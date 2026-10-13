package com.whl.aikm;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * BackButton — 系统返回手势 / 返回键桥。
 *
 * 为什么需要：安卓的返回手势（屏幕左右边缘内划）与返回键默认直接结束 Activity，
 * 但本应用的界面栈是**渲染层状态**（设置浮层、应用内文件窗口、主面板切换），
 * WebView 与 URL 历史都不知道，所以必须让渲染层有机会先处理。
 *
 * 工作方式（配合 MainActivity 的 OnBackPressedDispatcher 回调）：
 * - 渲染层有东西可回退时调用 setHandled({ handled: true }) → 原生把返回事件交给 JS
 *   （notifyListeners("back")），不再结束应用；
 * - 渲染层处理不了（例如已在主页根）→ 调用 exit()，由 JS 请求结束 Activity；
 * - 渲染层完全没接管时（jsHandled=false）→ 原生走系统默认行为（结束 Activity）。
 *
 * 渲染层用法见 src/platform/android/back.ts 与 App.vue 的 handleAndroidBack()。
 */
@CapacitorPlugin(name = "BackButton")
public class BackButtonPlugin extends Plugin {

    private static BackButtonPlugin instance;

    /** 渲染层是否接管返回（false = 走系统默认：结束应用） */
    private boolean jsHandled = false;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    /** 渲染层声明是否接管返回手势 */
    @PluginMethod public void setHandled(PluginCall call) {
        Boolean handled = call.getBoolean("handled", Boolean.TRUE);
        jsHandled = handled != null && handled;
        JSObject res = new JSObject();
        res.put("handled", jsHandled);
        call.resolve(res);
    }

    /** 查询当前是否由渲染层接管（调试 / 自检用） */
    @PluginMethod public void isHandled(PluginCall call) {
        JSObject res = new JSObject();
        res.put("handled", jsHandled);
        call.resolve(res);
    }

    /** 渲染层确认「回无可回」：结束应用（与系统返回在根页面的语义一致） */
    @PluginMethod public void exit(PluginCall call) {
        if (getActivity() != null) {
            getActivity().finish();
            call.resolve(new JSObject().put("success", true));
        } else {
            call.reject("no activity");
        }
    }

    /**
     * MainActivity 在返回手势里调用：
     * 返回 true 表示渲染层已接管（原生不要结束应用），false 表示走系统默认。
     */
    public static boolean handleBack() {
        BackButtonPlugin p = instance;
        if (p == null || !p.jsHandled) return false;
        try {
            p.notifyListeners("back", new JSObject());
        } catch (Exception e) {
            return false;
        }
        return true;
    }
}
