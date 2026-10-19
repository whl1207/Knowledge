<!-- ImageGenSettings.vue - 生图设置（Qwen-Image-Edit-2511 本地 Gradio 应用，默认 7861）
     样式与 AsrSettings / TtsSettings 同一套：input 与 select 同高（33px）、说明文字另起一行并与输入框左对齐 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'
import { aikmIpcAvailable } from '@/lib/aikmIpc'
import { getPlatform } from '@/platform'
import {
  qwenImageGenerate,
  qwenImageInfo,
  paramDefault,
  paramEnum,
  type QwenImageConfig,
  type QwenImageDefaults,
} from '@/services/image/qwenImage'

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const cfg = computed<any>(() => store.AIconfig.image || {})

// 服务端信息（版本 / 参数枚举）：测试连接或生成时拉一次，用于填充下拉选项
const serverInfo = ref<QwenImageDefaults | null>(null)
const testing = ref(false)
const testMessage = ref('')

const modelOptions = computed<string[]>(() => {
  const fromServer = serverInfo.value ? paramEnum(serverInfo.value, 'model_type') : []
  const list = fromServer.length ? fromServer : ['Qwen(本地免费)', 'Banana2(收费)']
  return list.map(m => m)
})

const loraOptions = computed<string[]>(() => {
  const fromServer = serverInfo.value ? paramEnum(serverInfo.value, 'm1_lora_1') : []
  const list = ['None', ...fromServer.filter(v => v !== 'None')]
  return [...new Set(list)]
})

// ================== 试生图 ==================
const prompt = ref('')
const pickedFiles = ref<File[]>([])
const pickedPreviews = ref<string[]>([])
const generating = ref(false)
const genLog = ref('')
const genError = ref('')
const genStage = ref('')
const results = ref<Array<{ url: string; path?: string }>>([])
let abortCtl: AbortController | null = null

function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const list = Array.from(input.files || []).slice(0, 3)
  clearPreviews()
  pickedFiles.value = list
  pickedPreviews.value = list.map(f => URL.createObjectURL(f))
  input.value = ''
}

function clearPreviews() {
  for (const u of pickedPreviews.value) {
    try { URL.revokeObjectURL(u) } catch { /* ignore */ }
  }
  pickedPreviews.value = []
}

function removeFile(i: number) {
  const url = pickedPreviews.value[i]
  if (url) { try { URL.revokeObjectURL(url) } catch { /* ignore */ } }
  pickedPreviews.value.splice(i, 1)
  pickedFiles.value.splice(i, 1)
}

function buildConfig(): QwenImageConfig {
  const c = cfg.value
  return {
    base: String(c.url || '').trim(),
    modelType: c.modelType,
    width: c.width,
    height: c.height,
    steps: c.steps,
    negative: c.negative,
    lora1: c.lora1,
    lora2: c.lora2,
    lora3: 'None',
    lora4: 'None',
    token: c.token,
    horizontal: c.horizontal,
    vertical: c.vertical,
    distance: c.distance,
    refineText: '开启',
  }
}

async function generate() {
  const text = prompt.value.trim()
  if (!text) {
    ElMessage.warning(zh.value ? '请输入提示词' : 'Please enter a prompt')
    return
  }
  if (generating.value) return
  generating.value = true
  genError.value = ''
  genLog.value = ''
  genStage.value = zh.value ? '正在提交任务…' : 'Submitting…'
  results.value = []
  abortCtl = new AbortController()
  try {
    const res = await qwenImageGenerate(buildConfig(), {
      prompt: text,
      images: pickedFiles.value,
      fileNames: pickedFiles.value.map(f => f.name),
      onLog: (line) => {
        genLog.value = (genLog.value ? genLog.value + '\n' : '') + line
        if (genLog.value.length > 6000) genLog.value = genLog.value.slice(-6000)
      },
      onQueue: (n) => { genStage.value = zh.value ? `排队 ${n} 个任务` : `Queue: ${n}` },
      signal: abortCtl.signal,
      maxWaitMs: 8 * 60_000,
    })
    results.value = res.images
    genStage.value = zh.value ? '生成完成' : 'Done'
    store.updateImageConfig({ lastPrompt: text })
    if (!serverInfo.value) void loadInfo(true)
  } catch (e: any) {
    genError.value = e?.message || String(e)
    genStage.value = zh.value ? '生成失败' : 'Failed'
  } finally {
    generating.value = false
    abortCtl = null
  }
}

function cancelGenerate() {
  try { abortCtl?.abort() } catch { /* ignore */ }
  genStage.value = zh.value ? '已取消' : 'Cancelled'
}

// ================== 服务 ==================
async function loadInfo(silent = true) {
  try {
    serverInfo.value = await qwenImageInfo(cfg.value.url || '')
    return true
  } catch (e: any) {
    if (!silent) ElMessage.error(e?.message || String(e))
    return false
  }
}

async function testConnection() {
  if (testing.value) return
  testing.value = true
  try {
    const res = await store.testImageService()
    testMessage.value = res.message
    if (res.success) {
      ElMessage.success(res.message)
      void loadInfo(true)
      // 服务端默认 token 回填（不覆盖用户已填的值）
      if (serverInfo.value && !cfg.value.token) {
        const t = paramDefault(serverInfo.value, 'token', '')
        if (t) store.updateImageConfig({ token: t })
      }
    } else {
      ElMessage.error(res.message)
    }
  } finally {
    testing.value = false
  }
}

// ================== 本地服务（安装目录 / 启动停止） ==================
// Qwen-Image-Edit-2511 也是独立安装的 Python 程序（app.py + py312 + 内置 ComfyUI）。
// 桌面端按「安装目录」拉起它，等价于手动双击它目录里的启动 bat，不用再开 cmd。
const serviceBusy = ref(false)
const serviceHint = ref('')
const serviceLog = ref('')
const serviceRunning = computed(() => !!store.AIconfig.image?.serviceRunning)

const installDir = computed({
  get: () => String(store.AIconfig.image?.installDir || ''),
  set: (v: string) => { store.AIconfig.image.installDir = v },
})
const autoStart = computed({
  get: () => !!store.AIconfig.image?.autoStart,
  set: (v: boolean) => store.updateImageConfig({ autoStart: v }),
})

async function pickInstallDir() {
  try {
    if (!aikmIpcAvailable()) {
      ElMessage.warning(zh.value ? '仅在桌面应用中可用' : 'Only available in the desktop app')
      return
    }
    const dir = await getPlatform().dialog.pickDirectory()
    if (!dir) return
    installDir.value = dir
    store.saveConfig()
    await store.refreshPythonAppStatus('qwenImage')
  } catch (e: any) {
    ElMessage.error((zh.value ? '选择目录失败: ' : 'Select folder failed: ') + (e?.message || e))
  }
}

// 启动后轮询：进程还活着 + 端口能应答（/config + /info），ComfyUI 起来后才算就绪
async function waitImageReady(maxMs = 240000) {
  const started = Date.now()
  while (Date.now() - started < maxMs) {
    const st: any = await store.refreshPythonAppStatus('qwenImage')
    if (st && !st.running && st.lastExit) {
      serviceLog.value = st.logTail || ''
      serviceHint.value = zh.value
        ? `服务进程已退出（code ${st.lastExit.code ?? '-'}），详见下方日志`
        : `Service exited (code ${st.lastExit.code ?? '-'}); see logs below`
      return
    }
    try {
      await qwenImageInfo(cfg.value.url || '', true)
      serverInfo.value = await qwenImageInfo(cfg.value.url || '')
      serviceHint.value = zh.value ? '服务就绪（生图接口可用）' : 'Ready'
      serviceLog.value = ''
      testMessage.value = zh.value
        ? `已连接 · Gradio ${store.AIconfig.image.version || serverInfo.value?.version || '?'}`
        : `Connected · Gradio ${store.AIconfig.image.version || serverInfo.value?.version || '?'}`
      store.updateImageConfig({ connected: true, version: serverInfo.value?.version || '' })
      return
    } catch {
      serviceHint.value = zh.value
        ? '正在启动（等待内置 ComfyUI 就绪，首次可能要 1~3 分钟）…'
        : 'Starting (waiting for the bundled ComfyUI)…'
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  const st: any = await store.refreshPythonAppStatus('qwenImage')
  serviceLog.value = st?.logTail || ''
  serviceHint.value = zh.value
    ? '等待超时：服务可能还在启动，稍后点「测试连接」再试'
    : 'Timed out: the service may still be starting; try "Test connection" later'
}

async function startService() {
  if (serviceBusy.value) return
  serviceBusy.value = true
  serviceLog.value = ''
  serviceHint.value = zh.value ? '正在启动服务…' : 'Starting service…'
  try {
    const res = await store.startPythonAppService('qwenImage', false)
    serviceHint.value = res.message
    if (res.success) await waitImageReady()
    else {
      const st: any = await store.refreshPythonAppStatus('qwenImage')
      serviceLog.value = st?.logTail || ''
    }
  } finally {
    serviceBusy.value = false
  }
}

async function stopService() {
  if (serviceBusy.value) return
  serviceBusy.value = true
  try {
    const res = await store.stopPythonAppService('qwenImage', false)
    serviceHint.value = res.message
    serviceLog.value = ''
  } finally {
    serviceBusy.value = false
  }
}

onMounted(() => {
  if (cfg.value.url) void loadInfo(true)
  void store.refreshPythonAppStatus('qwenImage')
  testMessage.value = cfg.value.connected
    ? (zh.value ? `已连接 · Gradio ${cfg.value.version || '?'}` : `Connected · Gradio ${cfg.value.version || '?'}`)
    : ''
})

onUnmounted(() => {
  clearPreviews()
  try { abortCtl?.abort() } catch { /* ignore */ }
})
</script>

<template>
  <div class="settings-group">
    <h3>{{ zh ? '生图设置' : 'Image Generation' }}</h3>

    <div class="form-group">
      <label>{{ zh ? '服务地址' : 'Service URL' }}</label>
      <input v-model="store.AIconfig.image.url" @change="store.saveConfig"
             placeholder="http://127.0.0.1:7861"
             :title="zh ? 'Qwen-Image-Edit-2511 的 Gradio 地址（带 py312 / ComfyUI 的那套应用）' : 'Gradio URL of the Qwen-Image-Edit-2511 app'"/>
    </div>
    <div class="form-group">
      <label>{{ zh ? '连接' : 'Connection' }}</label>
      <div class="button-group">
        <div class="button" :class="{ active: cfg.connected, disabled: testing }" @click="testConnection">
          <i :class="testing ? 'fa fa-spinner fa-spin' : 'fa fa-plug'"></i>
          {{ zh ? '测试连接' : 'Test connection' }}
        </div>
      </div>
    </div>
    <div v-if="testMessage" class="form-group">
      <label></label>
      <div class="config-description">{{ testMessage }}</div>
    </div>

    <!-- 本地服务：安装目录 + 启动/停止（等价于手动双击该目录里的启动 bat） -->
    <div class="form-group">
      <label>{{ zh ? '安装目录' : 'Install folder' }}</label>
      <div class="input-with-button">
        <input v-model="installDir" @change="store.saveConfig"
               placeholder="D:\AI\Qwen-Image-Edit-2511"
               :title="zh ? 'Qwen-Image-Edit-2511 的根目录（含 py312、app.py 与 ComfyUI）' : 'Root folder of Qwen-Image-Edit-2511'"/>
        <div class="button" @click="pickInstallDir" :title="zh ? '选择文件夹' : 'Select folder'">
          <i class="fa fa-folder-open"></i>
        </div>
      </div>
    </div>
    <div class="form-group">
      <label>{{ zh ? '本地服务' : 'Local service' }}</label>
      <div class="button-group">
        <div class="button" :class="{ active: serviceRunning, disabled: serviceBusy }" @click="startService"
             :title="zh ? '按上面的安装目录启动生图服务（不用再开 cmd）' : 'Start the image service from the folder above'">
          <i :class="serviceBusy ? 'fa fa-spinner fa-spin' : 'fa fa-play'"></i>
          {{ zh ? '启动服务' : 'Start service' }}
        </div>
        <div class="button" :class="{ disabled: serviceBusy }" @click="stopService"
             :title="zh ? '停止本应用启动的服务' : 'Stop the service started by this app'">
          <i class="fa fa-stop"></i> {{ zh ? '停止服务' : 'Stop service' }}
        </div>
      </div>
    </div>
    <div class="form-group">
      <label></label>
      <div class="config-description">
        {{ serviceRunning
          ? (zh ? '● 服务运行中（本应用启动）' : '● Service running (started by this app)')
          : (zh ? '○ 本应用未启动服务（手动开的服务也能照常连接）' : '○ Not started by this app (an external one still works)') }}
      </div>
    </div>
    <div class="form-group">
      <label></label>
      <label class="checkbox-label">
        <input type="checkbox" v-model="autoStart" />
        <span>{{ zh ? '随软件启动自动拉起服务（首次要等 ComfyUI，较慢）' : 'Start the service with the app (ComfyUI takes a while)' }}</span>
      </label>
    </div>
    <div v-if="serviceHint || cfg.serviceError" class="form-group">
      <label></label>
      <div class="config-description" :class="{ 'gen-error': !!(cfg.serviceError && !serviceHint) }">
        {{ serviceHint || cfg.serviceError }}
      </div>
    </div>
    <div v-if="serviceLog" class="form-group log-group">
      <label></label>
      <pre class="gen-log">{{ serviceLog }}</pre>
    </div>

    <div class="form-group">
      <label>{{ zh ? '模型类型' : 'Model type' }}</label>
      <select v-model="store.AIconfig.image.modelType" @change="store.saveConfig">
        <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
      </select>
    </div>
    <div class="form-group">
      <label>{{ zh ? '尺寸' : 'Size' }}</label>
      <div class="size-row">
        <input type="number" min="256" max="4096" step="64" v-model.number="store.AIconfig.image.width" @change="store.saveConfig" />
        <span class="x">×</span>
        <input type="number" min="256" max="4096" step="64" v-model.number="store.AIconfig.image.height" @change="store.saveConfig" />
        <span class="inline-hint">{{ zh ? '宽 × 高（像素）' : 'width × height' }}</span>
      </div>
    </div>
    <div class="form-group">
      <label>{{ zh ? '迭代步数' : 'Steps' }}</label>
      <input type="number" min="1" max="60" step="1" v-model.number="store.AIconfig.image.steps" @change="store.saveConfig" />
      <span class="config-description">{{ zh ? '本地 2511 一般 4 步（Lightning）' : '4 steps is typical for the local 2511 model' }}</span>
    </div>
    <div class="form-group">
      <label>{{ zh ? '负面提示词' : 'Negative prompt' }}</label>
      <input v-model="store.AIconfig.image.negative" @change="store.saveConfig"
             :placeholder="zh ? '可留空' : 'Optional'"/>
    </div>
    <div class="form-group">
      <label>Lora 1</label>
      <select v-model="store.AIconfig.image.lora1" @change="store.saveConfig">
        <option v-for="l in loraOptions" :key="l" :value="l">{{ l }}</option>
      </select>
    </div>
    <div class="form-group">
      <label>Lora 2</label>
      <select v-model="store.AIconfig.image.lora2" @change="store.saveConfig">
        <option v-for="l in loraOptions" :key="l" :value="l">{{ l }}</option>
      </select>
    </div>
    <div class="form-group">
      <label>{{ zh ? 'API Token' : 'API token' }}</label>
      <input v-model="store.AIconfig.image.token" @change="store.saveConfig" type="password"
             :placeholder="zh ? '留空 = 用服务端保存的 token' : 'Empty = use the token saved on the server'"/>
    </div>

    <!-- 试生图：不接图片就是文生图，接了 1~3 张就是图生图 / 编辑 -->
    <div class="form-group divider-row"><label></label><div class="divider"></div></div>
    <div class="form-group">
      <label>{{ zh ? '提示词' : 'Prompt' }}</label>
      <textarea v-model="prompt" class="gen-prompt scoll" rows="3"
                :placeholder="zh ? '支持中文，例如：把背景换成海边日落' : 'e.g. change the background to a sunset beach'"></textarea>
    </div>
    <div class="form-group">
      <label>{{ zh ? '参考图' : 'Reference' }}</label>
      <div class="ref-row">
        <label class="file-btn">
          <input type="file" accept="image/*" multiple @change="onPickFiles" />
          <i class="fa fa-image"></i> {{ zh ? '选择图片（0~3 张）' : 'Pick images (0-3)' }}
        </label>
        <div class="ref-thumbs" v-if="pickedPreviews.length">
          <div class="thumb" v-for="(u, i) in pickedPreviews" :key="u">
            <img :src="u" alt="" />
            <span class="thumb-x" @click="removeFile(i)" :title="zh ? '移除' : 'Remove'">×</span>
          </div>
        </div>
      </div>
    </div>
    <div class="form-group">
      <label>{{ zh ? '生成' : 'Generate' }}</label>
      <div class="button-group">
        <div class="button" :class="{ active: generating, disabled: generating }" @click="generate">
          <i :class="generating ? 'fa fa-spinner fa-spin' : 'fa fa-magic'"></i>
          {{ generating ? (zh ? '生成中…' : 'Generating…') : (zh ? '生成图片' : 'Generate') }}
        </div>
        <div class="button" :class="{ disabled: !generating }" @click="cancelGenerate">
          <i class="fa fa-stop"></i> {{ zh ? '取消' : 'Cancel' }}
        </div>
      </div>
    </div>
    <div v-if="genStage || genError" class="form-group">
      <label></label>
      <div class="config-description" :class="{ 'gen-error': !!genError }">{{ genError || genStage }}</div>
    </div>
    <div v-if="genLog" class="form-group log-group">
      <label></label>
      <pre class="gen-log">{{ genLog }}</pre>
    </div>
    <div v-if="results.length" class="form-group result-group">
      <label>{{ zh ? '结果' : 'Result' }}</label>
      <div class="gen-results">
        <a v-for="img in results" :key="img.url" :href="img.url" target="_blank" rel="noopener" class="gen-result">
          <img :src="img.url" alt="generated" />
        </a>
      </div>
    </div>

    <div class="form-group">
      <label></label>
      <div class="config-description usage-guide">
        {{ zh
          ? '本页调用 Qwen-Image-Edit-2511 那套本地 Gradio 应用（默认 7861）：不加参考图 = 文生图，加 1~3 张 = 图生图 / 编辑。生成任务走服务端队列，通常 1~2 分钟一张；「模型类型」里的 Qwen(本地免费) 走本地 2511，Banana2(收费) 走云端。'
          : 'This page drives the local Qwen-Image-Edit-2511 Gradio app (default port 7861): no reference image = text-to-image, 1-3 images = edit. Tasks run through the server queue and usually take 1-2 minutes; Qwen(本地免费) uses the local 2511 model, Banana2(收费) the cloud one.' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 样式与 Set.vue / AsrSettings.vue 一致（拆分后由本组件自持，不依赖父级 scoped 样式） */
.settings-group {
  margin-bottom: 5px;
  padding: 8px;
}

.settings-group:last-child {
  margin-bottom: 0;
}

.settings-group h3 {
  position: relative;
  color: var(--fontActiveColor);
  margin: 0 0 10px 0;
  padding: 0 0 8px 10px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 14px;
  font-weight: 600;
}

.settings-group h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}

/* 表单组样式：与 ASR 页一致（flex-wrap 让说明文字可以另起一行） */
.form-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 5px;
}

/* 统一清零 form-group 内元素的 margin（防止全局样式污染导致行高超出） */
.form-group > * {
  margin: 0;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-group label {
  width: 120px;
  min-width: 120px;
  color: var(--fontColor);
  font-size: 14px;
  user-select: none;
  line-height: 1;
  flex-shrink: 0;
}

.form-group input:not([type="checkbox"]):not([type="file"]),
.form-group textarea {
  flex: 1;
  padding: 2px 4px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  font-size: 14px;
  transition: border-color 0.2s ease;
  margin: 0px;
}
/* 下拉框用正常背景色（不用菜单底色）；高度沿用全局 select（31px），与 input(27px+padding) 等高 */
.form-group select {
  background-color: var(--backgroundColor);
}

.form-group input:focus,
.form-group select:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--fontActiveColor);
}

.form-group input[type="checkbox"] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-right: 10px;
}

.form-group input[type="password"] {
  letter-spacing: 1px;
}

/* 提示词输入框：可纵向拉伸 */
.form-group textarea.gen-prompt {
  resize: vertical;
  min-height: 56px;
  line-height: 1.5;
  font-family: inherit;
}

/* 配置描述文本：位于输入元素下方一行（与 ASR 页一致，缩进到输入框正下方） */
.config-description {
  flex-basis: 100%;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.7;
  margin: 0;
  padding-left: 135px;
  box-sizing: border-box;
}

/* 行内小提示（跟在输入框右侧） */
.inline-hint {
  flex: 1 1 auto;
  min-width: 0;
  margin-left: 8px;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.7;
  line-height: 1.4;
}

/* 底部使用方法说明：全宽显示 */
.config-description.usage-guide {
  padding-left: 0;
  margin-top: 10px;
  padding-top: 6px;
  border-top: 1px dashed var(--borderColor);
  line-height: 1.6;
}

.config-description.gen-error {
  opacity: 1;
  color: #e6a23c;
  font-size: 11px;
  line-height: 1.5;
  word-break: break-all;
}

/* 带按钮的输入框 */
.input-with-button {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
  gap: 5px;
}
.input-with-button > input,
.input-with-button > select {
  flex: 1;
  min-width: 0;
  margin: 0;
}
.input-with-button > .button {
  flex-shrink: 0;
  height: auto;
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 0 6px;
  margin: 0;
  width: auto;
}

.button {
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 14px;
  white-space: nowrap;
  width: calc(100% - 20px);
  margin: 0px;
  padding: 6px 6px;
}

.button:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.button.active {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}

.button.disabled {
  opacity: 0.6;
  cursor: default;
}

.button i {
  font-size: 14px;
}

/* 按钮组样式 */
.button-group {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}
.button-group .button {
  width: calc(100% - 14px);
}

/* 复选框 + 说明一行（随软件启动）：注意 .form-group label 的 120px 宽要在这里放开 */
.checkbox-label,
.form-group .checkbox-label {
  flex: 1;
  width: auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 14px;
  color: var(--fontColor);
}
.checkbox-label input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  flex: 0 0 auto;
}

/* 尺寸：两个数字框 + × */
.size-row {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.size-row input {
  flex: 0 0 96px;
  width: 96px;
  margin: 0;
}
.size-row .x {
  opacity: 0.6;
}

/* 分隔线（配置区 / 试生图 之间） */
.divider-row .divider {
  flex: 1;
  height: 1px;
  background: var(--borderColor);
  opacity: 0.6;
}

/* 参考图选择 + 缩略图 */
.ref-row {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.file-btn,
.form-group .file-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 33px;
  box-sizing: border-box;
  padding: 0 12px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--menuColor);
  color: var(--fontColor);
  font-size: 14px;
  cursor: pointer;
  white-space: nowrap;
  flex: 0 0 auto;
  width: auto;
  min-width: 0;
}
.file-btn:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.file-btn input[type="file"] {
  display: none;
}
.ref-thumbs {
  display: flex;
  align-items: center;
  gap: 6px;
}
.thumb {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--borderColor);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb-x {
  position: absolute;
  right: 0;
  top: 0;
  width: 14px;
  height: 14px;
  line-height: 13px;
  text-align: center;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}

/* 日志 / 结果区：顶部对齐 */
.form-group.log-group,
.form-group.result-group {
  align-items: flex-start;
}
.gen-log {
  flex: 1;
  min-width: 0;
  max-height: 130px;
  overflow: auto;
  margin: 0;
  padding: 6px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--menuColor);
  color: var(--fontColor);
  font-size: 10px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
  opacity: 0.85;
}
.gen-results {
  flex: 1;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.gen-result {
  display: block;
  width: 220px;
  max-width: 100%;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  overflow: hidden;
  background: var(--menuColor);
}
.gen-result img {
  display: block;
  width: 100%;
  height: auto;
}
</style>
