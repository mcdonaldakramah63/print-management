package com.receiptsystem.admin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Reads a shop's status: whether its PC is online, and its latest snapshot
 * (sales, printers, alerts), which is AES-256-GCM encrypted with the pairing
 * key (see server/lib/pulse.js). Runs on a background thread.
 */
final class Pulse {
    private Pulse() {}

    /** Set at start-up from the package version. */
    static volatile String version = "1.0";

    /** { ok, online, last_seen, pulse_at, pulse?, error?, checked_at } */
    static JSONObject check(Shops.Shop shop) {
        JSONObject out = new JSONObject();
        try {
            out.put("checked_at", System.currentTimeMillis());
            try {
                JSONObject status = new JSONObject(get(shop.url + "__status"));
                out.put("online", status.optBoolean("online", false));
                out.put("direct", status.optBoolean("direct", false));
                if (!status.isNull("last_seen")) out.put("last_seen", status.optString("last_seen"));
            } catch (Exception e) {
                out.put("online", false);
                out.put("unreachable", true);
                out.put("error", friendly(e));
            }
            if (shop.key != null && !shop.key.isEmpty() && !out.optBoolean("unreachable")) {
                try {
                    JSONObject blob = new JSONObject(get(shop.url + "__pulse"));
                    JSONObject pulse = decrypt(blob, shop.key);
                    out.put("pulse", pulse);
                    if (blob.has("relay_at")) out.put("pulse_at", blob.optString("relay_at"));
                } catch (javax.crypto.AEADBadTagException e) {
                    out.put("error", "This phone's pairing is out of date. Scan the code in Settings > Remote access again.");
                    out.put("stale_key", true);
                } catch (Exception e) {
                    if (!out.has("error")) out.put("error", friendly(e));
                }
            }
            out.put("ok", out.has("pulse") || out.optBoolean("online"));
        } catch (Exception ignored) {
            // JSONException on put: cannot happen with these values
        }
        return out;
    }

    static JSONObject decrypt(JSONObject blob, String keyB64url) throws Exception {
        byte[] key = Base64.getUrlDecoder().decode(keyB64url);
        byte[] iv = Base64.getDecoder().decode(blob.getString("iv"));
        byte[] data = Base64.getDecoder().decode(blob.getString("data"));
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        return new JSONObject(new String(c.doFinal(data), StandardCharsets.UTF_8));
    }

    static String get(String address) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(address).openConnection();
        conn.setConnectTimeout(12000);
        conn.setReadTimeout(15000);
        conn.setUseCaches(false);
        conn.setRequestProperty("User-Agent", "ReceiptAdmin/" + version);
        conn.setRequestProperty("Accept", "application/json");
        try {
            int code = conn.getResponseCode();
            if (code == 404) throw new NotFound();
            if (code >= 400) throw new Exception("The server answered " + code);
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] b = new byte[8192];
                int n;
                while ((n = in.read(b)) > 0) {
                    buf.write(b, 0, n);
                    if (buf.size() > 2 * 1024 * 1024) throw new Exception("Answer too large");
                }
                return buf.toString("UTF-8");
            }
        } finally {
            conn.disconnect();
        }
    }

    static final class NotFound extends Exception {
        NotFound() { super("No snapshot yet"); }
    }

    static String friendly(Exception e) {
        if (e instanceof NotFound) return "The shop hasn't sent an update yet.";
        if (e instanceof java.net.UnknownHostException) return "No internet connection, or the address is wrong.";
        if (e instanceof java.net.SocketTimeoutException) return "The shop took too long to answer.";
        if (e instanceof java.net.ConnectException) return "Can't reach the shop. Is the PC on and on this network?";
        if (e instanceof javax.net.ssl.SSLException) return "Secure connection failed.";
        String m = e.getMessage();
        return m == null ? "Something went wrong." : m;
    }
}
