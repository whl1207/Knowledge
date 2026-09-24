// 统一 Monaco 环境初始化（worker 与诊断选项）。
// 独立成模块并仅由按需异步加载的组件引用（Edit_Code / BlockCode / SkillManagement），
// 确保 Monaco 及其 worker 不进入首屏 bundle，显著加快首屏。
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

let installed = false

/** 安装 Monaco worker 环境与诊断选项（幂等，可重复调用） */
export function ensureMonacoEnvironment(): void {
  if (installed) return
  installed = true
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'typescript' || label === 'javascript') {
        return new tsWorker()
      }
      return new editorWorker()
    },
  }
  // 禁用 TypeScript 验证（减少 worker 加载开销）
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  })
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  })
}
