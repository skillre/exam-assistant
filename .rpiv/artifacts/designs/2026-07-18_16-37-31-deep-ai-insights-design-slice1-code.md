Slice 1 code generation — types + schema + repos

## packages/shared/src/types.ts — MODIFY (append after line 207)

新增类型：

```typescript
// ── v3：掌握判定（DEC-32 — consecutive streak） ──────────────
export interface MasteryState {
  questionId: string;
  consecutiveCorrect: number;
  mastered: boolean;
  updatedAt?: number;
}

// ── v3：学情快照（FR4 — 时间序列，DEC-30 落库） ─────────────
export interface TagStat {
  tag: string;
  total: number;
  correct: number;
}

export interface TypeStat {
  type: QuestionType;
  total: number;
  correct: number;
}

export interface InsightSnapshot {
  id: string;
  sessionId: string;
  bankId: string;
  total: number;
  correct: number;
  accuracy: number;
  byTag: TagStat[];
  byType: TypeStat[];
  createdAt: number;
}

// ── v3：学习计划 / 任务（FR2 — DEC-31，两表） ───────────────
export type TaskStatus = 'pending' | 'in_progress' | 'done';
export type PlanStatus = 'active' | 'completed' | 'archived';

export interface LearningPlan {
  id: string;
  bankId: string;
  title: string;
  description?: string;
  phases: AiPhase[];
  status: PlanStatus;
  createdAt: number;
}

export interface LearningTask {
  id: string;
  planId: string;
  title: string;
  phaseIndex: number;
  sortOrder: number;
  scope: PracticeScope;
  status: TaskStatus;
  createdAt: number;
  completedAt?: number;
}

// ── v3：深度错因诊断（FR1 — DEC-33，固定枚举） ──────────────
export type ErrorCategory = 'concept_confusion' | 'calculation_error' | 'misread' | 'knowledge_gap';

export interface ErrorDiagnosis {
  questionId: string;
  stem: string;
  userAnswer: AnswerValue;
  correctAnswer: AnswerValue;
  errorCategory: ErrorCategory;
  distractorNote?: string;
}

export interface DistractorStat {
  questionId: string;
  stem: string;
  optionCounts: { optionIndex: number; optionText: string; count: number; isCorrect: boolean }[];
}

export interface DiagnosisResult {
  errorDiagnoses: ErrorDiagnosis[];
  distractorStats: DistractorStat[];
  errorDistribution: { category: ErrorCategory; count: number }[];
  tagErrorBreakdown: { tag: string; category: ErrorCategory; count: number }[];
}

// ── v3：AI 产出（计划生成，内部用） ─────────────────────────
export interface AiPhase {
  title: string;
  description?: string;
  tasks: AiTask[];
}

export interface AiTask {
  title: string;
  scope: PracticeScope;
}

export interface AiPlan {
  title: string;
  description?: string;
  phases: AiPhase[];
}

// ── v3：趋势（FR4 前端消费） ────────────────────────────────
export interface TrendPoint {
  timestamp: number;
  accuracy: number;
  total: number;
  correct: number;
}

export interface TagTrendPoint {
  timestamp: number;
  accuracy: number;
  total: number;
  correct: number;
}

// ── v3：API 请求 / 响应 ────────────────────────────────────
export interface FinishPracticeResponse extends Scorecard {
  snapshotId: string;
}

export interface SnapshotHistoryQuery {
  bankId?: string;
  limit?: number;
}

export interface CoachGenerateRequest {
  bankId?: string;
}

export interface UpdateTaskRequest {
  status: TaskStatus;
}
```

GradeResponse 扩展（在现有 GradeResponse 里加 optional mastered）：

```typescript
export interface GradeResponse {
  attemptId: string;
  isCorrect: boolean;
  correctAnswer: AnswerValue;
  mastered?: boolean; // v3：判分后自动触发的掌握状态变化
}
```

## packages/server/src/db/schema.ts — MODIFY (在 SCHEMA_SQL 末尾、CREATE INDEX 之前追加)

```sql
CREATE TABLE IF NOT EXISTS mastery_states (
  question_id         TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  consecutive_correct INTEGER NOT NULL DEFAULT 0,
  mastered            INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER
);

CREATE TABLE IF NOT EXISTS insight_snapshots (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL UNIQUE,
  bank_id     TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  total       INTEGER NOT NULL,
  correct     INTEGER NOT NULL,
  accuracy    REAL NOT NULL,
  by_tag      TEXT NOT NULL,
  by_type     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_plans (
  id          TEXT PRIMARY KEY,
  bank_id     TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  phases      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_tasks (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  phase_index  INTEGER NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  scope        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  completed_at INTEGER
);
```

复合索引追加到现有索引块之后：

```sql
CREATE INDEX IF NOT EXISTS idx_attempts_question_time ON attempts(question_id, answered_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_bank ON insight_snapshots(bank_id);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON learning_tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_plans_bank ON learning_plans(bank_id);
```

## packages/server/src/repositories/masteryRepo.ts — NEW

```typescript
import { db } from '../db/index.js';

interface MasteryRow {
  question_id: string;
  consecutive_correct: number;
  mastered: number;
  updated_at: number | null;
}

export const masteryRepo = {
  getOrCreate(questionId: string): { consecutiveCorrect: number; mastered: boolean } {
    let row = db
      .prepare('SELECT * FROM mastery_states WHERE question_id = ?')
      .get(questionId) as MasteryRow | undefined;
    if (!row) {
      db.prepare(
        'INSERT INTO mastery_states (question_id, consecutive_correct, mastered) VALUES (?, 0, 0)',
      ).run(questionId);
      row = { question_id: questionId, consecutive_correct: 0, mastered: 0, updated_at: null };
    }
    return {
      consecutiveCorrect: row.consecutive_correct,
      mastered: row.mastered === 1,
    };
  },

  incrementCorrect(questionId: string): number {
    this.getOrCreate(questionId);
    db.prepare(
      `UPDATE mastery_states SET consecutive_correct = consecutive_correct + 1, updated_at = ? WHERE question_id = ?`,
    ).run(Date.now(), questionId);
    const row = db
      .prepare('SELECT consecutive_correct FROM mastery_states WHERE question_id = ?')
      .get(questionId) as { consecutive_correct: number };
    return row.consecutive_correct;
  },

  reset(questionId: string): void {
    this.getOrCreate(questionId);
    db.prepare(
      'UPDATE mastery_states SET consecutive_correct = 0, updated_at = ? WHERE question_id = ?',
    ).run(Date.now(), questionId);
  },

  getByQuestion(questionId: string): { consecutiveCorrect: number; mastered: boolean } | undefined {
    const row = db
      .prepare('SELECT * FROM mastery_states WHERE question_id = ?')
      .get(questionId) as MasteryRow | undefined;
    if (!row) return undefined;
    return {
      consecutiveCorrect: row.consecutive_correct,
      mastered: row.mastered === 1,
    };
  },

  setMastered(questionId: string, mastered: boolean): void {
    this.getOrCreate(questionId);
    db.prepare(
      'UPDATE mastery_states SET mastered = ?, updated_at = ? WHERE question_id = ?',
    ).run(mastered ? 1 : 0, Date.now(), questionId);
  },
};
```

## packages/server/src/repositories/snapshotRepo.ts — NEW

```typescript
import { randomUUID } from 'node:crypto';
import type { InsightSnapshot, TagStat, TypeStat } from '@exam/shared';
import { db } from '../db/index.js';

interface SnapshotRow {
  id: string;
  session_id: string;
  bank_id: string;
  total: number;
  correct: number;
  accuracy: number;
  by_tag: string;
  by_type: string;
  created_at: number;
}

function toSnapshot(row: SnapshotRow): InsightSnapshot {
  return {
    id: row.id,
    sessionId: row.session_id,
    bankId: row.bank_id,
    total: row.total,
    correct: row.correct,
    accuracy: row.accuracy,
    byTag: JSON.parse(row.by_tag) as TagStat[],
    byType: JSON.parse(row.by_type) as TypeStat[],
    createdAt: row.created_at,
  };
}

export const snapshotRepo = {
  save(params: {
    sessionId: string;
    bankId: string;
    total: number;
    correct: number;
    accuracy: number;
    byTag: TagStat[];
    byType: TypeStat[];
  }): InsightSnapshot | null {
    const id = randomUUID();
    const createdAt = Date.now();
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO insight_snapshots
         (id, session_id, bank_id, total, correct, accuracy, by_tag, by_type, created_at)
         VALUES (@id, @session_id, @bank_id, @total, @correct, @accuracy, @by_tag, @by_type, @created_at)`,
      )
      .run({
        id,
        session_id: params.sessionId,
        bank_id: params.bankId,
        total: params.total,
        correct: params.correct,
        accuracy: params.accuracy,
        by_tag: JSON.stringify(params.byTag),
        by_type: JSON.stringify(params.byType),
        created_at: createdAt,
      });
    if (result.changes === 0) return null;
    return {
      id,
      sessionId: params.sessionId,
      bankId: params.bankId,
      total: params.total,
      correct: params.correct,
      accuracy: params.accuracy,
      byTag: params.byTag,
      byType: params.byType,
      createdAt,
    };
  },

  listByBank(bankId?: string, limit = 50): InsightSnapshot[] {
    if (bankId) {
      return (
        db
          .prepare(
            'SELECT * FROM insight_snapshots WHERE bank_id = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(bankId, limit) as SnapshotRow[]
      ).map(toSnapshot);
    }
    return (
      db
        .prepare('SELECT * FROM insight_snapshots ORDER BY created_at DESC LIMIT ?')
        .all(limit) as SnapshotRow[]
    ).map(toSnapshot);
  },

  countSince(bankId: string | undefined, sinceTimestamp: number): number {
    if (bankId) {
      const row = db
        .prepare(
          'SELECT COUNT(*) as cnt FROM insight_snapshots WHERE bank_id = ? AND created_at > ?',
        )
        .get(bankId, sinceTimestamp) as { cnt: number };
      return row.cnt;
    }
    const row = db
      .prepare('SELECT COUNT(*) as cnt FROM insight_snapshots WHERE created_at > ?')
      .get(sinceTimestamp) as { cnt: number };
    return row.cnt;
  },
};
```

## packages/server/src/repositories/planRepo.ts — NEW

```typescript
import { randomUUID } from 'node:crypto';
import type { LearningPlan, LearningTask, AiPhase, PracticeScope, TaskStatus, PlanStatus } from '@exam/shared';
import { db } from '../db/index.js';

// ── learning_plans ──

interface PlanRow {
  id: string;
  bank_id: string;
  title: string;
  description: string | null;
  phases: string;
  status: string;
  created_at: number;
}

function toPlan(row: PlanRow): LearningPlan {
  return {
    id: row.id,
    bankId: row.bank_id,
    title: row.title,
    description: row.description ?? undefined,
    phases: JSON.parse(row.phases) as AiPhase[],
    status: row.status as PlanStatus,
    createdAt: row.created_at,
  };
}

// ── learning_tasks ──

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
    scope: JSON.parse(row.scope) as PracticeScope,
    status: row.status as TaskStatus,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

export const planRepo = {
  createPlan(bankId: string, title: string, description: string | undefined, phases: AiPhase[]): LearningPlan {
    const id = randomUUID();
    const createdAt = Date.now();
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
    db.prepare('DELETE FROM learning_plans WHERE id = ?').run(id);
  },

  // ── tasks ──

  createTask(
    planId: string,
    title: string,
    phaseIndex: number,
    sortOrder: number,
    scope: PracticeScope,
  ): LearningTask {
    const id = randomUUID();
    const createdAt = Date.now();
    db.prepare(
      `INSERT INTO learning_tasks (id, plan_id, title, phase_index, sort_order, scope, status, created_at)
       VALUES (@id, @plan_id, @title, @phase_index, @sort_order, @scope, 'pending', @created_at)`,
    ).run({
      id,
      plan_id: planId,
      title,
      phase_index: phaseIndex,
      sort_order: sortOrder,
      scope: JSON.stringify(scope),
      created_at: createdAt,
    });
    return { id, planId, title, phaseIndex, sortOrder, scope, status: 'pending', createdAt };
  },

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

  updateTaskStatus(id: string, status: TaskStatus): void {
    const completedAt = status === 'done' ? Date.now() : null;
    db.prepare(
      'UPDATE learning_tasks SET status = ?, completed_at = ? WHERE id = ?',
    ).run(status, completedAt, id);
  },

  removeTasksByPlan(planId: string): void {
    db.prepare('DELETE FROM learning_tasks WHERE plan_id = ?').run(planId);
  },
};
```

## Success Criteria (Slice 1)

#### Automated Verification:
- [ ] Type checking passes: `npm run check`
- [ ] Tests pass: `npm test`

#### Manual Verification:
- [ ] 新 4 张表在 schema.ts 的 SCHEMA_SQL 内，`CREATE TABLE IF NOT EXISTS` 幂等
- [ ] masteryRepo / snapshotRepo / planRepo 的 CRUD 方法签名正确，Row→Entity 映射完整
- [ ] 复合索引 `idx_attempts_question_time` 存在于 schema.ts
