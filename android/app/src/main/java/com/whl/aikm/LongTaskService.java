package com.whl.aikm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * LongTaskService — 长任务前台服务（带进度通知）。
 *
 * 为什么需要它：安卓在应用退到后台后会限制/回收 WebView 所在的进程，
 * 知识处理（切片 / 向量化 / 本体构建）、长时问答、批量导出这类跑几分钟的任务很容易被掐断。
 * 起一个前台服务 + 常驻通知，系统就知道「还在干活」，不会回收；用户也能从通知栏看到进度并点回应用。
 *
 * 状态通过 Intent extra 传递（ACTION_START / ACTION_UPDATE / ACTION_STOP），
 * 因此更新进度不需要页面在存活（重复 startForeground 即更新同一条通知）。
 */
public class LongTaskService extends Service {

    public static final String CHANNEL_ID = "aikm_long_task";
    public static final int NOTIFICATION_ID = 4201;

    public static final String ACTION_START = "com.whl.aikm.longtask.START";
    public static final String ACTION_UPDATE = "com.whl.aikm.longtask.UPDATE";
    public static final String ACTION_STOP = "com.whl.aikm.longtask.STOP";

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_TEXT = "text";
    public static final String EXTRA_PROGRESS = "progress";
    public static final String EXTRA_INDETERMINATE = "indeterminate";

    // 最近一次状态：权限被授予后重发通知 / 更新时复用
    private String title = "";
    private String text = "";
    private int progress = 0;
    private boolean indeterminate = true;

    /** 是否有长任务前台服务在运行（渲染层可据此对账） */
    private static volatile boolean running = false;

    public static boolean isRunning() {
        return running;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null && intent.getAction() != null ? intent.getAction() : ACTION_START;

        if (ACTION_STOP.equals(action)) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (intent != null) {
            String t = intent.getStringExtra(EXTRA_TITLE);
            if (t != null && !t.isEmpty()) title = t;
            String x = intent.getStringExtra(EXTRA_TEXT);
            if (x != null) text = x;
            if (intent.hasExtra(EXTRA_PROGRESS)) progress = intent.getIntExtra(EXTRA_PROGRESS, progress);
            if (intent.hasExtra(EXTRA_INDETERMINATE)) indeterminate = intent.getBooleanExtra(EXTRA_INDETERMINATE, indeterminate);
        }

        ensureChannel();
        Notification notification = buildNotification();
        // 重复调用即更新同一条通知（避免额外申请通知权限的同时保持文案最新）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        return START_NOT_STICKY;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.app_name) + " · 后台任务",
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("长任务进行中时保持应用存活，并显示进度");
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        } catch (Exception ignored) {
        }
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open, piFlags);

        String heading = title == null || title.isEmpty() ? "后台任务进行中" : title;
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(heading)
                .setContentText(text == null ? "" : text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setProgress(100, Math.max(0, Math.min(100, progress)), indeterminate)
                .setContentIntent(contentIntent)
                .build();
    }
}
