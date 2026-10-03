package com.receiptsystem.admin;

import android.app.Activity;
import android.app.DownloadManager;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.view.View;
import android.view.animation.PathInterpolator;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Receipt Admin: the shop's full admin app on the phone.
 *
 * Two web views share the screen:
 *   - the shell (bundled pages in assets/shell): the list of shops, pairing,
 *     and each shop's status summary from its encrypted snapshot, which works
 *     even when the shop PC is off. Only the shell gets the "Shell" bridge.
 *   - the web app itself, loaded from the shop (through the relay or on the
 *     shop Wi-Fi), so every admin page and feature is there, always current.
 *     It gets a tiny "ReceiptApp" bridge (print, back to shops) and nothing
 *     else.
 */
public class MainActivity extends Activity {
    static final String EXTRA_SHOP = "shop";
    private static final String SHELL_URL = "file:///android_asset/shell/index.html";
    private static final int REQ_FILE = 11;
    private static final int REQ_NOTIFY = 12;
    // The design system's ease-out: cubic-bezier(0.16, 1, 0.3, 1).
    private static final PathInterpolator EASE_OUT = new PathInterpolator(0.16f, 1f, 0.3f, 1f);
    private static final String PRINT_SHIM =
            "(function(){if(window.ReceiptApp&&!window.__raPrint){window.__raPrint=true;"
            + "window.print=function(){ReceiptApp.print(document.title||'Receipt');};}})();";

    private Shops shops;
    private WebView shell;
    private WebView web;
    private boolean shellReady;
    private final List<String> pendingJs = new ArrayList<>();
    private Shops.Shop current;
    private boolean opening;
    private boolean webFailed;
    private boolean webShown;
    private ValueCallback<Uri[]> fileCallback;
    private final ExecutorService io = Executors.newFixedThreadPool(3);

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        try {
            Pulse.version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException ignored) {
            // keep the default
        }
        shops = new Shops(this);
        Alerts.ensureChannel(this);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFFEEF2F6);
        web = buildWeb();
        shell = buildShell();
        FrameLayout.LayoutParams fill = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
        root.addView(web, fill);
        root.addView(shell, new FrameLayout.LayoutParams(fill));
        web.setVisibility(View.INVISIBLE);
        setContentView(root);

        shell.loadUrl(SHELL_URL);
        handleIntent(getIntent());
        PulseJobService.schedule(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data != null && "receiptadmin".equals(data.getScheme())) {
            try {
                Shops.Shop shop = shops.put(Shops.parse(data.toString()));
                PulseJobService.schedule(this);
                askNotifications();
                js("window.onPaired&&window.onPaired(" + JSONObject.quote(shop.id) + ")");
                openShop(shop.id);
            } catch (IllegalArgumentException e) {
                js("window.toast&&window.toast(" + JSONObject.quote(e.getMessage()) + ",true)");
            }
            setIntent(new Intent(this, MainActivity.class));
            return;
        }
        String shopId = intent.getStringExtra(EXTRA_SHOP);
        if (shopId != null) {
            showShell();
            js("window.showShop&&window.showShop(" + JSONObject.quote(shopId) + ")");
            setIntent(new Intent(this, MainActivity.class));
        }
    }

    // ---------------------------------------------------------------
    // The shell
    // ---------------------------------------------------------------
    private WebView buildShell() {
        WebView v = new WebView(this);
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        v.setBackgroundColor(0xFFEEF2F6);
        v.setOverScrollMode(View.OVER_SCROLL_NEVER);
        v.addJavascriptInterface(new ShellBridge(), "Shell");
        v.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("file".equals(u.getScheme()) && u.getPath() != null && u.getPath().startsWith("/android_asset/shell/")) return false;
                openExternal(u);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                shellReady = true;
                for (String code : pendingJs) view.evaluateJavascript(code, null);
                pendingJs.clear();
            }
        });
        v.setWebChromeClient(new WebChromeClient());
        return v;
    }

    /** Runs JavaScript in the shell (queued until it has loaded). */
    private void js(String code) {
        runOnUiThread(() -> {
            if (shellReady) shell.evaluateJavascript(code, null);
            else pendingJs.add(code);
        });
    }

    private void showShell() {
        if (!webShown && shell.getVisibility() == View.VISIBLE) return;
        webShown = false;
        shell.animate().cancel();
        shell.setVisibility(View.VISIBLE);
        shell.setAlpha(0f);
        shell.setTranslationX(-dp(24));
        shell.animate().alpha(1f).translationX(0f).setDuration(240).setInterpolator(EASE_OUT)
                .withEndAction(() -> web.setVisibility(View.INVISIBLE)).start();
        shell.requestFocus();
        js("window.onShellShown&&window.onShellShown()");
    }

    private void revealWeb() {
        webShown = true;
        web.setVisibility(View.VISIBLE);
        shell.animate().cancel();
        shell.animate().alpha(0f).translationX(-dp(24)).setDuration(200).setInterpolator(EASE_OUT)
                .withEndAction(() -> {
                    if (webShown) shell.setVisibility(View.GONE);
                }).start();
        web.requestFocus();
    }

    private void openShop(String id) {
        Shops.Shop shop = shops.get(id);
        if (shop == null) return;
        boolean same = current != null && current.id.equals(shop.id) && !webFailed && web.getUrl() != null;
        current = shop;
        if (same) {
            revealWeb();
            return;
        }
        opening = true;
        js("window.onOpening&&window.onOpening(" + JSONObject.quote(shop.id) + ")");
        web.stopLoading();
        web.loadUrl(shop.url + "app.html");
    }

    private void showOffline(String reason) {
        opening = false;
        if (current == null) return;
        showShell();
        try {
            JSONObject o = new JSONObject();
            o.put("offline", true);
            o.put("reason", reason == null ? "" : reason);
            js("window.showShop&&window.showShop(" + JSONObject.quote(current.id) + "," + o + ")");
        } catch (JSONException ignored) {
            // not reachable
        }
    }

    private void askNotifications() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED) return;
        if (shops.getFlag("asked_notify", false)) return;
        shops.setFlag("asked_notify", true);
        requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY);
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open this link.", Toast.LENGTH_SHORT).show();
        }
    }

    private float dp(float v) {
        return v * getResources().getDisplayMetrics().density;
    }

    /** What the shell pages can ask of the app. */
    final class ShellBridge {
        @JavascriptInterface
        public String shops() {
            JSONArray arr = new JSONArray();
            for (Shops.Shop s : MainActivity.this.shops.all()) {
                try {
                    JSONObject o = s.toJson(false);
                    o.put("host", s.host());
                    arr.put(o);
                } catch (JSONException ignored) {
                    // skip
                }
            }
            return arr.toString();
        }

        @JavascriptInterface
        public String add(String text) {
            JSONObject out = new JSONObject();
            try {
                Shops.Shop shop = MainActivity.this.shops.put(Shops.parse(text));
                out.put("ok", true);
                out.put("id", shop.id);
                out.put("paired", shop.key != null && !shop.key.isEmpty());
                runOnUiThread(() -> {
                    PulseJobService.schedule(MainActivity.this);
                    askNotifications();
                });
            } catch (IllegalArgumentException e) {
                try {
                    out.put("ok", false);
                    out.put("error", e.getMessage());
                } catch (JSONException ignored) {
                    // not reachable
                }
            } catch (JSONException ignored) {
                // not reachable
            }
            return out.toString();
        }

        @JavascriptInterface
        public void remove(String id) {
            MainActivity.this.shops.remove(id);
            runOnUiThread(() -> {
                if (current != null && current.id.equals(id)) {
                    current = null;
                    web.loadUrl("about:blank");
                }
                PulseJobService.schedule(MainActivity.this);
            });
        }

        @JavascriptInterface
        public void open(String id) {
            runOnUiThread(() -> openShop(id));
        }

        @JavascriptInterface
        public String cached(String id) {
            String c = MainActivity.this.shops.cachedPulse(id);
            return c == null ? "" : c;
        }

        /** Fetches status + snapshot; answers with window.onCheck(id, result). */
        @JavascriptInterface
        public void check(String id) {
            io.execute(() -> {
                Shops.Shop shop = MainActivity.this.shops.get(id);
                if (shop == null) return;
                JSONObject result = Pulse.check(shop);
                JSONObject pulse = result.optJSONObject("pulse");
                if (pulse != null) {
                    MainActivity.this.shops.cachePulse(id, result.toString());
                    Alerts.fresh(MainActivity.this.shops, id, pulse); // seen in the app: no notification
                }
                js("window.onCheck&&window.onCheck(" + JSONObject.quote(id) + "," + result + ")");
            });
        }

        @JavascriptInterface
        public void setNotify(String id, boolean on) {
            MainActivity.this.shops.setNotify(id, on);
            if (on) runOnUiThread(MainActivity.this::askNotifications);
        }

        @JavascriptInterface
        public boolean notificationsAllowed() {
            NotificationManager nm = getSystemService(NotificationManager.class);
            return nm != null && nm.areNotificationsEnabled();
        }

        @JavascriptInterface
        public String clipboard() {
            ClipboardManager cm = getSystemService(ClipboardManager.class);
            if (cm == null || !cm.hasPrimaryClip()) return "";
            ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence text = clip.getItemAt(0).coerceToText(MainActivity.this);
            return text == null ? "" : text.toString();
        }

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> MainActivity.this.openExternal(Uri.parse(url)));
        }

        @JavascriptInterface
        public String version() {
            return Pulse.version;
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(MainActivity.this::finish);
        }
    }

    // ---------------------------------------------------------------
    // The shop's web app
    // ---------------------------------------------------------------
    private WebView buildWeb() {
        WebView v = new WebView(this);
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setUserAgentString(s.getUserAgentString() + " ReceiptAdmin/" + Pulse.version);
        v.setBackgroundColor(0xFFEEF2F6);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(v, false);
        v.addJavascriptInterface(new WebBridge(), "ReceiptApp");

        v.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String url = u.toString();
                if (current != null && url.startsWith(current.url)) return false;
                if ("about".equals(u.getScheme())) return false;
                openExternal(u);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                webFailed = false;
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                if (opening && !webFailed && !"about:blank".equals(url)) {
                    opening = false;
                    revealWeb();
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(PRINT_SHIM, null);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                webFailed = true;
                showOffline(String.valueOf(error.getDescription()));
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                int code = response.getStatusCode();
                if (request.isForMainFrame() && code >= 502 && code <= 504) {
                    webFailed = true;
                    showOffline(code == 503 ? "The shop computer is offline." : "The shop didn't answer.");
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                recreate();
                return true;
            }
        });

        v.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });

        // CSV exports and other attachments: hand them to the download manager
        // with this session's cookie.
        v.setDownloadListener((url, userAgent, disposition, mimetype, length) -> {
            try {
                String name = URLUtil.guessFileName(url, disposition, mimetype);
                DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) r.addRequestHeader("Cookie", cookie);
                r.addRequestHeader("User-Agent", userAgent);
                r.setTitle(name);
                r.setMimeType(mimetype);
                r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                if (Build.VERSION.SDK_INT >= 29) r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                else r.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
                DownloadManager dm = getSystemService(DownloadManager.class);
                if (dm == null) throw new IllegalStateException("No download manager");
                dm.enqueue(r);
                Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "Couldn't download: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
        return v;
    }

    /** All the shop's pages can ask of the app: print, and back to shops. */
    final class WebBridge {
        @JavascriptInterface
        public void print(String title) {
            runOnUiThread(() -> {
                PrintManager pm = getSystemService(PrintManager.class);
                if (pm == null) return;
                String name = title == null || title.trim().isEmpty() ? "Receipt" : title.trim();
                pm.print(name, web.createPrintDocumentAdapter(name), new PrintAttributes.Builder().build());
            });
        }

        @JavascriptInterface
        public void home() {
            runOnUiThread(MainActivity.this::showShell);
        }

        @JavascriptInterface
        public String version() {
            return Pulse.version;
        }
    }

    // ---------------------------------------------------------------
    // Activity plumbing
    // ---------------------------------------------------------------
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webShown) {
            if (web.canGoBack()) web.goBack();
            else showShell();
            return;
        }
        shell.evaluateJavascript("window.shellBack?window.shellBack():false", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == REQ_NOTIFY) js("window.onNotifyPermission&&window.onNotifyPermission()");
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        shell.onResume();
        if (!webShown) js("window.onShellShown&&window.onShellShown()");
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        web.onPause();
        shell.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        web.destroy();
        shell.destroy();
        super.onDestroy();
    }
}
