import type { QuestionDraft } from '@exam/shared';
import type { AiService } from '../ai/AiService.js';
import { validateDrafts } from './questionSchema.js';

// 粘贴文本 → AI 解析为结构化草稿题（DEC-11：一次性 inMemory 会话）。
// 判分不依赖 AI，但"把杂乱文本变成结构化题目"正是 AI 的价值点。

const SYSTEM_PROMPT = `你是一个考试题目解析器。用户会粘贴一段包含若干客观题的文本，
你需要把它解析成结构化的 JSON 数组。严格遵守：
- 只输出 JSON 数组本身，不要任何解释、不要 markdown 代码围栏。
- 每个元素字段：type、stem、options、answer、explanation(可选)、tags(可选)。
- type 取值：single(单选) | multiple(多选) | boolean(判断) | essay(主观题)。
- options：选项文本数组；判断题固定为 ["正确","错误"]；essay 题固定为 []。
- answer：single 为正确选项的下标(从 0 开始的整数)；multiple 为下标数组；
  boolean 为 true(正确)/false(错误)；essay 为参考答案文本(完整一句话)。
- explanation：若原文含解析则填入，否则省略。
- tags：知识点标签数组，可省略。
- 下标必须落在 options 范围内。无法确定答案的题目请跳过，不要编造。`;

function extractJsonArray(text: string): unknown {
  // 容错：模型偶尔会包裹 markdown 或前后加话。抽取第一个 [ 到最后一个 ] 之间的内容。
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI 未返回可识别的 JSON 数组');
  }
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    throw new Error('AI 返回的 JSON 数组无法解析');
  }
}

/** 解析粘贴文本为草稿题。失败抛出可读错误（route 层转 4xx）。 */
export async function parseTextWithAi(ai: AiService, text: string): Promise<QuestionDraft[]> {
  if (!text.trim()) throw new Error('文本为空');
  const raw = await ai.runOnce(SYSTEM_PROMPT, text);
  const json = extractJsonArray(raw);
  return validateDrafts(json, 'paste-ai');
}
