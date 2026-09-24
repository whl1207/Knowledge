/**
 * 协同文件编辑（局域网实时多人）类型定义
 * - 服务端：主进程 collab-service（WebSocket 服务器 + 房间级 Yjs 权威文档）
 * - 客户端：渲染进程 useCollabSession（Yjs Doc + Monaco 绑定 + Awareness 光标）
 */

/** 编辑权限模式 */
export type CollabPermissionMode = 'open' | 'approve' | 'readonly'

/** 房间数据模型：text=纯文本（代码编辑器） / excalidraw=白板场景 / drawio=draw.io 图表 */
export type CollabKind = 'text' | 'excalidraw' | 'drawio'

/** 协同成员（服务端视图，广播给所有客户端） */
export interface CollabMember {
  id: string
  name: string
  color: string
  role: 'host' | 'editor' | 'reader'
  canEdit: boolean
}

/** 协同服务运行状态（设置页 + 编辑器状态栏共用） */
export interface CollabStatus {
  running: boolean
  port: number
  ips: string[]
  rooms: number
}

/** 共享文件结果：创建/复用房间后返回给宿主 */
export interface CollabShareResult {
  roomId: string
  token: string
  /** 宿主本地连接地址（ws://127.0.0.1:port/collab/<roomId>?token=…） */
  url: string
  port: number
}

/** 协同服务设置（持久化到 localStorage） */
export interface CollabSettings {
  /** 主开关：关闭时编辑器状态栏不显示协同图标 */
  enabled: boolean
  /** WebSocket 服务端口（默认 3346，与 LAN 静态共享 3345 分离） */
  port: number
  /** 房间最大成员数（2~20，默认 10） */
  maxMembers: number
  /** 编辑权限模式 */
  permissionMode: CollabPermissionMode
  /** 房间 Token（分享时若为空自动生成并回填） */
  token: string
  /** 宿主自动写盘间隔（秒，默认 30） */
  autoSaveSeconds: number
}

/** 远程文件共享服务状态（主机视角，设置页显示） */
export interface RemoteFsStatus {
  running: boolean
  port: number
  ips: string[]
  rootDir: string
  token: string
  name: string
}

/** 远程工作区（客户端视角，文件树显示） */
export interface RemoteRoot {
  id: string
  name: string
  host: string
  port: number
  token: string
  /** 服务端共享根目录名（仅展示） */
  rootName?: string
}

/** 远程文件树节点（与服务端 /fs/list 输出同构） */
export interface RemoteFsNode {
  label: string
  path: string
  type: 'folder' | 'file'
  size?: number
  mtime?: number
  children?: RemoteFsNode[]
}

/** WebSocket JSON 消息帧（服务端 ↔ 客户端统一协议） */
export interface CollabWsMessage {
  type: string
  [k: string]: any
}
