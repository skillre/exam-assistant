/**
 * shell.overlay 入口 —— 考试助手全屏原生面板（无 iframe）。
 *
 * Slot 契约（dsh-client-ui-layout/lib/types/client/index.d.ts）：
 * - 'shell.overlay': { kind: 'list'; scope: 'root' }（无 owner props；加法式浮层）
 * - 层本身 click-through；本入口挂载时通过 .exam-assistant-overlay-* 显式 opt-in pointer-events。
 * - 关闭时本入口渲染 null：不挂 mask、不拦截底层交互、不占布局。
 *
 * 可访问性/交互基础：
 * - role="dialog" + aria-modal="true" + aria-labelledby；
 * - 挂载时聚焦关闭按钮（对话框模式标准初始焦点），卸载/关闭时还原焦点到触发元素；
 * - 完整焦点陷阱：Tab/Shift+Tab 在对话框内循环；focusin 逃逸（如点击遮罩未关闭）
 *   立即拉回对话框，焦点不会落到背后的 DSH shell；
 * - Escape 关闭；点击 mask（非对话框区域）关闭。
 */
import { useEffect, useRef } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { closeExamOverlay, useExamOverlayOpen } from './overlay-store.ts';
import { ExamWorkspace } from './ExamWorkspace.tsx';

/** 本入口的完整 props 组合（owner 为空对象 + 全局标准座位）。 */
export type ExamOverlayProps = PropsRuntime<'shell.overlay'>;

/** 对话框内可聚焦元素选择器（禁用控件与 tabindex=-1 锚点排除）。 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ExamOverlay(_props: ExamOverlayProps) {
  const open = useExamOverlayOpen();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  // 焦点管理 + 完整焦点陷阱：打开时聚焦关闭按钮；Tab 循环于对话框内；
  // 关闭/卸载时还原到触发元素。全部监听随 open 生命周期开关。
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    // 初始焦点：关闭按钮（对话框标准模式）；极端情况下回退到对话框本身
    if (closeBtnRef.current) closeBtnRef.current.focus();
    else dialog?.focus();

    const getFocusables = (): HTMLElement[] => {
      if (!dialog) return [];
      return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.getClientRects().length > 0,
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeExamOverlay();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = getFocusables();
      if (focusables.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const inside = active !== null && dialog !== null && dialog.contains(active);
      if (event.shiftKey) {
        // Shift+Tab：在第一个元素上（或焦点已逃逸）→ 回到最后一个
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        // Tab：在最后一个元素上（或焦点已逃逸）→ 回到第一个
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      // 焦点逃逸兜底（如点击遮罩未关闭、浏览器把焦点移出）：立即拉回对话框
      const target = event.target;
      if (dialog !== null && target instanceof Node && !dialog.contains(target)) {
        (closeBtnRef.current ?? dialog).focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="exam-assistant-overlay-mask"
      onClick={(event) => {
        // 点击遮罩本身（而非对话框内容）关闭
        if (event.target === event.currentTarget) closeExamOverlay();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="exam-assistant-overlay-title"
        tabIndex={-1}
        className="exam-assistant-overlay-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="exam-assistant-overlay-header">
          <h2 id="exam-assistant-overlay-title" className="exam-assistant-overlay-title">
            考试助手
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="exam-assistant-overlay-close"
            aria-label="关闭考试助手"
            onClick={closeExamOverlay}
          >
            ✕
          </button>
        </div>
        <div className="exam-assistant-overlay-body">
          <ExamWorkspace />
        </div>
      </div>
    </div>
  );
}
