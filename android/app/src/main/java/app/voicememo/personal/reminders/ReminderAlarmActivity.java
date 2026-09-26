package app.voicememo.personal.reminders;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.text.format.DateUtils;
import android.view.WindowManager;
import android.widget.TextView;

import app.voicememo.personal.MainActivity;
import app.voicememo.personal.R;

/**
 * The full-screen alarm: wakes the screen and shows over the lock screen, like an incoming call.
 * The sound belongs to the notification and keeps ringing until Done or Snooze.
 */
public class ReminderAlarmActivity extends Activity {

    private String id;
    private String text;
    private String url;
    private long at;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_reminder_alarm);

        findViewById(R.id.reminder_done).setOnClickListener(v -> act(ReminderActionReceiver.DONE));
        findViewById(R.id.reminder_snooze).setOnClickListener(v -> act(ReminderActionReceiver.SNOOZE));
        findViewById(R.id.reminder_open).setOnClickListener(v -> {
            ReminderScheduler.stopRinging(this, id);
            startActivity(new Intent(this, MainActivity.class)
                .setAction(MainActivity.ACTION_OPEN)
                .putExtra(MainActivity.EXTRA_PATH, url)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
            finish();
        });
        bind(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Another reminder went off while this one was on screen.
        bind(intent);
    }

    private void bind(Intent intent) {
        id = intent.getStringExtra(ReminderScheduler.EXTRA_ID);
        text = intent.getStringExtra(ReminderScheduler.EXTRA_TEXT);
        url = intent.getStringExtra(ReminderScheduler.EXTRA_URL);
        at = intent.getLongExtra(ReminderScheduler.EXTRA_AT, System.currentTimeMillis());
        if (id == null) {
            finish();
            return;
        }
        ((TextView) findViewById(R.id.reminder_text)).setText(text);
        ((TextView) findViewById(R.id.reminder_time)).setText(DateUtils.formatDateTime(this, at, DateUtils.FORMAT_SHOW_TIME));
    }

    private void act(String action) {
        ReminderActionReceiver.handle(this, action, id, text, url, at);
        finish();
    }
}
