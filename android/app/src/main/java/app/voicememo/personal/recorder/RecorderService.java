package app.voicememo.personal.recorder;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import java.io.File;
import java.io.IOException;
import java.util.Locale;
import java.util.UUID;

import app.voicememo.personal.MainActivity;
import app.voicememo.personal.R;

/**
 * Records in a foreground service so it keeps going with the screen off or the app in the
 * background. Long sessions are cut into 30-minute parts; every finished part goes to the
 * upload queue.
 */
public class RecorderService extends Service {

    private static final String TAG = "VoiceMemoRecorder";
    public static final String ACTION_START = "app.voicememo.personal.recorder.START";
    public static final String ACTION_PAUSE = "app.voicememo.personal.recorder.PAUSE";
    public static final String ACTION_RESUME = "app.voicememo.personal.recorder.RESUME";
    public static final String ACTION_STOP = "app.voicememo.personal.recorder.STOP";
    public static final String ACTION_CANCEL = "app.voicememo.personal.recorder.CANCEL";

    private static final String CHANNEL_ID = "recording";
    private static final int NOTIFICATION_ID = 42;
    private static final long MAX_PART_MS = 30 * 60 * 1000L;
    private static final int SAMPLE_RATE = 16_000;
    private static final int BITRATE = 32_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private MediaRecorder recorder;
    private PowerManager.WakeLock wakeLock;
    private String sessionId;
    private int partIndex;
    private String partId;
    private long partRecordedAt;
    /** Recorded time in the current part, excluding pauses. */
    private long partAccumulatedMs;
    private long partSpanStart;
    /** Loudest sample in the current part (MediaRecorder amplitude, 0–32767). */
    private int partPeak;

    public static void send(Context context, String action) {
        Intent intent = new Intent(context, RecorderService.class).setAction(action);
        if (ACTION_START.equals(action)) ContextCompat.startForegroundService(context, intent);
        else context.startService(intent);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (action == null) {
            // Restarted by the system after being killed: the old recording can't be resumed.
            stopSelf();
            return START_NOT_STICKY;
        }
        switch (action) {
            case ACTION_START:
                startSession();
                break;
            case ACTION_PAUSE:
                pauseSession();
                break;
            case ACTION_RESUME:
                resumeSession();
                break;
            case ACTION_STOP:
                finishSession(true);
                break;
            case ACTION_CANCEL:
                finishSession(false);
                break;
            default:
                break;
        }
        return START_NOT_STICKY;
    }

    // ── Session lifecycle ────────────────────────────────────────────────────

    private void startSession() {
        if (RecorderState.state() != RecorderState.State.IDLE) {
            updateNotification();
            return;
        }
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                buildNotification(),
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0
            );
        } catch (RuntimeException e) {
            Log.e(TAG, "Could not start foreground recording", e);
            RecorderState.end("Android didn't allow recording in the background. Open the app and try again.");
            stopSelf();
            return;
        }
        sessionId = UUID.randomUUID().toString();
        partIndex = 0;
        try {
            beginPart();
        } catch (IOException | RuntimeException e) {
            Log.e(TAG, "Could not start recorder", e);
            releaseRecorder();
            RecorderState.end("Couldn't use the microphone. Another app may be using it.");
            stopForegroundAndSelf();
            return;
        }
        acquireWakeLock();
        RecorderState.begin();
        updateNotification();
        handler.post(ticker);
    }

    private void pauseSession() {
        if (recorder == null || RecorderState.state() != RecorderState.State.RECORDING) return;
        try {
            recorder.pause();
        } catch (IllegalStateException e) {
            Log.w(TAG, "pause failed", e);
            return;
        }
        partAccumulatedMs += SystemClock.elapsedRealtime() - partSpanStart;
        partSpanStart = 0;
        RecorderState.pause();
        updateNotification();
    }

    private void resumeSession() {
        if (recorder == null || RecorderState.state() != RecorderState.State.PAUSED) return;
        try {
            recorder.resume();
        } catch (IllegalStateException e) {
            Log.w(TAG, "resume failed", e);
            return;
        }
        partSpanStart = SystemClock.elapsedRealtime();
        RecorderState.resume();
        updateNotification();
    }

    private void finishSession(boolean keep) {
        handler.removeCallbacks(ticker);
        String error = null;
        if (recorder != null) {
            if (keep) {
                if (!finishPart()) error = "The last part of the recording couldn't be saved.";
            } else {
                releaseRecorder();
                PendingStore.audioFile(this, partId).delete();
            }
        }
        releaseWakeLock();
        RecorderState.end(error);
        if (keep) UploadWorker.enqueue(this);
        stopForegroundAndSelf();
    }

    // ── Parts ────────────────────────────────────────────────────────────────

    private void beginPart() throws IOException {
        partId = UUID.randomUUID().toString();
        partRecordedAt = System.currentTimeMillis();
        partAccumulatedMs = 0;
        partPeak = 0;
        File file = PendingStore.audioFile(this, partId);

        MediaRecorder r = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? new MediaRecorder(this) : new MediaRecorder();
        r.setAudioSource(MediaRecorder.AudioSource.MIC);
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
        r.setAudioChannels(1);
        r.setAudioSamplingRate(SAMPLE_RATE);
        r.setAudioEncodingBitRate(BITRATE);
        r.setOutputFile(file.getAbsolutePath());
        r.prepare();
        r.start();
        recorder = r;
        partSpanStart = SystemClock.elapsedRealtime();
    }

    /** Stops the current part and puts it in the upload queue. */
    private boolean finishPart() {
        if (RecorderState.state() == RecorderState.State.RECORDING && partSpanStart > 0) {
            partAccumulatedMs += SystemClock.elapsedRealtime() - partSpanStart;
        }
        boolean ok = true;
        try {
            recorder.stop();
        } catch (RuntimeException e) {
            // stop() throws when almost nothing was recorded; the file is unusable.
            Log.w(TAG, "stop failed", e);
            ok = false;
        }
        releaseRecorder();
        File file = PendingStore.audioFile(this, partId);
        if (!ok || !file.exists() || file.length() == 0) {
            file.delete();
            return ok;
        }
        PendingStore.Item item = new PendingStore.Item();
        item.id = partId;
        item.recordedAt = partRecordedAt;
        item.durationSec = Math.round(partAccumulatedMs / 100.0) / 10.0;
        item.bytes = file.length();
        item.partOf = sessionId;
        item.partIndex = partIndex;
        item.peak = Math.round(partPeak / 32767.0 * 10000) / 10000.0;
        try {
            PendingStore.save(this, item);
        } catch (IOException e) {
            Log.e(TAG, "Could not save recording details", e);
            return false;
        }
        RecorderState.notifyQueueChanged();
        return true;
    }

    private void rollover() {
        finishPart();
        partIndex += 1;
        try {
            beginPart();
            UploadWorker.enqueue(this);
        } catch (IOException | RuntimeException e) {
            Log.e(TAG, "Could not start next part", e);
            releaseRecorder();
            finishSession(true);
        }
    }

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (recorder == null) return;
            if (RecorderState.state() == RecorderState.State.RECORDING) {
                try {
                    int amplitude = recorder.getMaxAmplitude();
                    if (amplitude > partPeak) partPeak = amplitude;
                    RecorderState.setLevel(Math.min(1f, amplitude / 12000f));
                } catch (IllegalStateException ignored) {
                }
                long partMs = partAccumulatedMs + (SystemClock.elapsedRealtime() - partSpanStart);
                if (partMs >= MAX_PART_MS) rollover();
            }
            // Fast only while someone can see the waveform. getMaxAmplitude() reports the loudest
            // moment since the last call, so the silence check stays accurate at the slow rate.
            boolean live = RecorderState.state() == RecorderState.State.RECORDING && RecorderState.uiVisible();
            handler.postDelayed(this, live ? 100 : 1000);
        }
    };

    private void releaseRecorder() {
        if (recorder == null) return;
        try {
            recorder.reset();
        } catch (RuntimeException ignored) {
        }
        recorder.release();
        recorder = null;
    }

    // ── Notification & wake lock ─────────────────────────────────────────────

    private Notification buildNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Recording", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while Voice Memo is recording");
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }
        boolean paused = RecorderState.state() == RecorderState.State.PAUSED;
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_mic)
            .setContentTitle(paused ? "Recording paused" : "Recording")
            .setContentIntent(content)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, paused ? "Resume" : "Pause", actionIntent(paused ? ACTION_RESUME : ACTION_PAUSE, 1))
            .addAction(0, "Stop & save", actionIntent(ACTION_STOP, 2));
        if (paused) {
            b.setContentText(formatElapsed(RecorderState.elapsedMs()));
        } else {
            b.setUsesChronometer(true).setWhen(System.currentTimeMillis() - RecorderState.elapsedMs()).setShowWhen(true);
        }
        return b.build();
    }

    private PendingIntent actionIntent(String action, int requestCode) {
        Intent intent = new Intent(this, RecorderService.class).setAction(action);
        return PendingIntent.getService(this, requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void updateNotification() {
        if (RecorderState.state() == RecorderState.State.IDLE) return;
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, buildNotification());
    }

    private static String formatElapsed(long ms) {
        long s = ms / 1000;
        return s >= 3600
            ? String.format(Locale.US, "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
            : String.format(Locale.US, "%d:%02d", s / 60, s % 60);
    }

    private void acquireWakeLock() {
        PowerManager pm = getSystemService(PowerManager.class);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VoiceMemo:recording");
        wakeLock.setReferenceCounted(false);
        // Safety net: a session can't hold the CPU awake for more than 6 hours.
        wakeLock.acquire(6 * 60 * 60 * 1000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private void stopForegroundAndSelf() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(ticker);
        if (recorder != null) {
            // The system is tearing us down mid-recording: keep what we have.
            finishPart();
            UploadWorker.enqueue(this);
        }
        releaseWakeLock();
        if (RecorderState.state() != RecorderState.State.IDLE) RecorderState.end(null);
        super.onDestroy();
    }
}
