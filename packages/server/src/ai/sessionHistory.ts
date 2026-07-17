import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { parseSessionEntries } from '@earendil-works/pi-coding-agent';

// 从答疑会话的 JSONL 文件读回多轮对话历史（Phase 6 GET /api/tutor/history）。
// 用 SDK 的 parseSessionEntries 解析，只取 user/assistant 的纯文本，
// 过滤掉首条注入的上下文（可选）、thinking、toolCall 等非对话内容。

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** 从内容项数组里抽取纯文本（拼接所有 text 片段） */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object' && (item as { type?: string }).type === 'text') {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join('');
}

/**
 * 读回某答疑会话的多轮对话。文件不存在返回空数组（降级，不抛）。
 */
export function readSessionHistory(jsonlPath: string): HistoryTurn[] {
  if (!existsSync(jsonlPath)) return [];
  let content: string;
  try {
    content = readFileSync(jsonlPath, 'utf8');
  } catch {
    return [];
  }

  const entries = parseSessionEntries(content);
  const turns: HistoryTurn[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const text = extractText(msg.content).trim();
    if (!text) continue;
    turns.push({ role: msg.role, content: text });
  }
  return turns;
}
