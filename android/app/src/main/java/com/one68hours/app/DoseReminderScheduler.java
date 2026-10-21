package com.one68hours.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * Schedules the injection-day reminder. The page passes the next planned date,
 * the reminder time and the interval; after each alarm the next one is the
 * same time {@code intervalDays} later until the page sends a new date.
 */
public final class DoseReminderScheduler {
    public static final String ACTION = "com.one68hours.app.DOSE_REMINDER";

    private static final String PREFS = "dose_reminder";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_YEAR = "year";
    private static final String KEY_MONTH = "month";
    private static final String KEY_DAY = "day";
    private static final String KEY_HOUR = "hour";
    private static final String KEY_MINUTE = "minute";
    private static final String KEY_INTERVAL = "interval_days";
    private static final int REQUEST_CODE = 169;
    private static final int MAX_INTERVAL_DAYS = 60;
    private static final int MAX_CATCH_UP_STEPS = 4000;

    private DoseReminderScheduler() {
    }

    public static boolean enable(Context context, String dateKey, int hour, int minute, int intervalDays) {
        int[] date = parseDate(dateKey);
        if (date == null || hour < 0 || hour > 23 || minute < 0 || minute > 59
                || intervalDays < 1 || intervalDays > MAX_INTERVAL_DAYS) {
            return false;
        }
        preferences(context).edit()
                .putBoolean(KEY_ENABLED, true)
                .putInt(KEY_YEAR, date[0])
                .putInt(KEY_MONTH, date[1])
                .putInt(KEY_DAY, date[2])
                .putInt(KEY_HOUR, hour)
                .putInt(KEY_MINUTE, minute)
                .putInt(KEY_INTERVAL, intervalDays)
                .apply();
        rescheduleStored(context);
        return true;
    }

    public static void disable(Context context) {
        preferences(context).edit().putBoolean(KEY_ENABLED, false).apply();
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager != null) {
            alarmManager.cancel(pendingIntent(context));
        }
    }

    public static boolean isEnabled(Context context) {
        return preferences(context).getBoolean(KEY_ENABLED, false);
    }

    public static void rescheduleStored(Context context) {
        SharedPreferences preferences = preferences(context);
        if (!preferences.getBoolean(KEY_ENABLED, false)) {
            return;
        }
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) {
            return;
        }
        int interval = preferences.getInt(KEY_INTERVAL, 7);
        Calendar next = Calendar.getInstance();
        next.clear();
        next.set(
                preferences.getInt(KEY_YEAR, 2026),
                preferences.getInt(KEY_MONTH, 1) - 1,
                preferences.getInt(KEY_DAY, 1),
                preferences.getInt(KEY_HOUR, 9),
                preferences.getInt(KEY_MINUTE, 0),
                0
        );
        // Calendar day arithmetic keeps the wall-clock time across DST changes.
        Calendar now = Calendar.getInstance();
        int steps = 0;
        while (!next.after(now) && steps < MAX_CATCH_UP_STEPS) {
            next.add(Calendar.DAY_OF_YEAR, interval);
            steps += 1;
        }
        if (!next.after(now)) {
            return;
        }
        PendingIntent alarm = pendingIntent(context);
        alarmManager.cancel(alarm);
        alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next.getTimeInMillis(), alarm);
    }

    public static String getStateJson(Context context) {
        JSONObject result = new JSONObject();
        try {
            result.put("enabled", isEnabled(context));
            result.put("notificationAllowed", NotificationHelper.canPostDoseNotifications(context));
        } catch (JSONException ignored) {
            return "{\"enabled\":false,\"notificationAllowed\":false}";
        }
        return result.toString();
    }

    static int[] parseDate(String value) {
        if (value == null || !value.matches("\\d{4}-\\d{2}-\\d{2}")) {
            return null;
        }
        int year = Integer.parseInt(value.substring(0, 4));
        int month = Integer.parseInt(value.substring(5, 7));
        int day = Integer.parseInt(value.substring(8, 10));
        Calendar check = Calendar.getInstance();
        check.clear();
        check.setLenient(false);
        try {
            check.set(year, month - 1, day);
            check.getTimeInMillis();
        } catch (IllegalArgumentException invalid) {
            return null;
        }
        return new int[]{year, month, day};
    }

    private static PendingIntent pendingIntent(Context context) {
        Intent intent = new Intent(context, ReminderReceiver.class);
        intent.setAction(ACTION);
        return PendingIntent.getBroadcast(
                context,
                REQUEST_CODE,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
