/**
 * StreamingPlaceholder —— SSE 流式输出的 TTFT 等待期骨架占位（设计 §5.6）。
 *
 * 三档可见阶段：TTFT 等待（SSE 已连接、delta 为空）→ 生成中（首个 delta 已到，逐字追加）→ 终态。
 * 本组件只负责 TTFT 等待期的「内容区」占位：若干条骨架线 + 可选过渡文字（label）。
 * 不带 label 时容器 `aria-hidden="true"`（非内容，不被 screen reader 朗读）；
 * 带 label 时保留可读语义（由调用方提供 role/aria 上下文）。
 *
 * 逐行宽度由 CSS 修饰类 `--1`/`--2`/`--3` 控制（100% / 92% / 78%）。
 */
export function StreamingPlaceholder({ lines = 3, label }: { lines?: number; label?: string }) {
  return (
    <div
      className="exam-assistant-streaming-placeholder"
      role={label !== undefined ? 'status' : undefined}
      aria-hidden={label === undefined ? true : undefined}
    >
      {label !== undefined ? (
        <span className="exam-assistant-streaming-placeholder__label">{label}</span>
      ) : null}
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} className={`exam-assistant-skeleton-line exam-assistant-skeleton-line--${i + 1}`} />
      ))}
    </div>
  );
}
