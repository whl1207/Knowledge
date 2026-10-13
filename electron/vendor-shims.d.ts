/**
 * 无类型声明的可选运行时依赖的最小环境声明。
 *
 * sherpa-onnx-node：本地 TTS 原生 N-API 二进制包（Kokoro / Piper），
 * npm 上没有 @types 包，仅在 tts-worker.ts 中懒加载使用
 * （不依赖其类型信息，避免为它引入类型维护成本）。
 */
declare module 'sherpa-onnx-node'
