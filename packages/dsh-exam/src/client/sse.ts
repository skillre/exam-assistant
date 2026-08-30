/**
 * 小型 SSE reader —— 适配 Host 的 POST SSE 契约（llm/test、grading/essay、tutor/chat）。
 *
 * 说明：本接口是 POST，EventSource 只支持 GET，因此使用
 * `fetch` + `ReadableStream` reader 消费（同源，无 CORS 问题）。
 *
 * 协议（host-engineer 定稿）：
 * - 200 text/event-stream；事件为 `data: {...}\n\n` 行，JSON 形如
 *   `{ type: 'delta' | 'done' | 'error', ... }`（done 的 result 载荷类型由调用方泛型指定）；
 * - 非 200 时响应为 JSON `{ error: { code, message } }`（如 503 EXAM_LLM_NO_PROVIDER、400 EXAM_INVALID_BODY），
 *   stream 尚未开始，直接读 JSON 展示；
 * - 流内失败：`{"type":"error","error":{...}}` 事件后连接关闭；
 * - 客户端可通过 AbortController 取消（Host 侧收到断开 → EXAM_LLM_ABORTED）。
 */
import type { ExamErrorDto } from './types.ts';

/** SSE 事件分发回调；T 为 done 事件 result 的载荷类型（llm/test 或 Phase 2 各端点）。 */
export interface SseHandlers<T = unknown> {
  onDelta: (text: string) => void;
  onDone: (result: T) => void;
  onError: (error: ExamErrorDto) => void;
}

export interface SseResult {
  /** 传输层/协议层是否以错误结束。 */
  failed: boolean;
}

/** 从非 200 JSON 响应中解析统一错误体；解析失败时构造兜底错误。 */
async function readJsonError(resp: Response, fallback: string): Promise<ExamErrorDto> {
  try {
    const body: unknown = await resp.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { error?: unknown }).error === 'object' &&
      (body as { error: { message?: unknown } }).error !== null
    ) {
      const err = (body as { error: { code?: unknown; message?: unknown } }).error;
      return {
        code: typeof err.code === 'string' ? err.code : `HTTP_${resp.status}`,
        message: typeof err.message === 'string' ? err.message : fallback,
      };
    }
  } catch {
    /* 非 JSON 响应，走兜底 */
  }
  return { code: `HTTP_${resp.status}`, message: fallback };
}

/**
 * POST 一个 JSON body 到 SSE 端点并逐帧消费。
 * 返回的 Promise 在流自然结束（done 事件或连接关闭）时 resolve；
 * 传输层异常（断线/网络错误）内部转换为 onError 回调后 resolve，绝不静默 reject。
 *
 * @param signal - 调用方 AbortController 的 signal；abort 后 reader 中断并触发 onError(EXAM_LLM_ABORTED 语义由 UI 层标注)。
 */
export async function streamSse<T = unknown>(
  url: string,
  body: unknown,
  handlers: SseHandlers<T>,
  signal?: AbortSignal,
): Promise<SseResult> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const aborted = signal?.aborted === true || err instanceof DOMException && err.name === 'AbortError';
    handlers.onError({
      code: aborted ? 'EXAM_LLM_ABORTED' : 'EXAM_LLM_STREAM_FAILED',
      message: aborted ? '已取消请求' : '网络错误：无法连接考试助手服务',
    });
    return { failed: true };
  }

  // 非 200：流未开始，读 JSON 错误体
  if (!resp.ok || !resp.body) {
    const err = await readJsonError(resp, `请求失败 (${resp.status})`);
    handlers.onError(err);
    return { failed: true };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let failed = false;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 帧分隔符 "\n\n"（兼容 "\r\n\r\n"）
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        dispatchFrame(frame, handlers);
      }
    }
  } catch (err) {
    const aborted = signal?.aborted === true || err instanceof DOMException && err.name === 'AbortError';
    handlers.onError({
      code: aborted ? 'EXAM_LLM_ABORTED' : 'EXAM_LLM_STREAM_FAILED',
      message: aborted ? '已取消请求' : '连接中断，流式响应未完成',
    });
    failed = true;
  }

  return { failed };
}

/** 解析一帧 SSE：取所有 `data:` 行拼接后 JSON.parse，按 type 分发。 */
function dispatchFrame<T>(frame: string, handlers: SseHandlers<T>): void {
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  const payload = dataLines.join('\n');
  let event: { type?: string; text?: unknown; result?: unknown; error?: unknown };
  try {
    event = JSON.parse(payload) as { type?: string; text?: unknown; result?: unknown; error?: unknown };
  } catch {
    // 非 JSON data 行：忽略（不打断流）
    return;
  }
  switch (event.type) {
    case 'delta':
      if (typeof event.text === 'string') handlers.onDelta(event.text);
      break;
    case 'done':
      if (event.result !== undefined) handlers.onDone(event.result as T);
      break;
    case 'error':
      if (
        typeof event.error === 'object' &&
        event.error !== null &&
        typeof (event.error as { code?: unknown; message?: unknown }).code === 'string' &&
        typeof (event.error as { code?: unknown; message?: unknown }).message === 'string'
      ) {
        handlers.onError(event.error as ExamErrorDto);
      } else {
        handlers.onError({ code: 'EXAM_LLM_STREAM_FAILED', message: '服务端返回了无法解析的错误事件' });
      }
      break;
  }
}
