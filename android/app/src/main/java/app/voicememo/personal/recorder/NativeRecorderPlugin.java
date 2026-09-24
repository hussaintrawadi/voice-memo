package app.voicememo.personal.recorder;

import android.Manifest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import app.voicememo.personal.reminders.ReminderSyncWorker;

/** JavaScript bridge for {@link RecorderService} and the upload queue (see src/lib/native.ts). */
@CapacitorPlugin(
    name = "NativeRecorder",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
    }
)
public class NativeRecorderPlugin extends Plugin implements RecorderState.Listener {

    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        RecorderState.addListener(this);
        RecorderState.setUiVisible(true);
        ReminderSyncWorker.schedule(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        RecorderState.setUiVisible(false);
        RecorderState.removeListener(this);
    }

    @Override
    protected void handleOnResume() {
        RecorderState.setUiVisible(true);
        // Coming back online often happens while the app is closed; nudge the queue when it opens.
        if (!PendingStore.list(getContext()).isEmpty()) UploadWorker.enqueue(getContext());
        ReminderSyncWorker.syncSoon(getContext(), 0);
    }

    @Override
    protected void handleOnPause() {
        RecorderState.setUiVisible(false);
    }

    // ── Configuration ───────────────────────────────────────────────────────

    @PluginMethod
    public void configure(PluginCall call) {
        String baseUrl = call.getString("baseUrl");
        String token = call.getString("captureToken");
        PendingStore.setConfig(getContext(), baseUrl, token);
        if (token != null) {
            PendingStore.unblockAll(getContext());
            UploadWorker.enqueue(getContext());
            ReminderSyncWorker.syncSoon(getContext(), 0);
        }
        call.resolve();
    }

    // ── Reminders ───────────────────────────────────────────────────────────

    /** Re-sync reminder alarms now (after one is added or changed in the app). Asks for notifications first. */
    @PluginMethod
    public void syncReminders(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterReminderPermission");
            return;
        }
        ReminderSyncWorker.syncSoon(getContext(), 0);
        call.resolve();
    }

    @PermissionCallback
    private void afterReminderPermission(PluginCall call) {
        ReminderSyncWorker.syncSoon(getContext(), 0);
        call.resolve();
    }

    @PluginMethod
    public void getConfig(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("baseUrl", PendingStore.baseUrl(getContext()));
        ret.put("hasToken", PendingStore.captureToken(getContext()) != null);
        call.resolve(ret);
    }

    // ── Recording ───────────────────────────────────────────────────────────

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicPermission");
            return;
        }
        startRecording(call);
    }

    @PermissionCallback
    private void afterMicPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startRecording(call);
        } else {
            call.reject("Microphone permission is needed to record", "NotAllowedError");
        }
    }

    private void startRecording(PluginCall call) {
        // The recording notification needs this on Android 13+; recording works without it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("notifications") == PermissionState.PROMPT) {
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        beginAndWait(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        beginAndWait(call);
    }

    private void beginAndWait(PluginCall call) {
        RecorderState.clearError();
        RecorderService.send(getContext(), RecorderService.ACTION_START);
        waitFor(call, 3000, () -> {
            if (RecorderState.state() != RecorderState.State.IDLE) return Boolean.TRUE;
            return RecorderState.lastError() != null ? Boolean.FALSE : null;
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        RecorderService.send(getContext(), RecorderService.ACTION_PAUSE);
        waitFor(call, 1500, () -> RecorderState.state() != RecorderState.State.RECORDING ? Boolean.TRUE : null);
    }

    @PluginMethod
    public void resume(PluginCall call) {
        RecorderService.send(getContext(), RecorderService.ACTION_RESUME);
        waitFor(call, 1500, () -> RecorderState.state() != RecorderState.State.PAUSED ? Boolean.TRUE : null);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (RecorderState.state() == RecorderState.State.IDLE) {
            JSObject ret = new JSObject();
            ret.put("saved", false);
            call.resolve(ret);
            return;
        }
        RecorderService.send(getContext(), RecorderService.ACTION_STOP);
        waitFor(call, 5000, () -> RecorderState.state() == RecorderState.State.IDLE ? Boolean.TRUE : null);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        RecorderService.send(getContext(), RecorderService.ACTION_CANCEL);
        waitFor(call, 3000, () -> RecorderState.state() == RecorderState.State.IDLE ? Boolean.TRUE : null);
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusObject());
    }

    private JSObject statusObject() {
        JSObject ret = new JSObject();
        RecorderState.State s = RecorderState.state();
        ret.put("state", s == RecorderState.State.RECORDING ? "recording" : s == RecorderState.State.PAUSED ? "paused" : "idle");
        ret.put("elapsedSec", RecorderState.elapsedMs() / 1000.0);
        ret.put("level", RecorderState.level());
        ret.put("error", RecorderState.lastError());
        return ret;
    }

    interface Check {
        /** TRUE = done, FALSE = failed, null = keep waiting. */
        Boolean test();
    }

    /** Resolves once the service reaches the expected state, or rejects with its error. */
    private void waitFor(PluginCall call, long timeoutMs, Check check) {
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        handler.post(new Runnable() {
            @Override
            public void run() {
                Boolean result = check.test();
                if (Boolean.TRUE.equals(result)) {
                    JSObject ret = statusObject();
                    ret.put("saved", RecorderState.lastError() == null);
                    call.resolve(ret);
                } else if (Boolean.FALSE.equals(result)) {
                    call.reject(RecorderState.lastError() != null ? RecorderState.lastError() : "Recording failed");
                } else if (SystemClock.elapsedRealtime() > deadline) {
                    call.reject("The recorder didn't respond. Please try again.");
                } else {
                    handler.postDelayed(this, 50);
                }
            }
        });
    }

    // ── Upload queue ────────────────────────────────────────────────────────

    @PluginMethod
    public void listPending(PluginCall call) {
        JSArray items = new JSArray();
        for (PendingStore.Item item : PendingStore.list(getContext())) {
            JSObject o = new JSObject();
            o.put("id", item.id);
            o.put("recordedAt", item.recordedAt);
            o.put("durationSec", item.durationSec);
            o.put("bytes", item.bytes);
            o.put("attempts", item.attempts);
            o.put("lastError", item.lastError);
            o.put("blocked", item.blocked);
            items.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("items", items);
        call.resolve(ret);
    }

    @PluginMethod
    public void retryUploads(PluginCall call) {
        PendingStore.unblockAll(getContext());
        UploadWorker.enqueue(getContext());
        call.resolve();
    }

    @PluginMethod
    public void deletePending(PluginCall call) {
        String id = call.getString("id");
        if (id == null || !id.matches("[0-9a-f-]{36}")) {
            call.reject("Invalid id");
            return;
        }
        PendingStore.delete(getContext(), id);
        RecorderState.notifyQueueChanged();
        call.resolve();
    }

    // ── Events ──────────────────────────────────────────────────────────────

    @Override
    public void onStateChanged() {
        handler.post(() -> notifyListeners("stateChanged", statusObject()));
    }

    @Override
    public void onQueueChanged() {
        handler.post(() -> notifyListeners("queueChanged", new JSObject()));
    }
}
