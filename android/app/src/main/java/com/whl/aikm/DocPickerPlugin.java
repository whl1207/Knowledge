package com.whl.aikm;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * DocPicker — 单文件 / 多文件选择 + 按 uri 读写（SAF 的「文件」侧）。
 *
 * 与 SafFolderPlugin 的分工：
 * - SafFolderPlugin：用户授权**一个目录**（tree uri），之后按「相对该目录的路径」读写（工作区）。
 * - DocPicker：用户挑**若干文件**（document uri，如微信发来的 PDF、下载目录里的表格），
 *   拿到可持久化的读权限后按 uri 读取；也可用系统「另存为」写出一个新文件。
 *
 * 为什么需要它：安卓没有「任意路径读取」权限，插件/应用要读手机里的文件只能走系统选择器。
 * 挑过的 uri 会记住（takePersistableUriPermission），重启后仍可读（授权被系统撤销时读取会失败，
 * 调用方应提示用户重新选择）。
 */
@CapacitorPlugin(name = "DocPicker")
public class DocPickerPlugin extends Plugin {

    private static final String PREFS = "aikm_docpicker";
    private static final String KEY_URIS = "uris";

    // ---------------------------------------------------------------- 选择

    /** 打开系统文件选择器（multiple=true 时可多选） */
    @PluginMethod
    public void pickFiles(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "*/*"));
        if (Boolean.TRUE.equals(call.getBoolean("multiple", Boolean.FALSE))) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickFilesResult");
    }

    @ActivityCallback
    private void pickFilesResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            call.reject("用户取消");
            return;
        }
        List<Uri> uris = new ArrayList<>();
        Intent data = result.getData();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        JSArray files = new JSArray();
        for (Uri uri : uris) {
            remember(uri);
            JSObject item = describe(uri);
            if (item != null) files.put(item);
        }
        JSObject res = new JSObject();
        res.put("files", files);
        call.resolve(res);
    }

    /** 系统「另存为」：写出一个新文件（data 为文本，base64 为二进制，二选一） */
    @PluginMethod
    public void saveFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/octet-stream"));
        String name = call.getString("name", "untitled");
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "saveFileResult");
    }

    @ActivityCallback
    private void saveFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("用户取消");
            return;
        }
        Uri uri = result.getData().getData();
        String base64 = call.getString("base64", "");
        String text = call.getString("data", "");
        try {
            byte[] bytes = base64 != null && !base64.isEmpty()
                    ? Base64.decode(base64, Base64.DEFAULT)
                    : (text == null ? new byte[0] : text.getBytes(StandardCharsets.UTF_8));
            try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) {
                    call.reject("无法写入所选位置");
                    return;
                }
                out.write(bytes);
                out.flush();
            }
            remember(uri);
            JSObject res = describe(uri);
            if (res == null) res = new JSObject();
            res.put("success", true);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("写入失败: " + e.getMessage());
        }
    }

    // ---------------------------------------------------------------- 读写

    /** 按 uri 读文件（mode=text|base64） */
    @PluginMethod
    public void readFile(PluginCall call) {
        final String raw = call.getString("uri", "");
        if (raw == null || raw.isEmpty()) {
            call.reject("缺少 uri");
            return;
        }
        final String mode = call.getString("mode", "text");
        final int maxBytes = call.getInt("maxBytes", 0) == null ? 0 : call.getInt("maxBytes", 0);
        new Thread(() -> {
            try {
                Uri uri = Uri.parse(raw);
                byte[] bytes;
                try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                    if (in == null) {
                        call.reject("无法打开文件（授权可能已失效，请重新选择）");
                        return;
                    }
                    bytes = readAll(in, maxBytes);
                }
                JSObject res = new JSObject();
                if ("base64".equals(mode)) {
                    res.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                } else {
                    res.put("text", new String(bytes, StandardCharsets.UTF_8));
                }
                res.put("size", bytes.length);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("读取失败: " + e.getMessage());
            }
        }).start();
    }

    /** 查询 uri 的基本信息（名称 / 大小 / 类型），也用于判断授权是否仍有效 */
    @PluginMethod
    public void stat(PluginCall call) {
        String raw = call.getString("uri", "");
        JSObject res = describe(raw == null ? null : Uri.parse(raw));
        if (res == null) {
            res = new JSObject();
            res.put("exists", false);
        } else {
            res.put("exists", true);
        }
        call.resolve(res);
    }

    /** 已记住（含持久化读权限）的 uri 列表：插件/应用下次启动可直接读 */
    @PluginMethod
    public void remembered(PluginCall call) {
        JSArray uris = new JSArray();
        for (String u : prefs().getAll().keySet()) uris.put(u);
        JSObject res = new JSObject();
        res.put("uris", uris);
        call.resolve(res);
    }

    // ---------------------------------------------------------------- 内部

    private android.content.SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
    }

    private void remember(Uri uri) {
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception e) {
            // 提供方不支持持久化：本次会话内仍可用
        }
        try {
            prefs().edit().putString(uri.toString(), String.valueOf(System.currentTimeMillis())).apply();
        } catch (Exception ignored) {
        }
    }

    /** 读取 uri 的展示信息（name / size / mimeType） */
    private JSObject describe(Uri uri) {
        if (uri == null) return null;
        JSObject o = new JSObject();
        String name = null;
        long size = -1;
        ContentResolver cr = getContext().getContentResolver();
        try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int si = c.getColumnIndex(OpenableColumns.SIZE);
                if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni);
                if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
            }
        } catch (Exception ignored) {
        }
        if (name == null) {
            String last = uri.getLastPathSegment();
            name = last == null ? "" : last;
        }
        String mime = cr.getType(uri);
        o.put("uri", uri.toString());
        o.put("name", name == null ? "" : name);
        o.put("size", size);
        o.put("mime", mime == null ? "" : mime);
        // 是否为文档树（目录）
        boolean isTree = DocumentsContract.isTreeUri(uri);
        o.put("isDir", isTree);
        return o;
    }

    private static byte[] readAll(InputStream in, int maxBytes) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        int total = 0;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            total += n;
            if (maxBytes > 0 && total >= maxBytes) break;
        }
        return out.toByteArray();
    }
}
