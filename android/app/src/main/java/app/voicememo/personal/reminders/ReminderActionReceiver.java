package app.voicememo.personal.reminders;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The buttons on a ringing reminder and on "Set this reminder?". Each acts on the phone at once
 * (so it works offline) and tells the server in the background.
 */
public class ReminderActionReceiver extends BroadcastReceiver {

    static final String DONE = "done";
    static final String SNOOZE = "snooze";
    static final String CONFIRM = "confirm";
    static final String DISMISS = "dismiss";

    static final int SNOOZE_MINUTES = 10;

    static PendingIntent intent(Context context, String action, String id, String text, String url, long at) {
        Intent i = new Intent(context, ReminderActionReceiver.class)
            .setAction("app.voicememo.personal.REMINDER_ACTION." + action + "." + id)
            .putExtra("action", action)
            .putExtra(ReminderScheduler.EXTRA_ID, id)
            .putExtra(ReminderScheduler.EXTRA_TEXT, text)
            .putExtra(ReminderScheduler.EXTRA_URL, url)
            .putExtra(ReminderScheduler.EXTRA_AT, at);
        return PendingIntent.getBroadcast(context, (action + id).hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra(ReminderScheduler.EXTRA_ID);
        String action = intent.getStringExtra("action");
        if (id == null || action == null) return;
        handle(context, action, id,
            intent.getStringExtra(ReminderScheduler.EXTRA_TEXT),
            intent.getStringExtra(ReminderScheduler.EXTRA_URL),
            intent.getLongExtra(ReminderScheduler.EXTRA_AT, 0));
    }

    /** Shared with the full-screen alarm screen. */
    static void handle(Context context, String action, String id, String text, String url, long at) {
        String safeText = text != null ? text : "Reminder";
        String safeUrl = url != null ? url : "/";
        switch (action) {
            case DONE:
                ReminderScheduler.stopRinging(context, id);
                break;
            case SNOOZE:
                ReminderScheduler.stopRinging(context, id);
                // Rings again locally even if the server can't be reached right now.
                ReminderScheduler.schedule(context, id, safeText, safeUrl, System.currentTimeMillis() + SNOOZE_MINUTES * 60_000L);
                break;
            case CONFIRM:
                ReminderScheduler.cancelPrompt(context, id);
                if (at > System.currentTimeMillis()) ReminderScheduler.schedule(context, id, safeText, safeUrl, at);
                break;
            case DISMISS:
                ReminderScheduler.cancelPrompt(context, id);
                break;
            default:
                return;
        }
        ReminderActionWorker.enqueue(context, id, action, SNOOZE_MINUTES);
    }
}
