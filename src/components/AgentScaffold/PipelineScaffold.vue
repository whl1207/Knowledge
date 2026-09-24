<!-- PipelineScaffold.vue - Agent脚手架（Step 1 平移自 AgentBatch.vue，行为逐位一致）
功能：导入表格 → 任务指令（{{列名}} 占位符，每行渲染一次）→ 并发执行独立 Agent 会话 → 结果写回结果列。
本组件是「Agent脚手架」重构（见 docs/设计决策记录.md §三 配置化流水线）的新载体：
平移阶段先保持与 AgentBatch 完全一致的行为，抽象重组（Source/Executor/Sink）在后续 Step 于本文件上进行。 -->
<template>
  <div class="agent-batch">
    <!-- ====== 内部标签页（仅无外部控制时显示；跟随全局语言） ====== -->
    <div v-if="!externalTab" class="top-tabs">
      <button class="tab-btn" :class="{ active: activeTab === 'task' }" @click="activeTab = 'task'">
        <i class="fa fa-bullseye"></i> {{ en() ? 'Task' : '任务' }}
      </button>
      <button class="tab-btn" :class="{ active: activeTab === 'rows' }" @click="activeTab = 'rows'"
              :title="en() ? 'Details of every row: status / times / steps / tokens / errors — click a row for the full record' : '每行的详情：状态 / 时间 / 步数 / Token / 错误；点击行看完整记录'">
        <i class="fa fa-list-alt"></i> {{ en() ? 'Details' : '详情' }} ({{ rows.length }})
      </button>
      <button class="tab-btn" :class="{ active: activeTab === 'results' }" @click="activeTab = 'results'"
              :title="en() ? 'Preview results and export to Excel' : '预览结果并导出 Excel'">
        <i class="fa fa-table"></i> {{ en() ? 'Results' : '结果' }} ({{ hasDataset ? datasetRows.length : rows.length }})
      </button>
      <button v-if="rounds.length > 1" class="tab-btn" :class="{ active: activeTab === 'compare' }" @click="activeTab = 'compare'"
              :title="compareTabTitle">
        <i class="fa fa-columns"></i> {{ en() ? 'Compare' : '对比' }}
      </button>
      <button v-if="graphEnabled" class="tab-btn" :class="{ active: activeTab === 'graph' }" @click="activeTab = 'graph'"
              :title="en() ? 'Trajectory graph: crawl path or visited-source paths' : '轨迹图谱：爬取轨迹或信源访问路径'">
        <i class="fa fa-sitemap"></i> {{ en() ? 'Graph' : '图谱' }} ({{ graphViewFiltered.nodes.length }})
      </button>
      <button class="tab-btn" :class="{ active: activeTab === 'logs' }" @click="activeTab = 'logs'"
              :title="en() ? 'Run logs (main + per-worker), level filter and keyword search' : '运行日志（主日志 + 各线程），支持级别筛选与关键字搜索'">
        <i class="fa fa-terminal"></i> {{ en() ? 'Logs' : '日志' }} ({{ logs.length }})
      </button>
      <button class="tab-btn" :class="{ active: activeTab === 'help' }" @click="activeTab = 'help'">
        <i class="fa fa-book"></i> {{ en() ? 'Help' : '帮助' }}
      </button>
    </div>

    <div class="main-content">
      <!-- ====== 任务（定义任务）/ 日志（独立标签页共用此容器，按激活页签二选一显示） ====== -->
      <div v-if="activeTab === 'task' || activeTab === 'logs'" class="task-two-col">
        <!-- 任务页：三列（左：执行与配置——操作栏已并入卡片；中：输入；右：输出） -->
        <div v-if="activeTab === 'task'" class="task-page scoll">
            <div class="task-panels">

            <!-- ====== 输入：（中列）来源与输入元素 ====== -->
            <div class="form-section task-panel-input scoll">
              <div class="form-section-title"><i class="fa fa-sign-in"></i> {{ en() ? 'Input' : '输入' }}</div>

            <!-- 来源：表格（导入）/ 文件夹（扫描）/ 文本（每行一条，可粘贴网址·文件路径·任意文本） -->
            <div class="form-group">
              <label>{{ en() ? 'Source' : '来源' }}</label>
              <select style="margin:0px" v-model="sourceKind" :disabled="isRunning || isLoading"
                      :title="en() ? 'Where task rows come from: an imported table, files scanned from a folder, or lines of pasted text (URLs, file paths or plain text — see Content under Run).' : '任务行的来源：导入的表格、扫描自文件夹的文件，或粘贴的文本（每行一条，可为网址 / 文件路径 / 任意文本——含义由「执行 → 内容获取」决定）'">
                <option value="table">{{ en() ? 'Table (import)' : '表格（导入 xlsx / csv）' }}</option>
                <option value="folder">{{ en() ? 'Folder (scan files)' : '文件夹（扫描本地文件）' }}</option>
                <option value="text">{{ en() ? 'Text (one entry per line)' : '文本（每行一条）' }}</option>
              </select>
            </div>
            <!-- 表格来源：导入按钮（原顶部按钮组的导入已移到此处） -->
            <div v-if="sourceKind === 'table'" class="button" style="margin:0 0 8px;width:100%;box-sizing:border-box;" @click="importData" :disabled="isRunning || isLoading"
                 :title="en() ? 'Import table (xlsx / xls / csv); each row becomes one task' : '导入表格（xlsx / xls / csv），每行 = 一个任务'">
              <i class="fa fa-file-excel-o"></i> {{ en() ? 'Import table (each row = one task)' : '导入表格（每行 = 一个任务）' }}
            </div>
            <!-- 文件夹来源：文件夹路径 + 扩展名/排除目录 + 扫描生成任务行 -->
            <div v-if="isFolderSource">
              <div class="form-group">
                <label>{{ en() ? 'Folder' : '扫描文件夹' }}</label>
                <input v-model="config.folderPath" style="flex:1;min-width:0;" :disabled="isRunning || isLoading"
                       :placeholder="en() ? 'Pick the folder to scan' : '选择要扫描的文件夹'"
                       :title="en() ? 'Each file under this folder becomes one task row' : '该文件夹下的文件将逐个成为任务行'" />
                <div class="button" style="margin:0 0 0 4px;flex:none;" @click="pickFolder" :disabled="isRunning || isLoading"
                     :title="en() ? 'Choose folder' : '选择文件夹'"><i class="fa fa-folder-open"></i></div>
              </div>
              <div class="form-group">
                <label>{{ en() ? 'Extensions' : '扩展名' }}</label>
                <input v-model="extInput" style="margin:0px" :disabled="isRunning || isLoading" placeholder=".md,.txt" @change="applySourceInputs"
                       :title="en() ? 'Comma separated (with dot); empty = all files' : '逗号分隔（含点）；留空 = 全部文件'" />
              </div>
              <div class="form-group">
                <label>{{ en() ? 'Exclude dirs' : '排除目录' }}</label>
                <input v-model="excludeInput" style="margin:0px" :disabled="isRunning || isLoading" placeholder="node_modules,.git" @change="applySourceInputs"
                       :title="en() ? 'Comma separated directory names to skip' : '逗号分隔的目录名（扫描时跳过）'" />
              </div>
              <div class="button" style="margin:0 0 8px;width:100%;box-sizing:border-box;" @click="scanFolderRows" :disabled="isRunning || isLoading || !config.folderPath"
                   :title="en() ? 'Scan the folder and turn each file into a task row (existing files are skipped)' : '扫描文件夹，每个文件生成一行任务（已存在的文件自动跳过）'">
                <i class="fa fa-search"></i> {{ en() ? 'Scan folder' : '扫描文件夹生成任务行' }}
              </div>
            </div>

            <!-- 文本来源：粘贴文本，每行一条 → 生成任务行（行的含义由「执行 → 内容获取」决定：纯文本/网页/文件） -->
            <div v-if="isTextSource">
              <div class="form-group goal-group">
                <label>{{ en() ? 'Text' : '文本内容' }}</label>
                <textarea
                  v-model="config.textInput"
                  rows="5"
                  class="scoll"
                  :disabled="isRunning || isLoading"
                  :title="en() ? 'One entry per line; each line becomes one task row. What a line means (plain text / web page / file path) is chosen under Run → Content.' : '每行一条；每行生成一个任务行。行文本的含义（纯文本 / 网页地址 / 文件路径）由「执行 → 内容获取」决定'"
                  :placeholder="'https://example.com/list\nhttps://example.com/page-2\n（每行一条，可粘贴任意文本）'"
                ></textarea>
              </div>
              <div class="form-group">
                <label>{{ en() ? 'Field name' : '字段名' }}</label>
                <input v-model="config.textFieldName" style="margin:0px" :disabled="isRunning || isLoading"
                       :placeholder="en() ? 'e.g. url / text' : '如 url / text'"
                       :title="en() ? 'Column name each line is stored in; used by {{placeholders}} and as the Content lookup field' : '每行文本存放的字段名；既用于 {{占位符}}，也是「内容获取」的取值字段'" />
              </div>
              <div class="button" style="margin:0 0 8px;width:100%;box-sizing:border-box;" @click="generateTextRows" :disabled="isRunning || isLoading || !(config.textFieldName || '').trim()"
                   :title="en() ? 'Create one task row per line (duplicates are skipped; fetch mode ignores non-http lines)' : '每行生成一个任务行（重复行自动跳过；抓取模式忽略非 http(s) 行）'">
                <i class="fa fa-list-ol"></i> {{ en() ? 'Create rows (one per line)' : '按行生成任务行' }}
              </div>
            </div>
            <!-- 来源路径：导入表格 / 选择文件夹 / 生成文本行后显示（悬停看完整路径） -->
            <div v-if="sourceInfo" class="source-info-line" :title="sourceInfo.path">
              <i class="fa" :class="sourceInfo.icon"></i>
              <span class="source-info-text">{{ sourceInfo.text }}</span>
            </div>

            <!-- ====== 任务指令（每行渲染一次）：智能体 / 纯 LLM / 结构化提取三种执行方式共用
                 （排版：CSS order 把它排到「数据选择」下方，并占满输入面板剩余高度） ====== -->
            <div class="io-section io-instr-section">
              <div class="tr-group-head">
                <span class="io-sec-title" :title="instructionTitle">{{ en() ? 'Task instruction' : '任务指令' }}</span>
              </div>
              <textarea
                ref="templateTextarea"
                v-model="config.template"
                rows="6"
                class="scoll io-instr"
                :title="instructionTitle"
                :placeholder="instructionPlaceholder"
                :disabled="isRunning || isLoading"
              ></textarea>
              <div v-if="unusedPlaceholders.length" class="placeholder-warn">
                <i class="fa fa-exclamation-triangle"></i>
                {{ config.keepUnmatched
                  ? (en() ? 'No such columns (kept as-is): ' : '以下占位符未匹配到列（将保留原样）：')
                  : (en() ? 'No such columns (will be cleared): ' : '以下占位符未匹配到列（将清空）：') }} {{ unusedPlaceholders.join(', ') }}
              </div>
              <div class="instr-opt-row">
                <label :title="en() ? 'Unmatched {{placeholders}} are cleared by default; check to keep them as-is (applies to Agent / Pure LLM / Structured extraction alike)' : '未匹配到列的 {{占位符}} 默认清空；勾选后保留原样（智能体 / 纯 LLM / 结构化提取三种执行方式都生效）'">
                  <input type="checkbox" v-model="config.keepUnmatched" :disabled="isRunning || isLoading" />
                  {{ en() ? 'Keep unmatched placeholders as-is' : '未匹配占位符保留原样' }}
                </label>
              </div>
            </div>

            <!-- ====== 数据选择：这一行把哪些数据交给模型（点列名 = 写入 / 移除任务指令里的 {{列名}}） ====== -->
            <div class="io-section io-data-section">
              <div class="tr-group-head">
                <span class="io-sec-title" :title="dataSelectTitle">{{ en() ? 'Data selection' : '数据选择' }}</span>
                <span v-if="columns.length" class="tr-mini" @click="appendAllCols" :title="en() ? 'Reference every column in the task instruction' : '把每一列都写入任务指令（{{列名}}）'">{{ en() ? 'All' : '全部引用' }}</span>
                <span v-if="columns.length" class="tr-mini" @click="removeAllCols" :title="en() ? 'Remove every {{column}} placeholder from the task instruction' : '从任务指令里移除全部 {{列名}} 占位符'">{{ en() ? 'None' : '全部移除' }}</span>
              </div>
              <div v-if="columns.length" class="data-chips scoll">
                <div class="placeholder-chips">
                  <span v-for="col in columns" :key="col" class="placeholder-chip" :class="{ on: isColUsed(col) }"
                        @click="toggleCol(col)" :title="colTitle(col)">{{ col }}</span>
                  <span class="placeholder-chip special" :class="{ on: isColUsed('rowIndex') }" @click="toggleCol('rowIndex')"
                        :title="en() ? 'Special: the 1-based row number; click to write / remove' : '特殊占位符：行号（从 1 起）；点击写入 / 移除'">rowIndex</span>
                </div>
              </div>
              <div v-else class="tr-empty">{{ dataEmptyHint }}</div>
              <!-- 前轮结果：跨轮引用（点芯片即写入 / 移除 {{第1轮.结果}} 这类占位符） -->
              <div v-if="otherRounds.length" class="round-ref-block">
                <div class="round-ref-head" :title="roundRefTitle"><i class="fa fa-history"></i> {{ en() ? 'Previous rounds' : '前轮结果' }}</div>
                <div class="placeholder-chips">
                  <template v-for="s in otherRounds" :key="s.id">
                    <span v-for="f in roundRefChipFields(s)" :key="`${s.id}-${f}`" class="placeholder-chip round-ref"
                          :class="{ on: isPlaceholderUsed(`${s.label}.${f}`) }"
                          @click="toggleRoundRef(`${s.label}.${f}`)" :title="roundRefChipTitle(s, f)">{{ s.label }}.{{ f }}</span>
                  </template>
                </div>
              </div>

              <!-- 内容获取提示（非「结构化提取」时不生效——智能体可自行访问，纯 LLM 直接用行数据） -->
              <div v-if="contentSourceLocal !== 'none' && !isExtractMode" class="dsr-hint" style="margin:2px 0 0;">
                <i class="fa fa-info-circle"></i>
                {{ contentSourceHint }}
              </div>

              <!-- 结构化提取的「素材」：直接使用行数据 / 读字段中的文件 / 抓字段中的网页（+ 链接跟随设置） -->
              <template v-if="isExtractMode">
                <div class="form-group" style="margin-top:4px;">
                  <label>{{ en() ? 'Content' : '内容获取' }}</label>
                  <select style="margin:0px" v-model="contentSourceLocal" :disabled="isRunning || isLoading || isFolderSource"
                          :title="en() ? 'Where the material of each row comes from: the row data itself, a local file path in a field, or a web page URL in a field (fetch + optional link following). Folder sources always read local files.' : '每行任务的素材来源：直接使用行数据、把字段当作本地文件路径读取，或把字段当作网页地址抓取（支持链接跟随）。文件夹来源固定读取本地文件。'">
                    <option value="none">{{ en() ? 'Row data (as is)' : '直接使用行数据' }}</option>
                    <option value="file">{{ en() ? 'Read file from field' : '读取字段中的本地文件' }}</option>
                    <option value="url">{{ en() ? 'Fetch web page from field' : '抓取字段中的网页' }}</option>
                  </select>
                </div>
                <!-- 取值字段（仅表格来源需要填写；文本来源用上方「字段名」，文件夹固定 filePath） -->
                <div class="form-group" v-if="contentSourceLocal !== 'none' && !isTextSource && !isFolderSource">
                  <label>{{ en() ? 'Value field' : '取值字段' }}</label>
                  <input v-model="config.contentField" style="margin:0px" :disabled="isRunning || isLoading"
                         :placeholder="en() ? 'Column holding path / URL' : '存放路径 / 网址的列名'"
                         :title="en() ? 'Which column holds the file path or URL for each row' : '该行从哪一列取文件路径 / 网页地址'" />
                </div>

                <!-- 抓取设置（内容获取 = 抓取网页）：链接跟随 / 关键词 / 深度 / 页数 / 分析对象 -->
                <div v-if="contentSourceLocal === 'url'">
                  <div class="form-group">
                    <label>{{ en() ? 'Follow' : '链接跟随' }}</label>
                    <select style="margin:0px" v-model="config.urlFollow" :disabled="isRunning || isLoading"
                            :title="en() ? 'Which discovered links become new rows: none / same host / keyword / all (capped by max depth and max pages)' : '页面中发现的链接如何变成新任务行：不跟随 / 同域 / 关键词 / 全部（受最大深度与最大页面数约束）'">
                      <option value="none">{{ en() ? 'None (seeds only)' : '不跟随（只抓种子）' }}</option>
                      <option value="same-host">{{ en() ? 'Same host' : '同域链接' }}</option>
                      <option value="keyword">{{ en() ? 'Keyword match' : '关键词匹配' }}</option>
                      <option value="all">{{ en() ? 'All links' : '全部链接' }}</option>
                    </select>
                  </div>
                  <div class="form-group" v-if="config.urlFollow === 'keyword'">
                    <label>{{ en() ? 'Keywords' : '跟随关键词' }}</label>
                    <input v-model="config.urlKeywords" :disabled="isRunning || isLoading" placeholder="cfp,conference"
                           :title="en() ? 'Comma separated; a link is followed when its URL contains one of them' : '逗号分隔；链接 URL 命中任一关键词时才跟随'" />
                  </div>
                  <div class="form-group">
                    <label>{{ en() ? 'Max depth' : '最大深度' }}</label>
                    <input type="number" v-model.number="config.urlMaxDepth" min="0" max="10" :disabled="isRunning || isLoading"
                           :title="en() ? '0 = fetch seeds only; child links are one level deeper' : '0 = 只抓种子页；子链接深度 = 父 + 1'" />
                  </div>
                  <div class="form-group">
                    <label>{{ en() ? 'Max pages' : '最大页面数' }}</label>
                    <input type="number" v-model.number="config.urlMaxPages" min="1" max="100000" :disabled="isRunning || isLoading"
                           :title="en() ? 'Total page cap for this crawl (seeds included)' : '本次爬取的页面总数上限（含种子）'" />
                  </div>
                  <div class="form-group">
                    <label>{{ en() ? 'Analyze' : '分析对象' }}</label>
                    <select style="margin:0px" v-model="config.urlBody" :disabled="isRunning || isLoading"
                            :title="en() ? 'What to feed the LLM: the filtered page text, or the link list with anchor texts (old link-analysis mode)' : '交给 LLM 的内容：过滤后的页面正文，或页面链接清单（含锚文本；旧「链接分析模式」）'">
                      <option value="text">{{ en() ? 'Page text' : '页面正文' }}</option>
                      <option value="links">{{ en() ? 'Link list (with anchor text)' : '链接清单（含锚文本）' }}</option>
                    </select>
                  </div>
                </div>
                <div class="dsr-hint" style="margin-top:2px;">
                  <i class="fa fa-info-circle"></i>
                  {{ extractHintText }}
                </div>
              </template>
            </div>
            </div>

            <!-- ====== 执行与配置（左列）：操作栏 + 预设 + 处理方式与模式定义 + 执行参数（同一张卡片） ====== -->
            <div class="form-section task-panel-run scoll">
              <!-- 任务操作栏（卡片顶部，卡片内滚动时吸顶）：读取 / 保存 / 另存为 · 重置 / 停止 / 启动 -->
              <div class="task-toolbar">
                <button class="task-action-btn" :disabled="isLoading" :title="en() ? 'Load task state' : '读取任务状态'" @click="loadTaskState()"><i class="fa" :class="isLoading ? 'fa-spinner fa-spin' : 'fa-folder-open'"></i> {{ en() ? 'Load' : '读取' }}</button>
                <button class="task-action-btn" :disabled="isLoading" :title="en() ? 'Save task state' : '保存任务状态'" @click="saveTaskState"><i class="fa fa-save"></i> {{ en() ? 'Save' : '保存' }}</button>
                <button class="task-action-btn" :disabled="isLoading || rows.length === 0" :title="saveAsTitle" @click="saveTaskStateAs"><i class="fa fa-files-o"></i> {{ en() ? 'Save as' : '另存为' }}</button>
                <button class="task-action-btn" :disabled="isRunning || isLoading" :title="en() ? 'Reset rows, logs and stats (keep task config)' : '重置行数据、日志和统计（保留任务配置）'" @click="clearAll"><i class="fa fa-trash"></i> {{ en() ? 'Reset' : '重置' }}</button>
                <button class="task-action-btn danger" v-if="isRunning" :title="stopButtonTitle" @click="stopBatch"><i class="fa fa-stop"></i> {{ en() ? 'Stop' : '停止' }}</button>
                <!-- 启动按钮不显示「运行中…」标记：运行状态统一看底部状态栏最左侧（运行时按钮只是禁用） -->
                <button class="task-action-btn primary" :disabled="isRunning || isLoading || rows.length === 0" :title="startButtonTitle" @click="startBatch()"><i class="fa fa-play"></i> {{ en() ? 'Start' : '启动' }}</button>
              </div>
              <!-- 轮次（多轮处理）：每轮各存一份配置快照与结果；运行中锁定 -->
              <div class="form-group">
                <label>{{ en() ? 'Round' : '轮次' }}</label>
                <div class="round-box">
                  <select class="round-select" :value="currentRoundId" :disabled="isRunning || isLoading"
                          :title="roundSelectTitle" @change="onRoundSelect">
                    <option v-for="r in rounds" :key="r.id" :value="r.id">{{ roundOptionLabel(r) }}</option>
                  </select>
                  <span class="round-btn" :class="{ disabled: isRunning || isLoading }" :title="newRoundTitle" @click="newRound">
                    <i class="fa fa-plus"></i>
                  </span>
                  <span class="round-btn" :class="{ disabled: isRunning || isLoading }" :title="chainedRoundTitle" @click="newChainedRound">
                    <i class="fa fa-code-fork"></i>
                  </span>
                  <span class="round-btn" :class="{ disabled: isRunning || isLoading }" :title="renameRoundTitle" @click="renameRound">
                    <i class="fa fa-pencil"></i>
                  </span>
                  <span class="round-btn danger" :class="{ disabled: isRunning || isLoading || rounds.length <= 1 }" :title="deleteRoundTitle" @click="deleteRound">
                    <i class="fa fa-trash-o"></i>
                  </span>
                </div>
              </div>
              <!-- 预设：一键套用旧脚手架的配置形态（批量智能体运行 / 表格定向推理 / 文件采集表格 / 链接采集表格） -->
              <div class="form-group">
                <label>{{ en() ? 'Preset' : '预设' }}</label>
                <select style="margin:0px" v-model="presetKey" :disabled="isRunning || isLoading"
                        :title="en() ? 'Apply a built-in preset (a legacy scaffold as a configuration); existing rows are kept. Any manual change switches it back to Custom.' : '一键套用内置预设（旧脚手架即一组配置）；已导入的任务行会保留；手动改动任一维度后回到「自定义配置」'">
                  <option value="">{{ en() ? 'Custom' : '自定义配置' }}</option>
                  <option v-for="p in presetOptions" :key="p.key" :value="p.key">{{ p.label }}</option>
                </select>
              </div>

            <!-- 执行方式：智能体（每行一个完整智能体会话）/ 纯 LLM 推理（按输出字段逐列补全并写回新列）/ 结构化提取（写入数据表） -->
            <div class="form-group">
              <label>{{ en() ? 'Mode' : '执行方式' }}</label>
              <select style="margin:0px" v-model="execMethod" :disabled="isRunning || isLoading"
                      :title="en() ? 'Who does the work: Agent (full session with tools — can read files, browse the web, use the KB) or Pure LLM (no tools; single or chunked calls). Where the result goes is set by Output.' : '由谁来完成：智能体（完整会话、带工具，可读文件 / 联网 / 用知识库）或 纯 LLM 推理（无工具；单次或分段调用）。结果写到哪由「输出方式」决定。'">
                <option value="agent">{{ en() ? 'Agent (full session, with tools)' : '智能体（完整会话，带工具）' }}</option>
                <option value="llm">{{ en() ? 'Pure LLM (no tools)' : '纯 LLM 推理（无工具）' }}</option>
              </select>
            </div>
            <!-- 详情标题：详情表格（及结果页预览）左侧显示哪一列——可不选；运行中可随时切换 -->
            <div class="form-group">
              <label>{{ en() ? 'Row title' : '详情标题' }}</label>
              <select style="margin:0px" v-model="config.rowTitleField" :disabled="isLoading"
                      :title="en() ? 'Which field is shown as the row title at the left of the details table (and the results preview). Choose None to hide the column; switchable while running.' : '详情表格（及结果页预览）左侧显示哪个字段作为行标题：选「不显示」则隐藏该列；运行中可随时切换'">
                <option value="">{{ en() ? 'None (hide the column)' : '不显示（隐藏该列）' }}</option>
                <option v-for="col in columns" :key="col" :value="col">{{ col }}</option>
                <!-- 旧任务/换表后：已选字段不在当前列中——保底显示，避免下拉空白 -->
                <option v-if="staleTitleField" :value="staleTitleField">{{ staleTitleField }}</option>
              </select>
            </div>
            <!-- 内容获取提示（非结构化提取时不生效；智能体可自行访问占位符里的地址） -->
            <div v-if="contentSourceLocal !== 'none' && !isExtractMode" class="dsr-hint" style="margin-top:2px;">
              <i class="fa fa-info-circle"></i>
              {{ contentSourceHint }}
            </div>

            <!-- 预设智能体选择（仅智能体模式） -->
            <div class="form-group" v-if="isAgentMode">
              <label>{{ en() ? 'Agent' : '智能体' }}</label>
              <select style="margin:0px" v-model="config.presetId" :disabled="isRunning || isLoading">
                <option value="">{{ en() ? 'General Agent (autonomous)' : '通用智能体（自主规划）' }}</option>
                <option v-for="p in store.agentPresets" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>

            <!-- LLM 后端 / 模型（仅智能体模式；纯 LLM 推理跟随全局设置） -->
            <div class="form-group" v-if="isAgentMode">
              <label>{{ en() ? 'LLM Backend' : 'LLM 后端' }}</label>
              <select style="margin:0px" v-model="config.llmType" :disabled="isRunning || isLoading">
                <option v-for="t in LLM_TYPES" :key="t.value" :value="t.value">{{ en() ? t.labelEn : t.labelZh }}</option>
                <!-- 兼容旧任务文件里保存的显式后端 id（新 UI 只保留两种跟随选项，不让下拉变空白） -->
                <option v-if="legacyLlmOption" :value="config.llmType">{{ legacyLlmOption }}</option>
              </select>
            </div>
            <div v-if="isAgentMode && isDeepSeekResponses" class="dsr-hint">
              <i class="fa fa-globe"></i>
              {{ en() ? 'DeepSeek Responses backend: online search is provided by the local web_search tool (enable the Web Search capability).' : 'DeepSeek Responses 后端：联网搜索由本地 web_search 工具提供（请在能力插槽中开启网络搜索）。' }}
            </div>

            <!-- 任务指令 / 数据选择已移至上方「输入」面板——此处只保留执行选项 -->

            <!-- ====== 纯 LLM 推理：执行选项（任务指令・数据选择在「输入」、输出字段在「输出」中配置） ====== -->
            <div v-if="isLlmMode">
              <div class="form-group">
                <label>{{ en() ? 'Structured' : '结构化输出' }}</label>
                <label style="flex:none;min-width:0;font-size:10px;gap:4px;cursor:pointer;">
                  <input type="checkbox" v-model="config.structured" :disabled="isRunning || isLoading" style="flex:none;margin:0px" />
                  {{ en() ? 'One call per row (JSON)' : '每行一次调用（JSON）' }}
                </label>
              </div>
              <div class="dsr-hint" style="margin-top:2px;">
                <i class="fa fa-info-circle"></i>
                {{ en() ? 'Pure LLM mode follows the global LLM backend; each row follows the Task instruction and is filled field by field (no tools, fast & cheap). The instruction and data selection live under Input, output fields under Output.' : '纯 LLM 模式跟随全局 LLM 后端；每行按「任务指令」逐字段推理补全（不使用工具，快且省）。任务指令与数据选择在「输入」面板，输出字段在「输出」面板。' }}
              </div>
            </div>

            <!-- ====== 纯 LLM 推理（结构化提取）：仅保留分段大小 / 分段结果（任务指令 / 数据选择在「输入」面板） ====== -->
            <div v-if="isExtractMode">
              <div class="form-group" style="flex-wrap:wrap;">
                <label>{{ en() ? 'Chunk size' : '分段大小' }}</label>
                <input type="number" v-model.number="config.maxContentPerFile" min="500" step="500" style="flex:1 1 120px;min-width:80px;" :disabled="isRunning || isLoading"
                       :title="en() ? 'Max characters per LLM call; long content is chunked at paragraph/row boundaries with table headers kept' : '每次 LLM 调用的最大字符数；超长内容按段落/整行边界切分（表格自动补表头）'" />
              </div>
              <div class="form-group">
                <label>{{ en() ? 'Segments' : '分段结果' }}</label>
                <select v-model="config.segmentMerge" :disabled="isRunning || isLoading" :title="segmentMergeTitle">
                  <option value="one">{{ en() ? 'Merge into one record' : '合并为一条记录' }}</option>
                  <option value="each">{{ en() ? 'One record per segment' : '每段各成一条' }}</option>
                </select>
              </div>
            </div>
            <!-- 重跑同一个行时，结构化提取结果怎么算（默认替换，避免越跑越多） -->
            <div v-if="outputMode === 'structured'" class="form-group">
              <label>{{ en() ? 'On rerun' : '重跑结果' }}</label>
              <select v-model="config.rerunResultMode" :disabled="isRunning || isLoading" :title="rerunResultModeTitle">
                <option value="replace">{{ en() ? 'Replace this row’s previous records' : '替换该行原有结果' }}</option>
                <option value="merge">{{ en() ? 'Keep & merge (may append)' : '保留并合并（可能追加）' }}</option>
              </select>
            </div>
            <!-- ====== 执行设置（原右列，已并入本卡片；与上方执行配置同一列表，不再加分隔线） ====== -->
            <!-- 定时自动保存：每 N 小时在任务文件同目录生成带时间戳的快照（0 = 关闭）
                 「下次自动保存」时间显示在底部状态栏，此处只保留间隔输入 -->
            <div class="form-group">
              <label>{{ en() ? 'Auto-save' : '自动保存间隔' }}</label>
              <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
                <input type="number" v-model.number="config.autoSaveHours" min="0" max="168" step="1" style="flex:1;min-width:64px;"
                       :disabled="isLoading"
                       :title="autoSaveInputTitle" />
                <span style="font-size:10px;color:var(--fontColor);white-space:nowrap;flex:none;">{{ en() ? 'h' : '小时' }}</span>
              </div>
            </div>
            <!-- 图谱总开关：关闭后不做轨迹投影（省算力）、也不显示「图谱」标签页；行详情的过息快照不受影响 -->
            <div class="form-group">
              <label>{{ en() ? 'Graph' : '图谱' }}</label>
              <div class="keep-file-box">
                <label class="keep-file-check" :title="graphEnabledTitle">
                  <input type="checkbox" v-model="config.graphEnabled" />
                  <span>{{ en() ? 'Enable graph tab' : '启用「图谱」标签页' }}</span>
                </label>
              </div>
            </div>
            <!-- 随任务文件保留：图谱数据（行过程快照 / 步骤数）与运行日志（主日志 + 各线程）默认不保留，
                 勾选后才会写进 .task 文件（重开任务文件仍可看图谱 / 日志，但文件更大） -->
            <div class="form-group">
              <label>{{ en() ? 'Keep in file' : '随任务文件保留' }}</label>
              <div class="keep-file-box">
                <label class="keep-file-check" :title="keepTraceTitle">
                  <input type="checkbox" v-model="config.keepTrace" />
                  <span>{{ en() ? 'Graph data' : '图谱数据' }}</span>
                </label>
                <label class="keep-file-check" :title="keepLogsTitle">
                  <input type="checkbox" v-model="config.keepLogs" />
                  <span>{{ en() ? 'Run logs' : '运行日志' }}</span>
                </label>
              </div>
            </div>
            <div class="form-group">
              <label>{{ en() ? 'Concurrency' : '并发数' }}</label>
              <input type="number" v-model.number="config.concurrency" min="1" :max="MAX_CONCURRENCY" :disabled="isLoading" @change="onConcurrencyChange"
                     :title="en() ? `Concurrent agents (max ${MAX_CONCURRENCY}). Adjustable while running: raising starts queued rows immediately.` : `同时执行的智能体数量（上限 ${MAX_CONCURRENCY}）。运行中可调：调高会立即放行排队行，调低则等当前任务结束后收敛`" />
            </div>
            <div class="form-group" v-if="isAgentMode">
              <label>{{ en() ? 'Stagger (ms)' : '错峰间隔(ms)' }}</label>
              <input type="number" v-model.number="config.staggerMs" min="0" max="5000" :disabled="isLoading"
                     :title="en() ? 'Stagger the first request of each worker (ms) to reduce concurrent spikes to remote LM Studio; 0 = off. Applies to rows started after the change.' : '各线程首个请求的错峰间隔（毫秒）：降低远程 LM Studio 高并发空回/500；0 = 关闭。对调整之后启动的行生效'" />
            </div>
            <div class="form-group" v-if="isAgentMode">
              <label>{{ en() ? 'Max Steps' : '最大步数' }}</label>
              <input type="number" v-model.number="config.maxSteps" :min="1" :max="AGENT_MAX_STEPS_MAX" :disabled="isLoading"
                     :title="en() ? 'Max execution steps per agent turn. Applies to rows started after the change. It is also the budget when an agent browses the web itself — keep it modest (and state a visit cap in the task instruction) to avoid endless page visiting.' : '每个智能体单轮最大执行步数。对调整之后启动的行生效。它也是智能体自行联网翻页时的预算——别调太大（并在任务指令里写明访问上限），以免无限翻页。'" />
            </div>
            <div class="form-group">
              <label>{{ en() ? 'Retry' : '失败重试' }}</label>
              <input type="number" v-model.number="config.retry" min="0" max="10" :disabled="isLoading" :title="en() ? 'How many times a failed row is retried automatically (applies to failures from now on)' : '失败后自动重试次数（对后续失败生效）'" />
            </div>
            <div class="form-group" v-if="isAgentMode">
              <label>{{ en() ? 'Empty result' : '空内容处理' }}</label>
              <select style="margin:0px" v-model="config.emptyAction" :disabled="isRunning || isLoading"
                      :title="en() ? 'What to do when the agent finishes with no text output' : '当智能体正常结束但无任何文本输出时的处理方式'">
                <option value="">{{ en() ? 'No action (completed, keep empty)' : '无操作（按完成，结果留空）' }}</option>
                <option value="replace">{{ en() ? 'Replace result with text' : '将结果替换为指定文本' }}</option>
                <option value="rerun">{{ en() ? 'Auto rerun (with cap)' : '自动重跑（可设上限）' }}</option>
              </select>
            </div>
            <div v-if="isAgentMode && config.emptyAction === 'replace'" class="form-group">
              <label>{{ en() ? 'Replacement' : '替换文本' }}</label>
              <input v-model="config.emptyReplaceText" :disabled="isRunning || isLoading"
                     :placeholder="en() ? 'Text written to result when output is empty' : '输出为空时写入结果列的文本'" />
            </div>
            <div v-if="isAgentMode && config.emptyAction === 'rerun'" class="form-group">
              <label>{{ en() ? 'Rerun cap' : '重跑上限' }}</label>
              <input type="number" v-model.number="config.emptyRetryLimit" min="0" max="50" :disabled="isRunning || isLoading"
                     :title="en() ? 'Max auto reruns when result is empty' : '输出为空时最多自动重跑次数（按行计数）'" />
            </div>
            <div class="form-group" v-if="isAgentMode">
              <label>{{ en() ? 'Tools' : '工具白名单' }}</label>
              <input v-model="config.toolsOverride" :disabled="isRunning || isLoading" :placeholder="en() ? 'comma separated, empty = auto' : '逗号分隔，留空自动跟随预设/全局'"
                     :title="en() ? 'Advanced (agent mode only): comma-separated tool whitelist that overrides the preset capability slots / global tools. Empty = follow them; also used for custom LLM algorithms.' : '高级（仅智能体模式）：逗号分隔的工具白名单，显式指定时覆盖「预设能力插槽 / 全局工具配置」；留空则自动跟随。'" />
            </div>
            </div>

            <!-- ====== 输出（右列）：输出方式（单独结果 / 结构化提取）+ 提取字段 ====== -->
            <div class="form-section task-panel-output scoll">
              <div class="form-section-title"><i class="fa fa-sign-out"></i> {{ en() ? 'Output' : '输出' }}</div>

            <!-- 输出方式：单独结果（每行一个文本 = 单字段结果）/ 结构化提取（多字段，按主键合并进数据表）
                 两种模型的区别只放在 title 里（悬停看），不再占界面一行 -->
            <div class="form-group">
              <label>{{ en() ? 'Output' : '输出方式' }}</label>
              <select style="margin:0px" v-model="outputMode" :disabled="isRunning || isLoading" :title="outputModeHint">
                <option value="single">{{ isAgentMode ? (en() ? 'Single result (result column)' : '单独结果（写入结果列）') : (en() ? 'Single result (write back to new columns)' : '单独结果（逐列写回原表新列）') }}</option>
                <option value="structured">{{ en() ? 'Structured extraction (data table)' : '结构化提取（按字段合并进数据表）' }}</option>
              </select>
            </div>

            <!-- 输出字段（统一）：逐列写回时 = 写回原表的列（+推理指令）；结构化提取时 = 提取字段（+说明/必填/主键） -->
            <div v-if="isLlmMode || needsSchema" class="tr-block">
              <div class="tr-group-head">
                <span class="tr-group-title" :title="outputFieldsTitle">{{ en() ? 'Output fields' : '输出字段' }}</span>
                <div class="button" style="margin:0px;" @click="addSchemaField" :disabled="isRunning || isLoading"
                     :title="en() ? 'Add a field' : '添加字段'"><i class="fa fa-plus"></i> {{ en() ? 'Add field' : '添加字段' }}</div>
              </div>
              <!-- 字段用表格铺满面板宽度（不再给标签留左侧 94px 空白） -->
              <table v-if="schemaFields.length" class="fields-table">
                <thead><tr>
                  <th style="width:26%;">{{ en() ? 'Field' : '字段名' }}</th>
                  <th>{{ fieldInstructionLabel }}</th>
                  <th v-if="needsSchema" style="width:44px;text-align:center;" :title="en() ? 'Required: never leave empty' : '必填：不允许留空'">{{ en() ? 'Req' : '必填' }}</th>
                  <th v-if="needsSchema" style="width:44px;text-align:center;" :title="en() ? 'Primary key: dedupe & merge by this field' : '主键：按该字段去重合并（同名数据更新而非新增）'">{{ en() ? 'PK' : '主键' }}</th>
                  <th style="width:30px;"></th>
                </tr></thead>
                <tbody>
                  <tr v-for="(f, fi) in schemaFields" :key="f.id">
                    <td><input v-model="f.name" :placeholder="en() ? 'Field' : '字段名'" :disabled="isRunning || isLoading" /></td>
                    <td>
                      <input v-model="f.description" :placeholder="fieldInstructionPlaceholder" :title="f.description" :disabled="isRunning || isLoading" />
                      <div v-if="isLlmMode && f.name && !(f.description || '').trim()" class="tr-auto">
                        <i class="fa fa-lightbulb-o"></i> {{ en() ? 'No instruction — inferred from the field name' : '未填指令：按字段名自动分析提取' }}
                      </div>
                    </td>
                    <td v-if="needsSchema" style="text-align:center;"><input type="checkbox" v-model="f.required" style="flex:none;margin:0px" :disabled="isRunning || isLoading" /></td>
                    <td v-if="needsSchema" style="text-align:center;"><input type="checkbox" :checked="!!f.isPrimaryKey" style="flex:none;margin:0px" :disabled="isRunning || isLoading" @change="setPrimaryKey(fi)" /></td>
                    <td style="text-align:center;"><span class="action-icon danger" @click="removeSchemaField(fi)" :title="en() ? 'Delete' : '删除'"><i class="fa fa-times"></i></span></td>
                  </tr>
                </tbody>
              </table>
              <span v-else class="col-toggle-empty">{{ en() ? 'No fields yet — click + to add' : '暂无字段，点 + 添加' }}</span>
            </div>

            <!-- 结果字段（智能体 + 单独结果） -->
            <div class="form-group" v-if="isAgentMode && outputMode === 'single'">
              <label>{{ en() ? 'Result Field' : '结果字段名' }}</label>
              <input v-model="config.resultField" :disabled="isRunning || isLoading" :title="en() ? 'Column name for the agent result' : '结果写入表格的列名'" />
            </div>

            <!-- 导出列：导出 Excel 时一并写入的列（原表列 + 运行信息 + 轮次列合成一张竖向表单：点行开 / 关，拖手柄排序） -->
            <div class="tr-block export-block" style="margin-top:8px;">
              <div class="tr-group-head">
                <span class="io-sec-title" :title="exportBlockTitle">{{ en() ? 'Export columns' : '导出列' }}</span>
                <span v-if="columns.length" class="tr-mini" @click="exportAllCols" :title="en() ? 'Export every source column' : '导出全部原表列'">{{ en() ? 'All' : '全部' }}</span>
                <span v-if="columns.length" class="tr-mini" @click="exportNoCols" :title="en() ? 'Export no source columns' : '不导出原表列'">{{ en() ? 'None' : '不导出' }}</span>
              </div>
              <div v-if="exportFormItems.length" class="export-form scoll" :title="exportFormTitle">
                <draggable v-model="exportFormItems" item-key="key" handle=".export-form-grip" :animation="150"
                           ghost-class="export-form-ghost" @start="onExportFormDragStart" @end="onExportFormDragEnd">
                  <template #item="{ element }">
                    <div class="export-form-item" :class="{ on: element.on }" :title="element.hint" @click="toggleExportItem(element)">
                      <i class="fa fa-bars export-form-grip" :title="en() ? 'Drag to reorder' : '拖动调整顺序'"></i>
                      <i class="fa export-form-check" :class="element.on ? 'fa-check-square-o' : 'fa-square-o'"></i>
                      <input class="export-form-name" :value="exportNameValue(element)" :placeholder="element.def"
                             :title="exportNameTitle(element)"
                             @click.stop @input="onExportNameInput(element, $event)" @blur="onExportNameBlur(element)"
                             @keydown.enter="($event.target as HTMLInputElement).blur()" />
                      <!-- 改过名的列标出原名，避免看不出它原来是哪一列 -->
                      <span v-if="exportRenamed(element)" class="export-form-origin"
                            :title="en() ? `Original column: ${element.def}` : `原名：${element.def}`">← {{ element.def }}</span>
                      <span v-else class="export-form-kind">{{ exportKindLabel(element.kind) }}</span>
                    </div>
                  </template>
                </draggable>
              </div>
              <div v-else class="tr-empty" style="padding:4px;">{{ exportFormEmptyHint }}</div>
            </div>

            <!-- 详情表格左侧显示哪一列由「执行 → 详情标题」选择（原「显示列」多选已改为此单选） -->
            </div>


            </div>
        </div>

        <!-- 执行日志（独立标签页）：不再显示标题栏（页签名已是「日志」）；清空按钮移入日志工具栏 -->
        <div v-if="activeTab === 'logs'" class="task-col">
          <div class="task-col-body logs-body">
            <div class="logs-content">
              <div class="log-toolbar">
                <div class="logs-tabs">
                  <button class="log-tab-btn" :class="{ active: logTab === 'main' }" @click="logTab = 'main'">
                    <i class="fa fa-terminal"></i> {{ en() ? 'Main' : '主日志' }}
                    <span class="log-tab-count">{{ logs.length }}</span>
                  </button>
                  <button v-for="slot in workerSlots" :key="slot.id" class="log-tab-btn"
                          :class="{ active: logTab === 'w' + slot.id, busy: slot.active }"
                          @click="logTab = 'w' + slot.id">
                    <i class="fa" :class="slot.active ? 'fa-spinner fa-spin' : 'fa-user'"></i> {{ slot.label }}
                    <span class="log-tab-count">{{ slot.rowCount || 0 }}{{ en() ? 'r' : '行' }}</span>
                  </button>
                </div>
                <!-- 工具栏尾部：清空日志（原来在页签标题栏里） -->
                <div class="log-toolbar-tail">
                  <span class="action-icon danger" style="flex:none;" @click="clearLogs" :title="en() ? 'Clear logs' : '清空日志'"><i class="fa fa-trash"></i></span>
                </div>
              </div>

              <!-- 日志过滤：级别（带计数，可多选；不选 = 全部）+ 关键字搜索 -->
              <div class="log-filter-bar">
                <span v-for="opt in logLevelOptions" :key="opt.value" class="log-level-chip"
                      :class="[opt.value, { active: logLevels.includes(opt.value) }]"
                      :title="(en() ? opt.labelEn : opt.labelZh) + (en() ? ': click to show only this level' : '：点击只看该级别（可多选）')"
                      @click="toggleLogLevel(opt.value)">
                  {{ en() ? opt.labelEn : opt.labelZh }} <b>{{ logCounts[opt.value] || 0 }}</b>
                </span>
                <span v-if="logLevels.length" class="log-filter-reset" @click="logLevels = []"
                      :title="en() ? 'Show all levels' : '显示全部级别'">{{ en() ? 'All' : '全部' }}</span>
                <span style="flex:1"></span>
                <input class="filter-input log-search" v-model="logKeyword"
                       :placeholder="en() ? 'Search logs' : '搜索日志'"
                       :title="en() ? 'Filter logs by keyword (message text)' : '按关键字过滤日志（消息内容）'" />
              </div>

              <div v-if="logTab === 'main'" ref="mainLogRef" class="log-list main-log-list scoll" @scroll="onMainLogScroll">
                <!-- 上方已折叠的旧日志：只占高度不渲染（窗口式渲染，DOM 里只保留最后 200 条） -->
                <div v-if="mainLogHiddenAbove > 0" class="log-top-spacer" :style="{ height: mainLogSpacerHeight + 'px' }"></div>
                <div v-if="mainLogHiddenAbove > 0" class="log-more-hint" @click="expandLogWindow('main')"
                     :title="en() ? 'Click to load earlier logs' : '点击加载更早的日志'">
                  <i class="fa fa-arrow-up"></i> {{ en() ? `${mainLogHiddenAbove} earlier logs hidden — scroll up / click` : `已折叠 ${mainLogHiddenAbove} 条更早日志 — 向上滚动或点击展开` }}
                </div>
                <div v-for="item in visibleLogs" :key="item.key" :data-log-key="item.key"
                     class="log-item" :class="[item.log.level, 'lv-' + item.kind]">
                  <span class="log-bar"></span>
                  <span class="log-time">{{ item.log.time }}</span>
                  <span class="log-level">{{ logLevelText(item.log.level) }}</span>
                  <span v-if="item.log.workerId !== undefined" class="log-worker-tag" :title="'线程' + (item.log.workerId + 1)">{{ en() ? 'T' : '线程' }}{{ item.log.workerId + 1 }}</span>
                  <span v-if="item.kind === 'row'" class="log-row-link" @click.stop="jumpToLogRow(item.rowNo)"
                        :title="en() ? `Jump to table row ${item.rowNo}` : `跳到表格第 ${item.rowNo} 行并高亮`">#{{ item.rowNo }}</span>
                  <span class="log-message" :class="{ clamped: item.long && !expandedLogs.has(item.key), expandable: item.long }"
                        :title="item.long ? (expandedLogs.has(item.key) ? (en() ? 'Click to collapse' : '点击收起') : (en() ? 'Click to expand' : '点击展开全文')) : ''"
                        @click="item.long ? toggleLogExpand(item.key) : undefined">{{ expandedLogs.has(item.key) && item.detail ? item.detail : item.text }}</span>
                </div>
                <div v-if="logs.length === 0" class="empty-hint" style="height:auto;padding:30px 0;">
                  <i class="fa fa-terminal" style="font-size:24px;"></i><span>{{ en() ? 'No logs' : '暂无日志' }}</span>
                </div>
                <div v-else-if="visibleLogs.length === 0" class="worker-log-empty">{{ en() ? 'No logs match the filter' : '没有匹配筛选条件的日志' }}</div>
              </div>

              <div v-else ref="workerLogRef" class="log-list worker-log-list worker-log-list-full scoll" @scroll="onWorkerLogScroll">
                <div v-if="currentWorker" class="worker-panel-header">
                  <span class="worker-title">{{ currentWorker.label }}</span>
                  <span class="worker-page-count">{{ currentWorker.rowCount || 0 }} {{ en() ? 'rows' : '行' }}</span>
                  <span v-if="currentWorker.rowTitle" class="worker-url" :title="currentWorker.rowTitle">{{ currentWorker.rowTitle }}</span>
                  <span v-else class="worker-url idle-text">{{ en() ? 'Idle' : '空闲' }}</span>
                </div>
                <!-- 上方已折叠的旧日志：只占高度不渲染（窗口式渲染，DOM 里只保留最后 200 条） -->
                <div v-if="workerLogHiddenAbove > 0" class="log-top-spacer" :style="{ height: workerLogSpacerHeight + 'px' }"></div>
                <div v-if="workerLogHiddenAbove > 0" class="log-more-hint" @click="expandLogWindow('worker')"
                     :title="en() ? 'Click to load earlier logs' : '点击加载更早的日志'">
                  <i class="fa fa-arrow-up"></i> {{ en() ? `${workerLogHiddenAbove} earlier logs hidden — scroll up / click` : `已折叠 ${workerLogHiddenAbove} 条更早日志 — 向上滚动或点击展开` }}
                </div>
                <div v-for="item in visibleWorkerLogs" :key="item.key" :data-log-key="item.key"
                     class="log-item" :class="[item.log.level, 'lv-' + item.kind]">
                  <span class="log-bar"></span>
                  <span class="log-time">{{ item.log.time }}</span>
                  <span class="log-level">{{ logLevelText(item.log.level) }}</span>
                  <span v-if="item.kind === 'row'" class="log-row-link" @click.stop="jumpToLogRow(item.rowNo)"
                        :title="en() ? `Jump to table row ${item.rowNo}` : `跳到表格第 ${item.rowNo} 行并高亮`">#{{ item.rowNo }}</span>
                  <span class="log-message" :class="{ clamped: item.long && !expandedLogs.has(item.key), expandable: item.long }"
                        :title="item.long ? (expandedLogs.has(item.key) ? (en() ? 'Click to collapse' : '点击收起') : (en() ? 'Click to expand' : '点击展开全文')) : ''"
                        @click="item.long ? toggleLogExpand(item.key) : undefined">{{ expandedLogs.has(item.key) && item.detail ? item.detail : item.text }}</span>
                </div>
                <div v-if="currentWorkerLogs.length === 0" class="worker-log-empty">{{ en() ? 'Waiting...' : '等待处理中...' }}</div>
                <div v-else-if="visibleWorkerLogs.length === 0" class="worker-log-empty">{{ en() ? 'No logs match the filter' : '没有匹配筛选条件的日志' }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ====== 轮次对比（多轮结果并排 + 一致性标记） ====== -->
      <div v-if="activeTab === 'compare'" class="compare-wrap">
        <div class="compare-toolbar">
          <span class="compare-label" :title="compareHint">{{ en() ? 'Rounds' : '轮次' }}</span>
          <span v-for="s in rounds" :key="s.id" class="placeholder-chip round-ref" :class="{ on: compareRounds.some(c => c.id === s.id) }"
                @click="toggleCompareRound(s.id)"
                :title="en() ? 'Show / hide this round in the comparison (at least one round is always kept)' : '在对比表里显示 / 隐藏该轮（至少保留一轮，不会全部关掉）'">{{ s.label }}</span>
          <div class="toolbar-spacer"></div>
          <i class="fa fa-info-circle compare-info" :title="compareHint"></i>
        </div>
        <div class="files-table-wrap scoll">
          <table v-if="compareViewRows.length" class="data-table">
            <thead><tr>
              <th style="width:56px;text-align:center;" :title="en() ? 'Original row number' : '原始行号'">#</th>
              <th style="min-width:130px;">{{ titleColumn || (en() ? 'Row' : '行') }}</th>
              <th v-for="s in compareRounds" :key="s.id" style="min-width:200px;" :title="s.label">{{ s.label }}</th>
              <th v-if="compareRounds.length >= 2" style="width:64px;text-align:center;" :title="compareHint">{{ en() ? 'Same?' : '一致' }}</th>
            </tr></thead>
            <tbody>
              <tr v-for="r in compareViewRows" :key="r.origin" :class="{ 'compare-issue-row': r.diff || r.missing }">
                <td style="text-align:center;">{{ r.no }}</td>
                <td class="cell-wrap" :title="r.title"><div class="clamp-3">{{ r.title }}</div></td>
                <td v-for="(c, ci) in r.cells" :key="ci" class="cell-wrap compare-cell" :class="{ clickable: !!String(c || '').trim() }"
                    :title="c ? (en() ? 'Click to preview the rendered result' : '点击用 Markdown 渲染预览该轮结果') : ''" @click="openComparePreview(r, ci)">
                  <div class="clamp-3">{{ c || '—' }}</div>
                </td>
                <td v-if="compareRounds.length >= 2" style="text-align:center;">
                  <i v-if="r.diff" class="fa fa-exclamation-triangle compare-icon-diff" :title="en() ? 'Round results differ' : '各轮结果不一致'"></i>
                  <i v-else-if="r.missing" class="fa fa-question-circle compare-icon-missing" :title="en() ? 'Some round has no result for this row' : '有轮次对此行没有结果'"></i>
                  <i v-else class="fa fa-check compare-icon-same" :title="en() ? 'All rounds agree' : '各轮结果一致'"></i>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-hint">
            <i class="fa fa-columns"></i>
            <span>{{ compareEmptyHint }}</span>
          </div>
          <div v-if="compareTotal > compareViewRows.length" class="table-preview-hint">
            <i class="fa fa-info-circle"></i>
            {{ en() ? `Showing first ${compareViewRows.length} of ${compareTotal} rows` : `仅展示前 ${compareViewRows.length} 行（共 ${compareTotal} 行）` }}
          </div>
        </div>
      </div>

      <!-- ====== 帮助 ====== -->
      <div v-if="activeTab === 'help'" class="help-tab">
        <div class="help-tab-body scoll">
          <div v-for="(sec, si) in helpSections" :key="si" class="help-block">
            <div class="help-title"><i :class="sec.icon"></i> {{ sec.title }}</div>
            <p v-if="sec.text" class="help-text">{{ sec.text }}</p>
            <ul v-if="sec.items && sec.items.length" class="help-list">
              <li v-for="(it, ii) in sec.items" :key="ii">{{ it }}</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- ====== 子任务 / 结果 / 图谱（共用容器，按激活页签显示对应内容） ====== -->
      <div v-if="activeTab === 'rows' || activeTab === 'results' || activeTab === 'graph'" class="files-content">
        <!-- 工具栏：子任务＝筛选/跳转/重跑；结果＝导出；图谱页自带提示条（无工具栏） -->
        <div v-if="activeTab !== 'graph'" class="log-toolbar table-toolbar">
          <template v-if="activeTab === 'rows'">
          <input class="filter-input" v-model="displayKeyword" style="width:180px;min-width:110px" :placeholder="en() ? 'Search' : '搜索'" :disabled="isLoading" />
          <input class="filter-input" v-model="jumpInput" style="width:96px" :disabled="isLoading || rows.length === 0"
                 :placeholder="en() ? 'Row # / id' : '行号 / id'"
                 :title="en() ? 'Jump by 1-based row number or row id' : '按行号（1 起）或行 id 跳转'" @keydown.enter="jumpToRow" />
          <div class="button" style="margin:0px;padding:3px 10px" @click="jumpToRow" :disabled="isLoading || rows.length === 0"
               :title="en() ? 'Jump to row' : '跳转到该行并高亮'"><i class="fa fa-location-arrow"></i> {{ en() ? 'Jump' : '跳转' }}</div>
          <!-- 筛选面板入口：状态 / 搜索 / 结果 / 行号 / 步数 / 耗时 集中在一个面板里，并实时显示命中行数（右侧小字）；重跑选区也在面板内 -->
          <div ref="filterMenuBtnRef" class="button filter-menu-btn" :class="{ active: showFilterPanel, on: activeFilterCount > 0 }"
               style="margin:0px;padding:3px 10px" @click="toggleFilterPanel" :disabled="isLoading" :title="filterButtonTitle">
            <i class="fa fa-filter"></i> {{ en() ? 'Filter' : '筛选' }}
            <span v-if="activeFilterCount" class="filter-menu-count">{{ activeFilterCount }}</span>
            <span class="filter-menu-hit">· {{ tableFilteredRows.length }}/{{ rows.length }}</span>
          </div>
          </template>
          <!-- 结果页：搜索（任意列） / 列筛选 / 行号跳转（预览与导出列一致，导出始终是全部行） -->
          <template v-else-if="activeTab === 'results'">
            <input class="filter-input" v-model="resultSearchKeyword" style="width:180px;min-width:110px"
                   :placeholder="en() ? 'Search all columns' : '搜索全部列'"
                   :title="en() ? 'Keyword search across every column (source columns, extracted fields, run info); searching builds all rows first' : '在所有列（原表列 / 提取字段 / 运行信息）里搜关键字；一搜索会先把全部行构建出来'" />
            <select class="filter-input" v-model="resultFilterCol" style="width:130px"
                    :title="en() ? 'Filter by one column (with a value below; leave the value empty to keep only rows where this column has content)' : '按某一列筛选（配合右侧的值；只选列不填值 = 只看该列有内容的行）'">
              <option value="">{{ en() ? 'Any column' : '任意列' }}</option>
              <option v-for="c in resultColumns" :key="c" :value="c">{{ c }}</option>
            </select>
            <input class="filter-input" v-model="resultFilterValue" style="width:120px" :disabled="!resultFilterCol"
                   :placeholder="en() ? 'value contains' : '值包含'"
                   :title="en() ? 'Value contains (case-insensitive); empty = this column must not be empty' : '值包含（不区分大小写）；留空 = 只看该列非空的行'" />
            <input class="filter-input" v-model="resultJumpInput" style="width:96px"
                   :placeholder="en() ? 'Row #' : '行号'"
                   :title="en() ? 'Jump to the Nth row of the preview (1-based) and highlight it' : '跳到预览的第 N 行（1 起）并高亮'" @keydown.enter="jumpResultRow" />
            <div class="button" style="margin:0px;padding:3px 10px" @click="jumpResultRow"
                 :title="en() ? 'Jump to that row and highlight it' : '跳转到该行并高亮'"><i class="fa fa-location-arrow"></i> {{ en() ? 'Jump' : '跳转' }}</div>
            <span class="filter-menu-hit">· {{ resultHasFilter ? resultHitCount : resultVisibleRows.length }}/{{ resultShownTotal }}</span>
            <!-- 已移除：源表重读后对应任务行已被删掉的记录（只要有一条就出现，点一下只看这些） -->
            <div v-if="removedResultCount" class="button removed-toggle" :class="{ accent: removedOnly }" style="margin:0px;padding:3px 10px"
                 @click="toggleRemovedOnly" :title="removedToggleTitle">
              <i class="fa fa-ban"></i> {{ en() ? `Removed ${removedResultCount}` : `已移除 ${removedResultCount}` }}
            </div>
            <!-- 异常结果：找不到对应任务行的记录（行号缺失 / 超出当前行数），可筛出来逐条处理 -->
            <div v-if="extraResultCount" class="button removed-toggle" :class="{ accent: extraOnly }" style="margin:0px;padding:3px 10px"
                 @click="toggleExtraOnly" :title="extraToggleTitle">
              <i class="fa fa-question-circle"></i> {{ en() ? `Orphan ${extraResultCount}` : `异常 ${extraResultCount}` }}
            </div>
            <span v-if="resultHasFilter" class="tr-mini" style="flex:none" @click="clearResultFilters"
                  :title="en() ? 'Clear search / filter only (results are kept)' : '只取消搜索与筛选（不删结果）'">{{ en() ? 'Clear' : '清除' }}</span>
            <!-- 删掉当前筛出来的残留（异常 / 已移除）——与「清除」（只取消筛选）不同 -->
            <div v-if="extraOnly || removedOnly" class="button removed-toggle accent" style="margin:0px;padding:3px 10px"
                 @click="deleteFilteredExtras" :title="deleteFilteredTitle">
              <i class="fa fa-trash-o"></i> {{ en() ? 'Delete these' : '删除这些' }}
            </div>
          </template>
          <!-- 重跑选区菜单已并入筛选面板（面板内「重跑」+ 选区下拉），此处不再重复入口 -->

          <!-- 筛选面板（Teleport 到 body，避免被工具栏 / 滚动容器裁剪）：条件集中配置 + 命中统计 + 批量标记 -->
          <Teleport to="body">
            <div v-if="showFilterPanel" class="filter-panel-mask" @click="showFilterPanel = false"></div>
            <div v-if="showFilterPanel" class="filter-panel scoll" :style="filterPanelStyle" @click.stop>
              <div class="filter-panel-head">
                <span><i class="fa fa-filter"></i> {{ en() ? 'Filters' : '筛选条件' }}</span>
                <span class="filter-panel-clear" :class="{ disabled: !activeFilterCount }" @click="clearAllFilters"
                      :title="en() ? 'Clear every condition' : '清除全部筛选条件'"><i class="fa fa-eraser"></i> {{ en() ? 'Clear' : '清除' }}</span>
              </div>
              <div class="filter-panel-body">
                <div class="filter-row">
                  <span class="filter-row-label">{{ en() ? 'Status' : '状态' }}</span>
                  <StatusMultiSelect v-model="displayStatus" :options="statusOptions" :hint="statusFilterHint" :disabled="isLoading" />
                </div>
                <div class="filter-row">
                  <span class="filter-row-label">{{ en() ? 'Search' : '搜索' }}</span>
                  <input class="filter-input" v-model="displayKeyword" style="flex:1;min-width:0" :disabled="isLoading"
                         :placeholder="en() ? 'Search data / result / error' : '搜索行数据 / 结果 / 错误'"
                         :title="en() ? 'Keyword search across row data, result and error' : '在行数据 / 结果 / 错误里搜关键字'" />
                </div>
                <div class="filter-row">
                  <span class="filter-row-label">{{ en() ? 'Field' : '字段' }}</span>
                  <!-- 筛哪一列：默认「结果」列，也可选具体的提取字段 / 原表列（含逐列写回的新列） -->
                  <select class="filter-input" v-model="resultFilterField" style="flex:0 0 132px;min-width:96px" :disabled="isLoading"
                          :title="resultFieldSelectTitle" aria-label="筛选字段 / Filter field">
                    <option value="">{{ en() ? 'Result' : '结果' }}</option>
                    <option v-for="c in resultFieldOptions" :key="c" :value="c">{{ c }}</option>
                  </select>
                  <input class="filter-input" v-model="resultKeyword" style="flex:1;min-width:0" :disabled="isLoading"
                         :placeholder="resultPlaceholder" :title="resultFilterHint" />
                  <!-- 空值快捷开关：等价于在该列筛选里写 |''（可与关键字叠加，任一命中即显示） -->
                  <span class="filter-chip" :class="{ on: emptyResultOnly }" :title="emptyResultHint"
                        @click="emptyResultOnly = !emptyResultOnly">{{ en() ? 'Empty' : '为空' }}</span>
                </div>
                <div class="filter-row">
                  <span class="filter-row-label">{{ en() ? 'Rows' : '行号' }}</span>
                  <input class="filter-input" :class="{ 'input-invalid': rowRangeInvalid.length > 0 }" v-model="rowRangeInput"
                         style="flex:1;min-width:0" :disabled="isLoading"
                         :placeholder="rowRangePlaceholder" :title="rowRangeTitle" />
                </div>
                <!-- 源表增量（重读表格发现变化后才出现）：只看新增行 / 源数据改过的行 -->
                <div v-if="sourceDeltaTotal" class="filter-row">
                  <span class="filter-row-label">{{ en() ? 'Delta' : '增量' }}</span>
                  <select class="filter-input" v-model="deltaFilter" style="flex:1;min-width:0" :disabled="isLoading"
                          :title="deltaFilterHint" aria-label="源表增量筛选 / Source delta">
                    <option value="">{{ en() ? 'All rows' : '全部行' }}</option>
                    <option value="added">{{ en() ? `New rows (${sourceDelta.added})` : `新增行（${sourceDelta.added}）` }}</option>
                    <option value="modified">{{ en() ? `Changed rows (${sourceDelta.changed})` : `已变更行（${sourceDelta.changed}）` }}</option>
                  </select>
                </div>
                <div class="filter-row">
                  <span class="filter-row-label">{{ en() ? 'Steps' : '步数' }}</span>
                  <input class="filter-input" :class="{ 'input-invalid': stepsInputInvalid }" v-model="stepsInput"
                         style="flex:1;min-width:0" :disabled="isLoading"
                         :placeholder="en() ? 'steps' : '步数'" :title="stepsFilterHint" />
                </div>
                <div class="filter-row">
                  <span class="filter-row-label">{{ en() ? 'Took' : '耗时' }}</span>
                  <select class="filter-op-select" v-model="durOp" :disabled="isLoading" :title="durFilterHint"
                          aria-label="耗时比较方式 / Duration comparison">
                    <option v-for="(lb, opKey) in CMP_OP_LABEL" :key="opKey" :value="opKey">{{ lb }}</option>
                  </select>
                  <input class="filter-input" :class="{ 'input-invalid': durInputInvalid }" v-model="durInput"
                         style="flex:1;min-width:0" :disabled="isLoading"
                         :placeholder="durPlaceholder" :title="durFilterHint" />
                </div>
              </div>
              <!-- 命中统计：条件一改立即可见 -->
              <div class="filter-panel-count">
                <i class="fa fa-crosshairs"></i>
                <b>{{ en() ? `Matched ${tableFilteredRows.length} / ${rows.length} row(s)` : `命中 ${tableFilteredRows.length} / ${rows.length} 行` }}</b>
                <span v-if="markExcludedHint" class="filter-panel-note">{{ markExcludedHint }}</span>
              </div>
              <div class="filter-panel-tags">
                <span v-for="t in activeFilterTags" :key="t" class="filter-tag">{{ t }}</span>
                <span v-if="!activeFilterTags.length" class="filter-tag empty">{{ en() ? 'No condition — all rows match' : '未设条件 —— 全部行命中' }}</span>
              </div>
              <!-- 批量标记：只改状态、不动结果；「待处理」= 待执行（下次启动跑），重跑 = 标记待处理并立即执行 -->
              <div class="filter-panel-mark">
                <div class="filter-mark-title">{{ en() ? 'Mark matched rows as' : '把命中行标记为' }}</div>
                <div class="filter-mark-btns">
                  <span v-for="opt in markStatusOptions" :key="opt.value" class="detail-edit-btn" :title="opt.hint"
                        @click="markFilteredRows(opt.value)">{{ opt.label }}</span>
                </div>
                <div class="filter-mark-hint">{{ markHint }}</div>
                <!-- 重跑：直接拿当前筛选命中行——运行中加入优先队列立即执行；未运行则标记待处理并启动 -->
                <div class="filter-mark-btns">
                  <span class="detail-edit-btn primary" :title="rerunHint" @click="rerunFilteredRows">
                    <i class="fa fa-refresh"></i> {{ en() ? 'Rerun matched rows' : '重跑命中行' }}
                  </span>
                </div>
              </div>
            </div>
          </Teleport>

          <div class="toolbar-spacer"></div>
          <!-- 源表增量：新增 / 变更 / 移除 各多少；点「新增」「变更」直接在下方表格里筛选（再点取消），✕ 只关提示 -->
          <span v-if="activeTab === 'rows' && (sourceDeltaTotal || sourceDelta.reason)" class="source-delta-chip"
                :class="{ muted: !sourceDeltaTotal }" :title="sourceDeltaHint">
            <i class="fa fa-exchange"></i>
            <template v-if="sourceDeltaTotal">
              <span class="delta-seg added" :class="{ on: deltaFilter === 'added', off: !sourceDelta.added }"
                    :title="en() ? 'Show only the rows added to the source table (click again to clear)' : '只看源表新增的行（再点一次取消筛选）'"
                    @click.stop="sourceDelta.added && toggleDeltaFilter('added')">
                {{ en() ? `new ${sourceDelta.added}` : `新增 ${sourceDelta.added}` }}
              </span>
              <span class="delta-seg modified" :class="{ on: deltaFilter === 'modified', off: !sourceDelta.changed }"
                    :title="en() ? 'Show only the rows whose source data changed (click again to clear)' : '只看源数据改过的行（再点一次取消筛选）'"
                    @click.stop="sourceDelta.changed && toggleDeltaFilter('modified')">
                {{ en() ? `changed ${sourceDelta.changed}` : `变更 ${sourceDelta.changed}` }}
              </span>
              <span class="delta-seg removed" :class="{ off: !sourceDelta.removed, clickable: !!removedResultCount }"
                    :title="removedResultCount ? (en() ? 'Click to open the Results tab filtered to the “removed” results' : '点一下直接到「结果」页并只看「已移除」的结果') : (sourceDeltaCleaned ? (en() ? `Rows deleted from the source — their ${sourceDeltaCleaned} result(s) were deleted automatically` : `已从源表删除的行——它们的结果已自动删除（共 ${sourceDeltaCleaned} 条）`) : (en() ? 'Rows removed from the source are no longer in the table' : '已被删除的源行已不在表格里'))"
                    @click.stop="sourceDelta.removed && openRemovedResults()">
                {{ en() ? `removed ${sourceDelta.removed}` : `移除 ${sourceDelta.removed}` }}
              </span>
            </template>
            <template v-else>{{ en() ? 'Source not comparable' : '源表不可比（已按行号）' }}</template>
            <i class="fa fa-times source-delta-x" :title="en() ? 'Hide this hint' : '知道了（只关提示）'" @click.stop="resetSourceDelta"></i>
          </span>
          <!-- 同步源表：任务已开着时在 Excel 里改了行 → 点一下重读源表并按指纹把结果对回去（不用重开任务） -->
          <div v-if="activeTab === 'rows' && canSyncSource" class="button source-sync-btn" :class="{ accent: !!(sourceDeltaTotal || sourceDelta.reason) }"
               style="margin:0px;padding:3px 10px" @click="syncSourceRows" :disabled="isRunning || isLoading" :title="syncSourceTitle">
            <i class="fa fa-refresh"></i> {{ en() ? 'Sync source' : '同步源表' }}
          </div>
          <!-- 同步结果：按当前任务行重建结果（数量与数据都对上，清掉归属不明的残留） -->
          <div v-if="activeTab === 'rows'" class="button source-sync-btn" :class="{ accent: !!resultMismatchNote }"
               style="margin:0px;padding:3px 10px" @click="syncResultsToRows" :disabled="isRunning || isLoading || (rows.length === 0 && datasetRows.length === 0 && !removedRows.length)" :title="syncResultsTitle">
            <i class="fa fa-crosshairs"></i> {{ en() ? 'Sync results' : '同步结果' }}
          </div>
          <!-- 右侧按钮：仅保留行页专属动作（导入表格 / 重置 已在「任务」页输入面板与操作栏，不重复） -->
          <div v-if="activeTab === 'rows' && isRunning" class="button danger" style="margin:0px;padding:3px 10px" @click="stopBatch"
               :title="stopButtonTitle"><i class="fa fa-stop"></i> {{ en() ? 'Stop' : '停止' }}</div>
          <div v-if="activeTab === 'results'" class="button" style="margin:0px;padding:3px 10px" @click="clearResults" :disabled="isRunning || isLoading || (rows.length === 0 && datasetRows.length === 0)"
               :title="en() ? 'Clear results only (rows & settings stay): per-row result / status / tokens / timings / process snapshots, plus the extracted dataset' : '只清除结果（任务行与配置保留）：每行结果 / 状态 / Token / 计时 / 过程快照，以及结构化提取的数据表'">
            <i class="fa fa-eraser"></i> {{ en() ? 'Clear results' : '清除结果' }}
          </div>
          <div v-if="activeTab === 'results'" class="button" :class="{ accent: !!resultMismatchNote }" style="margin:0px;padding:3px 10px"
               @click="syncResultsToRows" :disabled="isRunning || isLoading || (rows.length === 0 && datasetRows.length === 0 && !removedRows.length)" :title="syncResultsTitle">
            <i class="fa fa-crosshairs"></i> {{ en() ? 'Sync results' : '同步结果' }}
          </div>
          <div v-if="activeTab === 'results'" class="button" style="margin:0px;padding:3px 10px" @click="exportData" :disabled="isRunning || isLoading || exporting || (rows.length === 0 && datasetRows.length === 0)"
               :title="en() ? 'Export to Excel — exactly the preview above (configure columns under Output → Export columns); big tables are exported in chunks with progress in the status bar' : '导出 Excel——与上方预览完全一致（列在「输出 → 导出列」配置）；大表会分片导出并在状态栏显示进度'">
            <i class="fa" :class="exporting ? 'fa-spinner fa-spin' : 'fa-download'"></i> {{ exporting ? (en() ? 'Exporting…' : '导出中…') : (en() ? 'Export Excel' : '导出 Excel') }}
          </div>
        </div>
        <div class="files-layout">
          <!-- 子任务表：每行一个子任务（状态/时间/步数/Token/错误；点行看详情） -->
          <div v-if="activeTab === 'rows'" ref="tableWrapRef" class="files-table-wrap scoll" @scroll="onTableScroll">
            <!-- 上方占位：窗口之前被跳过的行只用一个高度顶开（不渲染 DOM）→ 跳转大表（10w+ 行）也能秒开；
                 向上滚动时再逐步把前面的行补进来 -->
            <div v-if="hasPrevTableRows" class="table-top-spacer" :style="{ height: topSpacerHeight + 'px' }"></div>
            <table class="data-table">
              <thead><tr>
                <th style="width:56px;text-align:center;" :title="en() ? 'Original row number (1-based, unaffected by filtering)' : '原始顺序号（从 1 起，不受筛选/跳转影响）'">#</th>
                <th v-if="titleColumn" style="min-width:110px;" :title="en() ? 'Row title field (switch under Run → Row title)' : '行标题字段（在「执行 → 详情标题」中切换）'">{{ titleColumn }}</th>
                <template v-if="detailColumns.length">
                  <th v-for="c in detailColumns" :key="c.name" style="min-width:110px;" :title="c.name">{{ c.name }}</th>
                </template>
                <th v-else style="text-align:center;" :style="{ minWidth: '120px' }">{{ config.resultField || roundResultRefName() }}</th>
                <!-- 运行元信息列（对齐旧批量智能体运行时可看到的字段） -->
                <th style="width:92px;text-align:center;" :title="en() ? 'Start time' : '开始时间'">{{ en() ? 'Start' : '开始' }}</th>
                <th style="width:92px;text-align:center;" :title="en() ? 'Finish time' : '结束时间'">{{ en() ? 'End' : '结束' }}</th>
                <th style="width:70px;text-align:center;" :title="en() ? 'Duration (start → finish)' : '耗时（开始 → 结束）'">{{ en() ? 'Took' : '耗时' }}</th>
                <th style="width:56px;text-align:center;" :title="en() ? 'Reasoning steps of this run (kept in memory after finishing)' : '本轮推理步骤数（结束后仅存内存）'">{{ en() ? 'Steps' : '步数' }}</th>
                <th style="width:110px;text-align:center;" :title="en() ? 'Input / output tokens of this row' : '该行的输入 / 输出 Token'">{{ en() ? 'Tokens' : 'Token' }}</th>
                <th style="width:140px;" :title="en() ? 'Last error (hover for full text)' : '最后一次错误（悬停看全文）'">{{ en() ? 'Error' : '错误' }}</th>
                <th style="width:76px;text-align:center;">{{ en() ? 'Ops' : '操作' }}</th>
              </tr></thead>
              <tbody>
                <tr v-if="hasPrevTableRows" class="load-more-row">
                  <td :colspan="(titleColumn ? 1 : 0) + 8 + detailColumnCount" class="load-more-hint" @click="loadPrevRows()"
                      :title="en() ? 'Click to load earlier rows' : '点击加载前面的行'">
                    <i class="fa fa-arrow-up"></i>
                    {{ en() ? `Scroll up / click to load earlier rows (${hiddenAboveCount} above)` : `向上滚动或点击加载前面的行（上方还有 ${hiddenAboveCount} 行）` }}
                  </td>
                </tr>
                <tr v-for="row in visibleTableRows" :key="row.id" :data-batch-row="row.id"
                    :class="{ 'row-selected': selectedRowId === row.id, 'row-running': row.status === 'running' }"
                    @mousedown="onRowMouseDown"
                    @click="onRowClick(row.id, $event)">
                  <td style="text-align:center;">{{ rowNo(row) }}</td>
                  <td v-if="titleColumn" class="cell-wrap" :title="String(row.data[titleColumn] ?? '')">{{ row.data[titleColumn] ?? '' }}</td>
                  <template v-if="detailColumns.length">
                    <td v-for="c in detailColumns" :key="c.name" class="cell-wrap" :title="c.value(row)">
                      <div class="clamp-3">{{ c.value(row) }}</div>
                    </td>
                  </template>
                  <td v-else class="cell-wrap result-cell" :title="row.result"><div class="clamp-3">{{ row.result || '' }}</div></td>
                  <td class="cell-nowrap" :title="fmtRowTime(row.startedAt)">{{ fmtRowTime(row.startedAt) || '—' }}</td>
                  <td class="cell-nowrap" :title="fmtRowTime(row.finishedAt)">{{ fmtRowTime(row.finishedAt) || '—' }}</td>
                  <td class="cell-nowrap" :title="fmtRowDuration(row)">{{ fmtRowDuration(row) || '—' }}</td>
                  <td style="text-align:center;" :title="row.trace ? (en() ? 'Steps kept: ' + row.trace.length : '过程快照保留 ' + row.trace.length + ' 步') : ''">{{ rowStepsText(row) || '—' }}</td>
                  <td class="cell-nowrap" :title="rowTokensText(row)">{{ rowTokensText(row) || '—' }}</td>
                  <td class="cell-wrap" :title="row.error || ''"><div class="clamp-3">{{ row.error || '' }}</div></td>
                  <td style="text-align:center;">
                    <!-- 只显示状态文字（不要任何样式）；改状态 / 停止 / 重跑 / 删除都在行详情面板里 -->
                    <span :title="rowStatusTitle(row)">{{ statusLabel(row.status) }}</span>
                    <!-- 源表增量角标（重读表格发现新增 / 源数据改动时出现） -->
                    <span v-if="row.delta" class="row-delta-badge" :class="row.delta" :title="deltaTitle(row.delta)">{{ deltaLabel(row.delta) }}</span>
                  </td>
                </tr>
                <tr v-if="hasMoreTableRows" class="load-more-row">
                  <td :colspan="(titleColumn ? 1 : 0) + 9" class="load-more-hint" @click="loadMoreRows()" :title="en() ? 'Click or scroll to load more' : '点击或下滑加载更多'">
                    <i class="fa fa-arrow-down"></i>
                    {{ en() ? `Click / scroll to load more (${tableFilteredRows.length - windowEnd} left)` : `点击或下滑加载更多（剩余 ${tableFilteredRows.length - windowEnd} 项）` }}
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-if="rows.length === 0" class="empty-hint">
              <i class="fa fa-list-alt"></i>
              <span>{{ rowsEmptyHint }}</span>
            </div>
            <div v-else-if="filteredRows.length === 0" class="empty-hint"><i class="fa fa-filter"></i><span>{{ en() ? 'No rows match the filter' : '没有匹配筛选条件的行' }}</span></div>
          </div>

          <!-- 结果页：导出预览——列与「输出 → 导出列」完全一致（所见即所导）；渐进式加载 + 搜索 / 列筛选 / 行号跳转 -->
          <div v-else-if="activeTab === 'results'" ref="resultWrapRef" class="files-table-wrap scoll" @scroll="onResultScroll">
            <table v-if="resultColumns.length" class="data-table">
              <thead><tr>
                <th style="width:56px;text-align:center;">#</th>
                <!-- 结果 → 任务行：点行号跳到「详情」页的对应任务行（结果与任务永远能对上） -->
                <th style="width:84px;text-align:center;" :title="resultTaskRowTitle">{{ en() ? 'Task row' : '任务行' }}</th>
                <th v-for="c in resultColumns" :key="c" :title="resultColumnTitle(c)" style="min-width:110px;">{{ c }}</th>
                <th style="width:40px;text-align:center;" :title="deleteResultTitle"></th>
              </tr></thead>
              <tbody>
                <tr v-for="r in resultVisibleRows" :key="r.no" :data-result-row="r.no" :class="{ 'row-selected': resultHighlightIndex === r.no - 1 }">
                  <td style="text-align:center;">{{ r.no }}</td>
                  <td style="text-align:center;">
                    <span v-if="resultTaskRow(r).removed" class="result-row-removed" :title="resultRemovedHint">{{ en() ? 'removed' : '已移除' }}</span>
                    <span v-else-if="resultTaskRow(r).no" class="result-row-link" @click.stop="jumpToTaskRow(resultTaskRow(r).no)"
                          :title="en() ? `Open task row #${resultTaskRow(r).no} in the Details tab` : `在「详情」页打开第 ${resultTaskRow(r).no} 行并高亮`">#{{ resultTaskRow(r).no }}</span>
                    <span v-else class="idle-text">—</span>
                  </td>
                  <td v-for="c in resultColumns" :key="c" class="cell-wrap" :title="r.data[c]"><div class="clamp-3">{{ r.data[c] }}</div></td>
                  <!-- 只删这一条结果（图标，最右列） -->
                  <td style="text-align:center;">
                    <span class="action-icon danger" :title="deleteResultTitle" @click.stop="deleteResultRow(r)"><i class="fa fa-trash"></i></span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="empty-hint">
              <i class="fa fa-table"></i>
              <span>{{ resultEmptyHint }}</span>
            </div>
            <!-- 有筛选但命中 0 行 -->
            <div v-if="resultColumns.length && resultHitCount === 0" class="empty-hint">
              <i class="fa fa-filter"></i>
              <span>{{ en() ? 'No rows match the search / filter' : '没有匹配搜索 / 筛选条件的行' }}</span>
            </div>
            <!-- 渐进式加载：滚动到底自动加载，也可点击 -->
            <div v-else-if="canLoadMoreResults" class="table-preview-hint" style="cursor:pointer" @click="loadMoreResults"
                 :title="en() ? 'Click or scroll to load more' : '点击或下滑加载更多'">
              <i class="fa fa-arrow-down"></i>
              {{ en()
                ? `Loaded ${resultVisibleRows.length} / ${resultShownTotal} row(s) — click or scroll to load more`
                : `已加载 ${resultVisibleRows.length} / ${resultShownTotal} 行 —— 点击或下滑继续加载` }}
            </div>
            <div v-else-if="resultColumns.length" class="table-preview-hint">
              <i class="fa fa-info-circle"></i>
              {{ en()
                ? (resultHasFilter
                  ? `${resultHitCount} of ${resultGrandTotal} row(s) match — export writes ALL rows (unfiltered).`
                  : `All ${resultGrandTotal} row(s) shown — export matches the preview.${resultCountBreakdown}`)
                : (resultHasFilter
                  ? `命中 ${resultHitCount} / ${resultGrandTotal} 行——导出始终写全部行（不受搜索 / 筛选影响）。`
                  : `已全部显示（共 ${resultGrandTotal} 行）——导出与预览一致。${resultCountBreakdown}`) }}
            </div>
          </div>

          <!-- 图谱页：轨迹投影（爬取轨迹 / 访问路径，取决于视图下拉；智能体任务自动落在访问路径） -->
          <div v-else class="graph-view-wrap">
            <div class="graph-hint">
              <select v-model="graphMode" @change="graphModePinned = true" class="graph-mode-select" :title="en() ? 'Graph view: crawl trajectory (pages) or access paths (agent → visited sources / MCP services)' : '图谱视图：爬取轨迹（页面之间谁发现谁）或访问路径（智能体 → 访问过的信源 / MCP 服务）'">
                <option value="crawl">{{ en() ? 'Crawl' : '爬取轨迹' }}</option>
                <option value="rowAccess">{{ en() ? 'Access (row)' : '访问路径（行）' }}</option>
                <option value="allAccess">{{ en() ? 'Access (all)' : '访问路径（全部）' }}</option>
              </select>
              <!-- 节点上限：文字改由 title 展示，输入框与左侧下拉等高 -->
              <label class="graph-max-nodes" :title="graphMaxNodesTitle">
                <input v-model.number="graphMaxNodes" type="number" min="50" max="100000" step="100"
                       aria-label="节点上限 / Max nodes" :title="graphMaxNodesTitle" />
              </label>
              <!-- 图例 = 筛选器：单击圆点隐藏 / 恢复该类型（彩色圆圈代替大段文字） -->
              <span class="graph-legend">
                <span v-for="it in legendItems" :key="it.key"
                      class="legend-item" :class="{ off: graphHidden.includes(it.key), muted: !legendCounts[it.key] }"
                      :title="legendTitle(it)" @click="toggleLegend(it.key)">
                  <i class="legend-dot" :style="{ background: GRAPH_NODE_COLORS[it.color] }"></i>{{ en() ? it.en : it.zh }}
                </span>
              </span>
              <span class="graph-hint-tail">{{ graphTailText }}</span>
            </div>
            <div class="graph-canvas">
              <KnowledgeGraphViewer :graphData="graphViewFiltered" />
              <!-- 空态说明：图谱是投影，没数据时告诉用户为什么 / 怎么看 -->
              <div v-if="!graphViewFiltered.nodes.length" class="graph-empty">
                <i class="fa fa-sitemap"></i>
                <span>{{ graphEmptyText }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>

    <!-- 底部状态栏（左：运行状态 + 保存反馈 + 各状态彩色圆点统计；右：Token / 耗时 / 自动保存 / 筛选计数；始终显示在所有标签页下方） -->
    <div class="batch-status-panel">
      <!-- 最左：运行状态（运行中转圈 + 状态文字，如「执行中…」）——运行状态只在这里显示 -->
      <i v-if="isRunning || tableLoading" class="fa fa-spinner fa-spin batch-status-spin"></i>
      <span class="batch-status-text" :title="statusText">{{ statusText }}</span>
      <!-- 保存反馈（保存中 / 已保存 / 保存失败）——几秒后自动消失 -->
      <span v-if="statusHint.text" class="batch-status-item batch-status-hint" :class="statusHint.kind" :title="statusHintTitle">
        <i :class="statusHint.icon"></i> {{ statusHint.text }}
      </span>
      <!-- 逐状态统计（待处理 / 执行中 / 已完成 / 失败 / 跳过）；鼠标悬停「圆点+数量」整组显示状态名与数量 -->
      <span v-if="rows.length" class="batch-status-item batch-status-dots">
        <span class="stat-item" :title="(en() ? 'Pending' : '待处理') + ': ' + pendingRows"><span class="stat-dot pending-dot"></span>{{ pendingRows }}</span>
        <span class="stat-item" :title="(en() ? 'Running' : '执行中') + ': ' + runningRows"><span class="stat-dot running-dot"></span>{{ runningRows }}</span>
        <span class="stat-item" :title="(en() ? 'Completed' : '已完成') + ': ' + completedRows"><span class="stat-dot completed-dot"></span>{{ completedRows }}</span>
        <span class="stat-item" :title="(en() ? 'Failed' : '失败') + ': ' + failedRows"><span class="stat-dot failed-dot"></span>{{ failedRows }}</span>
        <span class="stat-item" :title="(en() ? 'Skipped' : '跳过') + ': ' + skippedRows"><span class="stat-dot skipped-dot"></span>{{ skippedRows }}</span>
      </span>
      <div style="flex:1"></div>
      <!-- 右侧：运行信息（Token / 耗时 / 自动保存 / 筛选计数）——
           运行状态已在最左侧显示、成功·失败·待处理·跳过·执行中的数量看最左侧圆点，这里不重复 -->
      <template v-if="tokenInfo.totalTokens > 0 || elapsedDisplay !== '00:00' || isRunning">
        <span class="batch-status-sep"></span>
        <span class="batch-status-item" v-if="tokenInfo.totalTokens > 0">
          <i class="fa fa-flask"></i> ↑{{formatTokenCount(tokenInfo.inputTokens)}} ↓{{formatTokenCount(tokenInfo.outputTokens)}} {{ en() ? 'total' : '共' }}{{formatTokenCount(tokenInfo.totalTokens)}}
        </span>
        <span class="batch-status-item">
          <i class="fa fa-clock-o"></i> {{ elapsedDisplay }}<span v-if="etaDisplay" style="color:#4CAF50;">&nbsp;~{{ etaDisplay }} {{ en() ? 'left' : '剩余' }}</span>
        </span>
      </template>
      <!-- 下次自动保存（原在执行设置里，已移到状态栏） -->
      <span v-if="autoSaveEnabled" class="batch-status-item" :title="autoSaveTitle">
        <i class="fa fa-floppy-o"></i> {{ en() ? 'Auto-save' : '自动保存' }}: {{ autoSaveHint }}
      </span>
      <span v-if="rows.length && rowRangeInput.trim()" class="batch-status-item" :title="rowRangeTitle">
        <i class="fa fa-list-ol"></i> {{ en() ? 'Row range' : '行号范围' }}: {{ tableFilteredRows.length }}/{{ rows.length }}
      </span>
      <span v-if="rows.length && stepsFilterActive" class="batch-status-item" :title="stepsFilterHint">
        <i class="fa fa-list-ol"></i> {{ en() ? 'Steps' : '步数' }} {{ stepsOpLabel }} {{ stepsInput.trim() }}: {{ tableFilteredRows.length }}/{{ rows.length }}
      </span>
      <span v-if="rows.length && durFilterActive" class="batch-status-item" :title="durFilterHint">
        <i class="fa fa-clock-o"></i> {{ en() ? 'Took' : '耗时' }} {{ durOpLabel }} {{ durInput.trim() }}: {{ tableFilteredRows.length }}/{{ rows.length }}
      </span>
      <span v-if="rows.length && debouncedResultKw.trim()" class="batch-status-item">
        <i class="fa fa-filter"></i> {{ en() ? 'Result filter' : '结果筛选' }}: {{ tableFilteredRows.length }}/{{ rows.length }}
      </span>
      <span v-if="rows.length && filteredRows.length !== rows.length" class="batch-status-item">
        <i class="fa fa-filter"></i> {{ en() ? 'Showing' : '显示' }} {{ filteredRows.length }}/{{ rows.length }}
      </span>
    </div>

    <!-- 行详情模态框（点击表格行弹出） -->
    <div v-if="showRowDetail" class="modal-overlay" @mousedown="onModalMouseDown" @click.self="onOverlayClick">
      <div class="modal-content row-detail-modal">
        <template v-if="selectedRow">
        <div class="modal-header">
          <h3 class="row-detail-title">
            <span :title="rowTitle(selectedRow)">{{ rowTitle(selectedRow) }}</span>
            <span class="status-tag" :class="selectedRow.status" :title="rowStatusTitle(selectedRow)"><i :class="statusIcon(selectedRow.status)"></i></span>
            <span v-if="selectedRow.status === 'running'" class="thinking-status"><i class="fa fa-cogs fa-spin"></i> {{ en() ? 'Running' : '执行中' }}</span>
          </h3>
          <button class="modal-close" @click="closeRowDetail"><i class="fa fa-times"></i></button>
        </div>
        <div class="modal-body row-detail-body">
          <!-- 详情头部：左＝页签（任务 / 过程 / 输出）；右＝ 5 个运行计数（开始 / 结束 / 耗时 / 步数 / Token）
               页签对应的操作（复制 / 编辑等）在底部按钮栏，与状态选择、删除、关闭同一行 -->
          <div class="detail-head-row">
            <div class="detail-tabs">
              <button v-for="t in DETAIL_TABS" :key="t.key" class="detail-tab" :class="{ active: detailTab === t.key }"
                      :title="en() ? t.hintEn : t.hintZh" @click="detailTab = t.key">
                <i class="fa" :class="t.icon"></i> {{ en() ? t.en : t.zh }}
              </button>
            </div>
            <!-- 右侧计数（仅本行；Token 为输入↑ / 输出↓） -->
            <div class="detail-counts">
              <span :title="en() ? 'Start time' : '开始时间'"><i class="fa fa-play-circle"></i>{{ fmtRowTime(selectedRow.startedAt) || '—' }}</span>
              <span :title="en() ? 'Finish time' : '结束时间'"><i class="fa fa-flag-checkered"></i>{{ fmtRowTime(selectedRow.finishedAt) || '—' }}</span>
              <span :title="en() ? 'Duration (start → finish)' : '耗时（开始 → 结束）'"><i class="fa fa-clock-o"></i>{{ fmtRowDuration(selectedRow) || '—' }}</span>
              <span :title="en() ? 'Reasoning steps of this run' : '本轮推理步骤数'"><i class="fa fa-list-ol"></i>{{ rowStepsText(selectedRow) || '—' }}</span>
              <span :title="en() ? 'Input / output tokens' : '输入 / 输出 Token'"><i class="fa fa-flask"></i>{{ rowTokensText(selectedRow) || '—' }}</span>
              <span v-if="selectedRow.retryCount || selectedRow.emptyRetryCount" :title="en() ? 'Retries / empty reruns' : '失败重试 / 空内容重跑'"><i class="fa fa-repeat"></i>{{ selectedRow.retryCount }} / {{ selectedRow.emptyRetryCount }}</span>
            </div>
          </div>

          <!-- 页签 1：任务（占位符替换后的实际任务） -->
          <div v-show="detailTab === 'task'" class="detail-section detail-input">
            <pre class="detail-input-pre scoll">{{ renderRowPrompt(selectedRow, selectedRowIndex) }}</pre>
          </div>

          <!-- 页签 2：过程（步骤 / 推理 / 工具参数与结果）：运行中实时更新，完成后仍可回看（数据来自内存会话，重启/读取任务后不可用） -->
          <div v-show="detailTab === 'process'" class="detail-section detail-process-section">
            <div class="detail-process-body scoll">
              <!-- 运行中的联网搜索提示（活跃状态归「过程」） -->
              <div v-if="selectedRow.status === 'running' && live.webSearch.active" class="server-search-banner" :class="live.webSearch.phase">
                <i class="fa" :class="live.webSearch.phase === 'searching' ? 'fa-spinner fa-spin' : 'fa-globe'"></i>
                <template v-if="live.webSearch.phase === 'searching'">
                  <span v-if="live.webSearch.query" class="server-search-query">“{{ live.webSearch.query }}”</span>
                  <span>{{ en() ? 'Searching the web…' : '正在联网搜索…' }}</span>
                </template>
                <template v-else>
                  <span>{{ en() ? 'Web search done — found ' + live.webSearch.resultsCount + ' sources' : '联网搜索完成 — 搜到 ' + live.webSearch.resultsCount + ' 条链接' }}</span>
                </template>
              </div>
              <template v-if="live.steps.length">
                <div v-for="(step, si) in live.steps" :key="si" class="live-step">
                  <div class="live-step-head">{{ en() ? 'Step' : '步骤' }} {{ si + 1 }}</div>
                  <div v-if="step.reasoning" class="live-reasoning">💭 {{ step.reasoning }}</div>
                  <div v-if="step.content" class="live-content">{{ step.content }}</div>
                  <div v-for="tc in step.toolCalls" :key="tc.callId" class="live-tool-call" :class="tc.status">
                    <!-- 头部：图标 + 工具名 + 状态 + 展开箭头（与 home.vue 的 tool-box 同款） -->
                    <div class="live-tool-head" :title="toolCallPreview(tc) || tc.name" @click="toggleToolExpand(tc.callId)">
                      <i :class="toolStatusIcon(tc.status)"></i>
                      <b class="live-tool-name">{{ tc.name }}</b>
                      <span class="live-tool-state">{{ toolStateLabel(tc.status) }}</span>
                      <span class="live-tool-toggle" :class="{ expanded: expandedToolKeys.has(tc.callId) }">
                        <i class="fa fa-chevron-down"></i>
                      </span>
                    </div>
                    <!-- 折叠态：单行摘要（不换行、超出省略，点击展开） -->
                    <div v-if="!expandedToolKeys.has(tc.callId)" class="live-tool-preview" :title="toolCallPreview(tc) || tc.name"
                         @click="toggleToolExpand(tc.callId)">{{ toolCallPreview(tc) || '…' }}</div>
                    <!-- 展开态：参数 / 结果 -->
                    <template v-else>
                      <div v-if="tc.argsText" class="live-tool-block">
                        <div class="live-tool-label">{{ en() ? 'Arguments' : '参数' }}</div>
                        <pre class="live-tool-pre scoll">{{ tc.argsText }}</pre>
                      </div>
                      <div v-if="tc.resultText" class="live-tool-block">
                        <div class="live-tool-label">
                          {{ en() ? 'Result' : '结果' }}
                          <span v-if="tc.resultTruncated" class="live-tool-note">{{ en() ? '(truncated)' : '（已截断）' }}</span>
                        </div>
                        <pre class="live-tool-pre scoll">{{ tc.resultText }}</pre>
                      </div>
                    </template>
                  </div>
                </div>
              </template>
              <div v-else-if="selectedRow.status === 'running'" class="detail-process-missing">
                <i class="fa fa-cogs fa-spin"></i> {{ en() ? 'Waiting for the first step…' : '等待首个步骤…' }}
              </div>
              <div v-else-if="selectedRow.status === 'pending'" class="detail-process-missing">
                <i class="fa fa-hourglass-half"></i> {{ en() ? 'Not run yet — no process info' : '尚未运行，暂无过程信息' }}
              </div>
              <div v-else class="detail-process-missing">
                <i class="fa fa-info-circle"></i>
                <template v-if="rowStepsText(selectedRow)">
                  {{ en() ? `Process details are unavailable (session ended) — only the summary is kept (${rowStepsText(selectedRow)} steps).` : `过程信息已不可用（会话已结束，仅保留汇总：${rowStepsText(selectedRow)} 步）` }}
                </template>
                <template v-else>
                  {{ en() ? 'Process details are unavailable (session ended) — only the final result is kept.' : '过程信息已不可用（会话已结束，仅保留最终结果）' }}
                </template>
              </div>
            </div>
          </div>

          <!-- 页签 3：输出（提取数据 / 写回列 / 结果 / 错误；可编辑） -->
          <div v-show="detailTab === 'output'" class="detail-section detail-output">
            <div class="detail-output-body scoll">
              <template v-if="selectedRow.status === 'running'">
                <!-- 运行中：直接流式渲染渲染后的正文（不再显示 Markdown 源码） -->
                <div v-if="liveStreamMd" class="pv-md">
                  <BlockMd :content="liveStreamMd" :fontSize="'12px'" />
                </div>
                <div v-else class="detail-empty">{{ en() ? 'Waiting for output…' : '等待输出…' }}</div>
              </template>
              <div v-else-if="rowDetailEditing" class="detail-edit-area">
                <textarea ref="rowDetailEditorRef" v-model="rowDetailEditText" rows="12" class="detail-edit-textarea" :placeholder="detailEditPlaceholder" @input="autoResizeDetailEditor" @keydown.ctrl.enter.prevent="saveDetailEdit" @keydown.esc.prevent="cancelDetailEdit"></textarea>
              </div>
              <div v-else-if="detailExtractFields.length && selectedRow.extracted && selectedRow.extracted.length" class="detail-extracted">
                <div class="detail-extracted-title">
                  <i class="fa fa-table"></i>
                  {{ en() ? 'Extracted data' : '提取数据' }}（{{ selectedRow.extracted.length }}{{ en() ? ' records — editable as JSON below' : ' 条，可用下方「编辑」改 JSON' }}）
                </div>
                <table class="fields-table">
                  <thead><tr>
                    <th v-for="f in detailExtractFields" :key="f.name" :title="f.description || f.name">{{ f.name }}</th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="(rec, ri) in selectedRow.extracted" :key="ri">
                      <td v-for="f in detailExtractFields" :key="f.name" :title="String(rec[f.name] ?? '')">{{ rec[f.name] ?? '' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-else-if="isLlmMode && Object.keys(writeBackValueMap(selectedRow)).length" class="detail-extracted">
                <div class="detail-extracted-title">
                  <i class="fa fa-columns"></i>
                  {{ en() ? 'Written-back columns (editable as JSON)' : '写回原表的列（可用下方「编辑」改 JSON）' }}
                </div>
                <table class="fields-table">
                  <thead><tr>
                    <th style="width:26%;">{{ en() ? 'Column' : '列名' }}</th>
                    <th>{{ en() ? 'Value' : '值' }}</th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="(v, k) in writeBackValueMap(selectedRow)" :key="k">
                      <td>{{ k }}</td>
                      <td :title="v">{{ v }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-else-if="selectedRow.result" class="pv-md">
                <BlockMd :content="selectedRow.result" :fontSize="'12px'" />
              </div>
              <pre v-else-if="selectedRow.error" class="pv-pre pv-error">{{ '❌ ' + selectedRow.error }}</pre>
              <div v-else class="detail-empty">{{ en() ? 'No output yet' : '暂无输出' }}</div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <div class="detail-footer-left">
            <!-- 任务页签：复制替换后的任务 -->
            <button v-if="detailTab === 'task'" class="modal-btn" :title="en() ? 'Copy rendered prompt' : '复制替换后的任务'" @click="copyRenderedPrompt"><i class="fa fa-copy"></i> {{ en() ? 'Copy' : '复制' }}</button>
            <!-- 输出页签：编辑 / 保存 / 取消 -->
            <template v-else-if="detailTab === 'output' && selectedRow.status !== 'running'">
              <button v-if="!rowDetailEditing" class="modal-btn" :title="detailEditTitle" @click="startDetailEdit"><i class="fa fa-pencil"></i> {{ en() ? 'Edit' : '编辑' }}</button>
              <template v-else>
                <button class="modal-btn" :title="en() ? 'Save (Ctrl+Enter)' : '保存（Ctrl+Enter）'" @click="saveDetailEdit"><i class="fa fa-check"></i> {{ en() ? 'Save' : '保存' }}</button>
                <button class="modal-btn modal-btn-cancel" :title="en() ? 'Cancel (Esc)' : '取消（Esc）'" @click="cancelDetailEdit"><i class="fa fa-times"></i> {{ en() ? 'Cancel' : '取消' }}</button>
              </template>
            </template>
            <!-- 底部按钮栏顺序：状态选择 → 停止（仅执行中）→ 重跑（其他情况）→ 删除 -->
            <!-- 状态下拉：只改状态、结果不动（重跑 = 选「待处理」后回任务页启动；执行中的行不能改） -->
            <select class="detail-status-select" :value="selectedRow.status"
                    :disabled="selectedRow.status === 'running'" :title="detailStatusTitle"
                    @change="onRowStatusPick(selectedRow, $event)">
              <option v-for="opt in detailStatusOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
            <!-- 停止本行：只停这一行（取消它的会话 / 请求），不影响其它行与整批 -->
            <button v-if="canStopRowDetail" class="modal-btn modal-btn-stop" :title="stopRowDetailTitle" @click="stopRowFromDetail">
              <i class="fa fa-stop-circle"></i> {{ en() ? 'Stop' : '停止' }}
            </button>
            <!-- 重跑本行：非执行中显示（批量运行中 → 插到队首立即执行；未运行 → 置待处理并启动） -->
            <button v-else class="modal-btn" :title="rerunRowDetailTitle" @click="rerunRowFromDetail">
              <i class="fa fa-refresh"></i> {{ en() ? 'Rerun' : '重跑' }}
            </button>
            <button class="modal-btn danger" :title="en() ? 'Delete this row' : '删除该行'" @click="removeRow(selectedRow); closeRowDetail()"><i class="fa fa-times"></i> {{ en() ? 'Delete' : '删除' }}</button>
          </div>
          <button class="modal-btn modal-btn-cancel" @click="closeRowDetail">{{ en() ? 'Close' : '关闭' }}</button>
        </div>
        </template>
        <div v-else class="detail-empty" style="padding:24px;text-align:center;">{{ en() ? 'Row not found or deleted' : '该行不存在或已被删除' }}</div>
      </div>
    </div>

    <!-- 对比表单元格预览：用 block_md 渲染该轮该行的结果 -->
    <div v-if="comparePreview" class="modal-overlay" @click.self="comparePreview = null">
      <div class="modal-content compare-preview-modal">
        <div class="modal-header">
          <h3 class="row-detail-title">
            <span :title="comparePreview.title">{{ comparePreview.title }}</span>
            <span class="status-tag" style="background: transparent;color:var(--fontColor);border:1px solid var(--borderColor);">{{ comparePreview.round }}</span>
          </h3>
          <button class="modal-close" @click="comparePreview = null"><i class="fa fa-times"></i></button>
        </div>
        <div class="modal-body compare-preview-body scoll">
          <div class="pv-md">
            <BlockMd :content="comparePreview.content" :fontSize="'13px'" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn modal-btn-cancel" @click="comparePreview = null">{{ en() ? 'Close' : '关闭' }}</button>
        </div>
      </div>
    </div>

    <!-- 导入弹窗 -->
    <input type="file" ref="dataFileInput" accept=".xlsx,.xls,.csv" style="display:none" @change="handleDataFileImport" />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'PipelineScaffold' })
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { usestore } from '@/store'
import { reportInstanceRunning, reportInstanceProgress, reportInstanceState } from '@/store/runningTasks'
import { useTaskFileOpen } from '@/composables/useTaskFileOpen'
import { useInstanceTaskFile } from '@/composables/useInstanceTaskFile'
import {
  BatchAgent, MAX_CONCURRENCY, renderTemplate, extractPlaceholders, effectiveLlmType,
  type BatchRow, type BatchConfig, type BatchWorkerInfo, type BatchRowStatus,
} from '@/components/AgentScaffold/pipelineRunner'
import { agentBridge } from '@/platform/agentBridge'
import BlockMd from '@/components/block_md.vue'
import StatusMultiSelect from '@/components/AgentScaffold/StatusMultiSelect.vue'
import KnowledgeGraphViewer from '@/components/AgentScaffold/KnowledgeGraphViewer.vue'
import { buildCrawlGraph, buildAccessGraph, type PipelineGraph } from '@/components/AgentScaffold/graph'
import { normalizeUrl } from '@/components/AgentScaffold/fetch'
import { effectiveContentSource, migratePipelineConfig, resolveContentField, type PipelineUnit, type PipelineRound, type PipelineRoundSummary } from '@/components/AgentScaffold/types'
import { defaultPipelineConfig, pipelinePreset, PIPELINE_PRESETS } from '@/components/AgentScaffold/presets'
import { normalizeLegacyState } from '@/components/AgentScaffold/legacy'
import * as XLSX from 'xlsx'
import draggable from 'vuedraggable'
import { ElMessage, ElMessageBox } from 'element-plus'
import { createDragGuard } from '@/utils/clickGuard'
import { deepSeekApiStyle, normalizeLlmType } from '@/shared/llmSources'
import { AGENT_MAX_STEPS_MAX } from '@/shared/agent-loop-rounds'

const store = usestore()
const en = () => store.locales === 'en'

// ====== 实例上下文（由 AgentScaffold 传入：实例 id 用于运行态上报，taskFilePath 为关联任务文件） ======
const props = defineProps<{ externalTab?: string; instanceId?: string; taskFilePath?: string }>()
const emit = defineEmits<{
  'update:externalTab': [tab: string]
  /** 脚手架内部对话框选中文件后回传路径，供宿主写入实例 meta */
  'link-file': [path: string]
  /** 关联任务文件不可用（被移动/删除） */
  'file-missing': [path: string]
  /** 已保存到关联文件 */
  'file-saved': [path: string]
}>()

const internalTab = ref('task')
const activeTab = computed({
  get: () => props.externalTab || internalTab.value,
  set: (val: string) => {
    if (props.externalTab) emit('update:externalTab', val)
    else internalTab.value = val
  }
})

// ====== 任务配置 ======
// 初始值 = batch 预设默认值（presets.ts；字段与 Step 1 平移版逐字段一致，保证行为对等）
const config = reactive<BatchConfig>(defaultPipelineConfig('batch', !en()))
// 纯 LLM 执行器字段（可选）默认值；旧任务文件无这些字段时保证可用
// （注：旧「源列」sourceColumns / 旧「目标列」targetColumns 均已废弃——读旧任务时迁移）
if (!config.schema) config.schema = []
if (!config.extensions) config.extensions = ['.md', '.markdown', '.txt']
if (!config.maxContentPerFile) config.maxContentPerFile = 8000
// 分段结果汇总策略：默认「合并为一条记录」（一个文件最终只产出一条数据）
if (!config.segmentMerge) config.segmentMerge = 'one'
// 重跑结果策略：默认「替换该行原有结果」（重跑不会越跑越多）
if (!config.rerunResultMode) config.rerunResultMode = 'replace'
if (!config.maxFiles) config.maxFiles = 5000
// 文本源（每行一条）与抓取字段默认值
if (config.textInput === undefined) config.textInput = ''
if (config.textFieldName === undefined) config.textFieldName = 'text'
if (config.urlMaxDepth === undefined) config.urlMaxDepth = 1
if (!config.urlMaxPages) config.urlMaxPages = 50
if (!config.urlFollow) config.urlFollow = 'same-host'
if (!config.urlBody) config.urlBody = 'text'

// ====== 预设（旧脚手架 = 一组配置，一键套用） ======
/** 内置预设选项（batch / tabreason / file / collector） */
const presetOptions = computed(() => Object.values(PIPELINE_PRESETS).map(p => ({ key: p.key, label: en() ? p.labelEn : p.labelZh })))
/** 预设的“拓扑字段”：套用前先清掉，避免上一个预设的残留（如从链接采集切到文件夹仍带 contentSource=url） */
const PRESET_SHAPE_KEYS = ['contentSource', 'contentField', 'textFieldName']
/** 套用预设（运行中禁用）：重置“拓扑”（来源 / 执行 / 输出与参数），用户已写文本（模板 / 文本内容 / 目标）保留 */
const applyPreset = (key: string) => {
  if (isRunning.value) return
  if (!key) {
    config.preset = ''
    addLog('info', en() ? 'Custom configuration (no preset applied)' : '已切换为自定义配置（不套用预设）')
    return
  }
  const preset = pipelinePreset(key)
  if (!preset) return
  // 用户已写的文本保留（换预设不清空输入：任务指令 / 文本内容）
  const keep = { template: config.template, textInput: config.textInput }
  for (const k of PRESET_SHAPE_KEYS) delete (config as any)[k]
  Object.assign(config, defaultPipelineConfig(key, !en()))
  config.sourceKind = preset.source
  if (keep.template) config.template = keep.template
  if (keep.textInput) config.textInput = keep.textInput
  if (!config.textFieldName) config.textFieldName = 'text'
  if (!config.schema) config.schema = []
  addLog('info', `${en() ? 'Applied preset: ' : '已套用预设：'}${en() ? preset.labelEn : preset.labelZh}`)
  if (rows.value.length) {
    addLog('info', en() ? 'Existing rows kept — clear or re-create them if the new workflow expects different rows' : '已保留现有任务行——若新流程的行形态不同，请「清空」后重新生成')
  }
}
/** 预设下拉（v-model；'' = 自定义） */
const presetKey = computed({
  get: () => config.preset || '',
  set: (v: string) => applyPreset(v),
})

/** 「来源」：任务行的来源（表格 / 文件夹 / 文本）——与执行方式正交；切换时联动一个合理的执行方式 */
const sourceKind = computed({
  get: () => {
    const k = config.sourceKind
    return k === 'folder' ? 'folder' : (k === 'text' || k === 'urls') ? 'text' : 'table'
  },
  set: (v: string) => {
    config.sourceKind = v === 'folder' ? 'folder' : v === 'text' ? 'text' : 'table'
    config.preset = '' // 手动改维度 = 偏离预设 → 标记为自定义
    // 联动：切到文件夹时默认「纯 LLM 推理 + 结构化提取」（逐文件）；切回表格时若正停留在提取则回到「智能体 + 单独结果」
    if (v === 'folder' && config.executorKind !== 'extract') applyExecPair('llm', 'structured')
    if (v === 'table' && config.executorKind === 'extract') applyExecPair('agent', 'single')
    // 切入文本源时补齐默认值（老任务文件可能没有这些字段）
    if (v === 'text') {
      if (config.textInput === undefined) config.textInput = ''
      if (!config.textFieldName) config.textFieldName = 'text'
      if (!config.urlFollow) config.urlFollow = 'same-host'
      if (!config.urlBody) config.urlBody = 'text'
    }
  },
})
/** 是否文件夹来源 */
const isFolderSource = computed(() => sourceKind.value === 'folder')
/** 是否文本来源（每行一条：可粘贴网址 / 文件路径 / 任意文本） */
const isTextSource = computed(() => sourceKind.value === 'text')
/** 「内容获取」：素材来源（直接使用行数据 / 读字段中的文件 / 抓字段中的网页）；文件夹固定读本地文件 */
const contentSourceLocal = computed({
  get: () => effectiveContentSource(config),
  set: (v: string) => { config.contentSource = v === 'file' ? 'file' : v === 'url' ? 'url' : 'none'; config.preset = '' },
})

// ====== 执行方式 × 输出方式（两个正交维度） ======
// 执行方式（谁来做）：'agent' 智能体（带工具、多轮）/ 'llm' 纯 LLM 推理（无工具；单次或分段）
// 输出方式（写到哪）：'single' 单独结果（智能体→结果列；纯 LLM→逐列写回原表）/ 'structured' 结构化提取（按字段合并进数据表）
// 内部映射：extract 执行器 = 纯 LLM 推理的结构化分支（素材获取/分段/JSON 重试）；任务文件字段不变、无需迁移
type ExecMethod = 'agent' | 'llm'
type OutputMode = 'single' | 'structured'
/** 由（执行方式 × 输出方式）派生内部执行器与汇聚器 */
const applyExecPair = (method: ExecMethod, out: OutputMode) => {
  // 切换前把「导出列」的当前生效集合固化为显式配置：
  // 否则从「单独结果」（默认全选）切到「结构化提取」（默认不选）时，看上去就像导出列被清空了
  if (!Array.isArray(config.exportColumns)) config.exportColumns = exportCols.value.slice()
  if (!Array.isArray(config.exportMeta)) config.exportMeta = exportMetas.value.slice()
  config.preset = '' // 手动改维度 = 偏离预设 → 标记为自定义
  if (method === 'agent') {
    config.executorKind = 'agent'
    config.sinkKind = out === 'structured' ? 'dataRows' : 'resultColumn'
  } else {
    config.executorKind = out === 'structured' ? 'extract' : 'llm'
    config.sinkKind = out === 'structured' ? 'dataRows' : 'writeBack'
  }
}
/** 执行方式：智能体 / 纯 LLM 推理 */
const execMethod = computed({
  get: () => (((config.executorKind || 'agent') === 'agent' ? 'agent' : 'llm') as ExecMethod),
  set: (v: string) => applyExecPair(v as ExecMethod, outputMode.value),
})
/** 输出方式：单独结果 / 结构化提取 */
const outputMode = computed({
  get: () => (((config.sinkKind || 'resultColumn') === 'dataRows' ? 'structured' : 'single') as OutputMode),
  set: (v: string) => applyExecPair(execMethod.value, v as OutputMode),
})
/** 是否智能体执行（预设/模板/后端等智能体配置块） */
const isAgentMode = computed(() => execMethod.value === 'agent')
/** 纯 LLM + 单独结果（逐列写回原表；输出字段配置块） */
const isLlmMode = computed(() => execMethod.value === 'llm' && outputMode.value === 'single')
/** 纯 LLM + 结构化提取（写入数据表；任务目标/内容获取/分段配置块） */
const isExtractMode = computed(() => execMethod.value === 'llm' && outputMode.value === 'structured')
/** 智能体 + 结构化输出（智能体结尾输出 JSON → 数据表） */
const agentStructured = computed(() => isAgentMode.value && outputMode.value === 'structured')
/** 是否需要编辑「提取字段」（任一结构化输出） */
const needsSchema = computed(() => outputMode.value === 'structured')

/** 「输出方式」两种模型的区别说明（只用于下拉的 title 悬停提示，不占界面） */
const outputModeHint = computed(() => en()
  ? 'Where results go (click to switch).\nSingle result — the result stays on the row: agent writes the result column; pure LLM fills the Output fields and writes them back to new source-table columns (no merge / dedupe).\nStructured extraction — records are produced per Output fields and merged into the data table by primary key (several records per row possible) — file / link collection and legacy “Table Reasoning” tasks both use this.'
  : '结果的落点（点此切换）。\n单独结果——结果落在本行：智能体写入结果列；纯 LLM 按下方「输出字段」逐列推理并写回原表新列（不合并不去重）。\n结构化提取——按「输出字段」产出记录，按主键合并进数据表（一行可产出多条）——文件 / 链接采集与旧「表格定向推理」任务统一走这种。')

/** 内容获取提示（非结构化提取时不生效；智能体可自行访问，但有步数预算） */
const contentSourceHint = computed(() => en()
  ? '“Content” applies to Structured extraction only. In Agent mode the agent fetches by itself — e.g. write in the task instruction: visit {{url}} and extract … Its page budget is the Max Steps setting, so also state a visit cap in the instruction (e.g. "visit at most 3 pages").'
  : '「内容获取」仅在「结构化提取」下生效；智能体模式可自行访问——例如任务指令写「请访问 {{url}} 并提取 …」。它的预算就是「最大步数」，建议同时在指令里写明访问上限（如「最多访问 3 个页面」）。')

/** 结构化提取的提示文案（按内容获取类型自适应） */
const extractHintText = computed(() => {
  const src = contentSourceLocal.value
  if (src === 'url') return en()
    ? 'Crawl mode fetches each URL, stores page title & links as row fields, extracts per chunk and merges into the data table by primary key. The Graph tab projects rows into the crawl trajectory.'
    : '链接采集逐页抓取，页面标题与链接存为行字段；分段调用纯 LLM 提取，结果按主键合并到数据表。表格页「图谱」把行投影为爬取轨迹（节点=页面，边=谁发现谁）。'
  if (src === 'file') return en()
    ? 'Each row reads its file, calls pure LLM per chunk (follows the global backend) and merges results into the data table by primary key.'
    : '逐行读取文件、分段调用纯 LLM（跟随全局后端），结果按主键合并进数据表。'
  return en()
    ? 'Each row uses its data as material (single field → its value; multiple fields → "field: value" lines), calls pure LLM per chunk and merges into the data table by primary key.'
    : '每行直接以行数据为素材（单字段取其值；多字段拼成「字段: 值」行），分段调用纯 LLM，结果按主键合并进数据表。'
})

// LLM 后端选项：'' = 跟随全局设置；'agent' = 跟随智能体（预设）设置
const LLM_TYPES = [
  { value: '', labelZh: '跟随全局设置', labelEn: 'Follow global' },
  { value: 'agent', labelZh: '跟随智能体设置', labelEn: 'Follow agent preset' },
]

// ====== DeepSeek Responses 接口样式专项 ======
// 实际生效后端（'' = 跟随全局；'agent' = 跟随预设智能体，预设未配置则回退全局）——用于显示 DSR 提示横幅
const effectiveLlm = computed(() => effectiveLlmType(config, store))
/** 旧任务文件可能保存了显式后端 id（新 UI 已只留「跟随全局/跟随智能体」）——补一个选项避免下拉空白 */
const legacyLlmOption = computed(() => {
  const v = String(config.llmType || '').trim()
  if (!v || v === 'agent') return ''
  return en() ? `Explicit: ${v} (from saved task)` : `显式指定：${v}（来自已保存任务）`
})
// DeepSeek 单来源：Responses 样式由 deepseek.api_style 决定（历史 'deepseek-responses' 已归一）
const isDeepSeekResponses = computed(() => effectiveLlm.value === 'deepseek' && deepSeekApiStyle(store.AIconfig.llm) === 'responses')

const rows = ref<BatchRow[]>([])
const isRunning = ref(false)
// 后台运行登记（按实例 id，供导航栏状态点 / 关闭确认使用；独立使用时退回脚手架 key）
const instanceKey = computed(() => props.instanceId || 'pipeline')
watch(isRunning, (v) => reportInstanceRunning(instanceKey.value, v))
onBeforeUnmount(() => {
  reportInstanceRunning(instanceKey.value, false)
  reportInstanceState(instanceKey.value, null)
})
// 正在读取任务/表格文件（加载期间禁用保存/运行/导入/清空等按钮，避免并发冲突）
const isLoading = ref(false)
const statusText = ref(en() ? 'Ready' : '就绪')
const logs = ref<Array<{ seq: number; time: string; level: string; message: string; detail?: string; workerId?: number }>>([])

// ====== 线程槽位（日志二级 tab） ======
const workers = ref<BatchWorkerInfo[]>([])
/** 日志页签最多铺多少个（并发可以设到 500，不能让日志页签也铺 500 个） */
const LOG_TAB_MAX = 60
const workerSlots = computed(() => {
  const slots: Array<BatchWorkerInfo & { active: boolean }> = []
  const activeIds = new Set(workers.value.filter(w => w.rowTitle).map(w => w.id))
  // 只用过的线程（在跑 / 有日志）+ 补齐到并发数（页签数量上限 LOG_TAB_MAX）
  const used = new Map(workers.value.map(w => [w.id, w]))
  const usedIds = [...used.values()]
    .filter(w => activeIds.has(w.id) || (Array.isArray(w.logs) && w.logs.length))
    .map(w => w.id)
  const conc = Math.min(Math.max(1, config.concurrency, workers.value.length), LOG_TAB_MAX)
  const ids = new Set<number>(usedIds)
  for (let i = 0; ids.size < conc && i < conc; i++) ids.add(i)
  for (const id of [...ids].sort((a, b) => a - b)) {
    const w = used.get(id)
    slots.push(w ? { ...w, active: activeIds.has(id) } : { id, label: en() ? `Thread ${id + 1}` : `线程${id + 1}`, rowTitle: '', logs: [], rowCount: 0, active: false })
  }
  return slots
})
const logTab = ref<string>('main')
// 页签被收起（槽位不再出现）时回到主日志，避免停在空面板上
watch(workerSlots, (list) => {
  if (logTab.value !== 'main' && !list.some(s => 'w' + s.id === logTab.value)) logTab.value = 'main'
})
const currentWorker = computed(() => {
  if (logTab.value === 'main') return null
  const id = parseInt(logTab.value.slice(1), 10)
  return workerSlots.value.find(w => w.id === id) || null
})
const currentWorkerLogs = computed(() => currentWorker.value?.logs || [])

// ====== 显示筛选（任务页/行页指定显示哪些行） ======
// 状态筛选：**多选**（空数组 = 不筛状态，显示全部）；任务页「显示行」区与表格页工具栏共用同一状态
const displayStatus = ref<BatchRowStatus[]>([])
// 状态多选项（不含「全部」：不勾选即全部）
const statusOptions = computed(() => [
  { value: 'pending' as BatchRowStatus, label: en() ? 'Pending' : '待处理' },
  { value: 'running' as BatchRowStatus, label: en() ? 'Running' : '执行中' },
  { value: 'completed' as BatchRowStatus, label: en() ? 'Completed' : '已完成' },
  { value: 'failed' as BatchRowStatus, label: en() ? 'Failed' : '失败' },
  { value: 'skipped' as BatchRowStatus, label: en() ? 'Skipped' : '跳过' },
])
const statusFilterHint = computed(() => en()
  ? 'Status filter (multi-select): tick one or more statuses; nothing ticked = show all. Filtered rows can be rerun in bulk with "Rerun ▾".'
  : '状态筛选（多选）：可同时勾选多种状态，不勾选 = 显示全部；筛选出的行可用「重跑 ▾」批量重跑')
const displayKeyword = ref('')
// 搜索关键字防抖：避免 10w+ 行时每次击键都全量过滤
const debouncedKeyword = ref('')
let keywordTimer: ReturnType<typeof setTimeout> | null = null
watch(displayKeyword, (v) => {
  if (keywordTimer) clearTimeout(keywordTimer)
  keywordTimer = setTimeout(() => { debouncedKeyword.value = v }, 200)
})
// ====== 行号范围筛选（原始行号，1 起；支持多段） ======
// 语法：`1-100` 区间、`5000-` 从 5000 行起、`-200` 前 200 行、`3` 单行；多段用逗号/空格/分号分隔。
// 语义：与状态/关键字/结果筛选叠加（交集）；不填 = 不筛行号。行号始终是「原始顺序号」，
// 与 # 列、{{rowIndex}}、以及重跑选区里的行号完全一致。
const rowRangeInput = ref('')
const debouncedRowRange = ref('')
let rowRangeTimer: ReturnType<typeof setTimeout> | null = null
watch(rowRangeInput, (v) => {
  if (rowRangeTimer) clearTimeout(rowRangeTimer)
  rowRangeTimer = setTimeout(() => { debouncedRowRange.value = v }, 200)
})
/** 解析行号表达式 → 闭区间数组（右端 Infinity = 到最后一行）+ 无法解析的片段 */
const parseRowRanges = (input: string): { ranges: Array<[number, number]>; invalid: string[] } => {
  const ranges: Array<[number, number]> = []
  const invalid: string[] = []
  for (const raw of String(input || '').split(/[,，;；\s]+/)) {
    const t = raw.trim()
    if (!t) continue
    const m = /^(\d*)\s*[-~到]\s*(\d*)$/.exec(t)
    if (m) {
      const start = m[1] ? Math.max(1, parseInt(m[1], 10)) : 1
      const end = m[2] ? parseInt(m[2], 10) : Infinity
      if (end < start) { invalid.push(t); continue }
      ranges.push([start, end])
      continue
    }
    if (/^\d+$/.test(t)) {
      const n = parseInt(t, 10)
      if (n >= 1) { ranges.push([n, n]); continue }
    }
    invalid.push(t)
  }
  return { ranges, invalid }
}
const rowRangeParsed = computed(() => parseRowRanges(debouncedRowRange.value))
const rowRangeRanges = computed(() => rowRangeParsed.value.ranges)
const rowRangeInvalid = computed(() => rowRangeParsed.value.invalid)
const rowRangeActive = computed(() => rowRangeRanges.value.length > 0)
const inRowRanges = (rowNo: number, ranges: Array<[number, number]>): boolean => {
  for (const [s, e] of ranges) if (rowNo >= s && rowNo <= e) return true
  return false
}
const rowRangePlaceholder = computed(() => (en() ? 'rows: 1-100,5000-' : '行号: 1-100,5000-'))
const rowRangeHint = computed(() => en()
  ? 'Row-number filter (original 1-based numbers): "1-100" range, "5000-" from row 5000 on, "-200" first 200, "3" a single row; separate several with commas.'
  : '行号范围筛选（原始行号，从 1 起）：1-100 区间、5000- 从第 5000 行起、-200 前 200 行、3 单行；多段用逗号分隔')
const rowRangeTitle = computed(() => rowRangeInvalid.value.length
  ? `${rowRangeHint.value}\n${en() ? 'Ignored input' : '已忽略的无效片段'}: ${rowRangeInvalid.value.join(', ')}`
  : rowRangeHint.value)

// ====== 步数筛选（挑出推理步数不足的行 → 配合「重跑 → 当前筛选结果」补跑） ======
// 规则：未运行 / 无步数的行按 0 步计（「<」「≤」会包含它们，「= 0」可专门挑出还没跑过的行）
const CMP_OP_LABEL: Record<'lt' | 'le' | 'gt' | 'ge' | 'eq', string> = { lt: '<', le: '≤', gt: '>', ge: '≥', eq: '=' }
const stepsOp = ref<'lt' | 'le' | 'gt' | 'ge' | 'eq'>('lt')
const stepsInput = ref('')
/** 阈值（null = 未筛；NaN = 输入非法→不筛） */
const stepsThreshold = computed<number | null>(() => {
  const t = stepsInput.value.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
})
const stepsFilterActive = computed(() => { const v = stepsThreshold.value; return v !== null && !Number.isNaN(v) })
const stepsInputInvalid = computed(() => stepsInput.value.trim() !== '' && !stepsFilterActive.value)
const stepsOpLabel = computed(() => CMP_OP_LABEL[stepsOp.value] || '<')
/** 行的推理步数（stepsCount；缺省用过程快照长度，都没有 = 0） */
const rowStepsValue = (row: BatchRow): number => {
  const v = Number(row.stepsCount)
  if (Number.isFinite(v)) return v
  return Array.isArray(row.trace) ? row.trace.length : 0
}
const matchStepsFilter = (row: BatchRow): boolean => {
  const t = stepsThreshold.value
  if (t === null || Number.isNaN(t)) return true
  const v = rowStepsValue(row)
  switch (stepsOp.value) {
    case 'lt': return v < t
    case 'le': return v <= t
    case 'gt': return v > t
    case 'ge': return v >= t
    case 'eq': return v === t
    default: return true
  }
}
const stepsFilterHint = computed(() => en()
  ? 'Step filter: keep only rows whose reasoning steps satisfy the comparison (rows never run / without steps count as 0). Typical use: "< 5" then Rerun → Current filter result to redo the short ones.'
  : '步数筛选：只保留推理步数满足比较条件的行（未运行 / 无步数的行按 0 步计）。常见用法：筛「< 5」后用「重跑 → 当前筛选结果」把这些步数不够的行重跑。')

// ====== 耗时筛选（挑出推理过快的行 → 同样配合「重跑 → 当前筛选结果」重跑） ======
// 规则与步数一致：未运行 / 无起止时间的行按 0 计；数值默认秒，可写 90 / 1.5m / 2m30s / 1h
const durOp = ref<'lt' | 'le' | 'gt' | 'ge' | 'eq'>('lt')
const durInput = ref('')
/** 解析耗时表达式 → 秒（默认秒；支持 s/m/h 与 1m30s 组合）；非法 = NaN */
const parseDurationSec = (input: string): number => {
  // 先去掉空白，便于“合法片段拼起来必须等于原串”的严格校验（挡住 2x 这类写法）
  const t = String(input || '').trim().toLowerCase().replace(/\s+/g, '')
  if (!t) return NaN
  const re = /(\d+(?:\.\d+)?)(h|m|s|时|分|秒)?/g
  const parts: string[] = []
  let total = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    const v = Number(m[1])
    if (!Number.isFinite(v)) return NaN
    const unit = m[2] || 's'
    total += (unit === 'h' || unit === '时') ? v * 3600 : ((unit === 'm' || unit === '分') ? v * 60 : v)
    parts.push(m[0])
  }
  if (!parts.length || parts.join('') !== t) return NaN
  return total
}
const durThresholdSec = computed<number | null>(() => {
  const t = durInput.value.trim()
  if (!t) return null
  return parseDurationSec(t)
})
const durFilterActive = computed(() => { const v = durThresholdSec.value; return v !== null && !Number.isNaN(v) })
const durInputInvalid = computed(() => durInput.value.trim() !== '' && !durFilterActive.value)
const durOpLabel = computed(() => CMP_OP_LABEL[durOp.value] || '<')
const durPlaceholder = computed(() => (en() ? 'took' : '耗时'))
/** 行的耗时（秒；无开始时间 = 0；运行中按当前时刻） */
const rowDurationSec = (row: BatchRow): number => {
  if (!row.startedAt) return 0
  const s = new Date(row.startedAt).getTime()
  const e = row.finishedAt ? new Date(row.finishedAt).getTime() : (row.status === 'running' ? Date.now() : NaN)
  if (!isFinite(s) || !isFinite(e) || e < s) return 0
  return Math.round((e - s) / 1000)
}
const matchDurFilter = (row: BatchRow): boolean => {
  const t = durThresholdSec.value
  if (t === null || Number.isNaN(t)) return true
  const v = rowDurationSec(row)
  switch (durOp.value) {
    case 'lt': return v < t
    case 'le': return v <= t
    case 'gt': return v > t
    case 'ge': return v >= t
    case 'eq': return v === t
    default: return true
  }
}
const durFilterHint = computed(() => en()
  ? 'Duration filter: keep rows whose run time satisfies the comparison (never-run rows count as 0). Value is in seconds but accepts units: 90, 1.5m, 2m30s, 1h. Typical use: "< 1m" then Rerun → Current filter result to redo the ones that finished too fast.'
  : '耗时筛选：按行耗时（开始→结束）筛选。未运行 / 无起止时间的行按 0 计；数值默认秒，可写 90 / 1.5m / 2m30s / 1h。常见用法：筛「< 1m」后用「重跑 → 当前筛选结果」把推理过快（可能没认真思考）的行重跑。')

// ====== 源表增量（重读表格相对上次保存的变化） ======
/** 源表增量摘要（本次载入相对上次保存的变化），供详情页工具栏提示；仅在真的重读了源表时填写 */
const sourceDelta = reactive({ added: 0, changed: 0, removed: 0, bySig: false, reason: '' })
const sourceDeltaTotal = computed(() => sourceDelta.added + sourceDelta.changed + sourceDelta.removed)
/** 任务文件里记录的源表列（上次保存时的列名顺序）：与本次读到的列不同 → 指纹不可比，退回按行号对位 */
const savedSourceColumns = ref<string[]>([])
/**
 * 被删掉的源行（非结构化模式）：源表重读后对不上的旧行，连**旧行数据**与它的结果一起留下来，
 * 结果页照样列出并标「已移除」（结构化模式是给记录标 `_removed`，见 syncDatasetRowsToMap）。
 * 只在内存里（下次同步 / 导入 / 清除结果 / 打开任务时重算），不写进任务文件。
 */
const removedRows = ref<Array<{ no: number; data: Record<string, any>; saved: Record<string, any> }>>([])
/** 重读源表前留的旧行数据（源表不存行数据，删掉的行只能从这份快照里带出原表列） */
const prevRowData = ref<Array<Record<string, any>> | null>(null)
/** 结果页最多保留多少条「已移除」的旧结果（大表只保留前若干条） */
const REMOVED_ROWS_MAX = 5000
/** 本次同步自动删掉了多少条「源行已不存在」的多余结果（0 = 没删 / 没这类结果） */
const sourceDeltaCleaned = ref(0)
/** 状态栏用的精简后缀：只算行数增减 / 自动删除多余结果 */
const sourceDeltaStatusNote = computed(() => {
  const parts: string[] = []
  if (sourceDelta.reason) parts.push(en() ? 'row-count difference only' : '只算行数增减')
  if (sourceDeltaCleaned.value) {
    parts.push(en()
      ? `${sourceDeltaCleaned.value} surplus result(s) deleted`
      : `已删除 ${sourceDeltaCleaned.value} 条多余结果`)
  }
  return parts.length ? `（${parts.join('；')}）` : ''
})
const resetSourceDelta = () => {
  sourceDelta.added = 0
  sourceDelta.changed = 0
  sourceDelta.removed = 0
  sourceDelta.bySig = false
  sourceDelta.reason = ''
  removedRows.value = []
  sourceDeltaCleaned.value = 0
}
/** 列差异（仅用于提示文案）：上次保存时的源表列 → 本次读到的源表列 */
const deltaColumnDiff = computed(() => {
  const a = savedSourceColumns.value || []
  const b = sourceColumnsNow.value
  if (!a.length || !b.length) return { added: [], removed: [], reordered: false }
  const addedCols = b.filter(c => !a.includes(c))
  const removedCols = a.filter(c => !b.includes(c))
  const keptA = a.filter(c => b.includes(c))
  const keptB = b.filter(c => a.includes(c))
  return { added: addedCols, removed: removedCols, reordered: keptA.join('\u0001') !== keptB.join('\u0001') }
})
const sourceDeltaHint = computed(() => {
  const head = en()
    ? `Source table changed since the results were saved:\n${sourceDelta.added} new row(s) — to run (marked “new”)\n${sourceDelta.changed} row(s) whose source data changed — same row, its result stays attached (marked “changed”; rerun when you like)\n${sourceDelta.removed} row(s) removed from the source — **their results are deleted automatically** when the source is re-read; if the mismatch looks unreliable (more than half the rows) they are only marked “removed” (the “Removed N” button on the Results tab shows them so you can review / delete manually)\nRows are matched by whole-row fingerprint first, then by the row’s first value, so adding / removing / editing rows keeps every result aligned with its own task row.\n“Changed” is judged on normalized fingerprints only (number formats / stray whitespace do not count); when either side lacks one (older task files) no per-row “changed” marks are added — only additions / removals are reported, and a rerun restores it.\nClick “+new” / “changed” to filter the table below; “removed” rows are not in the table any more.`
    : `源表相对上次保存已经变化：\n新增 ${sourceDelta.added} 行——待跑（标「新增」）\n变更 ${sourceDelta.changed} 行——还是同一行，结果仍留在该行上（标「已变更」，需要时重跑）\n移除 ${sourceDelta.removed} 行——重读源表时**结果会一并自动删掉**（结果跟着源表走）；只有当对位不可信（删掉的超过一半）才只标「已移除」不删，可在结果页用「已移除 N」查看后手动处理\n对位顺序：先按整行指纹，再按「该行首个非空单元格」的值——所以增删 / 改行后每条结果都仍与它自己的任务行对齐。\n判「变更」只看归一化指纹（数字写法 / 空白差异不算改动），两侧缺归一化指纹（老任务文件）时不逐行判变更、只报增删，重跑一轮后恢复。\n点「新增 / 变更」即在下方表格里筛选；「移除」的行已不在表里。`
  const colDiff = deltaColumnDiff.value
  const colLines: string[] = []
  if (colDiff.added.length) colLines.push(en() ? `columns added: ${colDiff.added.join(', ')}` : `新增列：${colDiff.added.join('、')}`)
  if (colDiff.removed.length) colLines.push(en() ? `columns missing now: ${colDiff.removed.join(', ')}` : `已丢失列：${colDiff.removed.join('、')}`)
  if (colDiff.reordered) colLines.push(en() ? 'column order changed' : '列顺序已变化')
  const tail = (colLines.length ? '\n\n' + colLines.join('\n') : '')
    + (sourceDelta.reason
      ? (en()
        ? `\n\n⚠ ${sourceDelta.reason} — this time only the row-count difference is reported above: the rows involved were not pinpointed.`
        : `\n\n⚠ ${sourceDelta.reason} —— 本次上面的增量只算行数增减，没有定位到具体行。`)
      : '')
  return head + tail
})
/** 增量筛选（详情页）：'' = 全部 / added / modified —— 工具栏的「新增 / 变更」标识就是它的开关 */
const deltaFilter = ref<'' | 'added' | 'modified'>('')
/** 点工具栏的「新增 / 变更」标识：切换该增量筛选（再点一次取消） */
const toggleDeltaFilter = (kind: 'added' | 'modified') => {
  deltaFilter.value = deltaFilter.value === kind ? '' : kind
  resetPages()
}
const deltaFilterHint = computed(() => en()
  ? 'Show only the rows the source table brought in (new) or whose source data changed (need a rerun). Available after a table re-import finds changes.'
  : '只看源表带来的变化：新增的行 / 源数据已变的行（需重跑）。重读源表发现变化后才有这个筛选。')
const deltaLabel = (d?: 'added' | 'modified') => d === 'added'
  ? (en() ? 'new' : '新增')
  : d === 'modified' ? (en() ? 'changed' : '已变更') : ''
const deltaTitle = (d?: 'added' | 'modified') => d === 'added'
  ? (en() ? 'Added in the source table (not run yet)' : '源表新增的行（还没跑过）')
  : (en() ? 'This row’s source data changed — its result stays attached to the row; rerun it (e.g. filter “changed” then “Rerun matched rows”) to refresh' : '源表这一行的数据改过了——结果仍保留在本行上，需要时重跑刷新（可在筛选面板选「已变更行」后点「重跑命中行」）')

// ====== 筛选面板（状态 / 结果 / 行号 / 步数 / 耗时 统一配置 + 命中统计 + 批量标记） ======
const showFilterPanel = ref(false)
const filterMenuBtnRef = ref<HTMLElement | null>(null)
const filterPanelStyle = ref<Record<string, string>>({})
const toggleFilterPanel = () => {
  if (showFilterPanel.value) { showFilterPanel.value = false; return }
  const rect = filterMenuBtnRef.value?.getBoundingClientRect()
  if (rect) {
    const width = 380
    const left = Math.max(6, Math.min(Math.round(rect.left), window.innerWidth - width - 8))
    filterPanelStyle.value = {
      left: `${left}px`,
      top: `${Math.round(rect.bottom + 4)}px`,
      width: `${width}px`,
      maxHeight: `${Math.max(240, Math.round(window.innerHeight - rect.bottom - 24))}px`,
    }
  }
  showFilterPanel.value = true
}
/** 已启用的条件数（含搜索关键字）——按钮上的小计 */
const activeFilterCount = computed(() =>
  (displayStatus.value.length ? 1 : 0)
  + (debouncedKeyword.value.trim() ? 1 : 0)
  + (debouncedResultKw.value.trim() ? 1 : 0)
  + (rowRangeActive.value ? 1 : 0)
  + (deltaFilter.value ? 1 : 0)
  + (stepsFilterActive.value ? 1 : 0)
  + (durFilterActive.value ? 1 : 0))
/** 条件摘要（面板里逐条列出，便于核对当前到底筛了什么） */
const activeFilterTags = computed(() => {
  const tags: string[] = []
  if (displayStatus.value.length) tags.push(`${en() ? 'Status' : '状态'}: ${displayStatus.value.map(v => statusOptions.value.find(o => o.value === v)?.label || v).join('/')}`)
  if (debouncedKeyword.value.trim()) tags.push(`${en() ? 'Search' : '搜索'}: ${debouncedKeyword.value.trim()}`)
  if (debouncedResultKw.value.trim()) tags.push(`${filteredFieldLabel.value}: ${parseResultFilter(debouncedResultKw.value).tokens.join(' / ')}`)
  if (parseResultFilter(debouncedResultKw.value).matchEmpty) tags.push(en() ? `${filteredFieldLabel.value} is empty` : `${filteredFieldLabel.value}为空`)
  if (rowRangeActive.value) tags.push(`${en() ? 'Rows' : '行号'}: ${debouncedRowRange.value.trim()}`)
  if (deltaFilter.value) tags.push(en()
    ? `Source: ${deltaFilter.value === 'added' ? 'new rows' : 'changed rows'}`
    : `源表${deltaFilter.value === 'added' ? '新增行' : '已变更行'}`)
  if (stepsFilterActive.value) tags.push(`${en() ? 'Steps' : '步数'} ${stepsOpLabel.value} ${stepsInput.value.trim()}`)
  if (durFilterActive.value) tags.push(`${en() ? 'Took' : '耗时'} ${durOpLabel.value} ${durInput.value.trim()}`)
  return tags
})
const filterButtonTitle = computed(() => en()
  ? 'Filters in one panel: status / search / result-or-field / row range / steps / duration — the panel shows how many rows match and can mark them in bulk (marking “Pending” = queued for the next Start; Rerun marks + runs immediately).'
  : '筛选面板：状态 / 搜索 / 结果或指定字段 / 行号 / 步数 / 耗时 集中在一个面板里；面板内实时显示命中行数，并可把命中行批量标记为某个状态（标记「待处理」= 待执行，下次启动即跑；「重跑」= 标记待处理并立即执行）。')
const filterPanelHint = computed(() => en()
  ? 'Conditions combine with AND; an empty field means “not filtered”.'
  : '多个条件为「同时满足」；不填的项 = 不筛该项。')
const clearAllFilters = () => {
  displayStatus.value = []
  displayKeyword.value = ''
  debouncedKeyword.value = ''
  resultKeyword.value = ''
  debouncedResultKw.value = ''
  resultFilterField.value = ''
  deltaFilter.value = ''
  rowRangeInput.value = ''
  debouncedRowRange.value = ''
  stepsInput.value = ''
  durInput.value = ''
  resetPages()
}
/** 可批量标记的状态（不含「执行中」：运行中的行不能手改） */
const markStatusOptions = computed(() => [
  { value: 'pending' as BatchRowStatus, label: en() ? 'Pending (to run)' : '待处理（待执行）', hint: en() ? 'Mark as pending → they run on the next Start (results kept until then)' : '标记为「待处理」= 待执行，下次点「启动」就会跑（在此之前旧结果保留）' },
  { value: 'skipped' as BatchRowStatus, label: en() ? 'Skipped' : '跳过', hint: en() ? 'Mark as skipped → they are not run' : '标记为「跳过」，不参与运行' },
  { value: 'completed' as BatchRowStatus, label: en() ? 'Completed' : '已完成', hint: en() ? 'Mark as completed manually (e.g. checked by hand)' : '手动标记为「已完成」（如人工校核过）' },
  { value: 'failed' as BatchRowStatus, label: en() ? 'Failed' : '失败', hint: en() ? 'Mark as failed' : '标记为「失败」' },
])
const markHint = computed(() => en()
  ? 'Marking changes the STATUS only (results are untouched, so you can queue rows without losing anything). “Pending” = to-run: press Start on the Task tab and those rows run. “Rerun matched rows” below runs them right away (while the batch is running they jump the queue).'
  : '标记只改状态、不动结果（可先排队而不丢结果）；「待处理」= 待执行，在「任务」页点启动就会跑这些行。下方「重跑命中行」则立即执行（批量运行中会插队）。')
const markExcludedHint = computed(() => runningRows.value
  ? (en() ? `(running ${runningRows.value} excluded)` : `（执行中 ${runningRows.value} 行不参与标记）`)
  : '')
/** 把当前筛选命中的行批量标记为某状态（执行中的行跳过） */
const markFilteredRows = async (status: BatchRowStatus) => {
  const targets = tableFilteredRows.value.filter(r => r.status !== 'running')
  if (!targets.length) {
    ElMessage.warning(en() ? 'No matched rows to mark' : '没有可标记的命中行')
    return
  }
  const label = markStatusOptions.value.find(o => o.value === status)?.label || status
  const skippedRunning = tableFilteredRows.value.length - targets.length
  try {
    await ElMessageBox.confirm(
      en()
        ? `Mark ${targets.length} matched row(s) as “${label}”?${skippedRunning ? ` (${skippedRunning} running row(s) are left untouched)` : ''}`
        : `把命中的 ${targets.length} 行标记为「${label}」？${skippedRunning ? `（另有 ${skippedRunning} 行执行中，不参与）` : ''}`,
      en() ? 'Mark rows' : '批量标记',
      { confirmButtonText: en() ? 'Mark' : '标记', cancelButtonText: en() ? 'Cancel' : '取消', type: 'warning' },
    )
  } catch { return }
  for (const r of targets) {
    applyStatusChange(r.status, status)
    r.status = status
    if (status === 'pending') r.error = undefined
  }
  recountRows()
  addLog('info', en()
    ? `Marked ${targets.length} row(s) as “${label}”`
    : `已把 ${targets.length} 行标记为「${label}」`)
  ElMessage.success(en() ? `Marked ${targets.length} row(s)` : `已标记 ${targets.length} 行`)
}
/** 重跑命中行（= 当前筛选结果） */
const rerunHint = computed(() => en()
  ? 'Rerun the rows matched by the current filters: while the batch runs they go into a priority queue and start as soon as a worker frees up; when stopped they are marked pending and started right away (other pending rows are left alone).'
  : '重跑当前筛选命中的行：批量运行中 → 加入优先队列，任一线程空闲立即执行；未运行 → 标记为待处理并立即启动（不会带跑其它待处理行）。')
/** 重跑命中行：运行中插队立即执行；未运行则标记待处理并按选区启动 */
const rerunFilteredRows = async () => {
  const targets = tableFilteredRows.value.filter(r => r.status !== 'running')
  if (!targets.length) {
    ElMessage.warning(en() ? 'No matched rows to rerun' : '没有可重跑的命中行')
    return
  }
  showFilterPanel.value = false
  if (isRunning.value) {
    if (!agent) {
      addLog('warning', en() ? 'Batch is starting up — try again in a moment' : '批量正在启动中，请稍后再试')
      return
    }
    const accepted = agent.requestRerunBatch(targets)
    if (accepted === 0) {
      addLog('warning', en() ? 'Rerun not accepted (batch may be stopping)' : '重跑未受理（批量可能正在停止）')
      return
    }
    addLog('info', en()
      ? `Queued ${accepted} matched row(s) into the priority rerun queue`
      : `已把命中的 ${accepted} 行加入优先重跑队列（立即执行）`)
    if (accepted < targets.length) {
      addLog('warning', en()
        ? `${targets.length - accepted} row(s) not accepted (already running)`
        : `${targets.length - accepted} 行未受理（正在执行中）`)
    }
    ElMessage.success(en() ? `Queued ${accepted} row(s)` : `已加入优先队列 ${accepted} 行`)
    return
  }
  for (const r of targets) {
    applyStatusChange(r.status, 'pending')
    r.status = 'pending'
    r.error = undefined
    r.retryCount = 0
    r.emptyRetryCount = 0
  }
  addLog('info', en() ? `Rerun: ${targets.length} matched row(s)` : `重跑命中行：${targets.length} 行`)
  await startBatch(new Set(targets.map(r => r.id)))
}

/** 结果为空快捷开关：直接读写结果筛选里的 `|''` 语法（单一数据来源，输入框与开关双向联动） */
const emptyResultOnly = computed<boolean>({
  get: () => parseResultFilter(resultKeyword.value).matchEmpty,
  set: (on: boolean) => {
    const { tokens, matchEmpty } = parseResultFilter(resultKeyword.value)
    if (on === matchEmpty) return
    const parts = [...tokens]
    if (on) parts.push("''")
    resultKeyword.value = parts.join('|')
  },
})
const emptyResultHint = computed(() => en()
  ? `Shortcut for the “|''” syntax: match rows where ${filteredFieldLabel.value} is empty (never run / failed with no output). Combine with keywords to match either; often used with Rerun → Current filter result.`
  : `「本列为空」快捷开关（等价于在该列筛选里写竖线加两个单引号）：筛出 ${filteredFieldLabel.value} 为空的行（未跑过 / 失败无输出）；与关键字同时使用时取「任一命中」，常配合重跑补跑。`)

const filteredRows = computed(() => {
  const kw = debouncedKeyword.value.trim().toLowerCase()
  const statuses = displayStatus.value
  const ranges = rowRangeRanges.value
  const stepsOn = stepsFilterActive.value
  const durOn = durFilterActive.value
  const delta = deltaFilter.value
  // 无筛选时直接返回原数组（零拷贝，且不依赖行状态，运行期不因状态变化重算）
  if (!kw && !statuses.length && !ranges.length && !stepsOn && !durOn && !delta) return rows.value
  return rows.value.filter((r, i) => {
    if (delta && r.delta !== delta) return false
    if (ranges.length && !inRowRanges(i + 1, ranges)) return false
    if (statuses.length && !statuses.includes(r.status)) return false
    if (stepsOn && !matchStepsFilter(r)) return false
    if (durOn && !matchDurFilter(r)) return false
    if (!kw) return true
    const hay = Object.values(r.data || {}).join(' ') + ' ' + (r.result || '') + ' ' + (r.error || '')
    return hay.toLowerCase().includes(kw)
  })
})

// ====== 结果 / 字段筛选（仅表格页：选「结果」或某个字段，支持 | 分隔多关键字与 |'' 空值；供批量重跑定位） ======
const resultKeyword = ref('')
/** 筛哪个列：'' = 结果列；其它 = 提取字段 / 原表列（含写回列）——与详情表的列名一致 */
const resultFilterField = ref('')
/** 可选字段：结构化提取字段 + 原表列（写回列也在 row.data 里） */
const resultFieldOptions = computed(() => {
  const names: string[] = []
  for (const f of detailExtractFields.value) if (!names.includes(f.name)) names.push(f.name)
  for (const c of columns.value) if (!names.includes(c)) names.push(c)
  for (const c of writeBackColumns.value) if (!names.includes(c)) names.push(c)
  return names
})
/** 取某行在该筛选列上的文本（'' = 结果列） */
const rowFieldFilterText = (row: BatchRow, field: string): string => {
  if (!field) return String(row.result ?? '')
  const structured = detailExtractFields.value.find(f => f.name === field)
  if (structured) return extractedCell(row, field)
  const v = row.data?.[field]
  return v === undefined || v === null ? '' : String(v)
}
const filteredFieldLabel = computed(() => resultFilterField.value || (en() ? 'Result' : '结果'))
const debouncedResultKw = ref('')
let resultKwTimer: ReturnType<typeof setTimeout> | null = null
watch(resultKeyword, (v) => {
  if (resultKwTimer) clearTimeout(resultKwTimer)
  resultKwTimer = setTimeout(() => { debouncedResultKw.value = v }, 200)
})
// 换列立即生效（不用等关键字的 200ms 防抖）
watch(resultFilterField, () => {
  if (resultKwTimer) clearTimeout(resultKwTimer)
  debouncedResultKw.value = resultKeyword.value
})
const resultPlaceholder = computed(() => (en() ? `${filteredFieldLabel.value}: a|b|''` : `${filteredFieldLabel.value}: a|b|''`))
const resultFilterHint = computed(() => en()
  ? `Filter by ${filteredFieldLabel.value}: separate multiple keywords with "|" — a row shows if that column contains ANY of them. Use |'' to pick rows where it is empty.`
  : `按「${filteredFieldLabel.value}」筛选：多个关键字用 | 分隔（命中任一即显示）；用 |'' 可挑出该列为空的行。`)
const resultFieldSelectTitle = computed(() => en()
  ? 'Which column to filter: the result column by default, or a specific extracted field / source column'
  : '筛哪一列：默认「结果」列，也可选具体的提取字段 / 原表列（包含逐列写回的新列）')
/** 解析结果筛选表达式：`|` 分隔多关键字（任一命中即显示）；`''` / `""` 表示「结果为空」 */
const parseResultFilter = (input: string) => {
  const tokens: string[] = []
  let matchEmpty = false
  for (const raw of String(input || '').split('|')) {
    const t = raw.trim()
    if (!t) continue
    const unquoted = /^(['"])(.*)\1$/.test(t) ? t.slice(1, -1) : t
    if (unquoted === '') { matchEmpty = true; continue }
    tokens.push(unquoted.toLowerCase())
  }
  return { tokens, matchEmpty }
}
// 表格页最终筛选集：通用筛选(filteredRows) 叠加 结果多关键字 / 结果为空
const tableFilteredRows = computed(() => {
  const { tokens, matchEmpty } = parseResultFilter(debouncedResultKw.value)
  if (!tokens.length && !matchEmpty) return filteredRows.value
  const field = resultFilterField.value
  return filteredRows.value.filter(r => {
    const text = rowFieldFilterText(r, field)
    if (matchEmpty && text.trim() === '') return true
    if (!tokens.length) return false
    const low = text.toLowerCase()
    return tokens.some(t => low.includes(t))
  })
})

// ====== 分页（窗口式渲染：可从中任意一行开始渲染，向上/向下按需扩展） ======
// 只在 DOM 中保留 [windowStart, windowEnd) 区间内的行；窗口之前的行用一个「占位高度」顶开，
// 因此跳转到第 10w 行时不再需要先把前面 10w 行渲染出来（旧实现是加载数量累加，越大越慢）。
const ROW_PAGE_SIZE = 200
const tableWrapRef = ref<HTMLElement | null>(null)
/** 渲染窗口：[windowStart, windowEnd) 为 tableFilteredRows 的下标区间 */
const windowStart = ref(0)
const windowEnd = ref(ROW_PAGE_SIZE)
/** 单行高度估算值（仅用于「上方隐藏行」的占位高度与滚动位置换算；真实定位用实测补偿校正）
 *  需大致匹配当前表格行高：结果列最多 3 行 + 操作列两行（状态下拉 + 图标）≈ 35~45px */
const EST_ROW_H = 38
const visibleTableRows = computed(() => tableFilteredRows.value.slice(windowStart.value, windowEnd.value))
const hasMoreTableRows = computed(() => windowEnd.value < tableFilteredRows.value.length)
const hasPrevTableRows = computed(() => windowStart.value > 0)
/** 窗口上方未渲染的行数（占位区内的行） */
const hiddenAboveCount = computed(() => windowStart.value)
const topSpacerHeight = computed(() => windowStart.value * EST_ROW_H)

const isNearBottom = (el: HTMLElement | null, threshold = 80): boolean => {
  if (!el) return false
  return el.scrollTop + el.clientHeight >= el.scrollHeight - threshold
}
const onTableScroll = (e: Event) => {
  const el = e.target as HTMLElement
  requestAnimationFrame(() => {
    // ⚠ 必须先处理「向上」：窗口很窄时（如跳转到表格末尾，只渲染了几百行且下方再无行），
    // 视口必然也满足「接近底部」；若先判底部就 return，向上将永远不加载（只剩点击提示行可用，
    // 上方一直露着空白占位区）
    if (hasPrevTableRows.value) {
      // 视口底边到「窗口顶部边界」的距离：>0 表示视口还在已渲染行内，<0 表示上方占位区露出来了
      const gap = el.scrollTop + el.clientHeight - topSpacerHeight.value
      if (gap < -40) { relocateWindowAtOffset(el); return }
      if (gap < 200) { loadPrevRows(); return }
    }
    if (hasMoreTableRows.value && isNearBottom(el)) loadMoreRows()
  })
}
/** 向下扩展一页（点击或下滑到底部「加载更多」时调用） */
const loadMoreRows = () => {
  windowEnd.value = Math.min(tableFilteredRows.value.length, windowEnd.value + ROW_PAGE_SIZE)
}
/** 向上扩展一页：用窗口首行的实测位移补偿 scrollTop，保证已看到的内容不跳动 */
let prevLoading = false
const loadPrevRows = async (count = ROW_PAGE_SIZE) => {
  if (prevLoading || windowStart.value <= 0) return
  prevLoading = true
  try {
    const wrap = tableWrapRef.value
    const firstRow = wrap?.querySelector<HTMLElement>('tbody tr[data-batch-row]')
    const anchorId = firstRow?.dataset.batchRow || ''
    const anchorTop = firstRow ? firstRow.getBoundingClientRect().top : 0
    const scrollTop = wrap?.scrollTop ?? 0
    windowStart.value = Math.max(0, windowStart.value - count)
    await nextTick()
    if (!wrap || !anchorId) return
    const anchor = wrap.querySelector<HTMLElement>(`tbody tr[data-batch-row="${anchorId}"]`)
    if (!anchor) return
    const delta = anchor.getBoundingClientRect().top - anchorTop
    if (delta) wrap.scrollTop = scrollTop + delta
  } finally {
    prevLoading = false
  }
}
/** 视口落在上方占位区内：按估算行高把窗口重定位到当前滚动位置（用户看到的行直接补齐，不再是一片空白） */
const relocateWindowAtOffset = (el: HTMLElement) => {
  const total = tableFilteredRows.value.length
  const cur = windowStart.value
  // 预留 8 行上下文在视口上方；换算结果必须比当前窗口更靠前
  const start = Math.max(0, Math.min(cur - 1, Math.floor(el.scrollTop / EST_ROW_H) - 8))
  if (start >= cur) return
  // 窗口收敛到「一页 + 覆盖视口所需行数」：重定位后视口内容不变，但不再保留窗口原先渲染的（更靠后的）行
  const cover = Math.ceil(el.clientHeight / EST_ROW_H) + 40
  windowStart.value = start
  windowEnd.value = Math.min(total, start + Math.max(ROW_PAGE_SIZE, cover))
}
watch(activeTab, (tab) => {
  if (tab === 'rows') resetPages()
  // 日志已并入任务页右列：切回任务页时 DOM 重新挂载（scrollTop 归零），主动滚到底部
  if (tab === 'task') nextTick(() => {
    if (logTab.value === 'main') scrollLogToBottom(mainLogRef.value)
    else scrollLogToBottom(workerLogRef.value)
  })
})
// 结构变化（导入/读取/清空/删除行）或筛选变化时重置分段加载，保证新列表从头渲染
const resetPages = () => {
  windowStart.value = 0
  windowEnd.value = ROW_PAGE_SIZE
}
watch([displayStatus, debouncedKeyword, debouncedResultKw, debouncedRowRange, stepsOp, stepsInput, durOp, durInput], () => {
  resetPages()
})
// 列表变短（删除行等）时收敛窗口，避免窗口整体落在末尾之外导致空白
watch(() => tableFilteredRows.value.length, (len) => {
  if (windowStart.value >= len && len >= 0) resetPages()
})

// ====== 行号（# 列）：始终显示原始顺序号，不受筛选 / 跳转 / 窗口渲染影响 ======
// id → 原始行号（1 起）映射；只在行增删（数组结构变化）时重建，运行期状态刷新不会触发
const rowNoMap = computed(() => {
  const m = new Map<string, number>()
  const arr = rows.value
  for (let i = 0; i < arr.length; i++) m.set(arr[i].id, i + 1)
  return m
})
const rowNo = (row: BatchRow): number => rowNoMap.value.get(row.id) ?? 0

// ====== 表格跳转（按行号 1 起 或 行 id 定位行） ======
const jumpInput = ref('')
const jumpToRow = async () => {
  const raw = String(jumpInput.value || '').trim()
  if (!raw) return
  const n = rows.value.length
  if (n === 0) { ElMessage.warning(en() ? 'No rows to jump to' : '暂无行数据，无法跳转'); return }
  let target: BatchRow | undefined
  if (/^\d+$/.test(raw)) {
    const idx = parseInt(raw, 10) - 1
    if (idx < 0 || idx >= n) { ElMessage.warning(en() ? `Row number out of range (1-${n})` : `行号超出范围（1-${n}）`); return }
    target = rows.value[idx]
  } else {
    target = rows.value.find(r => r.id === raw)
    if (!target) { ElMessage.warning(en() ? `No row with id "${raw}"` : `未找到 id 为 “${raw}” 的行`); return }
  }
  // 切到表格标签并清空筛选，保证目标行一定可见
  activeTab.value = 'rows'
  displayStatus.value = []
  displayKeyword.value = ''
  debouncedKeyword.value = ''
  resultKeyword.value = ''
  debouncedResultKw.value = ''
  rowRangeInput.value = ''
  debouncedRowRange.value = ''
  // 等筛选/标签切换的 watch 跑完（它们会 resetPages），再设置窗口，避免被覆盖
  await nextTick()
  const fi = tableFilteredRows.value.indexOf(target)
  if (fi < 0) { ElMessage.warning(en() ? 'Row not visible after reset' : '重置筛选后仍未找到该行'); return }
  // 关键：窗口从目标行开始（上方只占高度不渲染）→ 大表跳转即时生效；
  // 但目标靠表尾时下方内容不足一屏，滚动会被顶到最底、上方露出空白占位区，
  // 故上方额外预留约一屏的行（几十行，开销可忽略）
  const viewportH = tableWrapRef.value?.clientHeight || 600
  const aboveRows = Math.min(fi, Math.ceil(viewportH / EST_ROW_H) + 4)
  windowStart.value = fi - aboveRows
  windowEnd.value = Math.min(tableFilteredRows.value.length, fi + ROW_PAGE_SIZE)
  selectedRowId.value = target.id
  await nextTick()
  const wrap = tableWrapRef.value
  const el = wrap?.querySelector<HTMLElement>(`tbody tr[data-batch-row="${target.id}"]`)
  if (wrap && el) {
    // 用实测位置把目标行顶到（吸顶表头下方的）视口顶端，避免占位高度估算误差
    const headH = wrap.querySelector('thead')?.getBoundingClientRect().height || 0
    wrap.scrollTop += el.getBoundingClientRect().top - wrap.getBoundingClientRect().top - headH - 4
    el.classList.add('jump-flash')
    setTimeout(() => el.classList.remove('jump-flash'), 1600)
  }
}

// ====== 列 / 占位符 ======
const columns = computed(() => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of rows.value) {
    for (const k of Object.keys(r.data)) {
      if (!seen.has(k)) { seen.add(k); out.push(k) }
    }
  }
  return out
})
const unusedPlaceholders = computed(() => {
  // 无表格数据时列集为空，占位符必然“未匹配”（任务文件不含表格，加载后需先导入）——此时不提示
  if (rows.value.length === 0) return []
  const used = extractPlaceholders(config.template)
  // 跨轮引用（{{第1轮.结果}} 等）已在上方「前轮结果」里可选，不算未匹配
  return used.filter(name => !columns.value.includes(name) && name !== 'rowIndex' && !isKnownRoundRef(name))
})

// ====== 子任务标题（原「显示列」多选改为单列：子任务表格 / 结果预览左侧显示哪一列，''=不显示） ======
/** 标题字段（任务级配置，运行中可切换） */
const titleColumn = computed(() => (config.rowTitleField || '').trim())
/** 已选标题字段不在当前列中（旧任务 / 换了表格）：下拉保底显示，避免空白 */
const staleTitleField = computed(() => {
  const f = titleColumn.value
  return f && !columns.value.includes(f) ? f : ''
})

// ====== 输入面板底部：来源表格 / 文件夹路径（导入或选择后显示；悬停看完整路径） ======
const sourceInfo = computed(() => {
  const n = rows.value.length
  const cnt = en() ? `${n} rows` : `${n} 行`
  if (isFolderSource.value && config.folderPath) {
    return { icon: 'fa-folder-open', text: `${en() ? 'Folder' : '文件夹'}：${config.folderPath}（${cnt}）`, path: config.folderPath }
  }
  if (sourceKind.value === 'table' && (sourceTablePath.value || sourceTableName.value)) {
    const label = sourceTablePath.value || sourceTableName.value
    return { icon: 'fa-file-excel-o', text: `${en() ? 'Table' : '表格'}：${label}（${cnt}）`, path: sourceTablePath.value || label }
  }
  if (isTextSource.value && n) {
    return { icon: 'fa-list-ol', text: `${en() ? 'Text rows' : '文本任务行'}：${cnt}`, path: '' }
  }
  return null
})

// ====== 写回列（纯 LLM 逐列写回：结果落在原表新列；随任务文件保存写回值用） ======
const writeBackColumns = computed(() => {
  if (outputMode.value !== 'single' || !isLlmMode.value) return [] as string[]
  return (config.schema || []).map(f => f.name.trim()).filter(Boolean)
})

// ====== 详情表的结果列：结构化 → 提取字段；逐列写回（表格定向推理）→ 目标列；其余 → 单一结果列 ======
/** 提取字段（已命名的）——结构化模式下行详情 / 提取数据表用它们当列 */
const detailExtractFields = computed(() => (outputMode.value === 'structured' ? (config.schema || []).filter(f => f.name.trim()) : []))
/** 详情表的结果字段列（名字 + 取值）：写回模式 = 目标列（值落在行数据新列） / 结构化 = 提取字段 */
const detailColumns = computed<Array<{ name: string; value: (row: BatchRow) => string }>>(() => {
  if (outputMode.value === 'structured') {
    return detailExtractFields.value.map(f => ({ name: f.name, value: (row: BatchRow) => extractedCell(row, f.name) }))
  }
  if (isLlmMode.value) {
    return (config.schema || []).map(f => f.name.trim()).filter(Boolean)
      .map(name => ({ name, value: (row: BatchRow) => (row.data?.[name] === undefined || row.data?.[name] === null ? '' : String(row.data[name])) }))
  }
  return []
})
/** 详情表里「结果区」占的列数（没有结果字段时退回单一结果列） */
const detailColumnCount = computed(() => detailColumns.value.length || 1)
/** 逐列写回：本行写回字段的值（字段名 → 值；行详情展示与 JSON 编辑用） */
const writeBackValueMap = (row: BatchRow): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const f of config.schema || []) {
    const name = f.name.trim()
    if (!name) continue
    const v = row.data?.[name]
    out[name] = v === undefined || v === null ? '' : String(v)
  }
  return out
}
/** 本行提取出的该字段值（多条记录按行合并，空值忽略） */
const extractedCell = (row: BatchRow, field: string): string =>
  (row.extracted || [])
    .map(r => (r[field] === undefined || r[field] === null ? '' : String(r[field])))
    .filter(v => v.trim())
    .join('\n')

// ====== 数据选择（统一后）：哪些列进入提示词 = 任务指令里的 {{列名}}（不再单独配置源列） ======
/** 任务指令里已引用的列（占位符名集合；rowIndex 单独判断） */
const referencedCols = computed(() => new Set(extractPlaceholders(config.template || '')))
const isColUsed = (col: string): boolean => col === 'rowIndex'
  ? (config.template || '').includes('{{rowIndex}}')
  : referencedCols.value.has(col)
/** 点列名：未引用 → 写入任务指令（光标处插入 / 未聚焦追加一行）；已引用 → 从指令里移除全部 {{列名}} */
const toggleCol = (col: string) => {
  if (!isColUsed(col)) { insertPlaceholder(col); return }
  config.template = (config.template || '').split(`{{${col}}}`).join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
}
/** 全部引用：把尚未引用的列逐行追加到任务指令末尾 */
const appendAllCols = () => {
  const missing = columns.value.filter((c) => !isColUsed(c))
  if (!missing.length) return
  const cur = config.template || ''
  const tail = missing.map((c) => `{{${c}}}`).join('\n')
  config.template = cur ? `${cur}${cur.endsWith('\n') ? '' : '\n'}${tail}` : tail
}
/** 全部移除：从任务指令里移除全部列占位符（含 rowIndex；未知占位符保留，仍由未匹配告警提示） */
const removeAllCols = () => {
  let t = config.template || ''
  for (const c of [...columns.value, 'rowIndex']) t = t.split(`{{${c}}}`).join('')
  config.template = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
}
/** 任务指令框：标题 / 占位文本（按执行方式自适应；三种执行方式共用同一字段） */
const instructionTitle = computed(() => {
  const common = en() ? 'Rendered once per row' : '每行渲染一次'
  if (isAgentMode.value) return en()
    ? `${common}: the task of that row's agent (one agent per row). {{column}} placeholders are picked from Data selection below.`
    : `${common}：作为该行智能体的任务（一个智能体一行）。{{列名}} 由下方「数据选择」点选写入。`
  if (isExtractMode.value) return en()
    ? `${common}: what to extract (optional). {{column}} placeholders are picked from Data selection below.`
    : `${common}：说明要提取什么（可留空）。{{列名}} 由下方「数据选择」点选写入。`
  return en()
    ? `${common}: the basis of that row's pure-LLM reasoning (target columns live under Output). {{column}} placeholders are picked from Data selection below.`
    : `${common}：作为该行纯 LLM 推理的依据（输出字段在「输出」面板）。{{列名}} 由下方「数据选择」点选写入。`
})
const instructionPlaceholder = computed(() => {
  if (isAgentMode.value) return en()
    ? 'Task instruction with {{column}} placeholders, one agent per row. e.g. 请为「{{标题}}」写一段 200 字简介'
    : '含 {{列名}} 占位符的任务指令，每行一个任务。例如：请为「{{标题}}」写一段 200 字简介'
  if (isExtractMode.value) return en()
    ? 'e.g. Extract the submission deadline of the conference described in this page'
    : '例如：提取本页所述会议的截稿日期'
  return en()
    ? 'e.g. Judge the industry of the company from: {{名称}}、{{范围}}'
    : '例如：请根据以下信息判断所属行业：{{名称}}、{{范围}}'
})
/** 数据选择区：标题 / 空态 / 列芯片悬停说明 */
const dataSelectTitle = computed(() => en()
  ? 'Which data this row hands to the model — click a column to write / remove its {{placeholder}} in the instruction'
  : '这一行把哪些数据交给模型——点列名即写入 / 移除任务指令里的 {{列名}}')
const dataEmptyHint = computed(() => isFolderSource.value
  ? (en() ? 'Scan a folder to create task rows first' : '请先扫描文件夹生成任务行')
  : isTextSource.value
    ? (en() ? 'Create task rows from the text first' : '请先按行生成任务行')
    : (en() ? 'Import a table first' : '请先导入表格'))
const colTitle = (col: string): string => isColUsed(col)
  ? (en() ? `Referenced by {{${col}}} — click to remove it from the instruction` : `已在任务指令中引用 {{${col}}}——点击移除`)
  : (en() ? `Not referenced — click to insert {{${col}}} into the instruction` : `尚未引用——点击把 {{${col}}} 写入任务指令`)

// ====== 文件采集（folder 源 + 提取字段 schema） ======
/** 提取数据集（sink=dataRows；由 runner 经 onDatasetUpdate 回传，随任务文件保存/恢复） */
const datasetRows = ref<Array<Record<string, any>>>([])
const hasDataset = computed(() => outputMode.value === 'structured' || datasetRows.value.length > 0)
/** 行状态显示名（结果页只读展示用） */
const statusLabel = (s: BatchRowStatus): string => statusOptions.value.find(o => o.value === s)?.label || s
/** 行时间显示：HH:MM:SS（非当天附 MM-DD） */
const fmtRowTime = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const sameDay = d.toDateString() === new Date().toDateString()
  return `${sameDay ? '' : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} `}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
/** 行耗时（开始→结束；运行中按当前时刻） */
const fmtRowDuration = (row: BatchRow): string => {
  if (!row.startedAt) return ''
  const s = new Date(row.startedAt).getTime()
  const e = row.finishedAt ? new Date(row.finishedAt).getTime() : (row.status === 'running' ? Date.now() : NaN)
  if (!isFinite(s) || !isFinite(e) || e < s) return ''
  const sec = Math.round((e - s) / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m${String(sec % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}
/** 行推理步骤数（过程快照长度；仅内存） */
const rowStepsText = (row: BatchRow): string => (typeof row.stepsCount === 'number' ? String(row.stepsCount) : '')
/** 行 token 文本（输入/输出） */
const rowTokensText = (row: BatchRow): string => (row.inputTokens || row.outputTokens ? `↑${formatTokenCount(row.inputTokens || 0)} ↓${formatTokenCount(row.outputTokens || 0)}` : '')
/** 扩展名 / 排除目录：以逗号分隔文本编辑，扫描时解析为数组 */
const extInput = ref((config.extensions || []).join(','))
const excludeInput = ref((config.excludeDirs || []).join(','))
const parseListInput = (s: string): string[] => String(s || '').split(/[,，;；\s]+/).map(x => x.trim()).filter(Boolean)
/** 输入框 → config：把框里的扩展名 / 排除目录写回配置（失焦或回车时触发），并回显规范化结果 */
const applySourceInputs = () => {
  config.extensions = parseListInput(extInput.value)
  config.excludeDirs = parseListInput(excludeInput.value)
  if (extInput.value !== config.extensions.join(',')) extInput.value = config.extensions.join(',')
  if (excludeInput.value !== config.excludeDirs.join(',')) excludeInput.value = config.excludeDirs.join(',')
}
// 载入任务文件 / 切轮次 / 套预设后 config 会被整体替换 → 把扩展名 / 排除目录回填到输入框，
// 否则输入框还显示上一次的内容，看起来就像「这两个设置没随任务文件保存」
watch(() => (config.extensions || []).join(','), (v) => { if (v !== extInput.value) extInput.value = v })
watch(() => (config.excludeDirs || []).join(','), (v) => { if (v !== excludeInput.value) excludeInput.value = v })
const pickFolder = async () => {
  try {
    const path = await window.ipcRenderer.invoke('openFolderDialog')
    if (path) config.folderPath = path
  } catch (e: any) { addLog('error', String(e?.message || e)) }
}
/** 扫描文件夹生成任务行（核心实现：不做运行态拦截，供按钮与「打开任务后自动扫描」共用）
 * @param opts.rebuild = true 时按扫描结果**重建**行集合（删掉的文件会消失，交给增量对位标记「已移除」）
 */
const doScanFolder = async (opts?: { rebuild?: boolean }): Promise<number> => {
  if (!config.folderPath) return 0
  // 注意：传给 IPC 的参数必须是可以结构化克隆的普通值 —— config 是 reactive 对象，
  // 直接传 config.extensions / config.excludeDirs 会传进去 Vue 的 Proxy，
  // 主进程克隆时抛「An object could not be cloned.」（文件夹扫描失败的根因）。
  const res = await window.ipcRenderer.invoke('scanFolder', {
    folderPath: String(config.folderPath || ''),
    extensions: (config.extensions || []).map((s: any) => String(s)),
    excludeDirs: (config.excludeDirs || []).map((s: any) => String(s)),
    excludeFiles: [],
    maxFiles: Number(config.maxFiles) || 5000,
  })
  if (!res?.success) { addLog('error', `扫描失败: ${res?.error || ''}`); return 0 }
  const files: Array<{ filePath: string; relativePath: string; fileName: string; extension: string; size: number }> = res.files || []
  const mkRow = (f: typeof files[number]) => {
    const data = { relativePath: f.relativePath, fileName: f.fileName, filePath: f.filePath, extension: f.extension, size: f.size }
    return {
      id: newRowId(),
      data,
      sig: rowSig(data),
      sigNorm: rowSigNorm(data),
      status: 'pending' as BatchRowStatus,
      inputTokens: 0, outputTokens: 0, retryCount: 0, emptyRetryCount: 0,
    }
  }
  if (opts?.rebuild) {
    // 同步：按扫描结果重建行（已存在的文件靠行指纹把结果对回去）
    rows.value = files.map(mkRow)
    recountRows()
    resetPages()
    addLog('info', `已同步源文件夹：共 ${files.length} 个文件`)
    return files.length
  }
  const existing = new Set(rows.value.map(r => String(r.data?.filePath || '')))
  const added = files.filter(f => !existing.has(f.filePath)).map(mkRow)
  rows.value = rows.value.concat(added)
  recountRows()
  resetPages()
  addLog('info', `扫描完成：共 ${files.length} 个文件，新增 ${added.length} 行（跳过已存在 ${files.length - added.length}）`)
  return added.length
}
/** 扫描文件夹 → 每文件一行任务（已存在的文件自动跳过） */
const scanFolderRows = async () => {
  if (isRunning.value || isLoading.value) return
  if (!config.folderPath) { addLog('error', en() ? 'Pick a folder first' : '请先选择文件夹'); return }
  applySourceInputs()
  try { await doScanFolder() } catch (e: any) { addLog('error', `扫描失败: ${e?.message || e}`) }
}
/**
 * 文件夹源：任务行由扫描生成（行数据不随任务文件保存）——
 * 打开任务 / 载入状态后自动扫描一次恢复行，并按行索引合并已保存的结果 / 状态。
 * folderScanTried：每次载入只自动尝试一次（避免失败时被多个分支重复触发、重复报错）。
 */
let folderScanTried = false
const autoScanFolderSource = async () => {
  if (!config.folderPath || rows.value.length || folderScanTried) return
  folderScanTried = true
  try {
    addLog('info', `文件夹源：正在自动扫描 ${config.folderPath} ...`)
    const added = await doScanFolder()
    if (added > 0 && pendingResults.value.length) {
      const n = mergeResults(rows.value, pendingResults.value)
      pendingResults.value = []
      addLog('info', `已自动扫描源文件夹并合并 ${n} 行结果/状态`)
    }
  } catch (e: any) {
    addLog('error', `自动扫描文件夹失败: ${e?.message || e}`)
  }
}

// ====== 文本源 / 图谱投影 ======
/** 按行生成任务行：文本（每行一条）→ 任务行（重复行跳过；抓取模式忽略非 http(s) 行） */
const generateTextRows = () => {
  if (isRunning.value || isLoading.value) return
  const field = (config.textFieldName || '').trim() || 'text'
  const lines = String(config.textInput || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (!lines.length) { addLog('error', en() ? 'Paste some text first (one entry per line)' : '请先粘贴文本（每行一条）'); return }
  const urlMode = contentSourceLocal.value === 'url'
  const keyOf = (s: string) => urlMode ? normalizeUrl(s) : s
  const existing = new Set(rows.value.map(r => keyOf(String(r.data?.[field] ?? ''))).filter(Boolean))
  const added: BatchRow[] = []
  let invalid = 0
  for (const line of lines) {
    if (urlMode && !/^https?:\/\//i.test(line)) { invalid++; continue }
    const key = keyOf(line)
    if (!key || existing.has(key)) continue
    existing.add(key)
    const data: Record<string, any> = { [field]: line }
    if (urlMode) { data.title = ''; data.links = '' }
    added.push({
      id: newRowId(),
      data,
      sig: rowSig(data),
      sigNorm: rowSigNorm(data),
      status: 'pending' as BatchRowStatus,
      inputTokens: 0, outputTokens: 0, retryCount: 0, emptyRetryCount: 0,
      meta: { depth: 0, parentUrl: '' },
    })
  }
  if (!added.length) {
    addLog('warning', en() ? 'No new rows to add (all exist or invalid)' : '没有可新增的行（均已存在或格式无效）')
    return
  }
  rows.value = rows.value.concat(added)
  recountRows()
  resetPages()
  addLog('info', `已生成 ${added.length} 行任务${invalid ? `（忽略 ${invalid} 行非 http(s) 链接）` : ''}`)
}

/** 图谱视图模式：crawl=爬取轨迹 / rowAccess=选中行访问路径 / allAccess=全部行访问路径 */
const graphMode = ref<'crawl' | 'rowAccess' | 'allAccess'>('crawl')
/** 用户是否手动选过图谱视图（选过之后不再自动切换，尊重用户选择） */
const graphModePinned = ref(false)
/** 图谱节点上限（本机偏好持久化；默认 2000，之前写死 150） */
const GRAPH_MAX_NODES_KEY = 'pipelineGraphMaxNodes'
const graphMaxNodes = ref<number>((() => {
  const raw = Number(localStorage.getItem(GRAPH_MAX_NODES_KEY))
  return Number.isFinite(raw) && raw >= 50 ? Math.min(Math.floor(raw), 100000) : 2000
})())
watch(graphMaxNodes, (v) => {
  const n = Math.max(50, Math.min(100000, Math.floor(Number(v) || 2000)))
  if (n !== v) graphMaxNodes.value = n
  try { localStorage.setItem(GRAPH_MAX_NODES_KEY, String(n)) } catch { /* 忽略持久化失败 */ }
})
/** 爬取轨迹的网址字段（按内容获取配置解析；与 crawlGraph 共用） */
const crawlUrlField = computed(() => resolveContentField(config) || 'url')
/** 是否存在「页面行」（有网页地址的行）——爬取轨迹投影的前提 */
const hasUrlRows = computed(() => rows.value.some(r => String(r.data?.[crawlUrlField.value] || '').trim() !== ''))
/** 是否存在过程快照（仅智能体执行方式、且本次会话运行过的行有）——访问路径投影的前提 */
const hasTraceRows = computed(() => rows.value.some(r => Array.isArray(r.trace) && r.trace.length > 0))
// 默认视图智能选择：有网页行 → 爬取轨迹；否则有过程快照 → 访问路径（全部行）——
// 避免「智能体 + 表格」任务打开图谱只看得到空白（用户手动选过后不再自动切）
watch([hasUrlRows, hasTraceRows], () => {
  if (graphModePinned.value) return
  if (hasUrlRows.value) graphMode.value = 'crawl'
  else if (hasTraceRows.value) graphMode.value = 'allAccess'
  else graphMode.value = 'crawl'
}, { immediate: true })
/** 访问路径图的「智能体」节点标签：行号（+ 可选标题字段值，截断到 14 字） */
const agentNodeLabel = (row: PipelineUnit, _index: number): string => {
  const n = rowNo(row as BatchRow)
  const title = config.rowTitleField ? String(row.data?.[config.rowTitleField] || '').trim() : ''
  const short = title.length > 14 ? title.slice(0, 14) + '…' : title
  return short ? `${en() ? 'Agent' : '智能体'} #${n} ${short}` : `${en() ? 'Agent' : '智能体'} #${n}`
}
/** MCP serverId → 显示名（图谱 MCP 服务节点标签；缺省回落 serverId） */
const mcpServerNameOf = (id: string): string => {
  const hit = (store.mcpServers || []).find(s => s && s.id === id)
  return String(hit?.name || '')
}
/** 图谱总开关：关闭后不构建任何图谱数据（节点/边），也不显示「图谱」标签页；行详情的过息快照不受影响 */
const graphEnabled = computed(() => config.graphEnabled !== false)
/** 关闭图谱时的空投影（共用同一对象，避免每次新建） */
const EMPTY_GRAPH: PipelineGraph = { nodes: [], edges: [] }
/** 图谱开关的悬停说明 */
const graphEnabledTitle = computed(() => en()
  ? 'Tick to keep the Graph tab. Unticked: the trajectory projection is not computed at all and the Graph tab is hidden (row-detail process snapshots are unaffected).'
  : '勾选 = 保留「图谱」标签页；取消勾选：完全不计算轨迹投影（省算力），并隐藏「图谱」标签页（行详情里的“过程”回看不受影响）。')
// 关闭图谱时把当前页从「图谱」切走（否则标签页已隐藏但内容还在）
watch(graphEnabled, (on) => {
  if (!on && activeTab.value === 'graph') activeTab.value = 'rows'
})
/** 爬取轨迹图：节点=页面行，边=meta.parentUrl（谁发现了谁）；网址字段按内容获取配置解析 */
const crawlGraph = computed(() => graphEnabled.value
  ? buildCrawlGraph(rows.value, { urlField: crawlUrlField.value, maxNodes: graphMaxNodes.value })
  : EMPTY_GRAPH)
/** 选中行的访问路径图（「智能体」节点 + 访问过的信源 / MCP 服务；仅运行过的智能体行有） */
const rowAccessGraph = computed(() => (graphEnabled.value && selectedRow.value
  ? buildAccessGraph([selectedRow.value], { maxNodes: graphMaxNodes.value, agentLabel: agentNodeLabel, mcpServerName: mcpServerNameOf })
  : EMPTY_GRAPH))
/** 全部行的访问路径图（智能体节点按行；信源/MCP 节点按来源去重；边=智能体→访问对象） */
const allAccessGraph = computed(() => graphEnabled.value
  ? buildAccessGraph(rows.value, { maxNodes: graphMaxNodes.value, agentLabel: agentNodeLabel, mcpServerName: mcpServerNameOf })
  : EMPTY_GRAPH)
/** 当前图谱数据（按视图模式选择） */
const graphView = computed(() => graphMode.value === 'rowAccess'
  ? rowAccessGraph.value
  : graphMode.value === 'allAccess'
    ? allAccessGraph.value
    : crawlGraph.value)
/**
 * 图例（同时就是筛选器）：按当前视图给出维度——
 * 访问路径 = 节点类型（智能体 / 网页 / 文件 / 搜索 / 知识库 / MCP）；爬取轨迹 = 页面状态颜色。
 * 单击图例隐藏 / 恢复该类型（当前图中没有该类型的项不可点）。
 */
const GRAPH_NODE_COLORS: Record<string, string> = {
  green: '#4CAF50', blue: '#2196F3', orange: '#FF9800', red: '#E53935', gray: '#9E9E9E', purple: '#9C27B0',
}
const legendItems = computed(() => graphMode.value === 'crawl'
  ? [
      { key: 'green', color: 'green', zh: '已完成', en: 'Done' },
      { key: 'blue', color: 'blue', zh: '执行中', en: 'Running' },
      { key: 'red', color: 'red', zh: '失败', en: 'Failed' },
      { key: 'gray', color: 'gray', zh: '待处理', en: 'Pending' },
      { key: 'orange', color: 'orange', zh: '跳过', en: 'Skipped' },
    ]
  : [
      { key: 'agent', color: 'purple', zh: '智能体', en: 'Agent' },
      { key: 'web', color: 'green', zh: '网页', en: 'Web' },
      { key: 'file', color: 'blue', zh: '文件', en: 'File' },
      { key: 'search', color: 'orange', zh: '搜索', en: 'Search' },
      { key: 'kb', color: 'gray', zh: '知识库', en: 'KB' },
      { key: 'mcp', color: 'red', zh: 'MCP', en: 'MCP' },
    ])
/** 节点 → 图例 key（爬取视图按状态颜色；访问路径视图按语义 kind） */
const nodeLegendKey = (n: any): string => graphMode.value === 'crawl'
  ? String(n.color || 'gray')
  : String(n.kind || (n.type === 'agent' ? 'agent' : n.type === 'mcp' ? 'mcp' : n.type === 'source' ? 'web' : n.type === 'file' ? 'file' : 'kb'))
/** 各类型的节点数（图例计数；为 0 的类型不可点） */
const legendCounts = computed(() => {
  const m: Record<string, number> = {}
  for (const n of graphView.value.nodes) { const k = nodeLegendKey(n); m[k] = (m[k] || 0) + 1 }
  return m
})
/** 被隐藏（筛选掉）的类型；本机记忆，切换视图时清空（不同视图的图例维度不同） */
const GRAPH_HIDDEN_KEY = 'pipelineGraphHiddenKinds'
const graphHidden = ref<string[]>((() => {
  try {
    const a = JSON.parse(localStorage.getItem(GRAPH_HIDDEN_KEY) || '[]')
    return Array.isArray(a) ? a.filter((x: any) => typeof x === 'string') : []
  } catch { return [] }
})())
const toggleLegend = (key: string) => {
  if (!legendCounts.value[key]) return // 当前图中没有该类型 → 不参与筛选
  const set = new Set(graphHidden.value)
  if (set.has(key)) set.delete(key)
  else set.add(key)
  graphHidden.value = [...set]
  try { localStorage.setItem(GRAPH_HIDDEN_KEY, JSON.stringify(graphHidden.value)) } catch { /* 忽略持久化失败 */ }
}
const legendTitle = (it: { key: string; zh: string; en: string }) => {
  const n = legendCounts.value[it.key] || 0
  const label = en() ? it.en : it.zh
  const hidden = graphHidden.value.includes(it.key)
  return en()
    ? `${label}: ${n} node(s) — click to ${hidden ? 'show' : 'hide'} this type`
    : `${label}：${n} 个节点 —— 单击${hidden ? '显示' : '隐藏'}该类型`
}
watch(graphMode, () => { if (graphHidden.value.length) graphHidden.value = [] })
/** 筛选后的图谱数据（隐藏的类型不画；边两端都在才保留） */
const graphViewFiltered = computed(() => {
  const g = graphView.value
  if (!graphHidden.value.length) return g
  const hide = new Set(graphHidden.value)
  const nodes = g.nodes.filter(n => !hide.has(nodeLegendKey(n)))
  const ids = new Set(nodes.map(n => n.id))
  const sideId = (v: any) => (v && typeof v === 'object' ? v.id : v)
  const edges = g.edges.filter(e => ids.has(sideId(e.source)) && ids.has(sideId(e.target)))
  return { ...g, nodes, edges }
})
/** 工具栏右侧短提示：深度分布（爬取）+ 节点上限截断提示；其余说明由圆点图例 + 悬停承担 */
const graphTailText = computed(() => {
  const parts: string[] = []
  if (graphMode.value === 'crawl') {
    const s = crawlGraph.value.depthStats || []
    if (s.length) parts.push((en() ? 'Depth ' : '深度 ') + s.map(d => `${d.depth}: ${d.total}`).join(' · '))
  }
  if (graphView.value.truncated) parts.push(en()
    ? `Reached the node cap (${graphMaxNodes.value}) — raise the number above to see more`
    : `已达节点上限（${graphMaxNodes.value}）——可调大上方数值`)
  return parts.join('｜')
})
/** 节点上限输入的悬停说明（栏内不再占文字，改由 title 展示） */
const graphMaxNodesTitle = computed(() => en()
  ? 'Max nodes in the graph (crawl & access views; default 2000). Too high slows big tasks down.'
  : '节点上限（爬取轨迹 / 访问路径都生效，默认 2000；太大影响大任务流畅度）')
/** 图谱空态文案（按当前视图说明“为什么空 / 怎么看”） */
const graphEmptyText = computed(() => {
  if (graphView.value.nodes.length && !graphViewFiltered.value.nodes.length) return en()
    ? 'Everything is filtered out — click the coloured dots above to show those types again.'
    : '当前筛选下没有节点——点击上方图例的彩色圆圈可重新显示。'
  if (graphMode.value === 'rowAccess') return en()
    ? 'Pick a row in the “Sources” view first — only rows that ran an agent have a visited-source path.'
    : '先在「源」视图点选一个运行过的行——只有跑过智能体（带工具）的行才有访问路径。'
  if (graphMode.value === 'allAccess') return en()
    ? 'No process snapshots yet — only “Agent” execution keeps them, and only for runs made in this session (kept in memory). Run the task first.'
    : '还没有过程快照：只有「智能体」执行方式、且本次会话运行过的行才有（快照只存内存）。先运行任务再回来看。'
  return en()
    ? 'Nothing to project here — the crawl trajectory needs page rows (web / link collection). For agent tasks switch the view above to “Access path (all rows)”.'
    : '没有可投影的内容：爬取轨迹需要「页面行」（网页 / 链接采集）。若是智能体任务，请把上方视图切到「访问路径（全部行）」。'
})
/** 源视图空态提示（按来源） */
const rowsEmptyHint = computed(() => {
  if (isTextSource.value) return en()
    ? 'No rows yet — paste text on the Task tab and click "Create rows".'
    : '暂无行数据——请在任务页粘贴文本并点「按行生成任务行」'
  if (isFolderSource.value) return en()
    ? 'No rows yet — pick a folder on the Task tab and click "Scan folder".'
    : '暂无行数据——请在任务页选择文件夹并点「扫描文件夹生成任务行」'
  return en() ? 'No rows yet — use the Import button at the top right.' : '暂无行数据，请用工具栏右上角的「导入」按钮导入表格'
})

/** 提取字段（schema）编辑 */
const schemaFields = computed(() => config.schema || [])
const addSchemaField = () => {
  const list = config.schema || (config.schema = [])
  list.push({ id: `sf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: '', type: 'text', description: '', required: false })
}
const removeSchemaField = (i: number) => { (config.schema || []).splice(i, 1) }
/** 主键单选（勾选即清除其它字段的主键标记） */
const setPrimaryKey = (idx: number) => {
  ;(config.schema || []).forEach((f, i) => { f.isPrimaryKey = i === idx })
}

// ====== 输出字段（统一）：逐列写回的「目标列」 ≡ 结构化提取的「提取字段」（同一张 schema 列表） ======
/** 输出字段表头：指令列标题（写回=推理指令；结构化=说明） */
const fieldInstructionLabel = computed(() => isLlmMode.value
  ? (en() ? 'Inference instruction (optional)' : '推理指令（可留空）')
  : (en() ? 'Description' : '说明'))
/** 指令 / 说明输入框占位提示 */
const fieldInstructionPlaceholder = computed(() => isLlmMode.value
  ? (en() ? 'Empty = infer from the field name; use {{column}} to reference the row value' : '留空则按字段名自动分析提取；可用 {{列名}} 引用该行对应值')
  : (en() ? 'Field description (added to the prompt to guide extraction)' : '字段说明（写入提示词，帮助模型理解要提取什么）'))
/** 输出字段区标题 / 说明（两者合并成一条，只在标题上悬停显示，不占界面） */
const outputFieldsTitle = computed(() => en()
  ? 'Output fields — the same list in both modes. Column-by-column write-back (pure LLM + single result): each field goes to a new source-table column, one value per row, no merge / dedupe, and the instruction may stay empty (the field name alone guides inference). Structured extraction: records are produced per field and merged into the data table by primary key (Required / PK apply when merging); in agent mode the agent is asked to finish with a JSON object using these fields.'
  : '输出字段——两种模式共用同一张列表。逐列写回（纯 LLM + 单独结果）：每个字段写回原表新列，每行一个值、不合并不去重，推理指令可留空按字段名自动分析。结构化提取：按字段产出记录并按主键合并进数据表（「必填」「主键」在合并时生效）；智能体模式会在任务末尾要求它只输出含这些字段的 JSON。')
/** 分段结果汇总策略的说明（悬停） */
const segmentMergeTitle = computed(() => en()
  ? 'Long content is split into chunks and inferred segment by segment. “Merge into one record” joins the per-segment fragments field by field, so one task row always yields exactly one record (text fields are concatenated in order). “One record per segment” keeps every segment’s output as its own record — use it when a single file contains many independent records.'
  : '超长内容会被切成多段分别推理：「合并为一条记录」会把各段的片段按字段合并，保证一个任务行最终只产出 1 条数据（文本字段按段顺序拼接）；「每段各成一条」则每段的结果各自成为一条记录——一个文件里含多条独立记录（如长长的清单）时用它。')
/** 重跑结果策略的说明（悬停） */
const rerunResultModeTitle = computed(() => en()
  ? 'Structured extraction only. “Replace this row’s previous records” deletes the records this task row produced last time right before the new ones are written, so rerunning updates instead of piling up (a failed run keeps the old records). “Keep & merge” keeps them and merges by primary key (appends when no primary key is set) — use it when several task rows are meant to contribute to the same record.'
  : '仅结构化提取生效。「替换该行原有结果」= 新结果写入前先删掉这条任务行上次产出的记录，重跑就是更新、不会越跑越多（跑失败时旧记录保留）；「保留并合并」= 保留旧记录，配了主键就按主键更新、没配主键就追加——适用于「多行汇总成同一条记录」的用法。')

// 帮助文案（脚本中字符串可安全包含 {{}}，避免模板插值冲突）
const helpTexts = computed(() => ({
  rerun: en()
    ? 'Details tab: the “Filter” button opens one panel with every condition (status multi-select, keyword, result-or-field with | separated keywords and an “empty” switch, row number, reasoning steps and duration) and shows how many rows match; the matched rows can be marked in bulk as Pending / Skipped / Completed / Failed (Pending = to-run: press Start on the Task tab) or rerun right away with “Rerun matched rows” — while the batch is running they jump the priority queue, and when stopped they are marked pending and started immediately (other pending rows are left untouched). Running rows never take part. Import / Reset live on the Task tab.'
    : '详情页：「筛选」按钮打开一个面板，把状态（多选）、关键字、**结果或指定字段**（先选列：结果 / 提取字段 / 原表列，再用 | 分隔多关键字，`|\'\'` 或「为空」开关 = 该列为空）、行号范围、推理步数与耗时集中在一处，并实时显示命中行数（行号语法：1-100 区间、5000- 从第 5000 行起、-200 前 200 行、3 单行，多段用逗号分隔）。命中行可批量标记为 待处理 / 跳过 / 已完成 / 失败（「待处理」= 待执行，在「任务」页点启动就会跑），或点「重跑命中行」立即执行——批量运行中插入优先队列，未运行则标记待处理并马上启动（不会带跑其它待处理行）。执行中的行不参与。导入表格与重置在「任务」页。',
  capability: en()
    ? 'Each row runs a full agent with tools (files / python / web / KB / MCP). The system prompt comes from the selected preset, or the autonomous general agent when none is chosen. ask_user is auto-disabled in batch mode.'
    : '每行运行完整智能体（文件 / Python / 联网 / 知识库 / MCP 工具）。系统提示词来自所选预设；未选择时使用通用智能体自主规划提示词。批量模式自动禁用 ask_user 交互提问。',
  scenario: en()
    ? 'Massive repetitive agent tasks with one template and many inputs: writing a profile or summary for hundreds of records, checking items one by one, or generating tailored copy per client. Each row runs an independent agent (web / files / knowledge base enabled) concurrently and writes results back to the table — ideal for high-throughput batch operations.'
    : '海量“同一模板、不同输入”的重复性智能体任务：例如给成百上千条记录逐一撰写简介 / 摘要、逐条核查要素、逐家生成定制文案或调研提纲。每行运行一个独立智能体（可联网 / 读写文件 / 使用知识库），并发执行并把结果写回原表，适合大规模产能型批量作业。',
}))

/** 帮助页签分区（数据驱动：内容集中在这里，模板只负责渲染）；中英必须对称 */
type HelpSection = { icon: string; title: string; text?: string; items?: string[] }
const helpSections = computed<HelpSection[]>(() => {
  const zh = !en()
  return [
    {
      icon: 'fa fa-bullseye',
      title: zh ? '使用场景' : 'Use cases',
      text: helpTexts.value.scenario,
    },
    {
      icon: 'fa fa-list-ol',
      title: zh ? '快速上手' : 'Quick start',
      items: zh
        ? [
            '装好任务行：表格（导入 xlsx / xls / csv，每行一条）/ 文件夹（扫描目录，每个文件一条）/ 文本（每行一条）——也可以直接点「预设」套用四种形态之一（大表格导入 / 自动读取时，底部状态栏最左侧显示「读取表格 x/y 行」，每 5000 行刷新一次）',
            '写「任务指令」，用 {{列名}} 引用行数据；点「数据选择」里的列芯片即可写入 / 移除占位符',
            '在「输出」面板按需配好输出字段 / 结果字段，以及「导出列」',
            '点左列操作栏的「启动」开始跑；在「详情」看每行进度，点行打开行详情看完整过程',
            '在「结果」核对导出预览，点「导出 Excel」导出（列与预览完全一致）',
          ]
        : [
            'Load task rows: table (import xlsx / xls / csv — one row per task), folder (scan a directory — one file per task) or text (one entry per line) — or click a preset to apply one of the four shapes (while a big table is imported / auto-loaded, the left of the status bar shows “Loading table x/y rows”, refreshed every 5000 rows)',
            'Write the task instruction and reference row data with {{column}}; click a column chip under Data selection to insert / remove a placeholder',
            'Configure the output fields / result field and the export columns under Output as needed',
            'Click Start in the left card; watch per-row progress on the Details tab and click a row for the full trace',
            'Check the export preview on the Results tab and click Export Excel (its columns match the preview exactly)',
          ],
    },
    {
      icon: 'fa fa-cubes',
      title: zh ? '三个维度：来源 / 执行方式 / 输出方式' : 'Three dimensions: source / execution / output',
      items: zh
        ? [
            '来源：表格（导入 xlsx / xls / csv）、文件夹（扫描本地目录；打开任务时会自动扫描该目录重建任务行，扩展名 / 排除目录随任务文件保存）、文本（每行一条：网址 / 文件路径 / 任意文本）',
            '执行方式：智能体（完整会话，带工具）或纯 LLM 推理（无工具，逐行直接作答）',
            '输出方式：单独结果（智能体→结果列；纯 LLM→逐列写回原表新列）或结构化提取（每行输出 JSON，按字段 / 主键合并进数据表；超长内容自动分段推理，默认把各段结果合并为一条记录——一个文件最终只产出 1 条数据，「输出 → 分段结果」可改为每段各一条）',
            '这三个维度可以自由组合；左列「执行与配置」卡片顶部是操作栏（读取 / 保存 / 另存为 · 重置 / 停止 / 启动），下面是预设、轮次与各项参数',
          ]
        : [
            'Source: table (import xlsx / xls / csv), folder (scan a local directory — opening the task re-scans it to rebuild the rows, and the extensions / excluded folders are stored in the task file) or text (one entry per line: a URL / file path / any text)',
            'Execution: agent (a full session with tools) or pure LLM (no tools, one answer per row)',
            'Output: single result (agent → result column; pure LLM → write back new columns) or structured extraction (each row returns JSON, merged into the dataset by field / primary key; long content is inferred in chunks and by default the per-chunk fragments are merged into ONE record — one file ends as exactly one dataset row; switch “Output → Segments” to “one record per segment” when a file holds many independent records)',
            'The three dimensions combine freely; the Run &amp; settings card starts with the action bar (Open / Save / Save as · Reset / Stop / Start), then the preset, the rounds and the parameters',
          ],
    },
    {
      icon: 'fa fa-magic',
      title: zh ? '四种预设' : 'Four presets',
      items: zh
        ? [
            '批量智能体运行＝表格源 × 智能体 × 单独结果',
            '表格定向推理＝表格源 × 纯 LLM × 结构化提取（给已有表格批量打标签 / 补字段）',
            '文件采集表格＝文件夹源 × 智能体 × 结构化提取（逐文件提取成数据表）',
            '链接采集表格＝文本源（每行一个网址）× 抓取网页 × 结构化提取，可按「链接跟随」在深度 / 页数约束内自动扩展新任务行',
            '手动改动任一维度后会自动回到「自定义配置」；已导入的任务行不会被预设覆盖',
          ]
        : [
            'Batch Agent = table source × agent × single result',
            'Table Reasoning = table source × pure LLM × structured extraction (label or fill fields of an existing table in bulk)',
            'Collect File = folder source × agent × structured extraction (one record per file)',
            'Collect Web = text source (one URL per line) × fetch pages × structured extraction; “link following” can expand new task rows within the depth / page limits',
            'Changing any dimension by hand switches back to “Custom”; imported task rows are never overwritten by a preset',
          ],
    },
    {
      icon: 'fa fa-hashtag',
      title: zh ? '任务指令与占位符' : 'Instruction & placeholders',
      items: zh
        ? [
            '{{列名}}：注入该行该列的值（每行渲染一次任务指令）',
            '{{rowIndex}}：行号（从 1 起）',
            '{{第1轮.结果}} / {{第1轮.字段}}：取同一行在某一轮的产出（多轮打磨时很常用）',
            '未匹配的占位符默认清空，可在指令区下方勾选保留原样',
            '纯 LLM + 结构化提取还可选「内容获取」：行数据 / 读取字段中指定的本地文件 / 抓取字段中指定的网页（抓网页即链接采集，会把页面标题与发现的链接存为行字段）',
          ]
        : [
            '{{column}}: injects that column’s value for the row (the instruction is rendered once per row)',
            '{{rowIndex}}: 1-based row number',
            '{{Round 1.result}} / {{Round 1.field}}: the same row’s output from one of the rounds (handy for multi-round refinement)',
            'Unmatched placeholders are cleared by default; tick “keep unmatched” under the instruction area to keep them as-is',
            'With pure LLM + structured extraction you can also pick what Content to use: row data / read a local file named in a field / fetch a web page named in a field (fetching pages is web collection — page titles and discovered links are stored as row fields)',
          ],
    },
    {
      icon: 'fa fa-play-circle',
      title: zh ? '运行、停止与行操作' : 'Running, stopping & row actions',
      items: zh
        ? [
            '「启动」开始跑；「停止」会取消进行中的行并置回待处理，再点启动即可续跑；失败行按设定次数自动重试',
            '「详情」表格每行显示 状态 / 开始 / 结束 / 耗时 / 步数 / Token / 错误（纯 LLM 推理同样统计 Token）',
            '点行打开行详情，分「任务 / 过程 / 输出」三个页签：「过程」里的每次工具调用默认只占一行，点开看参数与结果；「输出」运行中直接流式显示渲染后的正文',
            '行详情底部：复制 / 编辑（编辑时变为 保存 + 取消）→ 状态下拉 → 停止本行（仅该行执行中，收尾为「跳过」，其它行与整批不受影响）→ 重跑本行（**只跑这一行**：运行中插到队首，未运行时也只启动它，其它待处理行不动）→ 删除，右侧关闭',
            '状态下拉只改状态、不动结果；选「待处理」= 待执行，回「任务」页点启动就会把它拾起来',
            '重跑同一个行的结果怎么算：逐列写回 / 单独结果 → **覆盖**该行的结果；结构化提取配了主键 → 按主键更新原记录（完全相同则跳过），没配主键 → **追加**新记录（反复重跑会重复）——不想要旧结果时用结果页的「清除结果」',
          ]
        : [
            'Start runs the batch; Stop cancels running rows and marks them pending — press Start again to resume; failed rows retry automatically up to the configured count',
            'The Details table shows status / start / end / duration / steps / tokens / error per row (pure-LLM rows count tokens too)',
            'Click a row to open its detail with Task / Process / Output tabs: in Process each tool call is a single line by default (click to expand arguments and result), and Output streams the rendered text while the row runs',
            'Row detail footer: Copy / Edit (becomes Save + Cancel while editing) → status dropdown → Stop this row (only while that row runs; it ends as “Skipped” and the other rows keep going) → Rerun this row (**this row only** — queued first while the batch runs, and when stopped only this row starts; other pending rows stay untouched) → Delete, with Close on the right',
            'The status dropdown changes status only and keeps results; “Pending” = to-run — press Start on the Task tab to pick it up',
            'What happens to results when a row is rerun: column write-back / single result **overwrites** that row; structured extraction with a primary key updates the existing record (skipped when identical), without one it **appends** a new record (repeated reruns duplicate) — use “Clear results” on the Results tab when you want a clean slate',
          ],
    },
    {
      icon: 'fa fa-filter',
      title: zh ? '筛选与重跑选区' : 'Filter & rerun scope',
      text: helpTexts.value.rerun,
    },
    {
      icon: 'fa fa-columns',
      title: zh ? '轮次与对比' : 'Rounds & compare',
      items: zh
        ? [
            '「轮次」可新建 / 重命名 / 删除：新轮次会保留同一批任务行（状态置回待处理）并沿用当前配置，可换指令或设置再跑；结果 / 图谱 / 导出都跟着当前轮',
            '带 ⑂ 的按钮是链式新轮次：把本轮结果展开成新一轮的任务行，适合「先发散再收敛」',
            '「对比」页把同一批行在各轮的产出并排看（按原始行号对齐）：⚠ = 结果不一致，? = 某轮缺结果；点任意一格可弹窗用 Markdown 渲染预览该轮结果',
            '「对比」页上方的「轮次」芯片可显示 / 隐藏某一轮（至少保留一轮，隐藏后只看剩下的那些轮）',
            '在「导出列」里勾选各轮结果，也能在导出的表格里并排成列',
          ]
        : [
            'Rounds can be created / renamed / deleted: a new round keeps the same task rows (status back to pending) and the current settings, so you can change the instruction and run again; results / graph / export always follow the active round',
            'The ⑂ button is a chained round: it expands this round’s results into the next round’s task rows — good for expand-then-refine',
            'The Compare tab shows the same rows across rounds side by side (aligned by original row number): ⚠ = results differ, ? = a round has no result; click any cell to preview that round’s result rendered as Markdown',
            'The Rounds chips on the Compare tab show / hide a round (at least one is kept — hiding one just leaves the others)',
            'Tick the rounds in Export columns to place their results side by side in the exported table too',
          ],
    },
    {
      icon: 'fa fa-table',
      title: zh ? '结果页与导出 Excel' : 'Results & Export Excel',
      items: zh
        ? [
            '「结果」页就是导出预览（滚动到底会继续加载，每批 200 行，不再只预览前几行）：列完全由「任务 → 输出 → 导出列」决定，所见即所导',
            '结果页工具栏可搜索（任意列关键字）、按列筛选（值包含；只选列不填值 = 只看该列非空的行）与行号跳转（跳过去并高亮）；**导出仍然写全部行**，不受搜索 / 筛选影响',
            '「导出列」是一个竖向列表：点一下开关即选中 / 取消，按住左侧手柄上下拖动调整顺序（列表顺序就是导出表的列顺序）',
            '可勾选：原表列、运行信息（行号 / 任务指令 / 状态 / 错误 / Token / 起止时间 / 耗时 / 步数 / 重试 / 原始输出）、各轮结果；一项都没选时按默认列导出',
            '结果表有「任务行」列：点行号可直接跳到「详情」页并高亮该任务行（源表里删掉的行，结构化记录仍保留在结果里并标「已移除」）',
            '源表增删 / 改过行后：「详情」页点「同步源表」重读源表并按行指纹重新对位（不用重开任务）；工具栏的 «+新增 ~变更 -移除» 摘要里，点「新增 / 变更」直接在下方表格里筛选（再点一次取消）、悬停可看列级差异（新增 / 丢失 / 顺序）与对位说明，「移除」的行已不在表里（结果里去标「已移除」）；变化的行会标上「新增」/「已变更」（已变更 = 还是同一行、结果仍留在该行上，需要时重跑）；筛选面板的「增量」也能只看新增行 / 已变更行',
            '「清除结果」只清结果（每行结果 / 状态 / Token / 计时 / 过程快照 + 提取数据表），任务行与配置保留、行回到「待处理」可重跑',
            '结构化提取没解析出 JSON 的行不会丢：导出会自动补上「原始输出」列把这些行一并写出',
            '导出为 xlsx：单元格超过 Excel 上限（32767 字符）会自动截断并标注；**大表分片写入**（每 2000 行一片，片间让出界面）不会卡，状态栏最左侧显示「导出 x/y 行」进度',
          ]
        : [
            'The Results tab is the export preview (scroll to the bottom to keep loading, 200 rows per batch — no longer capped at the first few hundred): its columns come straight from Task → Output → Export columns — what you see is what you export',
            'Its toolbar can search all columns, filter by one column (value contains; column only = that column must not be empty) and jump to a row number (scrolls there and highlights it); **the export still writes every row**, unaffected by search / filter',
            'Export columns is a vertical list: click a row to switch it on / off, and drag the handle on its left to reorder (that order is the column order of the export)',
            'Available items: source columns, run info (row # / instruction / status / error / tokens / start / end / duration / steps / retry / raw output) and each round’s result; with nothing selected the default columns are used',
            'The results table has a “Task row” column: click the number to open that task row in the Details tab and highlight it (rows deleted from the source table keep their structured records here, marked “removed”)',
            'After the source table (or folder) changes, hit “Sync source” on the Details toolbar to re-read it and re-attach results by row fingerprint — no need to reopen the task; in the toolbar summary “+new ~changed -removed”, click “new” / “changed” to filter the table below (click again to clear) and hover for column-level differences (added / missing / reordered) plus the matching notes; “removed” rows are no longer in the table (results mark them “removed”); changed rows are badged “new” / “changed” (changed = same row, its result stays attached — rerun when you like); the “Delta” filter shows only new or changed rows',
            '“Clear results” removes results only (per-row result / status / tokens / timings / process snapshots plus the extracted dataset) — task rows and settings stay, and rows go back to Pending so they can run again',
            'Rows whose JSON could not be parsed are not lost: the export adds a “Raw output” column so they are written out too',
            'Exported as xlsx: cells beyond Excel’s limit (32767 characters) are truncated and flagged; big tables are written in chunks (2000 rows per chunk, yielding in between) so the app stays responsive, and the status bar shows “Exporting x/y rows”',
          ],
    },
    {
      icon: 'fa fa-sitemap',
      title: zh ? '图谱页与日志页' : 'Graph & logs tabs',
      items: zh
        ? [
            '「图谱」是投影视图：链接采集看爬取轨迹（页面之间谁发现谁，附深度分布），智能体任务看访问路径（每行的智能体 → 访问过的信源 / 调用的 MCP 服务）',
            '图谱可切换视图、设置节点上限、点图例把某类节点显示 / 隐藏；布局收敛后会自动把所有节点框进视口并居中（手动缩放 / 拖动后不再自动调整）',
            '图谱数据来自行过程快照：只有勾选「随任务文件保留 → 图谱数据」才会写进任务文件，重开后仍可查看',
            '「日志」页有主日志 + 每个并发智能体一个页签，可按级别 / 关键字过滤，工具栏右侧是「清空日志」',
          ]
        : [
            'The Graph tab is a projection: crawl trajectories for web collection (which page discovered which, plus a depth distribution) and access paths for agent rows (each row’s agent → sources it visited / MCP services it called)',
            'You can switch the view, cap the node count and click a legend dot to show / hide a node type; once the layout settles every node is framed and centred automatically (manual zoom / pan turns that off)',
            'Graph data comes from per-row process snapshots: only with “Keep in file → Graph data” ticked is it written into the task file and still viewable after reopening',
            'The Logs tab has the main log plus one tab per concurrent agent, filterable by level / keyword, with “Clear logs” at the right of the toolbar',
          ],
    },
    {
      icon: 'fa fa-microchip',
      title: zh ? '智能体能力' : 'Agent capability',
      text: helpTexts.value.capability,
    },
    {
      icon: 'fa fa-save',
      title: zh ? '保存与数据保留' : 'Saving & retention',
      items: zh
        ? [
            '「保存」把任务写回它的 .task 文件（含各轮配置、结果与行状态）；尚未关联文件的会先让你选保存位置；运行中保存的是当前快照',
            '实例栏的「保存」按钮作用于当前标签的任务；按住 Ctrl / ⌘ / Alt 点击则保存全部已打开实例',
            '「随任务文件保留」可勾选 图谱数据（行过程快照）与 运行日志；默认两者都不保留（任务文件更小）',
            '自动保存需先手动保存一次选定路径，间隔与开关显示在状态栏右侧',
            '「读取」可直接打开 .task 文件（含旧脚手架的批量智能体 / 表格定向推理 / 文件采集 / 链接采集任务，会自动转换）',
          ]
        : [
            'Save writes the task back to its .task file (each round’s settings, results and row statuses); if it has no file yet you pick a location first; saving while running stores the current snapshot',
            'The Save button on the instance bar acts on the current tab’s task; hold Ctrl / ⌘ / Alt to save every opened instance',
            '“Keep in file” can store Graph data (per-row process snapshots) and Run logs; both are off by default to keep the file small',
            'Auto-save needs one manual save to pick the path first; its interval and toggle are shown at the right of the status bar',
            'Open loads a .task file directly (including legacy Batch Agent / Table Reasoning / Collect File / Collect Web tasks, converted automatically)',
          ],
    },
    {
      icon: 'fa fa-info-circle',
      title: zh ? '底部状态栏' : 'Status bar',
      items: zh
        ? [
            '最左：运行状态（转圈 + 「执行中…」）与保存反馈（保存中 / 已保存 / 已取消 / 失败，几秒后自动消失，悬停看失败详情）',
            '中间：待处理 / 执行中 / 已完成 / 失败 / 跳过 的计数圆点',
            '右侧：Token（输入 ↑ / 输出 ↓ / 合计）、耗时与预计剩余时间、自动保存、筛选命中计数',
          ]
        : [
            'Left: run status (spinner + “running…”) and save feedback (saving / saved / canceled / failed — it clears itself after a few seconds, hover for the failure detail)',
            'Middle: pending / running / completed / failed / skipped counters',
            'Right: tokens (in ↑ / out ↓ / total), elapsed time and ETA, auto-save, filter hit count',
          ],
    },
  ]
})

const templateTextarea = ref<HTMLTextAreaElement | null>(null)
const insertPlaceholder = (name: string) => {
  const token = `{{${name}}}`
  const el = templateTextarea.value
  if (el) {
    const start = el.selectionStart ?? config.template.length
    const end = el.selectionEnd ?? config.template.length
    config.template = config.template.slice(0, start) + token + config.template.slice(end)
    nextTick(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  } else {
    config.template += token
  }
}

const renderRowPrompt = (row: BatchRow, index: number): string =>
  renderTemplate(config.template, rowRenderData(row, index), index, config.keepUnmatched)

const rowTitle = (row: BatchRow): string => {
  const first = Object.values(row.data || {})[0]
  const title = first !== undefined && first !== null && String(first).trim() ? String(first) : '(空)'
  return `${title.slice(0, 40)}`
}

// ====== 状态统计（O(1) 增量维护，避免 10w+ 行每次状态变化全量过滤） ======
const statusCounts = reactive({ pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 })
const recountRows = () => {
  const c = { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 }
  for (const r of rows.value) c[r.status] = (c[r.status] || 0) + 1
  Object.assign(statusCounts, c)
}
const applyStatusChange = (from: BatchRowStatus, to: BatchRowStatus) => {
  if (from === to) return
  if (statusCounts[from] > 0) statusCounts[from]--
  statusCounts[to]++
}
const processedRows = computed(() => statusCounts.completed + statusCounts.failed + statusCounts.skipped)
const completedRows = computed(() => statusCounts.completed)
const failedRows = computed(() => statusCounts.failed)
// 底部状态栏逐状态统计：待处理 / 执行中 / 已完成 / 失败 / 跳过（各自独立计数）
const pendingRows = computed(() => statusCounts.pending)
const runningRows = computed(() => statusCounts.running)
const skippedRows = computed(() => statusCounts.skipped)

/**
 * 实例任务状态上报（实例栏据此决定显示 / 隐藏「开始」「暂停」按钮）：
 * 待处理行数变化（导入表格 / 扫描文件夹 / 跑完 / 停止 / 重置）与运行状态变化都要同步一次。
 */
watch(
  [pendingRows, runningRows, () => rows.value.length, isRunning],
  () => {
    reportInstanceState(instanceKey.value, {
      pending: pendingRows.value,
      runningRows: runningRows.value,
      rows: rows.value.length,
      canStart: !isRunning.value && pendingRows.value > 0,
    })
  },
  { immediate: true },
)

const statusIcon = (status: BatchRowStatus): string => {
  const map: Record<string, string> = {
    pending: 'fa fa-hourglass-o',
    running: 'fa fa-spinner fa-spin',
    completed: 'fa fa-check-circle',
    failed: 'fa fa-times-circle',
    skipped: 'fa fa-forward',
  }
  return map[status] || 'fa fa-circle-o'
}
const getStatusTooltip = (status: BatchRowStatus): string => {
  const map: Record<string, string> = en()
    ? { pending: 'Pending', running: 'Running', completed: 'Completed', failed: 'Failed', skipped: 'Skipped' }
    : { pending: '待处理', running: '执行中', completed: '已完成', failed: '失败', skipped: '已跳过' }
  return map[status] || status
}
/** 状态 hover 提示：失败行附带失败原因（鼠标悬停状态图标查看） */
const rowStatusTitle = (row: BatchRow): string => {
  const base = getStatusTooltip(row.status)
  if (row.status === 'failed' && String(row.error || '').trim()) return `${base}：${row.error}`
  return base
}
const toolStatusIcon = (status: string): string => {
  const map: Record<string, string> = { running: 'fa fa-spinner fa-spin', success: 'fa fa-check-circle', error: 'fa fa-times-circle' }
  return map[status] || 'fa fa-circle-o'
}

// ====== Token 统计 ======
const tokenInfo = reactive({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
// 本次运行前已累计的 token 基数（读取任务/上次运行后保留，本次运行在其上继续累计）
let tokenBaseInput = 0
let tokenBaseOutput = 0
const formatTokenCount = (n: number): string => {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

// ====== 任务计时 ======
const taskStartTime = ref<number | null>(null)
const elapsedBeforePause = ref(0)
const segmentStartProcessed = ref(0)
const elapsedDisplay = ref('00:00')
const etaDisplay = ref('')
let timerInterval: ReturnType<typeof setInterval> | null = null

const formatDuration = (ms: number): string => {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
const getElapsedMs = (): number => {
  let totalMs = elapsedBeforePause.value
  if (taskStartTime.value !== null) totalMs += Date.now() - taskStartTime.value
  return totalMs
}
const getSegmentElapsedMs = (): number => {
  if (taskStartTime.value === null) return 0
  return Date.now() - taskStartTime.value
}
const startTimer = () => {
  stopTimer()
  // 保留已累计时间（elapsedBeforePause 不清零），本次运行在其上继续累计
  segmentStartProcessed.value = processedRows.value
  taskStartTime.value = Date.now()
  updateTimerDisplay()
  timerInterval = setInterval(updateTimerDisplay, 1000)
}
const stopTimer = () => {
  if (timerInterval !== null) {
    // 把本次运行已耗时累计进 elapsedBeforePause，供下次运行/读取任务延续
    elapsedBeforePause.value = getElapsedMs()
    clearInterval(timerInterval)
    timerInterval = null
  }
  taskStartTime.value = null
}
const updateTimerDisplay = () => {
  elapsedDisplay.value = formatDuration(getElapsedMs())
  const total = rows.value.length
  const processed = processedRows.value
  // 预计剩余毫秒（null = 尚在估算）：状态栏与托盘悬停提示共用
  let etaMs: number | null = null
  if (total > 0 && processed < total) {
    const segProcessed = processed - segmentStartProcessed.value
    const segElapsed = getSegmentElapsedMs()
    if (segProcessed > 0 && segElapsed > 0) etaMs = (segElapsed / segProcessed) * (total - processed)
  } else if (total > 0 && processed >= total) {
    etaMs = 0
  }
  etaDisplay.value = etaMs == null ? '' : formatDuration(etaMs)
  reportInstanceProgress(instanceKey.value, processed, total, etaMs)
}

// ====== 日志 ======
let lastToastMessage = ''
let lastToastTime = 0
let logSeq = 0
const addLog = (level: string, message: string, workerId?: number, detail?: string) => {
  logs.value.push({ seq: ++logSeq, time: new Date().toLocaleTimeString(), level, message, detail, workerId })
  if (logs.value.length > 1000) logs.value = logs.value.slice(-500)
  if (level === 'error' || level === 'warning') {
    // 工具调用失败的详细日志（如 web_fetch: 抓取失败 HTTP 403）只在日志区展示，不弹 toast，避免批量运行刷屏
    if (level === 'error' && message.includes('✔ 工具')) return
    const now = Date.now()
    if (message !== lastToastMessage || now - lastToastTime > 3000) {
      lastToastMessage = message
      lastToastTime = now
      if (level === 'error') ElMessage.error(message)
      else ElMessage.warning(message)
    }
  }
}
const clearLogs = () => { logs.value = []; mainLogStart.value = -1; workerLogStart.value = -1 }

// ====== 日志窗口式渲染（DOM 里只保留最后 LOG_WINDOW 条；向上滚动再按块前移） ======
// 批量运行日志可达上千条（线程日志更无上限），全量渲染会随每条新日志做整表 diff → 卡顿
const LOG_WINDOW = 200
/** 单条日志高度估算（仅用于「上方已折叠」的占位高度，真实定位靠实测补偿校正） */
const EST_LOG_H = 20
/** 窗口起点：-1 = 跟随末尾（新日志自动滚到最新）；>= 0 = 用户上翻后冻结的绝对下标 */
const logWinStartIdx = (len: number, start: number): number =>
  len <= LOG_WINDOW ? 0 : (start < 0 ? len - LOG_WINDOW : Math.max(0, Math.min(start, len - 1)))
const logWinSlice = <T,>(arr: T[], start: number): T[] => {
  const s = logWinStartIdx(arr.length, start)
  return arr.slice(s, Math.min(arr.length, s + LOG_WINDOW))
}
const logWinHidden = (len: number, start: number): number => (len <= LOG_WINDOW ? 0 : logWinStartIdx(len, start))

const mainLogStart = ref(-1)
const workerLogStart = ref(-1)

// ---- 日志过滤：级别（带计数徽标）+ 关键字搜索（主日志与线程日志共用） ----
const logLevelOptions = [
  { value: 'error', labelZh: '错误', labelEn: 'Error' },
  { value: 'warning', labelZh: '警告', labelEn: 'Warning' },
  { value: 'success', labelZh: '成功', labelEn: 'Success' },
  { value: 'info', labelZh: '信息', labelEn: 'Info' },
]
const logLevels = ref<string[]>([])
const logKeyword = ref('')
const debouncedLogKeyword = ref('')
let logKwTimer: ReturnType<typeof setTimeout> | null = null
watch(logKeyword, (v) => {
  if (logKwTimer) clearTimeout(logKwTimer)
  logKwTimer = setTimeout(() => { debouncedLogKeyword.value = v }, 200)
})
/** 切换级别过滤（空 = 全部级别）；过滤变化后回到「跟随末尾」 */
const toggleLogLevel = (lv: string) => {
  const i = logLevels.value.indexOf(lv)
  if (i >= 0) logLevels.value.splice(i, 1)
  else logLevels.value.push(lv)
  mainLogStart.value = -1
  workerLogStart.value = -1
}
watch(debouncedLogKeyword, () => { mainLogStart.value = -1; workerLogStart.value = -1 })
const logPassKw = (l: any, kw: string): boolean => !kw || String(l?.message || '').toLowerCase().includes(kw)
/** 逐级别计数（只应用关键字，方便看出各还剩多少） */
const logCounts = computed(() => {
  const arr: any[] = logTab.value === 'main' ? logs.value : currentWorkerLogs.value
  const kw = debouncedLogKeyword.value.trim().toLowerCase()
  const c: Record<string, number> = { error: 0, warning: 0, success: 0, info: 0 }
  for (const l of arr) if (logPassKw(l, kw)) c[l.level] = (c[l.level] || 0) + 1
  return c
})
/** 过滤后的下标数组：只存下标（零对象分配），视图对象只对渲染窗口内的条目构造 */
const buildLogIdx = (arr: any[]): number[] => {
  const levels = logLevels.value
  const kw = debouncedLogKeyword.value.trim().toLowerCase()
  if (!levels.length && !kw) { const all = new Array<number>(arr.length); for (let i = 0; i < arr.length; i++) all[i] = i; return all }
  const out: number[] = []
  for (let i = 0; i < arr.length; i++) {
    const l = arr[i]
    if (levels.length && !levels.includes(l?.level)) continue
    if (!logPassKw(l, kw)) continue
    out.push(i)
  }
  return out
}
const mainLogIdx = computed(() => buildLogIdx(logs.value))
const workerLogIdx = computed(() => buildLogIdx(currentWorkerLogs.value))

/** 日志行类型：row = [行N] 开头（行级）；step = 带缩进的步骤级（💭🧰✔）；其余为系统级 */
type LogViewItem = { key: string; log: any; kind: 'row' | 'step' | 'sys'; rowNo: number; text: string; detail: string; long: boolean }
const toLogViewItem = (l: any, key: string): LogViewItem => {
  const m = String(l?.message || '')
  const rm = /^\s*\[行(\d+)\]\s*/.exec(m)
  const kind: LogViewItem['kind'] = rm ? 'row' : (/^\s{2,}/.test(m) ? 'step' : 'sys')
  const detail = String(l?.detail || '')
  return {
    key, log: l, kind,
    rowNo: rm ? Number(rm[1]) : 0,
    text: rm ? m.slice(rm[0].length) : m.trimStart(),
    detail,
    // 长消息或有 detail（工具结果等被截断的内容）都可以展开看全文
    long: m.length > 80 || detail.length > 0,
  }
}

const visibleLogs = computed(() => logWinSlice(mainLogIdx.value, mainLogStart.value).map(i => toLogViewItem(logs.value[i], `m${logs.value[i]?.seq ?? i}`)))
const mainLogWinStart = computed(() => logWinStartIdx(mainLogIdx.value.length, mainLogStart.value))
const mainLogHiddenAbove = computed(() => logWinHidden(mainLogIdx.value.length, mainLogStart.value))
const mainLogSpacerHeight = computed(() => mainLogHiddenAbove.value * EST_LOG_H)

const visibleWorkerLogs = computed(() => logWinSlice(workerLogIdx.value, workerLogStart.value).map(i => toLogViewItem(currentWorkerLogs.value[i], `w${i}`)))
const workerLogWinStart = computed(() => logWinStartIdx(workerLogIdx.value.length, workerLogStart.value))
const workerLogHiddenAbove = computed(() => logWinHidden(workerLogIdx.value.length, workerLogStart.value))
const workerLogSpacerHeight = computed(() => workerLogHiddenAbove.value * EST_LOG_H)

// ---- 长文本折叠（默认一行）----
const expandedLogs = ref<Set<string>>(new Set())
const toggleLogExpand = (key: string) => {
  const s = new Set(expandedLogs.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  expandedLogs.value = s
}
// ---- 日志行号 → 表格跳转 ----
const logLevelText = (lv: string): string => {
  const zh: Record<string, string> = { error: '错误', warning: '警告', success: '成功', info: '信息' }
  const enMap: Record<string, string> = { error: 'ERR', warning: 'WARN', success: 'OK', info: 'INFO' }
  return (en() ? enMap : zh)[lv] || lv
}
/** 点日志里的 #行N → 跳到表格该行并高亮（复用 jumpToRow 的清筛选 + 定位逻辑） */
const jumpToLogRow = async (n: number) => {
  if (!n) return
  jumpInput.value = String(n)
  await jumpToRow()
}

/** 向上展开一屏日志：用首条已渲染日志的实测位移补偿 scrollTop，已看到的内容不跳动 */
let logExpandBusy = false
const expandLogWindow = async (kind: 'main' | 'worker') => {
  if (logExpandBusy) return
  const el = kind === 'main' ? mainLogRef.value : workerLogRef.value
  const len = kind === 'main' ? mainLogIdx.value.length : workerLogIdx.value.length
  const start = kind === 'main' ? mainLogStart.value : workerLogStart.value
  if (!el || logWinHidden(len, start) <= 0) return
  logExpandBusy = true
  try {
    const first = el.querySelector<HTMLElement>('[data-log-key]')
    const anchorKey = first?.dataset.logKey || ''
    const anchorTop = first ? first.getBoundingClientRect().top : 0
    const scrollTop = el.scrollTop
    const s = logWinStartIdx(len, start)
    if (kind === 'main') mainLogStart.value = Math.max(0, s - LOG_WINDOW)
    else workerLogStart.value = Math.max(0, s - LOG_WINDOW)
    await nextTick()
    if (!anchorKey) return
    const anchor = el.querySelector<HTMLElement>(`[data-log-key="${anchorKey}"]`)
    if (!anchor) return
    const delta = anchor.getBoundingClientRect().top - anchorTop
    if (delta) el.scrollTop = scrollTop + delta
  } finally { logExpandBusy = false }
}

// ====== 日志自动滚动 ======
const mainLogRef = ref<HTMLElement | null>(null)
const workerLogRef = ref<HTMLElement | null>(null)
const mainLogAutoScroll = ref(true)
const workerLogAutoScroll = ref(true)
const scrollLogToBottom = (el: HTMLElement | null) => { if (el) el.scrollTop = el.scrollHeight }
/** 日志滚动：到底 → 恢复跟随末尾；接近顶部 → 冻结当前窗口并向前展开 */
const onMainLogScroll = () => {
  const el = mainLogRef.value
  if (!el) return
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
  mainLogAutoScroll.value = atBottom
  if (atBottom) { mainLogStart.value = -1; return }
  if (el.scrollTop < 60) {
    if (mainLogStart.value < 0) mainLogStart.value = mainLogWinStart.value
    expandLogWindow('main')
  }
}
/** 日志滚动：到底 → 恢复跟随末尾；接近顶部 → 冻结当前窗口并向前展开 */
const onWorkerLogScroll = () => {
  const el = workerLogRef.value
  if (!el) return
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
  workerLogAutoScroll.value = atBottom
  if (atBottom) { workerLogStart.value = -1; return }
  if (el.scrollTop < 60) {
    if (workerLogStart.value < 0) workerLogStart.value = workerLogWinStart.value
    expandLogWindow('worker')
  }
}
watch(() => logs.value.length, () => {
  if (logs.value.length === 0) { mainLogStart.value = -1; return }
  if (mainLogAutoScroll.value && logTab.value === 'main') nextTick(() => scrollLogToBottom(mainLogRef.value))
})
watch(() => currentWorkerLogs.value.length, () => {
  if (workerLogAutoScroll.value && logTab.value !== 'main') nextTick(() => scrollLogToBottom(workerLogRef.value))
})
watch(logTab, (tab) => {
  if (tab === 'main') { mainLogAutoScroll.value = true; mainLogStart.value = -1; nextTick(() => scrollLogToBottom(mainLogRef.value)) }
  else { workerLogAutoScroll.value = true; workerLogStart.value = -1; nextTick(() => scrollLogToBottom(workerLogRef.value)) }
})

// ====== 实时视图（选中行详情：流式输出 + 工具调用） ======
const selectedRowId = ref<string | null>(null)
const showRowDetail = ref(false)
/** 行详情页签（任务 / 过程 / 输出）：**不随打开其他行重置**，连续核对多行时停在同一页签 */
const DETAIL_TABS = [
  { key: 'task' as const, zh: '任务', en: 'Task', icon: 'fa-file-text-o', hintZh: '占位符替换后真正发给该行的任务', hintEn: 'The prompt actually sent for this row (after placeholder substitution)' },
  { key: 'process' as const, zh: '过程', en: 'Process', icon: 'fa-sitemap', hintZh: '推理步骤与工具调用（运行中实时更新；会话结束后不可用）', hintEn: 'Reasoning steps and tool calls (live while running; unavailable after the session ends)' },
  { key: 'output' as const, zh: '输出', en: 'Output', icon: 'fa-commenting-o', hintZh: '提取数据 / 写回列 / 结果文本，可编辑', hintEn: 'Extracted data / written-back columns / result text — editable' },
]
const detailTab = ref<'task' | 'process' | 'output'>('task')
// 按 id 从当前 rows 动态解析：rows 数组被替换/行数据更新时始终指向最新行；
// computed 惰性——agent 就地修改行（rows 引用与 id 不变）不会触发重算，10w+ 行仍 O(1)
const selectedRow = computed(() => {
  const id = selectedRowId.value
  if (!id) return null
  return rows.value.find(r => r.id === id) || null
})
type LiveToolCall = {
  callId: string
  name: string
  status: string
  /** 工具参数（对象已格式化为 JSON 文本） */
  argsText: string
  /** 工具结果（或错误文本） */
  resultText: string
  /** 结果是否被字符上限截断 */
  resultTruncated: boolean
}
const live = reactive({
  status: '',
  stream: '',
  steps: [] as Array<{ reasoning: string; content: string; toolCalls: LiveToolCall[] }>,
  // 服务端联网搜索（DeepSeek Responses）状态：phase = '' | 'searching' | 'done'
  webSearch: { active: false, phase: '', query: '', resultsCount: 0 },
})
// 运行中输出的「渲染用」文本：流式事件是逐 token 通知的，每个 token 都让 BlockMd 整篇重渲染会卡，
// 所以节流到 ~150ms 再交给 Markdown 渲染（视觉上仍是流式；清空时立即生效，避免切行时闪现旧内容）
const liveStreamMd = ref('')
let liveStreamTimer: ReturnType<typeof setTimeout> | null = null
watch(() => live.stream, (v: string) => {
  if (!v) {
    if (liveStreamTimer) { clearTimeout(liveStreamTimer); liveStreamTimer = null }
    liveStreamMd.value = ''
    return
  }
  if (liveStreamTimer) return
  liveStreamTimer = setTimeout(() => {
    liveStreamTimer = null
    liveStreamMd.value = live.stream
  }, 150)
})
/** 工具参数/结果块的展开状态（按 callId）：默认只露几行，点击看全文 */
const expandedToolKeys = ref<Set<string>>(new Set())
const toggleToolExpand = (callId: string) => {
  const s = new Set(expandedToolKeys.value)
  if (s.has(callId)) s.delete(callId)
  else s.add(callId)
  expandedToolKeys.value = s
}
/** 工具状态文字（与 home.vue 的工具盒子一致的四种） */
const toolStateLabel = (status: string): string => {
  const map: Record<string, [string, string]> = {
    running: ['执行中', 'running'],
    success: ['成功', 'success'],
    error: ['失败', 'error'],
  }
  const hit = map[status]
  if (hit) return en() ? hit[1] : hit[0]
  return en() ? 'pending' : '等待'
}
/** 折叠态单行摘要：优先参数（去换行压成一行），没有参数就用结果；过长截断（悬停看全） */
const toolCallPreview = (tc: { argsText?: string; resultText?: string }): string => {
  const oneLine = (t?: string) => String(t || '').replace(/\s+/g, ' ').trim()
  const src = oneLine(tc.argsText) || oneLine(tc.resultText)
  if (!src) return ''
  return src.length > 200 ? src.slice(0, 200) + '…' : src
}
/** 值 → 展示文本：对象格式化为多行 JSON；超过 limit 截断并标记 */
const liveText = (v: any, limit = 4000): { text: string; truncated: boolean } => {
  if (v === null || v === undefined || v === '') return { text: '', truncated: false }
  let s: string
  if (typeof v === 'string') s = v
  else { try { s = JSON.stringify(v, null, 2) } catch { s = String(v) } }
  s = s.trim()
  return s.length > limit ? { text: s.slice(0, limit), truncated: true } : { text: s, truncated: false }
}
/** 过程里的工具调用总数（过程区标题里显示） */
const processToolCount = computed(() => live.steps.reduce((n, s) => n + (s.toolCalls?.length || 0), 0))
/** 选中行的原始下标（-1 = 无）：用 rowNoMap O(1) 查表，代替 rows.indexOf 的全表扫描 */
const selectedRowIndex = computed(() => {
  const row = selectedRow.value
  if (!row) return -1
  return (rowNoMap.value.get(row.id) ?? 0) - 1
})
// 服务端搜索事件消费游标：仅在选中同一 viewId 时自增；切换选中行/无选中时归零
let liveViewId = ''
let liveSearchConsumed = 0
const resetLiveWebSearch = () => {
  live.webSearch.active = false
  live.webSearch.phase = ''
  live.webSearch.query = ''
  live.webSearch.resultsCount = 0
  liveSearchConsumed = 0
}
const usageSeen = new Map<string, any>()
// viewId → 行（O(1) 查找，避免监听器每次事件全表 find）
const viewRowMap = new Map<string, BatchRow>()
// 行点击 = 打开行详情；但「拖动 / 划选」不应触发（共享判定见 utils/clickGuard）
const rowClickGuard = createDragGuard()
const onRowMouseDown = (e: MouseEvent) => rowClickGuard.onMouseDown(e)
const onRowClick = (id: string, e: MouseEvent) => {
  if (!rowClickGuard.isRealClick(e)) return
  selectRow(id)
}
// 行详情弹窗：点遮罩空白处关闭；拖动划选文字后松手落在遮罩上时不应误关
const modalClickGuard = createDragGuard()
const onModalMouseDown = (e: MouseEvent) => modalClickGuard.onMouseDown(e)
const onOverlayClick = (e: MouseEvent) => {
  if (!modalClickGuard.isRealClick(e)) return
  closeRowDetail()
}
const selectRow = (id: string) => {
  selectedRowId.value = id
  showRowDetail.value = true
  rowDetailEditing.value = false
  // 工具详情块重置；页签保持上次选择（不重置 detailTab，方便连续查看多行的同一类信息）
  expandedToolKeys.value = new Set()
  syncLiveForSelected()
}
const closeRowDetail = () => {
  showRowDetail.value = false
  selectedRowId.value = null
  rowDetailEditing.value = false
}
const syncLiveForSelected = () => {
  const row = selectedRow.value
  if (!row) {
    live.status = ''
    live.stream = ''
    live.steps = []
    resetLiveWebSearch()
    return
  }
  const view: any = row.viewId ? agentBridge.get(row.viewId) : null
  if (view) {
    // 切换了选中行 → 重置服务端搜索状态并重新消费新 view 的事件队列
    if (liveViewId !== row.viewId) {
      liveViewId = String(row.viewId)
      resetLiveWebSearch()
    }
    syncLiveFromView(view)
    return
  }
  // 会话已结束（view 已销毁）→ 用行上留的过程快照回看；纯内存，重启/读取任务后不可用
  live.status = ''
  live.stream = ''
  live.steps = (row.trace || []).map((s: any) => ({
    reasoning: s.reasoning || '',
    content: s.content || '',
    toolCalls: (s.toolCalls || []).map((t: any): LiveToolCall => ({
      callId: String(t.callId || ''),
      name: String(t.name || ''),
      status: String(t.status || ''),
      argsText: String(t.args || ''),
      resultText: String(t.result || ''),
      resultTruncated: /…$/.test(String(t.result || '')),
    })),
  }))
  resetLiveWebSearch()
}
const syncLiveFromView = (view: any) => {
  live.status = view.status
  live.stream = view.currentStream || ''
  // 过程全量映射：每步推理/正文 + 每次工具调用的参数、结果（或错误）
  live.steps = (view.steps || []).map((s: any) => ({
    reasoning: s.reasoning || '',
    content: s.content || '',
    toolCalls: (s.toolCalls || []).map((t: any): LiveToolCall => {
      const args = liveText(t.args, 2000)
      const raw = t.status === 'error' ? (t.error || t.result) : t.result
      const res = liveText(raw, 4000)
      return {
        callId: String(t.callId || ''),
        name: String(t.name || ''),
        status: String(t.status || ''),
        argsText: args.text,
        resultText: res.text,
        resultTruncated: res.truncated,
      }
    }),
  }))
  // 服务端联网搜索（deepseek-responses）：增量消费事件队列 → 展示“正在联网搜索/搜到 N 条链接”
  const events: any[] = view.searchEvents || []
  if (events.length < liveSearchConsumed) liveSearchConsumed = 0
  if (events.length > liveSearchConsumed) {
    for (let i = liveSearchConsumed; i < events.length; i++) {
      const ev = events[i]
      if (!ev) continue
      if (ev.kind === 'search') {
        live.webSearch.active = true
        live.webSearch.phase = 'searching'
        live.webSearch.query = String(ev.query || '').trim()
      } else if (ev.kind === 'open') {
        live.webSearch.active = true
      } else if (ev.kind === 'done') {
        live.webSearch.active = true
        live.webSearch.phase = 'done'
        live.webSearch.resultsCount = Array.isArray(ev.results) ? ev.results.length : 0
        if (ev.query) live.webSearch.query = String(ev.query).trim()
      }
    }
    liveSearchConsumed = events.length
  }
}
let liveUnsub: (() => void) | null = null

// ====== Agent 实例 ======
let agent: BatchAgent | null = null

// ==================== 运行 / 停止 ====================
/** 运行中调整并发：调高立即放行排队行，调低等当前任务收敛；并同步主进程远端并发声明 */
const onConcurrencyChange = () => {
  const n = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(Number(config.concurrency) || 1)))
  config.concurrency = n
  if (isRunning.value && agent) agent.setConcurrency(n)
}

/**
 * 启动/续跑批量执行。
 * @param onlyRowIds 选区执行：只跑这些行（表里其它待处理行保持不动）——「精确重跑某段」靠它实现
 */
const startBatch = async (onlyRowIds?: Set<string>) => {
  if (isRunning.value || isLoading.value) return
  if (isAgentMode.value && !agentBridge.available) {
    addLog('error', en() ? 'Agent execution requires the desktop app' : '智能体执行仅桌面版支持')
    return
  }
  if (isAgentMode.value) {
    if (!config.template.trim()) { addLog('error', en() ? 'Please fill the task instruction' : '请先填写任务指令'); return }
    if (agentStructured.value && !(config.schema || []).some(f => f.name.trim())) {
      addLog('error', en() ? 'Structured output needs at least one extract field' : '结构化输出请先配置至少一个提取字段')
      return
    }
  } else if (isLlmMode.value) {
    // 纯 LLM 推理：校验任务指令与输出字段（执行器内部还会再校验一次）
    if (!config.template.trim()) { addLog('error', en() ? 'Please fill the task instruction' : '请先填写任务指令'); return }
    if (!(config.schema || []).some(f => f.name.trim())) { addLog('error', en() ? 'Add at least one output field' : '请先在「输出字段」里添加至少一个字段'); return }
  } else if (isExtractMode.value) {
    // 采集类：校验任务行（扫描 / 文本生成）与提取字段
    if (!rows.value.length) {
      addLog('error', isTextSource.value
        ? (en() ? 'Create task rows from the text first' : '请先按行生成任务行')
        : isFolderSource.value
          ? (en() ? 'Scan a folder to create task rows first' : '请先扫描文件夹生成任务行')
          : (en() ? 'Import a table first' : '请先导入表格'))
      return
    }
    if (!(config.schema || []).some(f => f.name.trim())) { addLog('error', en() ? 'Configure at least one extract field' : '请先配置至少一个提取字段'); return }
  }
  if (rows.value.length === 0) { addLog('error', en() ? 'Please import a table first' : '请先导入表格'); return }
  const inScope = (r: BatchRow) => !onlyRowIds || onlyRowIds.has(r.id)
  if (!rows.value.some(r => inScope(r) && r.status === 'pending')) {
    addLog('warning', onlyRowIds
      ? (en() ? 'No pending rows in the selected scope' : '选区内没有待处理的行')
      : (en() ? 'No pending rows' : '没有待处理的行'))
    return
  }
  if (unusedPlaceholders.value.length) {
    addLog('warning', en() ? `Unmatched placeholders: ${unusedPlaceholders.value.join(', ')}` : `未匹配列名的占位符: ${unusedPlaceholders.value.join(', ')}`)
  }

  logs.value = []
  // 新一批开始：日志窗口回到「跟随末尾」
  mainLogStart.value = -1
  workerLogStart.value = -1
  // 保留读取任务/上次运行已累计的 token 与时间作为基数，本次运行在其上继续累计（不重置）
  tokenBaseInput = tokenInfo.inputTokens
  tokenBaseOutput = tokenInfo.outputTokens

  // 跨轮引用：把「第N轮.结果 / 第N轮.字段」按行解析成虚拟列（与行数据合并后当占位符用）
  rows.value.forEach((r, i) => { r.roundRefs = buildRowRoundRefs(i, rowOriginIndex(r, i)) })
  // 本次要跑的行：清掉「源表增量」标记（已重新执行，增量已消化）
  for (const r of rows.value) if (inScope(r) && r.delta) r.delta = undefined
  agent = new BatchAgent(config as any, store, {
    // 行对象本身是响应式代理，agent 就地修改即可驱动 UI，无需整表替换（避免 O(N) 级联重算）
    onRowUpdate: () => { /* no-op */ },
    onStatusChange: (_rowId, from, to) => applyStatusChange(from, to),
    onRowSessionStart: (row, viewId) => { viewRowMap.set(viewId, row) },
    onRowSessionEnd: (_row, viewId) => { viewRowMap.delete(viewId); usageSeen.delete(viewId) },
    // 进度数字已由状态栏左侧圆点统计体现，这里只保留「执行中」状态文字
    onProgress: () => {
      statusText.value = en() ? 'Running...' : '执行中...'
    },
    onLog: (level, message, workerId, detail) => addLog(level, message, workerId, detail),
    onWorkerUpdate: (workerList) => { workers.value = workerList },
    onTokenUsage: (i, o, t) => {
      tokenInfo.inputTokens = tokenBaseInput + i
      tokenInfo.outputTokens = tokenBaseOutput + o
      tokenInfo.totalTokens = tokenInfo.inputTokens + tokenInfo.outputTokens
    },
    // 成功/失败/跳过 数量已由状态栏左侧圆点显示，这里只提示整体完成
    onAllDone: () => {
      statusText.value = en() ? 'Done' : '执行完成'
    },
    // 提取数据集更新（sink=dataRows）：拷贝到响应式 ref，供数据视图渲染与任务文件保存
    onDatasetUpdate: (ds) => { datasetRows.value = [...ds] },
    // 爬取中发现的新页面行（runner 已 push 进 rows）：O(1) 维护待处理计数与提示
    onRowsAdded: (added) => {
      statusCounts.pending += added.length
      statusText.value = en() ? `Discovered ${added.length} new page(s), queued` : `发现 ${added.length} 个新页面，已加入队列`
    },
  }, { dataset: datasetRows.value })

  isRunning.value = true
  statusText.value = en() ? 'Running...' : '执行中...'
  if (activeRound.value) addLog('info', en() ? `Round: ${activeRound.value.label}` : `当前轮次：${activeRound.value.label}`)
  startTimer()

  try {
    const result = await agent.start(rows.value, onlyRowIds)
    if (!result.success) {
      statusText.value = en() ? `Error: ${result.error}` : `执行失败: ${result.error}`
      addLog('error', result.error || '')
    } else {
      reportUnparsedStructuredRows()
    }
  } catch (error: any) {
    statusText.value = `${en() ? 'Error' : '出错'}: ${error.message}`
    addLog('error', `执行出错: ${error.message}`)
  } finally {
    isRunning.value = false
    agent = null
    stopTimer()
  }
}

/**
 * 结构化提取跑完后的汇总提示：有多少行「模型答了、但没解析出记录」。
 * 这些行以前会被静默丢弃（不出现在数据表与导出里），现在原文保留在行上、导出自动带出，但仍应告知用户。
 */
const reportUnparsedStructuredRows = () => {
  if (outputMode.value !== 'structured') return
  const n = rows.value.filter(r => r.status === 'completed' && !(r.extracted && r.extracted.length) && safeExportString(r.result) !== '').length
  if (!n) return
  addLog('warning', en()
    ? `${n} row(s) produced no structured records (the model did not return valid JSON) — their raw output is kept on the row and will be added to the export automatically`
    : `有 ${n} 行没有解析出结构化数据（模型未返回合法 JSON）——原文已保留在该行，导出会自动带上「原始输出」列`)
  ElMessage.warning(en()
    ? `${n} row(s) failed JSON parsing — raw output kept (export adds a “Raw output” column)`
    : `${n} 行未解析出结构化数据——原文已保留，导出会自动带上「原始输出」列`)
}

const stopBatch = () => {
  if (agent) {
    agent.stop()
    statusText.value = en() ? 'Stopped — click ▶ to resume' : '已停止 — 点击 ▶ 续跑'
    addLog('info', en() ? 'Execution stopped' : '执行已停止')
  }
}

// ==================== 行操作 ====================
const rerunRow = (row: BatchRow) => {
  if (row.status === 'running') {
    addLog('warning', en() ? 'Row is running, cannot rerun now' : '该行正在执行中，无法立即重跑')
    return
  }
  if (isRunning.value && agent) {
    // 运行中：交给调度器优先重跑（当前某一线程一空闲立即执行，无需排队等整批结束）
    const ok = agent.requestRerun(row)
    if (!ok) addLog('warning', en() ? 'Rerun rejected (batch stopped or row busy)' : '重跑未受理（可能批量已停止或该行执行中）')
    return
  }
  // 未运行：把该行置为待处理，并**只启动这一行**（选区执行；其它待处理行保持不动——
  // 之前这里调的是 startBatch()，会把所有待处理行一起跑起来）
  applyStatusChange(row.status, 'pending')
  row.status = 'pending'
  // 保留旧结果：跑出新结果后再替换，不提前清空结果
  row.error = undefined
  row.retryCount = 0
  row.emptyRetryCount = 0
  startBatch(new Set([row.id]))
}

// ====== 重跑 ======
// 设计：筛选（Filter）只管「看到什么」；重跑对象就是当前筛选命中行（面板内一键）。
// 运行中 → 交给调度器优先队列立即执行；未运行 → 命中行置待处理后按选区启动。
/** 行详情底部的状态下拉：不允许手动选「执行中」（执行中的行整体禁止改动） */
const detailStatusOptions = computed(() => {
  const base = statusOptions.value.filter(o => o.value !== 'running')
  const cur = selectedRow.value?.status
  return cur === 'running'
    ? [{ value: 'running' as BatchRowStatus, label: en() ? 'Running' : '执行中' }, ...base]
    : base
})
const detailStatusTitle = computed(() => en()
  ? 'Change this row’s status — results are kept. “Pending” = to-run: press Start on the Task tab to run it (a rerun is simply Pending + Start). Running rows cannot be changed.'
  : '直接改这一行的状态（已有结果不动）——「待处理」即待执行：回「任务」页点启动就会跑它（重跑 = 置为待处理 + 启动）；执行中的行不能改。')
/** 行详情「停止」是否可用：仅该行正在执行中（排队中的行可用状态下拉选「跳过」移出） */
const canStopRowDetail = computed(() => {
  const row = selectedRow.value
  return !!row && isRunning.value && row.status === 'running'
})
const stopRowDetailTitle = computed(() => en()
  ? 'Stop THIS row only (cancels its session/request) — other rows and the batch keep running.'
  : '只停这一行（取消它的会话 / 请求），其它行与整批继续。')
const rerunRowDetailTitle = computed(() => en()
  ? 'Rerun THIS row only (the old result is kept until the new one arrives): while the batch runs it jumps the queue; when stopped, this row is run on its own — other pending rows stay untouched.'
  : '只重跑这一行（旧结果保留到新结果出来）：批量运行中 → 插到队首立即执行；未运行时 → 只跑这一行，其它待处理行不动。')
/** 行详情「重跑」：与表格操作列原来的重跑一致 */
const rerunRowFromDetail = () => {
  const row = selectedRow.value
  if (row) rerunRow(row)
}
/** 行详情「停止」：只停当前这一行 */
const stopRowFromDetail = () => {
  const row = selectedRow.value
  if (!row) return
  const ok = agent?.requestStopRow?.(row)
  if (ok) setStatusHint('info', en() ? 'Stopping this row…' : '正在停止该行…')
  else setStatusHint('info', en() ? 'This row is not running' : '该行当前不在执行中')
}
/** 操作列状态下拉：手动改行状态（跳过/恢复/标记完成等）；执行中的行不允许手改，避免与运行中的 agent 冲突 */
const onRowStatusPick = (row: BatchRow, e: Event) => {
  const sel = e.target as HTMLSelectElement
  const next = sel.value as BatchRowStatus
  if (!next || next === row.status) return
  if (row.status === 'running') {
    addLog('warning', en()
      ? 'Row is running — wait until it finishes or stop the batch before changing its status'
      : '该行正在执行中，无法改状态（请等待完成或先停止批量）')
    sel.value = row.status // 绑定的值未变，Vue 不会重新 patch，手动把下拉显示回滚
    return
  }
  applyStatusChange(row.status, next)
  row.status = next
  if (next === 'pending') {
    row.error = undefined
    // 运行中队列已在启动时构建，新置为待处理的行要等下次点 ▶ 续跑
    if (isRunning.value) addLog('info', en() ? 'Marked as pending — it will run on the next Start' : '已置为待处理 — 将在下次点 ▶ 续跑时执行')
  }
}
const removeRow = (row: BatchRow) => {
  if (isRunning.value) { addLog('warning', en() ? 'Stop the run before deleting rows' : '请先停止运行再删除行'); return }
  const idx = rows.value.findIndex(r => r.id === row.id)
  if (idx !== -1) rows.value.splice(idx, 1)
  if (selectedRowId.value === row.id) {
    selectedRowId.value = null
    showRowDetail.value = false
  }
  recountRows()
  resetPages()
}

// 复制「替换后的任务」（占位符渲染后的完整 prompt）到剪贴板
const copyRenderedPrompt = async () => {
  const row = selectedRow.value
  if (!row) return
  const text = renderRowPrompt(row, rows.value.indexOf(row))
  if (!text.trim()) { ElMessage.warning(en() ? 'Nothing to copy' : '无可复制内容'); return }
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(en() ? 'Prompt copied' : '已复制替换后的任务')
  } catch {
    ElMessage.warning(en() ? 'Copy failed' : '复制失败')
  }
}

// 行详情模态框内结果编辑（点击输出区“编辑”按钮后编辑）
const rowDetailEditing = ref(false)
const rowDetailEditText = ref('')
const rowDetailEditorRef = ref<HTMLTextAreaElement | null>(null)
/** 结构化提取：该任务行在当前轮数据集里的记录（与 row.extracted 引用同一批对象） */
const rowRecords = (row: BatchRow | null | undefined): Array<Record<string, any>> => {
  if (!row) return []
  const idx = rows.value.indexOf(row)
  if (idx < 0) return Array.isArray(row.extracted) ? row.extracted : []
  const rowNo = idx + 1
  const fromDataset = datasetRows.value.filter(d => Number(d._rowNo) === rowNo && !d._removed)
  if (fromDataset.length) return fromDataset
  return Array.isArray(row.extracted) ? row.extracted : []
}
/** 结构化提取的编辑草稿：JSON 数组（按「输出字段」排序，内部字段 `_rowNo` / `_来源` 不展示） */
const recordsEditDraft = (row: BatchRow): string => {
  const fields = detailExtractFields.value.map(f => f.name)
  const list = rowRecords(row).map(rec => {
    const ordered: Record<string, any> = {}
    for (const f of fields) ordered[f] = rec[f] ?? ''
    for (const [k, v] of Object.entries(rec)) if (!k.startsWith('_') && !(k in ordered)) ordered[k] = v
    return ordered
  })
  return JSON.stringify(list, null, 2)
}
/** 输出方式的编辑提示（结构化提取 = 编辑提取记录，写回 = 编辑写回 JSON，单独结果 = 编辑文本） */
const detailEditPlaceholder = computed(() => outputMode.value === 'structured'
  ? (en() ? 'Edit extracted records (JSON array; add / remove records freely)…' : '编辑提取记录（JSON 数组，可自行增删记录）…')
  : isLlmMode.value
    ? (en() ? 'Edit written-back results (JSON)...' : '编辑写回结果（JSON）...')
    : (en() ? 'Edit output result...' : '编辑输出结果...'))
const detailEditTitle = computed(() => outputMode.value === 'structured'
  ? (en() ? 'Edit the extracted records (JSON)' : '编辑提取记录（JSON）')
  : (en() ? 'Edit the output text' : '编辑输出文本'))
const startDetailEdit = () => {
  if (!selectedRow.value || selectedRow.value.status === 'running') return
  // 结构化提取：编辑提取记录（JSON 数组）；逐列写回（纯 LLM）：编辑写回结果（JSON）；其余：编辑单文本结果
  rowDetailEditText.value = outputMode.value === 'structured'
    ? recordsEditDraft(selectedRow.value)
    : isLlmMode.value
      ? JSON.stringify(writeBackValueMap(selectedRow.value), null, 2)
      : (selectedRow.value.result || '')
  rowDetailEditing.value = true
  nextTick(() => {
    rowDetailEditorRef.value?.focus()
    autoResizeDetailEditor()
  })
}
// textarea 高度自适应内容（不内部滚动，由外层 .detail-output-body 滚动）
const autoResizeDetailEditor = () => {
  const el = rowDetailEditorRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}
const saveDetailEdit = () => {
  const row = selectedRow.value
  if (!row) return
  if (outputMode.value === 'structured') {
    if (!saveStructuredRecordsEdit(row)) return
  } else if (isLlmMode.value) {
    // 逐列写回：编辑的是「写回结果」JSON，保存后写回行数据（字段名 → 值）
    try {
      const obj = JSON.parse(rowDetailEditText.value || '{}')
      for (const [k, v] of Object.entries(obj)) row.data[k] = v as any
      addLog('info', en() ? 'Written-back results updated' : '写回结果已更新')
    } catch {
      ElMessage.warning(en() ? 'Invalid JSON' : 'JSON 格式不正确')
      return
    }
  } else {
    row.result = rowDetailEditText.value
  }
  rowDetailEditing.value = false
}
/**
 * 结构化提取的编辑保存：把 JSON 数组写回该行在数据集里的记录
 * （删掉该行旧记录 → 按同位置插入新记录；结果页与行详情同步，`_rowNo` / `_来源` 等内部字段自动补回）
 */
const saveStructuredRecordsEdit = (row: BatchRow): boolean => {
  let parsed: any
  try {
    parsed = JSON.parse(rowDetailEditText.value || '[]')
  } catch {
    ElMessage.warning(en() ? 'Invalid JSON' : 'JSON 格式不正确')
    return false
  }
  const list: any[] = Array.isArray(parsed) ? parsed : [parsed]
  const records = list.map((rec) => {
    const o: Record<string, any> = {}
    for (const [k, v] of Object.entries(rec || {})) {
      if (k.startsWith('_')) continue
      o[k] = v === null || v === undefined
        ? ''
        : (typeof v === 'object' ? JSON.stringify(v) : v as any)
    }
    return o
  })
  const rowNo = rows.value.indexOf(row) + 1
  if (rowNo <= 0) return false
  const prev = datasetRows.value.filter(d => Number(d._rowNo) === rowNo)
  const at = datasetRows.value.findIndex(d => Number(d._rowNo) === rowNo)
  // 内部的 _来源 / _时间 等元字段按位置保留（条数变了就用第一条的）
  const newRecs = records.map((r, i) => {
    const base = prev[i] || prev[0] || {}
    const meta: Record<string, any> = {}
    for (const [k, v] of Object.entries(base)) if (k.startsWith('_') && k !== '_rowNo') meta[k] = v
    return { ...r, ...meta, _rowNo: rowNo }
  })
  if (at >= 0) datasetRows.value.splice(at, prev.length, ...newRecs)
  else datasetRows.value.push(...newRecs)
  row.extracted = newRecs.length ? newRecs : undefined
  const slot = activeRound.value
  if (slot) slot.dataset = datasetRows.value.slice()
  addLog('info', en()
    ? `Row ${rowNo}: extracted records updated (${newRecs.length})`
    : `第 ${rowNo} 行：提取记录已更新（${newRecs.length} 条）`)
  setStatusHint('ok', en() ? 'Records updated' : '提取记录已更新')
  return true
}
const cancelDetailEdit = () => { rowDetailEditing.value = false }

// ==================== 导入表格 ====================
/** 大表格分片大小：每读取这么多行刷新一次底部状态栏进度 */
const TABLE_LOAD_CHUNK = 5000
/** 是否正在读取 / 解析表格（状态栏最左侧的转圈 + 进度文案） */
const tableLoading = ref(false)
const tableLoadProgressText = (loaded: number, total: number) => en()
  ? `Loading table ${loaded}/${total} rows...`
  : `读取表格 ${loaded}/${total} 行...`
const dataFileInput = ref<HTMLInputElement | null>(null)
const importData = () => {
  if (isRunning.value || isLoading.value) return
  dataFileInput.value?.click()
}

// CSV 解析（状态机，正确处理引号/逗号/转义/换行/CRLF）
const parseCsvText = (text: string): string[][] => {
  const rowsOut: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2 }
        else { inQuotes = false; i++ }
      } else { field += ch; i++ }
    } else if (ch === '"' && field.length === 0) { inQuotes = true; i++ }
    else if (ch === ',') { row.push(field); field = ''; i++ }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''; rowsOut.push(row); row = []; i++
    } else { field += ch; i++ }
  }
  if (field !== '' || row.length > 0) { row.push(field); rowsOut.push(row) }
  return rowsOut
}
// 表格文件解码（CSV：UTF-8 优先，失败回退 GBK；XLSX：二进制）
const decodeCsvText = (bytes: Uint8Array): string => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return new TextDecoder('gbk').decode(bytes) }
}
// ====== 行指纹：源表行的稳定标识 ======
/**
 * 行数据指纹（原表列 → 值 的短哈希）。
 * 用途：源表增删 / 重排行之后重读表格时，把任务文件里的历史结果按指纹对回正确的行
 * （否则只能按行号对位，中间插一行就会全部错位）。仅取导入那一刻的原表列，
 * 不包含运行时写回的新列 / 跨轮引用等虚拟列。
 */
const rowSig = (data: Record<string, any> | undefined): string => {
  if (!data) return ''
  const keys = Object.keys(data).sort()
  let h = 2166136261
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
    h ^= 124
    h = Math.imul(h, 16777619)
  }
  for (const k of keys) {
    const v = data[k]
    feed(k)
    feed(v === null || v === undefined ? '' : String(v))
  }
  return (h >>> 0).toString(36)
}
/**
 * 归一化单元格值（用于 sigNorm）：
 * Excel 重新保存常把单元格「换个写法」（数字带/不带千分位、多余 .0、前后空白、零宽字符、全角空格），
 * 归一化后这些差异不再算「内容变了」。
 */
const normCellValue = (v: any): string => {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'string' ? v : String(v)
  // 零宽 / BOM / 不换行空格 → 普通空格；内部连续空白折叠
  s = s.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').replace(/[\s]+/g, ' ').trim()
  // 数字（可带千分位 / 正负号 / 百分号）→ 归一化为数值字串
  const numeric = s.replace(/[,\s]/g, '')
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(numeric)) return 'n' + String(Number(numeric))
  const pct = numeric.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))%$/)
  if (pct) return 'n' + String(Number(pct[1]) / 100)
  return s
}
/**
 * 行数据指纹 - 归一化版：与 rowSig 同构，但每个单元格值先归一化。
 * 用它才能区分「真的改了内容」与「只是换了个写法」（否则 Excel 复存一次就满屏「已变更」）。
 */
const rowSigNorm = (data: Record<string, any> | undefined): string => {
  if (!data) return ''
  const keys = Object.keys(data).sort()
  let h = 2166136261
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
    h ^= 124
    h = Math.imul(h, 16777619)
  }
  for (const k of keys) {
    feed(k)
    feed(normCellValue(data[k]))
  }
  return (h >>> 0).toString(36)
}
/**
 * 行标识（首个非空单元格，形如 `名称:N1`，值截断 60 字符）：
 * 内容改过（指纹对不上）时靠它认出「还是同一行」→ 同步时把结果留在该行上（保持对齐）。
 * 写回列 / 下划线内部字段不参与。
 */
const rowKeyOf = (data: Record<string, any> | undefined): string => {
  if (!data) return ''
  const skip = writeBackColumns.value
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('_')) continue
    if (skip.includes(k)) continue
    const s = v === null || v === undefined ? '' : String(v).trim()
    if (s) return `${k}:${s.slice(0, 60)}`
  }
  return ''
}
// 单行原始值 → BatchRow（空行返回 null）
const rowFromRaw = (raw: any[], headers: string[]): BatchRow | null => {
  const data: Record<string, any> = {}
  let hasValue = false
  raw.forEach((val: any, ci: number) => {
    const name = headers[ci]
    if (name === undefined) return
    const v = val === null || val === undefined ? '' : String(val).trim()
    data[name] = v
    if (v) hasValue = true
  })
  if (!hasValue) return null
  return { id: newRowId(), data, sig: rowSig(data), sigNorm: rowSigNorm(data), status: 'pending', inputTokens: 0, outputTokens: 0, retryCount: 0, emptyRetryCount: 0 }
}
// 原始行二维数组 → BatchRow[]
const buildRowsFromRaw = (rawRows: any[][]): BatchRow[] => {
  if (rawRows.length < 2) return []
  const headers = rawRows[0].map((h: any) => String(h ?? '').trim()).filter(Boolean)
  if (headers.length === 0) return []
  const out: BatchRow[] = []
  for (let i = 1; i < rawRows.length; i++) {
    const r = rowFromRaw(rawRows[i], headers)
    if (r) out.push(r)
  }
  return out
}
// 解析表格文件内容为「原始行二维数组」（CSV / XLSX）
const parseTableRawRows = (buffer: Uint8Array, fileName: string): any[][] => {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'csv') {
    return parseCsvText(decodeCsvText(buffer))
      .map(row => row.map(v => v.trim()))
      .filter(row => row.some(c => c !== ''))
  }
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as any[][]
}
// 解析表格文件内容为 BatchRow[]（CSV / XLSX，文件导入用）
const parseTableBuffer = (buffer: Uint8Array, fileName: string): BatchRow[] =>
  buildRowsFromRaw(parseTableRawRows(buffer, fileName))
// 原始行 → BatchRow[]（分批构建：每 TABLE_LOAD_CHUNK 行让出事件循环并回报进度，
// 避免超大表格导入时界面卡死且看不到进度）
const buildRowsFromRawAsync = async (
  rawRows: any[][],
  onProgress?: (loaded: number, total: number) => void,
): Promise<BatchRow[]> => {
  if (rawRows.length < 2) return []
  const headers = rawRows[0].map((h: any) => String(h ?? '').trim()).filter(Boolean)
  if (headers.length === 0) return []
  const out: BatchRow[] = []
  const total = rawRows.length - 1
  for (let i = 1; i < rawRows.length; i++) {
    const r = rowFromRaw(rawRows[i], headers)
    if (r) out.push(r)
    if (i % TABLE_LOAD_CHUNK === 0) {
      onProgress?.(Math.min(i, total), total)
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  return out
}
const newRowId = (): string => `row_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
// 源表格文件路径（导入时记录；保存进任务文件，加载时自动重读合并）
const sourceTablePath = ref('')
// 源表格文件名（浏览器环境下拿不到路径时用于展示）
const sourceTableName = ref('')

const handleDataFileImport = async (event: Event) => {
  const input = event.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return
  const prevStatus = statusText.value
  tableLoading.value = true
  try {
    const file = input.files[0]
    // 记录源表格路径（Electron 下 File.path 可用；浏览器环境只有文件名）
    // 注意：先记下「上次的源表格路径」——同一个文件再次导入 = 重读（替换行 + 按指纹重挂结果），
    // 若改成追加，行数会翻倍（老行 + 新行），后面的增量对位就全乱了。
    const prevSourcePath = sourceTablePath.value
    const sameSource = !!prevSourcePath && !!file.path && prevSourcePath === file.path && rows.value.length > 0
    sourceTablePath.value = file.path || ''
    sourceTableName.value = file.name || ''
    let newRows: BatchRow[] = []
    if (sourceTablePath.value) {
      // Electron：交给主进程 worker 解析并分片取回，每 TABLE_LOAD_CHUNK 行刷新一次状态栏（大表也不卡界面）
      statusText.value = en() ? 'Parsing table...' : '正在解析表格...'
      newRows = await loadTableRowsByPath(sourceTablePath.value, (loaded, total) => {
        statusText.value = tableLoadProgressText(loaded, total)
      })
    } else {
      // 浏览器：先在内存里解析，再分批构建行（同样每 TABLE_LOAD_CHUNK 行刷新一次进度）
      statusText.value = en() ? 'Parsing table...' : '正在解析表格...'
      const buffer = new Uint8Array(await file.arrayBuffer())
      const rawRows = parseTableRawRows(buffer, file.name)
      newRows = await buildRowsFromRawAsync(rawRows, (loaded, total) => {
        statusText.value = tableLoadProgressText(loaded, total)
      })
    }
    if (newRows.length === 0) {
      addLog('warning', en() ? 'No valid rows imported' : '未导入任何有效数据')
      setStatusHint('info', en() ? 'No valid rows imported' : '未导入任何有效数据')
      statusText.value = prevStatus
      return
    }
    // 同一源表格重读：直接替换行集合（按行指纹把历史结果重挂回去），而不是追加
    if (sameSource) {
      captureCurrentRound()
      const slot = activeRound.value
      // 别把「刚载入任务文件时暂存、还没合并的结果」冲掉
      if (!pendingResults.value.length) pendingResults.value = (slot?.results || []).slice()
      // 只取源表列（排除逐列写回产生的新列）
      savedSourceColumns.value = sourceColumnsNow.value.slice()
    }
    // 替换 / 追加前留一份旧行数据：被删掉的行要能在结果页里带出原表列
    prevRowData.value = rows.value.map(r => ({ ...(r.data || {}) }))
    if (sameSource) rows.value = newRows
    else rows.value = rows.value.concat(newRows)
    recountRows()
    // 若此前加载过仅含结果/状态的任务文件，导入表格后自动按行索引合并
    if (pendingResults.value.length) {
      const n = mergeResults(rows.value, pendingResults.value)
      pendingResults.value = []
      if (n > 0) addLog('info', en() ? `Merged ${n} saved results/status` : `已合并 ${n} 行保存的结果/状态`)
    }
    // 任务文件里保留过图谱数据（traces）时，导入表格后按同一套行索引合并
    if (pendingTraces.value.length) {
      const n = applyPendingTraces()
      if (n > 0) addLog('info', en() ? `Restored process snapshots for ${n} rows (graph available)` : `已恢复 ${n} 行的过程快照（图谱可用）`)
    }
    // 合并完立刻重写活跃轮次快照：否则切轮次 / 保存用的还是导入前的结果
    captureCurrentRound()
    resetPages()
    addLog('info', en() ? `Imported ${newRows.length} rows` : `成功导入 ${newRows.length} 行`)
    const headers = Object.keys(newRows[0].data || {})
    addLog('info', en() ? `Columns: ${headers.join(', ')}` : `列: ${headers.join(', ')}`)
    setStatusHint('ok', en()
      ? `Imported ${newRows.length} rows${sourceDeltaStatusNote.value}`
      : `已导入 ${newRows.length} 行${sourceDeltaStatusNote.value}`, sourceTableName.value)
    statusText.value = prevStatus
  } catch (error: any) {
    addLog('error', `${en() ? 'Import failed' : '导入失败'}: ${error.message}`)
    setStatusHint('err', en() ? 'Import failed (see Logs)' : '导入失败（详见日志）', String(error?.message || ''))
    statusText.value = prevStatus
  } finally {
    tableLoading.value = false
    input.value = ''
  }
}

// 按路径自动读取表格并合并（打开任务文件后自动恢复表格数据）
// 大表格：主进程 worker 线程后台解析 + 分批 IPC 传输，渲染端分批构建并让出事件循环，避免白屏
// 并发保护：同一路径正在读取时复用同一流程，不同路径排队（避免两个流程互抢主进程解析缓存）
let autoLoadTask: Promise<void> | null = null
let autoLoadTaskPath = ''
const autoLoadTable = (path: string): Promise<void> => {
  if (autoLoadTask && autoLoadTaskPath === path) return autoLoadTask
  const run = (autoLoadTask ? autoLoadTask.catch(() => {}) : Promise.resolve()).then(() => doAutoLoadTable(path))
  autoLoadTask = run
  autoLoadTaskPath = path
  return run.finally(() => {
    if (autoLoadTask === run) autoLoadTask = null
  })
}
/**
 * 大表格分片读取（主进程 worker 后台解析 + 每 TABLE_LOAD_CHUNK 行一次 IPC 取回）：
 * 手动导入与「按路径自动读取」共用；onProgress(已读行数, 总行数) 用于在状态栏最左侧显示进度。
 */
const loadTableRowsByPath = async (path: string, onProgress?: (loaded: number, total: number) => void): Promise<BatchRow[]> => {
  const start = await window.ipcRenderer.invoke('parseTableFile:start', path)
  if (!start || !start.success) throw new Error(start?.error || '解析表格失败')
  const total = start.total
  if (total < 2) {
    await window.ipcRenderer.invoke('parseTableFile:done', path)
    return []
  }
  const newRows: BatchRow[] = []
  let headers: string[] = []
  for (let off = 0; off < total; off += TABLE_LOAD_CHUNK) {
    onProgress?.(Math.min(off + TABLE_LOAD_CHUNK, total), total)
    const res = await window.ipcRenderer.invoke('parseTableFile:chunk', path, off, TABLE_LOAD_CHUNK)
    if (!res || !res.success) throw new Error(res?.error || '读取表格分片失败')
    const chunkRows: any[][] = res.rows
    if (off === 0) headers = (chunkRows[0] || []).map((h: any) => String(h ?? '').trim()).filter(Boolean)
    // 首块跳过表头行（index 0），其余块全量
    for (let i = (off === 0 ? 1 : 0); i < chunkRows.length; i++) {
      const r = rowFromRaw(chunkRows[i], headers)
      if (r) newRows.push(r)
    }
    if ((off / TABLE_LOAD_CHUNK) % 4 === 3) await new Promise(resolve => setTimeout(resolve, 0))
  }
  await window.ipcRenderer.invoke('parseTableFile:done', path)
  return newRows
}
const doAutoLoadTable = async (path: string) => {
  const prevStatus = statusText.value
  tableLoading.value = true
  try {
    statusText.value = en() ? 'Parsing table...' : '正在解析大表格...'
    addLog('info', `正在解析大表格: ${path} ...`)
    const newRows = await loadTableRowsByPath(path, (loaded, total) => {
      statusText.value = tableLoadProgressText(loaded, total)
    })

    if (newRows.length === 0) {
      addLog('warning', `自动读取表格无有效数据: ${path}`)
      statusText.value = prevStatus
      return
    }
    statusText.value = en() ? 'Merging results...' : '正在合并结果/状态...'
    rows.value = newRows
    recountRows()
    if (pendingResults.value.length) {
      const n = mergeResults(rows.value, pendingResults.value)
      pendingResults.value = []
      addLog('info', `已自动读取表格并合并 ${n} 行结果/状态`)
    }
    // 保留过图谱数据时，源表读入（行对齐）后恢复过程快照
    if (pendingTraces.value.length) {
      const n = applyPendingTraces()
      if (n > 0) addLog('info', `已恢复 ${n} 行的过程快照（图谱可用）`)
    }
    resetPages()
    addLog('info', `已自动读取表格: ${path}（${newRows.length} 行）`)
    statusText.value = prevStatus
  } catch (error: any) {
    statusText.value = en() ? 'Load table failed' : '读取表格失败'
    addLog('error', `自动读取表格失败: ${error.message}。请手动点击「导入」选择原表格。`)
    // 只有确实没有数据时才清空源表格路径：若是并发流程抢先释放了缓存，
    // 另一个流程已成功读取，此时清空会让后续保存丢失「源表格」引用
    if (rows.value.length === 0) sourceTablePath.value = ''
  } finally {
    tableLoading.value = false
  }
}

// ==================== 同步源表（任务已打开时重读源表 / 重扫文件夹） ====================
/** 有没有可同步的源：表格源要有记录过的表格路径，文件夹源要有目录（文本源无需同步） */
const canSyncSource = computed(() => !isTextSource.value
  && (isFolderSource.value ? !!config.folderPath : !!sourceTablePath.value))
/** 「同步源表」按钮的悬停说明（带上上次同步结果） */
const syncSourceTitle = computed(() => {
  const head = en()
    ? 'Re-read the source (table file / folder) and re-sync the task rows — no need to reopen the task. Unchanged rows keep their results (re-attached by row fingerprint), so adding / removing rows never shifts them.'
    : '重新读取源表（表格文件 / 文件夹）并同步任务行——不用重开任务。没变过的行结果原样保留（按行指纹对回去），增删行都不会错位。'
  const tail = sourceDeltaTotal.value
    ? (en()
      ? `\nLast sync: +${sourceDelta.added} new / ~${sourceDelta.changed} changed / -${sourceDelta.removed} removed`
      : `\n上次同步：新增 ${sourceDelta.added} / 变更 ${sourceDelta.changed} / 移除 ${sourceDelta.removed}`)
      + (sourceDelta.reason ? `\n⚠ ${sourceDelta.reason}` : '')
    : sourceDelta.reason ? `\n⚠ ${sourceDelta.reason}` : ''
  return head + tail
})

/**
 * 同步源表：把源表格（或源文件夹）重新读一遍，让任务行与源表一致，并按行指纹把历史结果对回正确的行。
 * 场景：任务已经开着，你在 Excel 里增删 / 改了行（或文件夹里加了 / 删了文件）→ 点一下即可，不必重开任务。
 * 实现就是「打开任务」那条路径：先把当前行结果写回本轮（带行指纹）→ 当作待合并结果 → 重读源 → 合并。
 */
const syncSourceRows = async () => {
  if (isRunning.value) {
    addLog('warning', en() ? 'Stop the run before syncing the source' : '请先停止运行再同步源表')
    return
  }
  if (isLoading.value) return
  const folder = isFolderSource.value
  if (!canSyncSource.value) {
    addLog('warning', en()
      ? 'No source table recorded — use Import to pick the table file first'
      : '没有可同步的源表格——请先用「导入」选择表格文件')
    setStatusHint('info', en() ? 'No source to sync' : '没有可同步的源表')
    return
  }
  // 1) 当前行结果写回本轮（含行指纹）；并记下当前**源表列**作为「结构是否变化」的比较基准
  //    （只取源表列：逐列写回产生的新列不算结构变化，否则每次同步都会被当成「列变了」）
  captureCurrentRound()
  savedSourceColumns.value = sourceColumnsNow.value.slice()
  const slot = activeRound.value
  pendingResults.value = (slot?.results || []).slice()
  pendingTraces.value = (slot?.traces || []).slice()
  // 重读源表前先留一份旧行数据：被删掉的行的旧结果需要它才能在结果页里带出原表列
  prevRowData.value = rows.value.map(r => ({ ...(r.data || {}) }))
  setStatusHint('saving', en() ? 'Syncing source...' : '正在同步源表...')
  try {
    if (folder) {
      applySourceInputs()
      await doScanFolder({ rebuild: true })
      if (pendingResults.value.length) mergeResults(rows.value, pendingResults.value)
      pendingResults.value = []
      if (pendingTraces.value.length) applyPendingTraces()
      pendingTraces.value = []
      recountRows()
      resetPages()
    } else {
      await doAutoLoadTable(sourceTablePath.value)
    }
    // 同步后立刻重写活跃轮次快照：否则切轮次 / 对比 / 保存用的还是同步前的结果（结果也要跟着同步）
    captureCurrentRound()
    if (sourceDeltaTotal.value) {
      setStatusHint('ok', en()
        ? `Source synced: +${sourceDelta.added} new / ~${sourceDelta.changed} changed / -${sourceDelta.removed} removed${sourceDeltaStatusNote.value}`
        : `源表已同步：新增 ${sourceDelta.added} / 变更 ${sourceDelta.changed} / 移除 ${sourceDelta.removed}${sourceDeltaStatusNote.value}`)
    } else if (sourceDelta.reason) {
      setStatusHint('info', en() ? `Source synced — ${sourceDelta.reason}` : `源表已同步——${sourceDelta.reason}`)
    } else {
      setStatusHint('ok', en() ? 'Source synced — no changes' : '源表已同步——没有变化')
    }
  } catch (e: any) {
    addLog('error', en() ? `Sync failed: ${e?.message || e}` : `同步源表失败：${e?.message || e}`)
    setStatusHint('err', en() ? 'Sync failed (see Logs)' : '同步失败（详见日志）', String(e?.message || e))
  } finally {
    pendingResults.value = []
    pendingTraces.value = []
  }
}

// ==================== 导出 ====================
/** Excel 单元格最长字符数（xlsx 规范上限；超长会被 SheetJS 直接报错，导致整个导出失败） */
const MAX_CELL_CHARS = 32767
/**
 * 单元格文本清洗：
 * 1) 去掉 XML 非法控制字符（保留 \t \n \r）——否则个别行会把整个文件写坏（Excel 打开后内容丢失）；
 * 2) 超长文本截断到 Excel 上限并加标记，避免“一行太长 → 整份导出报错/无文件”。
 */
const sanitizeCellText = (s: string): string => {
  // eslint-disable-next-line no-control-regex
  let out = String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  if (out.length > MAX_CELL_CHARS) {
    const mark = en() ? '… (too long, truncated on export)' : '…（内容超长，已在导出时截断）'
    out = out.slice(0, MAX_CELL_CHARS - mark.length) + mark
  }
  return out
}
/** 导出时写入单元格的安全字符串（对象转 JSON；null/undefined → 空） */
const safeExportString = (v: any): string => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return sanitizeCellText(v.trim())
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try { return sanitizeCellText(JSON.stringify(v) || '') } catch { return sanitizeCellText(String(v)) }
}

/** 导出可选的「运行信息列」（顺序 = 导出列顺序；header = Excel 列名） */
const EXPORT_META_COLUMNS: Array<{ key: string; zh: string; en: string; header: string }> = [
  { key: 'rowNo', zh: '行号', en: 'Row #', header: '_行号' },
  { key: 'instruction', zh: '任务指令', en: 'Instruction', header: '_任务指令' },
  { key: 'status', zh: '状态', en: 'Status', header: '_状态' },
  { key: 'error', zh: '错误', en: 'Error', header: '_错误' },
  { key: 'inputTokens', zh: '输入Token', en: 'In tokens', header: '_输入Token' },
  { key: 'outputTokens', zh: '输出Token', en: 'Out tokens', header: '_输出Token' },
  { key: 'startedAt', zh: '开始时间', en: 'Start', header: '_开始时间' },
  { key: 'finishedAt', zh: '结束时间', en: 'End', header: '_结束时间' },
  { key: 'duration', zh: '耗时', en: 'Took', header: '_耗时' },
  { key: 'steps', zh: '步数', en: 'Steps', header: '_步数' },
  { key: 'retry', zh: '重试', en: 'Retries', header: '_重试' },
  { key: 'rawOutput', zh: '原始输出', en: 'Raw output', header: '_原始输出' },
]
/** 未设置 config.exportMeta 时的默认运行信息列（单独结果模式：与旧版固定导出保持一致） */
const LEGACY_EXPORT_META = ['status', 'error', 'inputTokens', 'outputTokens', 'startedAt', 'finishedAt']

/** 导出：原表列（未设置 = 单独结果模式导出全部列 / 结构化模式不导出） */
const exportCols = computed<string[]>(() => {
  if (Array.isArray(config.exportColumns)) return (config.exportColumns || []).filter(c => columns.value.includes(c))
  return outputMode.value === 'structured' ? [] : [...columns.value]
})
/** 导出：运行信息列（未设置 = 结构化模式不导出 / 单独结果模式同旧版） */
const exportMetas = computed<string[]>(() => {
  if (Array.isArray(config.exportMeta)) return config.exportMeta
  return outputMode.value === 'structured' ? [] : [...LEGACY_EXPORT_META]
})
const toggleExportCol = (col: string) => {
  const cur = new Set(exportCols.value)
  if (cur.has(col)) cur.delete(col)
  else cur.add(col)
  config.exportColumns = columns.value.filter(c => cur.has(c))
}
const toggleExportMeta = (key: string) => {
  const cur = new Set(exportMetas.value)
  if (cur.has(key)) cur.delete(key)
  else cur.add(key)
  config.exportMeta = EXPORT_META_COLUMNS.map(m => m.key).filter(k => cur.has(k))
}
const exportAllCols = () => { config.exportColumns = [...columns.value] }
const exportNoCols = () => { config.exportColumns = [] }

/** 运行信息列的表头（键 → Excel 列名） */
const exportMetaHeader = (key: string): string => {
  const m = EXPORT_META_COLUMNS.find(x => x.key === key)
  if (!m) return `_${key}`
  // 列名（结果页表头 / 导出的 Excel）按界面语言：英文界面不再出现「_行号」这类中文表头
  return en() ? `_${m.en}` : m.header
}
/** 结构化导出最后一列「来源」的列名（内部字段，同样按界面语言） */
const exportSourceHeader = computed(() => (en() ? '_Source' : '_来源'))

/** 导出：某任务行某运行信息列的值（index = 0 起的行号） */
const exportMetaValue = (row: BatchRow, key: string, index: number): string => {
  switch (key) {
    case 'rowNo': return String(index + 1)
    case 'instruction': return renderRowPrompt(row, index).trim()
    case 'status': return statusLabel(row.status)
    case 'error': return safeExportString(row.error)
    case 'inputTokens': return String(row.inputTokens || 0)
    case 'outputTokens': return String(row.outputTokens || 0)
    case 'startedAt': return safeExportString(row.startedAt)
    case 'finishedAt': return safeExportString(row.finishedAt)
    case 'duration': return fmtRowDuration(row) || ''
    case 'steps': return row.stepsCount ? String(row.stepsCount) : ''
    case 'retry': return String(row.retryCount || 0)
    // 结构化提取没解析出记录时 runner 会把模型原始输出留在 result 上（单独结果模式 = 结果文本）
    case 'rawOutput': return safeExportString(row.result)
    default: return ''
  }
}

/** 导出列区块的标题 / 说明（两者合并成一条，只在下拉式 title 里悬停显示，不占界面） */
const exportBlockTitle = computed(() => en()
  ? 'Export = extracted fields (structured) or result / written-back columns (single result) + the source columns you ticked + the runtime info you ticked (row #, instruction, status, error, times, tokens…, raw output).\nIn structured mode those runtime columns are merged from the task row that produced each record, and rows whose JSON could not be parsed are written as well (with their raw output).'
  : '导出 = 提取字段（结构化）或结果列 / 写回列（单独结果）＋ 点选的原表列 ＋ 点选的运行信息（行号 / 任务指令 / 状态 / 错误 / Token / 起止时间… / 原始输出）。\n结构化提取时这些运行信息按「产生该条数据的任务行」合并到每条记录上；模型没返回合法 JSON 的行也会一并写出（带原始输出）。')

/** 结果页一行对应的来源：record = 提取记录（datasetRows 下标）；orphan = 没解析出记录的任务行；row = 单个任务行 */
type ResultRowRef = { kind: 'record' | 'orphan' | 'row' | 'removed'; index: number }

/** 结果页渐进式加载：一次构建 / 渲染多少行（滚动到底继续加载；不再固定截断 500 行） */
const RESULT_PAGE_SIZE = 200

/**
 * 拼最终导出列顺序：
 * - 可配置列（原表列 / 运行信息 / 轮次列）按导出列表单的顺序；未列进表单的保持默认次序（原表列 → 运行信息 → 轮次列）；
 * - 固定列（结构化 = 提取字段 / 单独结果 = 结果列）插在第一个「运行信息 / 轮次」列之前（默认即在原表列之后）；
 * - tail（结构化模式的「_来源」）永远排最后。
 */
const assembleExportColumns = (fixed: string[], metaHeaders: string[], roundHeaders: string[], tail: string[] = []): string[] => {
  const metaRanks = metaHeaders.map((h, i) => {
    const def = EXPORT_META_COLUMNS.find(m => m.header === h)
    return def ? exportItemRank(exportItemMetaKey(def.key), 1000 + i) : 1000 + 500 + i
  })
  const roundRanks = roundHeaders.map((_h, i) => {
    const slot = exportRoundSlots.value[i]
    return slot ? exportItemRank(exportItemRoundKey(slot.id), 2000 + i) : 2000 + i
  })
  const firstInfoRank = Math.min(...metaRanks, ...roundRanks, Infinity)
  // 没有运行信息 / 轮次列时：固定列排在所有可配置列之后
  const fixedRank = Number.isFinite(firstInfoRank) ? firstInfoRank - 0.5 : 1e6 + 9000
  const entries = [
    ...exportCols.value.map((c, i) => ({ name: c, r: exportItemRank(exportItemColKey(c), i), i })),
    ...metaHeaders.map((h, i) => ({ name: h, r: metaRanks[i], i })),
    ...roundHeaders.map((h, i) => ({ name: h, r: roundRanks[i], i })),
    ...fixed.map((name, i) => ({ name, r: fixedRank, i })),
    ...tail.map((name, i) => ({ name, r: 1e9 + i, i })),
  ]
  entries.sort((a, b) => a.r - b.r || a.i - b.i)
  const out: string[] = []
  for (const e of entries) if (e.name && !out.includes(e.name)) out.push(e.name)
  return out
}

/**
 * 导出计划：列 + 每行来源（refs）。
 * 行内容**按需生成**（见 exportRowAt）——大表导出时逐片生成，既不在渲染层一次性建出全部行对象，
 * 也不把几十万行塞进一个 IPC 消息（导出卡顿的主因）。
 */
type ExportPlan = {
  columns: string[]
  /** 列名映射（原名 → 最终列名，含「导出列」里的自定义改名）；顺序即导出 / Excel 列序 */
  pairs: Array<{ src: string; name: string }>
  refs: ResultRowRef[]
  structured: null | {
    cols: string[]; fields: string[]; metas: string[]; rawPicked: boolean; autoRaw: boolean
    slots: PipelineRound[]; orphans: Map<number, BatchRow>
  }
  single: null | {
    cols: string[]; metas: string[]; resultField: string; showResultCol: boolean; slots: PipelineRound[]
  }
}

/** 定型列：把列名换成自定义名并兜住重名（返回 原名 → 现名 的有序映射） */
const finalizeExportColumns = (columns: string[]): Array<{ src: string; name: string }> => {
  const keyOf = exportColumnKeyOf.value
  const used = new Set<string>()
  return columns.map((c, i) => {
    const key = keyOf.get(c)
    const renamed = key ? exportHeaderName(key, c) : c
    // 重名兜底：改出来的名字不能占其它列的原名，否则回退原名（避免两列互相覆盖）
    const clash = used.has(renamed) || (renamed !== c && columns.some((x, j) => j !== i && x === renamed))
    const name = clash ? c : renamed
    used.add(name)
    return { src: c, name }
  })
}

/**
 * 组装导出计划（**结果页预览与导出共用，保证「所见即所导」**）：
 * 列顺序 = 按导出列表单（可拖动）的顺序排列原表列 / 运行信息 / 轮次列，固定列（提取字段 / 结果列）插在运行信息之前
 */
const buildExportPlan = (): ExportPlan => {
  const cols = exportCols.value
  const metas = exportMetas.value
  const metaHeaders = metas.map(exportMetaHeader)
  // 轮次结果对比列（勾选的前几轮：每轮一列）
  const roundSlots = exportRoundSlots.value
  const roundHeaders = roundSlots.map(roundExportHeader)
  // 结构化输出（纯 LLM 提取 / 智能体 JSON）：每条提取记录 = 原表列（若有）+ 提取字段 + 运行信息（若有）+ 轮次列 + 来源
  if (outputMode.value === 'structured' && datasetRows.value.length) {
    const fields = (config.schema || []).map(f => f.name).filter(Boolean)
    // 有「模型答了但没解析出记录」的任务行时：自动补上「原始输出」列，否则这些行的内容永远进不了导出
    // （自动模式下只填这些行；用户主动勾选该列时才会给所有记录行都填原文）
    const usedRowNos = new Set<number>()
    for (const d of datasetRows.value) {
      // 源行已被删掉的记录（_removed）不占用行号：否则会误判对应任务行「已有记录」
      if (d && d._removed) continue
      const n = Number(d._rowNo) || 0
      if (n > 0) usedRowNos.add(n)
    }
    const orphanList = rows.value
      .map((row, i) => ({ row, i }))
      .filter(({ row, i }) => !usedRowNos.has(i + 1) && safeExportString(row.result) !== '')
    const rawPicked = metas.includes('rawOutput')
    const autoRaw = !rawPicked && orphanList.length > 0
    const effMetas = autoRaw ? [...metas, 'rawOutput'] : metas
    // 列顺序：按导出列表单的顺序（提取字段插在运行信息之前；_来源 恒最末）
    const columns = assembleExportColumns(fields, effMetas.map(exportMetaHeader), roundHeaders, [exportSourceHeader.value])
    const refs: ResultRowRef[] = datasetRows.value.map((_d, i) => ({ kind: 'record', index: i }))
    // 没有产出记录的行也补进导出（字段留空，带行号 / 状态 / 原文）——否则它们会在数据表里彻底消失
    for (const { i } of orphanList) refs.push({ kind: 'orphan', index: i })
    // ⚠️ 列名必须用定型后的名字（自定义改名后的）：行数据的键就是它，
    // 若这里返回原名，改名后的列在结果页会读不到值（显示空白）、Excel 也会列错位
    const pairsStructured = finalizeExportColumns(columns)
    return {
      columns: pairsStructured.map(p => p.name),
      pairs: pairsStructured,
      refs,
      structured: {
        cols, fields, metas, rawPicked, autoRaw, slots: roundSlots,
        orphans: new Map(orphanList.map(o => [o.i, o.row])),
      },
      single: null,
    }
  }
  const resultField = config.resultField || roundResultRefName()
  // 逐列写回模式的结果在输出字段（写回列）里：若所有行都没有「结果」文本，则不输出空的「结果列」（导出更干净）
  const showResultCol = !isLlmMode.value || rows.value.some(r => safeExportString(r.result) !== '')
  const columns = assembleExportColumns(showResultCol ? [resultField] : [], metaHeaders, roundHeaders)
  // 被删掉的源行（源表重读后对不上的旧行）：结果属于它，仍列在结果页里（标「已移除」）
  const refs: ResultRowRef[] = rows.value.map((_row, i) => ({ kind: 'row', index: i }))
  for (let i = 0; i < removedRows.value.length; i++) refs.push({ kind: 'removed', index: i })
  // 同上：列名用定型后的名字（自定义改名后结果页 / Excel 才取得到值）
  const pairsSingle = finalizeExportColumns(columns)
  return {
    columns: pairsSingle.map(p => p.name),
    pairs: pairsSingle,
    refs,
    structured: null,
    single: { cols, metas, resultField, showResultCol, slots: roundSlots },
  }
}

/** 生成一行「原名键」的导出数据（未定型：列名还是原名、键序未排） */
const rawExportRowAt = (plan: ExportPlan, ref: ResultRowRef): Record<string, string> => {
  const out: Record<string, string> = {}
  const st = plan.structured
  if (st) {
    if (ref.kind === 'record') {
      const d = datasetRows.value[ref.index]
      if (!d) return out
      const rowNo = Number(d._rowNo) || 0
      const srcRow = rowNo > 0 ? rows.value[rowNo - 1] : undefined
      const srcIndex = rowNo > 0 ? rowNo - 1 : 0
      // 原表列（旧数据集没有行号映射时列为空——重新运行一次即可带上）
      for (const col of st.cols) out[col] = srcRow ? safeExportString(srcRow.data?.[col]) : ''
      for (const f of st.fields) out[f] = d[f] === null || d[f] === undefined ? '' : sanitizeCellText(String(d[f]))
      for (const key of st.metas) out[exportMetaHeader(key)] = srcRow ? exportMetaValue(srcRow, key, srcIndex) : ''
      // 主动勾选「原始输出」时记录行也带原文；自动补列时留空（避免把每条 JSON 都塞进导出）
      if (st.rawPicked) out[exportMetaHeader('rawOutput')] = srcRow ? exportMetaValue(srcRow, 'rawOutput', srcIndex) : ''
      else if (st.autoRaw) out[exportMetaHeader('rawOutput')] = ''
      for (const slot of st.slots) out[roundExportHeader(slot)] = roundExportCell(slot, srcIndex)
      out[exportSourceHeader.value] = String(d._source || '')
      return out
    }
    const row = st.orphans.get(ref.index)
    if (!row) return out
    const i = ref.index
    for (const col of st.cols) out[col] = safeExportString(row.data?.[col])
    for (const f of st.fields) out[f] = ''
    for (const key of st.metas) out[exportMetaHeader(key)] = exportMetaValue(row, key, i)
    out[exportMetaHeader('rawOutput')] = safeExportString(row.result)
    for (const slot of st.slots) out[roundExportHeader(slot)] = roundExportCell(slot, i)
    out[exportSourceHeader.value] = ''
    return out
  }
  const sg = plan.single
  if (!sg) return out
  // 「已移除」的旧行：用同步前留的旧行数据 + 保存下来的结果 / 写回值拼一行（各轮次列留空）
  if (ref.kind === 'removed') {
    const rr = removedRows.value[ref.index]
    if (!rr) return out
    const saved = rr.saved || {}
    const data: Record<string, any> = { ...(rr.data || {}), ...(saved.values || {}) }
    for (const col of sg.cols) out[col] = safeExportString(data[col])
    if (sg.showResultCol) out[sg.resultField] = safeExportString(saved.result)
    for (const key of sg.metas) {
      switch (key) {
        case 'rowNo': out[exportMetaHeader(key)] = String(rr.no || 0); break
        case 'status': out[exportMetaHeader(key)] = statusLabel(saved.status || 'completed'); break
        case 'error': out[exportMetaHeader(key)] = safeExportString(saved.error); break
        case 'inputTokens': out[exportMetaHeader(key)] = String(saved.inputTokens || 0); break
        case 'outputTokens': out[exportMetaHeader(key)] = String(saved.outputTokens || 0); break
        case 'startedAt': out[exportMetaHeader(key)] = safeExportString(saved.startedAt); break
        case 'finishedAt': out[exportMetaHeader(key)] = safeExportString(saved.finishedAt); break
        case 'steps': out[exportMetaHeader(key)] = saved.stepsCount ? String(saved.stepsCount) : ''; break
        case 'retry': out[exportMetaHeader(key)] = String(saved.retryCount || 0); break
        case 'rawOutput': out[exportMetaHeader(key)] = safeExportString(saved.result); break
        default: out[exportMetaHeader(key)] = ''
      }
    }
    for (const slot of sg.slots) out[roundExportHeader(slot)] = ''
    return out
  }
  const row = (ref.kind === 'row') ? rows.value[ref.index] : undefined
  if (!row) return out
  for (const col of sg.cols) out[col] = safeExportString(row.data?.[col])
  if (sg.showResultCol) out[sg.resultField] = safeExportString(row.result)
  for (const key of sg.metas) out[exportMetaHeader(key)] = exportMetaValue(row, key, ref.index)
  for (const slot of sg.slots) out[roundExportHeader(slot)] = roundExportCell(slot, ref.index)
  return out
}

/** 单行导出数据：按最终列序 / 列名输出（等价于对整表做一次 finalize，只是逐行做） */
const exportRowAt = (plan: ExportPlan, ref: ResultRowRef): Record<string, string> => {
  const raw = rawExportRowAt(plan, ref)
  const out: Record<string, string> = {}
  for (const { src, name } of plan.pairs) out[name] = raw[src] ?? ''
  return out
}

/**
 * 组装导出表（结果页预览用：只建前 N 行，滚动到底再扩窗口）
 * @param limit 只组装前 N 行（不传 = 全部）
 * @param offset 从第 offset 行开始（分片导出用）
 * @returns refs 与 rows 一一对应：该行来自哪条提取记录 / 哪个任务行（结果页逐条删除用）
 */
const buildExportTable = (limit?: number, offset = 0): { rows: Array<Record<string, string>>; columns: string[]; refs: ResultRowRef[] } => {
  const plan = buildExportPlan()
  const refs = plan.refs.slice(offset, limit === undefined ? undefined : offset + limit)
  return { rows: refs.map(r => exportRowAt(plan, r)), columns: plan.columns, refs }
}

/**
 * 导出列的改名 / 排序映射：原名 → 条目键（结果页表头悬停显示原名、自定义列名都靠它）
 */
const exportColumnKeyOf = computed(() => {
  const m = new Map<string, string>()
  for (const c of columns.value) m.set(c, exportItemColKey(c))
  for (const meta of EXPORT_META_COLUMNS) m.set(exportMetaHeader(meta.key), exportItemMetaKey(meta.key))
  for (const slot of exportRoundSlots.value) m.set(roundExportHeader(slot), exportItemRoundKey(slot.id))
  return m
})

/**
 * 结果页预览（渐进式加载）：
 * - 未筛选：只构建前 resultBuildLimit 行，滚动到底继续扩窗口（不再 500 行截断）；
 * - 筛选 / 搜索时：构建全量后过滤（否则搜索不到还没构建的行），命中集再分批渲染。
 * 列与取值仍与导出完全一致（同一 buildExportTable）。
 */
const resultBuildLimit = ref(RESULT_PAGE_SIZE)
const resultDisplayLimit = ref(RESULT_PAGE_SIZE)
/** 搜索：任意列包含关键字 */
const resultSearchKeyword = ref('')
/** 筛选：指定列 + 值包含（只选列不填值 = 该列必须有内容） */
const resultFilterCol = ref('')
const resultFilterValue = ref('')
const resultJumpInput = ref('')
/** 跳转高亮的行（结果表里的序号，0 起） */
const resultHighlightIndex = ref(-1)
const resultWrapRef = ref<HTMLElement | null>(null)
/** 「只看已移除」开关（结果页）：源表重读后对应任务行已被删掉的记录 */
const removedOnly = ref(false)
/** 「只看异常结果」开关（结果页）：找不到对应任务行的记录（行号缺失 / 超出当前行数） */
const extraOnly = ref(false)
/** 一条结果是否找不到对应任务行（行号缺失 / 超出当前任务行数；不含「已移除」） */
const isExtraResultRef = (ref?: ResultRowRef): boolean => {
  if (!ref || ref.kind !== 'record') return false
  const rec = datasetRows.value[ref.index]
  if (!rec || rec._removed) return false
  const no = Number(rec._rowNo) || 0
  return no <= 0 || no > rows.value.length
}
/** 异常结果条数（结构化提取下的「无主」记录） */
const extraResultCount = computed(() => outputMode.value !== 'structured'
  ? 0
  : datasetRows.value.filter(d => {
    if (!d || d._removed) return false
    const no = Number(d._rowNo) || 0
    return no <= 0 || no > rows.value.length
  }).length)
/** 与任务行对不上的结果条数（异常 + 已移除）：> 0 时「同步结果」按钮高亮 */
const resultMismatchNote = computed(() => {
  const n = extraResultCount.value + removedResultCount.value
  if (!n) return ''
  return en()
    ? `${n} result(s) do not match the task rows — click “Sync results” to rebuild them`
    : `有 ${n} 条结果与任务行对不上——点「同步结果」按任务行重建`
})
/** 「同步结果」按钮的悬停说明 */
const syncResultsTitle = computed(() => {
  const head = en()
    ? 'Rebuild the results from the current task rows: every row keeps exactly the records it produced (row numbers and data re-aligned), and leftovers that belong to no row are removed.'
    : '按当前任务行重建结果：每个任务行只保留它自己产出的记录（行号与数据重新对齐），不属于任何任务行的残留会被清掉。'
  return head + (resultMismatchNote.value ? '\n⚠ ' + resultMismatchNote.value : '')
})
/**
 * 同步结果：按当前任务行重建结果（数量与数据都对上）。
 * 结构化 = 用各任务行的 `extracted`（与数据集是同一批对象）重建数据表 + 重编行号；
 * 其余模式 = 清掉「已移除」旧结果列表。最后重写当前轮次快照。
 */
const syncResultsToRows = async () => {
  if (isRunning.value || isLoading.value) return
  const extra = extraResultCount.value
  const removed = removedResultCount.value
  if (!extra && !removed) {
    captureCurrentRound()
    setStatusHint('ok', en() ? 'Results already match the task rows' : '结果已经与任务行一致')
    return
  }
  try {
    await ElMessageBox.confirm(
      en()
        ? `Rebuild the results from the current task rows? ${extra + removed} result(s) that belong to no row will be deleted.`
        : `按当前任务行重建结果吗？与任务行对不上的 ${extra + removed} 条残留结果将被删除。`,
      en() ? 'Confirm' : '提示',
      { confirmButtonText: en() ? 'Confirm' : '确定', cancelButtonText: en() ? 'Cancel' : '取消', type: 'warning' }
    )
    let cleaned = 0
    if (outputMode.value === 'structured') {
      const used = new Set<any>()
      const next: any[] = []
      rows.value.forEach((r, i) => {
        for (const rec of (Array.isArray(r.extracted) ? r.extracted : [])) {
          if (!rec || used.has(rec)) continue
          used.add(rec)
          // 直接改原对象（与行上的 extracted 是同一批引用，删/改才能双向同步）
          rec._rowNo = i + 1
          if (rec._removed) delete rec._removed
          next.push(rec)
        }
      })
      cleaned = datasetRows.value.length - next.length
      datasetRows.value = next
    } else {
      cleaned = removedRows.value.length
      removedRows.value = []
    }
    removedOnly.value = false
    extraOnly.value = false
    captureCurrentRound()
    recountRows()
    resetPages()
    addLog('info', en()
      ? `Results rebuilt from the task rows: ${cleaned} leftover result(s) removed`
      : `已按任务行重建结果：清掉 ${cleaned} 条与任务行对不上的残留`)
    setStatusHint('ok', en()
      ? `Results synced — ${cleaned} leftover result(s) removed`
      : `结果已同步——清掉 ${cleaned} 条残留`)
  } catch { /* 用户取消 */ }
}
/** 删除当前筛出来的残留（异常 / 已移除）——结果页「删除这些」按钮 */
const deleteFilteredTitle = computed(() => {
  const n = extraOnly.value ? extraResultCount.value : removedResultCount.value
  return en()
    ? `Delete these ${n} result(s) (the “Clear” to the left only cancels the filter)`
    : `删除当前筛出来的 ${n} 条结果（左侧「清除」只取消筛选、不删结果）`
})
const deleteFilteredExtras = async () => {
  const isExtra = extraOnly.value
  const n = isExtra ? extraResultCount.value : removedResultCount.value
  if (!n) return
  try {
    await ElMessageBox.confirm(
      en() ? `Delete these ${n} result(s)? This cannot be undone.` : `删除这 ${n} 条结果吗？删除后无法恢复。`,
      en() ? 'Confirm' : '提示',
      { confirmButtonText: en() ? 'Delete' : '删除', cancelButtonText: en() ? 'Cancel' : '取消', type: 'warning' }
    )
    if (isExtra) {
      for (let i = datasetRows.value.length - 1; i >= 0; i--) {
        const d = datasetRows.value[i]
        if (!d || d._removed) continue
        const no = Number(d._rowNo) || 0
        if (no <= 0 || no > rows.value.length) datasetRows.value.splice(i, 1)
      }
    } else if (outputMode.value === 'structured') {
      for (let i = datasetRows.value.length - 1; i >= 0; i--) {
        if (datasetRows.value[i]?._removed) datasetRows.value.splice(i, 1)
      }
    } else {
      removedRows.value = []
    }
    extraOnly.value = false
    removedOnly.value = false
    const slot = activeRound.value
    if (slot) slot.dataset = datasetRows.value.slice()
    recountRows()
    addLog('info', en() ? `Deleted ${n} leftover result(s)` : `已删除 ${n} 条残留结果`)
    setStatusHint('ok', en() ? `Deleted ${n} leftover result(s)` : `已删除 ${n} 条残留结果`)
  } catch { /* 用户取消 */ }
}
/** 结果页「异常 N」按钮：点一下只看这些无主结果（再点取消） */
const toggleExtraOnly = () => {
  if (!extraResultCount.value) return
  extraOnly.value = !extraOnly.value
  if (extraOnly.value) removedOnly.value = false
  resultDisplayLimit.value = RESULT_PAGE_SIZE
  resultHighlightIndex.value = -1
}
const extraToggleTitle = computed(() => en()
  ? `Show only the ${extraResultCount.value} result(s) that belong to no current task row (row number missing, or beyond the current row count) — usually leftovers from source changes or round switching; delete them one by one if not needed`
  : `只看找不到对应任务行的那 ${extraResultCount.value} 条结果（行号缺失，或超出当前任务行数）——多为源表改动 / 多轮切换留下的残留，不需要可逐条删除`)
/** 一条结果是否来自「任务行已被删掉」的记录（只有结构化提取才会把这种记录留在数据表里） */
const isRemovedResultRef = (ref?: ResultRowRef): boolean => {
  if (!ref) return false
  if (ref.kind === 'removed') return true
  if (ref.kind !== 'record') return false
  const rec = datasetRows.value[ref.index]
  return !!rec?._removed
}
/** 结果里标「已移除」的行数（结构化 = 记录数，其余 = 旧行列表长度）；> 0 时工具栏才出现筛选按钮 */
const removedResultCount = computed(() => outputMode.value === 'structured'
  ? datasetRows.value.filter(d => d && d._removed).length
  : removedRows.value.length)
/** 结果页「已移除 N」按钮：点一下只看这些记录（再点取消） */
const toggleRemovedOnly = () => {
  if (!removedResultCount.value) return
  removedOnly.value = !removedOnly.value
  if (removedOnly.value) extraOnly.value = false
  resultDisplayLimit.value = RESULT_PAGE_SIZE
  resultHighlightIndex.value = -1
}
const removedToggleTitle = computed(() => en()
  ? `Show only the ${removedResultCount.value} result(s) whose source row was removed when the table was re-read (click again to clear)`
  : `只看源表重读后任务行已被删掉的那 ${removedResultCount.value} 条结果（再点一次取消）`)
/** 详情页工具栏的「移除 N」分段：点它直接到结果页并只看「已移除」的记录 */
const openRemovedResults = () => {
  if (!sourceDelta.removed) return
  if (!removedResultCount.value) {
    setStatusHint('info', en()
      ? 'Removed rows left no results here (only structured extraction keeps them) — nothing to filter'
      : '被删掉的行没有留在结果里（非结构化提取不保留），没有可筛选的记录')
    return
  }
  removedOnly.value = true
  resultDisplayLimit.value = RESULT_PAGE_SIZE
  activeTab.value = 'results'
}
const resultHasFilter = computed(() => !!resultSearchKeyword.value.trim() || !!resultFilterCol.value || removedOnly.value || extraOnly.value)
const resultGrandTotal = computed(() => outputMode.value === 'structured'
  ? datasetRows.value.length
  : rows.value.length + removedRows.value.length)
/**
 * 结果页底部统计：解释「为什么结果条数多于任务行数」（结构化提取一行可产出多条记录），
 * 并分别给出「一行多条 / 无对应任务行（异常）/ 已移除」各多少。
 */
const resultCountBreakdown = computed(() => {
  if (outputMode.value !== 'structured' || !rows.value.length) return ''
  if (resultGrandTotal.value <= rows.value.length) return ''
  let removed = 0
  let extra = 0
  let attached = 0
  const rowNos = new Set<number>()
  for (const d of datasetRows.value) {
    if (!d) continue
    if (d._removed) { removed++; continue }
    const no = Number(d._rowNo) || 0
    if (no <= 0 || no > rows.value.length) { extra++; continue }
    attached++
    rowNos.add(no)
  }
  const oneToMany = attached - rowNos.size
  const parts: string[] = []
  if (oneToMany > 0) parts.push(en() ? `${oneToMany} extra from multi-record rows` : `一行多条 ${oneToMany} 条`)
  if (extra > 0) parts.push(en() ? `${extra} with no task row` : `无对应任务行 ${extra} 条`)
  if (removed > 0) parts.push(en() ? `${removed} removed` : `已移除 ${removed} 条`)
  if (!parts.length) return ''
  return en()
    ? ` (${resultGrandTotal.value} result(s) vs ${rows.value.length} task row(s): ${parts.join(', ')})`
    : `（${resultGrandTotal.value} 条结果 / ${rows.value.length} 个任务行：${parts.join('、')}）`
})
/** 构建结果（筛选时全量；未筛选时只建到当前窗口） */
const resultTable = computed(() => {
  if (outputMode.value === 'structured' && !datasetRows.value.length) {
    return { columns: [] as string[], rows: [] as Array<Record<string, string>>, refs: [] as ResultRowRef[] }
  }
  return buildExportTable(resultHasFilter.value ? undefined : resultBuildLimit.value)
})
const resultColumns = computed(() => resultTable.value.columns)
/** 改过名的列：当前列名 → 原名（结果页表头悬停显示） */
const resultColumnOrigins = computed(() => {
  const m = new Map<string, string>()
  const add = (c: string, key: string) => {
    const n = exportHeaderName(key, c)
    if (n !== c) m.set(n, c)
  }
  for (const c of columns.value) add(c, exportItemColKey(c))
  for (const meta of EXPORT_META_COLUMNS) add(exportMetaHeader(meta.key), exportItemMetaKey(meta.key))
  for (const slot of exportRoundSlots.value) add(roundExportHeader(slot), exportItemRoundKey(slot.id))
  return m
})
/** 结果页表头的悬停说明：改过名的列标出原名（导出 Excel 的列名即这里显示的名字） */
const resultColumnTitle = (col: string): string => {
  const orig = resultColumnOrigins.value.get(col)
  if (!orig) return col
  return en() ? `${col} — original column: ${orig}` : `${col}（原名：${orig}）`
}
/** 预览行 + 来源引用（下标记为「第几行预览」，与表格显示的 # 一致） */
const resultRowsWithRef = computed(() => {
  const t = resultTable.value
  return t.rows.map((data, i) => ({ data, ref: t.refs[i] }))
})
/** 已构建范围内筛选命中的行 */
const resultFilteredRows = computed(() => {
  const all = resultRowsWithRef.value
  const kw = resultSearchKeyword.value.trim().toLowerCase()
  const col = resultFilterCol.value
  const val = resultFilterValue.value.trim().toLowerCase()
  if (!kw && !col && !removedOnly.value && !extraOnly.value) return all
  return all.filter(it => {
    if (removedOnly.value && !isRemovedResultRef(it.ref)) return false
    if (extraOnly.value && !isExtraResultRef(it.ref)) return false
    const r = it.data
    if (kw && !Object.values(r).join('\n').toLowerCase().includes(kw)) return false
    if (col) {
      const v = String(r[col] ?? '')
      if (val) { if (!v.toLowerCase().includes(val)) return false }
      else if (!v.trim()) return false
    }
    return true
  })
})
const resultHitCount = computed(() => resultFilteredRows.value.length)
/** 结果页应显示的“总行数”：无筛选 = 源总行数（已经知道总数，不需先全建）；有筛选 = 命中数 */
const resultShownTotal = computed(() => resultHasFilter.value
  ? resultFilteredRows.value.length
  : Math.max(resultTable.value.rows.length, resultGrandTotal.value))
const resultVisibleRows = computed(() => resultFilteredRows.value
  .map((it, i) => ({ no: i + 1, data: it.data, ref: it.ref }))
  .slice(0, resultDisplayLimit.value))
/** 结果 → 所属任务行（结构化记录看 `_rowNo`；单结果行 = 行号；源行已删除的记录标 removed） */
const resultTaskRow = (item: { ref?: ResultRowRef }): { no: number; removed: boolean } => {
  const ref = item?.ref
  if (!ref) return { no: 0, removed: false }
  if (ref.kind === 'removed') return { no: 0, removed: true }
  if (ref.kind === 'record') {
    const rec = datasetRows.value[ref.index]
    if (!rec) return { no: 0, removed: false }
    if (rec._removed) return { no: 0, removed: true }
    return { no: Number(rec._rowNo) || 0, removed: false }
  }
  return { no: ref.index + 1, removed: false }
}
const resultTaskRowTitle = computed(() => en()
  ? 'Which task row this result belongs to — click to open it in the Details tab (rows whose source row was deleted from the re-imported table show “removed”)'
  : '这条结果属于哪个任务行——点行号会跳到「详情」页并高亮该行（源表删掉的行显示「已移除」）')
const resultRemovedHint = computed(() => en()
  ? 'The source row was removed when the table was re-imported — the result is kept here (delete it manually if not needed)'
  : '重读表格时这一行已经从源表里删掉了——结果仍保留在这里（不需要可手动删除）')
/** 结果 → 任务行跳转（切到「详情」页并高亮该行） */
const jumpToTaskRow = async (no: number) => {
  if (!no) return
  jumpInput.value = String(no)
  await jumpToRow()
}
/** 源数据是否已全部构建（构建出的行数少于窗口 → 到底了） */
const resultAllBuilt = computed(() => resultHasFilter.value || resultTable.value.rows.length < resultBuildLimit.value)
const canLoadMoreResults = computed(() => resultDisplayLimit.value < resultShownTotal.value || !resultAllBuilt.value)
const loadMoreResults = () => {
  resultDisplayLimit.value += RESULT_PAGE_SIZE
  if (!resultHasFilter.value && resultBuildLimit.value < resultDisplayLimit.value) {
    resultBuildLimit.value = Math.min(resultDisplayLimit.value, Math.max(resultGrandTotal.value, RESULT_PAGE_SIZE) + RESULT_PAGE_SIZE)
  }
}
const onResultScroll = (e: Event) => {
  const el = e.target as HTMLElement
  if (!el) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 300) loadMoreResults()
}
const clearResultFilters = () => {
  resultSearchKeyword.value = ''
  resultFilterCol.value = ''
  resultFilterValue.value = ''
  removedOnly.value = false
  extraOnly.value = false
}
/** 行号跳转（结果表里的第 N 行，1 起）：不够就先把窗口撑到该行，再滚动高亮 */
const jumpResultRow = async () => {
  const n = parseInt(String(resultJumpInput.value || '').trim(), 10)
  const total = resultShownTotal.value
  if (!Number.isFinite(n) || n < 1 || n > total) {
    addLog('warning', en() ? `Row ${resultJumpInput.value} is out of range (1–${total})` : `行号 ${resultJumpInput.value} 超出范围（1–${total}）`)
    return
  }
  if (n > resultDisplayLimit.value) resultDisplayLimit.value = Math.ceil(n / RESULT_PAGE_SIZE) * RESULT_PAGE_SIZE
  // 未筛选时行是分批构建的：必要时把构建窗口撑到能包含该行
  while (!resultHasFilter.value && resultTable.value.rows.length < n && canLoadMoreResults.value) loadMoreResults()
  resultHighlightIndex.value = n - 1
  await nextTick()
  resultWrapRef.value?.querySelector(`[data-result-row="${n}"]`)?.scrollIntoView({ block: 'center' })
}
// 筛选 / 搜索变化：回到第一批（并切到全量构建），清掉跳转高亮
watch([resultSearchKeyword, resultFilterCol, resultFilterValue, removedOnly, extraOnly], () => {
  resultDisplayLimit.value = RESULT_PAGE_SIZE
  resultHighlightIndex.value = -1
  resultBuildLimit.value = resultHasFilter.value ? RESULT_PAGE_SIZE : RESULT_PAGE_SIZE
})
const deleteResultTitle = computed(() => en()
  ? 'Delete THIS result only (task rows & settings kept): a structured record is removed from the dataset, other modes clear that row’s result / written-back columns and put it back to Pending.'
  : '只删除这一条结果（任务行与配置保留）：结构化提取=从数据表里删掉这条记录；其它模式=清掉该行的结果 / 写回列并回到「待处理」。')
/**
 * 结果页逐条删除（最右列的图标）：
 * - 结构化记录 → 从 datasetRows 移除该条，并同步删掉任务行上的同一条提取结果；
 * - 没解析出记录的任务行（orphan）/ 单独结果 → 清掉该行的结果 / 写回列 / 状态回到待处理（任务行保留）。
 */
const deleteResultRow = (item: { no: number; data: Record<string, string>; ref?: ResultRowRef }) => {
  const ref = item?.ref
  if (!ref) return
  if (ref.kind === 'removed') {
    removedRows.value.splice(ref.index, 1)
    addLog('info', en()
      ? `Deleted 1 removed-source result (${removedRows.value.length} left)`
      : `已删除 1 条「已移除」的旧结果（剩余 ${removedRows.value.length} 条）`)
    setStatusHint('ok', en() ? 'Result deleted' : '已删除该结果')
    return
  }
  if (ref.kind === 'record') {
    const d = datasetRows.value[ref.index]
    if (!d) return
    const rowNo = Number(d._rowNo) || 0
    datasetRows.value.splice(ref.index, 1)
    // 行详情里的提取结果同步移除（sinks 写入的是同一个对象引用）；
    // 「源行已移除」的旧记录不挂在任何行上，不用回查行
    if (rowNo > 0 && !d._removed) {
      const taskRow = rows.value[rowNo - 1]
      const list = taskRow?.extracted
      if (Array.isArray(list)) {
        const at = list.indexOf(d)
        if (at >= 0) list.splice(at, 1)
      }
    }
    const slot = activeRound.value
    if (slot) slot.dataset = datasetRows.value.slice()
    addLog('info', en()
      ? `Deleted 1 extracted record (${datasetRows.value.length} left)`
      : `已删除 1 条提取结果（剩余 ${datasetRows.value.length} 条）`)
  } else {
    const taskRow = rows.value[ref.index]
    if (!taskRow) return
    applyStatusChange(taskRow.status, 'pending')
    taskRow.status = 'pending'
    resetRowRunState(taskRow)
    // 逐列写回：结果落在原表新列里，一并清掉这些列
    for (const name of writeBackColumns.value) delete taskRow.data?.[name]
    recountRows()
    const slot = activeRound.value
    if (slot) slot.results = buildRoundResults()
    addLog('info', en() ? 'Deleted this row’s result (row kept, back to Pending)' : '已删除该行结果（任务行保留，状态回到待处理）')
  }
  setStatusHint('ok', en() ? 'Result deleted' : '已删除该结果')
}

/** 结果页空态文案（结构化未提取 / 单结果无行） */
const resultEmptyHint = computed(() => {
  if (outputMode.value === 'structured') {
    if (isFolderSource.value) return en() ? 'No extracted data yet — scan a folder and run.' : '暂无提取数据——请扫描文件夹并运行'
    if (isTextSource.value) return en() ? 'No extracted data yet — create rows from text and run.' : '暂无提取数据——请先生成任务行并运行'
    return en() ? 'No extracted data yet — run the structured extraction first.' : '暂无提取数据——请先运行结构化提取'
  }
  return rowsEmptyHint.value
})

/** 导出分片大小：每片这么多行（片间让出事件循环 → 界面不卡，同时刷新状态栏进度） */
const EXPORT_CHUNK = 2000
/** 是否正在导出（导出中禁用按钮：两次导出交叉发分片会写坏文件） */
const exporting = ref(false)
/** 导出进度文案（状态栏最左侧） */
const exportProgressText = (done: number, total: number) => en()
  ? `Exporting ${done}/${total} rows...`
  : `导出 ${done}/${total} 行...`

/**
 * 分片导出（大表格不卡界面）：
 * - 先让用户选保存位置（主进程弹框）；
 * - 渲染层每 EXPORT_CHUNK 行构建一次 → 立刻发给主进程追加进工作表 → 让出事件循环 + 刷新状态栏进度；
 * - 全部发完再让主进程一次性落盘。
 * 这样既不会在渲染层一次性建出全部行对象（以前配合 JSON.parse(JSON.stringify()) 很容易卡死），
 * 也不会把几十万行塞进单个 IPC 消息让主进程长时间处理不了别的消息。
 */
const exportRowsChunked = async (filename: string, plan: ExportPlan): Promise<void> => {
  if (exporting.value) return
  exporting.value = true
  try {
    await runExport(filename, plan, new Date().toISOString().slice(0, 10))
  } finally {
    exporting.value = false
  }
}

/** 真正的导出流程（按有无 Electron 分两条路；外面包 exporting 防止重入） */
const runExport = async (filename: string, plan: ExportPlan, date: string): Promise<void> => {
  const total = plan.refs.length
  const ipc = window.ipcRenderer
  if (ipc) {
    setStatusHint('saving', en() ? 'Waiting for the save location…' : '等待选择保存位置…')
    let start: any
    try {
      start = await ipc.invoke('exportExcel:start', { filename, header: plan.columns })
    } catch (e: any) {
      addLog('error', `导出失败: ${e?.message || e}`)
      setStatusHint('err', en() ? 'Export failed (see Logs)' : '导出失败（详见日志）', String(e?.message || e))
      return
    }
    if (!start?.success) {
      if (start?.error === '用户取消') {
        addLog('info', en() ? 'Export canceled' : '已取消导出')
        setStatusHint('info', en() ? 'Export canceled' : '已取消导出')
      } else {
        addLog('error', `导出失败: ${start?.error || ''}`)
        setStatusHint('err', en() ? 'Export failed (see Logs)' : '导出失败（详见日志）', String(start?.error || ''))
      }
      return
    }
    try {
      setStatusHint('saving', exportProgressText(0, total))
      for (let off = 0; off < total; off += EXPORT_CHUNK) {
        const rows = plan.refs.slice(off, off + EXPORT_CHUNK).map(r => exportRowAt(plan, r))
        const res = await ipc.invoke('exportExcel:chunk', { rows, header: plan.columns })
        if (!res?.success) throw new Error(res?.error || '写入导出分片失败')
        setStatusHint('saving', exportProgressText(Math.min(off + EXPORT_CHUNK, total), total))
        await new Promise(r => setTimeout(r, 0))
      }
      const done = await ipc.invoke('exportExcel:done', {})
      if (!done?.success) throw new Error(done?.error || '保存导出文件失败')
      addLog('info', `导出成功: ${done.path}（${total} 行）`)
      setStatusHint('ok', en() ? `Exported ${total} row(s)` : `已导出 ${total} 行`, done.path)
    } catch (e: any) {
      await ipc.invoke('exportExcel:abort', {}).catch(() => { /* 忽略 */ })
      addLog('error', `导出失败: ${e?.message || e}`)
      setStatusHint('err', en() ? 'Export failed (see Logs)' : '导出失败（详见日志）', String(e?.message || e))
    }
    return
  }
  // 浏览器（无 Electron）：同样分片构建（让出事件循环 + 状态栏进度），最后直接下载
  const all: Array<Record<string, string>> = []
  setStatusHint('saving', exportProgressText(0, total))
  for (let off = 0; off < total; off += EXPORT_CHUNK) {
    for (const r of plan.refs.slice(off, off + EXPORT_CHUNK)) all.push(exportRowAt(plan, r))
    setStatusHint('saving', exportProgressText(Math.min(off + EXPORT_CHUNK, total), total))
    await new Promise(r => setTimeout(r, 0))
  }
  const ws = XLSX.utils.json_to_sheet(all, { header: plan.columns })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  XLSX.writeFile(wb, `${filename}.xlsx`)
  addLog('info', en() ? 'Export done (browser download)' : '导出成功（浏览器下载）')
  setStatusHint('ok', en() ? 'Exported (browser download)' : '已导出（浏览器下载）', `${filename}_${date}.xlsx`)
}

const exportData = async () => {
  if (exporting.value) {
    addLog('warning', en() ? 'An export is already running' : '已有导出正在进行，请稍等')
    return
  }
  // 预览与导出共用同一套组装（buildExportPlan + exportRowAt）→ 所见即所导
  const plan = buildExportPlan()
  if (!plan.refs.length) {
    addLog('warning', en() ? 'No data to export' : '没有数据可导出')
    setStatusHint('info', en() ? 'No data to export' : '没有数据可导出')
    return
  }
  // 结构化输出（纯 LLM 提取 / 智能体 JSON）：导出数据集（原表列 + 提取字段 + 运行信息 + 来源）
  const filename = plan.structured
    ? `${en() ? 'File-collection results' : '文件采集结果'}_${new Date().toISOString().slice(0, 10)}`
    : `${en() ? 'Batch agent run' : '批量智能体执行'}${activeRound.value?.label ? '_' + activeRound.value.label : ''}_${new Date().toISOString().slice(0, 10)}`
  if (plan.refs.length > EXPORT_CHUNK) {
    addLog('info', en()
      ? `Exporting ${plan.refs.length} row(s) in chunks — progress in the status bar`
      : `正在分片导出 ${plan.refs.length} 行（进度见状态栏）`)
  }
  await exportRowsChunked(filename, plan)
}

// ==================== 任务状态保存 / 读取 ====================
// v2：只保存推理结果与状态（不含表格数据列/日志），加载后重新导入表格按行索引合并，避免大表格保存白屏
type SavedResult = {
  status?: BatchRowStatus
  result?: string
  error?: string
  inputTokens?: number
  outputTokens?: number
  startedAt?: string
  finishedAt?: string
  retryCount?: number
  emptyRetryCount?: number
  /** 行指纹（严格版 + 归一化版）与行标识：重读源表时用来把结果对回正确的行 */
  sig?: string
  sigNorm?: string
  key?: string
}
const pendingResults = ref<SavedResult[]>([])
/** 任务文件里保留过的行过程快照（图谱数据）：与 results 同一套行索引，待行就绪后合并 */
const pendingTraces = ref<any[]>([])
/** 把暂存的过程快照合并到行上（同结果一样按行指纹对位），返回合并数 */
const applyPendingTraces = (): number => {
  if (!pendingTraces.value.length || !rows.value.length) return 0
  const map = matchSavedRows(pendingTraces.value, rows.value)
  let applied = 0
  rows.value.forEach((r, i) => {
    const j = map.newToOld[i]
    if (j < 0 || map.kind[i] !== 'same') return
    const t = pendingTraces.value[j]
    if (t && Array.isArray(t.trace) && t.trace.length) {
      r.trace = t.trace
      r.stepsCount = Number(t.stepsCount) || t.trace.length
      applied++
    }
  })
  pendingTraces.value = []
  return applied
}

// 分批序列化：把大 results 数组切片逐个 stringify，中间让出事件循环避免主线程阻塞白屏
const buildTaskJson = async (state: any): Promise<string> => {
  const results: any[] = state.results || []
  const rest: any = { ...state, results: undefined }
  let json = JSON.stringify(rest)
  json = json.slice(0, -1) + ',"results":['
  const parts: string[] = []
  const CHUNK = 5000
  for (let i = 0; i < results.length; i += CHUNK) {
    parts.push(JSON.stringify(results.slice(i, i + CHUNK)).slice(1, -1))
    if ((i / CHUNK) % 4 === 3) await new Promise((r) => setTimeout(r, 0))
  }
  json += parts.join(',') + ']}'
  return json
}

// ==================== 保存结果 ↔ 当前行 的对位（源表增删行后不错位） ====================
/** 保存下来的行数据（results / traces 同索引）与当前行的对应关系 */
type SavedRowMap = {
  /** 新行下标 → 旧下标（-1 = 新增行，没有历史） */
  newToOld: number[]
  /** 新行下标与旧行的关系：same = 同一个源行；changed = 同一行但源数据变了（结果保留，标「已变更」）；added = 新行 */
  kind: Array<'same' | 'changed' | 'added'>
  /** 旧下标 → 新行下标（-1 = 该源行已被移除） */
  oldToNew: number[]
  /** 是否用了指纹对位（false = 按行号对位） */
  bySig: boolean
  /** 严格指纹（整行文本一致）匹配上的行数 */
  sigMatched: number
  /** 归一化指纹（忽略数字写法 / 空白差异）匹配上的行数 */
  normMatched: number
  /** 靠行标识（首列值）匹配上的行数——源数据改过的行能靠它保持对齐 */
  keyMatched: number
  /** 能认出是同一行的总行数（严格指纹 + 归一化指纹 + 行标识），用于判断「能否认出源表」 */
  matched: number
  /** 同 matched（单独一份：合并层文案里要用，不参与其它逻辑） */
  identified: number
  /** true = 没能定位增 / 删位置，只报了「行数差」（新增 / 移除 未定位到具体行） */
  coarse: boolean
}
/**
 * 把「按旧行序保存的数据」映射到当前行：
 * ① 整行指纹一致 = 同一个源行（源表中间插/删行、重排都不会让结果错位）；
 * ② 归一化指纹一致 = 同一个源行（内容没变，只是 Excel 复存把单元格换个写法）；
 * ③ 指纹对不上但**行标识（首列值）一致** = 同一行、源数据被改过 → changed（结果仍留在该行上，只标「已变更」）；
 * ④ 剩下的按同位置兑底配；两边都没有行指纹 / 标识（极旧文件）时也只能按位置配。
 * 旧数据里没被认领的就是被删掉的源行（removed），新行没配上结果的就是新增行（added）。
 */
const matchSavedRows = (saved: any[], target: BatchRow[]): SavedRowMap => {
  const newToOld = target.map(() => -1)
  const kind = target.map(() => 'added' as 'same' | 'changed' | 'added')
  const oldToNew = saved.map(() => -1)
  const sigOfSaved = (i: number): string => (saved[i] && typeof saved[i].sig === 'string' ? saved[i].sig : '')
  /**
   * 同一行到底算不算「已变更」：
   * ① 严格指纹一致 = 完全没变；
   * ② 两侧都有**归一化指纹** → 归一化后不同才算变更（Excel 复存的写法差异不算）；
   * ③ 只有一侧（老任务文件没存归一化指纹）→ **不猜**，一律当 same：
   *    宁可漏标「已变更」，也不要因为 Excel 换个写法就满屏误报（重跑一遍即可）。
   */
  const classify = (r: BatchRow, j: number): 'same' | 'changed' => {
    const sSig = sigOfSaved(j)
    const sNorm = saved[j] && typeof saved[j].sigNorm === 'string' ? saved[j].sigNorm : ''
    if (r.sig && sSig && r.sig === sSig) return 'same'
    if (r.sigNorm && sNorm) return r.sigNorm === sNorm ? 'same' : 'changed'
    return 'same'
  }
  const keyOfSaved = (i: number): string => (saved[i] && typeof saved[i].key === 'string' ? saved[i].key : '')
  const positional = (): SavedRowMap => {
    const n = Math.min(target.length, saved.length)
    for (let i = 0; i < n; i++) { newToOld[i] = i; oldToNew[i] = i; kind[i] = 'same' }
    return { newToOld, kind, oldToNew, bySig: false, sigMatched: 0, normMatched: 0, keyMatched: 0, matched: n, identified: n, coarse: false }
  }
  const sigNormOfSaved = (i: number): string => (saved[i] && typeof saved[i].sigNorm === 'string' ? saved[i].sigNorm : '')
  const canSig = saved.some(s => s && typeof s.sig === 'string' && s.sig)
    && target.some(r => !!r.sig)
  // 归一化指纹对位：新任务文件两侧都有 sigNorm，Excel 复存造成的写法差异不影响识别
  const canNorm = saved.some(s => s && typeof s.sigNorm === 'string' && s.sigNorm)
    && target.some(r => !!r.sigNorm)
  const canKey = saved.some(s => s && typeof s.key === 'string' && s.key)
    && target.some(r => !!rowKeyOf(r.data))
  if (!canSig && !canNorm && !canKey) return positional()
  let sigMatched = 0
  let normMatched = 0
  let keyMatched = 0
  // ① 整行指纹一致的 = 同一个源行（源表中间插/删行、重排都不会让结果错位）
  //    指纹是短哈希，理论上会撞车——两侧都有归一化指纹时再校一次，避开「哈希相同但内容不同」的假匹配。
  if (canSig) {
    const queues = new Map<string, number[]>()
    saved.forEach((s, i) => {
      const sig = sigOfSaved(i)
      if (!sig) return
      const q = queues.get(sig)
      if (q) q.push(i)
      else queues.set(sig, [i])
    })
    target.forEach((r, i) => {
      if (!r.sig) return
      const q = queues.get(r.sig)
      if (!q || !q.length) return
      let pick = -1
      for (let k = 0; k < q.length; k++) {
        const sn = sigNormOfSaved(q[k])
        if (r.sigNorm && sn && r.sigNorm !== sn) continue
        pick = k
        break
      }
      if (pick < 0) return
      const j = q.splice(pick, 1)[0]
      newToOld[i] = j
      oldToNew[j] = i
      kind[i] = 'same'
      sigMatched++
    })
  }
  // ② 归一化指纹一致的 = 同一个源行（内容其实没变，只是 Excel 复存把单元格换了个写法：
  //    千分位 / 多余 .0 / 前后空白等）——归一化后相同就不标「已变更」。
  if (canNorm) {
    const queues = new Map<string, number[]>()
    saved.forEach((s, i) => {
      if (oldToNew[i] >= 0) return
      const norm = sigNormOfSaved(i)
      if (!norm) return
      const q = queues.get(norm)
      if (q) q.push(i)
      else queues.set(norm, [i])
    })
    target.forEach((r, i) => {
      if (newToOld[i] >= 0 || !r.sigNorm) return
      const q = queues.get(r.sigNorm)
      if (!q || !q.length) return
      const j = q.shift() as number
      newToOld[i] = j
      oldToNew[j] = i
      kind[i] = 'same'
      normMatched++
    })
  }
  // ③ 指纹对不上时用**行标识（首个非空单元格的值）**认同一行：
  //    只在该标识「两侧都唯一」时才用（有重复值就宁可不用，免得把行配错）。
  //    到底算不算「已变更」：只有两侧都带**归一化指纹**且不同才判 changed——
  //    否则（老任务文件没归一化指纹、或只是换了个写法）一律当 same，
  //    避免 Excel 复存一次就满屏误报「已变更」。
  if (canKey) {
    const savedKeyCount = new Map<string, number>()
    for (let i = 0; i < saved.length; i++) {
      if (oldToNew[i] >= 0) continue
      const k = keyOfSaved(i)
      if (k) savedKeyCount.set(k, (savedKeyCount.get(k) || 0) + 1)
    }
    const keyIndex = new Map<string, number>()
    for (let i = 0; i < saved.length; i++) {
      if (oldToNew[i] >= 0) continue
      const k = keyOfSaved(i)
      if (k && savedKeyCount.get(k) === 1) keyIndex.set(k, i)
    }
    if (keyIndex.size) {
      const newKeyCount = new Map<string, number>()
      target.forEach((r, i) => {
        if (newToOld[i] >= 0) return
        const k = rowKeyOf(r.data)
        if (k) newKeyCount.set(k, (newKeyCount.get(k) || 0) + 1)
      })
      target.forEach((r, i) => {
        if (newToOld[i] >= 0) return
        const key = rowKeyOf(r.data)
        if (!key || newKeyCount.get(key) !== 1) return
        const j = keyIndex.get(key)
        if (j === undefined || oldToNew[j] >= 0) return
        newToOld[i] = j
        oldToNew[j] = i
        kind[i] = classify(r, j)
        keyMatched++
      })
    }
  }
  // ④ 剩余行的配对：两种口径都算一遍，取**可信**的那个
  //   fine = 用「行号不交叉」的锚点把两侧切成一段段、段内按顺序配对
  //          → 能定位到具体是哪几行被增 / 删（识别率高时最准）；
  //   coarse = 不切段，剩下的行整段按顺序配对
  //          → 只保证「行数差」（新增 = 多出来的行数、移除 = 少掉的行数）。
  //   只有当 fine 的结论「不大」（≤ 净差 + 20）时才采用它：锚点一旦误配（行被移动 /
  //   重复行配错），一行的增删会被放大成上百对「新增 + 移除」，此时宁可只报净差。
  //   注：coarse 里配对是猜的，所以不标「已变更」；fine 里才按 classify 判。
  const baseI = newToOld.slice()
  const baseJ = oldToNew.slice()
  const baseK = kind.slice()
  const runPairing = (useAnchors: boolean) => {
    const ti = baseI.slice()
    const sj = baseJ.slice()
    const kd = baseK.slice()
    const pairRun = (tFrom: number, tTo: number, sFrom: number, sTo: number): void => {
      if (tTo <= tFrom || sTo <= sFrom) return
      const n = Math.min(tTo - tFrom, sTo - sFrom)
      for (let k = 0; k < n; k++) {
        const i = tFrom + k
        const j = sFrom + k
        if (ti[i] >= 0 || sj[j] >= 0) continue
        ti[i] = j
        sj[j] = i
        kd[i] = useAnchors ? classify(target[i], j) : 'same'
      }
    }
    let tPrev = 0
    let sPrev = 0
    if (useAnchors) {
      // 只拿「行号不交叉」的锚点切段：交叉说明前面认错了，不能当边界用
      let lastJ = -1
      for (let i = 0; i < target.length; i++) {
        if (ti[i] < 0 || ti[i] <= lastJ) continue
        pairRun(tPrev, i, sPrev, ti[i])
        lastJ = ti[i]
        tPrev = i + 1
        sPrev = ti[i] + 1
      }
      pairRun(tPrev, target.length, sPrev, saved.length)
    } else {
      // 不切段：把两边「还没认领的行」按出现顺序一一配上（多出来的才算新增 / 移除），
      // 这样即使锚点全错也不会凭空冒出一堆「新增 + 移除」。
      const tFree: number[] = []
      for (let i = 0; i < ti.length; i++) if (ti[i] < 0) tFree.push(i)
      const sFree: number[] = []
      for (let j = 0; j < sj.length; j++) if (sj[j] < 0) sFree.push(j)
      const n2 = Math.min(tFree.length, sFree.length)
      for (let k = 0; k < n2; k++) {
        const i = tFree[k]
        const j = sFree[k]
        ti[i] = j
        sj[j] = i
        kd[i] = 'same'
      }
    }
    let added = 0
    let removed = 0
    for (let i = 0; i < ti.length; i++) if (ti[i] < 0) added++
    for (let j = 0; j < sj.length; j++) if (sj[j] < 0) removed++
    return { ti, sj, kd, added, removed }
  }
  const coarse = runPairing(false)
  const fine = runPairing(true)
  const netDelta = coarse.added + coarse.removed
  const useFine = fine.added + fine.removed <= Math.max(20, netDelta + 20)
  const chosen = useFine ? fine : coarse
  for (let i = 0; i < target.length; i++) {
    newToOld[i] = chosen.ti[i]
    kind[i] = chosen.kd[i]
  }
  for (let j = 0; j < saved.length; j++) oldToNew[j] = chosen.sj[j]
  // matched = 靠指纹 / 行标识真正认出同一行的行数；identified 供提示文案用
  const identified = sigMatched + normMatched + keyMatched
  return { newToOld, kind, oldToNew, bySig: canSig || canNorm, sigMatched, normMatched, keyMatched, matched: identified, identified, coarse: !useFine }
}

/** 源表列（不含运行时逐列写回产生的新列）：列签名 / 列差异都用它，否则写回模式每次都会被当成「列变了」 */
const sourceColumnsNow = computed(() => columns.value.filter(c => !writeBackColumns.value.includes(c)))
/** 两组原表列是否一致（顺序也一致）；任务文件里没记录列时视为一致（老文件） */
const sameSourceColumns = (a: string[] | undefined, b: string[]): boolean => {
  if (!a || !a.length) return true
  if (a.length !== b.length) return false
  return a.every((c, i) => c === b[i])
}

/**
 * 结构化数据集跟着行一起走：
 * - 行只是换了位置 / 内容改过（同标识）→ 把记录的 `_rowNo` 改到新行号（记录跟着行，而不是跟着行号）；
 * - 源行被移除 → 记录标 `_removed`（结果页标「已移除」）；
 *   `opts.deleteRemoved` = true 时**直接删掉**这些记录（同步源表时的默认行为：结果跟着源表走）。
 * 注：内容改过的行结果与记录都**保留**（保持对齐），由行上的「已变更」角标提示重跑，不再成批作废。
 */
const syncDatasetRowsToMap = (map: SavedRowMap, opts?: { deleteRemoved?: boolean }): void => {
  if (!map.bySig || !datasetRows.value.length) return
  let removedDeleted = 0
  if (opts?.deleteRemoved) {
    for (let i = datasetRows.value.length - 1; i >= 0; i--) {
      const rec = datasetRows.value[i]
      const oldNo = Number(rec?._rowNo) || 0
      if (oldNo <= 0) continue
      // 只删「旧行号明确对不上任何行（= 该源行已被删掉）」的记录：
      // 行号缺失 / 超出已保存结果范围的属于来源不明，保留下来由结果页的「异常 N」筛选处理，不擅自删。
      const ni = map.oldToNew[oldNo - 1]
      if (ni !== undefined && ni < 0) {
        datasetRows.value.splice(i, 1)
        removedDeleted++
      }
    }
  }
  let removedMarked = 0
  for (const rec of datasetRows.value) {
    const oldNo = Number(rec?._rowNo) || 0
    if (oldNo <= 0) continue
    const ni = map.oldToNew[oldNo - 1]
    if (ni === undefined) continue
    if (ni < 0) {
      if (!rec._removed) { rec._removed = true; removedMarked++ }
    } else {
      if (rec._removed) delete rec._removed
      if (ni + 1 !== oldNo) rec._rowNo = ni + 1
    }
  }
  if (removedDeleted) {
    const slot = activeRound.value
    if (slot) slot.dataset = datasetRows.value.slice()
    addLog('info', en()
      ? `Source sync: deleted ${removedDeleted} result record(s) whose source row is gone`
      : `源表同步：已删除 ${removedDeleted} 条「源行已不存在」的结果记录`)
  }
  if (removedMarked) {
    const slot = activeRound.value
    if (slot) slot.dataset = datasetRows.value.slice()
    addLog('info', en()
      ? `Source table changed: ${removedMarked} record(s) marked as removed-source (their rows are gone)`
      : `源表变化：${removedMarked} 条记录标为「源行已移除」（对应任务行已从源表删除）`)
  }
}

/** 把一条已保存的结果写到某一行上 */
const applySavedResultToRow = (t: BatchRow, s: any, newIndex: number) => {
  t.status = (s.status === 'running' ? 'pending' : s.status) || 'pending'
  t.result = s.result
  // 结构化提取的行内数据（详情表按提取字段展示）
  if (Array.isArray(s.extracted) && s.extracted.length) t.extracted = s.extracted
  t.error = s.error
  t.inputTokens = s.inputTokens || 0
  t.outputTokens = s.outputTokens || 0
  t.startedAt = s.startedAt
  t.finishedAt = s.finishedAt
  t.retryCount = s.retryCount || 0
  t.emptyRetryCount = s.emptyRetryCount || 0
  // 推理步数：随文件保存的数字（无则清空，以免串行）；过程快照（图谱数据）里有更全的信息，稍后 applyPendingTraces 会再写一遍
  t.stepsCount = typeof s.stepsCount === 'number' ? s.stepsCount : undefined
  // 逐列写回（旧表格定向推理 / 纯 LLM + 单独结果）：保存的每行写回值合并回行数据；
  // 若当前已是结构化提取（「表格定向推理」已统一），则把旧写回值转成数据表记录（详情 / 导出照常展示）
  if (s.values && typeof s.values === 'object') {
    if (outputMode.value === 'structured') {
      const record: Record<string, any> = {}
      for (const [k, v] of Object.entries(s.values)) {
        if (v !== null && v !== undefined && String(v).trim() !== '') record[k] = v
      }
      if (Object.keys(record).length) {
        record._source = ''
        record._rowNo = newIndex + 1
        datasetRows.value.push(record)
        t.extracted = [record]
      }
    } else {
      Object.assign(t.data, s.values)
    }
  }
}

/**
 * 把保存的结果 / 状态 / 数据集合并到当前行上：
 * - 先按整行指纹、再按行标识（首个非空单元格的值）对位 → 源表增删 / 改行后历史结果都不会错位；
 * - 源数据改过的行：**结果仍留在该行上**（保持对齐），只标「已变更」提示重跑；
 * - 源表新增的行：标「新增」，等下次启动执行；
 * - 被删掉的源行：它的结果**自动删掉**（结果跟着源表走）；只有当「被删的超过一半」等可疑情况才
 *   只标记不删（结果页的「已移除 N」按钮可查看后手动删），避免表被换掉时误删一大片。
 * - 认不出旧行时（任务文件较旧 / 表内容变动很大）只会在日志与悬停提示里说明「按行号对位」，
 *   **不会**把已经认对的行改掉、也不会整表作废（否则「只删了几行」也会被说成对位失败）。
 * @param opts.report = false 时不更新源表增量摘要（切轮次等场景用）
 */
const mergeResults = (target: BatchRow[], results: any[], opts?: { report?: boolean }): number => {
  const colsChanged = !sameSourceColumns(savedSourceColumns.value, sourceColumnsNow.value)
  const colNote = en()
    ? `source columns changed (${(savedSourceColumns.value || []).join(', ') || '-'} → ${sourceColumnsNow.value.join(', ') || '-'})`
    : `源表列与上次不同（${(savedSourceColumns.value || []).join(', ') || '-'} → ${sourceColumnsNow.value.join(', ') || '-'}）`
  const map = matchSavedRows(results, target)
  const comparable = Math.min(target.length, results.length)
  // 提示（只解释、不改对位）：说明「增量只能理解为行数差」的原因。
  // ⚠️ 不要在这里改对位方式：把已经认对的行抛掉、整表改按行号对位，会把「只删了几行」说成
  //    「对位失败」，与上面的增量摘要自相矛盾；对位口径由 matchSavedRows 自己决定。
  let reason = ''
  if (comparable >= 3 && target.length !== results.length) {
    if (!map.identified) {
      reason = (colsChanged ? colNote + '；' : '') + (en()
        ? 'no old row could be identified (older task file, or a largely different table)'
        : '没能认出任何旧行（任务文件较旧，或表内容变动很大）')
    } else if (map.coarse) {
      reason = (colsChanged ? colNote + '；' : '') + (en()
        ? 'the positions of the added / removed rows could not be determined'
        : '增删的位置对不上（可能同时有增行和减行）')
    }
  }
  if (results.length) {
    if (reason) {
      // 只写日志（info，不弹 ElMessage）；左下角状态栏由调用方拼一句精简提示（sourceDeltaStatusNote）
      addLog('info', en()
        ? `Source sync: ${reason} — the delta summary counts rows added / removed only (positions are not pinpointed).`
        : `源表同步：${reason} —— 增量摘要只算行数增减（不定位到具体行）。`)
    } else if (colsChanged) {
      addLog('info', en()
        ? `Source sync: ${colNote} — rows were matched by fingerprint / first value and results stay aligned`
        : `源表同步：${colNote} —— 行仍按行指纹 / 首列值对位，结果保持对齐`)
    }
  }
  const surplusCount = map.oldToNew.filter(v => v < 0).length
  // 多余的结果（对应的源行已不存在）→ **自动删掉**，结果跟着源表走；
  // 但要防「表被换掉 / 老任务文件对不上」时误删一大片：超过一半（且行数不小）就不自动删，
  // 只标「已移除」，交给结果页的「已移除 N」按钮查看后手动处理。
  const autoClean = opts?.report !== false
    && surplusCount > 0
    && !(results.length >= 20 && surplusCount > results.length * 0.5)
  syncDatasetRowsToMap(map, { deleteRemoved: autoClean })
  if (opts?.report !== false) sourceDeltaCleaned.value = autoClean ? surplusCount : 0
  let merged = 0
  target.forEach((t, i) => {
    const j = map.newToOld[i]
    if ((map.kind[i] === 'same' || map.kind[i] === 'changed') && j >= 0) {
      applySavedResultToRow(t, results[j] || {}, i)
      // changed = 同一行（首列标识一致）但源数据改过：结果**留在该行上**（保持对齐），只标「已变更」提示重跑
      t.delta = map.kind[i] === 'changed' ? 'modified' : undefined
      merged++
    } else {
      // 没配上旧结果的行：fine 模式下确定是新行 → 标「新增」；
      // coarse 模式下行数对得上但位置是猜的，就不打角标（免得标错行，chip 仍报行数差）
      t.delta = map.coarse ? undefined : 'added'
    }
  })
  if (opts?.report !== false) {
    sourceDelta.added = map.kind.filter(k => k === 'added').length
    sourceDelta.changed = map.kind.filter(k => k === 'changed').length
    sourceDelta.removed = surplusCount
    sourceDelta.bySig = map.bySig
    sourceDelta.reason = reason
    // 被删掉的源行：非结构化模式把它们的旧数据 + 保存的结果留下来，结果页列出并标「已移除」
    // （结构化模式由 syncDatasetRowsToMap 给记录标 _removed / 直接删掉）
    // autoClean 已经自动删过的就不用留了
    if (autoClean || outputMode.value === 'structured') {
      removedRows.value = []
    } else {
      const removedList: Array<{ no: number; data: Record<string, any>; saved: Record<string, any> }> = []
      const prev = prevRowData.value
      results.forEach((s, j) => {
        if (map.oldToNew[j] >= 0) return
        if (removedList.length >= REMOVED_ROWS_MAX) return
        removedList.push({
          no: j + 1,
          data: prev && prev[j] ? { ...prev[j] } : {},
          saved: s && typeof s === 'object' ? s : {},
        })
      })
      removedRows.value = removedList
    }
    prevRowData.value = null
    if (sourceDeltaTotal.value) {
      addLog('info', en()
        ? `Source delta: ${sourceDelta.added} new / ${sourceDelta.changed} changed / ${sourceDelta.removed} removed${map.coarse ? ' (row-count difference only — positions not pinpointed)' : ' (results re-attached by fingerprint / first value)'}`
        : `源表增量：新增 ${sourceDelta.added} / 变更 ${sourceDelta.changed} / 移除 ${sourceDelta.removed}${map.coarse ? '（仅行数增减，未定位到具体行）' : '（历史结果已按行指纹 / 首列值对回原位）'}`)
    }
  }
  recountRows()
  return merged
}

// ==================== 定时自动保存（快照） ====================
// 需求：批量执行可持续数小时，按「执行设置 - 自动保存间隔」周期性把任务快照静默保存到
// 当前任务文件所在目录（文件名附加保存时间，不覆盖原文件），避免长时间运行崩溃丢失进度。
const autoSaveMs = computed(() => Math.max(0, Number(config.autoSaveHours) || 0) * 3600 * 1000)
const autoSaveEnabled = computed(() => autoSaveMs.value > 0)
/** 当前任务文件路径：优先取宿主实例的关联文件；独立使用时由「另存为」对话框记录 */
const localTaskFilePath = ref('')
const taskFilePath = computed({
  get: () => props.taskFilePath || localTaskFilePath.value,
  set: (v: string) => { localTaskFilePath.value = v; if (v) emit('link-file', v) },
})
const autoSaveHint = ref('')
/** 底部状态栏「自动保存」项的 title：保存目录 / 尚未确定目录的说明 */
const autoSaveTitle = computed(() => !taskFilePath.value
  ? (en() ? 'Auto-save needs a task file — click Save once to choose where it goes' : '自动保存需先确定任务文件：点一次「保存」选择位置即可')
  : (en() ? 'Snapshot folder' : '保存目录') + ': ' + taskFilePath.value)
/** 自动保存间隔输入的 title：间隔含义 + 当前开关/目录状态 */
const autoSaveInputTitle = computed(() => {
  const base = en()
    ? 'Hours between automatic snapshots saved next to the opened task file. 0 = off. Adjustable while running.'
    : '每隔多少小时自动保存一次任务快照到当前任务文件所在目录（文件名含保存时间）。0 = 关闭。运行中可调整'
  if (!autoSaveEnabled.value) return base + (en() ? ' (currently off)' : '（当前为关闭）')
  if (!taskFilePath.value) return base + (en() ? ' Folder not set yet — click Save once to choose it.' : ' 尚未确定保存目录：请先点一次「保存」选择位置。')
  return base + (en() ? ' Next snapshot: ' : ' ') + autoSaveHint.value
})
let autoSaveTimer: ReturnType<typeof setInterval> | null = null
const lastAutoSaveAt = ref(0)
const lastAutoSaveSig = ref('')
let autoSaveBusy = false

/** 「随任务文件保留 → 图谱数据」悬停说明（默认不保留） */
const keepTraceTitle = computed(() => en()
  ? 'When ticked, per-row process snapshots (what the graph and row details are built from) are written into the task file, so the graph is still there after reopening; default off keeps the file smaller. The step COUNT of every row is always saved (it is a single number), so the Steps column, step filter and export keep working after reopening.'
  : '勾选后：行过程快照（图谱与行详情的数据来源）会随任务文件保存，重开后无需重跑仍可看图谱；默认不保留（任务文件更小）。每行的推理步数只是一个数字，**始终随文件保存**（重开后步数列、步数筛选与导出照常可用）。')
/** 「随任务文件保留 → 运行日志」悬停说明（默认不保留） */
const keepLogsTitle = computed(() => en()
  ? 'When ticked, the main log and per-worker logs are written into the task file; default off keeps the file smaller.'
  : '勾选后：主日志与各线程日志会随任务文件保存；默认不保留（任务文件更小）。')

/** 状态指纹：自动保存时记录；未运行且无变化时跳过，避免空转生成重复文件 */
const checkpointSig = (): string =>
  `${rows.value.length}|${statusCounts.pending}|${statusCounts.running}|${statusCounts.completed}|${statusCounts.failed}|${statusCounts.skipped}|${tokenInfo.inputTokens}|${tokenInfo.outputTokens}`

const updateAutoSaveHint = () => {
  if (!autoSaveEnabled.value) { autoSaveHint.value = ''; return }
  if (!taskFilePath.value) {
    autoSaveHint.value = en() ? 'Need to save once first' : '需先保存一次（选择路径）'
    return
  }
  const remain = Math.max(0, autoSaveMs.value - (Date.now() - lastAutoSaveAt.value))
  const mins = Math.ceil(remain / 60000)
  if (mins <= 0) autoSaveHint.value = en() ? 'due' : '即将保存'
  else if (mins >= 60) autoSaveHint.value = en() ? `in ~${(mins / 60).toFixed(1)}h` : `约 ${(mins / 60).toFixed(1)} 小时后`
  else autoSaveHint.value = en() ? `in ~${mins}min` : `约 ${mins} 分钟后`
}
watch([autoSaveMs, taskFilePath], () => updateAutoSaveHint())

const baselineAutoSave = () => {
  lastAutoSaveAt.value = Date.now()
  lastAutoSaveSig.value = checkpointSig()
}

const autoSaveDue = (): boolean => {
  if (!autoSaveEnabled.value) return false
  if (!taskFilePath.value) return false            // 无任务文件位置 → 无保存目录
  if (rows.value.length === 0) return false        // 无可保存内容
  if (isLoading.value || autoSaveBusy) return false
  const now = Date.now()
  // 以组件打开 / 载入任务为计时起点（首帧只记基线，不触发保存，避免空闲生成重复文件）
  if (lastAutoSaveAt.value === 0) { baselineAutoSave(); return false }
  if (now - lastAutoSaveAt.value < autoSaveMs.value) return false
  // 未运行且自上次快照无任何变化：跳过（不生成重复文件）
  if (!isRunning.value && checkpointSig() === lastAutoSaveSig.value) return false
  return true
}

// ==================== 轮次（多轮处理）====================
// 一个 .task 文件按「轮次」分槽保存：每轮 = 一次启动的结果 + 该轮配置快照 + 汇总。
// 界面上的行 / 结果 / 数据集都属于「活跃轮」；切换轮次 = 把活跃状态写回槽位，再载入目标轮的配置与结果。
// 本期（P1）：轮次容器（新建 / 切换 / 重命名 / 删除 / 保存 / 启动交互）；跨轮引用（{{第N轮.列名}}）与对比导出在 P2。
const newRoundId = (): string => `round_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
const rounds = ref<PipelineRound[]>([])
const currentRoundId = ref('')
const activeRound = computed(() => rounds.value.find(r => r.id === currentRoundId.value) || rounds.value[0] || null)
/** 轮次下拉的选项名（附进度：已完成 / 合计；链式轮次加 ⑂ 标记） */
const roundOptionLabel = (r: PipelineRound): string => {
  const s = r.summary
  const mark = r.derivedFrom?.kind === 'chain' ? ' ⑂' : ''
  if (!s) return `${r.label}${mark}`
  return en() ? `${r.label}${mark} (${s.completed}/${s.rows})` : `${r.label}${mark}（${s.completed}/${s.rows}）`
}
/** 保底：始终至少有一个轮次（第1轮） */
const ensureFirstRound = () => {
  if (rounds.value.length) return
  const slot: PipelineRound = {
    id: newRoundId(),
    label: en() ? 'Round 1' : '第1轮',
    createdAt: new Date().toISOString(),
    config: JSON.parse(JSON.stringify(config)),
  }
  rounds.value = [slot]
  currentRoundId.value = slot.id
}
ensureFirstRound()

/** 跨轮引用里「结果」这一保留字段名：按界面语言生成（载入任务文件时会把指令里的引用一并迁移） */
const roundResultRefName = (): string => (en() ? 'result' : '结果')
/** 判定某个引用字段是否为「结果」保留字段（两种写法都认，避免旧指令失效） */
const isResultRefName = (f: string): boolean => f === 'result' || f === '结果'
/**
 * 载入任务文件后：把「自动生成的轮次名」与「跨轮引用的结果保留字」归一到当前界面语言，
 * 并把各轮指令里对应的引用同步改掉——中英切换后不会出现「第1轮 / Round 1」或「.结果 / .result」混排；
 * 手动改过名的轮次不动。
 */
const normalizeRoundLanguage = (): boolean => {
  const refWant = roundResultRefName()
  const refOther = en() ? '结果' : 'result'
  // 1) 自动轮次名（第N轮 ↔ Round N）按界面语言归一
  const renames: Array<[string, string]> = []
  for (const r of rounds.value) {
    const label = String(r.label || '').trim()
    const m = /^第\s*(\d+)\s*轮$/.exec(label) || /^Round\s+(\d+)$/i.exec(label)
    if (!m) continue
    const want = en() ? `Round ${m[1]}` : `第${m[1]}轮`
    if (want !== r.label) renames.push([r.label, want])
  }
  // 2) 各轮指令里的引用同步：{{旧轮次名.…}} → {{新轮次名.…}}；结果保留字 .结果 ↔ .result
  const fixTpl = (input: string): string => {
    let t = String(input || '')
    for (const [oldName, newName] of renames) t = t.split(`{{${oldName}.`).join(`{{${newName}.`)
    return t.split(`.${refOther}}}`).join(`.${refWant}}}`)
  }
  let changed = renames.length > 0
  for (const r of rounds.value) {
    const tpl = String(r.config?.template || '')
    const next = fixTpl(tpl)
    if (next !== tpl) { r.config = { ...(r.config || {}), template: next }; changed = true }
  }
  for (const [oldName, newName] of renames) {
    const slot = rounds.value.find(x => x.label === oldName)
    if (slot) slot.label = newName
  }
  const cur = String(config.template || '')
  const curNext = fixTpl(cur)
  if (curNext !== cur) config.template = curNext
  return changed
}

/** 当前行 → 文本源 units（保存用；单值超长截断） */
const buildRoundUnits = (): any[] => rows.value.map(r => {
  const data: Record<string, any> = {}
  for (const [k, v] of Object.entries(r.data || {})) {
    const s = v === null || v === undefined ? '' : String(v)
    data[k] = s.length > 8000 ? s.slice(0, 8000) : s
  }
  return {
    data,
    depth: Number(r.meta?.depth ?? 0) || 0,
    parentUrl: String(r.meta?.parentUrl || ''),
    status: r.status,
    result: r.result,
    extracted: r.extracted && r.extracted.length ? r.extracted : undefined,
    error: r.error,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    retryCount: r.retryCount,
    emptyRetryCount: r.emptyRetryCount,
    // 推理步数：仅一个数字，总是随文件保存（不依赖「保留图谱数据」）——重开后步数列 / 步数筛选 / 导出都还能用
    stepsCount: typeof r.stepsCount === 'number' ? r.stepsCount : undefined,
  }
})
/** 当前行 → 非文本源 results（保存用；只存结果/状态，不存数据列） */
const buildRoundResults = (): any[] => rows.value.map(r => {
  const item: Record<string, any> = {
    status: r.status,
    result: r.result,
    extracted: r.extracted && r.extracted.length ? r.extracted : undefined,
    error: r.error,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    retryCount: r.retryCount,
    emptyRetryCount: r.emptyRetryCount,
    // 源数据指纹：重读源表后用它对位（行增删 / 重排都不会让结果错位）
    sig: r.sig,
    // 归一化指纹：区分「真改了内容」与「只是换了个写法」（Excel 复存常见）
    sigNorm: r.sigNorm || rowSigNorm(r.data),
    // 行标识（首列非空单元格）：指纹对不上时（改过行）靠它把结果留在同一行上
    key: rowKeyOf(r.data),
    // 推理步数：仅一个数字，总是随文件保存（不依赖「保留图谱数据」）——重开后步数列 / 步数筛选 / 导出都还能用
    stepsCount: typeof r.stepsCount === 'number' ? r.stepsCount : undefined,
  }
  // 逐列写回（纯 LLM + 单独结果）：写回列的值随任务文件保存，重开后仍可预览 / 导出
  if (writeBackColumns.value.length) {
    const values: Record<string, any> = {}
    for (const name of writeBackColumns.value) {
      const v = r.data?.[name]
      if (v !== undefined && v !== null && String(v) !== '') values[name] = v
    }
    if (Object.keys(values).length) item.values = values
  }
  return item
})
/** 当前行 → 过程快照（仅勾选「保留图谱数据」时写入；带行指纹以便重读源表后对位） */
const buildRoundTraces = (): any[] | undefined => config.keepTrace
  ? rows.value.map(r => (Array.isArray(r.trace) && r.trace.length)
      ? { sig: r.sig, stepsCount: r.stepsCount || r.trace.length, trace: r.trace }
      : undefined)
  : undefined
/** 当前轮汇总（任务文件与轮次下拉展示用） */
const buildRoundSummary = (): PipelineRoundSummary => ({
  rows: rows.value.length,
  completed: completedRows.value,
  failed: failedRows.value,
  skipped: skippedRows.value,
  inputTokens: tokenInfo.inputTokens,
  outputTokens: tokenInfo.outputTokens,
  elapsedMs: (taskStartTime.value !== null ? Date.now() - taskStartTime.value : 0) + elapsedBeforePause.value,
  finishedAt: isRunning.value ? undefined : new Date().toISOString(),
})
/** 把活跃状态写回当前轮次槽位（保存 / 切换 / 新建轮次前调用） */
const captureCurrentRound = () => {
  const slot = activeRound.value
  if (!slot) return
  slot.config = JSON.parse(JSON.stringify(config))
  slot.dataset = datasetRows.value.slice()
  // 快照**源表列**（不含运行时写回的新列，否则写回模式每次重读都会被当成「列变了」）
  slot.sourceColumns = sourceColumnsNow.value.slice()
  slot.units = isTextSource.value ? buildRoundUnits() : undefined
  slot.results = isTextSource.value ? [] : buildRoundResults()
  slot.traces = buildRoundTraces()
  slot.summary = buildRoundSummary()
  // 派生行（链式展开后行数与源行不同）把「原始行号」随轮次保存；与行序号一致时不存（省体积）
  const origins = rows.value.map((r, i) => rowOriginIndex(r, i))
  slot.originOf = origins.some((v, i) => v !== i) ? origins : undefined
}
/** units → 行（文本源恢复用） */
const unitToRow = (u: any): BatchRow => {
  const data = (u.data && typeof u.data === 'object')
    ? { ...u.data }
    // v1 旧格式（链接采集最早版本）：url/title/links 为顶层字段
    : { url: String(u.url || ''), title: String(u.title || ''), links: String(u.links || '') }
  return {
    id: newRowId(),
    data,
    sig: rowSig(data),
    sigNorm: rowSigNorm(data),
    status: (u.status === 'running' ? 'pending' : (u.status || 'pending')) as BatchRowStatus,
    result: u.result,
    extracted: Array.isArray(u.extracted) ? u.extracted : undefined,
    error: u.error,
    inputTokens: u.inputTokens || 0,
    outputTokens: u.outputTokens || 0,
    startedAt: u.startedAt,
    finishedAt: u.finishedAt,
    retryCount: u.retryCount || 0,
    emptyRetryCount: u.emptyRetryCount || 0,
    // 推理步数（随单位一起保存；旧文件无此字段则为 undefined）
    stepsCount: typeof u.stepsCount === 'number' ? u.stepsCount : undefined,
    meta: { depth: u.depth || 0, parentUrl: u.parentUrl || '' },
  }
}
/** 清空行的运行痕迹（结果 / 错误 / Token / 时间 / 过程快照） */
const resetRowRunState = (r: BatchRow) => {
  r.status = 'pending'
  r.delta = undefined
  r.result = undefined
  r.extracted = undefined
  r.error = undefined
  r.inputTokens = 0
  r.outputTokens = 0
  r.startedAt = undefined
  r.finishedAt = undefined
  r.retryCount = 0
  r.emptyRetryCount = 0
  r.trace = undefined
  r.stepsCount = undefined
}
/** 非文本源：按行索引重放某轮结果（没有记录的行回到待处理）；切轮次不参与「源表增量」统计 */
const applyRoundResultsToRows = (results: any[]) => {
  for (const r of rows.value) resetRowRunState(r)
  if (results.length) mergeResults(rows.value, results, { report: false })
}
/** 载入某轮：配置快照 + 结果 + 数据集 + 过程快照 */
const activateRound = async (id: string, opts?: { silent?: boolean }) => {
  const slot = rounds.value.find(r => r.id === id)
  if (!slot) return
  currentRoundId.value = slot.id
  Object.assign(config, JSON.parse(JSON.stringify(slot.config || {})))
  migratePipelineConfig(config)
  datasetRows.value = Array.isArray(slot.dataset) ? slot.dataset.map((d: any) => ({ ...d })) : []
  tokenInfo.inputTokens = slot.summary?.inputTokens || 0
  tokenInfo.outputTokens = slot.summary?.outputTokens || 0
  tokenInfo.totalTokens = tokenInfo.inputTokens + tokenInfo.outputTokens
  elapsedBeforePause.value = slot.summary?.elapsedMs || 0
  stopTimer()
  updateTimerDisplay()
  // 派生轮（链式 / 同批复制）的行集合可能与当前不同 → 优先按来源重建（只算一次）
  const rebuiltRows = slot.derivedFrom?.kind === 'chain' ? null : buildRoundRows(slot)
  if (slot.derivedFrom?.kind === 'chain') {
    // 链式轮次：行由源轮结果派生 → 按同一规则重建行，再重放本轮自己的结果
    const srcSlot = rounds.value.find(r => r.id === slot.derivedFrom?.roundId)
    if (srcSlot) {
      rows.value = buildChainRowsFrom(srcSlot)
      applyRoundResultsToRows(roundResultItems(slot))
    } else {
      addLog('warning', en() ? 'The source round of this chained round no longer exists — rows cannot be rebuilt' : '该链式轮次的源轮次已被删除，无法重建行数据')
      applyRoundResultsToRows(slot.results || [])
    }
  } else if (rebuiltRows) {
    // 同批轮但行是派生的（前一轮展开过）→ 递归跟源重建本轮的跟源行，再重放结果
    rows.value = rebuiltRows
    applyRoundResultsToRows(slot.results || [])
  } else if (isTextSource.value) {
    rows.value = (slot.units || []).map(unitToRow)
  } else if (rows.value.length) {
    applyRoundResultsToRows(slot.results || [])
  } else {
    // 表格源但表格未导入：结果先暂存，导入表格后按行合并
    pendingResults.value = slot.results || []
  }
  pendingTraces.value = slot.traces || []
  const n = applyPendingTraces()
  recountRows()
  resetPages()
  // 只剩一个轮次时「对比」页签会消失（没有可对比对象）→ 把停留其上的用户送回结果页
  if (rounds.value.length <= 1 && activeTab.value === 'compare') activeTab.value = 'results'
  if (!opts?.silent) {
    addLog('info', `${en() ? 'Switched to ' : '已切换到轮次：'}${slot.label}${n ? (en() ? ` (restored snapshots of ${n} rows)` : `（已恢复 ${n} 行过程快照）`) : ''}`)
  }
}
/** 切换轮次（运行 / 加载中锁定） */
const switchRound = async (id: string) => {
  if (id === currentRoundId.value) return
  if (isRunning.value || isLoading.value) {
    addLog('warning', en() ? 'Cannot switch rounds while running — stop the batch first' : '运行中不能切换轮次（请先停止批量）')
    return
  }
  captureCurrentRound()
  await activateRound(id)
}
/** 轮次下拉变更（运行中回滚选中值） */
const onRoundSelect = async (e: Event) => {
  const sel = e.target as HTMLSelectElement
  if (isRunning.value || isLoading.value) {
    sel.value = currentRoundId.value
    addLog('warning', en() ? 'Cannot switch rounds while running — stop the batch first' : '运行中不能切换轮次（请先停止批量）')
    return
  }
  await switchRound(sel.value)
}
/** 新建轮次后的公共清理（数据集 / 令牌 / 计时 / 待合并结果 / 统计 / 分页） */
const resetRoundRuntime = () => {
  datasetRows.value = []
  resetSourceDelta()
  tokenInfo.inputTokens = 0
  tokenInfo.outputTokens = 0
  tokenInfo.totalTokens = 0
  stopTimer()
  taskStartTime.value = null
  elapsedBeforePause.value = 0
  updateTimerDisplay()
  pendingResults.value = []
  pendingTraces.value = []
  recountRows()
  resetPages()
}
/** 新建轮次：同批行回放（行数据保留、状态与结果清空），配置沿用当前快照 */
const newRound = () => {
  if (isRunning.value || isLoading.value) return
  const src = activeRound.value
  if (!src) return
  captureCurrentRound()
  const label = en() ? `Round ${rounds.value.length + 1}` : `第${rounds.value.length + 1}轮`
  // 当前轮的行本身是派生的（链式展开或复制而来）→ 新一轮跟着派生的源走，切回来时才能重建行
  const rowsAreDerived = !!src.derivedFrom || Array.isArray(src.rowsData)
  const slot: PipelineRound = {
    id: newRoundId(), label, createdAt: new Date().toISOString(),
    config: JSON.parse(JSON.stringify(config)), results: [], units: [], dataset: [], traces: [],
    derivedFrom: rowsAreDerived ? { kind: 'copy', roundId: src.id } : undefined,
  }
  rounds.value = [...rounds.value, slot]
  currentRoundId.value = slot.id
  for (const r of rows.value) resetRowRunState(r)
  resetRoundRuntime()
  addLog('info', `${en() ? 'New round: ' : '已新建轮次：'}${label}${rows.value.length ? (en() ? ` — ${rows.value.length} row(s) kept, all back to pending` : `——保留 ${rows.value.length} 行，状态全部置回待处理`) : ''}`)
}
/** 新建链式轮次（P3）：把当前轮的结果展开成新行（结构化逐条记录成一行），再在其上继续处理 */
const newChainedRound = () => {
  if (isRunning.value || isLoading.value) return
  const src = activeRound.value
  if (!src) return
  captureCurrentRound()
  // 基准轮（行不是派生的）被展开后行集合会被换掉 → 先存一份行快照，保证还能切回本轮
  if (!src.derivedFrom && !Array.isArray(src.rowsData)) {
    src.rowsData = rows.value.map(r => ({ ...(r.data || {}) }))
  }
  const derived = buildChainRowsFrom(src)
  if (!derived.length) {
    ElMessage.warning(en() ? 'This round has no results to expand — run it first' : '当前轮还没有可用于展开的结果（先跑一轮）')
    return
  }
  const label = en() ? `Round ${rounds.value.length + 1}` : `第${rounds.value.length + 1}轮`
  const slot: PipelineRound = {
    id: newRoundId(), label, createdAt: new Date().toISOString(),
    config: JSON.parse(JSON.stringify(config)), results: [], units: [], dataset: [], traces: [],
    derivedFrom: { kind: 'chain', roundId: src.id },
    originOf: derived.map((r, i) => rowOriginIndex(r, i)),
  }
  rounds.value = [...rounds.value, slot]
  currentRoundId.value = slot.id
  rows.value = derived
  resetRoundRuntime()
  addLog('info', `${en() ? 'New chained round: ' : '已新建链式轮次：'}${label}${en() ? ` — expanded from “${src.label}” into ${derived.length} row(s)` : `——由「${src.label}」的结果展开为 ${derived.length} 行`}`)
}
const renameRound = async () => {
  const slot = activeRound.value
  if (!slot) return
  try {
    const r = await ElMessageBox.prompt(en() ? 'Round name' : '轮次名称', en() ? 'Rename round' : '重命名轮次', {
      inputValue: slot.label,
      confirmButtonText: en() ? 'OK' : '确定',
      cancelButtonText: en() ? 'Cancel' : '取消',
    })
    const v = String(r?.value || '').trim()
    if (v) {
      const old = slot.label
      slot.label = v.slice(0, 40)
      // 跨轮引用用的是轮次名，改名后同步替换各轮指令里的 {{旧名.xxx}}，避免变成未匹配占位符
      if (slot.label !== old) {
        for (const r2 of rounds.value) {
          const tpl = String(r2.config?.template || '')
          if (tpl.includes(`{{${old}.`)) r2.config = { ...(r2.config || {}), template: tpl.split(`{{${old}.`).join(`{{${slot.label}.`) }
        }
        if (slot.id === currentRoundId.value) {
          const tpl = String(config.template || '')
          if (tpl.includes(`{{${old}.`)) config.template = tpl.split(`{{${old}.`).join(`{{${slot.label}.`)
        }
      }
      addLog('info', `${en() ? 'Round renamed: ' : '轮次已重命名为：'}${slot.label}`)
    }
  } catch { /* 用户取消 */ }
}
const deleteRound = async () => {
  if (isRunning.value || isLoading.value) return
  const slot = activeRound.value
  if (!slot) return
  if (rounds.value.length <= 1) { ElMessage.warning(en() ? 'At least one round must remain' : '至少保留一个轮次'); return }
  try {
    await ElMessageBox.confirm(
      en() ? `Delete round "${slot.label}" and its results?` : `删除轮次「${slot.label}」及其结果？`,
      en() ? 'Delete round' : '删除轮次',
      { confirmButtonText: en() ? 'Delete' : '删除', cancelButtonText: en() ? 'Cancel' : '取消', type: 'warning' },
    )
  } catch { return }
  const idx = rounds.value.findIndex(r => r.id === slot.id)
  rounds.value = rounds.value.filter(r => r.id !== slot.id)
  addLog('info', `${en() ? 'Round deleted: ' : '已删除轮次：'}${slot.label}`)
  await activateRound(rounds.value[Math.max(0, idx - 1)].id)
  // 导出的轮次列里若含已删除轮次，顺手清掉（避免导出出现空列）
  if (Array.isArray(config.exportRounds)) {
    const kept = rounds.value.map(r => r.id)
    config.exportRounds = config.exportRounds.filter(id => kept.includes(id))
  }
  // 有轮次由被删除的轮次派生 → 切回去时无法重建行数据，提前告知
  const orphan = rounds.value.filter(r => r.derivedFrom?.roundId === slot.id)
  if (orphan.length) {
    addLog('warning', en()
      ? `${orphan.map(r => r.label).join(' / ')} was expanded from “${slot.label}” — it can no longer rebuild its rows after switching`
      : `${orphan.map(r => r.label).join(' / ')} 由已删除的「${slot.label}」展开而来，切换回去时将无法重建行数据`)
  }
}
/** 轮次相关悬停说明 */
const roundSelectTitle = computed(() => en()
  ? 'Rounds inside this task file: each round keeps its own config snapshot and results. Switching loads that round (rows keep their data, results are re-applied row by row). ⑂ = a chained round expanded from the previous round’s results.'
  : '任务文件内的轮次：每轮各存一份配置快照与结果；切换即载入该轮（行数据保留，结果按行重放）。带 ⑂ 的轮次是由上一轮结果展开的链式轮次。')
const newRoundTitle = computed(() => en()
  ? 'New round: keep the same rows (all reset to pending) and the current config snapshot — run again with different settings/instruction. Switch rounds from the dropdown to compare.'
  : '新建轮次：保留同批任务行（状态全部置回待处理）与当前配置快照，可换配置 / 指令再跑一轮；用左侧下拉切换查看各轮结果。')
const renameRoundTitle = computed(() => en() ? 'Rename the current round' : '重命名当前轮次')
const deleteRoundTitle = computed(() => en() ? 'Delete the current round and its results (at least one must remain)' : '删除当前轮次及其结果（至少保留一个）')

// -------- 跨轮引用（P2）：`{{第1轮.结果}}` / `{{第1轮.字段名}}` --------
/** 其它轮次（「前轮结果」可引用范围：当前轮正在产出，不参与引用） */
const otherRounds = computed(() => rounds.value.filter(r => r.id !== currentRoundId.value))
/** 某轮的结果序列（表格源 = results；文本源 = units） */
const roundResultItems = (slot: PipelineRound): any[] =>
  (Array.isArray(slot.results) && slot.results.length) ? slot.results : (Array.isArray(slot.units) ? slot.units : [])
/** 该轮第 i 行对应的原始行号（缺省 = 行序号） */
const roundRowOrigin = (slot: PipelineRound, i: number): number => {
  const m = slot.originOf
  return (Array.isArray(m) && typeof m[i] === 'number' && m[i] >= 0) ? m[i] : i
}
/** 在该轮里按原始行号找行序号（找不到 -1 = 该行在本轮没有记录） */
const roundIndexByOrigin = (slot: PipelineRound, origin: number): number => {
  const m = slot.originOf
  if (!Array.isArray(m) || !m.length) return origin >= 0 ? origin : -1
  return m.indexOf(origin)
}
/** 某轮该行的记录项（results / units 按行索引；缺行返回 undefined → 渲染为空） */
const roundRowItem = (slot: PipelineRound, rowIndex: number): any => {
  const arr = Array.isArray(slot.results) && slot.results.length ? slot.results : (Array.isArray(slot.units) ? slot.units : [])
  return arr[rowIndex]
}
/** 某轮该行的「结果文本」（单结果 → result；结构化 → 首条记录拼文本） */
const roundRowResult = (slot: PipelineRound, rowIndex: number): string => {
  const item = roundRowItem(slot, rowIndex)
  if (!item) return ''
  const r = String(item.result ?? '').trim()
  if (r) return r
  const rec = Array.isArray(item.extracted) && item.extracted.length ? item.extracted[0] : null
  if (rec) return Object.entries(rec).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `${k}: ${v}`).join(' · ')
  return ''
}
/** 某轮该行的某字段值（写回字段 → values[字段]；结构化字段 → 首条记录字段） */
const roundRowField = (slot: PipelineRound, rowIndex: number, field: string): string => {
  const item = roundRowItem(slot, rowIndex)
  if (!item) return ''
  const v = item.values && item.values[field] !== undefined ? item.values[field] : undefined
  if (v !== undefined && v !== null) return String(v)
  const rec = Array.isArray(item.extracted) && item.extracted.length ? item.extracted[0] : undefined
  if (rec && rec[field] !== undefined && rec[field] !== null) return String(rec[field])
  return ''
}
/** 某轮可引用的字段名（输出字段 + 结果字段名） */
const roundRefFields = (slot: PipelineRound): string[] => {
  const names: string[] = []
  for (const f of ((slot.config?.schema || []) as any[])) {
    const n = String(f?.name || '').trim()
    if (n && !names.includes(n)) names.push(n)
  }
  const rf = String(slot.config?.resultField || '').trim()
  if (rf && !names.includes(rf)) names.push(rf)
  return names.filter(n => !isResultRefName(n))
}
/** 芯片字段列表：总是先给「结果」（轮次产出文本），再接该轮输出字段（去重） */
const roundRefChipFields = (slot: PipelineRound): string[] => [roundResultRefName(), ...roundRefFields(slot)]
/** 行 → 跨轮引用虚拟列（与行数据合并后当占位符用） */
const buildRowRoundRefs = (rowIndex: number, origin?: number): Record<string, string> => {
  const out: Record<string, string> = {}
  const base = typeof origin === 'number' && origin >= 0 ? origin : rowIndex
  for (const slot of rounds.value) {
    if (slot.id === currentRoundId.value) continue
    const idx = roundIndexByOrigin(slot, base)
    if (idx < 0) continue
    out[`${slot.label}.${roundResultRefName()}`] = roundRowResult(slot, idx)
    for (const f of roundRefFields(slot)) out[`${slot.label}.${f}`] = roundRowField(slot, idx, f)
  }
  return out
}
/** 行的「原始行号」：派生行（链式展开）记在 meta.originIndex，否则 = 行序号 */
const rowOriginIndex = (row: BatchRow | undefined, index: number): number => {
  const v = Number(row?.meta?.originIndex)
  return Number.isFinite(v) && v >= 0 ? v : index
}
/** 渲染用数据 = 行数据 + 跨轮引用虚拟列 */
const rowRenderData = (row: BatchRow, index: number): Record<string, any> =>
  ({ ...(row.data || {}), ...(row.roundRefs || {}), ...buildRowRoundRefs(index, rowOriginIndex(row, index)) })
/** 占位符是否已被任务指令引用 */
const isPlaceholderUsed = (name: string): boolean => (config.template || '').includes(`{{${name}}}`)
/** 点前轮结果芯片：未引用 → 写入任务指令；已引用 → 移除 */
const toggleRoundRef = (name: string) => {
  if (!isPlaceholderUsed(name)) { insertPlaceholder(name); return }
  config.template = (config.template || '').split(`{{${name}}}`).join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
}
/** 是否为已知的跨轮引用（供「未匹配占位符」告警过滤） */
const isKnownRoundRef = (name: string): boolean => {
  const i = name.indexOf('.')
  if (i <= 0) return false
  const label = name.slice(0, i)
  const field = name.slice(i + 1)
  const slot = rounds.value.find(r => r.label === label)
  if (!slot) return false
  return isResultRefName(field) || roundRefFields(slot).includes(field)
}
/** 前轮结果分组 / 芯片说明 */
const roundRefTitle = computed(() => en()
  ? 'Previous rounds: reference their output in the task instruction — e.g. {{Round 1.result}} takes that round’s result of the SAME row (handy for refining answer by round).'
  : '前轮结果：可在任务指令里引用前几轮的产出——例如 {{第1轮.结果}} 取「同一行」在第 1 轮的结果（适合逐轮打磨 / 对比）。')
const roundRefChipTitle = (slot: PipelineRound, field: string) => en()
  ? `Click to insert / remove {{${slot.label}.${field}}} (this row’s value in ${slot.label})`
  : `点击插入 / 移除 {{${slot.label}.${field}}}（取本行在「${slot.label}」的该值）`
/** 导出的轮次结果列（勾选；每轮一列，与当前轮并排对比） */
const exportRoundIds = computed<string[]>(() => Array.isArray(config.exportRounds) ? config.exportRounds : [])
const exportRoundSlots = computed<PipelineRound[]>(() =>
  exportRoundIds.value.map(id => rounds.value.find(r => r.id === id)).filter((r): r is PipelineRound => !!r))
const toggleExportRound = (id: string) => {
  const cur = new Set(exportRoundIds.value)
  if (cur.has(id)) cur.delete(id)
  else cur.add(id)
  config.exportRounds = rounds.value.map(r => r.id).filter(rid => cur.has(rid))
}
/** 结果项 → 单元格文本（结构化：多条记录逐行「字段: 值」；否则结果文本） */
const itemCellText = (item: any): string => {
  if (!item) return ''
  const recs = Array.isArray(item.extracted) ? item.extracted : []
  if (recs.length) {
    return recs.map((rec: any) => Object.entries(rec || {})
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => `${k}: ${v}`).join(' · ')).join('\n')
  }
  return safeExportString(item.result)
}
/** 导出单元格：某轮该行的结果文本（结构化轮把多条记录拼成文本） */
const roundExportCell = (slot: PipelineRound, rowIndex: number): string => itemCellText(roundRowItem(slot, rowIndex))
const roundExportHeader = (slot: PipelineRound): string => (en() ? `_Round·${slot.label}` : `_轮次·${slot.label}`)

// -------- 导出列表单（竖向排列：点开关 + 拖动排序）--------
// ⚠️ 这段必须放在轮次相关定义（otherRounds / exportRoundIds / exportRoundSlots）之后：
// exportItems 依赖它们，若在 setup 期间被求值（watch 的 getter / immediate）会 TDZ 报错
/** 条目键：col:<原表列> / meta:<运行信息键> / round:<轮次 id>（存进 config.exportOrder） */
type ExportItemKind = 'col' | 'meta' | 'round'
/** def = 默认列名（未改名时用它；改名后存在 config.exportHeaders） */
type ExportItem = { key: string; id: string; label: string; def: string; kind: ExportItemKind; on: boolean; hint: string }
const exportItemColKey = (c: string) => `col:${c}`
const exportItemMetaKey = (k: string) => `meta:${k}`
const exportItemRoundKey = (id: string) => `round:${id}`
/** 用户在表单里拖出的顺序（键 → 位次） */
const exportOrderRank = computed(() => {
  const order = Array.isArray(config.exportOrder) ? config.exportOrder : []
  return new Map(order.map((k, i) => [k, i]))
})
const exportItemRank = (key: string, fallback: number): number => {
  const r = exportOrderRank.value.get(key)
  return r === undefined ? 1e6 + fallback : r
}
/**
 * 导出列表单条目：原表列 + 运行信息列 + 轮次结果列合成一张竖向表单。
 * 默认顺序 = 原表列 → 运行信息 → 轮次列；有 config.exportOrder 时按其顺序（未列入的排在后面）。
 */
const exportItems = computed<ExportItem[]>(() => {
  const list: Array<{ key: string; id: string; label: string; def: string; kind: ExportItemKind; fallback: number; hint: string }> = []
  columns.value.forEach((c, i) => list.push({
    key: exportItemColKey(c), id: c, label: c, def: c, kind: 'col', fallback: i,
    hint: en() ? 'Source column — write it into the exported Excel' : '原表列：导出 Excel 时写入该列',
  }))
  EXPORT_META_COLUMNS.forEach((m, i) => list.push({
    key: exportItemMetaKey(m.key), id: m.key, label: en() ? m.en : m.zh, def: exportMetaHeader(m.key), kind: 'meta', fallback: 1000 + i,
    hint: en() ? 'Runtime info column (row #, status, tokens, times…)' : '运行信息列（行号 / 状态 / Token / 时间…）',
  }))
  otherRounds.value.forEach((s, i) => list.push({
    key: exportItemRoundKey(s.id), id: s.id, label: s.label, def: roundExportHeader(s), kind: 'round', fallback: 2000 + i,
    hint: en() ? 'Export this round’s result as its own column (side-by-side with the active round)' : '把该轮的结果作为单独一列导出（与当前轮并排对比）',
  }))
  const onCols = new Set(exportCols.value)
  const onMetas = new Set(exportMetas.value)
  const onRounds = new Set(exportRoundIds.value)
  return list
    .map(it => ({ it, r: exportItemRank(it.key, it.fallback) }))
    .sort((a, b) => a.r - b.r)
    .map(({ it }) => ({
      key: it.key, id: it.id, label: it.label, def: it.def, kind: it.kind, hint: it.hint,
      on: it.kind === 'col' ? onCols.has(it.id) : it.kind === 'meta' ? onMetas.has(it.id) : onRounds.has(it.id),
    }))
})
/** 导出列的自定义列名（结果页表头与导出的 Excel 都用它；未设置 = 默认名） */
const exportHeaderName = (key: string, fallback: string): string => {
  const custom = (config.exportHeaders || {})[key]
  return custom && String(custom).trim() ? String(custom).trim() : fallback
}
/** 编辑中的列名草稿（输入框直接用草稿，避免清空时被默认名顶回来） */
const exportNameDraft = ref<Record<string, string>>({})
const exportNameValue = (it: ExportItem): string => exportNameDraft.value[it.key] ?? exportHeaderName(it.key, it.def)
/** 该列是否已改名（模板用：改名后标出原名、不再显示类型标签） */
const exportRenamed = (it: ExportItem): boolean => exportHeaderName(it.key, it.def) !== it.def
/** 列名输入框的悬停说明（改过名时一并显示原名） */
const exportNameTitle = (it: ExportItem): string => {
  const renamed = exportRenamed(it)
  if (en()) return renamed
    ? `Original column: ${it.def} — click to rename (used by the Results tab and the exported Excel)`
    : 'Click to rename this column (used by the Results tab and the exported Excel)'
  return renamed
    ? `原名：${it.def}——点这里改列名（结果页与导出的 Excel 都用它）`
    : '点这里改列名（结果页与导出的 Excel 都用它）'
}
const onExportNameInput = (it: ExportItem, e: Event) => {
  const v = (e.target as HTMLInputElement).value
  exportNameDraft.value = { ...exportNameDraft.value, [it.key]: v }
  const next = { ...(config.exportHeaders || {}) }
  const t = v.trim()
  if (!t || t === it.def) delete next[it.key]
  else next[it.key] = t
  config.exportHeaders = next
}
/** 失焦：空名 / 默认名都回到默认（并清掉草稿） */
const onExportNameBlur = (it: ExportItem) => {
  const d = { ...exportNameDraft.value }
  delete d[it.key]
  exportNameDraft.value = d
}
/** vuedraggable 需要可改写的数组：本地副本随 exportItems 同步，拖动结束后写回 config.exportOrder */
const exportFormItems = ref<ExportItem[]>([])
let exportFormDragging = false
const syncExportForm = () => {
  exportFormItems.value = exportItems.value.map(it => ({ ...it }))
  exportNameDraft.value = {}
}
watch(exportItems, () => {
  if (exportFormDragging) return
  syncExportForm()
})
const onExportFormDragEnd = () => {
  config.exportOrder = exportFormItems.value.map(it => it.key)
  nextTick(() => { exportFormDragging = false })
}
const onExportFormDragStart = () => { exportFormDragging = true }
const toggleExportItem = (it: ExportItem) => {
  if (it.kind === 'col') toggleExportCol(it.id)
  else if (it.kind === 'meta') toggleExportMeta(it.id)
  else toggleExportRound(it.id)
}
const exportKindLabel = (kind: ExportItemKind): string => kind === 'col'
  ? (en() ? 'src' : '原表')
  : kind === 'meta' ? (en() ? 'info' : '信息') : (en() ? 'round' : '轮次')
const exportFormTitle = computed(() => en()
  ? 'All exportable columns in one list: click a row to include / exclude it, drag the handle to change the order (the order here is the column order in the exported Excel); click a name to rename that column — the Results tab and the exported Excel both use it'
  : '所有可导出的列集中在这张表单里：点一行 = 勾选 / 取消，拖动左侧手柄调整顺序（此顺序即导出 Excel 的列顺序）；点列名即可改名——结果页与导出的 Excel 都用这个名字')
/** 表单里没有任何条目时的占位说明 */
const exportFormEmptyHint = computed(() => en()
  ? 'Import a table to pick source columns; runtime info / round columns are always available.'
  : '导入表格后可选原表列；运行信息与轮次列始终可选。')

// -------- 链式轮次（P3）：把上一轮的结果展开成新行 --------
/** 建一条待处理行（origin = 原始行号） */
const makePendingRow = (data: Record<string, any>, origin: number): BatchRow => ({
  id: newRowId(), data, sig: rowSig(data), sigNorm: rowSigNorm(data), status: 'pending', inputTokens: 0, outputTokens: 0,
  retryCount: 0, emptyRetryCount: 0,
  meta: { depth: 0, parentUrl: '', originIndex: origin },
})
/** 链式展开：该轮每行产出 → 新行（结构化记录逐条展开；单结果一行；空结果跳过） */
const buildChainRowsFrom = (slot: PipelineRound): BatchRow[] => {
  const resultField = String(slot.config?.resultField || config.resultField || roundResultRefName())
  const out: BatchRow[] = []
  roundResultItems(slot).forEach((item: any, i: number) => {
    const origin = roundRowOrigin(slot, i)
    const recs = Array.isArray(item?.extracted) ? item.extracted : []
    if (recs.length) {
      for (const rec of recs) {
        const data: Record<string, any> = { _源行: String(origin + 1) }
        for (const [k, v] of Object.entries(rec || {})) {
          if (k.startsWith('_')) continue
          data[k] = v === null || v === undefined ? '' : String(v)
        }
        out.push(makePendingRow(data, origin))
      }
      return
    }
    const text = safeExportString(item?.result)
    if (text) out.push(makePendingRow({ _源行: String(origin + 1), [resultField]: text }, origin))
  })
  return out
}
/**
 * 重建某轮的任务行（可重建时返回行，否则 null = 保持当前行）。
 * - 基准轮：有行快照（被链式轮展开过）则按快照还原，否则 null（行来自导入表 / 手工生成）；
 * - 链式轮：按源轮结果展开；- 同批轮：递归复制源轮的行。
 */
const buildRoundRows = (slot: PipelineRound, depth = 0): BatchRow[] | null => {
  if (depth > 20) return null
  if (slot.derivedFrom) {
    const src = rounds.value.find(r => r.id === slot.derivedFrom?.roundId)
    if (!src) return null
    if (slot.derivedFrom.kind === 'chain') return buildChainRowsFrom(src)
    const base = buildRoundRows(src, depth + 1)
    return base ? base.map(r => makePendingRow({ ...(r.data || {}) }, rowOriginIndex(r, 0))) : null
  }
  if (Array.isArray(slot.rowsData)) return slot.rowsData.map((d, i) => makePendingRow({ ...d }, i))
  return null
}
const chainedRoundTitle = computed(() => en()
  ? 'New round from this round’s results: every result becomes the input rows of the new round (structured records are expanded one row each) — good for refine / dedupe / aggregate passes'
  : '链式新轮次：把本轮的结果展开成新一轮的任务行（结构化提取逐条记录成一行）——适合“先发散再收敛”的精修 / 去重 / 汇总轮')

// -------- 轮次对比（P3）：多轮结果并排 + 一致性标记 --------
/** 对比表最多展示多少行（避免大成表卡顿） */
const COMPARE_PREVIEW_MAX = 500
/** 参与一致性统计的最大行数（超出部分不参与计算，避免大表卡顿） */
const COMPARE_SCAN_MAX = 5000
/** 参与对比的轮次（空 = 全部轮次） */
const comparePicked = ref<string[]>([])
const compareRounds = computed<PipelineRound[]>(() => {
  const picked = comparePicked.value.length ? comparePicked.value : rounds.value.map(r => r.id)
  return rounds.value.filter(r => picked.includes(r.id))
})
const toggleCompareRound = (id: string) => {
  const cur = new Set(comparePicked.value.length ? comparePicked.value : rounds.value.map(r => r.id))
  if (cur.has(id)) {
    // 至少保留一轮：否则对比表会整个空掉（看起来像「点完就没了」）
    if (cur.size <= 1) {
      setStatusHint('info', en() ? 'At least one round must stay selected' : '至少保留一个对比轮次')
      return
    }
    cur.delete(id)
  } else cur.add(id)
  comparePicked.value = rounds.value.map(r => r.id).filter(rid => cur.has(rid))
}
/** 对比表单元格预览（点击某格 → 用 block_md 渲染预览） */
const comparePreview = ref<{ title: string; round: string; content: string } | null>(null)
const openComparePreview = (row: { no: number; title: string; cells: string[] }, ci: number) => {
  const content = String(row.cells?.[ci] ?? '')
  if (!content.trim()) return
  comparePreview.value = {
    title: row.title || (en() ? `Row ${row.no ?? ''}` : `第 ${row.no ?? ''} 行`),
    round: compareRounds.value[ci]?.label || '',
    content,
  }
}
/** 一致性比较前先归一化（折叠空白），避免排版差异被当成分歧 */
const normResultText = (s: string): string => String(s || '').replace(/\s+/g, ' ').trim()
/** 某轮按原始行号取单元格文本（链式轮同一原始行有多条派生行 → 合并展示，完全相同只留一份） */
const roundCellByOrigin = (slot: PipelineRound, origin: number): string => {
  const items = roundResultItems(slot)
  const m = slot.originOf
  if (!Array.isArray(m) || !m.length) {
    return origin >= 0 && origin < items.length ? itemCellText(items[origin]) : ''
  }
  const parts: string[] = []
  m.forEach((o, i) => {
    if (o !== origin) return
    const t = itemCellText(items[i])
    if (t && !parts.includes(t)) parts.push(t)
  })
  return parts.join('\n')
}
/** 当前（活跃）轮按原始行号聚合的单元格文本（运行中的实时结果，不依赖已存快照） */
const liveCellsByOrigin = computed(() => {
  const m = new Map<number, string[]>()
  rows.value.slice(0, COMPARE_SCAN_MAX).forEach((row, i) => {
    const o = rowOriginIndex(row, i)
    const arr = m.get(o) || []
    const t = itemCellText(row)
    if (t && !arr.includes(t)) arr.push(t)
    m.set(o, arr)
  })
  return m
})
/** 对比表数据：按「原始行号」一行一条（派生行的多条结果合并在同一格里），仅在对比页签激活时计算 */
const compareRows = computed(() => {
  if (activeTab.value !== 'compare') return []
  const picked = compareRounds.value
  // 只选一轮也照常展示（隐藏其它轮＝只看这一轮）；完全不选的情况已在 toggleCompareRound 里拦住
  if (!picked.length) return []
  const title = titleColumn.value
  // 行标题：优先用其它轮的「行快照」（rowsData = 该轮的原始行数据，链式轮的派生行没有原始列），
  // 快照里找不到的原始行号再用当前轮的行数据（含尚未运行的行）补上
  const infoByOrigin = new Map<number, string>()
  const put = (origin: number, data: any) => {
    if (!(origin >= 0) || infoByOrigin.has(origin)) return
    const label = title ? String(data?.[title] ?? '') : String(Object.values(data || {})[0] ?? '')
    infoByOrigin.set(origin, label)
  }
  // 1) 其它参与对比的轮：行快照 → 真实原始行号 + 原始行数据
  for (const slot of picked) {
    if (slot.id === currentRoundId.value) continue
    const snap = Array.isArray(slot.rowsData) && slot.rowsData.length ? slot.rowsData : null
    if (snap) {
      snap.slice(0, COMPARE_SCAN_MAX).forEach((d: any, i: number) => put(roundRowOrigin(slot, i), d))
      continue
    }
    // 没有行快照（通常是复制轮 / 首轮）：至少按结果条数把行号补齐（标题随后由当前轮补）
    const n = Math.min(roundResultItems(slot).length, COMPARE_SCAN_MAX)
    for (let i = 0; i < n; i++) put(roundRowOrigin(slot, i), null)
  }
  // 2) 当前轮的所有行（含尚未运行的行）——只为「其它轮里没有的原始行号」补标题
  rows.value.slice(0, COMPARE_SCAN_MAX).forEach((row, i) => put(rowOriginIndex(row, i), row.data))
  return [...infoByOrigin.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([origin, titleText]) => {
      const cells = picked.map(s => s.id === currentRoundId.value
        ? (liveCellsByOrigin.value.get(origin) || []).join('\n')
        : roundCellByOrigin(s, origin))
      const vals = cells.map(normResultText).filter(Boolean)
      return {
        origin,
        no: origin + 1,
        title: titleText,
        cells,
        diff: new Set(vals).size > 1,
        missing: vals.length > 0 && vals.length < picked.length,
      }
    })
})
const compareDiffCount = computed(() => compareRows.value.filter(r => r.diff).length)
const compareViewRows = computed(() => compareRows.value.slice(0, COMPARE_PREVIEW_MAX))
const compareTotal = computed(() => compareRows.value.length)
const compareTabTitle = computed(() => en()
  ? 'Compare the same rows across rounds; rows whose results differ (or that a round has no result for) are marked'
  : '把同一批行在各轮的产出并排对比；不一致（或某轮无结果）的行会标记出来')
const compareHint = computed(() => en()
  ? `Side-by-side view of the SAME rows across rounds (aligned by original row number; several rows expanded from one source row are merged into its cell). ⚠ = results differ (${compareDiffCount.value} row(s)), ? = some round has no result; whitespace differences are ignored.`
  : `按原始行号对齐，把同一批行在各轮的产出并排展示（一行派生出多行时，结果合并在同一格里）。⚠ = 各轮结果不一致（${compareDiffCount.value} 行），? = 有轮次缺结果；字符空白差异不计入。`)
const compareEmptyHint = computed(() => {
  if (rounds.value.length < 2) {
    return en()
      ? 'Only one round so far — create another round on the Task tab to compare them side by side'
      : '目前只有一轮——在「任务」页新建一轮后，这里就能把各轮结果并排对比'
  }
  return en() ? 'No rows to compare yet' : '暂无可对比的行'
})

/** 组装任务状态对象（手动保存 / 自动保存共用；v3 = 按轮次分槽保存） */
const buildTaskStateObject = (): any => {
  // 把活跃状态写回当前轮次槽位（配置 / 数据集 / 结果 / 快照 / 汇总）
  captureCurrentRound()
  const cur = activeRound.value
  const savedElapsed = (taskStartTime.value !== null ? Date.now() - taskStartTime.value : 0) + elapsedBeforePause.value
  return {
    version: 3,
    scaffold: 'pipeline', // 所属脚手架（供知识管理双击 .task 时识别并跳转）
    savedAt: new Date().toISOString(),
    /** 当前活跃轮次 */
    currentRoundId: currentRoundId.value,
    /** 全部轮次（含当前轮；其余轮为各自上次保存的快照） */
    rounds: rounds.value.map(r => ({
      id: r.id,
      label: r.label,
      createdAt: r.createdAt,
      config: r.config,
      summary: r.summary,
      results: r.results && r.results.length ? r.results : [],
      units: r.units && r.units.length ? r.units : undefined,
      dataset: r.dataset && r.dataset.length ? r.dataset : undefined,
      traces: r.traces && r.traces.length ? r.traces : undefined,
      // 链式 / 同批轮次：派生来源 + 每行的原始行号（重开时按同一规则重建行）+ 基准轮行快照
      derivedFrom: r.derivedFrom,
      originOf: r.originOf && r.originOf.length ? r.originOf : undefined,
      rowsData: r.rowsData && r.rowsData.length ? r.rowsData : undefined,
    })),
    // ====== 兼容字段（= 当前轮的实时状态；旧版本读取器 / 旧导入流程仍可读）======
    config: { ...config },
    // 提取数据集（sink=dataRows；文件采集的成果，随任务文件一起保存）
    dataset: datasetRows.value,
    units: isTextSource.value ? (cur?.units || []) : undefined,
    results: isTextSource.value ? [] : (cur?.results || []),
    sourceTablePath: sourceTablePath.value,

    statusText: statusText.value,
    tokenInput: tokenInfo.inputTokens,
    tokenOutput: tokenInfo.outputTokens,
    elapsedBeforePause: savedElapsed,
    // 图谱数据 / 运行日志：默认不保留（不写入任务文件）；勾选后随文件保存，重开任务文件时恢复
    traces: cur?.traces,
    logs: config.keepLogs
      ? logs.value.map(e => ({ time: e.time, level: e.level, message: e.message, detail: e.detail, workerId: e.workerId }))
      : undefined,
    workerLogs: config.keepLogs
      ? workers.value.filter(w => Array.isArray(w.logs) && w.logs.length).map(w => ({ id: w.id, label: w.label, logs: w.logs }))
      : undefined,
  }
}

const doAutoSave = async () => {
  if (autoSaveBusy) return
  autoSaveBusy = true
  try {
    const jsonStr = await buildTaskJson(buildTaskStateObject())
    const res = await window.ipcRenderer.invoke('saveTaskFileAuto', taskFilePath.value, jsonStr)
    if (res && res.success) {
      lastAutoSaveAt.value = Date.now()
      lastAutoSaveSig.value = checkpointSig()
      updateAutoSaveHint()
      addLog('info', `已自动保存快照: ${res.path}（${rows.value.length} 行结果，${(jsonStr.length / 1024 / 1024).toFixed(1)}MB）`)
    } else {
      addLog('error', `自动保存失败: ${res?.error || '未知错误'}`)
    }
  } catch (e: any) {
    addLog('error', `自动保存出错: ${e.message}`)
  } finally {
    autoSaveBusy = false
  }
}

const checkAutoSave = async () => {
  try {
    if (autoSaveDue()) await doAutoSave()
  } finally {
    updateAutoSaveHint()
  }
}

const startAutoSaveTimer = () => {
  stopAutoSaveTimer()
  autoSaveTimer = setInterval(checkAutoSave, 60 * 1000)
  updateAutoSaveHint()
}
const stopAutoSaveTimer = () => {
  if (autoSaveTimer) { clearInterval(autoSaveTimer); autoSaveTimer = null }
}

/** 应用任务状态对象（关联文件自动加载 / 手动读取 / 双击 .task 共用；文件 IO 由 useInstanceTaskFile 负责） */
const applyTaskState = async (state: any, srcPath = '') => {
    // 新载入一份任务：先清掉上一次的「源表增量」提示（真发现变化时后续的合并会重新填）
    resetSourceDelta()
    if (srcPath) taskFilePath.value = srcPath
    // 文件夹源：本次载入允许自动扫描一次（见 autoScanFolderSource）
    folderScanTried = false
    // 记录任务文件位置：定时自动保存将写到该文件所在目录（文件名另附保存时间，不覆盖原文件）
    lastAutoSaveAt.value = 0
    updateAutoSaveHint()

    // 兼容旧脚手架任务文件（batch / tabreason / file / collector）：先归一化为本模块状态
    const legacy = normalizeLegacyState(state)
    if (legacy.migratedFrom) {
      const p = pipelinePreset(legacy.migratedFrom)
      addLog('info', `${en() ? 'Legacy task file detected: ' : '已识别旧格式任务文件（'}${p ? (en() ? p.labelEn : p.labelZh) : legacy.migratedFrom}${en() ? ' — converted to the current format' : '），已自动转换为当前配置'}`)
      state = legacy.state
    }

    // ====== 轮次容器：载入全部轮次并激活 currentRoundId；旧文件（无 rounds）统一包成第 1 轮 ======
    const incoming: any[] = Array.isArray(state.rounds) ? state.rounds : []
    const toSlot = (r: any, fallbackLabel: string): PipelineRound => ({
      id: String(r?.id || newRoundId()),
      label: String(r?.label || fallbackLabel),
      createdAt: String(r?.createdAt || state.savedAt || new Date().toISOString()),
      config: (r?.config && typeof r.config === 'object') ? { ...r.config } : {},
      summary: (r?.summary && typeof r.summary === 'object') ? r.summary : undefined,
      results: Array.isArray(r?.results) ? r.results : [],
      units: Array.isArray(r?.units) ? r.units : undefined,
      dataset: Array.isArray(r?.dataset) ? r.dataset : undefined,
      traces: Array.isArray(r?.traces) ? r.traces : undefined,
      derivedFrom: (r?.derivedFrom && (r.derivedFrom.kind === 'chain' || r.derivedFrom.kind === 'copy') && r.derivedFrom.roundId)
        ? { kind: r.derivedFrom.kind as 'chain' | 'copy', roundId: String(r.derivedFrom.roundId) }
        : undefined,
      originOf: Array.isArray(r?.originOf) ? r.originOf.map((n: any) => Number(n) || 0) : undefined,
      rowsData: Array.isArray(r?.rowsData) ? r.rowsData : undefined,
    })
    if (incoming.length) {
      rounds.value = incoming.map((r: any) => toSlot(r, en() ? 'Round 1' : '第1轮'))
      const want = String(state.currentRoundId || '')
      currentRoundId.value = rounds.value.some(r => r.id === want) ? want : rounds.value[0].id
      addLog('info', en()
        ? `Loaded ${rounds.value.length} round(s) — active: ${activeRound.value?.label || ''}`
        : `已载入 ${rounds.value.length} 个轮次——当前：${activeRound.value?.label || ''}`)
    } else {
      // 旧文件（v1/v2）或跨模块导入：把顶层字段包成第 1 轮
      const slot = toSlot({
        config: state.config,
        results: state.results,
        units: state.units,
        dataset: state.dataset,
        traces: state.traces,
      }, en() ? 'Round 1' : '第1轮')
      rounds.value = [slot]
      currentRoundId.value = slot.id
    }
    // 用「活跃轮」的内容覆盖 state 的数据字段（配置 / 结果 / 行 / 数据集 / 快照）→ 下方恢复逻辑无需改动
    const active = activeRound.value as PipelineRound
    // 上次保存时的源表列（重读源表时判断「结构是否变过」）
    savedSourceColumns.value = Array.isArray(active.sourceColumns) ? active.sourceColumns.slice() : []
    state = {
      ...state,
      config: active.config,
      dataset: active.dataset,
      units: active.units,
      // 非文本源：活跃轮无结果时保留顶层 results（旧文件兼容路径）
      results: (Array.isArray(active.results) && active.results.length) ? active.results : state.results,
      traces: active.traces,
    }

    Object.assign(config, state.config || {})
    // 旧配置迁移（v1 链接采集 sourceKind='urls' → 文本源 + 内容获取=抓取网页；seedUrls → textInput）
    migratePipelineConfig(config)
    // 中英切换后：自动轮次名与跨轮引用里的「结果」保留字归一到当前界面语言（手动改名的轮次不动）
    if (normalizeRoundLanguage()) addLog('info', en() ? 'Round names / references normalized to the current UI language' : '已按当前界面语言归一化轮次名与引用')
    // 提取数据集（sink=dataRows）：随任务文件保存，加载时恢复（有数据则切到「结果」页签）
    if (Array.isArray(state.dataset)) {
      datasetRows.value = state.dataset
      if (state.dataset.length) {
        activeTab.value = 'results'
        addLog('info', `已恢复提取数据 ${state.dataset.length} 条`)
      }
    }
    // 文本/链接采集：恢复任务行（行数据 + title/links 字段 + 状态），重开后图谱与续跑仍可用
    if (Array.isArray(state.units) && state.units.length) {
      rows.value = state.units.map((u: any) => unitToRow(u))
      recountRows()
      resetPages()
      addLog('info', `已恢复 ${rows.value.length} 行任务（含行数据与运行状态）`)
    }
    statusText.value = state.statusText || (en() ? 'Ready' : '就绪')
    if (state.tokenInput !== undefined) {
      tokenInfo.inputTokens = state.tokenInput
      tokenInfo.outputTokens = state.tokenOutput || 0
      tokenInfo.totalTokens = (state.tokenInput || 0) + (state.tokenOutput || 0)
    }
    if (state.elapsedBeforePause !== undefined) {
      elapsedBeforePause.value = state.elapsedBeforePause
      updateTimerDisplay()
    }

    if (Array.isArray(state.results)) {
      // v2：只含结果/状态，与表格按行索引合并；若记录过源表格路径则自动重读
      pendingResults.value = state.results
      sourceTablePath.value = state.sourceTablePath || ''
      if (rows.value.length > 0) {
        const n = mergeResults(rows.value, pendingResults.value)
        pendingResults.value = []
        addLog('info', `已合并 ${n} 行保存的结果/状态`)
      } else if (sourceTablePath.value) {
        addLog('info', `已加载任务结果/状态（${state.results.length} 行），正在自动读取源表格...`)
        await autoLoadTable(sourceTablePath.value)
      } else if (isFolderSource.value && config.folderPath) {
        // 文件夹源：任务行由扫描生成（不随文件保存行数据）→ 自动扫描并按行索引合并结果/状态
        addLog('info', `已加载任务结果/状态（${state.results.length} 行），正在自动扫描源文件夹...`)
        await autoScanFolderSource()
      } else {
        addLog('info', `已加载任务结果/状态（${state.results.length} 行，不含表格数据）。请点击「导入」重新导入表格，将自动合并。`)
      }
    } else if (Array.isArray(state.rows)) {
      // v1：旧格式，含完整行数据
      rows.value = (state.rows || []).map((r: any) => ({
        id: r.id || newRowId(),
        data: r.data || {},
        // 老格式没存指纹 → 用行数据现算，后续照样能按指纹 / 标识对位
        sig: r.sig || rowSig(r.data || {}),
        sigNorm: r.sigNorm || rowSigNorm(r.data || {}),
        status: (r.status === 'running' ? 'pending' : r.status) || 'pending',
        result: r.result,
        error: r.error,
        inputTokens: r.inputTokens || 0,
        outputTokens: r.outputTokens || 0,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        retryCount: r.retryCount || 0,
        emptyRetryCount: r.emptyRetryCount || 0,
      }))
      addLog('info', `已读取任务状态${srcPath ? ': ' + srcPath : ''}（${rows.value.length} 行）`)
    }
    // 文件夹源：任务行由扫描生成（不随文件保存行数据）——走到这里仍没有行时（无结果 / 旧文件）自动扫描一次
    if (!rows.value.length && isFolderSource.value && config.folderPath) await autoScanFolderSource()
    resetPages()
    recountRows()

    // 图谱数据（可选保留）：按行索引恢复过程快照——文本源的行已就绪，直接合并；
    // 表格源此时行还未导入，留待导入源表 / 自动读取后在 mergeResults 之后合并（与 results 同一套索引）
    if (Array.isArray(state.traces) && state.traces.length) {
      pendingTraces.value = state.traces
      const n = applyPendingTraces()
      if (n > 0) addLog('info', `已恢复 ${n} 行的过程快照（图谱可用）`)
      else addLog('info', `已加载图谱数据（${state.traces.filter((t: any) => t && t.trace).length} 行），导入源表格后自动合并`)
    }
    // 运行日志（可选保留）：恢复主日志与各线程日志（重排 seq，后续新日志继续累加）
    if (Array.isArray(state.logs) && state.logs.length) {
      logs.value = state.logs.map((e: any, i: number) => ({
        seq: i + 1,
        time: String(e?.time || ''),
        level: String(e?.level || 'info'),
        message: String(e?.message || ''),
        detail: e?.detail ? String(e.detail) : undefined,
        workerId: typeof e?.workerId === 'number' ? e.workerId : undefined,
      }))
      logSeq = logs.value.length
      mainLogStart.value = -1
      addLog('info', `已恢复 ${logs.value.length} 条运行日志`)
    }
    if (Array.isArray(state.workerLogs) && state.workerLogs.length) {
      workers.value = state.workerLogs.map((w: any) => ({
        id: Number(w?.id) || 0,
        label: String(w?.label || ''),
        rowTitle: '',
        rowCount: 0,
        logs: (Array.isArray(w?.logs) ? w.logs : []).map((e: any) => ({
          time: String(e?.time || ''),
          level: String(e?.level || 'info'),
          message: String(e?.message || ''),
          detail: e?.detail ? String(e.detail) : undefined,
        })),
      }))
      addLog('info', `已恢复 ${workers.value.length} 个线程的日志`)
    }

    addLog('info', en() ? 'Click ▶ to resume pending rows' : '如需继续执行，请点击 ▶ 运行按钮')
    // 旧文件 / 首次载入：补齐当前轮的汇总（轮次下拉展示进度用）
    if (active && !active.summary) active.summary = buildRoundSummary()
}

// ====== 实例关联任务文件（自动加载 / 覆盖保存；独立使用时退回对话框） ======
const {
  saveTaskState: saveTaskStateToFile,
  saveToFile,
  loadTaskState: loadTaskStateFromFile,
} = useInstanceTaskFile({
  scaffold: 'pipeline',
  filePath: () => taskFilePath.value,
  instanceId: () => instanceKey.value,
  isBusy: () => isRunning.value,
  collect: () => buildTaskJson(buildTaskStateObject()),
  apply: (state: any) => applyTaskState(state, taskFilePath.value),
  log: (level, message) => addLog(level, message),
  onLinkFile: (path) => { taskFilePath.value = path },
  onFileMissing: (path) => emit('file-missing', path),
  onSaved: (path) => emit('file-saved', path),
})

// ====== 顶部按钮的悬停说明（按钮都是纯图标，含义靠 title） ======
/** ▶ 开始/续跑：说明本次会跑哪些行、以及「停止后可续跑」的行为 */
const startButtonTitle = computed(() => {
  if (isRunning.value) {
    return en()
      ? 'Running — stop it to pause; clicking ▶ again resumes the pending rows'
      : '正在运行 —— 可点 ■ 停止；停止后待处理的行会保留，再点 ▶ 即可续跑'
  }
  if (rows.value.length === 0) {
    return en()
      ? 'Import a table first (each row = one independent agent task)'
      : '请先导入表格（每行 = 一个独立智能体任务）'
  }
  if (pendingRows.value === 0) {
    return en()
      ? 'No pending rows — set rows back to Pending in the table, or use "Rerun ▾" to rerun a scope'
      : '没有待处理的行 —— 可在表格页把行状态改回「待处理」，或用「重跑 ▾」按选区重跑'
  }
  return en()
    ? `Start / resume: runs the ${pendingRows.value} pending row(s) with the current settings (agent, instruction, concurrency). Rows stopped midway go back to pending and can be resumed here.`
    : `开始 / 续跑：按当前设置（智能体、任务指令、并发数）执行 ${pendingRows.value} 个待处理行；中途停止的行会回到待处理，可再点此续跑`
})
const stopButtonTitle = computed(() => en()
  ? 'Stop: cancels running rows (they go back to pending and can be resumed with ▶)'
  : '停止：取消进行中的行并置回待处理（可再点 ▶ 续跑）')
const saveAsTitle = computed(() => en()
  ? 'Save as a new task file (a copy of results & settings, not the table data). If the new file is not linked to another instance, this instance switches to it.'
  : '另存为新任务文件（结果与设置的副本，不含表格数据）；若新文件未被其它实例关联，本实例会切换到该文件继续保存')

// ====== 保存反馈（状态栏最左侧）======
// 需求：点「保存」后不只是「保存中…」，成功 / 失败都要给反馈；且信息统一显示在状态栏左侧。
// ====== 通用状态栏提示（状态栏最左侧）======
// 需求：保存 / 导出等操作不只给日志与弹窗，统一在状态栏左侧给反馈。
// 做法：独立的 statusHint（不动 statusText，运行状态不会被覆盖）；非进行中状态几秒后自动消失。
type StatusHint = { kind: 'saving' | 'ok' | 'err' | 'info'; icon: string; text: string; detail: string }
const STATUS_HINT_KEEP_MS = 6000
const STATUS_HINT_ICON: Record<StatusHint['kind'], string> = {
  saving: 'fa fa-spinner fa-spin',
  ok: 'fa fa-check-circle',
  err: 'fa fa-times-circle',
  info: 'fa fa-info-circle',
}
const statusHint = ref<StatusHint>({ kind: 'info', icon: '', text: '', detail: '' })
let statusHintTimer: ReturnType<typeof setTimeout> | null = null
const clearStatusHintTimer = () => { if (statusHintTimer) { clearTimeout(statusHintTimer); statusHintTimer = null } }
/** 设置状态栏提示；kind !== 'saving' 时 keepMs 后自动清除 */
const setStatusHint = (kind: StatusHint['kind'], text: string, detail = '', keepMs = STATUS_HINT_KEEP_MS) => {
  clearStatusHintTimer()
  statusHint.value = { kind, icon: STATUS_HINT_ICON[kind], text, detail }
  if (kind !== 'saving' && keepMs > 0) {
    statusHintTimer = setTimeout(() => { statusHint.value = { kind: 'info', icon: '', text: '', detail: '' } }, keepMs)
  }
}
const clearStatusHint = () => { clearStatusHintTimer(); statusHint.value = { kind: 'info', icon: '', text: '', detail: '' } }
/** 保存反馈的悬停详情：时间 + 行数 + 保存位置 */
const statusHintDetail = (): string => {
  const time = new Date().toLocaleTimeString()
  const rowsText = en() ? `${rows.value.length} row result(s)` : `${rows.value.length} 行结果`
  const pathText = taskFilePath.value
    ? (en() ? 'File: ' : '文件：') + taskFilePath.value
    : (en() ? 'File: saved via dialog' : '文件：通过对话框选择位置')
  return `${en() ? 'Saved at' : '保存于'} ${time} · ${rowsText} · ${pathText}`
}
const statusHintTitle = computed(() => statusHint.value.detail || statusHint.value.text)

/** 保存任务状态（按钮）：有关联文件直接覆盖，否则弹「另存为」；反馈显示在状态栏左侧 */
const saveTaskState = async () => {
  if (isLoading.value) return
  if (rows.value.length === 0) { addLog('warning', en() ? 'No rows to save' : '没有可保存的行'); return }
  // 先组装（此时状态文本仍为真实运行状态，避免把「保存中…」写入快照），再写盘
  setStatusHint('saving', en() ? 'Saving…' : '保存中…')
  const ok = await saveTaskStateToFile()
  if (ok) {
    lastAutoSaveAt.value = Date.now()
    lastAutoSaveSig.value = checkpointSig()
    updateAutoSaveHint()
    addLog('info', `任务状态已保存（${rows.value.length} 行结果，不含表格数据）`)
    setStatusHint('ok', en() ? 'Saved' : '已保存', statusHintDetail())
  } else {
    setStatusHint('err', en() ? 'Save failed (see Logs)' : '保存失败（详见日志）')
  }
}

/**
 * 另存为（按钮）：把当前任务状态写入新的 .task 文件。
 * · 目标路径由主进程的「另存为」对话框选择并写入（可覆盖同名文件）；
 * · 新文件未被其它实例关联时，本实例切换到该文件（后续保存 / 自动保存都写新文件）；
 *   已被其它实例占用时只留一份副本、不改关联（同一任务文件不允许被两个实例关联）。
 */
const saveTaskStateAs = async () => {
  if (isLoading.value) return
  if (rows.value.length === 0) { addLog('warning', en() ? 'No rows to save' : '没有可保存的行'); return }
  if (!window.ipcRenderer?.invoke) { addLog('error', en() ? 'Save As requires the desktop app' : '另存为仅桌面版支持'); return }
  // 先组装（此时状态文本仍为真实运行状态，避免把「保存中…」写入快照），再写盘
  setStatusHint('saving', en() ? 'Saving as…' : '另存中…')
  try {
    const jsonStr = await buildTaskJson(buildTaskStateObject())
    const res = await window.ipcRenderer.invoke('saveTaskFile', jsonStr)
    if (!res?.success) {
      if (res?.error === '用户取消') { clearStatusHint(); return }
      addLog('error', (en() ? 'Save As failed: ' : '另存为失败: ') + (res?.error || ''))
      setStatusHint('err', en() ? 'Save as failed (see Logs)' : '另存为失败（详见日志）')
      return
    }
    const path = String(res.path || '')
    const sizeText = `${Math.round(jsonStr.length / 1024)}KB`
    addLog('info', `${en() ? 'Saved as: ' : '已另存为: '}${path}（${sizeText}，不含表格数据）`)
    const conflict = store.instanceByFilePath(path, instanceKey.value)
    if (conflict) {
      addLog('warning', en()
        ? `"${path}" is already linked to instance "${conflict.title}" — the copy was written, but this instance keeps its current file`
        : `「${path}」已被实例「${conflict.title}」关联 —— 副本已写出，但本实例仍关联原文件`)
      setStatusHint('ok', en() ? 'Saved as a copy' : '已另存为副本', `${path} · ${sizeText}`, STATUS_HINT_KEEP_MS)
      return
    }
    // 切换关联文件：后续「保存」与定时自动保存都写新文件
    taskFilePath.value = path
    lastAutoSaveAt.value = Date.now()
    lastAutoSaveSig.value = checkpointSig()
    updateAutoSaveHint()
    emit('file-saved', path)
    setStatusHint('ok', en() ? 'Saved as' : '已另存为', `${path} · ${sizeText}`)
  } catch (e: any) {
    addLog('error', (en() ? 'Save As failed: ' : '另存为失败: ') + (e?.message || e))
    setStatusHint('err', en() ? 'Save as failed (see Logs)' : '另存为失败（详见日志）')
  }
}

/** 读取任务状态（按钮 / 外部传入路径）；filePath 为空时弹文件对话框 */
const loadTaskState = async (filePath?: string) => {
  if (isLoading.value) return
  isLoading.value = true
  try {
    await loadTaskStateFromFile(filePath)
  } finally {
    isLoading.value = false
  }
}

// 从知识管理双击 .task 跳转过来时：切回「任务」页并加载该任务文件
useTaskFileOpen('pipeline', async (path) => {
  activeTab.value = 'task'
  await loadTaskState(path)
})

// ==================== 重置 ====================
const clearAll = async () => {
  if (isLoading.value) return
  try {
    await ElMessageBox.confirm(
      en() ? 'Reset rows, logs and stats? (task config stays)' : '确定要重置吗？将清空行数据、日志和统计（保留任务配置）。',
      en() ? 'Confirm' : '提示',
      { confirmButtonText: en() ? 'Confirm' : '确定', cancelButtonText: en() ? 'Cancel' : '取消', type: 'warning' }
    )
    rows.value = []
    recountRows()
    resetPages()
    logs.value = []
    selectedRowId.value = null
    showRowDetail.value = false
    tokenInfo.inputTokens = 0
    tokenInfo.outputTokens = 0
    tokenInfo.totalTokens = 0
    stopTimer()
    taskStartTime.value = null
    elapsedBeforePause.value = 0
    elapsedDisplay.value = '00:00'
    etaDisplay.value = ''
    statusText.value = en() ? 'Ready' : '就绪'
    workers.value = []
    // 重置后视为全新任务：定时自动保存重新计时
    lastAutoSaveAt.value = 0
  } catch { /* 用户取消 */ }
}

/**
 * 结果页「清除结果」：只清结果，任务行（来源数据）与全部配置都保留。
 * 清掉的是「跑出来的东西」：每行结果 / 状态 / Token / 计时 / 过程快照、提取数据表、
 * 待合并的结果与快照，以及当前轮的快照；行会回到「待处理」，可以重新跑。
 */
const clearResults = async () => {
  if (isRunning.value || isLoading.value) return
  try {
    await ElMessageBox.confirm(
      en()
        ? 'Clear all results? Task rows and settings stay. Per-row results, statuses, tokens, timings, process snapshots and the extracted dataset will be removed.'
        : '确定清除全部结果吗？任务行与配置保留。将清空：每行的结果 / 状态 / Token / 计时 / 过程快照，以及结构化提取的数据表。',
      en() ? 'Confirm' : '提示',
      { confirmButtonText: en() ? 'Confirm' : '确定', cancelButtonText: en() ? 'Cancel' : '取消', type: 'warning' }
    )
    for (const r of rows.value) resetRowRunState(r)
    datasetRows.value = []
    pendingResults.value = []
    pendingTraces.value = []
    resetSourceDelta()
    selectedRowId.value = null
    showRowDetail.value = false
    recountRows()
    resetPages()
    tokenInfo.inputTokens = 0
    tokenInfo.outputTokens = 0
    tokenInfo.totalTokens = 0
    stopTimer()
    taskStartTime.value = null
    elapsedBeforePause.value = 0
    elapsedDisplay.value = '00:00'
    etaDisplay.value = ''
    statusText.value = en() ? 'Ready' : '就绪'
    // 当前轮的快照一起清掉：保存时不会再把旧结果写回任务文件
    const slot = activeRound.value
    if (slot) {
      slot.results = []
      slot.dataset = undefined
      slot.traces = undefined
      slot.summary = buildRoundSummary()
    }
    addLog('info', en() ? 'Cleared all results (rows & settings kept)' : '已清除全部结果（任务行与配置保留）')
    setStatusHint('ok', en() ? 'Results cleared' : '已清除结果')
  } catch { /* 用户取消 */ }
}

// ==================== 生命周期 ====================
onMounted(() => {
  liveUnsub = agentBridge.on((view: any) => {
    // 更新对应行的实时用量（按 usage 对象身份去重；O(1) Map 查找）
    // 注意：这里是「增量累加本轮各 step 的用量」——行在每轮开始时（runner.runRow）已把 Token 归零，
    // 所以重跑不会在上一次的数值上继续加
    const row = viewRowMap.get(view.id)
    if (row && view.lastUsage) {
      const prev = usageSeen.get(view.id)
      if (prev !== view.lastUsage) {
        usageSeen.set(view.id, view.lastUsage)
        row.inputTokens += view.lastUsage.promptTokens || 0
        row.outputTokens += view.lastUsage.completionTokens || 0
      }
    }
    // 选中行实时刷新
    if (selectedRow.value && selectedRow.value.viewId === view.id) {
      syncLiveFromView(view)
    }
  })
  if (store.root) addLog('info', `工作区: ${store.root}（将注入每个 Agent 的上下文，工具相对路径基于该目录）`)
  startAutoSaveTimer()
  // 导出列表单首次同步（不能放在 setup 期的 immediate watch 里：轮次相关 computed 定义更靠后 → TDZ）
  syncExportForm()
})

onBeforeUnmount(() => {
  stopAutoSaveTimer()
  clearStatusHintTimer()
  if (liveStreamTimer) { clearTimeout(liveStreamTimer); liveStreamTimer = null }
  if (agent) agent.stop()
  stopTimer()
  if (liveUnsub) { liveUnsub(); liveUnsub = null }
})

/** 关闭实例时的清理（宿主导航栏调用）：停止批量运行与定时器，但保留内存状态 */
const dispose = () => {
  try { if (agent) agent.stop() } catch { /* 忽略 */ }
  stopTimer()
  stopAutoSaveTimer()
  clearStatusHintTimer()
  isRunning.value = false
  reportInstanceRunning(instanceKey.value, false)
}

/**
 * 实例栏（宿主 AgentScaffold）的「保存」入口：静默覆盖写关联文件（不弹确认），
 * 反馈与传统「保存」按钮一致 —— 状态栏左侧「保存中… → 已保存 / 保存失败」。
 */
const saveForInstanceBar = async (): Promise<boolean> => {
  const hadFile = !!taskFilePath.value
  setStatusHint('saving', en() ? 'Saving…' : '保存中…')
  let ok = false
  try {
    ok = await saveToFile()
  } catch (e: any) {
    // 写盘异常（如桌面端 IPC 不可用）也要给反馈，避免状态栏一直停在「保存中…」
    addLog('error', (en() ? 'Save failed: ' : '保存失败: ') + String(e?.message || e))
    setStatusHint('err', en() ? 'Save failed (see Logs)' : '保存失败（详见日志）', String(e?.message || e))
    return false
  }
  if (ok) {
    lastAutoSaveAt.value = Date.now()
    lastAutoSaveSig.value = checkpointSig()
    updateAutoSaveHint()
    addLog('info', `任务状态已保存（${rows.value.length} 行结果，不含表格数据）`)
    setStatusHint('ok', en() ? 'Saved' : '已保存', statusHintDetail())
  } else if (!hadFile && !taskFilePath.value) {
    // 未关联文件 + 用户在「另存为」对话框取消 → 中性提示，不算失败
    setStatusHint('info', en() ? 'Save canceled (no location chosen)' : '已取消选择保存位置')
  } else {
    setStatusHint('err', en() ? 'Save failed (see Logs)' : '保存失败（详见日志）')
  }
  return ok
}

// 暴露给父组件（AgentScaffold）使用
defineExpose({
  rows,
  logs,
  processedRows,
  config,
  dispose,
  /** 导航栏「保存」：写关联任务文件，反馈走状态栏左侧 */
  saveTaskState: () => saveForInstanceBar(),
  /** 宿主用的状态栏提示（保存 / 批量操作结果等）：与任务页反馈同一处显示 */
  showStatusHint: (kind: StatusHint['kind'], text: string, detail = '') => setStatusHint(kind, text, detail),
  /** 导航栏 tooltip：预计剩余时间 / 进度 */
  eta: () => etaDisplay.value,
  progress: () => `${processedRows.value}/${rows.value.length}`,
  /** 导航栏「开始全部」：启动/续跑待处理行 */
  start: () => { void startBatch() },
  /** 导航栏「暂停全部」：停止但不关闭（可稍后点 ▶ 续跑） */
  stop: () => stopBatch(),
})
</script>

<style scoped>
.agent-batch {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--backgroundColor);
}

/* ====== 顶层标签页 ====== */
/* 高度与实例栏（AgentScaffold 的 --harness-bar-h）一致：两处必须保持相同 */
.top-tabs {
  display: flex;
  height: var(--harness-bar-h, 34px);
  box-sizing: border-box;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
  background: var(--menuColor);
}
.top-tabs .tab-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 100%;
  box-sizing: border-box;
  padding: 0 16px;
  font-size: 12px;
  border: none;
  background: none;
  color: var(--fontColor);
  cursor: pointer;
  text-align: center;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}
.top-tabs .tab-btn:hover { background: var(--backgroundColor); }
.top-tabs .tab-btn.active {
  border-bottom-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
  background: var(--backgroundColor);
}

/* ====== 主内容 ====== */
.main-content {
  flex: 1;
  overflow: hidden;
  padding: 5px;
}

/* ====== 按钮 ====== */
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 26px;
  box-sizing: border-box;
  padding: 0 10px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  color: var(--fontColor);
  background: var(--backgroundColor);
  white-space: nowrap;
  user-select: none;
  transition: all 0.15s;
}
.button:hover { background: var(--menuColor); }
.button.danger { background: #f44336; color: white; border-color: #f44336; }
.button.danger:hover { background: #d32f2f; }
/* 禁用态：图标变灰 + 半透明，hover 不再高亮，鼠标显示 not-allowed */
.button:disabled,
.button:disabled:hover {
  opacity: 0.4;
  cursor: not-allowed;
  background: var(--backgroundColor);
  color: var(--fontColor);
  filter: grayscale(60%);
}
.button.danger:disabled,
.button.danger:disabled:hover {
  opacity: 0.4;
  cursor: not-allowed;
  filter: grayscale(60%);
  background: #f44336;
  color: white;
  border-color: #f44336;
}
/* 表单控件禁用时显示禁止光标 */
select:disabled,
input:disabled,
textarea:disabled {
  cursor: not-allowed;
}

/* ====== 底部状态栏（处理进度） ====== */
.batch-status-panel {
  display: flex;
  flex-direction: row;
  align-items: center;
  flex-wrap: nowrap;
  gap: 10px;
  padding: 5px 10px;
  background: var(--menuColor);
  border-top: 1px solid var(--borderColor);
  flex-shrink: 0;
  overflow: hidden;
  min-width: 0;
}
.batch-status-spin { color: #2196F3; flex-shrink: 0; font-size: 12px; }
.batch-status-text {
  font-size: 11px;
  color: var(--fontColor);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}
.batch-status-sep {
  width: 1px;
  height: 14px;
  background: var(--borderColor);
  flex-shrink: 0;
}
.batch-status-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--fontColor);
  white-space: nowrap;
}
.batch-status-dots .stat-item { display: inline-flex; align-items: center; gap: 3px; }
.batch-status-dots .stat-dot { margin-left: 0; }
/* 保存反馈（状态栏左侧，排在运行状态之后）：保存中 / 成功 / 失败，几秒后自动消失 */
.batch-status-hint { font-weight: 500; flex: none; }
.batch-status-hint.saving { color: #2196F3; }
.batch-status-hint.ok { color: #4CAF50; }
.batch-status-hint.err { color: #f44336; }
.batch-status-hint.info { color: var(--fontColor); opacity: 0.85; }

/* ====== 任务两列 ====== */
.task-two-col { display: flex; height: 100%; gap: 5px; }
.task-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  overflow: hidden;
  min-width: 0;
}
/* 任务页：无外框、无标题——左列（操作栏已并入）执行与配置 + 输入 + 输出三张卡片直接铺在页面上 */
.task-page { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow-y: auto; padding: 5px; }
/* 任务操作栏（读取 / 保存 / 另存为 · 重置 / 停止 / 启动）：实心按钮，位于「执行与配置」卡片顶部 */
.task-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
/* 操作栏在卡片内：按钮等宽拉伸平分行宽；卡片内滚动时吸顶（否则按钮会随内容滚走） */
.task-toolbar .task-action-btn { flex: 1 1 auto; justify-content: center; }
.task-panel-run > .task-toolbar { position: sticky; top: 0; z-index: 2; background: var(--backgroundColor); padding-top: 2px; }
/* 任务面板：三列网格——左列＝「执行与配置」（操作栏并入卡片内，整卡滚动），中列＝输入，右列＝输出
   高度：三列面板铺满整个任务页；内容超出可用高度时在各自面板内滚动（不顶开 / 压住别的卡片） */
.task-panels {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-template-rows: auto minmax(0, 1fr);
  column-gap: 8px;
  row-gap: 0;
  flex: 1;
  min-height: 0;
}
/* 面板内部纵向排列（让「任务指令」这类填充块能撑满剩余高度） */
.task-panels .form-section { display: flex; flex-direction: column; min-height: 0; }
/* 内容超出可用高度时：在面板内滚动（.scoll 提供细滚动条样式） */
.task-panels .task-panel-run,
.task-panels .task-panel-input,
.task-panels .task-panel-output { overflow-y: auto; }
.task-panels .task-panel-run { grid-column: 1; grid-row: 1 / span 2; margin-bottom: 0; }
.task-panels .task-panel-input { grid-column: 2; grid-row: 1 / span 2; }
.task-panels .task-panel-output { grid-column: 3; grid-row: 1 / span 2; }
/* 输入面板排版：CSS order 把「数据选择」排到「任务指令」上方；「任务指令」占满剩余高度 */
.task-panels .task-panel-input .io-instr-section {
  order: 2; flex: 1 1 auto; display: flex; flex-direction: column; min-height: 150px; padding-bottom: 6px;
}
.task-panels .task-panel-input .io-instr-section .io-instr { flex: 1 1 auto; min-height: 130px; }
.task-panels .task-panel-input .io-data-section { order: 1; }
/* 中 / 右两列的面板贴到页底（默认 8px 外边距会留出一条空隙） */
.task-panels .task-panel-input, .task-panels .task-panel-output { margin-bottom: 0; }
/* 窄窗口：不再有「两栏」中间态——要么三栏，要么直接单栏（配置 → 输入 → 输出，面板回到内容高度、整页滚动） */
@media (max-width: 720px) {
  .task-panels { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto; row-gap: 8px; flex: none; }
  .task-panels .task-panel-run { grid-column: 1; grid-row: 1; }
  .task-panels .task-panel-input { grid-column: 1; grid-row: 2; }
  .task-panels .task-panel-output { grid-column: 1; grid-row: 3; }
}
.task-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: all 0.15s;
}
.task-action-btn:hover { background: var(--menuColor); }
/* 主按钮（启动）：主题的 menuColor 底 + 略深一档的悬停 */
.task-action-btn.primary { background: var(--menuColor); border-color: var(--borderColor); color: var(--fontColor); font-weight: 600; }
.task-action-btn.primary:hover { background: color-mix(in srgb, var(--menuColor) 80%, var(--borderColor)); }
.task-action-btn.danger { background: #f44336; border-color: #f44336; color: #fff; }
.task-action-btn.danger:hover { background: #d32f2f; }
.task-action-btn:disabled,
.task-action-btn:disabled:hover { opacity: 0.45; cursor: not-allowed; }
/* 任务面板：三列网格（见下方 .task-panels 规则）；旧的 flex 列包装已不再使用 */
/* 输入面板底部：来源表格 / 文件夹路径（超长省略，悬停看全文） */
.source-info-line {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  padding: 4px 6px;
  border: 1px dashed var(--borderColor);
  border-radius: 3px;
  font-size: 10px;
  color: var(--fontColor);
  min-width: 0;
}
.source-info-line .source-info-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 提取字段表格：铺满面板宽度（固定布局：字段名 26% + 说明自适应 + 必填/主键/操作窄列） */
.fields-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.fields-table th, .fields-table td { border: 1px solid var(--borderColor); padding: 2px 4px; font-size: 10px; }
.fields-table th { background: var(--menuColor); color: var(--fontColor); font-weight: normal; overflow: hidden; text-overflow: ellipsis; }
/* 表格内输入框：无背景、无边框（透明扁平，只显示文字） */
.fields-table td input:not([type="checkbox"]) {
  width: 100%; min-width: 0; margin: 0; padding: 0; box-sizing: border-box;
  border: 0; background: transparent; box-shadow: none; outline: none;
  font-size: 10px; color: var(--fontColor); height: 18px;
}
.fields-table td input:not([type="checkbox"]):focus { background: transparent; box-shadow: none; }
.fields-table td input:not([type="checkbox"])::placeholder { color: var(--fontColor); opacity: 0.45; }
/* 行详情弹层：结构化提取的数据表（按提取字段逐列展示） */
.detail-extracted { padding: 2px 0 4px; }
.detail-extracted-title { font-size: 11px; color: var(--fontColor); margin-bottom: 4px; }
.detail-extracted .fields-table td { word-break: break-word; white-space: pre-wrap; }
/* ====== 源列 / 字段表格（与「表格定向推理」同一套样式） ====== */
.tr-block { margin-top: 6px; }
.tr-group-head { display: flex; align-items: center; gap: 4px; width: 100%; margin-bottom: 3px; }
.tr-group-title { font-size: 11px; color: var(--fontColor); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tr-mini {
  flex: none; font-size: 10px; line-height: 16px; padding: 0 5px; cursor: pointer; user-select: none;
  border: 1px solid var(--borderColor); border-radius: 3px; color: var(--fontColor); opacity: 0.85;
}
.tr-mini:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); opacity: 1; }
.tr-empty { color: var(--fontColor); opacity: 0.6; font-size: 12px; padding: 8px; text-align: center; }
.tr-auto { font-size: 10px; color: #67c23a; padding: 0 5px; }
.task-col-body { flex: 1; overflow-y: auto; padding: 6px; }
/* 日志作为任务页右列：内部自身滚动（logs-content 撑满 + log-list flex:1） */
.logs-body { display: flex; flex-direction: column; padding: 5px; overflow: hidden; }
.logs-body > .logs-content { flex: 1; min-height: 0; height: auto; }
.logs-body .log-list { margin-top: 4px; }

/* ====== 表单 ====== */
.form-group { display: flex; flex-direction: row; align-items: center; margin-bottom: 5px; }
.form-group label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 0px;
  color: var(--fontColor);
  min-width: 90px;
  flex-shrink: 0;
}
.form-group input:not([type="checkbox"]):not([type="radio"]) {
  width: calc(100% - 18px);
  height: 26px;
  box-sizing: border-box;
  padding: 2px 6px;
  margin: 0px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
}
.form-group input[type="checkbox"],
.form-group input[type="radio"] {
  flex: none;
  margin: 0px;
}
.form-group select {
  flex: 1;
  height: 26px;
  box-sizing: border-box;
  padding: 0 4px;
  margin: 0px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  min-width: 0;
}
/* 随任务文件保留：两个复选框成对（min-width 复位，避免继承 .form-group label 的 90px） */
.keep-file-box { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; flex-wrap: wrap; }
.keep-file-check { display: inline-flex; align-items: center; gap: 4px; min-width: 0; font-size: 11px; color: var(--fontColor); cursor: pointer; }
/* 轮次（多轮处理）：下拉 + 新建 / 重命名 / 删除 三个小图标按钮，高度与其它表单行一致 */
.round-box { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; }
.round-box .round-select { flex: 1; min-width: 0; height: 26px; box-sizing: border-box; padding: 0 4px; margin: 0; font-size: 11px; border: 1px solid var(--borderColor); border-radius: 4px; background: var(--backgroundColor); color: var(--fontColor); }
.round-box .round-btn {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; box-sizing: border-box;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor);
  font-size: 11px; cursor: pointer; user-select: none;
}
.round-box .round-btn:hover { background: var(--menuColor); color: var(--fontActiveColor); }
.round-box .round-btn.danger:hover { color: #f44336; }
.round-box .round-btn.disabled { opacity: 0.4; cursor: not-allowed; pointer-events: none; }
.round-box .round-btn.disabled:hover { background: var(--backgroundColor); color: var(--fontColor); }

/* ====== DeepSeek Responses 联网调研提示 ====== */
.dsr-hint {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin: -2px 0 6px 94px;
  font-size: 10px;
  line-height: 1.5;
  color: #2196F3;
  word-break: break-word;
}

/* ====== 筛选控件 ====== */
/* 注：状态筛选已改为 StatusMultiSelect 组件（多选）；全局 style.css 的 select { width: calc(100% - 10px) }
   会让 select 作为 flex 子元素时按整行宽度计算而撑满，故不要再往工具栏塞裸 <select> */
.filter-input {
  width: 120px;
  flex: none;
  height: 26px;
  margin: 0px;
  box-sizing: border-box;
  padding: 0 6px;
  font-size: 11px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
}

/* 筛选比较符（步数 / 耗时共用；工具栏裸 select 会被全局样式拉宽，必须显式给宽高） */
.filter-op-select {
  width: 46px;
  flex: none;
  height: 26px;
  margin: 0px;
  box-sizing: border-box;
  padding: 0 2px;
  font-size: 11px;
  text-align: center;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
}

/* ====== 列显示选择 ====== */
.col-toggle-list {
  flex: 1;
  min-width: 0;
  max-height: 180px;
  overflow: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  padding: 3px 4px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
}
.col-toggle-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  cursor: pointer;
  color: var(--fontColor);
  white-space: nowrap;
  user-select: none;
  padding: 0px
}
.col-toggle-item:hover { color: var(--fontActiveColor); }
.col-toggle-item.checked { color: var(--fontActiveColor); }
.col-toggle-empty { font-size: 10px; color: var(--borderColor); }
.goal-group { align-items: flex-start; }
.goal-group textarea {
  flex: 1;
  min-width: 0;
  width: auto;
  min-height: 110px;
  padding: 2px 6px;
  margin: 0px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  font-family: inherit;
  resize: vertical;
  line-height: 1.4;
}

/* ====== 占位符数据选择区（.data-chips 见上：输入面板两段式） ====== */
.placeholder-chips { display: flex; flex-wrap: wrap; gap: 3px; }
.placeholder-chip {
  display: inline-block;
  padding: 1px 6px;
  font-size: 10px;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  background: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  user-select: none;
  transition: all 0.15s;
}
.placeholder-chip:hover { background: #2196F3; color: white; border-color: #2196F3; }
.placeholder-chip.special { border-style: dashed; color: #2196F3; }
/* 数据选择：已引用的列高亮（点击 = 写入 / 移除任务指令里的 {{列名}}） */
.placeholder-chip.on { background: #2196F3; color: #fff; border-color: #2196F3; }
/* 前轮结果（跳轮引用）：用另一套底色与列芯片区分 */
.round-ref-block { margin-top: 5px; }
/* 轮次对比页：工具栏 + 并排结果表 */
/* 注意：父容器 .main-content 是 block，flex:1 在这里不起作用（会被内容撑高再被裁剪），
   必须用 height:100% 撑满，配合内部 min-height:0 才能让表格自己滚动 */
.compare-wrap { display: flex; flex-direction: column; min-height: 0; height: 100%; overflow: hidden; }
/* 行数多时表格要能在这块区域里上下滚动：flex 子项默认 min-height:auto 会按内容撑高，
   导致外层 overflow:hidden 直接裁掉、滚不动 —— 必须显式归零 */
/* 容器不再描边：表格自身的单元格边框已是完整外框，否则最外层看起来是两层线 */
.compare-wrap > .files-table-wrap { min-height: 0; border: 0; border-radius: 0; }
.compare-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--borderColor); font-size: 11px; }
.compare-label { color: var(--fontColor); opacity: 0.8; }
.compare-info { color: var(--fontColor); opacity: 0.6; cursor: help; margin-left: 4px; }
.compare-cell { white-space: pre-line; }
/* 有内容的格子可点击 → 用 block_md 渲染预览该轮结果 */
.compare-cell.clickable { cursor: pointer; }
.compare-cell.clickable:hover { background: var(--menuColor); text-decoration: underline dotted; text-underline-offset: 2px; }
.compare-preview-body { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--borderColor); border-radius: 4px; }
.compare-issue-row td { background: rgba(230, 162, 60, 0.09); }
.compare-icon-diff { color: #e6a23c; }
.compare-icon-missing { color: #909399; }
.compare-icon-same { color: #4caf50; opacity: 0.7; }
.round-ref-head { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--fontColor); opacity: 0.85; margin-bottom: 3px; }
.placeholder-chip.round-ref { border-style: dashed; }
.placeholder-chip.round-ref:hover { background: #9C27B0; border-color: #9C27B0; color: #fff; }
.placeholder-chip.round-ref.on { background: #9C27B0; border-color: #9C27B0; color: #fff; }
/* ====== 输入面板两段式：任务指令 / 数据选择 ====== */
.io-section { margin-top: 8px; }
.io-sec-title {
  font-size: 11px; font-weight: 600; color: var(--fontActiveColor);
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.io-instr {
  display: block; width: 100%; box-sizing: border-box; min-height: 130px;
  padding: 2px 6px; margin: 0; border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 11px; font-family: inherit;
  resize: vertical; line-height: 1.4;
}
/* 任务指令区底部：未匹配占位符保留原样（原来在执行与配置卡的「未匹配占位符」） */
.instr-opt-row { display: flex; align-items: center; gap: 6px; margin-top: 3px; flex: none; }
.instr-opt-row label { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--fontColor); cursor: pointer; min-width: 0; }
.instr-opt-row label input[type="checkbox"] { flex: none; margin: 0; }
.data-chips {
  max-height: 132px; overflow: auto; box-sizing: border-box;
  border: 1px dashed var(--borderColor); border-radius: 4px; padding: 4px 6px;
}
/* ====== 导出列表单（竖向排列：点行开关 + 拖手柄排序） ====== */
/* 输出面板本身改为 flex 列：其余部分保持内容高度，导出列占满剩余高度（窗口变高时跟着变高，
   内容真的超出时面板自己滚动，导出列至少留 150px） */
.task-panels .task-panel-output { display: flex; flex-direction: column; }
/* 输出面板底部留白与左右一致（.form-section 默认 padding-bottom 只有 2px，
   导出列撑满剩余高度后会贴到面板底边，看起来比左右窄） */
.task-panels .task-panel-output { padding-bottom: 8px; }
.task-panels .task-panel-output > * { flex: none; }
.task-panels .task-panel-output > .export-block { flex: 1 1 auto; min-height: 150px; display: flex; flex-direction: column; }
.task-panels .task-panel-output .export-block .export-form { flex: 1 1 auto; min-height: 0; max-height: none; }
.export-form {
  max-height: 176px; overflow: auto; box-sizing: border-box;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor);
}
.export-form-item {
  display: flex; align-items: center; gap: 5px;
  padding: 3px 6px; font-size: 11px; line-height: 1.4;
  color: var(--fontColor); cursor: pointer; user-select: none;
  border-bottom: 1px solid color-mix(in srgb, var(--borderColor) 45%, transparent);
}
.export-form-item:last-child { border-bottom: none; }
.export-form-item:hover { background: var(--menuColor); color: var(--fontActiveColor); }
.export-form-item:not(.on) { opacity: 0.5; }
.export-form-grip { flex: none; opacity: 0.45; cursor: grab; font-size: 10px; }
.export-form-grip:active { cursor: grabbing; }
.export-form-check { flex: none; font-size: 11px; opacity: 0.9; }
.export-form-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 列名（可直接编辑：平时看起来像普通文字，悬停 / 聚焦才出现边框） */
.export-form-name {
  flex: 1; min-width: 0; height: 17px; padding: 0 3px; margin: 0;
  font-size: 11px; line-height: 17px; color: inherit; background: transparent;
  border: 1px solid transparent; border-radius: 3px; outline: none;
}
.export-form-item:hover .export-form-name { border-color: color-mix(in srgb, var(--borderColor) 70%, transparent); }
.export-form-name:hover { background: var(--backgroundColor); }
.export-form-name:focus { background: var(--backgroundColor); border-color: var(--borderColor); }
.export-form-name::placeholder { color: var(--fontColor); opacity: 0.5; }
.export-form-kind { flex: none; font-size: 9px; opacity: 0.55; }
/* ====== 源表增量（新增 / 已变更 / 已移除）====== */
.source-delta-chip {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  padding: 2px 6px; font-size: 10px; border-radius: 10px; cursor: default;
  color: #b26a00; background: color-mix(in srgb, #ff9800 16%, transparent);
  border: 1px solid color-mix(in srgb, #ff9800 40%, transparent);
}
.source-delta-x { cursor: pointer; opacity: 0.65; }
.source-delta-x:hover { opacity: 1; }
/* 新增 / 变更 / 移除 三个可点分段：点一下就在下方表格里筛选 */
.delta-seg { padding: 0 5px; border-radius: 8px; cursor: pointer; }
.delta-seg:hover { background: color-mix(in srgb, currentColor 18%, transparent); }
.delta-seg.on { background: color-mix(in srgb, #ff9800 30%, transparent); font-weight: 600; }
.delta-seg.off { opacity: 0.45; cursor: default; }
.delta-seg.off:hover { background: none; }
.delta-seg.added { color: #1b7f3b; }
.delta-seg.modified { color: #b26a00; }
.delta-seg.removed { color: #a33; cursor: default; }
/* 指纹不可比（按行号对位）时：中性灰，表示「有变化但对不上」 */
.source-delta-chip.muted { color: #8a6d3b; background: color-mix(in srgb, #9e9e9e 16%, transparent); border-color: color-mix(in srgb, #9e9e9e 40%, transparent); }
/* 被删掉的源行：详情页工具栏上可点的「移除 N」（有可筛的记录时） */
.delta-seg.removed.clickable { cursor: pointer; }
.delta-seg.removed.clickable:hover { background: color-mix(in srgb, currentColor 18%, transparent); }
/* 结果页「已移除 N」筛选按钮 */
.removed-toggle { color: #a33; border-color: color-mix(in srgb, #a33 35%, transparent); }
.removed-toggle.accent { background: color-mix(in srgb, #a33 14%, transparent); font-weight: 600; }
/* 同步源表：有待同步的变化时用强调色提醒 */
.source-sync-btn.accent { color: #b26a00; border-color: color-mix(in srgb, #ff9800 45%, transparent); background: color-mix(in srgb, #ff9800 12%, transparent); }
/* 「同步结果」：结果与任务行对不上时同样强调 */
.button.accent { color: #b26a00; border-color: color-mix(in srgb, #ff9800 45%, transparent); background: color-mix(in srgb, #ff9800 12%, transparent); }
.placeholder-warn {
  margin-bottom: 5px;
  font-size: 10px;
  color: #FF9800;
  word-break: break-all;
}

/* ====== 帮助 ====== */
.help-block { margin-bottom: 5px; padding: 5px; border: 1px solid var(--borderColor); border-radius: 4px; }
.help-title { font-size: 11px; font-weight: 500; margin-bottom: 4px; }
.help-list { margin: 0; padding-left: 16px; font-size: 11px; line-height: 1.7; }
.help-text { margin: 0; font-size: 11px; line-height: 1.6; color: var(--fontColor); }

/* ====== 帮助标签页 ====== */
.help-tab { height: 100%; overflow: hidden; }
.help-tab-body { height: 100%; overflow: auto; padding: 5px; }
/* 帮助分区：条目列表用圆点（reset.css 不动 list-style，这里只补内缩） */
.help-tab .help-list { list-style: disc outside; padding-left: 16px; }
.help-tab .help-list li { margin-bottom: 1px; }

.status-text { font-weight: normal; font-size: 10px; color: var(--borderColor); }

/* ====== 状态统计点 ====== */
.files-stats { display: flex; align-items: center; gap: 6px; font-size: 10px; }
.stat-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-left: 4px; }
.pending-dot { background: #FFC107; }
.running-dot { background: #2196F3; }
.completed-dot { background: #4CAF50; }
.failed-dot { background: #f44336; }
.skipped-dot { background: #9E9E9E; }

/* ====== 行 tab ====== */
.files-content { display: flex; flex-direction: column; height: 100%; }
.files-layout { display: flex; flex: 1; gap: 6px; min-height: 0; }
.files-table-wrap {
  flex: 1;
  overflow: auto;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  /* 窗口式渲染：插/删行由代码实测补偿 scrollTop，禁用浏览器滚动锚定以免双重补偿抖动 */
  overflow-anchor: none;
}
/* 窗口式渲染：窗口之前被跳过的行用高度顶开（不渲染 DOM），跳转大表时可即时定位到任意行 */
.table-top-spacer { width: 100%; pointer-events: none; }
/* 图谱视图（链接采集）：占满剩余区域；节点=页面（颜色=状态），边=爬取轨迹 */
.graph-view-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; border: 1px solid var(--borderColor); border-radius: 4px; overflow: hidden; }
.graph-hint { flex: none; padding: 5px; font-size: 10px; color: var(--fontColor); display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--borderColor); }
/* 工具栏控件统一高度（下拉与节点上限输入框一致）；节点上限不再显示 label 文字（改 title） */
.graph-hint .graph-mode-select, .graph-hint .graph-max-nodes input {
  height: 22px;
  box-sizing: border-box;
  padding: 0 4px;
  margin: 0;
  font-size: 10px;
  line-height: 20px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
}
.graph-hint .graph-mode-select { flex: none; max-width: 130px; }
.graph-max-nodes { flex: none; display: inline-flex; align-items: center; }
.graph-max-nodes input { width: 62px; }
/* 图例（同时是筛选器）：彩色圆点 + 短标签；单击隐藏 / 恢复该类型 */
.graph-legend { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.legend-item { display: inline-flex; align-items: center; gap: 3px; cursor: pointer; user-select: none; white-space: nowrap; }
.legend-item:hover { color: var(--fontActiveColor, #409eff); }
.legend-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15) inset; }
/* 已筛选掉（隐藏）：整体变淡 + 圆点空心感 */
.legend-item.off { opacity: 0.38; text-decoration: line-through; }
/* 当前图中没有该类型：不可点 */
.legend-item.muted { opacity: 0.3; cursor: default; }
.legend-item.muted:hover { color: inherit; }
.graph-hint-tail { flex: 1; min-width: 0; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.85; }
.graph-canvas { flex: 1; min-height: 0; position: relative; }
/* 图谱空态说明（投影无内容时居中提示原因与去处） */
.graph-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 24px;
  text-align: center;
  font-size: 11px;
  line-height: 1.6;
  color: var(--fontColor);
  opacity: 0.6;
  pointer-events: none;
}
.graph-empty i { font-size: 22px; opacity: 0.7; }
.files-preview {
  width: 360px;
  flex: none;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  overflow: hidden;
}
.files-preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 8px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  font-size: 11px;
  flex-shrink: 0;
}
.row-preview-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px;
  overflow: hidden;
}

.pv-section { display: flex; flex-direction: column; min-height: 0; }
.pv-title { font-size: 11px; font-weight: 500; margin-bottom: 3px; flex-shrink: 0; }

/* 输出（顶部，最多占 55% 高度） */
.pv-output { flex: 0 0 auto; max-height: 55%; }
.pv-output-body { flex: 1; min-height: 0; overflow: auto; }
.pv-md { padding: 0; }
/* 行详情里的 Markdown 紧凑排版：与「文件阅读」同为 markdown-it 渲染，只是这里按预览尺寸收小
   （全局 h1 是 2.2em、段落默认 1em 上下边距，直接套用会又高又空） */
.pv-md :deep(h1), .pv-md :deep(h2), .pv-md :deep(h3), .pv-md :deep(h4), .pv-md :deep(h5), .pv-md :deep(h6) {
  font-size: 13px;
  line-height: 1.35;
  margin: 8px 0 4px;
  font-weight: 600;
}
.pv-md :deep(h1) { font-size: 15px; }
.pv-md :deep(h2) { font-size: 14px; }
.pv-md :deep(p) { margin: 4px 0; }
.pv-md :deep(ul), .pv-md :deep(ol) { margin: 4px 0; padding-left: 20px; }
.pv-md :deep(li) { margin: 2px 0; }
.pv-md :deep(li > p) { margin: 0; }
.pv-md :deep(blockquote) { margin: 4px 0; padding: 2px 8px; }
.pv-md :deep(pre) { margin: 4px 0; padding: 6px 8px; font-size: 11px; overflow: auto; }
.pv-md :deep(hr) { margin: 8px 0; }
.pv-md :deep(table) { font-size: 11px; }
.pv-md :deep(th), .pv-md :deep(td) { padding: 3px 6px; height: auto; }
.pv-md :deep(:first-child) { margin-top: 0; }

/* 输入（占满剩余高度） */
.pv-input { flex: 1 1 0; }
.pv-input .pv-input-pre {
  flex: 1;
  min-height: 0;
  overflow: auto;
  max-height: none;
  margin: 0;
}

.pv-pre {
  margin: 0;
  padding: 6px;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--fontColor);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  overflow: auto;
}
.pv-live { color: #2196F3; }
.pv-error { color: #f44336; }
.pv-empty { color: var(--borderColor); font-size: 11px; padding: 8px; }
.thinking-status { color: #2196F3; font-size: 11px; }

/* ====== 行详情：头部（左＝页签与操作，右＝运行计数） ====== */
.detail-head-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--borderColor);
}
.detail-tabs { display: flex; align-items: center; gap: 4px; flex: none; }
.detail-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  font-size: 11px;
  font-family: inherit;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  user-select: none;
}
.detail-tab:hover { background: var(--menuColor); color: var(--fontActiveColor); }
.detail-tab.active { background: var(--menuActiveColor); color: var(--fontActiveColor); border-color: var(--borderColor); }
/* 右侧计数：开始 / 结束 / 耗时 / 步数 / Token（从右往左读，图标只在悬停时给名称） */
.detail-counts {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px 12px;
  flex-wrap: wrap;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.9;
}
.detail-counts i { margin-right: 3px; opacity: 0.75; }
/* 页签内容独占剩余高度（两种详情区原本按 45% / 55% 分栏，现在只有一个显示） */
.row-detail-body .detail-section { flex: 1 1 auto; }

/* ====== 行详情：过程页签（步骤 / 工具调用） ====== */
.detail-process-section { white-space: normal; }
.detail-process-body { padding: 5px; flex: 1; min-height: 0; overflow: auto; white-space: normal; }
.detail-process-missing { font-size: 11px; color: var(--borderColor); padding: 4px 2px 8px; white-space: normal; }
.live-step { margin-bottom: 8px; padding: 5px; border: 1px solid var(--borderColor); border-radius: 4px; }
.live-step:last-child { margin-bottom: 0; }
.live-step-head { font-size: 10px; font-weight: 500; color: var(--borderColor); margin-bottom: 3px; }
.live-reasoning { font-size: 11px; color: #9C27B0; margin-bottom: 2px; word-break: break-word; white-space: pre-wrap; }
.live-content { font-size: 11px; margin-bottom: 2px; word-break: break-word; white-space: pre-wrap; }
/* 单次工具调用：与 home.vue 的 tool-box 同款（边框 + 头部行，默认只显示单行摘要） */
.live-tool-call {
  margin: 3px 0;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  overflow: hidden;
}
.live-tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
  background: var(--menuColor);
  cursor: pointer;
  user-select: none;
}
.live-tool-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live-tool-call.running .live-tool-head { color: #2196F3; }
.live-tool-call.success .live-tool-head { color: #4CAF50; }
.live-tool-call.error .live-tool-head { color: #f44336; }
.live-tool-state { font-size: 9px; opacity: 0.7; }
.live-tool-toggle {
  margin-left: auto;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  opacity: 0.55;
}
.live-tool-toggle i { font-size: 10px; transition: transform .18s ease; }
.live-tool-toggle.expanded i { transform: rotate(180deg); }
.live-tool-call:hover .live-tool-toggle { opacity: 1; }
/* 折叠态单行摘要（不换行、超出省略，点击展开） */
.live-tool-preview {
  padding: 5px 8px;
  border-top: 1px solid var(--borderColor);
  font-size: 11px;
  line-height: 1.4;
  opacity: 0.9;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  user-select: none;
}
.live-tool-preview:hover { background: var(--menuColor); color: var(--fontActiveColor); }
/* 展开态：参数 / 结果（等宽、限高滚动，对齐 home.vue 的 tool-code-box / tool-result-box） */
.live-tool-block { padding: 4px 8px 5px; border-top: 1px solid var(--borderColor); }
.live-tool-label { font-size: 9px; opacity: 0.7; margin-bottom: 2px; }
.live-tool-note { margin-left: 4px; color: #FF9800; }
.live-tool-pre {
  margin: 0;
  padding: 4px 6px;
  font-size: 11px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  max-height: 320px;
  overflow: auto;
}

/* ====== 服务端联网搜索状态（DeepSeek Responses） ====== */
.server-search-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
  padding: 4px 8px;
  font-size: 11px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--menuColor);
  color: #2196F3;
}
.server-search-banner.searching i { color: #2196F3; }
.server-search-banner.done { color: #4CAF50; }
.server-search-query { font-weight: 500; }

/* ====== 操作列（现在只显示状态文字，不再有下拉 / 重跑 / 删除按钮） ====== */

/* ====== 状态标签 ====== */
.status-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  padding: 2px 4px;
  border-radius: 8px;
  font-size: 11px;
}
.status-tag.pending { background: #FFC107; color: #333; }
.status-tag.running { background: #2196F3; color: white; }
.status-tag.completed { background: #4CAF50; color: white; }
.status-tag.failed { background: #f44336; color: white; }
.status-tag.skipped { background: #9E9E9E; color: white; }

.file-path-cell { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-result-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fontColor); }
.row-selected { background: rgba(33, 150, 243, 0.1); }
.row-running { background: rgba(33, 150, 243, 0.05); }

/* ====== 操作图标 ====== */
.row-ops {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 2px 6px;
  max-width: 120px;
}
.action-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin: 0 2px;
  cursor: pointer;
  color: var(--fontColor);
  font-size: 12px;
  border-radius: 4px;
  transition: all 0.15s;
}
.action-icon:hover { background: var(--menuColor); color: var(--fontActiveColor); }
.action-icon.danger:hover { background: rgba(244, 67, 54, 0.15); color: #f44336; }

/* ====== 日志/表格 通用 ====== */
.logs-content, .table-content { display: flex; flex-direction: column; height: 100%; }
/* 日志工具栏：grid 布局——第 1 列＝标签区（1fr，内部横向滚动），第 2 列＝尾部操作（auto，如清空日志） */
.log-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  flex-shrink: 0;
  gap: 4px;
  padding: 0px 5px;
}
.log-toolbar-tail { display: flex; align-items: center; gap: 4px; }
/* 表格页工具栏：控件多（搜索/跳转/筛选/重跑/图标组）且窄窗口需自动换行，保持 flex，覆盖上面的 grid */
.table-toolbar {
  display: flex;
  justify-content: flex-start;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
/* 表格页视图切换（源 / 数据）：选中态用主强调色 */
.view-switch-btn.active {
  background: #2196F3;
  color: #fff;
  border-color: #2196F3;
}
/* 任务页分组子面板（输入 / 执行 / 输出 / 配置） */
.form-section {
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  padding: 6px 8px 2px;
  margin-bottom: 8px;
}
.form-section-title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--fontActiveColor);
  margin-bottom: 6px;
}
.toolbar-spacer { flex: 1 1 auto; min-width: 0; }

/* ====== 行号范围筛选 / 重跑选区 ====== */
/* 行号表达式里的非法片段：输入框标红（无效片段清单写在 title 里） */
.filter-input.input-invalid { border-color: #f44336; color: #f44336; }
/* 重跑选区入口已并入筛选面板（.filter-scope-select），旧「重跑 ▾」菜单样式已删除 */

/* ====== 筛选面板（状态 / 搜索 / 结果 / 行号 / 步数 / 耗时 统一配置 + 命中统计 + 批量标记） ====== */
.filter-menu-btn { position: relative; }
.filter-menu-btn.on { border-color: #2196F3; color: var(--fontActiveColor); }
.filter-menu-count {
  display: inline-block; min-width: 14px; margin-left: 4px; padding: 0 4px;
  font-size: 10px; line-height: 14px; text-align: center;
  border-radius: 7px; background: #2196F3; color: #fff;
}
.filter-menu-hit { margin-left: 5px; font-size: 10px; opacity: 0.75; }
/* 层级：面板（991）要在内容之上，但要低于 StatusMultiSelect 的弹层（999）——否则状态下拉会被面板挡住 */
.filter-panel-mask { position: fixed; inset: 0; z-index: 990; }
.filter-panel {
  position: fixed;
  z-index: 991;
  overflow: auto;
  padding: 8px 10px 10px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--backgroundColor);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
  font-size: 11px;
  color: var(--fontColor);
}
.filter-panel-head { display: flex; align-items: center; gap: 6px; font-weight: 600; margin-bottom: 6px; }
.filter-panel-clear { margin-left: auto; font-weight: normal; font-size: 10px; padding: 1px 7px; border: 1px solid var(--borderColor); border-radius: 4px; background: var(--menuColor); cursor: pointer; user-select: none; }
.filter-panel-clear:hover { background: var(--menuActiveColor); color: var(--fontActiveColor); }
.filter-panel-clear.disabled { opacity: 0.45; cursor: not-allowed; }
.filter-panel-clear.disabled:hover { background: var(--menuColor); color: var(--fontColor); }
.filter-panel-body { display: flex; flex-direction: column; gap: 5px; }
.filter-row { display: flex; align-items: center; gap: 6px; }
.filter-row-label { width: 32px; flex: none; font-size: 10px; opacity: 0.8; }
/* 面板内的状态多选：占满剩余宽度（与其它输入行对齐） */
.filter-row > :deep(.status-multi) { flex: 1; min-width: 0; }
.filter-panel-count {
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  margin-top: 8px; padding: 5px 6px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--menuColor);
}
.filter-panel-count .fa-crosshairs { color: #2196F3; }
.filter-panel-note { font-size: 10px; opacity: 0.75; }
.filter-panel-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.filter-tag { padding: 1px 6px; font-size: 10px; border: 1px solid var(--borderColor); border-radius: 3px; background: var(--menuColor); }
.filter-tag.empty { opacity: 0.6; }
/* 条件旁的快捷开关（如「结果为空」）：点一下即切换 */
.filter-chip {
  flex: none;
  padding: 2px 7px;
  font-size: 10px;
  line-height: 16px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--menuColor);
  cursor: pointer;
  user-select: none;
}
.filter-chip:hover { background: var(--menuActiveColor); color: var(--fontActiveColor); }
.filter-chip.on { background: #2196F3; border-color: #2196F3; color: #fff; }
.filter-panel-mark { margin-top: 8px; padding-top: 7px; border-top: 1px dashed var(--borderColor); }
.filter-mark-title { font-size: 10px; opacity: 0.85; margin-bottom: 5px; }
.filter-mark-btns { display: flex; flex-wrap: wrap; gap: 5px; }
.filter-mark-btns .detail-edit-btn.primary { background: #2196F3; border-color: #2196F3; color: #fff; }
.filter-mark-btns .detail-edit-btn.primary:hover { background: #1976D2; border-color: #1976D2; color: #fff; }
.filter-mark-hint { margin: 6px 0 6px; font-size: 10px; line-height: 1.5; opacity: 0.75; }

.modal-btn:disabled { opacity: 0.5; cursor: not-allowed; }
/* 线程/主日志标签：可换行（不再横向滚动）——窗口变窄时标签自动折到下一行 */
.logs-tabs { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; padding: 2px 0; }
.log-tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 10px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
  white-space: nowrap;
}
.log-tab-btn.active { background: #2196F3; color: white; border-color: #2196F3; }
/* 运行中线程用蓝色文字标记；但**选中时不能再覆盖颜色**，否则蓝底 + 蓝字看不清
   （.busy 与 .active 同权重，靠写在前面的 .active 是压不住后写的 .busy 的） */
.log-tab-btn.busy:not(.active) { color: #2196F3; }
.log-tab-count { font-size: 9px; opacity: 0.7; }
.log-list {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  padding: 4px;
  /* 窗口式渲染：插/删条目由代码实测补偿 scrollTop，禁用浏览器滚动锚定以免双重补偿抖动 */
  overflow-anchor: none;
}
/* 日志窗口式渲染：上方被折叠的日志用高度顶开（不渲染 DOM） */
.log-top-spacer { width: 100%; pointer-events: none; }
.log-more-hint {
  text-align: center;
  font-size: 10px;
  padding: 3px 0;
  color: var(--fontColor);
  opacity: 0.8;
  user-select: none;
  cursor: pointer;
}
.log-more-hint:hover { color: var(--fontActiveColor); opacity: 1; }
.log-more-hint i { margin-right: 4px; }
/* ====== 日志过滤条（级别 chip + 计数 + 关键字） ====== */
.log-filter-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  flex-shrink: 0;
  padding: 2px 2px 4px;
}
.log-level-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  font-size: 10px;
  line-height: 16px;
  border: 1px solid var(--borderColor);
  border-radius: 9px;
  cursor: pointer;
  user-select: none;
  color: var(--fontColor);
  opacity: 0.7;
  transition: all 0.15s;
}
.log-level-chip:hover { opacity: 1; background: var(--menuColor); }
.log-level-chip.active { opacity: 1; border-color: currentColor; background: var(--menuColor); }
.log-level-chip b { font-weight: 500; font-size: 9px; opacity: 0.85; }
.log-level-chip.error { color: #f44336; }
.log-level-chip.warning { color: #FF9800; }
.log-level-chip.success { color: #4CAF50; }
.log-level-chip.info { color: #2196F3; }
.log-filter-reset { font-size: 10px; padding: 0 4px; cursor: pointer; color: var(--fontColor); opacity: 0.7; text-decoration: underline; }
.log-filter-reset:hover { opacity: 1; color: var(--fontActiveColor); }
.log-search { width: 150px; height: 22px; }

.log-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 2px 4px 2px 0;
  font-size: 10px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
}
/* 左侧色条（代替实心胶囊）：级别只看颜色，降低视觉噪音 */
.log-bar { flex: none; width: 3px; align-self: stretch; margin-right: 1px; border-radius: 2px; background: rgba(128, 128, 128, 0.25); }
.log-item.info .log-bar { background: #2196F3; }
.log-item.success .log-bar { background: #4CAF50; }
.log-item.warning .log-bar { background: #FF9800; }
.log-item.error .log-bar { background: #f44336; }
.log-time { color: var(--borderColor); flex-shrink: 0; font-family: monospace; }
.log-level { flex-shrink: 0; font-size: 9px; width: 24px; }
.log-item.error .log-level { color: #f44336; }
.log-item.warning .log-level { color: #FF9800; }
.log-item.success .log-level { color: #4CAF50; }
.log-item.info .log-level { color: var(--fontColor); opacity: 0.5; }
.log-message { flex: 1; min-width: 0; word-break: break-all; white-space: pre-wrap; }
/* 步骤级（💭 推理 / 🧰 工具 / ✔ 结果）缩进，与行级、系统级区分开 */
.log-item.lv-step .log-message { padding-left: 12px; opacity: 0.9; }
/* 行级：淡蓝底 + 加粗，方便按行扫读 */
.log-item.lv-row { background: rgba(33, 150, 243, 0.06); }
.log-item.lv-row .log-message { font-weight: 500; }
/* 错误 / 警告整行淡色底（放在 lv-row 之后，保证优先级） */
.log-item.warning { background: rgba(255, 152, 0, 0.08); }
.log-item.error { background: rgba(244, 67, 54, 0.08); }
/* 行号链接：#123 → 跳到表格该行 */
.log-row-link {
  flex: none;
  cursor: pointer;
  color: #2196F3;
  font-weight: 500;
  text-decoration: underline dotted;
}
.log-row-link:hover { color: var(--fontActiveColor); }
/* 长文本默认折叠一行，点击展开 */
.log-message.expandable { cursor: pointer; }
.log-message.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre-wrap;
}
.log-worker-tag { flex-shrink: 0; padding: 0 4px; border-radius: 3px; font-size: 9px; background: rgba(156, 39, 176, 0.15); color: #9C27B0; }
.worker-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 11px;
}
.worker-title { font-weight: bold; }
.worker-page-count { color: #2196F3; font-size: 10px; }
.worker-url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #2196F3; font-size: 10px; }
.idle-text { color: var(--borderColor); }
.worker-log-empty { padding: 20px; text-align: center; color: var(--borderColor); font-size: 11px; }

/* ====== 数据表 ====== */
.data-table-scroll { flex: 1; overflow: auto; border: 1px solid var(--borderColor); border-radius: 4px; }
.data-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.data-table th, .data-table td {
  border: 1px solid var(--borderColor);
  padding: 2px;
  text-align: left;
  max-width: 768px;
  overflow: hidden;
  white-space: normal;
  word-break: break-all;
  overflow-wrap: break-word;
  vertical-align: middle;
}
.data-table th { background: var(--menuColor); position: sticky; top: 0; z-index: 1; font-weight: 500; }
.cell-wrap { max-width: 360px; }
/* 元信息列（开始/结束/耗时/Token）：不折行，窄列小字 */
.cell-nowrap { text-align: center; white-space: nowrap; font-size: 10px; color: var(--fontColor); }
/* 结果页：只读预览的截断提示 */
.table-preview-hint { padding: 6px 8px; font-size: 10px; color: var(--fontColor); }
.result-cell { color: var(--fontActiveColor); }
/* 结果单元格最多显示 3 行，超出部分用省略号（完整内容见 title 提示 / 行详情模态框） */
.clamp-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.35;
  word-break: break-all;
}
.load-more-row td.load-more-hint {
  text-align: center;
  color: var(--fontColor);
  font-size: 10px;
  padding: 6px;
  user-select: none;
  background: var(--backgroundColor);
  cursor: pointer;
}
.load-more-row td.load-more-hint:hover {
  background: var(--menuColor);
  color: var(--fontActiveColor);
}
.load-more-row td.load-more-hint i { margin-right: 4px; opacity: 0.8; }

/* ====== 空状态 ====== */
.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 80px;
  color: var(--borderColor);
  font-size: 12px;
}
.empty-hint i { font-size: 20px; }

/* ====== 弹窗 ====== */
.modal-overlay {
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal-content {
  background: var(--backgroundColor);
  border-radius: 8px;
  width: 400px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--borderColor);
}
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px;
  border-bottom: 1px solid var(--borderColor);
}
.modal-header h3 { margin: 0; font-size: 14px; }
.modal-close { background: none; border: none; color: var(--fontColor); cursor: pointer; font-size: 16px; }
.modal-body { flex: 1; overflow-y: auto; padding: 5px; }
.modal-footer { display: flex; align-items: center; justify-content: flex-end; gap: 5px; padding: 5px; border-top: 1px solid var(--borderColor); }
/* 按钮与下拉（输入元素）统一 24px 高，底部一行看起来齐整 */
.modal-btn { display: inline-flex; align-items: center; gap: 4px; box-sizing: border-box; height: 24px; padding: 0 12px; border-radius: 4px; border: 1px solid var(--borderColor); background: var(--menuColor); color: var(--fontColor); cursor: pointer; font-size: 11px; }
.modal-btn-cancel { background: var(--backgroundColor); color: var(--fontColor); }
.modal-btn-confirm { background: #2196F3; color: white; border-color: #2196F3; }
.modal-btn.danger { background: #f44336; color: white; border-color: #f44336; }

/* ====== 行详情模态框 ====== */
.row-detail-modal { width: 720px; max-width: 92vw; height: 82vh; max-height: 92vh; }
/* 注意：这类覆盖 .modal-content 默认尺寸的规则必须写在 .modal-content 之后，否则会被 400px 默认宽度盖掉 */
.compare-preview-modal { width: 760px; max-width: 92vw; height: 76vh; max-height: 92vh; }
.row-detail-title { display: inline-flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; max-width: 90%; }
.row-detail-title > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-detail-body { display: flex; flex-direction: column; gap: 10px; }
/* 行详情：运行元信息条（已并入详情头部，此处保留类以备他用） */
.detail-section { display: flex; flex-direction: column; min-height: 0; }
.detail-title { font-size: 12px; font-weight: 500; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
.detail-edit-actions { margin-left: auto; display: flex; gap: 6px; }
.detail-edit-btn { cursor: pointer; font-size: 11px; padding: 1px 8px; border: 1px solid var(--borderColor); border-radius: 4px; background: var(--menuColor); color: var(--fontColor); user-select: none; }
.detail-edit-btn:hover { background: var(--menuActiveColor); color: var(--fontActiveColor); }
.detail-edit-btn.save { color: var(--fontActiveColor); }
.detail-edit-btn.cancel { color: var(--dangerColor, #e57373); }
.detail-edit-textarea {
  width: 100%;
  min-height: 160px;
  box-sizing: border-box;
  padding: 8px;
  font-size: 12px;
  font-family: inherit;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  resize: none;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-all;
}
.detail-output { flex: 1 1 55%; min-height: 0; }
/* 输出区：容器保持正常排版（不能设 pre-wrap —— markdown 由 v-html 生成，
   容器上的 pre-wrap 会被块级元素继承，把 HTML 里的换行当成硬换行，同一段内容高度虚增约七成）；
   只有等宽文本块（流式输出 / 错误 / 编辑框）才用 pre-wrap + 硬换行。 */
.detail-output-body { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--borderColor); border-radius: 4px; padding: 6px; font-size: 12px; color: var(--fontColor); white-space: normal; word-break: break-word; }
.detail-output-body pre { white-space: pre-wrap; word-break: break-all; }
.detail-input { flex: 1 1 45%; min-height: 0; display: flex; flex-direction: column; }
.detail-input-pre {
  flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 6px;
  font-size: 12px; white-space: pre-wrap; word-break: break-all; border: 1px solid var(--borderColor); border-radius: 4px; color: var(--fontColor);
}
.detail-empty { color: var(--borderColor); font-size: 12px; padding: 10px; }
/* 底部按钮栏：左＝页签操作（复制 / 编辑）+ 状态选择 + 删除，右＝关闭 */
.detail-footer-left { display: flex; align-items: center; gap: 5px; flex: 1; min-width: 0; }
/* 停止本行：橙色文字提示这是个「中断」动作（与红色删除区分） */
.modal-btn-stop { color: #FF9800; flex: none; }
.modal-btn-stop:hover { background: var(--menuActiveColor); }
/* 状态下拉（输入元素）：与按钮同高；不靠颜色区分状态，名称与说明走选项文字 / title
   必须显式盖掉全局 select{width:calc(100% - 10px);height:31px;margin:5px} */
.detail-status-select {
  box-sizing: border-box;
  width: auto;
  min-width: 92px;
  height: 24px;
  margin: 0;
  padding: 0 6px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid var(--borderColor);
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
}
.detail-status-select:disabled { opacity: 0.6; cursor: not-allowed; }
.detail-status-select option { background: var(--backgroundColor); color: var(--fontColor); }

/* ====== 跳转行高亮闪烁 ====== */
tr.jump-flash { animation: batch-jump-flash 1.6s ease-out; }
@keyframes batch-jump-flash {
  0%, 60% { background: rgba(76, 175, 80, 0.4); }
  100% { background: transparent; }
}
</style>
