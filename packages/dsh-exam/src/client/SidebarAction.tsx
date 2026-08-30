/**
 * sidebar.footer.action 入口 —— 考试助手按钮。
 *
 * Slot 契约（dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts）：
 * - 'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: { wide: boolean } }
 * - 注册选项：id/order/label（本入口 id: 'exam-assistant'）
 * - owner.wide：sidebar 宽列时为 true，56px rail 时为 false（只显示图标）。
 *
 * 可访问性：button + aria-label（rail 下无文字）+ aria-pressed 表示面板开关状态；
 * 点击切换 shell.overlay 面板（overlay-store 模块级共享状态）。
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { useExamOverlayOpen, toggleExamOverlay } from './overlay-store.ts';

/** 本入口的完整 props 组合（runtime 共享：owner { wide } + 全局标准座位）。 */
export type ExamSidebarActionProps = PropsRuntime<'sidebar.footer.action'>;

export function ExamSidebarAction({ wide }: ExamSidebarActionProps) {
  const open = useExamOverlayOpen();

  return (
    <button
      type="button"
      className={
        open
          ? 'exam-assistant-sidebar-action exam-assistant-sidebar-action--active'
          : 'exam-assistant-sidebar-action'
      }
      aria-label="考试助手"
      aria-pressed={open}
      title="考试助手"
      onClick={toggleExamOverlay}
    >
      <span className="exam-assistant-sidebar-action__icon" aria-hidden="true">
        {/* 内联 SVG 学士帽（lucide graduation-cap 图形：帽顶 + 流苏 + 底座），
            stroke=currentColor 跟随文字色，16×16，无图片资源/新依赖 */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" />
          <path d="M22 10v6" />
          <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />
        </svg>
      </span>
      {wide ? <span className="exam-assistant-sidebar-action__label">考试助手</span> : null}
    </button>
  );
}
