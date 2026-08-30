/**
 * 考试助手面板开关状态（sidebar.footer.action ↔ shell.overlay 之间的最小共享状态）。
 *
 * 说明：sidebar action 与 overlay 是两个独立的 Slot 注册（不同组件、不同渲染位置），
 * 因此用模块级单例 + useSyncExternalStore 做协调。仅承载「面板是否打开」一个布尔事实，
 * 不含任何 live DSH 对象；插件卸载/页面刷新即归零，无持久化。
 */
import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function isExamOverlayOpen(): boolean {
  return open;
}

export function openExamOverlay(): void {
  if (open) return;
  open = true;
  emit();
}

export function closeExamOverlay(): void {
  if (!open) return;
  open = false;
  emit();
}

export function toggleExamOverlay(): void {
  open = !open;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React 钩子：面板开关状态（组件卸载自动退订）。 */
export function useExamOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, isExamOverlayOpen);
}
