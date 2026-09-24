package app.voicememo.personal.recorder;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import app.voicememo.personal.reminders.ReminderSyncWorker;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Uploads queued recordings whenever there is a network connection, even if the app is closed.
 * Retries with exponential backoff; recordings the server refuses for good are marked blocked.
 */
public class UploadWorker extends Worker {

    private static final String TAG = "VoiceMemoUpload";
    private static final String WORK_NAME = "voice-memo-upload";

    public UploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    public static void enqueue(Context context) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(UploadWorker.class)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        String baseUrl = PendingStore.baseUrl(context);
        String token = PendingStore.captureToken(context);
        // Not signed in yet: keep the files; signing in schedules another run.
        if (baseUrl == null || token == null) return Result.success();

        boolean retryLater = false;
        List<PendingStore.Item> items = PendingStore.list(context);
        for (PendingStore.Item item : items) {
            if (isStopped()) return Result.retry();
            if (item.blocked) continue;
            File file = PendingStore.audioFile(context, item.id);
            Outcome outcome;
            try {
                outcome = upload(baseUrl, token, item, file);
            } catch (IOException e) {
                outcome = Outcome.retry("No connection to Voice Memo");
            }

            if (outcome.done) {
                PendingStore.delete(context, item.id);
                // The memo may have said "remind me…": pick that up once it has been processed.
                ReminderSyncWorker.syncSoon(context, 90);
            } else {
                item.attempts += 1;
                item.lastError = outcome.message;
                item.blocked = outcome.permanent;
                try {
                    PendingStore.save(context, item);
                } catch (IOException e) {
                    Log.w(TAG, "Could not update recording details", e);
                }
                if (outcome.signedOut) {
                    RecorderState.notifyQueueChanged();
                    return Result.success();
                }
                if (!outcome.permanent) retryLater = true;
            }
            RecorderState.notifyQueueChanged();
            // Server trouble applies to every file; don't hammer it.
            if (retryLater) break;
        }
        return retryLater ? Result.retry() : Result.success();
    }

    private static final class Outcome {
        final boolean done;
        final boolean permanent;
        final boolean signedOut;
        final String message;

        private Outcome(boolean done, boolean permanent, boolean signedOut, String message) {
            this.done = done;
            this.permanent = permanent;
            this.signedOut = signedOut;
            this.message = message;
        }

        static Outcome ok() {
            return new Outcome(true, false, false, null);
        }

        static Outcome retry(String message) {
            return new Outcome(false, false, false, message);
        }
    }

    private Outcome upload(String baseUrl, String token, PendingStore.Item item, File file) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(baseUrl + "/api/capture").openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(20_000);
            conn.setReadTimeout(120_000);
            conn.setFixedLengthStreamingMode(file.length());
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "audio/mp4");
            conn.setRequestProperty("X-Recording-Id", item.id);
            conn.setRequestProperty("X-Recorded-At", String.valueOf(item.recordedAt));
            conn.setRequestProperty("X-Duration-Sec", String.valueOf(item.durationSec));
            conn.setRequestProperty("X-Source", "android");
            if (item.partOf != null) conn.setRequestProperty("X-Part-Of", item.partOf);
            conn.setRequestProperty("X-Part-Index", String.valueOf(item.partIndex));
            if (item.peak >= 0) conn.setRequestProperty("X-Audio-Peak", String.valueOf(item.peak));

            try (InputStream in = new FileInputStream(file); OutputStream out = conn.getOutputStream()) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }

            int status = conn.getResponseCode();
            if (status >= 200 && status < 300) return Outcome.ok();
            String message = errorMessage(conn, status);
            if (status == 401) return new Outcome(false, false, true, "Sign in again to upload");
            if (status == 400 || status == 409 || status == 413 || status == 415) {
                return new Outcome(false, true, false, message);
            }
            return Outcome.retry(message);
        } finally {
            conn.disconnect();
        }
    }

    private static String errorMessage(HttpURLConnection conn, int status) {
        try (InputStream err = conn.getErrorStream()) {
            if (err == null) return "Upload failed (" + status + ")";
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(err, StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null && sb.length() < 2000) sb.append(line);
            }
            return new JSONObject(sb.toString()).optString("error", "Upload failed (" + status + ")");
        } catch (Exception e) {
            return "Upload failed (" + status + ")";
        }
    }
}
