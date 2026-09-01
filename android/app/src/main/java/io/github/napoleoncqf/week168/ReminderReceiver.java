package io.github.napoleoncqf.week168;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class ReminderReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ReminderScheduler.isEnabled(context)) {
            return;
        }
        NotificationHelper.showDailyReminder(context);
        ReminderScheduler.rescheduleStored(context);
    }
}
