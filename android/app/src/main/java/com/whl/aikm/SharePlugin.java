package com.whl.aikm;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * ShareOpen — 用系统应用打开 / 通过系统分享面板分享。
 *
 * 为什么需要它：安卓没有「默认打开方式」的直接 API，必须发 Intent：
 * - open()  → ACTION_VIEW（手机上有应用能打开就打开，没有就退化成分享面板，避免「点了没反应」）；
 * - share() → ACTION_SEND + 系统选择器（聊天软件 / 云盘 / 邮件…）。
 *
 * 传参（渲染层见 src/platform/android/share.ts）：
 * - uri：已是可共享的 uri（`content://` 直接用；SAF 授权目录里的文件由 SafFolder.getUri 给出）；
 * - fileUrl：`file://` 绝对路径（如 Capacitor Filesystem 返回的 uri）→ 经 FileProvider 换成 `content://`；
 * - path + directory：沙箱相对路径 + Capacitor Directory（Data / Cache / DOCUMENTS / External…）→ 同样走 FileProvider；
 * - mime 缺省时按扩展名推断，text 用于分享纯文本（无文件时）。
 *
 * FileProvider 的可用根目录见 res/xml/file_paths.xml（不在其内会明确报错，而不是抛 FileUriExposedException）。
 */
@CapacitorPlugin(name = "ShareOpen")
public class SharePlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        Uri uri = resolveUri(call);
        if (uri == null) {
            call.reject("无法共享该路径（文件不存在或不在可共享目录内）");
            return;
        }
        String mime = mimeOf(call, uri);
        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(uri, mime);
        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            getActivity().startActivity(view);
            call.resolve(new JSObject().put("success", true).put("action", "view"));
        } catch (ActivityNotFoundException e) {
            // 没有应用能打开这类文件：退化成分享面板（用户自己挑目标应用）
            sendShare(call, uri, mime, "open-fallback");
        } catch (Exception e) {
            call.reject("打开失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void share(PluginCall call) {
        Uri uri = resolveUri(call);
        String text = call.getString("text", "");
        if (uri == null && (text == null || text.isEmpty())) {
            call.reject("没有可分享的内容");
            return;
        }
        sendShare(call, uri, mimeOf(call, uri), "share");
    }

    /** 是否有应用能处理该 uri（界面据此决定是否显示「用系统应用打开」） */
    @PluginMethod
    public void canOpen(PluginCall call) {
        Uri uri = resolveUri(call);
        JSObject res = new JSObject();
        if (uri == null) {
            res.put("openable", false);
            res.put("error", "路径不可共享");
            call.resolve(res);
            return;
        }
        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(uri, mimeOf(call, uri));
        res.put("openable", view.resolveActivity(getContext().getPackageManager()) != null);
        call.resolve(res);
    }

    // ------------------------------------------------------------------ 内部

    private void sendShare(PluginCall call, Uri uri, String mime, String action) {
        Intent send = new Intent(Intent.ACTION_SEND);
        if (uri != null) {
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } else {
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, call.getString("text", ""));
        }
        String title = call.getString("title", "");
        if (title != null && !title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
        Intent chooser = Intent.createChooser(send, title == null || title.isEmpty() ? getString("分享到", "Share via") : title);
        try {
            getActivity().startActivity(chooser);
            call.resolve(new JSObject().put("success", true).put("action", action));
        } catch (Exception e) {
            call.reject("分享失败: " + e.getMessage());
        }
    }

    private String getString(String zh, String en) {
        // 跟随系统语言给分享面板标题；两种语言够用，避免额外资源
        boolean zhUi = false;
        try {
            String lang = java.util.Locale.getDefault().getLanguage();
            zhUi = "zh".equalsIgnoreCase(lang);
        } catch (Exception ignored) {
        }
        return zhUi ? zh : en;
    }

    /** 把调用参数解析为可共享的 uri；无法共享返回 null */
    private Uri resolveUri(PluginCall call) {
        // 三种传参：uri（含 content:// 与 file://）、fileUrl（Capacitor 的 file:// uri）、path + directory（沙箱相对路径）
        String raw = call.getString("uri", "");
        if (raw == null || raw.isEmpty()) raw = call.getString("fileUrl", "");
        if (raw != null && raw.startsWith("content://")) return Uri.parse(raw);

        File file = null;
        if (raw != null && !raw.isEmpty()) {
            file = fileOf(raw);
        } else {
            String rel = call.getString("path", "");
            String dir = call.getString("directory", "");
            File base = baseDir(dir);
            if (base != null && rel != null && !rel.isEmpty()) {
                file = new File(base, rel);
            }
        }
        if (file == null || !file.exists()) return null;
        try {
            return FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        } catch (Exception e) {
            return null;
        }
    }

    private static File fileOf(String raw) {
        String p = raw;
        if (p.startsWith("file://")) p = p.substring("file://".length());
        try {
            p = Uri.decode(p);
        } catch (Exception ignored) {
        }
        return new File(p);
    }

    private static String mimeOf(PluginCall call, Uri uri) {
        String given = call.getString("mime", "");
        if (given != null && !given.isEmpty()) return given;
        String name = uri == null ? "" : uri.getLastPathSegment();
        if (name == null) name = "";
        String lower = name.toLowerCase();
        if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".csv")) return "text/csv";
        if (lower.endsWith(".pdf")) return "application/pdf";
        if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".mp4")) return "video/mp4";
        return "application/octet-stream";
    }

    /** 与 Capacitor Filesystem 的 Directory 取值保持一致（见 src/platform/android/index.ts） */
    private File baseDir(String directory) {
        Context c = getContext();
        String dir = directory == null ? "" : directory.toUpperCase(java.util.Locale.ROOT);
        switch (dir) {
            case "DATA":
            case "LIBRARY":
                return c.getFilesDir();
            case "CACHE":
                return c.getCacheDir();
            case "DOCUMENTS":
                return Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
            case "EXTERNAL":
                return c.getExternalFilesDir(null);
            case "EXTERNAL_STORAGE":
                return Environment.getExternalStorageDirectory();
            default:
                return null;
        }
    }
}
