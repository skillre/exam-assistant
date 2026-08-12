import { parse as parseCsv } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import type { QuestionDraft } from '@exam/shared';
import { validateDrafts } from './questionSchema.js';

// 结构化文件导入（不走 AI，可靠、零成本）。支持 JSON / CSV / Excel。
// 统一先转成"原始记录数组"，再走 validateDrafts 把关。

// CSV/Excel 的列约定（模板）：
//   type | stem | options | answer | explanation | tags
//   - options：用 | 分隔，如 "地球|火星|木星"
//   - answer：single 填下标数字；multiple 填 "0|2"；boolean 填 true/false
//   - tags：用 | 分隔，可空
interface FlatRow {
  type?: string;
  stem?: string;
  options?: string;
  answer?: string;
  explanation?: string;
  tags?: string;
}

function splitPipe(v: string | undefined): string[] {
  if (!v) return [];
  return String(v)
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 把扁平行(CSV/Excel)按列约定转成草稿题的原始对象（answer 形态按 type 还原） */
function flatRowToRaw(row: FlatRow): unknown {
  const type = String(row.type ?? '').trim();
  const options = splitPipe(row.options);
  const answerRaw = String(row.answer ?? '').trim();

  let answer: unknown;
  if (type === 'single') {
    answer = Number(answerRaw);
  } else if (type === 'multiple') {
    answer = splitPipe(answerRaw).map((n) => Number(n));
  } else if (type === 'boolean') {
    answer = answerRaw.toLowerCase() === 'true' || answerRaw === '正确';
  } else if (type === 'essay') {
    // 主观题：answer 列=参考答案文本。兼容导出再导入（导出 answer 列是 JSON 编码
    // 字符串如 "参考文本"），剥掉 JSON 引号；解析失败按裸文本处理。
    try {
      const parsed = JSON.parse(answerRaw);
      answer = typeof parsed === 'string' ? parsed : answerRaw;
    } catch {
      answer = answerRaw;
    }
  }

  return {
    type,
    stem: String(row.stem ?? '').trim(),
    options,
    answer,
    explanation: row.explanation ? String(row.explanation).trim() : undefined,
    tags: splitPipe(row.tags),
  };
}

/**
 * 从文件提取纯文本（供 AI 解析的非结构化来源：.txt / .md / .docx）。
 * 返回 null 表示该文件类型不是"文本类"，应走结构化解析（parseFileBuffer）。
 */
export async function extractText(filename: string, buf: Buffer): Promise<string | null> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return buf.toString('utf8');
  }
  if (lower.endsWith('.docx')) {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }
  return null;
}

/** 结构化文件后缀判断（走确定性解析，不花 AI）。 */
export function isStructuredFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.json') || lower.endsWith('.csv') || lower.endsWith('.xlsx') || lower.endsWith('.xls');
}

/** 按文件名后缀解析 buffer 为草稿题。失败抛可读错误。 */
export function parseFileBuffer(filename: string, buf: Buffer): QuestionDraft[] {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.json')) {
    let json: unknown;
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {
      throw new Error('JSON 文件无法解析');
    }
    // JSON 直接按 schema 校验（结构应与草稿一致）
    return validateDrafts(json, 'file');
  }

  if (lower.endsWith('.csv')) {
    const records = parseCsv(buf, { columns: true, skip_empty_lines: true, trim: true }) as FlatRow[];
    return validateDrafts(records.map(flatRowToRaw), 'file');
  }

  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
    if (!sheet) throw new Error('Excel 无有效工作表');
    const records = XLSX.utils.sheet_to_json<FlatRow>(sheet, { defval: '' });
    return validateDrafts(records.map(flatRowToRaw), 'file');
  }

  throw new Error('不支持的文件类型（结构化：.json / .csv / .xlsx；文本类：.txt / .md / .docx）');
}
