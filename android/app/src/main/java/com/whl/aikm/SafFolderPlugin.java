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

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * SafFolder — 通过 SAF（Storage Access Framework）访问用户选定的文件夹。
 *
 * 为什么需要它：Capacitor Filesystem 只能访问应用沙箱目录，用户看不到自己的资料。
 * 本插件让用户用系统界面挑文件夹（ACTION_OPEN_DOCUMENT_TREE），拿到**可持久化**的
 * 目录授权（重启后仍有效），之后按「相对该文件夹的路径」做读写 / 列目录 / 增删改。
 *
 * **多授权根**：应用里不止一处要访问用户自己的文件夹（工作区、插件目录、插件自己的游戏 /
 * 数据目录……）。早期版本只存一份 tree_uri，任何一处再选文件夹都会把前一处顶掉——插件目录被
 * 顶掉后整个插件列表读空。现在按「名字 → uri」存多份，路径的第一段就是根名，各用各的互不干扰。
 *
 * 路径约定（与渲染层 src/platform/android/saf.ts 一致）：
 * - path 的第一个斜杠段是**授权根名**（`<根名>/sub/a.md`）：多授权根下按名字路由到对应文件夹；
 *   第一段不是已知根名时，按「最近一次授权的根 + 整条路径」处理（老版本渲染层会把根名剥掉，
 *   所以两种形状都得认；纯 '' 或 '/' 也表示最近一次授权的根）；
 * - '..' 段一律拒绝（防止越出授权范围）；
 * - 渲染层用 'saf:' 前缀标识这类路径（见 SAF_PREFIX）。
 *
 * 线程：文件 IO 都在单线程 executor 上执行（不阻塞主线程）；挑文件夹必须在主线程发起。
 */
@CapacitorPlugin(name = "SafFolder")
public class SafFolderPlugin extends Plugin {

    private static final String PREFS = "aikm_saf";
    /** 旧版（单授权根）的两个键：升级时并入 KEY_ROOTS，之后只跟着「最近一次」写，供旧版本回退读取 */
    private static final String KEY_URI = "tree_uri";
    private static final String KEY_NAME = "tree_name";
    /** 多授权根：JSON 对象 `{ "文件夹名": "content://…" }`（同名再选一次 = 刷新那条授权） */
    private static final String KEY_ROOTS = "tree_roots";
    /** 最近一次选择的授权根名：匿名 `saf:` 路径（工作区根）用它 */
    private static final String KEY_LAST = "tree_last";

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ---------------------------------------------------------------- 授权根

    /** 全部授权根（名字 → uri）：旧版单根也并进来，升级后原来的授权照旧可用 */
    private JSONObject rootsMap() {
        JSONObject out = new JSONObject();
        String legacyName = prefs().getString(KEY_NAME, "");
        String legacyUri = prefs().getString(KEY_URI, null);
        if (legacyUri != null && !legacyUri.isEmpty()) {
            try {
                out.put(legacyName == null ? "" : legacyName, legacyUri);
            } catch (Exception ignored) {
                // 旧记录异常：忽略（用户重选一次文件夹即可）
            }
        }
        String raw = prefs().getString(KEY_ROOTS, "");
        if (raw != null && !raw.isEmpty()) {
            try {
                JSONObject saved = new JSONObject(raw);
                Iterator<String> it = saved.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    String v = saved.optString(k, "");
                    if (!v.isEmpty()) out.put(k, v);
                }
            } catch (JSONException ignored) {
                // 存档坏了就当没有：用户重新选一次文件夹会写回一份新的
            }
        }
        return out;
    }

    /** 最近一次授权的根名（在已解析好的表里取）；表里没有它时退到任意一个，表空返回 '' */
    private static String lastRootNameIn(JSONObject map, String savedLast) {
        if (savedLast != null && !savedLast.isEmpty() && map.has(savedLast)) return savedLast;
        Iterator<String> it = map.keys();
        return it.hasNext() ? it.next() : "";
    }

    private String lastRootName() {
        return lastRootNameIn(rootsMap(), prefs().getString(KEY_LAST, ""));
    }

    /** uri → 授权根（授权失效 / uri 坏掉返回 null） */
    private DocumentFile treeOf(String uri) {
        if (uri == null || uri.isEmpty()) return null;
        try {
            return DocumentFile.fromTreeUri(getContext(), Uri.parse(uri));
        } catch (Exception e) {
            return null;
        }
    }

    /** 一次解析的结果：授权根 + 根内子路径 */
    private static final class Target {
        final DocumentFile root;
        final String sub;

        Target(DocumentFile root, String sub) {
            this.root = root;
            this.sub = sub;
        }
    }

    /**
     * 把相对路径解析成「授权根 + 根内子路径」（授权表只读一次）。
     *
     * 第一段正好是某个已授权文件夹名时按它路由；否则整条路径都算「最近一次授权根」里的子路径
     * （老版本渲染层会把根名剥掉，纯 `saf:` 也走这一支）。
     * 同名文件夹在这套路径口径下本来就分不出来（渲染层也只有 `saf:<名字>/…`），与渲染层一致。
     */
    private Target pick(String rel) {
        JSONObject map = rootsMap();
        String path = rel == null ? "" : rel.replaceAll("^/+", "");
        int idx = path.indexOf('/');
        String head = path.isEmpty() ? "" : (idx < 0 ? path : path.substring(0, idx));
        if (!head.isEmpty() && map.has(head)) {
            return new Target(treeOf(map.optString(head, "")), idx < 0 ? "" : path.substring(idx + 1));
        }
        String last = lastRootNameIn(map, prefs().getString(KEY_LAST, ""));
        return new Target(treeOf(map.optString(last, "")), path);
    }

    /** 路径是否直接指向某个授权根（授权根本身不允许删 / 当普通目录处理） */
    private boolean isRootPath(String rel) {
        String path = rel == null ? "" : rel.replaceAll("^/+", "").replaceAll("/+$", "");
        if (path.isEmpty()) return true;
        return rootsMap().has(path);
    }

    /** 相对路径 → DocumentFile；越界或不存在返回 null */
    private DocumentFile resolve(String rel) {
        Target t = pick(rel);
        return walk(t.root, t.sub);
    }

    // ---------------------------------------------------------------- 目录列表缓存

    /**
     * 目录列表缓存：`dir.getUri()` → （子项名 → DocumentFile）。
     *
     * 为什么需要：`DocumentFile.findFile(name)` 内部是「先向内容提供者查询这一层的**全部**子项，
     * 再按名字挑一个」——目录里躺着几百个 ROM 时，一次查询就是几十到上百毫秒；而按路径读一个文件
     * 要逐段 findFile，于是「列目录 → 逐个读卡带（封面 / 存档）」会把同一层目录反复查很多遍。
     * 这就是安卓上读 ROM / 读封面慢的第二个大头（第一个是经桥传 base64，已在渲染层解决）。
     *
     * 语义保持与「每次都查」一致：TTL 很短（2 秒），并且**任何写操作都会清空缓存**；
     * 缓存只放 DocumentFile（轻量句柄），最多 32 个目录。
     *
     * 线程：所有文件 IO 都在单线程 executor 上执行，缓存不需要额外同步。
     */
    private static final long DIR_CACHE_TTL_MS = 2000;
    private static final int DIR_CACHE_MAX = 32;
    private final Map<String, CachedDir> dirCache = new HashMap<>();

    private static final class CachedDir {
        final Map<String, DocumentFile> byName;
        final long at;

        CachedDir(Map<String, DocumentFile> byName, long at) {
            this.byName = byName;
            this.at = at;
        }
    }

    /** 列一层目录（带缓存）：提供者异常时按空目录处理 */
    private Map<String, DocumentFile> childrenOf(DocumentFile dir) {
        if (dir == null) return Collections.emptyMap();
        String key;
        try {
            key = dir.getUri().toString();
        } catch (Exception e) {
            return Collections.emptyMap();
        }
        long now = System.currentTimeMillis();
        CachedDir hit = dirCache.get(key);
        if (hit != null && now - hit.at <= DIR_CACHE_TTL_MS) return hit.byName;
        Map<String, DocumentFile> byName = new HashMap<>();
        try {
            for (DocumentFile f : dir.listFiles()) {
                String n = f.getName();
                if (n != null && !n.isEmpty()) byName.put(n, f);
            }
        } catch (Exception ignored) {
            // 列不出来：当空目录（上层会按「不存在」处理，不会假装读到东西）
        }
        if (dirCache.size() >= DIR_CACHE_MAX) dirCache.clear();
        dirCache.put(key, new CachedDir(byName, now));
        return byName;
    }

    /** 取子项（走缓存，替代 DocumentFile.findFile 的全量查询） */
    private DocumentFile childOf(DocumentFile dir, String name) {
        if (dir == null || name == null || name.isEmpty()) return null;
        return childrenOf(dir).get(name);
    }

    /** 任何写操作后都要清空（新建 / 删除 / 改名 / 复制都会让目录列表变化） */
    private void invalidateDirCache() {
        dirCache.clear();
    }

    /** 从某个已定位目录往下走（每段都不允许 ..） */
    private DocumentFile walk(DocumentFile from, String rel) {
        if (from == null) return null;
        if (rel == null || rel.isEmpty() || rel.equals("/")) return from;
        DocumentFile cur = from;
        for (String seg : rel.split("/")) {
            if (seg.isEmpty() || seg.equals(".")) continue;
            if (seg.equals("..")) return null;
            if (cur == null || !cur.isDirectory()) return null;
            cur = childOf(cur, seg);
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
        Target t = pick(rel);
        DocumentFile cur = t.root;
        if (cur == null) return null;
        String sub = t.sub;
        if (sub == null || sub.isEmpty() || sub.equals("/")) return cur;
        for (String seg : sub.split("/")) {
            if (seg.isEmpty() || seg.equals(".")) continue;
            if (seg.equals("..") || !cur.isDirectory()) return null;
            DocumentFile next = childOf(cur, seg);
            if (next == null) {
                next = cur.createDirectory(seg);
                invalidateDirCache(); // 刚建了目录：这一层的列表变了
            }
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

    /** 最近一次授权的根（附全部授权根名：渲染层用来展示 / 判断某个目录的授权还在不在） */
    @PluginMethod
    public void getRoot(PluginCall call) {
        String last = lastRootName();
        JSONObject map = rootsMap();
        JSObject res = new JSObject();
        res.put("granted", !last.isEmpty());
        res.put("name", last);
        res.put("uri", map.optString(last, ""));
        JSArray names = new JSArray();
        Iterator<String> it = map.keys();
        while (it.hasNext()) names.put(it.next());
        res.put("names", names);
        call.resolve(res);
    }

    /** 撤销全部授权（仅清掉记录，不动用户文件） */
    @PluginMethod
    public void clear(PluginCall call) {
        prefs().edit().remove(KEY_URI).remove(KEY_NAME).remove(KEY_ROOTS).remove(KEY_LAST).apply();
        invalidateDirCache();
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
        invalidateDirCache(); // 换了 / 新增了授权根：旧的目录缓存一律作废
        // 多授权根：新增 / 更新这一条，**不覆盖**别的文件夹的授权。
        // 旧版只留一份，在别处再选一个文件夹就会把这里顶掉（插件目录因此读空）。
        JSONObject map = rootsMap();
        try {
            map.put(name, uri.toString());
        } catch (Exception ignored) {
            // 名字异常（极少数提供方返回空名）：照样写进 KEY_LAST，至少「最近一次」还能用
        }
        prefs().edit()
                .putString(KEY_ROOTS, map.toString())
                .putString(KEY_LAST, name)                // 旧版单根的两个键跟着「最近一次」写：万一退回旧版本，最近选的那个仍可用
                .putString(KEY_URI, uri.toString())
                .putString(KEY_NAME, name)
                .apply();
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
                // 走 childrenOf：顺手把这一层的子项填进缓存 —— 「列目录 → 逐个读文件（封面 / 存档 / 卡带）」
                // 是最常见的用法，缓存命中后每个文件都不再重复查询这一层
                for (DocumentFile f : childrenOf(dir).values()) files.put(entryOf(f));
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
                        invalidateDirCache(); // 文件可能刚被创建出来：目录列表已经变了
                        call.reject("无法写入文件");
                        return;
                    }
                    out.write(bytes);
                    out.flush();
                }
                invalidateDirCache(); // 写完清缓存：紧接着按路径读回来时才不会撞到「创建前」那份列表
                JSObject res = new JSObject();
                res.put("path", path);
                res.put("size", bytes.length);
                call.resolve(res);
            } catch (Exception e) {
                invalidateDirCache();
                call.reject("写入失败: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        final String path = call.getString("path", "");
        io.execute(() -> {
            // 授权根名可能写在路径第一段（多授权根）：按实际要写的那条授权判空
            if (pick(path).root == null) {
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
            invalidateDirCache(); // 新建目录后目录列表变了
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
        // 多授权根：路径写成 `<根名>`（或 `<根名>/`）时指的也是授权根本身，同样不允许删
        if (isRootPath(path)) {
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
                    invalidateDirCache(); // 删掉了东西：目录列表变了
                    call.resolve(new JSObject());
                } else {
                    call.reject("删除失败: " + path);
                }
            } catch (Exception e) {
                invalidateDirCache();
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
                    invalidateDirCache(); // 改名 / 移动都会让目录列表变化
                    JSObject res = new JSObject();
                    res.put("path", to);
                    call.resolve(res);
                    return;
                }
                // 跨目录移动：SAF 没有直接移动 API → 复制到目标后删除源（覆盖同名目标文件）
                DocumentFile target = copyInto(src, destParent, name);
                if (target == null) {
                    invalidateDirCache();
                    call.reject("移动到目标失败: " + to);
                    return;
                }
                if (!deleteTree(src)) {
                    invalidateDirCache();
                    call.reject("源删除失败: " + from);
                    return;
                }
                invalidateDirCache();
                JSObject res = new JSObject();
                res.put("path", to);
                call.resolve(res);
            } catch (Exception e) {
                invalidateDirCache();
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
                        invalidateDirCache();
                        call.reject("复制目录失败: " + to);
                        return;
                    }
                    invalidateDirCache(); // 复制完成：目标那一层多了东西
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
                        invalidateDirCache();
                        call.reject("无法写入目标文件");
                        return;
                    }
                    out.write(bytes);
                    out.flush();
                }
                invalidateDirCache(); // 目标文件写好了：目录列表变了
                JSObject res = new JSObject();
                res.put("path", to);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("复制失败: " + e.getMessage());
            }
        });
    }
}
