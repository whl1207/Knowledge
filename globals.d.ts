// Electron adds a non-standard `path` property to File objects from drag-and-drop
interface File {
  path: string
}

// 阶段一/二新增的命名空间 IPC 面（preload 暴露 window.dsh）
// 类型经 import() 按需引用，避免把本文件变成模块（保持全局 augment 语义）
interface Window {
  dsh?: {
    sessionLog: {
      list(): Promise<Array<{ id: string; events: number; lastTs: number }>>
      search(keyword: string): Promise<Array<{ id: string; snippet: string }>>
      events(requestId: string, opts?: { limit?: number; beforeSeq?: number }): Promise<import('./src/types/session-log').SessionEvent[]>
      derive(requestId: string): Promise<import('./src/types/session-log').DerivedMessage[]>
      integrity(requestId: string): Promise<import('./src/types/session-log').SessionLogIntegrity>
      append(requestId: string, type: 'tool/result' | 'user/message', event: any): Promise<{ success: boolean }>
      clearAll(): Promise<{ success: boolean }>
      clearBefore(cutoffTs?: number): Promise<{ removed: number }>
    }
    agent: {
      create(options: import('./src/types/agent').AgentOptions): Promise<{ id: string }>
      send(id: string, content: string, source?: string, images?: string[]): Promise<{ success: boolean }>
      /** 转向/引导：仅当该会话正在执行 turn 时受理；未受理时 reason='not-running' */
      steer(id: string, content: string): Promise<{ success: boolean; reason?: string }>
      inject(id: string, content: string): Promise<{ success: boolean }>
      cancel(id: string, cause?: string, keepInbox?: boolean): Promise<{ success: boolean }>
      list(): Promise<import('./src/types/agent').AgentSummary[]>
      dispose(id: string): Promise<{ success: boolean }>
      tools(agentId?: string, scope?: string): Promise<{ name: string; description: string }[]>
      state(id: string): Promise<import('./src/types/agent').AgentStateView>
      answer(id: string, askId: string, message: string): Promise<{ success: boolean }>
      /** 渲染层任务接缝：抢占执行权（agent/renderer-task 事件；agentId + taskId） */
      claimRendererTask(id: string, taskId: string): Promise<{ claimed: boolean }>
      /** 渲染层任务接缝：回传执行结果 */
      rendererResult(id: string, taskId: string, result: { ok: boolean; value?: any; error?: string }): Promise<{ success: boolean }>
      declareConcurrency(scopeId: string, concurrency: number): Promise<{ success: boolean }>
      revokeConcurrency(scopeId: string): Promise<{ success: boolean }>
      sdkDocs(scope?: string, whitelist?: string[]): Promise<string>
      onEvent(cb: (ev: import('./src/types/agent').AgentEvent) => void): () => void
    }
    skills: {
      list(roots?: string[]): Promise<any[]>
      get(name: string): Promise<any>
      refresh(): Promise<{ success: boolean }>
      onChange(cb: (info: { kind: 'added' | 'removed' | 'changed'; names: string[] }) => void): () => void
    }
    tools: {
      list(scope?: string): Promise<import('./src/types/tool').ToolRegistrySnapshot[]>
      execute(name: string, input: any, ctx?: import('./src/types/tool').ToolExecutionContext): Promise<import('./src/types/tool').ToolResult>
    }
    jobs: {
      list(): Promise<import('./electron/main/job-registry').JobInfo[]>
      get(id: string): Promise<import('./electron/main/job-registry').JobInfo | null>
      cancel(id: string, cause?: string): Promise<{ success: boolean }>
      start(kind: string, owner: string, title: string): Promise<import('./electron/main/job-registry').JobInfo>
      progress(id: string, progress: number | null, detail?: string): Promise<{ success: boolean }>
      complete(id: string, result?: any): Promise<{ success: boolean }>
      fail(id: string, error: string): Promise<{ success: boolean }>
      onEvent(cb: (ev: import('./electron/main/job-registry').JobEvent) => void): () => void
    }
    credentials: {
      list(): Promise<import('./electron/main/credentials').CredentialInfo[]>
      set(name: string, value: string): Promise<import('./electron/main/credentials').CredentialInfo>
      delete(name: string): Promise<{ success: boolean }>
      resolve(name: string): Promise<{ value: string | null }>
    }
    tts: {
      status(): Promise<{ available: boolean; version: string; error: string | null }>
      load(payload: { engine: string; modelDir: string; lang?: string }): Promise<import('./electron/main/tts-service').TtsModelInfo>
      synthesize(payload: { engine: string; modelDir: string; text: string; sid?: number; speed?: number; lang?: string }): Promise<Uint8Array>
      dispose(): Promise<{ success: boolean }>
    }
    /** 联网搜索源（设置页「工具 → 搜索」；web_search 工具按该配置分发搜索源） */
    webSearch: {
      getConfig(): Promise<import('./src/shared/webSearch').WebSearchConfig>
      setConfig(cfg: Partial<import('./src/shared/webSearch').WebSearchConfig>): Promise<import('./src/shared/webSearch').WebSearchConfig>
      test(payload?: { query?: string; config?: Partial<import('./src/shared/webSearch').WebSearchConfig>; provider?: string }): Promise<import('./src/shared/webSearch').WebSearchTestResult>
    }
    interfaceConfig: {
      save(config: Record<string, any>): Promise<{ success: boolean; path: string }>
      load(): Promise<Record<string, any> | null>
      path(): Promise<string>
    }
    collab: {
      getStatus(): Promise<import('./src/types/collab').CollabStatus>
      start(payload?: { port?: number; maxMembers?: number; permissionMode?: string; token?: string }): Promise<{ success: boolean; port?: number; error?: string }>
      stop(): Promise<{ success: boolean }>
      shareFile(
        filePath: string,
        content: string,
        options?: { token?: string; maxMembers?: number; permissionMode?: string; autoSaveSeconds?: number; kind?: import('./src/types/collab').CollabKind },
      ): Promise<import('./src/types/collab').CollabShareResult>
      closeRoom(roomId: string): Promise<{ success: boolean }>
      saveRoom(roomId: string): Promise<{ ok: boolean; error?: string }>
      onStatus(cb: (status: import('./src/types/collab').CollabStatus) => void): () => void
    }
    remoteFs: {
      start(payload?: { port?: number; rootDir?: string; token?: string }): Promise<{ success: boolean; port?: number; token?: string; error?: string }>
      stop(): Promise<{ success: boolean }>
      getStatus(): Promise<{ running: boolean; port: number; ips: string[]; rootDir: string; token: string; name: string }>
      onStatus(cb: (status: { running: boolean; port: number; ips: string[]; rootDir: string; token: string; name: string }) => void): () => void
    }
    mapTiles: {
      list(): Promise<import('./electron/main/map-tiles').MapTileSource[]>
      add(): Promise<import('./electron/main/map-tiles').MapTileSource | null>
      remove(id: string): Promise<boolean>
      tile(payload: { id: string; z: number; x: number; y: number }): Promise<Uint8Array | null>
      onChange(cb: (sources: import('./electron/main/map-tiles').MapTileSource[]) => void): () => void
    }
  }
}

declare module 'js-yaml' {
  const yaml: any;
  export default yaml;
}

// sherpa-onnx（纯 WASM Node 构建，CJS；仅声明用到的 API）
declare module 'sherpa-onnx' {
  export interface OfflineTtsAudio {
    samples: Float32Array
    sampleRate: number
  }
  export interface OfflineTts {
    sampleRate: number
    numSpeakers: number
    generate(config: { text: string; sid?: number; speed?: number }): OfflineTtsAudio
    free(): void
  }
  export function createOfflineTts(config: any): OfflineTts
  export const version: string
}
declare module 'markdown-it-toc-and-anchor' {
  const tocAndAnchor: any;
  export default tocAndAnchor;
}
  
declare module 'markdown-it-mark' {
  const mark: any;
  export default mark;
}
declare module 'pdfjs-dist' {
  export * from 'pdfjs-dist/types/src/pdf';
}