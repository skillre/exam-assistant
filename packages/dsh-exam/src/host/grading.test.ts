/**
 * grading.ts 判分单元测试（Node 内置 node:test，零依赖）。
 * 覆盖：single 严格匹配 / multiple 集合语义 / boolean 严格布尔 / 边界非法输入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeQuestion } from './grading.ts';

function q(type: 'single' | 'multiple' | 'boolean', answer: unknown) {
  return { type, answer };
}

// ── single：严格标识匹配 ───────────────────────────────────────────────────

test('single：标识严格相等判对；不同标识/类型不匹配判错', () => {
  assert.equal(gradeQuestion(q('single', 'A'), 'A').isCorrect, true);
  assert.equal(gradeQuestion(q('single', '2'), '2').isCorrect, true, '下标字符串同样严格匹配');
  assert.equal(gradeQuestion(q('single', 'A'), 'B').isCorrect, false);
  assert.equal(gradeQuestion(q('single', 'A'), 'a').isCorrect, false, '大小写敏感');
  assert.equal(gradeQuestion(q('single', 'A'), ' A').isCorrect, false, '不做 trim');
  assert.equal(gradeQuestion(q('single', 'A'), 'A ').isCorrect, false, '不做 trim（尾）');
});

test('single：非字符串用户答案一律判错（不做类型强制）', () => {
  assert.equal(gradeQuestion(q('single', 'A'), 0).isCorrect, false, 'number 不强制为字符串');
  assert.equal(gradeQuestion(q('single', 'A'), true).isCorrect, false);
  assert.equal(gradeQuestion(q('single', 'A'), ['A']).isCorrect, false);
  assert.equal(gradeQuestion(q('single', 'A'), null).isCorrect, false);
  assert.equal(gradeQuestion(q('single', 'A'), undefined).isCorrect, false);
  assert.equal(gradeQuestion(q('single', 'A'), '').isCorrect, false, '空串判错');
});

test('single：正确答案非法（空串/非字符串）→ 用户任何答案都判错', () => {
  assert.equal(gradeQuestion(q('single', ''), '').isCorrect, false);
  assert.equal(gradeQuestion(q('single', 1), '1').isCorrect, false);
  assert.equal(gradeQuestion(q('single', ['A']), 'A').isCorrect, false);
});

// ── multiple：集合相等（去重、忽略顺序；拒绝空/非法）───────────────────────

test('multiple：顺序无关、去重后集合相等判对', () => {
  assert.equal(gradeQuestion(q('multiple', ['A', 'B']), ['A', 'B']).isCorrect, true);
  assert.equal(gradeQuestion(q('multiple', ['A', 'B']), ['B', 'A']).isCorrect, true, '顺序无关');
  assert.equal(gradeQuestion(q('multiple', ['A', 'A', 'B']), ['B', 'A', 'A']).isCorrect, true, '去重');
  assert.equal(gradeQuestion(q('multiple', ['A']), ['A', 'A']).isCorrect, true, '用户侧去重');
});

test('multiple：集合不等/缺漏/多选判错', () => {
  assert.equal(gradeQuestion(q('multiple', ['A', 'B']), ['A']).isCorrect, false, '缺项');
  assert.equal(gradeQuestion(q('multiple', ['A', 'B']), ['A', 'C']).isCorrect, false);
  assert.equal(gradeQuestion(q('multiple', ['A', 'B']), ['A', 'B', 'C']).isCorrect, false, '多选');
  assert.equal(gradeQuestion(q('multiple', ['A']), ['B']).isCorrect, false);
});

test('multiple：空/非法输入一律判错', () => {
  assert.equal(gradeQuestion(q('multiple', ['A', 'B']), []).isCorrect, false, '空用户答案');
  assert.equal(gradeQuestion(q('multiple', ['A', 'B']), 'A').isCorrect, false, '非数组');
  assert.equal(gradeQuestion(q('multiple', ['A', 'B']), [0, 1]).isCorrect, false, '非字符串元素');
  assert.equal(gradeQuestion(q('multiple', ['A', 'B']), ['A', 1]).isCorrect, false, '混合类型元素');
  assert.equal(gradeQuestion(q('multiple', ['A', 'B']), ['A', '']).isCorrect, false, '空串元素');
  assert.equal(gradeQuestion(q('multiple', ['A', 'B']), ['A', ' B']).isCorrect, false, '元素不 trim');
  assert.equal(gradeQuestion(q('multiple', ['A', 'B']), null).isCorrect, false);
  assert.equal(gradeQuestion(q('multiple', []), []).isCorrect, false, '正确答案为空也判错');
});

// ── boolean：严格布尔 ──────────────────────────────────────────────────────

test('boolean：true/false 字符串与原生 boolean 归一化比较', () => {
  assert.equal(gradeQuestion(q('boolean', 'true'), 'true').isCorrect, true);
  assert.equal(gradeQuestion(q('boolean', 'false'), 'false').isCorrect, true);
  assert.equal(gradeQuestion(q('boolean', 'true'), true).isCorrect, true, '原生 boolean true');
  assert.equal(gradeQuestion(q('boolean', 'false'), false).isCorrect, true, '原生 boolean false');
  assert.equal(gradeQuestion(q('boolean', 'true'), 'false').isCorrect, false);
  assert.equal(gradeQuestion(q('boolean', 'true'), false).isCorrect, false);
});

test('boolean：非严格布尔输入一律判错', () => {
  assert.equal(gradeQuestion(q('boolean', 'true'), 'TRUE').isCorrect, false, '大小写敏感');
  assert.equal(gradeQuestion(q('boolean', 'true'), 1).isCorrect, false, '数字不算 true');
  assert.equal(gradeQuestion(q('boolean', 'true'), 0).isCorrect, false);
  assert.equal(gradeQuestion(q('boolean', 'true'), 'yes').isCorrect, false);
  assert.equal(gradeQuestion(q('boolean', 'true'), '').isCorrect, false);
  assert.equal(gradeQuestion(q('boolean', 'true'), null).isCorrect, false);
  assert.equal(gradeQuestion(q('boolean', true), 'true').isCorrect, true, '存储为原生布尔也归一化');
});
