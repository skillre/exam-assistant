import { describe, it, expect } from 'vitest';
import { validateDiagnosisResults } from './diagnosisSchema.js';
import { validatePlan } from './planSchema.js';

// v3 结构化 AI 产出 zod 校验（评审 C6：非法值拒绝单测）。

describe('validateDiagnosisResults（错因枚举固定）', () => {
  const valid = [
    {
      questionId: 'q1',
      stem: '1+1=?',
      userAnswer: 'B. 3',
      correctAnswer: 'A. 2',
      errorCategory: 'calculation_error',
      distractorNote: '把加法当乘法',
    },
  ];

  it('合法输出通过', () => {
    const r = validateDiagnosisResults(valid);
    expect(r).toHaveLength(1);
    expect(r[0]!.errorCategory).toBe('calculation_error');
    expect(r[0]!.distractorNote).toBe('把加法当乘法');
  });

  it('非法错因枚举被拒绝', () => {
    expect(() =>
      validateDiagnosisResults([{ ...valid[0]!, errorCategory: 'random_guess' }]),
    ).toThrow(/errorCategory/);
  });

  it('缺字段被拒绝', () => {
    const { questionId: _q, ...missing } = valid[0]!;
    void _q;
    expect(() => validateDiagnosisResults([missing as never])).toThrow();
  });
});

describe('validatePlan（阶段+任务含 PracticeScope）', () => {
  const validPlan = {
    title: '代数强化 3 天',
    description: '聚焦薄弱点',
    phases: [
      {
        title: '阶段 1：专项训练',
        description: '攻代数',
        tasks: [
          { title: '重练代数 10 题', scope: { bankId: 'b1', mode: 'byTag', tag: '代数' } },
        ],
      },
    ],
  };

  it('合法计划通过，shuffle 默认 true', () => {
    const p = validatePlan(validPlan);
    expect(p.phases).toHaveLength(1);
    expect(p.phases[0]!.tasks[0]!.scope.shuffle).toBe(true);
  });

  it('数组输入取第一个', () => {
    const p = validatePlan([validPlan, { title: '第二计划', phases: [] }]);
    expect(p.title).toBe('代数强化 3 天');
  });

  it('非法 mode 被拒绝', () => {
    expect(() =>
      validatePlan({
        ...validPlan,
        phases: [
          {
            ...validPlan.phases[0]!,
            tasks: [
              { title: 'x', scope: { bankId: 'b1', mode: 'byRandom' } },
            ],
          },
        ],
      }),
    ).toThrow(/mode|enum/);
  });

  it('空阶段被拒绝', () => {
    expect(() => validatePlan({ title: '空计划', phases: [] })).toThrow(/阶段|至少/);
  });

  it('任务缺 scope 被拒绝', () => {
    expect(() =>
      validatePlan({
        ...validPlan,
        phases: [{ ...validPlan.phases[0]!, tasks: [{ title: '无范围任务' }] }],
      }),
    ).toThrow();
  });
});
