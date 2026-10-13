package com.whl.aikm;

import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * NativeSpeech — 安卓系统语音合成（android.speech.tts.TextToSpeech）。
 *
 * 为什么需要它：桌面端用 sherpa-onnx 合成 WAV 再播，手机没必要带模型 —— 系统自带 TTS 引擎
 * （Google 语音服务 / 厂商引擎，多数机型离线可用）直接朗读，且不占体积。
 *
 * 接口约定（渲染层见 src/platform/android/speech.ts）：
 * - speak() 返回的 Promise 在**朗读结束**时 resolve，因此渲染层的播放队列可以按句串行推进；
 * - stop() 会中断当前朗读，并把等待中的调用按「已停止」resolve（避免调用方永久挂起）；
 * - 引擎未就绪 / 文本为空时 reject，调用方按「系统语音不可用」提示。
 *
 * 注意：Android 11+ 查询 TTS 引擎需要 manifest 里的 <queries> 声明（已加）。
 */
@CapacitorPlugin(name = "NativeSpeech")
public class NativeSpeechPlugin extends Plugin {

    private TextToSpeech tts;
    private boolean ready = false;
    private String initError = null;
    /** 等待朗读结束的调用（utteranceId → PluginCall） */
    private final ConcurrentHashMap<String, PluginCall> pending = new ConcurrentHashMap<>();

    private final UtteranceProgressListener progressListener = new UtteranceProgressListener() {
        @Override
        public void onStart(String utteranceId) {
            // 开始朗读：不需要额外通知
        }

        @Override
        public void onDone(String utteranceId) {
            PluginCall c = pending.remove(utteranceId);
            if (c != null) {
                JSObject res = new JSObject();
                res.put("done", true);
                c.resolve(res);
            }
        }

        @Override
        public void onStop(String utteranceId, boolean interrupted) {
            PluginCall c = pending.remove(utteranceId);
            if (c != null) {
                JSObject res = new JSObject();
                res.put("done", false);
                res.put("stopped", true);
                c.resolve(res);
            }
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onError(String utteranceId) {
            failPending(utteranceId, "朗读失败");
        }

        @Override
        public void onError(String utteranceId, int errorCode) {
            failPending(utteranceId, "朗读失败（错误码 " + errorCode + "）");
        }
    };

    private void failPending(String utteranceId, String message) {
        PluginCall c = pending.remove(utteranceId);
        if (c != null) c.reject(message);
    }

    /** 懒初始化引擎（首次调用时；初始化是异步回调，故 status/speak 都会触发） */
    private void init() {
        if (tts != null) return;
        try {
            tts = new TextToSpeech(getContext(), status -> {
                ready = status == TextToSpeech.SUCCESS && tts != null;
                if (ready) {
                    try {
                        tts.setOnUtteranceProgressListener(progressListener);
                    } catch (Exception e) {
                        ready = false;
                        initError = String.valueOf(e.getMessage());
                    }
                } else {
                    initError = "系统语音引擎不可用（status=" + status + "）";
                }
            });
        } catch (Exception e) {
            tts = null;
            ready = false;
            initError = String.valueOf(e.getMessage());
        }
    }

    /** 引擎状态：可用性 + 当前引擎包名 + 支持的语言（用于设置页展示） */
    @PluginMethod
    public void status(PluginCall call) {
        init();
        JSObject res = new JSObject();
        res.put("available", ready);
        res.put("engine", tts != null && tts.getDefaultEngine() != null ? tts.getDefaultEngine() : "");
        res.put("error", initError == null ? "" : initError);
        JSArray langs = new JSArray();
        if (ready && tts != null) {
            try {
                Set<Locale> set = tts.getAvailableLanguages();
                if (set != null) {
                    for (Locale l : set) langs.put(l == null ? "" : l.toLanguageTag());
                }
            } catch (Exception e) {
                // 引擎不支持查询语言：忽略
            }
        }
        res.put("languages", langs);
        call.resolve(res);
    }

    /** 可用音色列表（设置页可选；不同机型差异很大） */
    @PluginMethod
    public void voices(PluginCall call) {
        init();
        JSArray out = new JSArray();
        if (ready && tts != null) {
            try {
                Set<Voice> set = tts.getVoices();
                if (set != null) {
                    for (Voice v : set) {
                        if (v == null) continue;
                        JSObject o = new JSObject();
                        o.put("name", v.getName() == null ? "" : v.getName());
                        o.put("locale", v.getLocale() == null ? "" : v.getLocale().toLanguageTag());
                        o.put("quality", v.getQuality());
                        o.put("latency", v.getLatency());
                        o.put("network", v.isNetworkConnectionRequired());
                        out.put(o);
                    }
                }
            } catch (Exception e) {
                // 忽略
            }
        }
        JSObject res = new JSObject();
        res.put("voices", out);
        call.resolve(res);
    }

    /**
     * 朗读文本，返回的 Promise 在读完（或被打断）后 resolve。
     * rate/pitch 为倍率（1 = 正常），lang 为空则用引擎默认语言。
     */
    @PluginMethod
    public void speak(PluginCall call) {
        init();
        final String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            call.reject("文本为空");
            return;
        }
        if (tts == null || !ready) {
            call.reject(initError == null ? "系统语音引擎未就绪" : initError);
            return;
        }
        try {
            String lang = call.getString("lang", "");
            if (lang != null && !lang.isEmpty()) {
                Locale locale = Locale.forLanguageTag(lang);
                if (locale != null) {
                    int r = tts.setLanguage(locale);
                    if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                        call.reject("系统语音不支持该语言：" + lang);
                        return;
                    }
                }
            }
            String voice = call.getString("voice", "");
            if (voice != null && !voice.isEmpty()) {
                try {
                    for (Voice v : tts.getVoices()) {
                        if (v != null && voice.equals(v.getName())) {
                            tts.setVoice(v);
                            break;
                        }
                    }
                } catch (Exception e) {
                    // 音色不可用：退回默认音色
                }
            }
            Double rate = call.getDouble("rate");
            Double pitch = call.getDouble("pitch");
            if (rate != null) tts.setSpeechRate(rate.floatValue());
            if (pitch != null) tts.setPitch(pitch.floatValue());
            int queueMode = call.getBoolean("stopPrevious", Boolean.FALSE) ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
            String utteranceId = UUID.randomUUID().toString();
            pending.put(utteranceId, call);
            int queued = tts.speak(text, queueMode, null, utteranceId);
            if (queued == TextToSpeech.ERROR) {
                pending.remove(utteranceId);
                call.reject("朗读入队失败");
            }
        } catch (Exception e) {
            call.reject("朗读失败: " + e.getMessage());
        }
    }

    /** 中断朗读（等待中的调用按「已停止」resolve） */
    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) {
            try {
                tts.stop();
            } catch (Exception e) {
                // 忽略
            }
        }
        for (String id : pending.keySet()) {
            PluginCall c = pending.remove(id);
            if (c != null) {
                JSObject res = new JSObject();
                res.put("done", false);
                res.put("stopped", true);
                c.resolve(res);
            }
        }
        JSObject res = new JSObject();
        res.put("success", true);
        call.resolve(res);
    }

    @Override
    protected void handleOnDestroy() {
        for (String id : pending.keySet()) {
            PluginCall c = pending.remove(id);
            if (c != null) c.reject("页面已关闭");
        }
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (Exception e) {
                // 忽略
            }
            tts = null;
        }
        ready = false;
        super.handleOnDestroy();
    }
}
