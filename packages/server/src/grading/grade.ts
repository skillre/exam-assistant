import type { AnswerValue, Question, QuestionType } from '@exam/shared';

// 客观题判分：纯程序、确定性，不经 AI（DEC-3）。
// - single：选项 index 相等
// - multiple：选项 index 集合相等（顺序无关、去重）
// - boolean：布尔相等

/** 判分主入口：按题型比对用户答案与正确答案。异常/类型不匹配一律判错（不抛）。 */
export function isAnswerCorrect(
  type: QuestionType,
  correct: AnswerValue,
  user: AnswerValue,
): boolean {
  switch (type) {
    case 'single':
      return isSingleCorrect(correct, user);
    case 'boolean':
      return typeof correct === 'boolean' && typeof user === 'boolean' && correct === user;
    case 'multiple':
      return isMultipleCorrect(correct, user);
    default:
      return false;
  }
}

function isSingleCorrect(correct: AnswerValue, user: AnswerValue): boolean {
  return typeof correct === 'number' && typeof user === 'number' && correct === user;
}

function isMultipleCorrect(correct: AnswerValue, user: AnswerValue): boolean {
  if (!Array.isArray(correct) || !Array.isArray(user)) return false;
  // 空答案不算对（除非正确答案也为空，但客观题正确答案不应为空）
  const c = normalizeIndexSet(correct);
  const u = normalizeIndexSet(user);
  if (c === null || u === null) return false;
  if (c.size === 0) return false;
  if (c.size !== u.size) return false;
  for (const idx of c) {
    if (!u.has(idx)) return false;
  }
  return true;
}

/** 归一化为 index 集合：非整数/负数视为非法 → null（判错） */
function normalizeIndexSet(arr: number[]): Set<number> | null {
  const set = new Set<number>();
  for (const n of arr) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;
    set.add(n);
  }
  return set;
}

/** 用题目对象判分（校验 user 答案的 index 是否落在选项范围内） */
export function gradeQuestion(question: Question, user: AnswerValue): boolean {
  if (!isAnswerInRange(question, user)) return false;
  return isAnswerCorrect(question.type, question.answer, user);
}

/** 超出选项范围的 index 视为非法作答（判错，不抛） */
function isAnswerInRange(question: Question, user: AnswerValue): boolean {
  const max = question.options.length;
  if (question.type === 'single') {
    return typeof user === 'number' && user >= 0 && user < max;
  }
  if (question.type === 'multiple') {
    return Array.isArray(user) && user.every((n) => n >= 0 && n < max);
  }
  // boolean 无范围约束
  return true;
}
