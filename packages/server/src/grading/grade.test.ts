import { describe, it, expect } from 'vitest';
import type { Question } from '@exam/shared';
import { isAnswerCorrect, gradeQuestion } from './grade.js';

describe('isAnswerCorrect — single', () => {
  it('相等判对', () => expect(isAnswerCorrect('single', 2, 2)).toBe(true));
  it('不等判错', () => expect(isAnswerCorrect('single', 2, 1)).toBe(false));
  it('类型不匹配判错', () => expect(isAnswerCorrect('single', 2, [2])).toBe(false));
});

describe('isAnswerCorrect — boolean', () => {
  it('true=true 判对', () => expect(isAnswerCorrect('boolean', true, true)).toBe(true));
  it('true≠false 判错', () => expect(isAnswerCorrect('boolean', true, false)).toBe(false));
  it('类型不匹配判错', () => expect(isAnswerCorrect('boolean', true, 1 as never)).toBe(false));
});

describe('isAnswerCorrect — multiple', () => {
  it('集合相等、顺序无关判对', () =>
    expect(isAnswerCorrect('multiple', [0, 2], [2, 0])).toBe(true));
  it('重复项归一后仍判对', () =>
    expect(isAnswerCorrect('multiple', [0, 2], [2, 0, 2])).toBe(true));
  it('少选判错', () => expect(isAnswerCorrect('multiple', [0, 1, 2], [0, 1])).toBe(false));
  it('多选判错', () => expect(isAnswerCorrect('multiple', [0, 1], [0, 1, 2])).toBe(false));
  it('空答案判错', () => expect(isAnswerCorrect('multiple', [0, 1], [])).toBe(false));
  it('负数 index 判错', () => expect(isAnswerCorrect('multiple', [0, 1], [-1, 1])).toBe(false));
  it('非数组判错', () => expect(isAnswerCorrect('multiple', [0, 1], 0 as never)).toBe(false));
});

describe('gradeQuestion — 范围校验', () => {
  const single: Question = {
    id: 'q1', bankId: 'b1', type: 'single',
    stem: '选一个', options: ['A', 'B', 'C'], answer: 1, createdAt: 0,
  };
  const multiple: Question = {
    id: 'q2', bankId: 'b1', type: 'multiple',
    stem: '选多个', options: ['A', 'B', 'C'], answer: [0, 2], createdAt: 0,
  };

  it('single 正确作答判对', () => expect(gradeQuestion(single, 1)).toBe(true));
  it('single 超范围 index 判错', () => expect(gradeQuestion(single, 5)).toBe(false));
  it('single 负数 index 判错', () => expect(gradeQuestion(single, -1)).toBe(false));
  it('multiple 正确集合判对', () => expect(gradeQuestion(multiple, [2, 0])).toBe(true));
  it('multiple 含超范围 index 判错', () => expect(gradeQuestion(multiple, [0, 9])).toBe(false));
});
