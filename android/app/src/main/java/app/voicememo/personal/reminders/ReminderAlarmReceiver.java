package app.voicememo.personal.reminders;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Fires when a reminder's alarm goes off (not exported: only our own alarms reach it). */
public class ReminderAlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra(ReminderScheduler.EXTRA_ID);
        String text = intent.getStringExtra(ReminderScheduler.EXTRA_TEXT);
        if (id == null || text == null) return;
        String url = intent.getStringExtra(ReminderScheduler.EXTRA_URL);
        long at = intent.getLongExtra(ReminderScheduler.EXTRA_AT, System.currentTimeMillis());
        ReminderScheduler.ring(context, id, text, url != null ? url : "/", at);
    }
}
