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
 */
export async function streamSse(
  url: string,
  body: unknown,
  handlers: SseHandlers,
): Promise<void> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok || !resp.body) {
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

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // 逐块读取，按 SSE 帧分隔符 "\n\n" 切分
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      dispatchFrame(frame, handlers);
    }
  }
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
