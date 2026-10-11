/**
 * 示例插件（主进程半边）——用于验收 P0：
 *
 * 1. 依赖驱动加载：inject 声明需要宿主服务 `tools`，服务未就绪时插件停在 pending；
 * 2. 工具注册：ctx.tool(...) 注册到 scope `plugin:hello-panel`，卸载即从注册表消失；
 * 3. 服务提供：ctx.service(...) 供其它插件注入；
 * 4. 事件订阅：ctx.on('tool/post-execute', ...)；
 * 5. 副作用与清理：ctx.effect(() => cleanup) 在卸载时自动执行（验证逆序撤销）；
 * 6. 私有存储：ctx.storage（落在 userData/plugins-data/hello-panel/storage.json）；
 * 7. 用户提示：ctx.host.notify(...)。
 *
 * 安装方式：把本目录整体复制到「设置 → 插件」里显示的插件目录（userData/plugins），
 * 宿主会自动发现（改动 package.json / 本文件会触发自动重载）。
 */

export const inject = ['tools']

export function apply(ctx) {
  ctx.log.info(`启动：config=${JSON.stringify(ctx.config)}`)

  // 1) 注册工具：agent 可按名调用；scope = plugin:hello-panel
  ctx.tool({
    name: 'hello_echo',
    description: '回显输入文本（示例插件工具，用于验证插件工具注册与撤销）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
    handler: async (input) => ({ ok: true, value: { echo: String(input?.text ?? '') } }),
  })

  // 2) 提供服务：其它插件可 inject 'helloGreeting'
  ctx.service('helloGreeting', {
    hello: (name) => `Hello, ${name}!`,
  })

  // 3) 订阅宿主事件：工具执行后审计（只关心本插件的工具）
  ctx.on('tool/post-execute', (ev) => {
    if (String(ev.name).startsWith('hello_')) {
      ctx.log.debug(`工具 ${ev.name} 执行完成：ok=${ev.result?.ok}`)
    }
  })

  // 4) 副作用 + 清理：卸载时必须停止定时器（验证 disposer 真的跑了）
  const timer = setInterval(() => ctx.log.debug('心跳：插件仍在运行'), 60_000)
  ctx.effect(() => () => {
    clearInterval(timer)
    ctx.log.info('心跳已停止（插件卸载）')
  })

  // 5) 私有存储
  void ctx.storage.set('lastStart', Date.now())

  // 6) 提示用户（主窗口弹出提示；仅在主窗口显示，避免多窗口重复）
  ctx.host.notify('示例插件已加载：工具 hello_echo 可用')
}
