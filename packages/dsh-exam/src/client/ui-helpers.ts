/**
 * dsh-exam Client 共享 UI 工具（纯函数，无状态）。
 *
 * 答案编码约定（对齐 src/host/grading.ts）：
 * - single：正确答案为选项标识字符串（'A' 或下标字符串 '0' 等，非空字符串严格相等）；
 * - multiple：字符串数组（选项标识集合，集合相等）；
 * - boolean：'true' | 'false'。
 * 展示时统一把标识映射回选项文本；无法映射时原样显示标识。
 */
import type { ExamErrorDto, ExamQuestionDto, ExamQuestionType, GradingVerdictDto } from './types.ts';

/**
 * 错误码 → 可读文案（共享映射，PracticeView/Insights/WrongView 等展示点复用）。
 * 覆盖 t11 新增码：练习已结束 / 空练习范围 / essay 批改缺失；EXAM_QUESTION_NOT_IN_PRACTICE
 * 为既有码（与 PracticeView.explainErrorMessage 文案保持一致）。未映射的码原样透传
 * `${code}: ${message}`，不丢诊断信息。
 */
export function examErrorMessage(error: ExamErrorDto): string {
  switch (error.code) {
    case 'EXAM_PRACTICE_FINISHED':
      return '练习已结束，无法继续作答/修改';
    case 'EXAM_EMPTY_PRACTICE_SCOPE':
      return '该范围没有可练题目，请调整范围';
    case 'EXAM_QUESTION_NOT_IN_PRACTICE':
      return '练习会话已失效或题目不在本题单中';
    case 'EXAM_ESSAY_GRADING_NOT_FOUND':
      return '批改结果不存在或已过期';
    default:
      return `${error.code}: ${error.message}`;
  }
}

const TYPE_LABELS: Record<ExamQuestionType, string> = {
  single: '单选',
  multiple: '多选',
  boolean: '判断',
  // Phase 2：essay 主观题（label 由 t4 细化）。
  essay: '主观题',
};

export function questionTypeLabel(type: ExamQuestionType): string {
  // 兜底：学情聚合可能携带 'unknown'（题目被级联删除后）等未知键，避免渲染 undefined
  return TYPE_LABELS[type] ?? String(type ?? '未知');
}

const VERDICT_LABELS: Record<GradingVerdictDto, string> = {
  correct: '正确',
  partial: '部分正确',
  incorrect: '不正确',
};

/** essay 批改结论 verdict 的人类可读文本。 */
export function verdictLabel(verdict: GradingVerdictDto): string {
  return VERDICT_LABELS[verdict] ?? String(verdict);
}

/** 选项下标 → 字母标识（0→'A'，1→'B' …）。 */
export function optionLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

/** 标识 → 选项下标：支持 'A'-'Z' 与数字下标字符串；无法解析返回 null。 */
export function identifierToIndex(identifier: unknown): number | null {
  if (typeof identifier !== 'string' || identifier.length === 0) return null;
  if (/^[A-Z]$/.test(identifier)) return identifier.charCodeAt(0) - 65;
  if (/^\d+$/.test(identifier)) {
    const n = Number(identifier);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** 单选/多选/判断的「正确答案」人类可读文本；essay 无标准答案返回固定说明。 */
export function answerText(question: ExamQuestionDto): string {
  if (question.type === 'essay') return '主观题（无标准答案，由 AI 批改）';
  const opts = question.options ?? [];
  if (question.type === 'single') {
    const idx = identifierToIndex(question.answer);
    if (idx !== null && opts[idx] !== undefined) return optionLabel(idx) + '. ' + opts[idx];
    return String(question.answer);
  }
  if (question.type === 'multiple') {
    if (!Array.isArray(question.answer)) return String(question.answer);
    const parts = (question.answer as unknown[]).map((id) => {
      const idx = identifierToIndex(id);
      return idx !== null && opts[idx] !== undefined ? optionLabel(idx) + '. ' + opts[idx] : String(id);
    });
    return parts.join('；');
  }
  if (question.type === 'boolean') {
    return question.answer === 'true' || question.answer === true ? '对' : '错';
  }
  return String(question.answer);
}

/** epoch 毫秒 → 本地可读时间。 */
export function formatTime(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined) return '—';
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs) || epochMs <= 0) return '—';
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 标签数组 → 逗号分隔字符串（编辑用）。 */
export function tagsToCsv(tags: string[] | null | undefined): string {
  return (tags ?? []).join(', ');
}

/** 逗号分隔字符串 → 标签数组（去空白、去空项）。 */
export function csvToTags(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
