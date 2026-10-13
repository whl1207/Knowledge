package com.whl.aikm;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册应用内插件（必须在 super.onCreate 之前）：
        // SafFolder = SAF 目录授权；DocPicker = 文件选择/按 uri 读写；NativeSpeech = 系统 TTS；
        // ShareOpen = 打开/分享；LongTask = 长任务前台服务；BackButton = 系统返回手势交给渲染层
        registerPlugin(SafFolderPlugin.class);
        registerPlugin(DocPickerPlugin.class);
        registerPlugin(NativeSpeechPlugin.class);
        registerPlugin(SharePlugin.class);
        registerPlugin(LongTaskPlugin.class);
        registerPlugin(BackButtonPlugin.class);
        super.onCreate(savedInstanceState);

        // 返回手势 / 返回键：渲染层接管时把事件交给页面（关闭设置浮层、文件窗口、回退主面板…），
        // 未接管时放行走系统默认行为（结束应用）。走 OnBackPressedDispatcher 以兼容 Android 13+
        // 的 predictive back（新的返回动画同样经这里分发）。
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (BackButtonPlugin.handleBack()) return;
                // 自己先让位，再把返回交回系统默认（否则会再次回到本回调形成死循环）
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}
