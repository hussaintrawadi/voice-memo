package app.voicememo.personal.reminders;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.text.format.DateUtils;
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
 * Reminders ring like an alarm on the phone: alarm sound on repeat, vibration, and a full-screen
 * screen over the lock screen, until you tap Done or Snooze. They are scheduled with the system
 * alarm clock, so they fire on time offline and in battery saver.
 *
 * The list comes from the server (GET /api/device/reminders with the device upload token) and is
 * re-synced when the app opens, after uploads, and every 15 minutes. Reminders the AI only
 * suggested come with a "Set this reminder?" notification you can confirm in one tap.
 */
public final class ReminderScheduler {

    private static final String TAG = "VoiceMemoReminders";
    private static final String PREFS = "voice_memo_reminders";
    private static final String KEY_SCHEDULED = "scheduled";
    /** "id@time" of every alarm already rung or shown, so a reminder rings once per time it's set for. */
    private static final String KEY_SHOWN = "shown_at";
    /** Ids already asked about with "Set this reminder?". */
    private static final String KEY_PROMPTED = "prompted";

    /** Rings: alarm sound, high importance. A new id, since a channel's sound can't change after creation. */
    static final String ALARM_CHANNEL = "reminder_alarm";
    /** Quiet: "Set this reminder?" and reminders missed while the phone was off. */
    static final String PROMPT_CHANNEL = "reminders";

    static final String EXTRA_ID = "id";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_URL = "url";
    static final String EXTRA_AT = "at";

    /** Stop ringing after this long without an answer; the reminder still shows in the app as due. */
    private static final long RING_MS = 10 * 60_000L;

    private ReminderScheduler() {}

    /** Fetches the reminder list and reschedules alarms. Returns false on a network or server error. */
    public static boolean sync(Context context) {
        String baseUrl = PendingStore.baseUrl(context);
        String token = PendingStore.captureToken(context);
        if (baseUrl == null || token == null) return true;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(baseUrl + "/api/device/reminders?include=suggested").openConnection();
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

    /** Schedules what will ring, asks about suggestions, shows what was missed, cancels what's gone. */
    static synchronized void apply(Context context, JSONArray reminders) throws JSONException {
        SharedPreferences prefs = prefs(context);
        Set<String> keep = new HashSet<>();
        long now = System.currentTimeMillis();
        for (int i = 0; i < reminders.length(); i++) {
            JSONObject r = reminders.getJSONObject(i);
            String id = r.getString("id");
            keep.add(id);
            String text = r.getString("text");
            long at = r.getLong("remindAt");
            String url = urlFor(r.optString("recordingId", ""));
            if (r.optBoolean("suggested", false)) {
                // Waiting for a tap: ask once, and don't ring until it's confirmed.
                if (at > now && !contains(prefs, KEY_PROMPTED, id)) promptToSet(context, id, text, url, at);
                continue;
            }
            // Confirmed (here or in the app): the question is answered.
            NotificationManagerCompat.from(context).cancel(promptNotificationId(id));
            if (at > now) {
                schedule(context, id, text, url, at);
            } else if (!contains(prefs, KEY_SHOWN, id + "@" + at)) {
                showMissed(context, id, text, url, at);
            }
        }
        // Cancel alarms and questions for reminders that were done, cancelled or moved elsewhere.
        try {
            JSONArray previous = new JSONArray(prefs.getString(KEY_SCHEDULED, "[]"));
            for (int i = 0; i < previous.length(); i++) {
                String id = previous.getJSONObject(i).getString("id");
                if (!keep.contains(id)) {
                    cancel(context, id);
                    NotificationManagerCompat.from(context).cancel(promptNotificationId(id));
                }
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

    // ── Alarms ──────────────────────────────────────────────────────────────

    /** Sets the system alarm clock for a reminder (the most reliable kind of alarm Android has). */
    static void schedule(Context context, String id, String text, String url, long at) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        PendingIntent fire = alarmIntent(context, id, text, url, at);
        boolean exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms();
        if (exact) {
            PendingIntent show = PendingIntent.getActivity(
                context, 0, new Intent(context, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            alarms.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), fire);
        } else {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
        }
    }

    private static void cancel(Context context, String id) {
        context.getSystemService(AlarmManager.class).cancel(alarmIntent(context, id, "", "/", 0));
    }

    private static PendingIntent alarmIntent(Context context, String id, String text, String url, long at) {
        Intent intent = new Intent(context, ReminderAlarmReceiver.class)
            .setAction("app.voicememo.personal.REMINDER." + id)
            .putExtra(EXTRA_ID, id)
            .putExtra(EXTRA_TEXT, text)
            .putExtra(EXTRA_URL, url)
            .putExtra(EXTRA_AT, at);
        return PendingIntent.getBroadcast(context, id.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /**
     * The alarm went off: ring until answered. The sound repeats (FLAG_INSISTENT) on the alarm
     * stream, so it plays with the ringer on silent; on the lock screen it opens full screen.
     */
    static void ring(Context context, String id, String text, String url, long at) {
        SharedPreferences prefs = prefs(context);
        String key = id + "@" + at;
        if (contains(prefs, KEY_SHOWN, key)) return;
        ensureChannels(context);

        Intent screen = new Intent(context, ReminderAlarmActivity.class)
            .putExtra(EXTRA_ID, id)
            .putExtra(EXTRA_TEXT, text)
            .putExtra(EXTRA_URL, url)
            .putExtra(EXTRA_AT, at)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent fullScreen = PendingIntent.getActivity(
            context, id.hashCode(), screen, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        NotificationCompat.Builder b = new NotificationCompat.Builder(context, ALARM_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setContentTitle("Reminder")
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(fullScreen, true)
            .setContentIntent(fullScreen)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(RING_MS)
            .addAction(0, "Snooze 10 min", ReminderActionReceiver.intent(context, ReminderActionReceiver.SNOOZE, id, text, url, at))
            .addAction(0, "Done", ReminderActionReceiver.intent(context, ReminderActionReceiver.DONE, id, text, url, at));
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT;
        post(context, alarmNotificationId(id), n);
        add(prefs, KEY_SHOWN, key);
    }

    /** Stops the ringing and clears the reminder's notification. */
    static void stopRinging(Context context, String id) {
        NotificationManagerCompat.from(context).cancel(alarmNotificationId(id));
    }

    /** A reminder whose time passed while the phone was off: tell, don't ring. */
    private static void showMissed(Context context, String id, String text, String url, long at) {
        ensureChannels(context);
        NotificationCompat.Builder b = new NotificationCompat.Builder(context, PROMPT_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setContentTitle("Missed reminder · " + DateUtils.formatDateTime(context, at, DateUtils.FORMAT_SHOW_TIME))
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openApp(context, id, url))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .addAction(0, "Done", ReminderActionReceiver.intent(context, ReminderActionReceiver.DONE, id, text, url, at));
        post(context, alarmNotificationId(id), b.build());
        add(prefs(context), KEY_SHOWN, id + "@" + at);
    }

    /** "Set this reminder?" for one the AI heard in a memo. One tap sets it; nothing rings until then. */
    private static void promptToSet(Context context, String id, String text, String url, long at) {
        ensureChannels(context);
        String when = DateUtils.formatDateTime(context, at,
            DateUtils.FORMAT_SHOW_TIME | DateUtils.FORMAT_SHOW_WEEKDAY | DateUtils.FORMAT_ABBREV_WEEKDAY);
        NotificationCompat.Builder b = new NotificationCompat.Builder(context, PROMPT_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setContentTitle("Set this reminder? " + when)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openApp(context, id, url))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .addAction(0, "Not now", ReminderActionReceiver.intent(context, ReminderActionReceiver.DISMISS, id, text, url, at))
            .addAction(0, "Set reminder", ReminderActionReceiver.intent(context, ReminderActionReceiver.CONFIRM, id, text, url, at));
        post(context, promptNotificationId(id), b.build());
        add(prefs(context), KEY_PROMPTED, id);
    }

    static void cancelPrompt(Context context, String id) {
        NotificationManagerCompat.from(context).cancel(promptNotificationId(id));
    }

    private static PendingIntent openApp(Context context, String id, String url) {
        Intent open = new Intent(context, MainActivity.class)
            .setAction(MainActivity.ACTION_OPEN)
            .putExtra(MainActivity.EXTRA_PATH, url)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, ("open:" + id).hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static void post(Context context, int notificationId, Notification n) {
        try {
            NotificationManagerCompat.from(context).notify(notificationId, n);
        } catch (SecurityException e) {
            Log.w(TAG, "Notifications are turned off for Voice Memo", e);
        }
    }

    static int alarmNotificationId(String id) {
        return id.hashCode();
    }

    private static int promptNotificationId(String id) {
        return ("prompt:" + id).hashCode();
    }

    private static String urlFor(String recordingId) {
        return recordingId.isEmpty() || "null".equals(recordingId) ? "/" : "/r/" + recordingId;
    }

    private static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(ALARM_CHANNEL) == null) {
            NotificationChannel alarm = new NotificationChannel(ALARM_CHANNEL, "Reminder alarms", NotificationManager.IMPORTANCE_HIGH);
            alarm.setDescription("Rings like an alarm when a reminder is due");
            Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (sound == null) sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            alarm.setSound(sound, new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
            alarm.enableVibration(true);
            alarm.setVibrationPattern(new long[] {0, 900, 500, 900, 500, 900});
            alarm.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(alarm);
        }
        if (nm.getNotificationChannel(PROMPT_CHANNEL) == null) {
            NotificationChannel prompts = new NotificationChannel(PROMPT_CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH);
            prompts.setDescription("Reminders to confirm, and ones you missed");
            nm.createNotificationChannel(prompts);
        }
    }

    // ── Local bookkeeping ───────────────────────────────────────────────────

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static boolean contains(SharedPreferences prefs, String key, String value) {
        return prefs.getStringSet(key, new HashSet<>()).contains(value);
    }

    private static void add(SharedPreferences prefs, String key, String value) {
        Set<String> set = new HashSet<>(prefs.getStringSet(key, new HashSet<>()));
        set.add(value);
        // Old entries are harmless but keep the set small.
        if (set.size() > 400) set.clear();
        prefs.edit().putStringSet(key, set).apply();
    }
}
