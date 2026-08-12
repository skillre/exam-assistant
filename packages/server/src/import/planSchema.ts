import { z } from 'zod';

// 计划/任务 zod schema（Slice 6）：阶段 + 任务列表，任务含 PracticeScope。

const practiceScopeSchema = z.object({
  bankId: z.string().min(1, 'bankId 不能为空'),
  mode: z.enum(['all', 'undone', 'wrong', 'byType', 'byTag']),
  type: z.enum(['single', 'multiple', 'boolean']).optional(),
  tag: z.string().optional(),
  shuffle: z.boolean().optional().default(true),
});

const taskSchema = z.object({
  title: z.string().min(1, '任务标题不能为空'),
  scope: practiceScopeSchema,
});

const phaseSchema = z.object({
  title: z.string().min(1, '阶段标题不能为空'),
  description: z.string().default(''),
  tasks: z.array(taskSchema).min(1, '每个阶段至少一个任务'),
});

export const planSchema = z.object({
  title: z.string().min(1, '计划标题不能为空'),
  description: z.string().optional(),
  phases: z.array(phaseSchema).min(1, '至少一个阶段'),
});

export const planArraySchema = z.array(planSchema);

/**
 * 校验 AI 计划输出。AI 可能返回单个对象或数组（数组时取第一个）。
 */
export function validatePlan(raw: unknown): z.infer<typeof planSchema> {
  const data = Array.isArray(raw) ? raw[0] : raw;
  if (!data) throw new Error('AI 未返回有效的学习计划');
  return planSchema.parse(data);
}

/** 校验计划数组（如果需要批量） */
export function validatePlans(raw: unknown): z.infer<typeof planArraySchema> {
  return planArraySchema.parse(raw);
}
