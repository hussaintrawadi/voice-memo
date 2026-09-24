package app.voicememo.personal;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;

import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import app.voicememo.personal.recorder.NativeRecorderPlugin;
import app.voicememo.personal.recorder.RecorderService;
import app.voicememo.personal.recorder.RecorderState;

public class MainActivity extends BridgeActivity {

    /** Sent by the home-screen shortcut and the Quick Settings tile. */
    public static final String ACTION_RECORD = "app.voicememo.personal.RECORD";
    /** Sent by a reminder notification: open the app at a path such as /r/<memo id>. */
    public static final String ACTION_OPEN = "app.voicememo.personal.OPEN";
    public static final String EXTRA_PATH = "path";
    private static final java.util.regex.Pattern SAFE_PATH = java.util.regex.Pattern.compile("^/(r/[0-9a-f-]{36})?$");

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeRecorderPlugin.class);
        super.onCreate(savedInstanceState);
        handleRecordIntent(getIntent());
        handleOpenIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleRecordIntent(intent);
        handleOpenIntent(intent);
    }

    /** Routes the web app to the reminder's memo (only well-formed in-app paths). */
    private void handleOpenIntent(Intent intent) {
        if (intent == null || !ACTION_OPEN.equals(intent.getAction())) return;
        String path = intent.getStringExtra(EXTRA_PATH);
        intent.setAction(Intent.ACTION_MAIN);
        if (path == null || !SAFE_PATH.matcher(path).matches() || getBridge() == null) return;
        String js = "history.pushState({}, '', '" + path + "'); dispatchEvent(new PopStateEvent('popstate'));";
        // The page may still be loading on a cold start; give it a moment.
        getBridge().getWebView().postDelayed(() -> getBridge().getWebView().evaluateJavascript(js, null), 800);
    }

    /** Starts recording straight away when opened from a "record" shortcut (if the mic is allowed). */
    private void handleRecordIntent(Intent intent) {
        if (intent == null || !ACTION_RECORD.equals(intent.getAction())) return;
        intent.setAction(Intent.ACTION_MAIN);
        boolean micAllowed = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
        if (micAllowed && RecorderState.state() == RecorderState.State.IDLE) {
            RecorderService.send(this, RecorderService.ACTION_START);
        }
    }
}
