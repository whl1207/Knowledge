/**
 * 托盘（用户界面里的「托管区」）服务
 * ---------------------------------------------------------------------------
 * 1. 关闭按钮行为（设置 → 基础 → 界面 → 关闭按钮行为）：
 *    · 直接退出：点关闭即退出软件（默认，与旧版一致）
 *    · 折叠到托管区：拦截窗口关闭 → 只隐藏主窗口，后台任务（智能体 / 工作流 / 采集…）继续运行
 * 2. 托盘图标：悬停显示「后台任务数 + 每个任务的进度」，右键菜单列出任务与「显示主窗口 / 退出」。
 *    任务数据由渲染层汇总后经 `tray:status` 上报（渲染层是任务状态的唯一汇总方，
 *    见 src/App.vue 的 trayTasks），主进程只负责展示。
 * 3. 关闭行为持久化到 `userData/app-behavior.json`（与 window-zoom.json 同思路：
 *    主进程是唯一事实源，渲染层设置页通过 IPC 读写）。
 *
 * ⚠️ 不能在模块顶层读盘：本模块被 index.ts 导入，而 dev 专用的
 *    `app.setPath('userData', …-dev)` 写在 index.ts 模块体里，导入求值早于它。
 *    因此延迟到 init()（app ready 之后）。
 */
import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, webContents } from 'electron'
import type { NativeImage, MenuItemConstructorOptions } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildTrayTooltip, trayItemLine, type TrayTaskItem } from './tray-tooltip'

/** 单个后台任务的展示信息（渲染层汇总后上报；实现见 tray-tooltip.ts） */
export type { TrayTaskItem }

export interface TrayStatusPayload {
  items?: TrayTaskItem[]
  /** 当前界面语言：zh / en（决定托盘提示与菜单文案） */
  locale?: string
}

/** 关闭行为配置文件（与 window-zoom.json 同目录） */
const BEHAVIOR_FILE = 'app-behavior.json'

class TrayService {
  private tray: Tray | null = null
  private iconPath = ''
  private getMainWindow: (() => BrowserWindow | null) | null = null
  /** 托盘菜单「设置…」回调（由 index.ts 注入：打开/聚焦设置独立窗口） */
  private openSettingsCb: ((nav?: string) => void) | null = null
  /** 关闭按钮行为：true = 折叠到托管区（托盘），false = 直接退出 */
  private closeToTray = false
  private loaded = false
  /** 正在退出应用（before-quit / 托盘菜单退出）：此时不再拦截窗口关闭 */
  private quitting = false
  /**
   * 各窗口上报的后台任务（悬停提示与菜单的数据源）。
   * ⚠ 必须按**上报窗口**分开存：主窗口与各文件窗口各有独立的渲染进程与任务登记表，
   *    若只存最后一份（旧实现），多窗口同时有任务时提示会在两份列表之间来回跳动。
   *    key = webContents id（窗口销毁后由 updateStatus/refresh 清理）。
   */
  private statusByWindow = new Map<number, { items: TrayTaskItem[]; label: string }>()
  private locale = 'zh'
  /** 是否已提示过「已折叠到托管区」（只在首次折叠时提示，避免每次关窗都弹） */
  private hiddenToastShown = false

  /** 应用就绪后调用一次：读取配置 + 注册 IPC（托盘本身随主窗口创建） */
  init(opts: {
    iconPath: string
    getMainWindow: () => BrowserWindow | null
    /** 右键菜单「设置…」：打开 / 聚焦设置窗口（nav 为设置分类，默认 view=基础） */
    openSettings?: (nav?: string) => void
  }): void {
    this.iconPath = opts.iconPath
    this.getMainWindow = opts.getMainWindow
    this.openSettingsCb = opts.openSettings || null
    this.load()

    ipcMain.handle('app-behavior:get', () => ({ closeToTray: this.closeToTray }))

    ipcMain.handle('app-behavior:set', (_e, payload?: { closeToTray?: boolean }) => {
      this.setCloseToTray(!!payload?.closeToTray)
      // 返回实际生效值：托盘不可用时会被回退为 false，渲染层据此提示并回写设置
      return { closeToTray: this.closeToTray }
    })

    // 渲染层上报后台任务摘要（高频，用 send；主进程按窗口汇总后展示）
    ipcMain.on('tray:status', (event, payload?: TrayStatusPayload) => this.updateStatus(event.sender.id, payload))

    ipcMain.handle('tray:show-window', () => {
      this.showMainWindow()
      return { ok: true }
    })
  }

  // ==================== 关闭行为 ====================

  private behaviorFilePath(): string {
    return path.join(app.getPath('userData'), BEHAVIOR_FILE)
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const file = this.behaviorFilePath()
      if (fs.existsSync(file)) {
        const cfg = JSON.parse(fs.readFileSync(file, { encoding: 'utf8' }))
        this.closeToTray = cfg?.closeToTray === true
      }
    } catch (e) {
      console.warn('[tray] 读取关闭行为配置失败:', e)
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(
        this.behaviorFilePath(),
        JSON.stringify({ closeToTray: this.closeToTray }, null, 2),
        'utf8',
      )
    } catch (e) {
      console.warn('[tray] 保存关闭行为配置失败:', e)
    }
  }

  /** 当前是否「折叠到托管区」（给渲染层查询用） */
  isCloseToTray(): boolean {
    this.load()
    return this.closeToTray
  }

  /** 设置关闭行为并立即落盘（托盘随之创建 / 销毁） */
  setCloseToTray(on: boolean): void {
    this.load()
    this.closeToTray = on
    if (!on) {
      this.save()
      this.destroyTray()
      return
    }
    // 开启时立刻建托盘：即使还没关过窗口，也能看到托盘图标与任务提示
    if (!this.createTray()) {
      // 托盘不可用（个别 Linux 桌面环境）→ 回退为直接退出，避免关窗后窗口「消失且唤不回」
      console.warn('[tray] 托盘不可用，关闭行为回退为直接退出')
      this.closeToTray = false
      this.save()
      return
    }
    this.save()
    this.refresh()
  }

  // ==================== 托盘 ====================

  /** 主窗口创建时调用：按当前设置准备托盘 */
  ensureTray(): void {
    this.load()
    if (this.closeToTray) this.createTray()
  }

  /**
   * 窗口关闭事件里调用：返回 true 表示本次关闭应被拦截（改为隐藏到托盘）。
   * 直接退出模式 / 正在退出 / 托盘不可用 → 返回 false（正常关闭）。
   */
  shouldHideOnClose(): boolean {
    this.load()
    if (!this.closeToTray || this.quitting) return false
    if (!this.tray && !this.createTray()) return false
    return true
  }

  /** 折叠到托管区：隐藏主窗口（不销毁，后台任务继续运行） */
  hideMainWindow(win: BrowserWindow): void {
    try {
      win.hide()
    } catch (e) {
      console.warn('[tray] 隐藏主窗口失败:', e)
    }
    this.notifyHidden()
  }

  /**
   * 文件（子）窗口关闭时调用：该窗口还有后台任务、且已开启「折叠到托管区」→ 拦截关闭改为隐藏。
   * 任务继续在后台跑，托盘右键菜单里点对应任务（或「隐藏的窗口」里的条目）即可唤回该窗口。
   * 没有后台任务时返回 false（正常关闭并销毁），避免窗口「消失且唤不回」。
   */
  shouldHideFileWindowOnClose(win: BrowserWindow): boolean {
    this.load()
    if (!this.closeToTray || this.quitting) return false
    if (!this.hasRunningTasks(win)) return false
    if (!this.tray && !this.createTray()) return false
    return true
  }

  /** 该窗口是否有上报中的后台任务 */
  hasRunningTasks(win: BrowserWindow): boolean {
    if (!win || win.isDestroyed()) return false
    const id = win.webContents?.id
    return id != null && (this.statusByWindow.get(id)?.items.length || 0) > 0
  }

  /** 隐藏子窗口并给出「已折叠到托管区」提示（托盘可唤回） */
  hideChildWindow(win: BrowserWindow): void {
    try {
      win.hide()
    } catch (e) {
      console.warn('[tray] 隐藏子窗口失败:', e)
    }
    this.notifyHidden()
  }

  /** 应用进入退出流程（before-quit / 托盘菜单退出）——此后不再拦截窗口关闭 */
  markQuitting(): void {
    this.quitting = true
  }

  private quitApp(): void {
    this.quitting = true
    app.quit()
  }

  /** 显示并聚焦主窗口（托盘单击 / 菜单「显示主窗口」） */
  showMainWindow(): void {
    const win = this.getMainWindow?.() || null
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
  }

  /** 托盘单击：已在前台 → 折叠；否则唤回窗口 */
  private toggleMainWindow(): void {
    const win = this.getMainWindow?.() || null
    if (!win || win.isDestroyed()) return
    if (win.isVisible() && !win.isMinimized() && win.isFocused()) {
      this.hideMainWindow(win)
      return
    }
    this.showMainWindow()
  }

  /** 右键菜单「设置…」：定位到「基础」（关闭按钮行为就在这里） */
  private openSettings(): void {
    try {
      this.openSettingsCb?.('view')
    } catch (e) {
      console.warn('[tray] 打开设置窗口失败:', e)
    }
  }

  private trayImage(): NativeImage {
    try {
      const img = nativeImage.createFromPath(this.iconPath)
      if (img.isEmpty()) return nativeImage.createEmpty()
      // Windows 通知区域按 16px 显示：先缩放可避免系统二次缩放导致的模糊
      return process.platform === 'win32' ? img.resize({ width: 16, height: 16 }) : img
    } catch (e) {
      console.warn('[tray] 读取托盘图标失败:', e)
      return nativeImage.createEmpty()
    }
  }

  /** 创建托盘；返回是否成功（失败时调用方回退为「直接退出」） */
  private createTray(): boolean {
    if (this.tray) return true
    try {
      const tray = new Tray(this.trayImage())
      tray.setToolTip(this.tooltipText())
      tray.setContextMenu(this.buildMenu())
      // macOS 上设置 context menu 后左键会直接弹菜单，故不注册 click
      if (process.platform !== 'darwin') {
        tray.on('click', () => this.toggleMainWindow())
        tray.on('double-click', () => this.showMainWindow())
      }
      this.tray = tray
      return true
    } catch (e) {
      console.warn('[tray] 创建托盘失败（回退为直接退出）:', e)
      this.tray = null
      return false
    }
  }

  destroyTray(): void {
    if (!this.tray) return
    try {
      this.tray.destroy()
    } catch { /* 忽略销毁异常 */ }
    this.tray = null
  }

  private refresh(): void {
    if (!this.tray) return
    try {
      this.tray.setToolTip(this.tooltipText())
      this.tray.setContextMenu(this.buildMenu())
    } catch (e) {
      console.warn('[tray] 刷新托盘失败:', e)
    }
  }

  /** 悬停提示：任务数 + 每个任务的进度 / 预计剩余时间（控制在系统提示长度上限内） */
  private tooltipText(): string {
    return buildTrayTooltip(this.allItems(), this.locale)
  }

  /** 所有窗口上报的任务（按窗口登记顺序合并） */
  private allItems(): TrayTaskItem[] {
    const out: TrayTaskItem[] = []
    for (const g of this.statusByWindow.values()) out.push(...g.items)
    return out
  }

  /** 唤回并聚焦某个窗口（托盘菜单点任务条目）；窗口已不在时退回主窗口 */
  private focusWindow(senderId: number): void {
    const wc = webContents.fromId(senderId)
    const win = wc ? BrowserWindow.fromWebContents(wc) : null
    if (win && !win.isDestroyed()) {
      this.showWindow(win)
      return
    }
    this.showMainWindow()
  }

  private showWindow(win: BrowserWindow): void {
    try {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    } catch (e) {
      console.warn('[tray] 唤回窗口失败:', e)
    }
  }

  /** 已隐藏的窗口（折叠到托管区的子窗口 / 独立窗口）：主窗口另有「显示主窗口」条目 */
  private listHiddenWindows(): { win: BrowserWindow; title: string }[] {
    const main = this.getMainWindow?.() || null
    const out: { win: BrowserWindow; title: string }[] = []
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w === main || w.isVisible()) continue
      const title = String(w.getTitle() || '').trim()
      if (title) out.push({ win: w, title })
    }
    return out
  }

  /** 右键菜单（系统原生菜单）：显示窗口 / 设置 / 后台任务（可点击唤回所属窗口）/ 隐藏的窗口 / 退出 */
  private buildMenu(): Menu {
    const zh = this.locale !== 'en'
    const template: MenuItemConstructorOptions[] = [
      { label: zh ? '显示主窗口' : 'Show Main Window', click: () => this.showMainWindow() },
      { label: zh ? '设置…' : 'Settings…', click: () => this.openSettings() },
    ]
    const groups = [...this.statusByWindow.entries()].filter(([, g]) => g.items.length > 0)
    const total = groups.reduce((n, [, g]) => n + g.items.length, 0)
    if (total) {
      template.push({ type: 'separator' })
      template.push({
        label: zh ? `后台任务（${total}）` : `Background tasks (${total})`,
        enabled: false,
      })
      // 多窗口同时有任务时按窗口分组（组标题=窗口标题），点击任务即唤回它所在的窗口
      const grouped = groups.length > 1
      for (const [senderId, g] of groups) {
        if (grouped) template.push({ label: ` ${g.label}`, enabled: false })
        for (const it of g.items.slice(0, 12)) {
          template.push({
            label: `${grouped ? '   ' : ' '}${trayItemLine(it)}`,
            click: () => this.focusWindow(senderId),
          })
        }
      }
    }
    const hidden = this.listHiddenWindows()
    if (hidden.length) {
      template.push({ type: 'separator' })
      template.push({ label: zh ? '隐藏的窗口' : 'Hidden windows', enabled: false })
      for (const h of hidden) {
        template.push({ label: ` ${h.title}`, click: () => this.showWindow(h.win) })
      }
    }
    template.push({ type: 'separator' })
    template.push({ label: zh ? '退出 AI-KM' : 'Quit AI-KM', click: () => this.quitApp() })
    return Menu.buildFromTemplate(template)
  }

  /** 首次折叠到托管区时的气泡提示（仅 Windows） */
  private notifyHidden(): void {
    if (this.hiddenToastShown) return
    this.hiddenToastShown = true
    if (process.platform !== 'win32' || !this.tray) return
    const zh = this.locale !== 'en'
    const n = this.allItems().length
    try {
      this.tray.displayBalloon({
        title: zh ? 'AI-KM 已折叠到托管区' : 'AI-KM is in the tray',
        content: n
          ? (zh
            ? `仍有 ${n} 个任务在后台运行；点击（或双击）托盘图标可重新打开窗口。`
            : `${n} task(s) still running; click the tray icon to reopen the window.`)
          : (zh ? '点击（或双击）托盘图标可重新打开窗口。' : 'Click the tray icon to reopen the window.'),
      })
    } catch { /* 个别系统不支持气泡提示，忽略 */ }
  }

  // ==================== 状态上报 ====================

  /**
   * 渲染层上报：按上报窗口分别记录（见 statusByWindow 注释）。
   * 空列表 = 该窗口已无后台任务 → 删除登记（窗口关闭拦截也随之失效）。
   */
  updateStatus(senderId: number, payload?: TrayStatusPayload): void {
    const raw = Array.isArray(payload?.items) ? payload!.items! : []
    const items = raw
      .filter((it) => !!it && typeof it.name === 'string' && it.name.trim() !== '')
      .slice(0, 12)
      .map((it) => ({
        name: String(it.name).slice(0, 40),
        detail: it.detail ? String(it.detail).slice(0, 32) : undefined,
      }))
    if (items.length) {
      // 分组标题用窗口自身标题（文件窗口是「文件名 - 视图」，主窗口是软件标题）
      const wc = webContents.fromId(senderId)
      const win = wc ? BrowserWindow.fromWebContents(wc) : null
      const label = String(win?.getTitle() || '').trim()
      this.statusByWindow.set(senderId, { items, label: label || (this.locale === 'en' ? 'Window' : '窗口') })
    } else {
      this.statusByWindow.delete(senderId)
    }
    if (payload?.locale === 'zh' || payload?.locale === 'en') this.locale = payload.locale
    this.refresh()
  }

  /** 窗口销毁后清掉它的登记（避免托盘里残留已关闭窗口的任务） */
  forgetWindow(senderId: number): void {
    if (!this.statusByWindow.delete(senderId)) return
    this.refresh()
  }
}

export const trayService = new TrayService()
