package app.voicememo.personal.reminders;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

import app.voicememo.personal.recorder.PendingStore;

/** Tells the server what you tapped on a reminder, retrying until there is a connection. */
public class ReminderActionWorker extends Worker {

    private static final String TAG = "VoiceMemoReminders";

    public ReminderActionWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void enqueue(Context context, String id, String action, int minutes) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(ReminderActionWorker.class)
            .setInputData(new Data.Builder().putString("id", id).putString("action", action).putInt("minutes", minutes).build())
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build();
        // One queue per reminder keeps taps in order (snooze, then done).
        WorkManager.getInstance(context).enqueueUniqueWork("reminder-action-" + id, ExistingWorkPolicy.APPEND_OR_REPLACE, request);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        String baseUrl = PendingStore.baseUrl(context);
        String token = PendingStore.captureToken(context);
        String id = getInputData().getString("id");
        String action = getInputData().getString("action");
        if (baseUrl == null || token == null || id == null || action == null) return Result.success();
        if (!id.matches("[0-9a-f-]{36}")) return Result.success();
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(baseUrl + "/api/device/reminders/" + id).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "application/json");
            String body = "{\"action\":\"" + action + "\",\"minutes\":" + getInputData().getInt("minutes", 10) + "}";
            try (OutputStream out = conn.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
            int status = conn.getResponseCode();
            if (status >= 200 && status < 300) {
                // Pick up the new time or status right away.
                ReminderSyncWorker.syncSoon(context, 0);
                return Result.success();
            }
            // Gone or refused for good: nothing to retry.
            if (status == 404 || status == 400 || status == 401) return Result.success();
            return Result.retry();
        } catch (IOException e) {
            Log.w(TAG, "Reminder action will retry", e);
            return Result.retry();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
