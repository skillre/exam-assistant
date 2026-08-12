// 前端 SSE 读取（DEC-8）：POST + fetch ReadableStream（非 EventSource，因需带请求体）。
// 后端 SSE 协议：event: delta | done | error，data 为 JSON。

export interface SseHandlers {
  onDelta: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

/**
 * 向 SSE 端点 POST 一个 JSON body，逐帧解析 event/data 并回调。
 * 用于 /api/tutor/explain、/api/tutor/ask、/api/insights/analyze。
 *
 * 可靠性（P0-1）：
 * - 首字节 30s 超时（AbortSignal.timeout，收到首个 SSE 帧后取消，流不设总时长）；
 * - 传输层异常（断线/超时/服务端崩溃）内部捕获并转 onError，promise 永不 reject 静默。
 */
export async function streamSse(
  url: string,
  body: unknown,
  handlers: SseHandlers,
): Promise<void> {
  const firstByteController = new AbortController();
  const t = setTimeout(() => firstByteController.abort(), 30_000);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: firstByteController.signal,
    });
  } catch (err) {
    clearTimeout(t);
    handlers.onError?.(abortMessage(err));
    return;
  }

  if (!resp.ok || !resp.body) {
    clearTimeout(t);
    // 非 SSE 的错误响应（如 400/404 的 JSON）
    let message = `请求失败 (${resp.status})`;
    try {
      const j = await resp.json();
      if (j?.error) message = j.error;
    } catch {
      /* ignore */
    }
    handlers.onError?.(message);
    return;
  }

  // 首个 SSE 数据块到达后取消超时：之后只靠传输层断线检测（reader.read 抛错）。
  // 若服务端挂着不推流（响应头已到、body 无数据），read 会被 abort 打断 → onError。
  let firstChunk = true;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    // 逐块读取，按 SSE 帧分隔符 "\n\n" 切分
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstChunk) {
        clearTimeout(t);
        firstChunk = false;
      }
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        dispatchFrame(frame, handlers);
      }
    }
  } catch (err) {
    clearTimeout(t);
    // 传输层异常（断线/代理断开/服务端崩溃）：转 onError，调用方 UI 复位
    handlers.onError?.((err as Error)?.name === 'AbortError' ? '连接超时，请重试' : `连接中断：${(err as Error)?.message ?? err}`);
  }
}

/** 首字节超时（AbortError）给用户可读文案 */
function abortMessage(err: unknown): string {
  const name = (err as Error)?.name;
  if (name === 'AbortError') return '连接超时（30s 未响应），请重试';
  return `请求失败：${(err as Error)?.message ?? err}`;
}

function dispatchFrame(frame: string, handlers: SseHandlers): void {
  let event = 'message';
  let dataRaw = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataRaw += line.slice(5).trim();
  }
  if (!dataRaw) return;

  let data: unknown;
  try {
    data = JSON.parse(dataRaw);
  } catch {
    return;
  }

  if (event === 'delta') handlers.onDelta((data as { text: string }).text);
  else if (event === 'done') handlers.onDone?.();
  else if (event === 'error') handlers.onError?.((data as { message: string }).message);
}
