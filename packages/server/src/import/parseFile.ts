import { parse as parseCsv } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import type { QuestionDraft } from '@exam/shared';
import { questionDraftSchema } from './questionSchema.js';

// 结构化文件导入（不走 AI，可靠、零成本）。支持 JSON / CSV / Excel。
// CSV/Excel 列约定（模板）：
//   type | stem | options | answer | explanation | tags
//   - type：single / multiple / boolean / essay（兼容中文：单选/多选/判断/简答…）
//   - options：用 | 分隔（也兼容 、 ， , ; 顿号/逗号），如 "地球|火星|木星"；也可用 选项A/选项B/… 分列
//   - answer：single 填 0 起下标或字母（A=0）；multiple 填 "0|2" / "A,C" / "AC"；
//             boolean 填 true/false 或 对/错/正确/错误；essay 填参考答案文本
//   - tags：用 | 、 ， 分隔，可空
// 解析结果带逐行错误：合法行照常返回，非法行给出 行号+原因（前端预览时提示，不整文件拒绝）。

export interface RowError {
  /** 1 起行号：CSV/Excel 为物理行号（含表头），JSON 为条目序号 */
  row: number;
  errors: string[];
}

export interface StructuredParseResult {
  questions: QuestionDraft[];
  errors: RowError[];
}

// ── 容错：表头与题型的别名 ──────────────────────────────────
const HEADER_ALIASES: Record<string, string> = {
  type: 'type',
  题型: 'type',
  题型类别: 'type',
  题目类型: 'type',
  stem: 'stem',
  题干: 'stem',
  题目: 'stem',
  题目内容: 'stem',
  题干内容: 'stem',
  question: 'stem',
  options: 'options',
  选项: 'options',
  answer: 'answer',
  答案: 'answer',
  正确答案: 'answer',
  explanation: 'explanation',
  解析: 'explanation',
  解释: 'explanation',
  答案解析: 'explanation',
  tags: 'tags',
  标签: 'tags',
  知识点: 'tags',
  考点: 'tags',
};

/** 选项分列写法：选项A/选项B/选项1… 按列顺序合并为 options */
const OPTION_COL_RE = /^选项([A-Ha-h一二三四五六七八1-8])$/;

interface HeaderColumn {
  canon: string;
  letter?: string;
}

function headerColumn(cell: unknown): HeaderColumn {
  const s = String(cell ?? '')
    .trim()
    .replace(/^\uFEFF/, '')
    .toLowerCase();
  const m = OPTION_COL_RE.exec(s);
  if (m) return { canon: 'options', letter: m[1]!.toUpperCase() };
  const canon = HEADER_ALIASES[s];
  return canon ? { canon } : { canon: '' };
}

const TYPE_ALIASES: Record<string, string> = {
  single: 'single',
  单选: 'single',
  单选题: 'single',
  单项选择: 'single',
  multiple: 'multiple',
  多选: 'multiple',
  多选题: 'multiple',
  多项选择: 'multiple',
  boolean: 'boolean',
  判断: 'boolean',
  判断题: 'boolean',
  是非: 'boolean',
  是非题: 'boolean',
  正误: 'boolean',
  essay: 'essay',
  简答: 'essay',
  简答题: 'essay',
  问答: 'essay',
  问答题: 'essay',
  主观: 'essay',
  主观题: 'essay',
  论述: 'essay',
  论述题: 'essay',
  作文: 'essay',
};

function normalizeType(v: string): string | undefined {
  return TYPE_ALIASES[v.toLowerCase()];
}

// ── 编码：UTF-8（含 BOM）/ UTF-16 / GBK（Windows Excel 常见） ──
function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // 非 UTF-8：按 GBK 解码（Windows Excel 导出 CSV 的常见编码）
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

// ── 单元格取值与分隔 ────────────────────────────────────────
function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** 按 | 、 ， , ; 分隔（选项/标签共用） */
function splitList(v: unknown): string[] {
  return str(v)
    .split(/[|,，、;；]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** options 列：| 分隔（兼容顿号/逗号）；也支持导出 CSV 的 JSON 数组形式 ["a","b"] */
function parseOptions(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => str(x)).filter((s) => s !== '');
  }
  const t = str(v);
  if (t === '') return [];
  if (t.startsWith('[')) {
    try {
      const p = JSON.parse(t) as unknown;
      if (Array.isArray(p) && p.every((x) => typeof x === 'string')) {
        return p.map((s) => s.trim()).filter((s) => s !== '');
      }
    } catch {
      /* 不是 JSON，走分隔符拆分 */
    }
  }
  return splitList(v);
}

/** answer 列按题型还原：字母/下标/多选组合/判断题说法，兼容器导出 JSON 编码 */
function parseAnswer(
  type: string,
  v: unknown,
  optionsLen: number,
): { value?: unknown; error?: string } {
  const raw = str(v);

  if (type === 'single') {
    if (raw === '') return { error: '单选题答案不能为空' };
    const m = /^[A-Za-z]$/.exec(raw);
    if (m) {
      const idx = raw.toUpperCase().charCodeAt(0) - 65;
      if (idx >= optionsLen) {
        return { error: `答案字母 ${raw.toUpperCase()} 超出选项范围（共 ${optionsLen} 个选项）` };
      }
      return { value: idx };
    }
    const n = Number(raw);
    if (!Number.isInteger(n)) {
      return { error: `单选题答案必须是选项下标（0 起）或字母，收到「${raw}」` };
    }
    let idx = n;
    // 1 起下标兼容：共 N 个选项时写 N 视作最后一个（0 起写法 N 本就越界，重解读只赚不亏）
    if (idx === optionsLen && optionsLen > 0) idx -= 1;
    if (idx < 0 || idx >= optionsLen) {
      return {
        error: `单选题答案 ${raw} 超出选项范围（共 ${optionsLen} 个选项，下标从 0 开始，第 1 项是 0）`,
      };
    }
    return { value: idx };
  }

  if (type === 'multiple') {
    if (raw === '') return { error: '多选题答案不能为空' };
    let tokens: string[] = [];
    const t = raw.replace(/\s+/g, '');
    if (t.startsWith('[')) {
      try {
        const p = JSON.parse(t) as unknown;
        if (Array.isArray(p)) tokens = p.map(String);
      } catch {
        /* fallthrough */
      }
    }
    if (tokens.length === 0) {
      if (/^[A-Za-z]{1,20}$/.test(t)) tokens = t.split('');
      else {
        tokens = raw
          .split(/[|,，、;；]/)
          .map((s) => s.trim())
          .filter((s) => s !== '');
      }
    }
    const idxs: number[] = [];
    for (const tk of tokens) {
      const lm = /^[A-Za-z]$/.exec(tk);
      if (lm) {
        const idx = tk.toUpperCase().charCodeAt(0) - 65;
        if (idx >= optionsLen) {
          return { error: `答案字母 ${tk.toUpperCase()} 超出选项范围（共 ${optionsLen} 个选项）` };
        }
        idxs.push(idx);
      } else {
        const n = Number(tk);
        if (!Number.isInteger(n) || n < 0 || n >= optionsLen) {
          return {
            error: `多选题答案「${tk}」非法（应为 0 起下标或字母，共 ${optionsLen} 个选项）`,
          };
        }
        idxs.push(n);
      }
    }
    if (idxs.length === 0) return { error: '多选题答案不能为空' };
    return { value: [...new Set(idxs)] };
  }

  if (type === 'boolean') {
    const l = raw.toLowerCase();
    if (['true', 't', 'yes', 'y', '1', '对', '正确', '是', '√'].includes(l)) return { value: true };
    if (['false', 'f', 'no', 'n', '0', '错', '错误', '否', '×', 'x'].includes(l)) {
      return { value: false };
    }
    return { error: `判断题答案「${raw || '空'}」无法识别（填 正确/错误 或 对/错）` };
  }

  // essay：参考答案文本（兼容导出 CSV 的 JSON 编码字符串）
  if (raw === '') return { error: '简答题答案不能为空（填写参考答案文本）' };
  try {
    const p = JSON.parse(raw) as unknown;
    if (typeof p === 'string') return { value: p };
  } catch {
    /* 裸文本 */
  }
  return { value: raw };
}

/** 无 题型(type) 列时按答案形态推断题型（题目/选项A-D/答案 这类排版常用） */
function inferType(rec: Record<string, unknown>): string | undefined {
  const ans = str(rec.answer);
  const l = ans.trim().toLowerCase();
  if (['对', '正确', '是', '√', 't', 'true', 'yes', 'y'].includes(l)) return 'boolean';
  if (['错', '错误', '否', '×', 'f', 'false', 'no', 'n'].includes(l)) return 'boolean';
  const hasOptions = parseOptions(rec.options).length > 0;
  if ((l === '1' || l === '0') && !hasOptions) return 'boolean';
  if (/^[a-z]{2,20}$/.test(l)) return 'multiple'; // AC / ABD
  if (/[|,，、;；]/.test(ans)) return 'multiple'; // 0|2 / A,C
  if (/^[a-z0-9]+$/.test(l)) return 'single'; // A / 0 / 2
  if (ans.length > 0) return 'essay';
  return undefined;
}

/** 扁平行 → 草稿原始对象（先做容错转换，交给 zod 兜底校验） */
function rawFromRecord(rec: Record<string, unknown>): { raw: unknown } | { error: string } {
  const typeRaw = str(rec.type);
  let type = normalizeType(typeRaw);
  if (!type && !typeRaw) {
    // 表头没有 题型 列：按答案形态推断
    type = inferType(rec);
  }
  if (!type) {
    return {
      error: `题型「${typeRaw || '空'}」无法识别（填 single/multiple/boolean/essay 或 单选/多选/判断/简答）`,
    };
  }
  const options = parseOptions(rec.options);
  const ans = parseAnswer(type, rec.answer, options.length);
  if (ans.error) return { error: ans.error };
  return {
    raw: {
      type,
      stem: str(rec.stem),
      options,
      answer: ans.value,
      explanation: str(rec.explanation) || undefined,
      tags: splitList(rec.tags),
    },
  };
}

// ── 表格（CSV/Excel 统一）→ 草稿 + 逐行错误 ─────────────────
interface TableRow {
  cells: unknown[];
  /** 物理行号（1 起） */
  line: number;
}

function findHeaderRow(rows: TableRow[]): { index: number; columns: HeaderColumn[] } | null {
  const scan = Math.min(rows.length, 10);
  for (let i = 0; i < scan; i++) {
    const cols = rows[i]!.cells.map(headerColumn);
    // 至少要有 题干(stem) 列；题型列可缺省（按答案推断），选项/答案/解析/标签可选
    if (cols.some((c) => c.canon === 'stem')) {
      return { index: i, columns: cols };
    }
  }
  return null;
}

function tableToResult(rows: TableRow[]): StructuredParseResult {
  const nonEmpty = rows.filter((r) => r.cells.some((c) => String(c ?? '').trim() !== ''));
  if (nonEmpty.length === 0) return { questions: [], errors: [] };

  const header = findHeaderRow(nonEmpty);
  if (!header) {
    throw new Error(
      '表头未识别：请在表格第一行（或前几行内）放置表头，需含 题干(stem) 列（支持中文：题型/题干/选项/答案/解析/标签）',
    );
  }

  const { index, columns } = header;
  const questions: QuestionDraft[] = [];
  const errors: RowError[] = [];
  const hasLetterCols = columns.some((c) => c.canon === 'options' && !!c.letter);

  for (let i = index + 1; i < nonEmpty.length; i++) {
    const { cells, line } = nonEmpty[i]!;
    if (cells.length !== columns.length) {
      errors.push({
        row: line,
        errors: [
          `列数与表头不一致（表头 ${columns.length} 列，本行 ${cells.length} 列）；单元格内含逗号时请用 Excel 编辑或给该格加引号`,
        ],
      });
      continue;
    }
    const rec: Record<string, unknown> = {};
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c]!;
      if (!col.canon) continue;
      if (col.canon === 'options') {
        if (col.letter) {
          const list = (rec.__optList as unknown[] | undefined) ?? [];
          list.push(cells[c]);
          rec.__optList = list;
        } else if (!hasLetterCols) {
          rec.options = cells[c];
        }
        continue;
      }
      if (!(col.canon in rec)) rec[col.canon] = cells[c];
    }
    if (rec.__optList !== undefined) {
      rec.options = rec.__optList;
      delete rec.__optList;
    }

    const built = rawFromRecord(rec);
    if ('error' in built) {
      errors.push({ row: line, errors: [built.error] });
      continue;
    }
    const r = questionDraftSchema.safeParse(built.raw);
    if (r.success) {
      questions.push({ ...r.data, source: 'file' });
    } else {
      errors.push({ row: line, errors: r.error.issues.map((x) => x.message) });
    }
  }
  return { questions, errors };
}

function parseCsvFile(buf: Buffer): StructuredParseResult {
  const text = decodeText(buf);
  const rows: TableRow[] = [];
  try {
    parseCsv(text, {
      trim: true,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      on_record(rec, ctx) {
        const lines = (ctx as { lines: number }).lines;
        rows.push({ cells: rec as string[], line: lines });
        return rec;
      },
    });
  } catch (e) {
    throw new Error(`CSV 无法解析：${(e as Error).message}`);
  }
  return tableToResult(rows);
}

function parseExcelFile(buf: Buffer): StructuredParseResult {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'buffer' });
  } catch {
    throw new Error('Excel 文件无法解析（请确认是有效的 .xlsx / .xls 文件）');
  }
  const sheetName = wb.SheetNames[0];
  const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!sheet) throw new Error('Excel 无有效工作表');
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  return tableToResult(rows.map((cells, i) => ({ cells, line: i + 1 })));
}

function parseJsonFile(buf: Buffer): StructuredParseResult {
  let json: unknown;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('JSON 文件无法解析');
  }
  if (!Array.isArray(json)) throw new Error('JSON 顶层必须是题目数组');
  const questions: QuestionDraft[] = [];
  const errors: RowError[] = [];
  json.forEach((item, i) => {
    const r = questionDraftSchema.safeParse(item);
    if (r.success) {
      questions.push({ ...r.data, source: 'file' });
    } else {
      errors.push({ row: i + 1, errors: r.error.issues.map((x) => x.message) });
    }
  });
  return { questions, errors };
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

/** 按文件名后缀解析 buffer 为草稿题 + 逐行错误。失败抛可读错误。 */
export function parseFileBuffer(filename: string, buf: Buffer): StructuredParseResult {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.json')) return parseJsonFile(buf);
  if (lower.endsWith('.csv')) return parseCsvFile(buf);
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return parseExcelFile(buf);

  throw new Error('不支持的文件类型（结构化：.json / .csv / .xlsx；文本类：.txt / .md / .docx）');
}
