import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// planRepo 依赖 SQLite：临时 DATA_DIR + 动态 import。

let tempDir: string;
let planRepo: typeof import('./planRepo.js').planRepo;

const phases = [
  {
    title: '阶段 1：专项',
    description: '攻代数',
    tasks: [
      { title: '重练代数', scope: { bankId: 'b1', mode: 'byTag' as const, tag: '代数' } },
      { title: '复盘错题', scope: { bankId: 'b1', mode: 'wrong' as const } },
    ],
  },
  {
    title: '阶段 2：巩固',
    description: '综合',
    tasks: [{ title: '全量练习', scope: { bankId: 'b1', mode: 'all' as const } }],
  },
];

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'exam-plan-'));
  process.env.DATA_DIR = tempDir;
  const dbMod = await import('../db/index.js');
  dbMod.getDb();
  dbMod.getDb().prepare(`INSERT INTO banks (id, name, created_at) VALUES ('b1', '测试库', 0)`).run();
  planRepo = (await import('./planRepo.js')).planRepo;
});

afterAll(async () => {
  const { closeDb } = await import('../db/index.js');
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('planRepo（计划/任务两表，D2）', () => {
  it('createPlan 落计划 + 展开创建全部任务', () => {
    const plan = planRepo.createPlan('b1', '代数强化', '三天计划', phases);
    expect(plan.title).toBe('代数强化');
    expect(plan.status).toBe('active');

    const tasks = planRepo.listTasksByPlan(plan.id);
    // 2+1 = 3 个任务，按 phase_index/sort_order 排序
    expect(tasks).toHaveLength(3);
    expect(tasks[0]!.phaseIndex).toBe(0);
    expect(tasks[0]!.sortOrder).toBe(0);
    expect(tasks[0]!.scope).toEqual({ bankId: 'b1', mode: 'byTag', tag: '代数' });
    expect(tasks[2]!.phaseIndex).toBe(1);
    expect(tasks[2]!.status).toBe('pending');
  });

  it('updateTaskStatus 置 done 记录完成时间，返回是否命中', () => {
    const plan = planRepo.createPlan('b1', '任务流', undefined, [
      { title: 'p1', tasks: [{ title: 't1', scope: { bankId: 'b1', mode: 'all' } }] },
    ]);
    const task = planRepo.listTasksByPlan(plan.id)[0]!;

    expect(planRepo.updateTaskStatus(task.id, 'done')).toBe(true);
    const updated = planRepo.getTask(task.id)!;
    expect(updated.status).toBe('done');
    expect(updated.completedAt).toBeTypeOf('number');

    // 回退 pending：completedAt 清空
    planRepo.updateTaskStatus(task.id, 'pending');
    expect(planRepo.getTask(task.id)!.completedAt).toBeUndefined();

    // 不存在的任务返回 false
    expect(planRepo.updateTaskStatus('nope', 'done')).toBe(false);
  });

  it('getPlan/listPlans 查询与状态更新', () => {
    const plan = planRepo.createPlan('b1', '列表测试', undefined, phases);
    expect(planRepo.getPlan(plan.id)!.phases).toHaveLength(2);
    planRepo.updatePlanStatus(plan.id, 'completed');
    expect(planRepo.getPlan(plan.id)!.status).toBe('completed');
    const all = planRepo.listPlans('b1');
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all[0]!.status).toBe('completed');
  });

  it('removePlan 级联清任务（ON DELETE CASCADE）', () => {
    const plan = planRepo.createPlan('b1', '删除测试', undefined, phases);
    const tasks = planRepo.listTasksByPlan(plan.id);
    expect(tasks).toHaveLength(3);
    planRepo.removePlan(plan.id);
    expect(planRepo.getPlan(plan.id)).toBeUndefined();
    expect(planRepo.listTasksByPlan(plan.id)).toHaveLength(0);
  });
});
