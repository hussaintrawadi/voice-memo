package app.voicememo.personal.reminders;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/** Keeps the phone's reminder alarms in step with the server. */
public class ReminderSyncWorker extends Worker {

    private static final String PERIODIC = "voice-memo-reminders";
    private static final String NOW = "voice-memo-reminders-now";

    public ReminderSyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    private static Constraints online() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    /** Every 15 minutes (the shortest period Android allows), while there is a network. */
    public static void schedule(Context context) {
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(ReminderSyncWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(online())
            .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request);
    }

    /** Sync soon, e.g. when the app opens or after a memo that may contain "remind me" was uploaded. */
    public static void syncSoon(Context context, long delaySeconds) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(ReminderSyncWorker.class)
            .setConstraints(online())
            .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, request);
    }

    @NonNull
    @Override
    public Result doWork() {
        return ReminderScheduler.sync(getApplicationContext()) ? Result.success() : Result.retry();
    }
}
