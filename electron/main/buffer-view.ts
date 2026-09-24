/**
 * Buffer → Uint8Array 的类型兼容垫片（纯类型层，运行时返回同一对象）。
 *
 * 为什么需要：
 *  - 本项目安装的是 @types/node 20.x，其 `Buffer` 未参数化；
 *  - 编辑器内置的 TypeScript 是 6.x，而 TypedArray 自 TS 5.7 起是**可变泛型**；
 *  - 两者相遇时，`Buffer` 与 `Uint8Array<ArrayBufferLike>` / `ArrayBufferView` /
 *    crypto 的 `BinaryLike` / zlib 的 `InputType` 等目标类型会因 `slice()` 成员的
 *    可变性而互相不兼容 —— 纯类型误报，运行时完全等价。
 *
 * 用法：把 Buffer 传给 fs / zlib / crypto / TextDecoder 之前套一层 asUint8()。
 * 注意：不要断言成裸 `ArrayBufferView`（参数化 interface，会报缺 DataView 方法）。
 *
 * 后续：等 @types/node 升到 22+（Buffer 自身带泛型参数）后，可删除本文件与全部调用点。
 */
export const asUint8 = (buf: Buffer): Uint8Array => buf as unknown as Uint8Array
