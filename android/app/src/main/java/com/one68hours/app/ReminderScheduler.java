package com.one68hours.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.Locale;

public final class ReminderScheduler {
    private static final String PREFS = "gentle_reminder";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_HOUR = "hour";
    private static final String KEY_MINUTE = "minute";
    private static final int DEFAULT_HOUR = 22;
    private static final int DEFAULT_MINUTE = 0;
    private static final int REQUEST_CODE = 168;

    private ReminderScheduler() {
    }

    public static void enable(Context context, int hour, int minute) {
        if (!isValidTime(hour, minute)) {
            return;
        }
        preferences(context).edit()
                .putBoolean(KEY_ENABLED, true)
                .putInt(KEY_HOUR, hour)
                .putInt(KEY_MINUTE, minute)
                .apply();
        scheduleNext(context, hour, minute);
    }

    public static void disable(Context context) {
        preferences(context).edit().putBoolean(KEY_ENABLED, false).apply();
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager != null) {
            alarmManager.cancel(pendingIntent(context));
        }
    }

    public static void rescheduleStored(Context context) {
        SharedPreferences preferences = preferences(context);
        if (!preferences.getBoolean(KEY_ENABLED, false)) {
            return;
        }
        int hour = preferences.getInt(KEY_HOUR, DEFAULT_HOUR);
        int minute = preferences.getInt(KEY_MINUTE, DEFAULT_MINUTE);
        scheduleNext(context, hour, minute);
    }

    public static boolean isEnabled(Context context) {
        return preferences(context).getBoolean(KEY_ENABLED, false);
    }

    private static void scheduleNext(Context context, int hour, int minute) {
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) {
            return;
        }

        Calendar now = Calendar.getInstance();
        Calendar next = Calendar.getInstance();
        next.set(Calendar.HOUR_OF_DAY, hour);
        next.set(Calendar.MINUTE, minute);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        if (!next.after(now)) {
            next.add(Calendar.DAY_OF_YEAR, 1);
        }

        PendingIntent alarm = pendingIntent(context);
        alarmManager.cancel(alarm);
        alarmManager.setAndAllowWhileIdle(
                AlarmManager.RTC_WAKEUP,
                next.getTimeInMillis(),
                alarm
        );
    }

    private static PendingIntent pendingIntent(Context context) {
        Intent intent = new Intent(context, ReminderReceiver.class);
        intent.setAction("com.one68hours.app.DAILY_REMINDER");
        return PendingIntent.getBroadcast(
                context,
                REQUEST_CODE,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    public static int[] parseTime(String time) {
        if (time == null) {
            return null;
        }
        String[] parts = time.trim().split(":", -1);
        if (parts.length != 2) {
            return null;
        }
        try {
            int hour = Integer.parseInt(parts[0]);
            int minute = Integer.parseInt(parts[1]);
            return isValidTime(hour, minute) ? new int[]{hour, minute} : null;
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    public static String getStateJson(Context context) {
        SharedPreferences preferences = preferences(context);
        boolean enabled = preferences.getBoolean(KEY_ENABLED, false);
        int hour = preferences.getInt(KEY_HOUR, DEFAULT_HOUR);
        int minute = preferences.getInt(KEY_MINUTE, DEFAULT_MINUTE);
        JSONObject result = new JSONObject();
        try {
            result.put("enabled", enabled);
            result.put("time", String.format(Locale.ROOT, "%02d:%02d", hour, minute));
            result.put("notificationAllowed", NotificationHelper.canPostNotifications(context));
        } catch (JSONException ignored) {
            return "{\"enabled\":false,\"time\":\"22:00\",\"notificationAllowed\":false}";
        }
        return result.toString();
    }

    private static boolean isValidTime(int hour, int minute) {
        return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
