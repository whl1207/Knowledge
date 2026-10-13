package com.whl.aikm;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * SafFolder — 通过 SAF（Storage Access Framework）访问用户选定的文件夹。
 *
 * 为什么需要它：Capacitor Filesystem 只能访问应用沙箱目录，用户看不到自己的资料。
 * 本插件让用户用系统界面挑一个文件夹（ACTION_OPEN_DOCUMENT_TREE），拿到**可持久化**的
 * 目录授权（重启后仍有效），之后按「相对该文件夹的路径」做读写 / 列目录 / 增删改。
 *
 * 路径约定（与渲染层 src/platform/android/saf.ts 一致）：
 * - 传入的 path 是相对已授权文件夹的路径，'' 或 '/' 表示根；
 * - '..' 段一律拒绝（防止越出授权范围）；
 * - 渲染层用 'saf:' 前缀标识这类路径（见 SAF_PREFIX）。
 *
 * 线程：文件 IO 都在单线程 executor 上执行（不阻塞主线程）；挑文件夹必须在主线程发起。
 */
@CapacitorPlugin(name = "SafFolder")
public class SafFolderPlugin extends Plugin {

    private static final String PREFS = "aikm_saf";
    private static final String KEY_URI = "tree_uri";
    private static final String KEY_NAME = "tree_name";

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** 已授权的根目录；未授权返回 null */
    private DocumentFile treeRoot() {
        String uri = prefs().getString(KEY_URI, null);
        if (uri == null || uri.isEmpty()) return null;
        try {
            return DocumentFile.fromTreeUri(getContext(), Uri.parse(uri));
        } catch (Exception e) {
            return null;
        }
    }

    /** 相对路径 → DocumentFile；越界或不存在返回 null */
    private DocumentFile resolve(String rel) {
        DocumentFile root = treeRoot();
        if (root == null) return null;
        if (rel == null || rel.isEmpty() || rel.equals("/")) return root;
        DocumentFile cur = root;
        for (String seg : rel.split("/")) {
            if (seg.isEmpty() || seg.equals(".")) continue;
            if (seg.equals("..")) return null;
            if (cur == null || !cur.isDirectory()) return null;
            cur = cur.findFile(seg);
            if (cur == null) return null;
        }
        return cur;
    }

    /** 父目录（相对路径的最后一段去掉） */
    private static String parentRelOf(String rel) {
        int idx = rel == null ? -1 : rel.lastIndexOf('/');
        return idx > 0 ? rel.substring(0, idx) : "";
    }

    /** 逐级创建目录（已存在则复用）；越界或失败返回 null */
    private DocumentFile ensureDir(String rel) {
        DocumentFile cur = treeRoot();
        if (cur == null) return null;
        if (rel == null || rel.isEmpty() || rel.equals("/")) return cur;
        for (String seg : rel.split("/")) {
            if (seg.isEmpty() || seg.equals(".")) continue;
            if (seg.equals("..") || !cur.isDirectory()) return null;
            DocumentFile next = cur.findFile(seg);
            if (next == null) next = cur.createDirectory(seg);
            if (next == null) return null;
            cur = next;
        }
        return cur;
    }

    /** 把 src（文件或目录）复制到 destParent 下并命名为 name；同名目标复用（覆盖），失败返回 null */
    private DocumentFile copyInto(DocumentFile src, DocumentFile destParent, String name) throws Exception {
        DocumentFile existing = destParent.findFile(name);
        if (src.isDirectory()) {
            DocumentFile dir = existing != null && existing.isDirectory() ? existing : destParent.createDirectory(name);
            if (dir == null) return null;
            for (DocumentFile child : src.listFiles()) {
                String childName = child.getName();
                if (childName == null || childName.isEmpty()) childName = "untitled";
                if (copyInto(child, dir, childName) == null) return null;
            }
            return dir;
        }
        DocumentFile file = existing != null && existing.isFile() ? existing : createFileNamed(destParent, name);
        if (file == null) return null;
        try (InputStream in = getContext().getContentResolver().openInputStream(src.getUri())) {
            if (in == null) return null;
            try (OutputStream out = getContext().getContentResolver().openOutputStream(file.getUri(), "wt")) {
                if (out == null) return null;
                out.write(readAll(in));
                out.flush();
            }
        }
        return file;
    }

    /**
     * 建文件，并把名称校正为期望值。
     * 部分提供方（含系统「外部存储」）会按 MIME 给文件名补扩展名（`nested.md` → `nested.md.txt`，
     * 因为 Android 的 MimeTypeMap 不认识 `md`），不校正的话调用方按原路径就会「文件不存在」。
     */
    private DocumentFile createFileNamed(DocumentFile parent, String name) {
        DocumentFile file = parent.createFile(mimeOf(name), name);
        if (file == null) return null;
        String actual = file.getName();
        if (actual == null || actual.equals(name)) return file;
        try {
            Uri renamed = DocumentsContract.renameDocument(getContext().getContentResolver(), file.getUri(), name);
            DocumentFile fixed = renamed == null ? null : DocumentFile.fromSingleUri(getContext(), renamed);
            if (fixed != null && fixed.exists()) return fixed;
        } catch (Exception e) {
            // 校正失败：只能返回原文件（提供方限制），调用方会按名称找不到
        }
        return file;
    }

    /** 递归删除（目录先删子项） */
    private boolean deleteTree(DocumentFile f) {
        if (f == null) return false;
        if (f.isDirectory()) {
            for (DocumentFile child : f.listFiles()) {
                if (!deleteTree(child)) return false;
            }
        }
        return f.delete();
    }

    private static String nameOf(String rel) {
        int idx = rel.lastIndexOf('/');
        return idx >= 0 ? rel.substring(idx + 1) : rel;
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".md") || n.endsWith(".txt") || n.endsWith(".json") || n.endsWith(".csv")
                || n.endsWith(".yml") || n.endsWith(".yaml")) return "text/plain";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".pdf")) return "application/pdf";
        return "application/octet-stream";
    }

    private JSObject entryOf(DocumentFile f) {
        JSObject o = new JSObject();
        o.put("name", f.getName() == null ? "" : f.getName());
        o.put("type", f.isDirectory() ? "directory" : "file");
        o.put("size", f.isDirectory() ? 0 : f.length());
        o.put("mtime", f.lastModified());
        return o;
    }

    // ---------------------------------------------------------------- 授权

    /** 是否已授权（返回根目录名，便于界面展示） */
    @PluginMethod
    public void getRoot(PluginCall call) {
        JSObject res = new JSObject();
        String uri = prefs().getString(KEY_URI, null);
        res.put("granted", uri != null && !uri.isEmpty());
        res.put("name", prefs().getString(KEY_NAME, ""));
        res.put("uri", uri == null ? "" : uri);
        call.resolve(res);
    }

    /** 撤销授权（仅清掉记录，不动用户文件） */
    @PluginMethod
    public void clear(PluginCall call) {
        prefs().edit().remove(KEY_URI).remove(KEY_NAME).apply();
        call.resolve();
    }

    /** 弹系统文件夹选择器（必须主线程发起） */
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            call.reject("用户取消");
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("未取得目录");
            return;
        }
        try {
            // 关键：取得持久化权限，否则重启后失效
            getContext().getContentResolver().takePersistableUriPermission(
                    uri,
                    result.getData().getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION));
        } catch (Exception e) {
            // 某些提供方不支持持久化：仍继续（本次会话可用）
        }
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), uri);
        String name = root != null && root.getName() != null ? root.getName() : "选择的文件夹";
        prefs().edit().putString(KEY_URI, uri.toString()).putString(KEY_NAME, name).apply();
        JSObject res = new JSObject();
        res.put("name", name);
        res.put("uri", uri.toString());
        call.resolve(res);
    }

    // ---------------------------------------------------------------- 读

    @PluginMethod
    public void readFile(PluginCall call) {
        final String path = call.getString("path", "");
        final String mode = call.getString("mode", "text");
        io.execute(() -> {
            DocumentFile f = resolve(path);
            if (f == null || !f.isFile()) {
                call.reject("文件不存在: " + path);
                return;
            }
            try (InputStream in = getContext().getContentResolver().openInputStream(f.getUri())) {
                if (in == null) {
                    call.reject("无法打开文件");
                    return;
                }
                byte[] bytes = readAll(in);
                JSObject res = new JSObject();
                if ("base64".equals(mode)) {
                    res.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                } else {
                    res.put("data", new String(bytes, StandardCharsets.UTF_8));
                }
                res.put("size", bytes.length);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("读取失败: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stat(PluginCall call) {
        final String path = call.getString("path", "");
        io.execute(() -> {
            DocumentFile f = resolve(path);
            if (f == null) {
                JSObject res = new JSObject();
                res.put("exists", false);
                call.resolve(res);
                return;
            }
            JSObject res = new JSObject();
            res.put("exists", true);
            res.put("type", f.isDirectory() ? "directory" : "file");
            res.put("size", f.isDirectory() ? 0 : f.length());
            res.put("mtime", f.lastModified());
            res.put("name", f.getName() == null ? "" : f.getName());
            call.resolve(res);
        });
    }

    @PluginMethod
    public void readdir(PluginCall call) {
        final String path = call.getString("path", "");
        io.execute(() -> {
            DocumentFile dir = resolve(path);
            JSArray files = new JSArray();
            if (dir != null && dir.isDirectory()) {
                for (DocumentFile f : dir.listFiles()) files.put(entryOf(f));
            }
            JSObject res = new JSObject();
            res.put("files", files);
            call.resolve(res);
        });
    }

    /**
     * 取「已授权目录内某个文件」的可共享 uri（content://…/document/…）。
     * 分享 / 用其它应用打开时需要它：file:// 在 Android 7+ 会抛 FileUriExposedException，
     * 而这里给出的 document uri 可以随 Intent 一起授予临时读权限。
     */
    @PluginMethod
    public void getUri(PluginCall call) {
        final String path = call.getString("path", "");
        io.execute(() -> {
            DocumentFile f = resolve(path);
            if (f == null) {
                call.reject("路径不存在: " + path);
                return;
            }
            JSObject res = new JSObject();
            res.put("uri", f.getUri().toString());
            res.put("name", f.getName() == null ? "" : f.getName());
            res.put("type", f.isDirectory() ? "directory" : "file");
            call.resolve(res);
        });
    }

    // ---------------------------------------------------------------- 写

    @PluginMethod
    public void writeFile(PluginCall call) {
        final String path = call.getString("path", "");
        final String data = call.getString("data", "");
        final String encoding = call.getString("encoding", "utf8");
        io.execute(() -> {
            try {
                byte[] bytes = "base64".equals(encoding)
                        ? Base64.decode(data, Base64.DEFAULT)
                        : data.getBytes(StandardCharsets.UTF_8);
                DocumentFile target = resolve(path);
                if (target == null) {
                    // 与 Capacitor Filesystem 的 recursive 写口径一致：父目录不存在时逐级创建
                    DocumentFile parent = ensureDir(parentRelOf(path));
                    if (parent == null) {
                        call.reject("父目录不可用: " + path);
                        return;
                    }
                    String name = nameOf(path);
                    target = createFileNamed(parent, name);
                    if (target == null) {
                        call.reject("无法创建文件: " + name);
                        return;
                    }
                }
                try (OutputStream out = getContext().getContentResolver().openOutputStream(target.getUri(), "wt")) {
                    if (out == null) {
                        call.reject("无法写入文件");
                        return;
                    }
                    out.write(bytes);
                    out.flush();
                }
                JSObject res = new JSObject();
                res.put("path", path);
                res.put("size", bytes.length);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("写入失败: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        final String path = call.getString("path", "");
        io.execute(() -> {
            if (treeRoot() == null) {
                call.reject("尚未授权文件夹");
                return;
            }
            try {
                if (ensureDir(path) == null) {
                    call.reject("无法创建目录（路径越界或权限不足）: " + path);
                    return;
                }
            } catch (Exception e) {
                call.reject("创建目录失败: " + e.getMessage());
                return;
            }
            JSObject res = new JSObject();
            res.put("path", path);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        final String path = call.getString("path", "");
        if (path == null || path.isEmpty() || path.equals("/")) {
            call.reject("不允许删除授权根目录本身");
            return;
        }
        io.execute(() -> {
            try {
                DocumentFile f = resolve(path);
                if (f == null) {
                    call.reject("路径不存在: " + path);
                    return;
                }
                // 递归删除：目录必须先删子项，否则 DocumentFile.delete() 会失败
                if (deleteTree(f)) {
                    call.resolve(new JSObject());
                } else {
                    call.reject("删除失败: " + path);
                }
            } catch (Exception e) {
                call.reject("删除失败: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void rename(PluginCall call) {
        final String from = call.getString("from", "");
        final String to = call.getString("to", "");
        io.execute(() -> {
            try {
                DocumentFile src = resolve(from);
                if (src == null) {
                    call.reject("路径不存在: " + from);
                    return;
                }
                String name = nameOf(to);
                if (name.isEmpty()) {
                    call.reject("目标名称不能为空");
                    return;
                }
                DocumentFile destParent = ensureDir(parentRelOf(to));
                if (destParent == null) {
                    call.reject("目标目录不可用: " + to);
                    return;
                }
                DocumentFile srcParent = src.getParentFile();
                boolean sameParent = srcParent != null && srcParent.getUri().equals(destParent.getUri());
                if (sameParent && src.renameTo(name)) {
                    JSObject res = new JSObject();
                    res.put("path", to);
                    call.resolve(res);
                    return;
                }
                // 跨目录移动：SAF 没有直接移动 API → 复制到目标后删除源（覆盖同名目标文件）
                DocumentFile target = copyInto(src, destParent, name);
                if (target == null) {
                    call.reject("移动到目标失败: " + to);
                    return;
                }
                if (!deleteTree(src)) {
                    call.reject("源删除失败: " + from);
                    return;
                }
                JSObject res = new JSObject();
                res.put("path", to);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("重命名失败: " + e.getMessage());
            }
        });
    }

    /** 复制文件或目录（目录递归复制；同名目标文件覆盖） */
    @PluginMethod
    public void copy(PluginCall call) {
        final String from = call.getString("from", "");
        final String to = call.getString("to", "");
        io.execute(() -> {
            try {
                DocumentFile src = resolve(from);
                if (src == null) {
                    call.reject("源不存在: " + from);
                    return;
                }
                String name = nameOf(to);
                DocumentFile destParent = ensureDir(parentRelOf(to));
                if (destParent == null || name.isEmpty()) {
                    call.reject("目标目录不存在: " + to);
                    return;
                }
                if (src.isDirectory()) {
                    if (copyInto(src, destParent, name) == null) {
                        call.reject("复制目录失败: " + to);
                        return;
                    }
                    JSObject res = new JSObject();
                    res.put("path", to);
                    call.resolve(res);
                    return;
                }
                byte[] bytes;
                try (InputStream in = getContext().getContentResolver().openInputStream(src.getUri())) {
                    if (in == null) {
                        call.reject("无法读取源文件");
                        return;
                    }
                    bytes = readAll(in);
                }
                DocumentFile target = resolve(to);
                if (target == null) {
                    target = destParent.createFile(mimeOf(name), name);
                    if (target == null) {
                        call.reject("无法创建目标文件");
                        return;
                    }
                }
                try (OutputStream out = getContext().getContentResolver().openOutputStream(target.getUri(), "wt")) {
                    if (out == null) {
                        call.reject("无法写入目标文件");
                        return;
                    }
                    out.write(bytes);
                    out.flush();
                }
                JSObject res = new JSObject();
                res.put("path", to);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("复制失败: " + e.getMessage());
            }
        });
    }
}
