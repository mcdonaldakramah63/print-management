package com.receiptsystem.admin;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Turns a shop's snapshot into notifications: a printer that stopped, a
 * high-risk alert, toner or stock running out. Each alert has a key that
 * stays the same while the problem lasts, so the phone buzzes once per
 * problem, and again only if it clears and comes back.
 */
final class Alerts {
    private Alerts() {}

    static final String CHANNEL = "alerts";

    static void ensureChannel(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, c.getString(R.string.channel_alerts), NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription(c.getString(R.string.channel_alerts_desc));
        ch.setLightColor(0xFFD6167A);
        ch.enableLights(true);
        nm.createNotificationChannel(ch);
    }

    /** Alerts worth a notification: every printer problem, other high ones. */
    static List<JSONObject> notable(JSONObject pulse) {
        List<JSONObject> list = new ArrayList<>();
        JSONArray arr = pulse == null ? null : pulse.optJSONArray("alerts");
        if (arr == null) return list;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject a = arr.optJSONObject(i);
            if (a == null) continue;
            if ("printer".equals(a.optString("kind")) || "high".equals(a.optString("severity"))) list.add(a);
        }
        return list;
    }

    /**
     * Records what the person has now seen and returns what is new.
     * The first check of a shop only records (no burst of old alerts).
     */
    static List<JSONObject> fresh(Shops shops, String shopId, JSONObject pulse) {
        List<JSONObject> notable = notable(pulse);
        Set<String> now = new HashSet<>();
        for (JSONObject a : notable) now.add(a.optString("key"));
        Set<String> seen = shops.seen(shopId);
        List<JSONObject> out = new ArrayList<>();
        if (seen != null) {
            for (JSONObject a : notable) if (!seen.contains(a.optString("key"))) out.add(a);
        }
        shops.setSeen(shopId, now);
        return out;
    }

    static void notify(Context c, Shops.Shop shop, List<JSONObject> alerts) {
        if (alerts.isEmpty()) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null || !nm.areNotificationsEnabled()) return;
        ensureChannel(c);
        Intent open = new Intent(c, MainActivity.class)
                .setAction("com.receiptsystem.admin.SHOW_SHOP")
                .putExtra(MainActivity.EXTRA_SHOP, shop.id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, shop.id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_alert)
                .setColor(0xFF0068A3)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setSubText(shop.name)
                .setCategory(Notification.CATEGORY_STATUS);
        if (alerts.size() == 1) {
            JSONObject a = alerts.get(0);
            String detail = a.optString("detail", "");
            b.setContentTitle(a.optString("title"))
                    .setContentText(detail.isEmpty() ? shop.name : detail)
                    .setStyle(new Notification.BigTextStyle().bigText(detail.isEmpty() ? shop.name : detail));
        } else {
            Notification.InboxStyle inbox = new Notification.InboxStyle();
            for (int i = 0; i < Math.min(6, alerts.size()); i++) inbox.addLine(alerts.get(i).optString("title"));
            if (alerts.size() > 6) inbox.setSummaryText("+" + (alerts.size() - 6) + " more");
            b.setContentTitle(alerts.size() + " new alerts at " + shop.name)
                    .setContentText(alerts.get(0).optString("title"))
                    .setStyle(inbox);
        }
        nm.notify("shop:" + shop.id, 1, b.build());
    }

    /** One background round over every paired shop. */
    static void checkAll(Context c) {
        Shops shops = new Shops(c);
        for (Shops.Shop shop : shops.all()) {
            if (shop.key == null || shop.key.isEmpty()) continue;
            JSONObject result = Pulse.check(shop);
            JSONObject pulse = result.optJSONObject("pulse");
            if (pulse == null) continue;
            shops.cachePulse(shop.id, result.toString());
            List<JSONObject> news = fresh(shops, shop.id, pulse);
            if (shop.notify) notify(c, shop, news);
        }
    }
}
