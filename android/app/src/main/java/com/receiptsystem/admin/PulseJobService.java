package com.receiptsystem.admin;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * Checks paired shops every 15 minutes (Android's shortest period) while
 * the phone has a network, and raises notifications for new alerts.
 * Survives reboots (setPersisted) and costs one small request per shop.
 */
public class PulseJobService extends JobService {
    private static final int JOB_ID = 4100;
    private volatile Thread worker;

    static void schedule(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null) return;
        boolean any = false;
        for (Shops.Shop s : new Shops(c).all()) if (s.key != null && !s.key.isEmpty()) any = true;
        if (!any) {
            js.cancel(JOB_ID);
            return;
        }
        if (js.getPendingJob(JOB_ID) != null) return;
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(c, PulseJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true)
                .build();
        js.schedule(job);
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        worker = new Thread(() -> {
            try {
                Alerts.checkAll(getApplicationContext());
            } catch (Exception ignored) {
                // next round will try again
            }
            jobFinished(params, false);
        }, "pulse-check");
        worker.start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        Thread t = worker;
        if (t != null) t.interrupt();
        return true;
    }
}
