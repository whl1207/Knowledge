package com.whl.aikm;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * LongTask — 长任务前台服务桥（见 LongTaskService）。
 *
 * 渲染层的用法（src/platform/longTask.ts）：
 *   begin({ title, text, progress, indeterminate })  开始/首次投出通知并起前台服务
 *   update({ text, progress, indeterminate })        更新进度（不重新起服务）
 *   end()                                            结束并移除通知
 *   active()                                         当前是否有前台服务在跑（页面重启后可对账）
 *
 * 通知权限（Android 13+）只是「让用户看得见进度」，因此申请权限不阻塞服务启动：
 * 授权回调里补发一次当前状态，用户就能立刻看到通知。
 */
@CapacitorPlugin(name = "LongTask", permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class LongTaskPlugin extends Plugin {

    @PluginMethod
    public void begin(PluginCall call) {
        sendIntent(LongTaskService.ACTION_START, call);
        boolean needPermission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED;
        if (needPermission) {
            // 把 resolve 交给权限回调：无论用户允许还是拒绝，服务都已经在跑
            requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
        } else {
            call.resolve(okResult("begin"));
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        sendIntent(LongTaskService.ACTION_UPDATE, call);
        call.resolve(okResult("update"));
    }

    @PluginMethod
    public void end(PluginCall call) {
        sendIntent(LongTaskService.ACTION_STOP, call);
        call.resolve(okResult("end"));
    }

    /** 当前是否有长任务前台服务在运行 */
    @PluginMethod
    public void active(PluginCall call) {
        JSObject res = new JSObject();
        res.put("active", LongTaskService.isRunning());
        call.resolve(res);
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        // 授权后补发一次，让通知立刻出现（拒绝则维持「服务在跑但没通知」）
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            sendIntent(LongTaskService.ACTION_UPDATE, null);
        }
        if (call != null) call.resolve(okResult(getPermissionState("notifications") == PermissionState.GRANTED ? "begin" : "begin-no-notification"));
    }

    private JSObject okResult(String action) {
        JSObject res = new JSObject();
        res.put("success", true);
        res.put("action", action);
        return res;
    }

    private void sendIntent(String action, PluginCall call) {
        Intent intent = new Intent(getContext(), LongTaskService.class);
        intent.setAction(action);
        if (call != null) {
            String title = call.getString("title", "");
            if (title != null && !title.isEmpty()) intent.putExtra(LongTaskService.EXTRA_TITLE, title);
            String text = call.getString("text", "");
            if (text != null) intent.putExtra(LongTaskService.EXTRA_TEXT, text);
            Double progress = call.getDouble("progress");
            if (progress != null) {
                intent.putExtra(LongTaskService.EXTRA_PROGRESS, progress.intValue());
                intent.putExtra(LongTaskService.EXTRA_INDETERMINATE, Boolean.FALSE);
            }
            Boolean indeterminate = call.getBoolean("indeterminate");
            if (indeterminate != null) intent.putExtra(LongTaskService.EXTRA_INDETERMINATE, indeterminate);
        }
        try {
            if (LongTaskService.ACTION_START.equals(action)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(intent);
                else getContext().startService(intent);
            } else {
                getContext().startService(intent);
            }
        } catch (Exception e) {
            // 系统限制后台启动前台服务（如应用已在后台且无豁免）时会抛异常：忽略，任务本身不受影响
        }
    }
}
