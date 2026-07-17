import { z } from 'zod';
import type { QuestionDraft } from '@exam/shared';

// 题目草稿的 zod 校验（AI 解析产出 + 文件导入都用它把关）。
// 与 @exam/shared 的 QuestionDraft 对齐；answer 的形态按 type 交叉校验。

const baseFields = {
  stem: z.string().min(1, '题干不能为空'),
  options: z.array(z.string()).default([]),
  explanation: z.string().optional(),
  tags: z.array(z.string()).optional(),
};

/** 单条草稿的 schema：先按结构解析，再按题型校验 answer 合法性 */
export const questionDraftSchema = z
  .object({
    type: z.enum(['single', 'multiple', 'boolean']),
    ...baseFields,
    // answer 用 union 承接三种形态，交由 superRefine 按 type 收紧
    answer: z.union([z.number(), z.array(z.number()), z.boolean()]),
  })
  .superRefine((q, ctx) => {
    if (q.type === 'single') {
      if (typeof q.answer !== 'number' || !Number.isInteger(q.answer) || q.answer < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'single 题 answer 必须是选项 index（非负整数）' });
      } else if (q.answer >= q.options.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'single 题 answer 超出选项范围' });
      }
    } else if (q.type === 'multiple') {
      if (!Array.isArray(q.answer) || q.answer.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'multiple 题 answer 必须是非空 index 数组' });
      } else if (q.answer.some((n) => !Number.isInteger(n) || n < 0 || n >= q.options.length)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'multiple 题 answer 含非法或越界 index' });
      }
    } else if (q.type === 'boolean') {
      if (typeof q.answer !== 'boolean') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'boolean 题 answer 必须是布尔值' });
      }
    }
  });

export const questionDraftArraySchema = z.array(questionDraftSchema);

/** 校验一组草稿；失败抛出可读错误。source 由调用方补充。 */
export function validateDrafts(raw: unknown, source: QuestionDraft['source']): QuestionDraft[] {
  const parsed = questionDraftArraySchema.parse(raw);
  return parsed.map((q) => ({
    type: q.type,
    stem: q.stem,
    options: q.options,
    answer: q.answer,
    explanation: q.explanation,
    tags: q.tags,
    source,
  }));
}
