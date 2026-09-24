package app.voicememo.personal.recorder;

import android.os.SystemClock;

import java.util.concurrent.CopyOnWriteArrayList;

/** Process-wide recording state shared by the service, the plugin and the tile. */
public final class RecorderState {

    public enum State { IDLE, RECORDING, PAUSED }

    public interface Listener {
        void onStateChanged();
        void onQueueChanged();
    }

    private static final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();

    private static volatile State state = State.IDLE;
    /** Recorded time in finished parts plus paused spans of the current part. */
    private static volatile long accumulatedMs = 0;
    /** When the current recording span started (elapsedRealtime), or 0 when paused/idle. */
    private static volatile long spanStartedAt = 0;
    private static volatile float level = 0f;
    private static volatile String lastError = null;
    /** True while the app is on screen; the service only samples quickly for the waveform then. */
    private static volatile boolean uiVisible = false;

    private RecorderState() {}

    public static State state() {
        return state;
    }

    public static synchronized void begin() {
        accumulatedMs = 0;
        spanStartedAt = SystemClock.elapsedRealtime();
        lastError = null;
        set(State.RECORDING);
    }

    public static synchronized void pause() {
        if (state != State.RECORDING) return;
        accumulatedMs += SystemClock.elapsedRealtime() - spanStartedAt;
        spanStartedAt = 0;
        level = 0f;
        set(State.PAUSED);
    }

    public static synchronized void resume() {
        if (state != State.PAUSED) return;
        spanStartedAt = SystemClock.elapsedRealtime();
        set(State.RECORDING);
    }

    public static synchronized void end(String error) {
        accumulatedMs = 0;
        spanStartedAt = 0;
        level = 0f;
        lastError = error;
        set(State.IDLE);
    }

    public static long elapsedMs() {
        long running = state == State.RECORDING && spanStartedAt > 0 ? SystemClock.elapsedRealtime() - spanStartedAt : 0;
        return accumulatedMs + running;
    }

    public static void setLevel(float value) {
        level = value;
    }

    public static float level() {
        return level;
    }

    public static void setUiVisible(boolean visible) {
        uiVisible = visible;
    }

    public static boolean uiVisible() {
        return uiVisible;
    }

    public static String lastError() {
        return lastError;
    }

    /** Forget a previous failure before a new attempt, so it isn't mistaken for this one. */
    public static void clearError() {
        lastError = null;
    }

    private static void set(State next) {
        state = next;
        for (Listener l : listeners) l.onStateChanged();
    }

    public static void notifyQueueChanged() {
        for (Listener l : listeners) l.onQueueChanged();
    }

    public static void addListener(Listener l) {
        listeners.add(l);
    }

    public static void removeListener(Listener l) {
        listeners.remove(l);
    }
}
