/**
 * dsh-exam Client 侧 DTO —— **type-only 再导出垫片**（t10 起单端来源）。
 *
 * 契约定义已上移到 Host 侧 `src/host/contract.ts`（含 Phase 0 健康/题库/LLM
 * 与 Phase 1 题目/练习/错题 DTO）；本文件仅做 `export type *` 再导出，
 * 保证既有 client 导入点（api.ts / sse.ts / 各 UI 组件）不改名即可用，
 * 且 bundle 零运行时依赖（类型在编译期擦除）。
 */
export type * from '../host/contract.ts';
