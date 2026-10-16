<!--
  PluginManagement.vue — 设置 → 插件（P0 主进程插件宿主的管理面）

  安全提示（必须显著）：插件与宿主同进程运行，**不受工作区沙箱保护**；
  因此启用/禁用/重载/移除/改配置都走「先展示权限 → 弹确认框 → 带 confirm 重试」的审批路径
  （未确认时主进程返回 PERMISSION_DENIED 且不改变状态，见 electron/main/plugin-ipc.ts）。

  插件目录：userData/plugins（设置页可一键打开）；放入插件包后宿主会自动发现，
  源码改动会触发自动重载（fs.watch）。
-->
<template>
  <div class="plugin-panel" :class="{ tall: isTallLayout }">
    <!-- ===================== 左侧：插件导航（安装 / 搜索 / 启用开关 / 状态） =====================
         细长窗口下与右侧详情各占满整屏互相切换（见 .tall 样式） -->
    <aside class="plugin-sidebar" v-show="!isTallLayout || showNavScreen">
      <div class="plugin-toolbar">
        <button
          class="toolbar-btn primary"
          @click="installFromFolder"
          :title="zh ? '从本地文件夹安装插件' : 'Install a plugin from a local folder'"
        >
          <i class="fa fa-plus"></i><span>{{ zh ? '安装插件' : 'Install' }}</span>
        </button>
        <button class="toolbar-btn" @click="refresh" :title="zh ? '刷新列表' : 'Refresh list'">
          <i class="fa fa-refresh"></i>
        </button>
        <button
          class="toolbar-btn"
          @click="rescan"
          :title="zh ? '重新扫描插件目录（含子文件夹里的新插件；会装载插件代码，需确认）' : 'Rescan plugins folder (including new plugins in subfolders; loads plugin code, asks for confirmation)'"
        >
          <i class="fa fa-search-plus"></i>
        </button>
        <button class="toolbar-btn" @click="openDir()" :title="zh ? '在资源管理器中打开插件目录' : 'Open the plugins folder in Explorer'">
          <i class="fa fa-external-link"></i>
        </button>
        <button class="toolbar-btn" @click="chooseRoot" :title="zh ? '选择插件目录' : 'Select plugins folder'">
          <i class="fa fa-folder-open"></i>
        </button>
      </div>

      <!-- 搜索过滤：名称 / id / 文件夹 / 权限 / 工具 / 描述 / 状态 任一命中即显示 -->
      <div class="plugin-sidebar-search">
        <i class="fa fa-search"></i>
        <input
          v-model="keyword"
          spellcheck="false"
          :placeholder="zh ? '搜索插件（名称 / id / 文件夹 / 权限 / 工具）' : 'Search plugins (name / id / folder / permission / tool)'"
        />
        <i
          v-if="keyword"
          class="fa fa-times-circle plugin-search-clear"
          :title="zh ? '清除搜索' : 'Clear search'"
          @click="keyword = ''"
        ></i>
      </div>

      <div class="plugin-nav-list scoll">
        <div v-if="unavailable" class="plugin-empty">
          <i class="fa fa-info-circle"></i>
          {{ zh ? '插件管理在当前环境不可用（找不到可读的插件目录 / 宿主未就绪）' : 'Plugin management is unavailable here (no readable plugins folder / host not ready)' }}
        </div>
        <div v-else-if="!plugins.length" class="plugin-empty">
          <span>{{ zh
            ? '还没有插件。点上方「安装插件」选择插件文件夹，或把插件文件夹放进插件目录后点「重新扫描」。插件可以直接放在插件目录下，也可以按用途分文件夹存放（会扫描各级子文件夹）。'
            : 'No plugins yet. Click “Install” to pick a plugin folder, or drop one into the plugins folder and click “Rescan”. Plugins may sit directly in the plugins folder or inside category subfolders.' }}</span>
          <span v-if="androidHost" class="plugin-empty-note">
            {{ zh
              ? '安卓：插件目录在应用私有存储里（插件目录用 data: 开头时指向应用私有目录）。用「安装插件」从手机里选插件文件夹最稳妥；把插件直接丢进公共「Documents/plugins」可能因系统权限读不到。'
              : 'Android: the plugins folder lives in app-private storage (a folder named with the data: prefix). Prefer “Install” to copy a plugin folder from your phone; dropping plugins into public Documents/plugins may be unreadable due to system permissions.' }}
          </span>
        </div>
        <div v-else-if="!filteredPlugins.length" class="plugin-empty">
          {{ zh ? `没有匹配「${keyword.trim()}」的插件。` : `No plugins match “${keyword.trim()}”.` }}
          <span class="plugin-empty-clear" @click="keyword = ''">{{ zh ? '清除搜索' : 'Clear search' }}</span>
        </div>
        <template v-else>
          <!-- 拖动排序（vuedraggable）：顺序 = 导航栏插件图标 / 启动器网格的顺序。
               #item 插槽每条目**只能有一个根节点**（见 src/shared/draggableSlot.selftest.ts），
               所以行本身必须是插槽唯一根元素，行内的把手/开关放在它里面。 -->
          <draggable
            v-model="draggablePlugins"
            item-key="id"
            class="plugin-nav-drag-list"
            :animation="160"
            ghost-class="plugin-nav-ghost"
            chosen-class="plugin-nav-chosen"
            :force-fallback="true"
            :fallback-on-body="true"
            :disabled="!canReorder"
          >
            <template #item="{ element: p }">
              <div
                class="plugin-nav-item"
                :class="{ active: selectedId === p.id, disabled: !p.enabled }"
                :title="`${p.name} · ${p.id}`"
                @click="selectPlugin(p.id)"
              >
                <div class="plugin-nav-top">
                  <!-- 拖动把手：整行可拖，这里只是「可以拖」的视觉提示 -->
                  <i
                    v-if="canReorder"
                    class="fa fa-bars plugin-nav-grip"
                    :title="zh ? '按住拖动调整顺序（导航栏插件图标顺序随之变化）' : 'Drag to reorder (the navbar icon order follows)'"
                  ></i>
                  <span class="plugin-nav-icon" :class="`status-${p.status}`"><i :class="statusIcon(p.status)"></i></span>
                  <span class="plugin-nav-name">{{ p.name }}</span>
                  <span
                    class="plugin-nav-toggle"
                    :class="{ on: p.enabled }"
                    :title="p.enabled
                      ? (zh ? '点击禁用（工具与界面元素立即消失）' : 'Click to disable (tools and UI elements disappear immediately)')
                      : (zh ? '点击启用（会先展示权限并要求确认）' : 'Click to enable (shows permissions and asks for confirmation)')"
                    @click.stop="setEnabled(p, !p.enabled)"
                  ><span class="toggle-knob"></span></span>
                </div>
                <div class="plugin-nav-meta">
                  <span class="plugin-nav-status">
                    <i class="plugin-nav-dot" :class="`status-${p.status}`"></i>{{ statusLabel(p.status) }}
                  </span>
                  <span class="plugin-nav-badge">v{{ p.version }}</span>
                  <span v-if="p.tools.length" class="plugin-nav-tools" :title="zh ? '已注册的工具（scope = plugin:id）' : 'Registered tools (scope = plugin:id)'">
                    <i class="fa fa-wrench"></i>{{ p.tools.length }}
                  </span>
                </div>
              </div>
            </template>
          </draggable>
        </template>
      </div>

      <!-- 底部通栏：数量（含搜索命中数）+ 安全声明 / 可注入服务 / 插件目录 -->
      <div class="plugin-sidebar-foot">
        <div class="plugin-foot-row">
          <span class="plugin-foot-count">
            {{ kw ? `${filteredPlugins.length} / ${plugins.length}` : plugins.length }} {{ zh ? '个插件' : 'plugins' }}
          </span>
          <span class="plugin-foot-icons">
            <i
              v-if="orderCustomized"
              class="fa fa-sort-amount-down plugin-foot-icon action"
              :title="zh ? '导航顺序已自定义：恢复宿主默认顺序（各插件声明 order 的顺序）' : 'Custom nav order: reset to the host default order'"
              @click="resetOrder"
            ></i>
            <i
              v-if="customRoot"
              class="fa fa-undo plugin-foot-icon action"
              :title="zh ? '恢复默认插件目录（用户数据目录下的 plugins）' : 'Reset to the default plugins folder (userData/plugins)'"
              @click="resetRoot"
            ></i>
            <i v-if="services.length" class="fa fa-plug plugin-foot-icon" :title="servicesHint"></i>
            <i class="fa fa-exclamation-triangle plugin-safe-icon" :title="securityNotice"></i>
          </span>
        </div>
        <!-- 排序提示：拖动顺序 = 导航栏插件图标 / 启动器网格的顺序（用户明确问过这件事，写在界面上） -->
        <div v-if="canReorder" class="plugin-order-hint">
          <i class="fa fa-bars"></i>
          <span>{{ zh
            ? (orderCustomized
              ? '已按你的拖动顺序排列：导航栏的插件图标与「全部插件」网格都按这个顺序显示'
              : '按住插件行拖动可调整顺序；导航栏的插件图标顺序会跟着这个顺序走')
            : (orderCustomized
              ? 'Ordered as you dragged: navbar plugin icons and the “All plugins” grid follow it'
              : 'Drag plugin rows to reorder; the navbar plugin icon order follows it') }}</span>
        </div>
        <div class="folder-path" :title="rootDir || (zh ? '未设置' : 'Not set')">
          <i class="fa fa-folder"></i> {{ rootDir || (zh ? '未设置插件目录' : 'No plugins folder set') }}
        </div>
      </div>
    </aside>

    <!-- ===================== 右侧：插件详情（详情 / 配置 / 日志 / 数据） ===================== -->
    <section class="plugin-content scoll" v-show="!isTallLayout || !showNavScreen">
      <!-- 细长窗口：详情屏左上角返回（回到整屏插件列表） -->
      <div v-if="isTallLayout" class="plugin-back-bar">
        <div class="plugin-back" @click="showNavScreen = true"
          :title="zh ? '返回插件列表' : 'Back to plugin list'">
          <i class="fa fa-arrow-left"></i>
        </div>
        <span class="plugin-back-title">{{ zh ? '插件详情' : 'Plugin Details' }}</span>
      </div>
      <!-- 被跳过的目录（有清单但目录名不能作为插件 id）：必须显式提示，否则用户只看到「放进去什么都没发生」 -->
      <div v-if="invalidNamedDirs.length" class="plugin-notice warn">
        <i class="fa fa-exclamation-circle"></i>
        <div class="plugin-notice-body">
          <div class="plugin-notice-title">
            {{ zh ? `有 ${invalidNamedDirs.length} 个插件文件夹被跳过` : `${invalidNamedDirs.length} plugin folder(s) skipped` }}
          </div>
          <div class="plugin-notice-desc">
            {{ zh
              ? '这些文件夹里有插件清单，但目录名不能作为插件 id（必须是 ASCII 小写、只含 a-z0-9._-，以字母或数字开头；中文 / 大写 / 空格都会被跳过）。改成英文目录名后会自动识别，无需重启。'
              : 'These folders contain a manifest, but the folder name cannot be used as a plugin id (ASCII lowercase only, containing a-z0-9._- and starting with a letter or digit; Chinese characters, uppercase letters and spaces are skipped). Rename them to ASCII and they are picked up automatically — no restart needed.' }}
            <div class="plugin-invalid-dirs">
              <code v-for="d in invalidNamedDirs" :key="d">{{ d }}</code>
            </div>
          </div>
        </div>
      </div>

      <template v-if="selected">
        <!-- 标题行：名称 + 标识徽标 + 状态（右侧：启用开关 + 重载 / 打开目录 / 移除） -->
        <div class="plugin-pane-head">
          <div class="plugin-pane-head-left">
            <span class="plugin-pane-name">{{ selected.name }}</span>
            <code class="plugin-id">{{ selected.id }}</code>
            <span class="plugin-badge">v{{ selected.version }}</span>
            <span class="plugin-badge" :title="zh ? '插件要求的宿主 API 版本区间' : 'Required host API range'">API {{ selected.apiVersion || '—' }}</span>
            <span class="plugin-status-pill" :class="`status-${selected.status}`">{{ statusLabel(selected.status) }}</span>
            <span v-if="!selected.enabled && selected.status !== 'disabled'" class="plugin-badge dim">{{ zh ? '已禁用' : 'Disabled' }}</span>
          </div>
          <div class="plugin-pane-head-actions">
            <span
              class="plugin-toggle"
              :class="{ on: selected.enabled }"
              :title="selected.enabled
                ? (zh ? '已启用，点击禁用（工具与界面元素立即消失）' : 'Enabled, click to disable')
                : (zh ? '已禁用，点击启用（会先展示权限并要求确认）' : 'Disabled, click to enable (shows permissions, asks for confirmation)')"
              @click="setEnabled(selected, !selected.enabled)"
            ><span class="toggle-knob"></span></span>
            <span class="plugin-head-divider"></span>
            <div class="head-btns">
              <button
                class="head-btn"
                @click="reloadPlugin(selected)"
                :title="zh ? '重载：撤销旧注册后重跑 apply（改代码 / 改配置后用它生效）' : 'Reload: dispose old registrations and re-run apply'"
              >
                <i class="fa fa-refresh"></i>
              </button>
              <button
                class="head-btn"
                @click="openDir(selected.id)"
                :title="zh ? '在资源管理器中打开该插件目录' : 'Open this plugin folder in Explorer'"
              >
                <i class="fa fa-folder-open"></i>
              </button>
              <button
                class="head-btn danger"
                @click="removePlugin(selected)"
                :title="zh ? '移除插件（可选是否连磁盘文件一起删除）' : 'Remove plugin (optionally delete its files)'"
              >
                <i class="fa fa-trash-o"></i>
              </button>
            </div>
          </div>
        </div>

        <div v-if="selected.error" class="plugin-notice error">
          <i class="fa fa-times-circle"></i>
          <div class="plugin-notice-body">
            <div class="plugin-notice-title">{{ zh ? '加载失败' : 'Load failed' }}</div>
            <div class="plugin-notice-desc">{{ selected.error }}</div>
          </div>
        </div>

        <!-- ① 详情：权限 / 注册内容 / 界面位置 / 快捷键（本地诊断，不联网） -->
        <div class="plugin-group">
          <div class="plugin-group-title">
            <i class="fa fa-info-circle"></i><span>{{ zh ? '详情' : 'Details' }}</span>
            <span class="plugin-group-note">{{ zh ? '取自插件清单与运行时注册表' : 'From the manifest and runtime registry' }}</span>
          </div>
          <div class="plugin-detail-body">
            <div class="detail-row">
              <span class="detail-k">{{ zh ? '标识' : 'Id' }}</span>
              <span class="detail-v"><code>{{ selected.id }}</code> · v{{ selected.version }} · API {{ selected.apiVersion || '—' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-k">{{ zh ? '状态' : 'Status' }}</span>
              <span class="detail-v">{{ statusDetail(selected) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-k">{{ zh ? '描述' : 'Description' }}</span>
              <span class="detail-v">{{ selected.description || (zh ? '（插件未写描述）' : '(no description)') }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-k">{{ zh ? '权限' : 'Permissions' }}</span>
              <span class="detail-v">
                {{ selected.permissions.length ? selected.permissions.join(' / ') : (zh ? '无' : 'none') }}
                <div
                  v-for="perm in selected.permissions"
                  :key="perm"
                  class="detail-hint"
                >{{ PERMISSION_HINTS[perm] ? `${perm} — ${zh ? PERMISSION_HINTS[perm][0] : PERMISSION_HINTS[perm][1]}` : perm }}</div>
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-k">{{ zh ? '工具' : 'Tools' }}</span>
              <span class="detail-v">{{ selected.tools.length ? selected.tools.join(', ') : (zh ? '无' : 'none') }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-k">{{ zh ? '服务' : 'Services' }}</span>
              <span class="detail-v">{{ selected.services.length ? selected.services.join(', ') : (zh ? '无' : 'none') }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-k">{{ zh ? '界面位置' : 'UI surface' }}</span>
              <span class="detail-v">
                {{ detailSlots.length ? detailSlots.join(' · ') : (zh ? '未注册（或未声明 client 半边）' : 'none') }}
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-k">{{ zh ? '快捷键' : 'Shortcuts' }}</span>
              <span class="detail-v">
                <template v-if="detailShortcuts.length">
                  <code v-for="s in detailShortcuts" :key="s.display" class="detail-shortcut">{{ s.display }}</code>
                  <span class="detail-note">{{ detailShortcuts.map((s) => (zh ? s.descriptionZh : s.descriptionEn) || s.display).join('；') }}</span>
                </template>
                <template v-else>{{ zh ? '无' : 'none' }}</template>
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-k">{{ zh ? '依赖' : 'Requires' }}</span>
              <span class="detail-v">{{ selected.inject.length ? selected.inject.join(', ') : (zh ? '无' : 'none') }}</span>
            </div>
            <div v-if="selected.hasClient" class="detail-row">
              <span class="detail-k">{{ zh ? '界面半边' : 'UI half' }}</span>
              <span class="detail-v" :class="{ error: clientStates[selected.id] && !clientStates[selected.id].ok }">
                {{ clientStates[selected.id] && !clientStates[selected.id].ok
                  ? (zh ? '装载失败' : 'Failed to load')
                  : (zh ? '正常（P1 生效）' : 'OK (effective in P1)') }}
                <div v-if="clientStates[selected.id] && !clientStates[selected.id].ok" class="detail-hint">{{ clientBadgeHint(selected.id) }}</div>
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-k">{{ zh ? '文件夹' : 'Folder' }}</span>
              <span class="detail-v">
                <template v-if="selected.folder">
                  <i class="fa fa-folder"></i> {{ selected.folder }}
                  <span class="detail-note">{{ zh ? `（相对插件目录：${selected.relDir}）` : `(relative to plugins dir: ${selected.relDir})` }}</span>
                </template>
                <template v-else>{{ zh ? '插件目录根（未分文件夹）' : 'plugins directory root' }}</template>
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-k">{{ zh ? '目录' : 'Path' }}</span>
              <span class="detail-v path">{{ selected.dir }}</span>
            </div>
          </div>
          <div class="plugin-group-foot">
            <span class="hint">{{ zh ? '快捷键需插件已激活才生效' : 'Shortcuts are live only while the plugin is active' }}</span>
          </div>
        </div>

        <!-- ② 配置：直接编辑（保存后点「重载」生效） -->
        <div class="plugin-group">
          <div class="plugin-group-title">
            <i class="fa fa-sliders"></i><span>{{ zh ? '配置' : 'Config' }}</span>
            <span class="plugin-group-note">{{ zh ? 'JSON 对象；传给 ctx.config，保存后点「重载」生效' : 'JSON object passed to ctx.config; save, then Reload to apply' }}</span>
            <div class="plugin-group-actions">
              <button
                class="head-btn"
                :disabled="configLoading"
                @click="loadConfig(selected)"
                :title="zh ? '重新读取（丢弃未保存的改动）' : 'Read again (discards unsaved edits)'"
              >
                <i class="fa" :class="configLoading ? 'fa-spinner fa-spin' : 'fa-undo'"></i>
              </button>
              <button
                class="head-btn primary"
                @click="saveConfig"
                :title="zh ? '保存配置（重启或重载后生效）' : 'Save config (applies after restart or Reload)'"
              >
                <i class="fa fa-save"></i>
              </button>
            </div>
          </div>
          <div class="plugin-group-body">
            <textarea
              v-model="configText"
              spellcheck="false"
              class="plugin-config-input"
              :placeholder="zh ? '{\n  // 传给插件的配置\n}' : '{\n  // config passed to the plugin\n}'"
            ></textarea>
          </div>
        </div>

        <!-- ③ 日志：插件运行日志（本地缓冲） -->
        <div class="plugin-group">
          <div class="plugin-group-title">
            <i class="fa fa-list-alt"></i><span>{{ zh ? '日志' : 'Logs' }}</span>
            <span class="plugin-group-note">{{ zh ? '插件通过 ctx.log 输出（有新日志可点右侧刷新）' : 'Written by ctx.log (hit refresh for new lines)' }}</span>
            <div class="plugin-group-actions">
              <button
                class="head-btn"
                :disabled="logLoading"
                @click="loadLogs(selected)"
                :title="zh ? '刷新日志' : 'Refresh logs'"
              >
                <i class="fa" :class="logLoading ? 'fa-spinner fa-spin' : 'fa-refresh'"></i>
              </button>
            </div>
          </div>
          <pre class="plugin-log">{{ logText }}</pre>
        </div>

        <!-- ④ 数据：占用统计与清理（localStorage + OPFS plugins/<id>/ + 主进程 plugins-data/<id>/） -->
        <div class="plugin-group">
          <div class="plugin-group-title">
            <i class="fa fa-database"></i><span>{{ zh ? '数据' : 'Data' }}</span>
            <span class="plugin-group-note" :title="dataBadgeHint(selected.id)">
              {{ zh ? '这个插件自己占用的设置 / 存档' : 'Settings and saves owned by this plugin' }}
            </span>
            <div class="plugin-group-actions">
              <button class="head-btn" @click="refreshCurrentData" :title="zh ? '重新统计' : 'Re-measure'">
                <i class="fa fa-refresh"></i>
              </button>
              <button
                class="small-btn danger"
                @click="clearData"
                :title="zh ? '只删这个插件自己的设置 / 存档，不影响插件本体文件' : 'Removes only this plugin’s own settings / saves, never the plugin files'"
              >{{ zh ? '清除全部数据' : 'Clear all data' }}</button>
            </div>
          </div>
          <div class="plugin-detail-body">
            <div class="detail-row">
              <span class="detail-k">{{ zh ? '合计' : 'Total' }}</span>
              <span class="detail-v">
                <template v-if="dataSummary">
                  <b>{{ formatBytes(dataSummary.totalBytes) }}</b>
                  <span class="detail-note">
                    {{ zh ? '设置（localStorage）' : 'settings (localStorage)' }} {{ formatBytes(dataSummary.lsBytes) }}
                    ·
                    {{ zh ? '本地文件（OPFS）' : 'local files (OPFS)' }} {{ formatBytes(dataSummary.fileBytes) }}
                    <template v-if="dataSummary.hostSupported">
                      · {{ zh ? '插件私有数据（主进程）' : 'plugin-private data (main process)' }} {{ formatBytes(dataSummary.hostBytes) }}
                    </template>
                  </span>
                </template>
                <template v-else>{{ zh ? '统计中…' : 'Measuring…' }}</template>
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-k">{{ zh ? '位置' : 'Location' }}</span>
              <span class="detail-v path">
                localstorage://<code>{{ pluginLsPrefix(selected.id) }}</code>*
                <span class="detail-note">
                  + opfs://{{ PLUGIN_DATA_DIR }}/<code>{{ selected.id }}</code>/
                  <template v-if="dataSummary && dataSummary.hostSupported"> + appdata://plugins-data/<code>{{ selected.id }}</code>/</template>
                </span>
              </span>
            </div>
            <div v-if="dataSummary && !dataSummary.filesSupported" class="detail-note">
              {{ zh ? '当前环境不支持 OPFS，只能看到 localStorage 里的数据。' : 'OPFS is unavailable here, so only localStorage data is listed.' }}
            </div>
            <div v-if="dataSummary && !dataSummary.hostSupported" class="detail-note">
              {{ zh
                ? '当前没有连接到主进程，插件私有数据（plugins-data/<插件 id>/）这一处看不到。'
                : 'Not connected to the main process, so plugin data under plugins-data/<id>/ is not visible.' }}
            </div>
            <div v-if="dataSummary && dataSummary.error" class="detail-note error">
              {{ dataSummary.error }}
            </div>

            <div v-if="dataSummary && dataSummary.entries.length" class="plugin-data-list">
              <div v-for="e in dataSummary.entries" :key="`${e.kind}:${e.name}`" class="plugin-data-row">
                <i class="fa" :class="e.kind === 'localStorage' ? 'fa-key' : e.kind === 'host' ? 'fa-hdd-o' : 'fa-file-o'"></i>
                <span class="plugin-data-name" :title="e.name">{{ e.name }}</span>
                <span class="plugin-data-size">{{ formatBytes(e.size) }}</span>
                <i
                  class="fa fa-times plugin-data-del"
                  :title="zh ? '只删这一项' : 'Delete just this entry'"
                  @click="removeDataEntry(e)"
                ></i>
              </div>
            </div>
            <div v-else-if="dataSummary" class="plugin-empty-inline">
              {{ zh ? '这个插件还没有数据。' : 'This plugin has no data yet.' }}
            </div>

            <!-- 文件授权：fs 权限能读的路径（用户自己选过的，跨重启记得住） -->
            <div class="detail-row" style="margin-top: 10px">
              <span class="detail-k">{{ zh ? '文件授权' : 'File access' }}</span>
              <span class="detail-v">
                <template v-if="!grantsSupported">
                  {{ zh ? '当前没有连接到主进程，看不到文件授权。' : 'Not connected to the main process, so file access is not visible.' }}
                </template>
                <template v-else-if="fileGrants.length">
                  <b>{{ fileGrants.length }}</b>
                  <span class="detail-note">
                    {{ zh
                      ? '个路径（你在这个插件里选过的文件 / 文件夹，重启后仍然有效）'
                      : 'path(s) you picked inside this plugin — still valid after a restart' }}
                  </span>
                </template>
                <template v-else>{{ zh ? '没有记住任何路径（插件读文件时会弹选择框）' : 'No remembered path (the plugin asks you to pick a file)' }}</template>
              </span>
            </div>
            <div v-if="fileGrants.length" class="plugin-data-list">
              <div v-for="g in fileGrants" :key="g.path" class="plugin-data-row">
                <i class="fa" :class="g.exists ? (g.isDir ? 'fa-folder-open-o' : 'fa-file-o') : 'fa-unlink'"></i>
                <span class="plugin-data-name" :title="g.path">{{ g.path }}</span>
                <span class="plugin-data-size">
                  {{ g.exists ? (g.isDir ? (zh ? '文件夹' : 'folder') : zh ? '文件' : 'file') : zh ? '已不存在' : 'missing' }}
                </span>
                <i
                  class="fa fa-times plugin-data-del"
                  :title="zh ? '撤销这条授权（撤销后要重新选）' : 'Revoke this grant (the plugin must ask again)'"
                  @click="revokeGrantEntry(g)"
                ></i>
              </div>
            </div>
            <div v-if="fileGrants.length" class="detail-note" style="margin-top: 6px">
              <span>
                {{ zh
                  ? '只有你亲自选过的路径能被这个插件读取；撤销只影响这个插件，不会动磁盘上的文件。'
                  : 'Only paths you picked can be read by this plugin; revoking only affects this plugin and never touches your files.' }}
              </span>
              <button
                class="small-btn danger"
                style="margin-left: 6px"
                @click="revokeAllGrants"
                :title="zh ? '撤销这个插件记住的全部路径' : 'Revoke every remembered path of this plugin'"
              >{{ zh ? '全部撤销' : 'Revoke all' }}</button>
            </div>
          </div>
        </div>
      </template>

      <div v-else class="plugin-content-empty">
        <i class="fa fa-cube" style="font-size: 22px"></i>
        <span>{{ zh
          ? '在左侧选择一个插件，即可在右侧查看详情 / 配置 / 日志 / 数据。'
          : 'Select a plugin on the left to view its details, config, logs and data here.' }}</span>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usestore } from '@/store'
import { useSlotSnapshot } from '@/lib/plugin/useSlots'
import { clientPluginLoadStates, clientShortcuts, syncClientPlugins } from '@/lib/plugin/runtime'
import { getPluginBridge } from '@/lib/plugin/bridge'
import { getPlatform } from '@/platform'
import { formatBytes } from '@/lib/settingsData'
import { useTallLayout } from '@/composables/useTallLayout'
import { useMobileBackScreen } from '@/composables/useBackLayer'
import {
  PLUGIN_DATA_DIR,
  clearPluginData,
  clearPluginGrants,
  collectAllPluginData,
  collectPluginData,
  collectPluginGrants,
  pluginDataFilesSupported,
  pluginFileGrantsSupported,
  pluginLsPrefix,
  removePluginDataEntry,
  revokePluginGrant,
  type PluginDataEntry,
  type PluginDataSummary,
  type PluginGrantEntry,
} from '@/lib/plugin/pluginData'
import type { PluginSnapshot, PluginStatus, PluginLogLine, PluginEvent } from '@/types/plugin'
import draggable from 'vuedraggable'
// 插件顺序（拖动排序）：导航栏图标 / 启动器网格 / 插件子窗口图标栏都按这份顺序
import { commitPluginOrder, sortPluginsByOrder, usePluginOrder } from '@/lib/plugin/navOrder'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

/** 安卓壳：插件目录在应用私有存储里，系统文件管理器打不开，需要不同的提示 */
const androidHost = computed(() => {
  try {
    return getPlatform().kind === 'android'
  } catch {
    return false
  }
})

const plugins = ref<PluginSnapshot[]>([])
const rootDir = ref('')
const customRoot = ref(false)
const services = ref<string[]>([])
const unavailable = ref(false)
/** 目录名不能作为插件 id 而被跳过的插件文件夹（相对插件目录；有清单但名字非法） */
const invalidNamedDirs = ref<string[]>([])
/** 搜索关键词（名称 / id / 文件夹 / 权限 / 工具 / 描述 / 状态 任一命中即显示） */
const keyword = ref('')
const kw = computed(() => keyword.value.trim().toLowerCase())

/** 安全声明（悬停提示；与「详情 → 权限」配合看该插件申请的宿主能力） */
const securityNotice = computed(() => (zh.value
  ? '插件以宿主权限运行\n\n插件代码与主进程同进程，不受工作区沙箱保护。启用前请确认来源可信；列表里每条插件的「权限」即该插件申请的宿主能力。'
  : 'Plugins run with host privileges\n\nPlugin code runs in the main process and is NOT confined by the workspace sandbox. Only enable plugins you trust; the “Permissions” shown for each plugin are the host capabilities it requests.'))

/** 宿主可注入服务（插件 inject 后可用）：信息量小且占地方，收进底部图标用 title 展示 */
const servicesHint = computed(() => (zh.value
  ? `宿主可注入服务（插件 inject 后可用，共 ${services.value.length} 个）：\n${services.value.join('\n')}`
  : `Host services available for inject (${services.value.length}):\n${services.value.join('\n')}`))

/** 搜索过滤后的插件列表（空关键词 = 全部）
 *  顺序 = 用户在插件管理里拖出来的插件顺序（见 lib/plugin/navOrder.ts）；
 *  导航栏图标 / 启动器网格 / 插件子窗口图标栏都以这份顺序为准，三处一致。 */
const filteredPlugins = computed(() => {
  const k = kw.value
  // ⚠️ 必须显式依赖 userOrder（响应式版本号）：`sortPluginsByOrder` 内部读的是 localStorage，
  // 那是**非响应式**的 —— 不读这一行的话，拖完顺序落盘了，列表却不会重排，看起来就是「拖了没反应」。
  const order = userOrder.value
  void order
  // 先按用户顺序排全量，再按关键词过滤：过滤只影响显示，不影响拖动时的落点计算
  const sorted = sortPluginsByOrder(plugins.value)
  if (!k) return sorted
  return sorted.filter((p) => {
    const hay = [
      p.name, p.id, p.folder, p.relDir, p.description, p.error,
      (p.permissions || []).join(' '),
      (p.tools || []).join(' '),
      (p.services || []).join(' '),
      statusLabel(p.status),
    ].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(k)
  })
})

// ---------------------------------------------------------------------------
// 拖动排序（vuedraggable：真实的拖拽投影 + 跟手动画）
// ---------------------------------------------------------------------------
// 为什么用 vuedraggable 而不是手写：
//  - 手写 HTML5 dragstart/dragover 在 Electron 里收不到事件（窗口拖动区会吞掉，实测无效）；
//  - 手写 pointer 事件虽然能落盘，但**没有跟手动画**（看不到被拖的块跟着鼠标），
//    还容易出现「拖动时选中文字」。vuedraggable（内部 Sortable.js）自带：
//    ghost 投影、跟手位移、animation 过渡，并且用 `handle`/`filter` 精确控制可拖区域。
//  ⚠️ 它的 #item 插槽每个条目只能有一个根节点（见 src/shared/draggableSlot.selftest.ts）。
//  ⚠️ `:force-fallback` 下跟着鼠标走的是 Sortable 克隆出来的 ghost（每次 mousemove 写 transform），
//    所以 **ghost 上绝不能有 CSS transition**（否则永远落后鼠标约一个过渡时长）——
//    见样式里 `.plugin-nav-chosen / .sortable-fallback` 那条规则，改样式时别把它删了。

/** 响应式的用户顺序（拖动 / 恢复默认后底部提示与按钮要跟着变） */
const userOrder = usePluginOrder()
/**
 * 是否允许拖动排序：列表里至少 2 个插件、且**没有搜索过滤**。
 * 搜索时列表只显示命中的插件，拖动落点会牵扯到看不见的插件（用户没法预期），因此先关掉。
 */
const canReorder = computed(() => !kw.value && plugins.value.length > 1)

/**
 * 可拖动的插件列表（v-model 的目标）。
 *
 * 拖动结束后把**新顺序**落盘，并保持 v-model 的读写闭环：
 *  - 读：`filteredPlugins`（已按用户顺序排好）；
 *  - 写：把新顺序写进 localStorage 并 bump 版本号，`filteredPlugins` 随即重排，
 *    用户看到的顺序与落盘的顺序永远是同一个。
 */
const draggablePlugins = computed<PluginSnapshot[]>({
  get: () => filteredPlugins.value,
  set: (next) => {
    if (!canReorder.value) return
    const ids = next.map((p) => p.id)
    if (ids.length !== filteredPlugins.value.length) return
    commitPluginOrder(ids.length ? ids : [], ids)
  },
})

/** 顺序是否已被用户自定义（底部提示用；空 = 还是宿主顺序） */
const orderCustomized = computed(() => userOrder.value.length > 0)
/** 恢复宿主默认顺序（各插件声明 order 的顺序） */
function resetOrder() {
  commitPluginOrder([], [])
}

// ---- 左右布局：左侧导航的选中项 + 右侧详情（详情 / 配置 / 日志 / 数据同一页内展开） ----
const selectedId = ref<string | null>(null)
const selected = computed<PluginSnapshot | undefined>(() => plugins.value.find((p) => p.id === selectedId.value))

// 细长窗口（高宽比 > 16:9，如手机竖屏）：插件列表与详情不再并排，而是各占满整屏互相切换
//（与设置导航 / 知识管理文件树 / 模型来源同一套做法）。true = 列表屏，false = 详情屏
const isTallLayout = useTallLayout()
const showNavScreen = ref(true)

// 安卓返回手势：细长窗口下本面板是「列表 ⇄ 内容」两屏，内容屏按返回回到列表（见 composables/useBackLayer）
useMobileBackScreen('settings:plugin', isTallLayout, showNavScreen)

const logText = ref('')
const logLoading = ref(false)
const configText = ref('')
const configLoading = ref(false)
// ---- 插件数据（localStorage + OPFS）：详情里的「数据」分组看占用、明细与清理 ----
const dataSummary = ref<PluginDataSummary | null>(null)
const pluginData = ref<Record<string, PluginDataSummary>>({})
// ---- 文件授权（用户在该插件里选过的路径，跨重启有效）：同分组里展示与撤销 ----
const fileGrants = ref<PluginGrantEntry[]>([])
const grantsSupported = ref(true)
/**
 * 界面半边的装载结果（渲染层内存态，主进程快照里没有）：
 * 主进程显示 active 不代表界面半边装上了 —— 常见于界面半边代码写错，
 * 这时只报在浏览器控制台里，用户只会觉得「点了重载没反应」。
 */
const clientStates = ref<Record<string, { ok: boolean; message: string; ts: number }>>({})

const refreshClientStates = () => {
  clientStates.value = clientPluginLoadStates()
}

/** 同步界面半边（幂等）后再取装载结果：主进程事件与同步完成之间没有顺序保证，所以主动等一次 */
const syncThenRefreshClients = async () => {
  try {
    await syncClientPlugins()
  } catch {
    /* 同步失败不影响列表展示 */
  }
  refreshClientStates()
}
/** 槽位注册表快照（详情面板用它把「界面位置」归到具体插件） */
const slotSnapshot = useSlotSnapshot()

let offEvent: (() => void) | null = null

const bridgeOrNull = () => getPluginBridge()
/** 调用点直接用：宿主不可用时抛错，由上层 try/catch 提示（桌面/安卓各自的宿主由 bridge 内部选择） */
const bridge = () => {
  const api = getPluginBridge()
  if (!api) throw new Error(zh.value ? '插件宿主不可用' : 'Plugin host unavailable')
  return api
}

const statusLabel = (status: PluginStatus): string => {
  const map: Record<PluginStatus, [string, string]> = {
    discovered: ['待加载', 'Ready'],
    invalid: ['清单/版本不可用', 'Invalid'],
    pending: ['等待依赖', 'Pending'],
    loading: ['加载中', 'Loading'],
    active: ['已激活', 'Active'],
    failed: ['加载失败', 'Failed'],
    disabled: ['已禁用', 'Disabled'],
  }
  const [z, e] = map[status]
  return zh.value ? z : e
}

/** 状态 + 启用状态：status = disabled 时状态文案本身就是「已禁用」，不再重复追加 */
const statusDetail = (p: PluginSnapshot): string => {
  const label = statusLabel(p.status)
  if (p.enabled || p.status === 'disabled') return label
  return `${label} · ${zh.value ? '已禁用' : 'disabled'}`
}

/** 列表 / 标题行的状态小图标（与 statusLabel 一一对应） */
const statusIcon = (status: PluginStatus): string => {
  const map: Record<PluginStatus, string> = {
    discovered: 'fa fa-circle-o',
    invalid: 'fa fa-exclamation-circle',
    pending: 'fa fa-hourglass-half',
    loading: 'fa fa-spinner fa-spin',
    active: 'fa fa-check-circle',
    failed: 'fa fa-times-circle',
    disabled: 'fa fa-pause-circle',
  }
  return map[status] || 'fa fa-circle-o'
}

/** 权限的中文/英文说明（悬停与详情用；未收录的权限按原样显示） */
const PERMISSION_HINTS: Record<string, [string, string]> = {
  fs: ['文件读写（本插件目录内；带此权限的插件工具默认需要审批）', 'File read/write (inside its own folder; plugin tools with it require approval by default)'],
  shell: ['执行命令（仍受 trusted 沙箱策略约束）', 'Run shell commands (still bound by the trusted sandbox policy)'],
  net: ['发起网络请求', 'Make network requests'],
  agent: ['读取会话日志（只读）', 'Read session logs (read-only)'],
  llm: ['调用你配置的大模型来源（会消耗额度 / 算力）', 'Call your configured model sources (consumes quota / compute)'],
}

const permissionHint = (permissions: string[]): string => {
  const head = zh.value ? '声明的权限（悬停看说明）：' : 'Declared permissions (hover for details):'
  if (!permissions.length) return zh.value ? '未申请任何权限' : 'No permissions requested'
  const lines = permissions.map((p) => {
    const hit = PERMISSION_HINTS[p]
    return hit ? `${p} — ${zh.value ? hit[0] : hit[1]}` : p
  })
  return `${head}\n${lines.join('\n')}`
}

const refresh = async () => {
  const api = bridgeOrNull()
  if (!api) {
    unavailable.value = true
    return
  }
  try {
    const res = await api.list()
    applyList(res)
    unavailable.value = false
  } catch (e: any) {
    console.error('[PluginManagement] 加载插件列表失败:', e)
    unavailable.value = true
  }
}

/** 应用 list / rescan 返回的宿主状态 */
const applyList = (res: any) => {
  plugins.value = res?.plugins || []
  rootDir.value = res?.rootDir || ''
  customRoot.value = res?.customRoot === true
  services.value = res?.services || []
  invalidNamedDirs.value = Array.isArray(res?.invalidNamedDirs) ? res.invalidNamedDirs : []
  // 列表到手后若还没有选中项，默认展开第一个可见插件
  if (!selectedId.value && filteredPlugins.value.length) selectedId.value = filteredPlugins.value[0].id
  void refreshAllData()
  void syncThenRefreshClients()
}

// ---------------------------------------------------------------------------
// 插件数据：统计 / 明细 / 单项删除 / 整体清理
// ---------------------------------------------------------------------------
const dataBadgeHint = (id: string): string => {
  const d = pluginData.value[id]
  if (!d) return ''
  const lines = [
    zh.value ? `插件数据合计 ${formatBytes(d.totalBytes)}` : `Plugin data: ${formatBytes(d.totalBytes)}`,
    `${zh.value ? '设置' : 'settings'} ${formatBytes(d.lsBytes)} · ${zh.value ? '本地文件' : 'local files'} ${formatBytes(d.fileBytes)}`,
    zh.value ? '点左边的数据库按钮可以看明细 / 清理' : 'Use the database button on the left to inspect or clean it',
  ]
  return lines.join('\n')
}

/** 界面半边失败徽标的提示：给出真实报错与下一步动作 */
const clientBadgeHint = (id: string): string => {
  const st = clientStates.value[id]
  if (!st) return ''
  const when = new Date(st.ts).toLocaleTimeString()
  return zh.value
    ? `界面半边装载失败（${when}）：\n${st.message}\n点「重新载入」会重试；仍失败请照提示改插件代码。`
    : `UI half failed to load (${when}):\n${st.message}\nReload retries it; if it still fails, fix the plugin code as the message says.`
}

/** 列表里给每个插件算一次占用（localStorage 扫一遍 + OPFS plugins/ 走一次） */
const refreshAllData = async () => {
  const ids = plugins.value.map((p) => p.id)
  if (!ids.length) {
    pluginData.value = {}
    return
  }
  try {
    pluginData.value = await collectAllPluginData(ids)
  } catch (e) {
    console.error('[PluginManagement] 统计插件数据失败:', e)
  }
}

const refreshData = async (id: string) => {
  try {
    const summary = await collectPluginData(id)
    dataSummary.value = summary
    pluginData.value = { ...pluginData.value, [id]: summary }
  } catch (e: any) {
    console.error('[PluginManagement] 统计插件数据失败:', e)
    ElMessage.error(zh.value ? `统计失败：${e?.message || e}` : `Failed: ${e?.message || e}`)
  }
}

/** 「数据」分组里的刷新：重新统计当前选中的插件 */
const refreshCurrentData = async () => {
  const id = selectedId.value
  if (id) await refreshData(id)
}

// ---------------------------------------------------------------------------
// 文件授权（fs 权限的「已记住路径」）：列表 + 逐条撤销 + 全部撤销
// 记住的路径跨重启有效，所以插件不必每次开机都让你重选目录；撤销后它要重新让你选。
// ---------------------------------------------------------------------------
const refreshGrants = async (id: string) => {
  if (!pluginFileGrantsSupported()) {
    grantsSupported.value = false
    fileGrants.value = []
    return
  }
  grantsSupported.value = true
  try {
    fileGrants.value = await collectPluginGrants(id)
  } catch {
    fileGrants.value = []
  }
}

const revokeGrantEntry = async (entry: PluginGrantEntry) => {
  const p = selected.value
  if (!p) return
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `撤销「${p.name}」对下面这个路径的访问授权？\n${entry.path}\n撤销后，这个插件要再读它就必须重新弹出选择框让你确认。`
        : `Revoke access for “${p.name}” to this path?\n${entry.path}\nAfterwards the plugin must ask you to pick it again.`,
      zh.value ? '撤销文件授权？' : 'Revoke file access?',
      {
        type: 'warning',
        confirmButtonText: zh.value ? '撤销' : 'Revoke',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      },
    )
  } catch {
    return
  }
  const ok = await revokePluginGrant(p.id, entry.path)
  await refreshGrants(p.id)
  if (ok) ElMessage.success(zh.value ? '已撤销这条文件授权' : 'File access revoked')
  else ElMessage.error(zh.value ? '撤销失败（可能已被撤销）' : 'Revoke failed (it may already be gone)')
}

const revokeAllGrants = async () => {
  const p = selected.value
  if (!p) return
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `撤销「${p.name}」记住的全部路径（共 ${fileGrants.value.length} 个）？\n撤销后，这个插件要再读文件就必须重新弹出选择框让你确认。`
        : `Revoke all ${fileGrants.value.length} remembered path(s) for “${p.name}”?\nAfterwards the plugin must ask you to pick files again.`,
      zh.value ? '撤销全部文件授权？' : 'Revoke all file access?',
      {
        type: 'warning',
        confirmButtonText: zh.value ? '全部撤销' : 'Revoke all',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      },
    )
  } catch {
    return
  }
  const ok = await clearPluginGrants(p.id)
  await refreshGrants(p.id)
  if (ok) ElMessage.success(zh.value ? '已撤销全部文件授权' : 'All file access revoked')
  else ElMessage.error(zh.value ? '撤销失败' : 'Revoke failed')
}

const removeDataEntry = async (entry: PluginDataEntry) => {
  const summary = dataSummary.value
  const id = selectedId.value
  if (!id) return
  const okDel = await removePluginDataEntry(id, entry)
  if (!okDel) {
    ElMessage.error(zh.value ? '删除失败（可能已被别处删掉）' : 'Delete failed (it may already be gone)')
  }
  if (summary) {
    const entries = summary.entries.filter((e) => !(e.kind === entry.kind && e.name === entry.name))
    const next: PluginDataSummary = {
      ...summary,
      entries,
      lsBytes: entries.filter((e) => e.kind === 'localStorage').reduce((n, e) => n + e.size, 0),
      fileBytes: entries.filter((e) => e.kind === 'file').reduce((n, e) => n + e.size, 0),
      hostBytes: entries.filter((e) => e.kind === 'host').reduce((n, e) => n + e.size, 0),
      totalBytes: entries.reduce((n, e) => n + e.size, 0),
    }
    dataSummary.value = next
    pluginData.value = { ...pluginData.value, [id]: next }
  } else {
    await refreshData(id)
  }
  ElMessage.success(zh.value ? '已删除这一项' : 'Entry deleted')
}

const clearData = async () => {
  const p = selected.value
  if (!p) return
  const sizeText = pluginData.value[p.id] ? formatBytes(pluginData.value[p.id].totalBytes) : ''
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `清除「${p.name}」的全部数据（当前约 ${sizeText || '未知大小'}）？\n` +
          '清除的内容：该插件的 localStorage 键（aikm.plugin.' +
          p.id +
          '.*）、本地文件（plugins/' +
          p.id +
          '/）、插件私有数据（plugins-data/' +
          p.id +
          '/）以及它记住的文件授权（下次读文件要重新让你选）。插件本体文件、其它插件的数据都不会动。\n此操作不可撤销。'
        : `Clear all data of “${p.name}” (currently about ${sizeText || 'unknown'})?\n` +
          'Removes: its localStorage keys (aikm.plugin.' +
          p.id +
          '.*), its local files (plugins/' +
          p.id +
          '/), its plugin-private data (plugins-data/' +
          p.id +
          '/) and its remembered file access (it will ask you to pick files again). Plugin files and other plugins’ data are untouched.\nThis cannot be undone.',
      zh.value ? '清除插件数据？' : 'Clear plugin data?',
      {
        type: 'warning',
        confirmButtonText: zh.value ? '清除' : 'Clear',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      },
    )
  } catch {
    return
  }
  try {
    const res = await clearPluginData(p.id)
    await refreshData(p.id)
    await refreshAllData()
    ElMessage.success(
      zh.value ? `已清除 ${res.keys} 个键 / ${res.files} 个文件` : `Cleared ${res.keys} key(s) / ${res.files} file(s)`,
    )
  } catch (e: any) {
    console.error('[PluginManagement] 清除插件数据失败:', e)
    ElMessage.error(zh.value ? `清除失败：${e?.message || e}` : `Clear failed: ${e?.message || e}`)
  }
}

/**
 * 重新扫描插件目录：用户在插件目录（或其子文件夹）里手动放进新插件后，不必重启软件。
 * 会装载插件代码（与宿主同进程）→ 弹确认框，确认后才带 confirm 调主进程。
 */
const rescan = async () => {
  const api = bridgeOrNull()
  if (!api?.rescan) return
  try {
    await ElMessageBox.confirm(
      zh.value
        ? '将重新扫描插件目录（含各级子文件夹）：发现的新插件会立即装载，已删除的插件会从列表移除。插件代码与宿主同进程运行，不受工作区沙箱保护，请确认这些文件来源可信。'
        : 'The plugins folder (including subfolders) will be rescanned: newly found plugins are loaded right away and removed ones disappear from the list. Plugin code runs in the main process and is not sandboxed — only continue if you trust these files.',
      zh.value ? '重新扫描插件目录' : 'Rescan plugins folder',
      { type: 'warning', confirmButtonText: zh.value ? '重新扫描' : 'Rescan', cancelButtonText: zh.value ? '取消' : 'Cancel' },
    )
  } catch {
    return
  }
  try {
    const res = await api.rescan(true)
    applyList(res)
    unavailable.value = false
    ElMessage.success(zh.value ? `已重新扫描（${plugins.value.length} 个插件）` : `Rescanned (${plugins.value.length} plugins)`)
  } catch (e: any) {
    ElMessage.error(zh.value ? `重新扫描失败：${e?.message || e}` : `Rescan failed: ${e?.message || e}`)
  }
}

/** 变更类操作统一走「先确认（展示权限与影响）→ 带 confirm 重试」 */
const confirmMutation = async (p: PluginSnapshot, actionZh: string, actionEn: string): Promise<boolean> => {
  const permText = p.permissions.length
    ? (zh.value
        ? `申请的权限：<b>${p.permissions.join(' / ')}</b><br/>${permissionHint(p.permissions).split('\n').slice(1).join('<br/>')}`
        : `Requested permissions: <b>${p.permissions.join(' / ')}</b><br/>${permissionHint(p.permissions).split('\n').slice(1).join('<br/>')}`)
    : (zh.value ? '未申请额外权限' : 'No extra permissions requested')
  try {
    await ElMessageBox.confirm(
      `<div style="line-height:1.6">${zh.value ? `将${actionZh}插件「${p.name}」` : `Will ${actionEn} plugin "${p.name}"`}<br/>${permText}<br/>`
        + `<span style="color:#b45309">${zh.value ? '插件与宿主同进程运行，不受工作区沙箱保护。' : 'Plugins run in the main process and are not sandboxed.'}</span></div>`,
      zh.value ? '插件操作确认' : 'Confirm plugin action',
      {
        dangerouslyUseHTMLString: true,
        type: 'warning',
        confirmButtonText: zh.value ? '继续' : 'Continue',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      },
    )
    return true
  } catch {
    return false
  }
}

const runMutation = async (p: PluginSnapshot, fn: (confirm: boolean) => Promise<any>) => {
  try {
    await fn(true)
    await refresh()
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

const setEnabled = async (p: PluginSnapshot, enable: boolean) => {
  const ok = enable
    ? await confirmMutation(p, '启用', 'enable')
    : await confirmMutation(p, '禁用', 'disable')
  if (!ok) return
  await runMutation(p, (confirm) =>
    enable ? bridge().enable(p.id, confirm) : bridge().disable(p.id, confirm))
  ElMessage.success(enable ? (zh.value ? '已启用' : 'Enabled') : (zh.value ? '已禁用' : 'Disabled'))
}

const reloadPlugin = async (p: PluginSnapshot) => {
  const ok = await confirmMutation(p, '重新加载', 'reload')
  if (!ok) return
  await runMutation(p, (confirm) => bridge().reload(p.id, confirm))
  ElMessage.success(zh.value ? '已重载' : 'Reloaded')
}

const removePlugin = async (p: PluginSnapshot) => {
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `从注册表移除插件「${p.name}」？移除后它的工具与界面元素立即消失。`
        : `Remove plugin "${p.name}" from the registry? Its tools and UI contributions disappear immediately.`,
      zh.value ? '移除确认' : 'Confirm removal',
      {
        type: 'warning',
        confirmButtonText: zh.value ? '移除' : 'Remove',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      },
    )
  } catch {
    return
  }
  // 第二步单独询问是否删文件：删除磁盘文件不可逆，不放在同一个按钮里误触
  let deleteFiles = false
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `是否同时删除插件目录里的文件？\n${p.dir}`
        : `Also delete the plugin files on disk?\n${p.dir}`,
      zh.value ? '删除文件？' : 'Delete files?',
      {
        type: 'warning',
        confirmButtonText: zh.value ? '删除文件' : 'Delete files',
        cancelButtonText: zh.value ? '保留文件' : 'Keep files',
      },
    )
    deleteFiles = true
  } catch {
    deleteFiles = false
  }
  try {
    const res = await bridge().uninstall(p.id, { confirm: true, deleteFiles })
    ElMessage.success(
      res?.deletedDir
        ? (zh.value ? '已移除并删除文件' : 'Removed and files deleted')
        : (zh.value ? '已从注册表移除（文件保留）' : 'Removed from registry (files kept)'),
    )
    await refresh()
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

const loadLogs = async (p: PluginSnapshot) => {
  const api = bridgeOrNull()
  if (!api) return
  logLoading.value = true
  try {
    const lines: PluginLogLine[] = await api.logs(p.id)
    logText.value = lines.length
      ? lines.map((l) => `[${new Date(l.ts).toLocaleTimeString()}] ${l.level.toUpperCase()} ${l.message}`).join('\n')
      : (zh.value ? '（暂无日志）' : '(no logs yet)')
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  } finally {
    logLoading.value = false
  }
}

const loadConfig = async (p: PluginSnapshot) => {
  const api = bridgeOrNull()
  if (!api) return
  configLoading.value = true
  try {
    const cfg = await api.getConfig(p.id)
    configText.value = JSON.stringify(cfg ?? {}, null, 2)
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  } finally {
    configLoading.value = false
  }
}

const saveConfig = async () => {
  const target = selected.value
  if (!target) return
  let patch: Record<string, unknown>
  try {
    patch = JSON.parse(configText.value || '{}')
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('必须是 JSON 对象')
  } catch (e: any) {
    ElMessage.error(zh.value ? `配置不是合法 JSON 对象：${e?.message || e}` : `Config must be a JSON object: ${e?.message || e}`)
    return
  }
  try {
    await bridge().setConfig(target.id, patch, true)
    ElMessage.success(zh.value ? '配置已保存（点「重载」生效）' : 'Config saved (applies on Reload)')
    await refresh()
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

const openDir = async (id?: string) => {
  try {
    const res: any = await bridge().openDir(id)
    // 当前环境唤不起系统文件管理器（安卓私有目录 / 网页）→ 退化为把路径告诉用户
    if (res && res.path && res.opened === false) {
      ElMessage.info(zh.value ? `插件目录：${res.path}（当前环境无法打开系统文件管理器）` : `Plugins folder: ${res.path} (no system file manager here)`)
    }
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

/** 选择插件目录（与技能管理同一交互：系统目录选择框 → 主进程切换根目录并重新扫描） */
const chooseRoot = async () => {
  const api = bridgeOrNull()
  if (!api?.setRoot) {
    ElMessage.error(zh.value ? '当前环境不支持切换插件目录' : 'Changing the plugins folder is not supported here')
    return
  }
  try {
    await ElMessageBox.confirm(
      zh.value
        ? '选择一个文件夹作为插件目录（每个含 aikm 清单的文件夹即一个插件，可按用途放进各级子文件夹）。切换后当前已加载的插件会先卸载，再从新目录重新扫描。'
        : 'Pick a folder to use as the plugins folder (each subfolder is a plugin). Loaded plugins are unloaded first, then the new folder is scanned.',
      zh.value ? '选择插件目录' : 'Select plugins folder',
      {
        type: 'warning',
        confirmButtonText: zh.value ? '选择文件夹' : 'Choose folder',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      },
    )
  } catch {
    return
  }
  try {
    const res = await api.setRoot({ confirm: true })
    if (res?.cancelled) return
    ElMessage.success(zh.value ? `插件目录已切换：${res.rootDir}` : `Plugins folder: ${res.rootDir}`)
    await refresh()
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

/**
 * 从本地文件夹安装（P2 本地安装；主进程弹目录选择框）。
 * 同名冲突时主进程返回 PLUGIN_EXISTS，这里询问用户后再以 replace 重试。
 */
const installFromFolder = async () => {
  const api = bridgeOrNull()
  if (!api?.install) {
    ElMessage.error(zh.value ? '当前环境不支持从文件夹安装插件' : 'Installing plugins from a folder is not supported here')
    return
  }
  try {
    await ElMessageBox.confirm(
      zh.value
        ? '选择一个插件文件夹（内含 package.json 与 aikm 清单）安装到插件目录。插件与宿主同进程运行、不受工作区沙箱保护，只安装可信来源。'
        : 'Pick a plugin folder (package.json with an aikm manifest) to install into the plugins folder. Plugins run in the main process and are not sandboxed — install only trusted sources.',
      zh.value ? '安装插件' : 'Install plugin',
      {
        type: 'warning',
        confirmButtonText: zh.value ? '选择文件夹' : 'Choose folder',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      },
    )
  } catch {
    return
  }

  const run = async (replace: boolean): Promise<boolean> => {
    try {
      const res = await api.install({ confirm: true, replace })
      if (res?.cancelled) return true
      const name = res?.snapshot?.name ?? ''
      ElMessage.success(zh.value ? `已安装：${name}` : `Installed: ${name}`)
      await refresh()
      return true
    } catch (e: any) {
      if (e?.code === 'PLUGIN_EXISTS') {
        try {
          await ElMessageBox.confirm(
            zh.value
              ? `${e.message} 覆盖安装会先删除插件目录里的旧版本（插件内的配置保留）。`
              : `${e.message} Replacing first deletes the old copy in the plugins folder (its config is kept).`,
            zh.value ? '覆盖安装？' : 'Replace?',
            { type: 'warning', confirmButtonText: zh.value ? '覆盖安装' : 'Replace', cancelButtonText: zh.value ? '取消' : 'Cancel' },
          )
        } catch {
          return true
        }
        return run(true)
      }
      ElMessage.error(e?.message || String(e))
      return true
    }
  }
  await run(false)
}

/** 恢复默认插件目录（仅在自定义目录时显示入口） */
const resetRoot = async () => {
  const api = bridgeOrNull()
  if (!api?.resetRoot) return
  try {
    await ElMessageBox.confirm(
      zh.value ? '恢复默认插件目录（<用户数据>/plugins）？' : 'Reset to the default plugins folder (userData/plugins)?',
      zh.value ? '恢复默认' : 'Reset',
      { type: 'warning', confirmButtonText: zh.value ? '恢复' : 'Reset', cancelButtonText: zh.value ? '取消' : 'Cancel' },
    )
  } catch {
    return
  }
  try {
    const res = await api.resetRoot({ confirm: true })
    ElMessage.success(zh.value ? `插件目录：${res.rootDir}` : `Plugins folder: ${res.rootDir}`)
    await refresh()
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

/** 详情：注册的工具与服务来自主进程快照；界面位置来自渲染层槽位注册表（owner 归属） */
const detailSlots = computed(() => {
  const target = selected.value
  if (!target) return []
  const owner = `plugin:${target.id}`
  return slotSnapshot.value
    .flatMap((s) => s.entries.filter((e) => e.owner === owner).map((e) => `${s.slot} · ${e.key}`))
    .sort()
})
const detailShortcuts = computed(() => {
  const target = selected.value
  if (!target) return []
  return clientShortcuts(`plugin:${target.id}`) as Array<{ display: string; descriptionZh: string; descriptionEn: string }>
})

// ---------------------------------------------------------------------------
// 选中与详情加载：右侧「详情 / 配置 / 日志 / 数据」四个分组都按当前选中项取数
// ---------------------------------------------------------------------------
const selectPlugin = (id: string) => {
  if (selectedId.value !== id) selectedId.value = id
  showNavScreen.value = false   // 细长窗口：进入整屏详情屏（宽窗口下两者并排，本状态无意义）
}

/** 切换插件时清空上一份内容，再拉取配置 / 日志 / 数据 */
const loadDetail = async (p: PluginSnapshot | undefined) => {
  logText.value = ''
  configText.value = ''
  dataSummary.value = null
  fileGrants.value = []
  if (!p) return
  await Promise.all([loadConfig(p), loadLogs(p), refreshData(p.id), refreshGrants(p.id)])
}

// 列表变化（首次加载 / 搜索过滤 / 插件被移除）后保证选中项始终有效：
// 选中项被过滤掉或被移除时自动落到第一个可见插件；插件全没了就清空右侧
watch(
  () => filteredPlugins.value.map((p) => p.id).join(','),
  () => {
    const list = filteredPlugins.value
    if (!list.length) {
      if (!plugins.value.length) selectedId.value = null
      return
    }
    if (!list.some((p) => p.id === selectedId.value)) selectedId.value = list[0].id
  },
)

watch(selectedId, () => {
  void loadDetail(selected.value)
})

onMounted(async () => {
  await refresh()
  // 主进程推送：状态变更 / 日志 / 通知（节流到下一帧，避免重载期间连续刷列表）
  offEvent = bridge()?.onEvent?.((ev: PluginEvent) => {
    if (ev.type === 'plugin/changed') void refresh()
    else if (ev.type === 'plugin/notify') ElMessage.info(`[${ev.id}] ${ev.message}`)
  }) ?? null
})

onUnmounted(() => {
  offEvent?.()
  offEvent = null
})
</script>

<style scoped>
/* ===========================================================================
   根容器：左右分栏（参照 MCP 管理 .mcp-settings）
     左 = 插件导航（安装 / 搜索 / 启用开关 / 状态）
     右 = 选中插件的 详情 / 配置 / 日志 / 数据（全部内嵌，不再用弹层）
   =========================================================================== */
.plugin-panel {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  color: var(--fontColor);
}

/* ====== 细长窗口（高宽比 > 16:9，如手机竖屏）：插件列表 / 详情各占满整屏互相切换 ======
   不再并排（并排会把详情区挤到只剩一两百像素）。两屏都用 v-show 隐藏，切回来时状态还在。 */
.plugin-panel.tall .plugin-sidebar {
  width: 100%;
  border-right: 0;
}
/* 插件条目按钢琴键式整宽条目呈现：行高够手指点 */
.plugin-panel.tall .plugin-nav-list { padding: 8px; }
.plugin-panel.tall .plugin-nav-item {
  min-height: 56px;
  padding: 8px 12px;
  margin-bottom: 4px;
  border-radius: 8px;
  border-color: var(--borderColor);
  background-color: var(--menuColor);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.plugin-panel.tall .plugin-nav-name { font-size: 14px; }
/* 详情屏顶部的返回条（只在细长窗口出现） */
.plugin-back-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--borderColor);
}
.plugin-back {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  cursor: pointer;
  color: var(--fontColor);
  font-size: 14px;
  transition: all 0.15s ease;
}
.plugin-back:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.plugin-back-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fontActiveColor);
}

/* ========== 左侧：插件导航栏 ========== */
.plugin-sidebar {
  width: 230px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--borderColor);
  background: var(--menuColor);
}
/* 顶部工具栏：安装 / 刷新 / 重新扫描 / 打开目录 / 选择目录 */
.plugin-toolbar {
  display: flex;
  gap: 4px;
  padding: 5px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}
.plugin-toolbar .toolbar-btn {
  flex-shrink: 0;
  height: 26px;
  min-width: 26px;
  padding: 0 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.12s;
}
.plugin-toolbar .toolbar-btn:hover {
  border-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
}
.plugin-toolbar .toolbar-btn.primary {
  flex: 1;
  border-color: color-mix(in srgb, var(--fontActiveColor) 45%, transparent);
  color: var(--fontActiveColor);
}
/* 搜索行 */
.plugin-sidebar-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 5px;
  padding: 0 8px;
  height: 26px;
  flex-shrink: 0;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--backgroundColor);
}
.plugin-sidebar-search:focus-within {
  border-color: var(--fontActiveColor);
}
.plugin-sidebar-search > i.fa-search {
  font-size: 11px;
  opacity: 0.6;
}
.plugin-sidebar-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
}
.plugin-search-clear {
  cursor: pointer;
  font-size: 12px;
  opacity: 0.55;
}
.plugin-search-clear:hover {
  opacity: 1;
}
/* 插件列表 */
.plugin-nav-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 4px 4px;
}
.plugin-empty {
  padding: 18px 10px;
  text-align: center;
  font-size: 12px;
  line-height: 1.65;
  opacity: 0.65;
}
.plugin-empty > span {
  display: block;
}
.plugin-empty-note {
  margin-top: 8px;
  font-size: 11px;
  opacity: 0.85;
}
.plugin-empty-clear {
  margin-left: 6px;
  cursor: pointer;
  color: var(--fontActiveColor);
  text-decoration: underline;
}
.plugin-nav-item {
  padding: 5px 6px;
  margin-bottom: 2px;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.12s;
  /* 拖动排序时不能选中文字（手写 pointer 拖拽的另一个毛病） */
  user-select: none;
  -webkit-user-select: none;
}
.plugin-nav-item:hover {
  background: color-mix(in srgb, var(--fontColor) 6%, transparent);
}
.plugin-nav-item.active {
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
  border-color: var(--fontActiveColor);
}
.plugin-nav-item.disabled {
  opacity: 0.55;
}
/* ===== 拖动排序（vuedraggable：跟手动画 + 投影） =====
   .plugin-nav-chosen = 被拖起来的那一块（跟着鼠标走）
   .plugin-nav-ghost  = 它在列表里留下的空位投影 */
.plugin-nav-grip {
  flex-shrink: 0;
  font-size: 10px;
  opacity: 0.3;
  cursor: grab;
}
.plugin-nav-item:hover .plugin-nav-grip { opacity: 0.75; }
.plugin-nav-drag-list {
  /* 拖拽期间禁止列表内的文字选中（Sortable 也会加这个，双保险） */
  user-select: none;
  -webkit-user-select: none;
}
/* ⚠️ 被拖起来的那一块**必须没有 transition**，否则拖动「不跟手、总比鼠标慢一点」。
   原因：`:force-fallback` 下 Sortable 是克隆一个 ghost 丢到 body 上（position:fixed），
   每次 mousemove 用 `transform: matrix(...)` 把它挪到鼠标位置；克隆体带着本行的类名，
   于是 `.plugin-nav-item` 的 `transition: all .12s` 连 transform 一起过渡 ——
   每个新位置都要花 120ms 动画过去，看上去就是「永远落后鼠标一点」。
   Sortable 自己只在 ghost 上清掉**内联** transition（css(ghostEl,'transition','')），
   盖不住这条类规则，所以必须在这里显式关掉。
   选择器同时列上 Sortable 给 ghost 加的两个内部类（sortable-fallback / sortable-drag），
   这样不依赖 vuedraggable 把 chosen-class 转发成 Sortable 的 chosenClass 也一定生效
   （scoped 样式带 data-v 属性，克隆体会继承，因此不会外泄到别处）。
   will-change: transform 让 ghost 单独一层，行内容重绘不再影响跟手。 */
.plugin-nav-chosen,
.plugin-nav-item.plugin-nav-chosen,
.sortable-fallback,
.sortable-drag {
  transition: none;
  will-change: transform;
}
.plugin-nav-chosen {
  background: color-mix(in srgb, var(--fontActiveColor) 16%, var(--menuColor));
  border-color: var(--fontActiveColor);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  cursor: grabbing;
}
.plugin-nav-ghost {
  opacity: 0.35;
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  border-style: dashed;
  border-color: var(--fontActiveColor);
}
.plugin-nav-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.plugin-nav-icon {
  width: 16px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.6;
}
.plugin-nav-icon.status-active {
  color: #4caf50;
  opacity: 1;
}
.plugin-nav-icon.status-failed,
.plugin-nav-icon.status-invalid {
  color: #e74c3c;
  opacity: 1;
}
.plugin-nav-icon.status-pending,
.plugin-nav-icon.status-loading {
  color: #f39c12;
  opacity: 1;
}
.plugin-nav-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 启用开关（列表内点击不切换选中） */
.plugin-nav-toggle {
  width: 26px;
  height: 14px;
  border-radius: 7px;
  flex-shrink: 0;
  background: var(--borderColor);
  position: relative;
  cursor: pointer;
  transition: all 0.15s;
}
.plugin-nav-toggle .toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: all 0.15s;
}
.plugin-nav-toggle.on {
  background: var(--fontActiveColor);
}
.plugin-nav-toggle.on .toggle-knob {
  left: 14px;
}
.plugin-nav-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  padding-left: 22px;
  min-width: 0;
  font-size: 10px;
}
.plugin-nav-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--fontColor);
  opacity: 0.72;
  white-space: nowrap;
}
.plugin-nav-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
  font-style: normal;
  background: var(--borderColor);
}
.plugin-nav-dot.status-active {
  background: #4caf50;
}
.plugin-nav-dot.status-failed,
.plugin-nav-dot.status-invalid {
  background: #e74c3c;
}
.plugin-nav-dot.status-pending,
.plugin-nav-dot.status-loading {
  background: #f39c12;
  animation: plugin-blink 1s infinite;
}
@keyframes plugin-blink {
  50% {
    opacity: 0.3;
  }
}
.plugin-nav-badge {
  font-size: 9px;
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid var(--borderColor);
  color: var(--fontActiveColor);
  opacity: 0.85;
  white-space: nowrap;
  flex-shrink: 0;
}
.plugin-nav-tools {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  font-size: 10px;
  color: var(--fontActiveColor);
  opacity: 0.9;
  white-space: nowrap;
}
/* 底部：数量 / 安全声明 / 插件目录 / 宿主服务 */
.plugin-sidebar-foot {
  flex-shrink: 0;
  padding: 6px 8px 8px;
  border-top: 1px solid var(--borderColor);
  font-size: 10px;
  line-height: 1.5;
  opacity: 0.85;
}
.plugin-foot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.plugin-foot-count {
  font-weight: 600;
  color: var(--fontActiveColor);
}
/* 安全声明图标（插件以宿主权限运行）：内容收进 title，只留一个小图标 */
.plugin-safe-icon {
  font-size: 12px;
  color: #f39c12;
  cursor: help;
}
.folder-path {
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  opacity: 0.7;
}
.folder-path i {
  margin-right: 3px;
}
.plugin-foot-icons {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
/* 可注入服务收进图标（悬停 title 看列表），避免底部堆一排服务名 */
.plugin-foot-icon {
  font-size: 12px;
  opacity: 0.7;
  cursor: help;
}
.plugin-foot-icon.action {
  cursor: pointer;
}
.plugin-foot-icon:hover {
  opacity: 1;
  color: var(--fontActiveColor);
}
/* 排序说明：一行小字，点明「拖动顺序 = 导航栏顺序」 */
.plugin-order-hint {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin: 4px 0 2px;
  font-size: 10px;
  line-height: 1.5;
  opacity: 0.65;
}
.plugin-order-hint i {
  margin-top: 2px;
  flex-shrink: 0;
}

/* ========== 右侧：内容区 ========== */
.plugin-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.plugin-content-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 20px;
  text-align: center;
  font-size: 13px;
  line-height: 1.6;
  opacity: 0.65;
}

/* 标题行：名称 + 徽标 + 状态 / 右侧启用开关与图标按钮 */
.plugin-pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}
.plugin-pane-head-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.plugin-pane-name {
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-id {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  opacity: 0.7;
}
.plugin-badge {
  font-size: 9px;
  padding: 0 5px;
  border: none;
  border-radius: 3px;
  background: color-mix(in srgb, var(--fontColor) 8%, transparent);
  white-space: nowrap;
}
.plugin-badge.dim {
  opacity: 0.5;
}
.plugin-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--borderColor);
  white-space: nowrap;
  flex-shrink: 0;
}
.plugin-status-pill.status-active {
  color: #4caf50;
}
.plugin-status-pill.status-failed,
.plugin-status-pill.status-invalid {
  color: #e74c3c;
}
.plugin-status-pill.status-pending,
.plugin-status-pill.status-loading {
  color: #f39c12;
}
.plugin-pane-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.plugin-toggle {
  width: 30px;
  height: 16px;
  border-radius: 8px;
  background: var(--borderColor);
  position: relative;
  cursor: pointer;
  transition: all 0.15s;
}
.plugin-toggle .toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: all 0.15s;
}
.plugin-toggle.on {
  background: var(--fontActiveColor);
}
.plugin-toggle.on .toggle-knob {
  left: 16px;
}
.plugin-head-divider {
  width: 1px;
  height: 16px;
  background: var(--borderColor);
  margin: 0 2px;
  flex-shrink: 0;
}
.head-btns {
  display: flex;
  align-items: center;
  gap: 4px;
}
.plugin-group-actions {
  margin-left: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.head-btn {
  width: 26px;
  height: 26px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.12s;
}
.head-btn:hover {
  border-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
}
.head-btn.primary {
  color: var(--fontActiveColor);
  border-color: color-mix(in srgb, var(--fontActiveColor) 40%, transparent);
}
.head-btn.danger {
  color: #e74c3c;
}
.head-btn.danger:hover {
  border-color: color-mix(in srgb, #e74c3c 45%, transparent);
}
.head-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

/* 提示块：虚线边框的信息 / 警告块 */
.plugin-notice {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border: 1px dashed var(--borderColor);
  border-radius: 5px;
  font-size: 11px;
  line-height: 1.6;
  flex-shrink: 0;
}
.plugin-notice > i {
  color: #f39c12;
  margin-top: 2px;
}
.plugin-notice.warn {
  border-color: #f0a020;
  background: rgba(240, 160, 32, 0.08);
}
.plugin-notice.warn > i {
  color: #e07b00;
}
.plugin-notice.error {
  border-color: #e74c3c;
  background: rgba(231, 76, 60, 0.06);
}
.plugin-notice.error > i {
  color: #e74c3c;
}
.plugin-notice-body {
  flex: 1;
  min-width: 0;
}
.plugin-notice-title {
  font-weight: 600;
  color: var(--fontActiveColor);
}
.plugin-notice-desc {
  opacity: 0.8;
  word-break: break-word;
}
.plugin-invalid-dirs {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.plugin-invalid-dirs code {
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--borderColor);
  font-family: ui-monospace, Consolas, monospace;
  word-break: break-all;
}

/* 分组卡片：详情 / 配置 / 日志 / 数据 */
.plugin-group {
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--menuColor);
  overflow: hidden;
  flex-shrink: 0;
}
.plugin-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fontActiveColor);
  border-bottom: 1px solid color-mix(in srgb, var(--borderColor) 60%, transparent);
  background: color-mix(in srgb, var(--fontColor) 3%, transparent);
}
.plugin-group-title > i {
  font-size: 12px;
}
.plugin-group-note {
  margin-left: auto;
  font-size: 10px;
  font-weight: normal;
  color: var(--fontColor);
  opacity: 0.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-group-body {
  padding: 8px 10px;
}
.plugin-group-foot {
  padding: 6px 10px;
  border-top: 1px solid color-mix(in srgb, var(--borderColor) 60%, transparent);
  font-size: 11px;
}
.plugin-group-foot .hint {
  opacity: 0.65;
}

/* 详情行 */
.plugin-detail-body {
  padding: 8px 10px;
  font-size: 12px;
}
.detail-row {
  display: flex;
  gap: 10px;
  padding: 4px 0;
  border-bottom: 1px dashed color-mix(in srgb, var(--borderColor) 70%, transparent);
}
.detail-row:last-child {
  border-bottom: none;
}
.detail-k {
  flex: 0 0 72px;
  opacity: 0.6;
}
.detail-v {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.detail-v.error {
  color: #e74c3c;
}
.detail-v.path {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  opacity: 0.85;
  word-break: break-all;
}
.detail-shortcut {
  margin-right: 6px;
  font-family: ui-monospace, Consolas, monospace;
}
.detail-note {
  opacity: 0.7;
}
.detail-note.error {
  color: #e74c3c;
}
.detail-hint {
  font-size: 10px;
  opacity: 0.6;
  margin-top: 2px;
  white-space: normal;
}

/* 配置输入 */
.plugin-config-input {
  width: 100%;
  min-height: 170px;
  max-height: calc(46vh / var(--ui-zoom, 1));
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  resize: vertical;
}
.plugin-config-input:focus {
  outline: none;
  border-color: var(--fontActiveColor);
}

/* 日志 */
.plugin-log {
  margin: 0;
  padding: 8px 10px;
  max-height: 260px;
  overflow: auto;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--fontColor);
  opacity: 0.9;
}

/* 数据明细 */
.plugin-data-list {
  margin-top: 6px;
  border-top: 1px solid var(--borderColor);
}
.plugin-data-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
  border-bottom: 1px dashed var(--borderColor);
}
.plugin-data-row > i:first-child {
  opacity: 0.6;
  width: 12px;
  flex-shrink: 0;
}
.plugin-data-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Consolas, monospace;
}
.plugin-data-size {
  opacity: 0.7;
  flex-shrink: 0;
}
.plugin-data-del {
  cursor: pointer;
  opacity: 0.45;
  flex-shrink: 0;
}
.plugin-data-del:hover {
  opacity: 1;
  color: #e74c3c;
}
.plugin-empty-inline {
  margin-top: 8px;
  font-size: 12px;
  opacity: 0.6;
}

/* 小按钮（分组标题行内的文字按钮） */
.small-btn {
  height: 22px;
  padding: 2px 8px;
  font-size: 10px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  white-space: nowrap;
}
.small-btn:hover {
  background-color: var(--menuActiveColor);
}
.small-btn.danger:hover {
  border-color: #e74c3c;
  color: #e74c3c;
}
</style>
