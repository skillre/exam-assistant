import type { FastifyReply } from 'fastify';

// 统一 SSE 写入协议（DEC-8）：event: delta | done | error。
// 用 reply.raw 直接写裸流；关键响应头见下（Nginx 免缓冲在 Phase 9 nginx.conf 配）。

export interface SseChannel {
  delta(text: string): void;
  done(): void;
  error(message: string): void;
}

export function openSse(reply: FastifyReply): SseChannel {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // 反代层免缓冲（Nginx 会读它；本地直连无害）
    'X-Accel-Buffering': 'no',
  });

  const write = (event: string, data: unknown): void => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  return {
    delta(text: string) {
      write('delta', { text });
    },
    done() {
      write('done', {});
      reply.raw.end();
    },
    error(message: string) {
      write('error', { message });
      reply.raw.end();
    },
  };
}
