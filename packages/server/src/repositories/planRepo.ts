import { randomUUID } from 'node:crypto';
import type {
  AiPhase,
  LearningPlan,
  LearningTask,
  PlanStatus,
  PracticeScope,
  TaskStatus,
} from '@exam/shared';
import { db } from '../db/index.js';

// v3 学习计划/任务仓储（DEC-31，D2 两表：learning_plans + learning_tasks）。
// createPlan 展开 AI 产出的 phases[].tasks 创建任务行（Slice0 对账 R4）。

interface PlanRow {
  id: string;
  bank_id: string;
  title: string;
  description: string | null;
  phases: string;
  status: string;
  created_at: number;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toPlan(row: PlanRow): LearningPlan {
  return {
    id: row.id,
    bankId: row.bank_id,
    title: row.title,
    description: row.description ?? undefined,
    phases: parseJson(row.phases, [] as AiPhase[]),
    status: row.status as PlanStatus,
    createdAt: row.created_at,
  };
}

interface TaskRow {
  id: string;
  plan_id: string;
  title: string;
  phase_index: number;
  sort_order: number;
  scope: string;
  status: string;
  created_at: number;
  completed_at: number | null;
}

function toTask(row: TaskRow): LearningTask {
  return {
    id: row.id,
    planId: row.plan_id,
    title: row.title,
    phaseIndex: row.phase_index,
    sortOrder: row.sort_order,
    scope: parseJson(row.scope, {} as PracticeScope),
    status: row.status as TaskStatus,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

export const planRepo = {
  /**
   * 创建计划（Slice0 对账 R4）：落 learning_plans + 展开 phases[].tasks 落 learning_tasks，
   * 事务原子。返回新计划。
   */
  createPlan(
    bankId: string | null,
    title: string,
    description: string | undefined,
    phases: AiPhase[],
  ): LearningPlan {
    const id = randomUUID();
    const createdAt = Date.now();

    const insertTasks = db.transaction((planId: string) => {
      const stmt = db.prepare(
        `INSERT INTO learning_tasks (id, plan_id, title, phase_index, sort_order, scope, status, created_at)
         VALUES (@id, @plan_id, @title, @phase_index, @sort_order, @scope, 'pending', @created_at)`,
      );
      phases.forEach((phase, pi) => {
        phase.tasks.forEach((task, si) => {
          stmt.run({
            id: randomUUID(),
            plan_id: planId,
            title: task.title,
            phase_index: pi,
            sort_order: si,
            scope: JSON.stringify(task.scope),
            created_at: createdAt,
          });
        });
      });
    });

    const run = db.transaction(() => {
      db.prepare(
        `INSERT INTO learning_plans (id, bank_id, title, description, phases, status, created_at)
         VALUES (@id, @bank_id, @title, @description, @phases, 'active', @created_at)`,
      ).run({
        id,
        bank_id: bankId,
        title,
        description: description ?? null,
        phases: JSON.stringify(phases),
        created_at: createdAt,
      });
      insertTasks(id);
    });
    run();

    return { id, bankId, title, description, phases, status: 'active', createdAt };
  },

  getPlan(id: string): LearningPlan | undefined {
    const row = db
      .prepare('SELECT * FROM learning_plans WHERE id = ?')
      .get(id) as PlanRow | undefined;
    return row ? toPlan(row) : undefined;
  },

  listPlans(bankId?: string): LearningPlan[] {
    if (bankId) {
      return (
        db
          .prepare('SELECT * FROM learning_plans WHERE bank_id = ? ORDER BY created_at DESC')
          .all(bankId) as PlanRow[]
      ).map(toPlan);
    }
    return (
      db.prepare('SELECT * FROM learning_plans ORDER BY created_at DESC').all() as PlanRow[]
    ).map(toPlan);
  },

  updatePlanStatus(id: string, status: PlanStatus): void {
    db.prepare('UPDATE learning_plans SET status = ? WHERE id = ?').run(status, id);
  },

  removePlan(id: string): void {
    // tasks 经 ON DELETE CASCADE 一并清
    db.prepare('DELETE FROM learning_plans WHERE id = ?').run(id);
  },

  // ── tasks ──

  getTask(id: string): LearningTask | undefined {
    const row = db
      .prepare('SELECT * FROM learning_tasks WHERE id = ?')
      .get(id) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  },

  listTasksByPlan(planId: string): LearningTask[] {
    return (
      db
        .prepare(
          'SELECT * FROM learning_tasks WHERE plan_id = ? ORDER BY phase_index ASC, sort_order ASC',
        )
        .all(planId) as TaskRow[]
    ).map(toTask);
  },

  /** 更新任务状态（Slice0 对账 R6：返回是否命中，供路由 404 判断） */
  updateTaskStatus(id: string, status: TaskStatus): boolean {
    const completedAt = status === 'done' ? Date.now() : null;
    const info = db
      .prepare('UPDATE learning_tasks SET status = ?, completed_at = ? WHERE id = ?')
      .run(status, completedAt, id);
    return info.changes > 0;
  },

  removeTasksByPlan(planId: string): void {
    db.prepare('DELETE FROM learning_tasks WHERE plan_id = ?').run(planId);
  },
};
