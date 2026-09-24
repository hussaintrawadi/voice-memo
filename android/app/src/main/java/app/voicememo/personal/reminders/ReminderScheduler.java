package app.voicememo.personal.reminders;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

import app.voicememo.personal.MainActivity;
import app.voicememo.personal.R;
import app.voicememo.personal.recorder.PendingStore;

/**
 * Reminders fire from alarms on the phone, so they work offline and need no push service.
 * The list comes from the server (GET /api/device/reminders with the device upload token) and is
 * re-synced when the app opens, after uploads, and every 15 minutes in the background.
 */
public final class ReminderScheduler {

    private static final String TAG = "VoiceMemoReminders";
    private static final String PREFS = "voice_memo_reminders";
    private static final String KEY_SCHEDULED = "scheduled";
    private static final String KEY_SHOWN = "shown";
    static final String CHANNEL_ID = "reminders";
    static final String EXTRA_ID = "id";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_URL = "url";

    private ReminderScheduler() {}

    /** Fetches the reminder list and reschedules alarms. Returns false on a network or server error. */
    public static boolean sync(Context context) {
        String baseUrl = PendingStore.baseUrl(context);
        String token = PendingStore.captureToken(context);
        if (baseUrl == null || token == null) return true;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(baseUrl + "/api/device/reminders").openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            int status = conn.getResponseCode();
            if (status == 401) return true; // signed out; the app will re-register
            if (status != 200) return false;
            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }
            apply(context, new JSONObject(body.toString()).getJSONArray("reminders"));
            return true;
        } catch (IOException | JSONException e) {
            Log.w(TAG, "Reminder sync failed", e);
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** Schedules future reminders, shows ones that were missed, and cancels ones that are gone. */
    static synchronized void apply(Context context, JSONArray reminders) throws JSONException {
        SharedPreferences prefs = prefs(context);
        Set<String> keep = new HashSet<>();
        long now = System.currentTimeMillis();
        for (int i = 0; i < reminders.length(); i++) {
            JSONObject r = reminders.getJSONObject(i);
            String id = r.getString("id");
            keep.add(id);
            long at = r.getLong("remindAt");
            String recordingId = r.optString("recordingId", "");
            String url = recordingId.isEmpty() || "null".equals(recordingId) ? "/" : "/r/" + recordingId;
            if (at > now) {
                schedule(context, id, r.getString("text"), url, at);
            } else if (!wasShown(prefs, id)) {
                show(context, id, r.getString("text"), url);
            }
        }
        // Cancel alarms for reminders that were done, cancelled or moved elsewhere.
        try {
            JSONArray previous = new JSONArray(prefs.getString(KEY_SCHEDULED, "[]"));
            for (int i = 0; i < previous.length(); i++) {
                String id = previous.getJSONObject(i).getString("id");
                if (!keep.contains(id)) cancel(context, id);
            }
        } catch (JSONException ignored) {
        }
        prefs.edit().putString(KEY_SCHEDULED, reminders.toString()).apply();
    }

    /** After a reboot alarms are gone: schedule again from the last synced list. */
    static void restore(Context context) {
        try {
            apply(context, new JSONArray(prefs(context).getString(KEY_SCHEDULED, "[]")));
        } catch (JSONException e) {
            Log.w(TAG, "Could not restore reminders", e);
        }
    }

    private static void schedule(Context context, String id, String text, String url, long at) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        PendingIntent pi = alarmIntent(context, id, text, url);
        boolean exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms();
        if (exact) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
    }

    private static void cancel(Context context, String id) {
        context.getSystemService(AlarmManager.class).cancel(alarmIntent(context, id, "", "/"));
    }

    private static PendingIntent alarmIntent(Context context, String id, String text, String url) {
        Intent intent = new Intent(context, ReminderAlarmReceiver.class)
            .setAction("app.voicememo.personal.REMINDER." + id)
            .putExtra(EXTRA_ID, id)
            .putExtra(EXTRA_TEXT, text)
            .putExtra(EXTRA_URL, url);
        return PendingIntent.getBroadcast(context, id.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void show(Context context, String id, String text, String url) {
        SharedPreferences prefs = prefs(context);
        if (wasShown(prefs, id)) return;
        ensureChannel(context);
        Intent open = new Intent(context, MainActivity.class)
            .setAction(MainActivity.ACTION_OPEN)
            .putExtra(MainActivity.EXTRA_PATH, url)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent content = PendingIntent.getActivity(context, id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setContentTitle("Reminder")
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(content)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH);
        try {
            NotificationManagerCompat.from(context).notify(id.hashCode(), b.build());
        } catch (SecurityException e) {
            Log.w(TAG, "Notifications are turned off for Voice Memo", e);
        }
        markShown(prefs, id);
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Reminders", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Things you asked Voice Memo to remind you about");
        nm.createNotificationChannel(channel);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static boolean wasShown(SharedPreferences prefs, String id) {
        return prefs.getStringSet(KEY_SHOWN, new HashSet<>()).contains(id);
    }

    private static void markShown(SharedPreferences prefs, String id) {
        Set<String> shown = new HashSet<>(prefs.getStringSet(KEY_SHOWN, new HashSet<>()));
        shown.add(id);
        // Old ids are harmless but keep the set small.
        if (shown.size() > 300) shown.clear();
        prefs.edit().putStringSet(KEY_SHOWN, shown).apply();
    }
}
