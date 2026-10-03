package com.receiptsystem.admin;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * The shops this phone is paired with, kept in private app storage.
 *
 * A shop is its web address (a relay link like https://relay/s/abc/ or a
 * local one like http://192.168.1.20:3000/) plus, when paired with the QR
 * code, the key that decrypts its status snapshot. The key never leaves the
 * phone.
 */
final class Shops {
    private static final String PREFS = "shops";
    private final SharedPreferences prefs;

    Shops(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static final class Shop {
        String id;
        String name;
        String url;
        String key;
        boolean notify = true;

        JSONObject toJson(boolean withKey) throws JSONException {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("name", name);
            o.put("url", url);
            o.put("notify", notify);
            o.put("paired", key != null && !key.isEmpty());
            if (withKey) o.put("key", key == null ? "" : key);
            return o;
        }

        static Shop fromJson(JSONObject o) {
            Shop s = new Shop();
            s.id = o.optString("id");
            s.name = o.optString("name", "Shop");
            s.url = o.optString("url");
            s.key = o.optString("key", "");
            s.notify = o.optBoolean("notify", true);
            return s;
        }

        String host() {
            Uri u = Uri.parse(url);
            return u.getHost() == null ? url : u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        }
    }

    synchronized List<Shop> all() {
        List<Shop> list = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(prefs.getString("list", "[]"));
            for (int i = 0; i < arr.length(); i++) list.add(Shop.fromJson(arr.getJSONObject(i)));
        } catch (JSONException ignored) {
            // corrupt storage: start over
        }
        return list;
    }

    synchronized Shop get(String id) {
        for (Shop s : all()) if (s.id.equals(id)) return s;
        return null;
    }

    private void save(List<Shop> list) {
        JSONArray arr = new JSONArray();
        try {
            for (Shop s : list) arr.put(s.toJson(true));
        } catch (JSONException ignored) {
            return;
        }
        prefs.edit().putString("list", arr.toString()).apply();
    }

    /** Adds the shop, or updates it if this address is already known. */
    synchronized Shop put(Shop shop) {
        List<Shop> list = all();
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i).id.equals(shop.id)) {
                Shop old = list.get(i);
                if (shop.key == null || shop.key.isEmpty()) shop.key = old.key;
                shop.notify = old.notify;
                list.set(i, shop);
                save(list);
                return shop;
            }
        }
        list.add(shop);
        save(list);
        return shop;
    }

    synchronized void remove(String id) {
        List<Shop> list = all();
        List<Shop> keep = new ArrayList<>();
        for (Shop s : list) if (!s.id.equals(id)) keep.add(s);
        save(keep);
        prefs.edit().remove("pulse:" + id).remove("seen:" + id).apply();
    }

    synchronized void setNotify(String id, boolean on) {
        List<Shop> list = all();
        for (Shop s : list) if (s.id.equals(id)) s.notify = on;
        save(list);
    }

    // ---------- last snapshot and alerts already shown ----------
    void cachePulse(String id, String json) {
        prefs.edit().putString("pulse:" + id, json).apply();
    }

    String cachedPulse(String id) {
        return prefs.getString("pulse:" + id, null);
    }

    /** Alert keys already seen, or null if this shop has never been checked. */
    Set<String> seen(String id) {
        Set<String> s = prefs.getStringSet("seen:" + id, null);
        return s == null ? null : new HashSet<>(s);
    }

    void setSeen(String id, Set<String> keys) {
        prefs.edit().putStringSet("seen:" + id, new HashSet<>(keys)).apply();
    }

    boolean getFlag(String name, boolean def) {
        return prefs.getBoolean("flag:" + name, def);
    }

    void setFlag(String name, boolean value) {
        prefs.edit().putBoolean("flag:" + name, value).apply();
    }

    // ---------- reading what the person scanned or pasted ----------

    /**
     * Accepts any of:
     *   receiptadmin://connect?u=<url>&k=<key>&n=<name>   (pairing link)
     *   https://relay/s/abc/connect.html#k=<key>&n=<name>  (the QR code itself)
     *   a connection code (base64url JSON {u, k, n})
     *   a plain address, https://… or 192.168.1.20:3000   (no snapshot)
     */
    static Shop parse(String input) throws IllegalArgumentException {
        String text = input == null ? "" : input.trim();
        if (text.isEmpty()) throw new IllegalArgumentException("Paste the connection code or the shop's address.");
        String url;
        String key = "";
        String name = "";
        if (text.startsWith("receiptadmin:")) {
            Uri u = Uri.parse(text);
            url = u.getQueryParameter("u");
            key = nz(u.getQueryParameter("k"));
            name = nz(u.getQueryParameter("n"));
        } else if (text.contains("connect.html#")) {
            int at = text.indexOf("connect.html#");
            url = text.substring(0, at);
            Uri frag = Uri.parse("x://x/?" + text.substring(at + "connect.html#".length()));
            key = nz(frag.getQueryParameter("k"));
            name = nz(frag.getQueryParameter("n"));
        } else if (text.matches("^[A-Za-z0-9_-]{40,}$")) {
            try {
                JSONObject o = new JSONObject(new String(Base64.getUrlDecoder().decode(text), StandardCharsets.UTF_8));
                url = o.optString("u");
                key = o.optString("k");
                name = o.optString("n");
            } catch (Exception e) {
                throw new IllegalArgumentException("That connection code isn't complete. Copy it again from Settings > Remote access on the shop PC.");
            }
        } else {
            url = text.matches("^[a-zA-Z][a-zA-Z0-9+.-]*://.*") ? text : "http://" + text;
        }
        Shop s = new Shop();
        s.url = normaliseUrl(url);
        if (!key.isEmpty() && !validKey(key)) throw new IllegalArgumentException("The pairing key in that code is damaged. Scan the code again.");
        s.key = key;
        s.name = name.isEmpty() ? Uri.parse(s.url).getHost() : name;
        s.id = idFor(s.url);
        return s;
    }

    static String normaliseUrl(String url) {
        if (url == null || url.trim().isEmpty()) throw new IllegalArgumentException("The shop's address is missing.");
        Uri u = Uri.parse(url.trim());
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) throw new IllegalArgumentException("The address must start with https:// or http://");
        if (u.getHost() == null || u.getHost().isEmpty()) throw new IllegalArgumentException("That isn't a web address.");
        String path = u.getPath() == null ? "" : u.getPath();
        path = path.replaceAll("(app|login|connect|index)\\.html$", "");
        if (!path.endsWith("/")) path = path + "/";
        return scheme + "://" + u.getEncodedAuthority() + path;
    }

    static boolean validKey(String key) {
        try {
            return key.matches("^[A-Za-z0-9_-]{43}$") && Base64.getUrlDecoder().decode(key).length == 32;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    static String idFor(String url) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-1").digest(url.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 6; i++) sb.append(String.format(Locale.ROOT, "%02x", h[i]));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(url.hashCode());
        }
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }
}
