/**
 * Phase 1 判分模块：纯函数、确定性、无副作用（不接触 store/ctx）。
 *
 * 答案编码约定（与 t9 数据层一致，见 store.ts QuestionRow.answer 文档）：
 * - single：正确答案为**选项标识字符串**（如 'A' 或下标字符串 '2'）；
 *   判分 = 用户答案与该标识**严格相等**（===，不 trim、不类型强制）。
 * - multiple：正确答案为字符串数组（选项标识集合）；判分 = 集合相等
 *   （去重、忽略顺序；空数组/非法元素（非字符串/空串）一律判错）。
 * - boolean：正确答案为 'true' | 'false'（字符串）；判分 = 严格布尔语义
 *   （接受原生 boolean 与 'true'/'false' 字符串并归一化比较，其余一律判错）。
 *
 * 一切类型不匹配/非法输入均判错（不抛异常），保证判分路径零中断。
 */
import type { QuestionRow } from './store.ts';

/** 判分结果（纯数据）。 */
export interface GradeResult {
  readonly isCorrect: boolean;
}

const BOOLEAN_TRUE = 'true';
const BOOLEAN_FALSE = 'false';

/** 判分主入口：按题型比对。 */
export function gradeQuestion(
  question: Pick<QuestionRow, 'type' | 'answer'>,
  userAnswer: unknown,
): GradeResult {
  switch (question.type) {
    case 'single':
      return { isCorrect: gradeSingle(question.answer, userAnswer) };
    case 'multiple':
      return { isCorrect: gradeMultiple(question.answer, userAnswer) };
    case 'boolean':
      return { isCorrect: gradeBoolean(question.answer, userAnswer) };
    default:
      return { isCorrect: false };
  }
}

/** single：严格字符串相等（"下标/标识精确匹配"）。 */
function gradeSingle(correct: unknown, user: unknown): boolean {
  return isOptionIdentifier(correct) && isOptionIdentifier(user) && correct === user;
}

/** multiple：字符串集合相等（去重、忽略顺序；拒绝空/非法）。 */
function gradeMultiple(correct: unknown, user: unknown): boolean {
  const c = normalizeIdentifierSet(correct);
  const u = normalizeIdentifierSet(user);
  if (c === null || u === null) return false;
  if (c.size === 0 || u.size === 0) return false;
  if (c.size !== u.size) return false;
  for (const id of c) {
    if (!u.has(id)) return false;
  }
  return true;
}

/** boolean：严格布尔语义（boolean 与 'true'/'false' 字符串归一化）。 */
function gradeBoolean(correct: unknown, user: unknown): boolean {
  const c = normalizeBoolean(correct);
  const u = normalizeBoolean(user);
  if (c === null || u === null) return false;
  return c === u;
}

/** 选项标识：非空字符串（不做 trim——标识匹配必须逐字符一致）。 */
function isOptionIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 归一化为去重标识集合；含非法元素（非字符串/空串）返回 null。 */
function normalizeIdentifierSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  const set = new Set<string>();
  for (const item of value) {
    if (!isOptionIdentifier(item)) return null;
    set.add(item);
  }
  return set;
}

/** 归一化布尔：boolean | 'true' | 'false' → 规范字符串；其余 null。 */
function normalizeBoolean(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? BOOLEAN_TRUE : BOOLEAN_FALSE;
  if (value === BOOLEAN_TRUE || value === BOOLEAN_FALSE) return value;
  return null;
}
