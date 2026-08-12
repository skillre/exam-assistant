---
date: 2026-07-18T16:37:31+0800
author: skillre
commit: 1410d48
branch: main
repository: 考试助手
topic: "学情分析模块深度 AI 赋能 — AI 学习教练"
tags: [design, insights, mastery-loop, trend-tracking, ai-diagnosis, coaching]
status: ready
parent: .rpiv/artifacts/research/2026-07-18_16-02-57_deep-ai-insights.md
last_updated: 2026-07-18T18:10:00+0800
last_updated_by: skillre
---

# Design: 学情分析模块深度 AI 赋能 — AI 学习教练

## Summary

在现有 Fastify + SQLite + pi SDK + React 架构上，新增 4 张表（`mastery_states` / `insight_snapshots` / `learning_plans` / `learning_tasks`），将学情模块从无时间维度的横截面读物升级为具备深度错因诊断、可执行学习计划与任务、掌握闭环自动判定、长期趋势跟踪的 AI 学习教练。核心路径：`mastery_states` 增量计数列在判分后自动判定掌握 → `POST /practice/:id/finish` 落快照到 `insight_snapshots` → 趋势查询走 SQLite JSON1 → AI 结构化产出走 `runOnce + extractJsonArray + zod`（照搬 `parseWithAi.ts` 范式）→ 计划/任务落两表、任务存完整 PracticeScope 一键开练。

## Requirements

（摘自 FRD + Research Developer Context）

- FR1：AI 结合题目内容、用户选的错误选项、答疑追问，归纳错因类型（概念混淆/计算失误/审题不仔/知识盲区），结果落库可追溯
- FR2：AI 产出分阶段学习计划 + 拆解为一键开练的具体任务，任务存 PracticeScope JSON 直接 POST /practice/start
- FR3：掌握判定基于"连续 N 次稳定达标"（增量 consecutive_correct 列），达阈自动 setMastered，与错题本软标记兼容
- FR4：阶段快照固定落库形成时间序列；整体正确率曲线 + 每知识点趋势可查看
- FR5：面板即时（REST）+ AI 深度产出按需生成（SSE 人读报告 / runOnce 结构化落库）

## Current State Analysis

### Key Discoveries

- `LearningDataCollector.collect()`（`LearningDataCollector.ts:23`）产出 4 字段横截面快照，`queryAttemptTags()`（`:36-49`）故意只 SELECT `is_correct, tags`，**不含每题细节**
- 判分后零 post-hook（`quiz.ts:82-88`，`attemptRepo.record()` 后立即返回）；mastery 100% 手动（`wrongBookRepo.setMastered` 仅被一个按钮路由调用）
- `POST /api/practice/start`（`quiz.ts:113`）直接接受任意 `PracticeScope`，无 mode 白名单——任务→练习桥已通
- `buildScorecard()`（`quiz.ts:183`）已产出 `byTag:{tag,total,correct}[]`，映射 `insight_snapshots.by_tag` 无 gap
- `parseWithAi.ts` 的 `runOnce + extractJsonArray + zod` 范式是结构化 AI 产出的模板
- `DrillFilter`（`App.tsx:21`）只带 `{bankId,tag,type}`，缺 `mode+shuffle`，需扩展到完整 `PracticeScope`
- `QuizPage` 初始 scope 消费（`:47-54`）不处理 `shuffle`，需补上
- `req<T>()` 包装器空 body + JSON header 曾致 400（`1410d48` 已修但脆弱）
- 无 migration 机制——`SCHEMA_SQL` 用 `CREATE TABLE IF NOT EXISTS`，只加新表不改列

### Constraints

- 单实例本地部署，无 cron / 常驻定时任务
- 结构化数据走 REST 即时，AI 文本走 SSE 流式（延续 DEC-24）
- 新增类型一律加入 `@exam/shared`（NFR3）
- 不引入重型图表库（NFR5）

## Scope

### Building

- 4 张新表：`mastery_states`（掌握 streak）、`insight_snapshots`（时间序列快照）、`learning_plans`（学习计划）、`learning_tasks`（任务）
- 掌握闭环：判分后 streak 计数 hook + 自动 setMastered
- 快照落库：`POST /practice/:id/finish` + 幂等 UNIQUE(session_id)
- 趋势查询：`GET /api/insights/history`（整体 + per-tag 时间序列，JSON1）
- 深度错因诊断：新 collector + AI runOnce + 固定错因枚举 + 结构化落库
- 学习计划/任务：两表 + AI 生成 + CRUD + 一键开练
- 前端：趋势图组件（纯 CSS/SVG）、诊断面板、计划面板、DrillFilter→PracticeScope 扩展

### Not Building

- 不改已有架构决策（继承 DEC-1..28 + 本次 DEC-29..36）
- 不引入新存储引擎（时序库、向量库等）
- 不改已有表结构（零 ALTER TABLE，4 张新表替代加列）
- 不引入重型图表库
- 不做主观题、多端同步、账号体系
- 不做 cron / 定时任务（快照触发走练习完成）
- 不做自动 AI 产出（按需生成，面板即时）

## Decisions

### D1: 掌握计数 — 增量 consecutive_correct 列

**Ambiguity**: "连续 N 次达标"的计数窗口是增量列还是实时查 attempts？
**Explored**:
- Option A: `mastery_states.consecutive_correct` 增量列（判分 hook 里答对+1答错归0）— O(1) 读写，`wrongBookRepo.ts:18` setMastered UPSERT 幂等
- Option B: 每次查 `attemptRepo.recentAttemptsByQuestion(qid, K)` — O(K) 查询，需复合索引 `idx_attempts_question_time`
**Decision**: **Option A** — 增量列。简单、O(1)、与 setMastered 幂等兼容。

### D2: 计划/任务数据模型 — 两表

**Ambiguity**: learning_plans 与 learning_tasks 是两张表还是一张表带层级？
**Decision**: **两表**。plans 头存策略概述，tasks 一对一关联 plans，scope JSON 直接喂 `/practice/start`。同构于 `practiceRepo.ts:15-49` 的 JSON 列范式。

### D3: 干扰项分析位置 — 后端聚合一份，面板与 AI 共用

**Decision**: 新 collector 后端聚合每道错题的错误选项分布，一份数据供前端面板和 AI prompt 共用，避免重复计算。

### D4: 缓存失效 — 新增题量 + 任务完成两信号

**Decision**: 距上次 AI 产出后新增 ≥ N 题 attempts 或有任务完成事件时，面板提示"可重新生成"。不靠墙钟。

### D5: 快照落库触发 — POST /practice/:id/finish

**Decision**: 新增 `POST /api/practice/:id/finish`，内部调 `buildScorecard` 后 INSERT `insight_snapshots`（UNIQUE session_id 幂等）。前端 `finish()` 改为调此端点，返回 Scorecard。

### D6: 闭环联动 — streak 单一驱动，任务完成为派生

**Decision**: 掌握状态唯一由判分 hook 的 streak 写入；任务完成 = 其 scope 下题目全部达标（查 `mastery_states` 派生）。单一真相源，天然幂等。

### D7: AI 结构化产出 — runOnce + zod + 固定错因枚举

**Decision**: 错因归类/计划/任务均用 `ai.runOnce` 拿完整文本 → `extractJsonArray` → zod 校验 → 落库（`parseWithAi.ts` 范式）。错因枚举固定：概念混淆/计算失误/审题不仔/知识盲区。

### D8: 掌握阈值 N = 3

**Decision**: 连续答对 3 次自动标记掌握（`MASTERY_THRESHOLD = 3` 常量），可通过环境变量覆盖。

## Architecture

### packages/shared/src/types.ts — MODIFY
新增类型定义（全模块共享）。

```typescript
// ── 掌握度追踪（Slice 2） ──────────────────────────────
export interface MasteryState {
  questionId: string;
  consecutiveCorrect: number;
  mastered: boolean;
  masteredAt?: number;
}

// ── 成绩单完成响应（Slice 3） ────────────────────────────
export interface FinishPracticeResponse {
  scorecard: Scorecard;
  snapshotId: string;
}

// ── 趋势追踪（Slice 4） ────────────────────────────────
export interface TrendPoint {
  ts: number;
  accuracy: number; // 0..1
  total: number;
}

export interface TagTrendPoint {
  ts: number;
  tag: string;
  accuracy: number; // 0..1
  total: number;
}

export interface TrendHistoryResponse {
  overall: TrendPoint[];
  byTag: TagTrendPoint[];
}

// ── 错误诊断（Slice 5） ────────────────────────────────
export type ErrorCategory = 'concept_confusion' | 'calculation_error' | 'misread' | 'knowledge_gap';

export interface DiagnosisResult {
  questionId: string;
  stem: string;
  userAnswer: string;
  correctAnswer: string;
  errorCategory: ErrorCategory;
  distractorNote: string;
}

export interface DiagnosisResponse {
  results: DiagnosisResult[];
}

// ── AI 学习计划（Slice 6） ─────────────────────────────
export interface AiTask {
  title: string;
  scope: PracticeScope;
}

export interface AiPhase {
  title: string;
  description: string;
  tasks: AiTask[];
}

export interface AiPlan {
  title: string;
  phases: AiPhase[];
}

export interface LearningTask {
  id: string;
  planId: string;
  phaseIndex: number;
  title: string;
  scope: PracticeScope;
  status: 'pending' | 'in_progress' | 'done';
  createdAt: number;
}

export interface LearningPlan {
  id: string;
  title: string;
  phases: AiPhase[];
  createdAt: number;
}
```

### packages/server/src/db/schema.ts — MODIFY
4 张新表 + 复合索引追加到 SCHEMA_SQL。

```sql
-- ── 新增表：question_mastery（掌握度追踪，Slice 2） ──
CREATE TABLE IF NOT EXISTS question_mastery (
  question_id         TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  consecutive_correct INTEGER NOT NULL DEFAULT 0,
  mastered            INTEGER NOT NULL DEFAULT 0,
  mastered_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mastery_mastered ON question_mastery(mastered);

-- ── 新增表：insight_snapshots（学情快照，Slice 3） ──
CREATE TABLE IF NOT EXISTS insight_snapshots (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL UNIQUE,          -- 练习会话 ID（幂等）
  bank_id        TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  total          INTEGER NOT NULL,              -- 题目总数
  correct        INTEGER NOT NULL,              -- 正确数
  accuracy       REAL NOT NULL,                 -- 正确率 0..1
  by_tag         TEXT NOT NULL,                 -- JSON: [{tag, total, correct}]
  by_type        TEXT NOT NULL,                 -- JSON: [{type, total, correct}]
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_bank ON insight_snapshots(bank_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON insight_snapshots(created_at);

-- ── 新增表：诊断结果 + 学习计划（Slice 5 & 6） ──
CREATE TABLE IF NOT EXISTS diagnosis_results (
  id         TEXT PRIMARY KEY,
  bank_id    TEXT,                          -- NULL = 全局
  results    TEXT NOT NULL,                 -- JSON: DiagnosisResult[]
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diagnosis_time ON diagnosis_results(created_at);

CREATE TABLE IF NOT EXISTS learning_plans (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  phases     TEXT NOT NULL,                 -- JSON: AiPhase[]
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_tasks (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,
  phase_index INTEGER NOT NULL,
  title       TEXT NOT NULL,
  scope       TEXT NOT NULL,                -- JSON: PracticeScope
  status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done')),
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_plan ON learning_tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON learning_tasks(status);

-- ── 复合索引：按题查询最近作答（Slice 2 辅助） ──
CREATE INDEX IF NOT EXISTS idx_attempts_question_time ON attempts(question_id, answered_at DESC);
```

### packages/server/src/repositories/masteryRepo.ts — NEW
mastery_states 表仓储：getOrCreate / incrementCorrect / reset / getByQuestion。

```typescript
// FILE: packages/server/src/repositories/masteryRepo.ts
import { db } from '../db/index.js';

// 掌握度仓储：追踪每题连续答对次数，达标即标记 mastered。
// 复用 wrong_book_state 的语义：mastered=true 的题从错题本列表消失。

interface MasteryRow {
  question_id: string;
  consecutive_correct: number;
  mastered: number; // 0/1
  mastered_at: number | null;
}

export const masteryRepo = {
  /** 递增连续答对次数；达标后标记 mastered。返回递增后的连续次数。 */
  incrementCorrect(questionId: string): number {
    db.prepare(
      `INSERT INTO question_mastery (question_id, consecutive_correct, mastered, mastered_at)
       VALUES (@qid, 1, 0, NULL)
       ON CONFLICT(question_id) DO UPDATE SET
         consecutive_correct = consecutive_correct + 1,
         mastered = CASE
           WHEN consecutive_correct + 1 >= @threshold THEN 1
           ELSE mastered
         END,
         mastered_at = CASE
           WHEN consecutive_correct + 1 >= @threshold THEN @now
           ELSE mastered_at
         END`,
    ).run({ qid: questionId, threshold: 3, now: Date.now() });

    const row = db
      .prepare('SELECT consecutive_correct FROM question_mastery WHERE question_id = ?')
      .get(questionId) as MasteryRow | undefined;
    return row?.consecutive_correct ?? 1;
  },

  /** 答错：重置连续计数为 0，取消 mastered 状态 */
  resetConsecutive(questionId: string): void {
    db.prepare(
      `INSERT INTO question_mastery (question_id, consecutive_correct, mastered, mastered_at)
       VALUES (@qid, 0, 0, NULL)
       ON CONFLICT(question_id) DO UPDATE SET
         consecutive_correct = 0,
         mastered = 0,
         mastered_at = NULL`,
    ).run({ qid: questionId });
  },

  /** 查询某题的掌握度状态 */
  get(questionId: string): MasteryRow | undefined {
    return db
      .prepare('SELECT * FROM question_mastery WHERE question_id = ?')
      .get(questionId) as MasteryRow | undefined;
  },

  /** 批量查询：返回已掌握的 question_id 集合 */
  listMasteredIds(): Set<string> {
    const rows = db
      .prepare('SELECT question_id FROM question_mastery WHERE mastered = 1')
      .all() as { question_id: string }[];
    return new Set(rows.map((r) => r.question_id));
  },
};
```

### packages/server/src/repositories/snapshotRepo.ts — NEW
insight_snapshots 表仓储：save / listHistory / listHistoryByTag。

```typescript
// FILE: packages/server/src/repositories/snapshotRepo.ts
import { randomUUID } from 'node:crypto';
import type { QuestionType } from '@exam/shared';
import { db } from '../db/index.js';

// 学情快照仓储：每次完成练习时落库一条快照，供趋势追踪查询。
// save() 签名：(sessionId, bankId, total, correct, accuracy, byTag, byType) — 幂等 UNIQUE(session_id)。

interface SnapshotInput {
  sessionId: string;
  bankId: string;
  total: number;
  correct: number;
  accuracy: number;
  byTag: { tag: string; total: number; correct: number }[];
  byType: { type: QuestionType; total: number; correct: number }[];
}

interface SnapshotRow {
  id: string;
  session_id: string;
  bank_id: string;
  total: number;
  correct: number;
  accuracy: number;
  by_tag: string;    // JSON
  by_type: string;   // JSON
  created_at: number;
}

export interface InsightSnapshot {
  id: string;
  sessionId: string;
  bankId: string;
  total: number;
  correct: number;
  accuracy: number;
  byTag: { tag: string; total: number; correct: number }[];
  byType: { type: QuestionType; total: number; correct: number }[];
  createdAt: number;
}

function toSnapshot(row: SnapshotRow): InsightSnapshot {
  return {
    id: row.id,
    sessionId: row.session_id,
    bankId: row.bank_id,
    total: row.total,
    correct: row.correct,
    accuracy: row.accuracy,
    byTag: JSON.parse(row.by_tag) as InsightSnapshot['byTag'],
    byType: JSON.parse(row.by_type) as InsightSnapshot['byType'],
    createdAt: row.created_at,
  };
}

export const snapshotRepo = {
  /**
   * 保存一条学情快照，返回 snapshot id。
   * 签名：(sessionId, bankId, total, correct, accuracy, byTag, byType)
   * UNIQUE(session_id) 确保同一练习多次调用 /finish 不重复落库。
   */
  save(
    sessionId: string,
    bankId: string,
    total: number,
    correct: number,
    accuracy: number,
    byTag: { tag: string; total: number; correct: number }[],
    byType: { type: QuestionType; total: number; correct: number }[],
  ): string {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO insight_snapshots
         (id, session_id, bank_id, total, correct, accuracy, by_tag, by_type, created_at)
       VALUES (@id, @session_id, @bank_id, @total, @correct, @accuracy, @by_tag, @by_type, @created_at)`,
    ).run({
      id,
      session_id: sessionId,
      bank_id: bankId,
      total,
      correct,
      accuracy,
      by_tag: JSON.stringify(byTag),
      by_type: JSON.stringify(byType),
      created_at: now,
    });
    return id;
  },

  /** 获取所有快照（趋势用），按时间升序 */
  listAll(bankId?: string): InsightSnapshot[] {
    if (bankId) {
      const rows = db
        .prepare('SELECT * FROM insight_snapshots WHERE bank_id = ? ORDER BY created_at ASC')
        .all(bankId) as SnapshotRow[];
      return rows.map(toSnapshot);
    }
    const rows = db
      .prepare('SELECT * FROM insight_snapshots ORDER BY created_at ASC')
      .all() as SnapshotRow[];
    return rows.map(toSnapshot);
  },

  /** 获取最新一条快照（某题库或全局） */
  getLatest(bankId?: string): InsightSnapshot | undefined {
    if (bankId) {
      const row = db
        .prepare('SELECT * FROM insight_snapshots WHERE bank_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(bankId) as SnapshotRow | undefined;
      return row ? toSnapshot(row) : undefined;
    }
    const row = db
      .prepare('SELECT * FROM insight_snapshots ORDER BY created_at DESC LIMIT 1')
      .get() as SnapshotRow | undefined;
    return row ? toSnapshot(row) : undefined;
  },
};
```

### packages/server/src/repositories/planRepo.ts — NEW
learning_plans + learning_tasks 表仓储（两表合一文件）。

```typescript
// FILE: packages/server/src/repositories/planRepo.ts
import { randomUUID } from 'node:crypto';
import type { AiPhase, LearningPlan, LearningTask, PracticeScope } from '@exam/shared';
import { db } from '../db/index.js';

// 学习计划 + 任务仓储（Slice 6）。

interface PlanRow {
  id: string;
  title: string;
  phases: string; // JSON
  created_at: number;
}

interface TaskRow {
  id: string;
  plan_id: string;
  phase_index: number;
  title: string;
  scope: string; // JSON
  status: string;
  created_at: number;
}

function toPlan(row: PlanRow): LearningPlan {
  return {
    id: row.id,
    title: row.title,
    phases: JSON.parse(row.phases) as AiPhase[],
    createdAt: row.created_at,
  };
}

function toTask(row: TaskRow): LearningTask {
  return {
    id: row.id,
    planId: row.plan_id,
    phaseIndex: row.phase_index,
    title: row.title,
    scope: JSON.parse(row.scope) as PracticeScope,
    status: row.status as LearningTask['status'],
    createdAt: row.created_at,
  };
}

export const planRepo = {
  /** 创建学习计划 + 批量创建任务（事务原子） */
  createPlan(title: string, phases: AiPhase[]): { planId: string; taskCount: number } {
    const planId = randomUUID();
    const now = Date.now();

    const run = db.transaction(() => {
      db.prepare(
        `INSERT INTO learning_plans (id, title, phases, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(planId, title, JSON.stringify(phases), now);

      let count = 0;
      const taskStmt = db.prepare(
        `INSERT INTO learning_tasks (id, plan_id, phase_index, title, scope, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      );
      for (let pi = 0; pi < phases.length; pi++) {
        const phase = phases[pi]!;
        for (const task of phase.tasks) {
          taskStmt.run(randomUUID(), planId, pi, task.title, JSON.stringify(task.scope), now);
          count++;
        }
      }
      return count;
    });

    const taskCount = run();
    return { planId, taskCount };
  },

  /** 获取单个计划 */
  getPlan(id: string): LearningPlan | undefined {
    const row = db.prepare('SELECT * FROM learning_plans WHERE id = ?').get(id) as PlanRow | undefined;
    return row ? toPlan(row) : undefined;
  },

  /** 列出所有计划（按时间降序） */
  listPlans(): LearningPlan[] {
    const rows = db
      .prepare('SELECT * FROM learning_plans ORDER BY created_at DESC')
      .all() as PlanRow[];
    return rows.map(toPlan);
  },

  /** 列出某计划的所有任务 */
  listTasks(planId: string): LearningTask[] {
    const rows = db
      .prepare('SELECT * FROM learning_tasks WHERE plan_id = ? ORDER BY phase_index, created_at')
      .all(planId) as TaskRow[];
    return rows.map(toTask);
  },

  /** 更新任务状态 */
  updateTaskStatus(taskId: string, status: LearningTask['status']): boolean {
    return db
      .prepare('UPDATE learning_tasks SET status = ? WHERE id = ?')
      .run(status, taskId).changes > 0;
  },

  /** 获取单个任务 */
  getTask(taskId: string): LearningTask | undefined {
    const row = db.prepare('SELECT * FROM learning_tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  },
};
```

### packages/server/src/repositories/diagnosisRepo.ts — NEW
诊断结果仓储：缓存 AI 诊断输出，避免重复调用。

```typescript
// FILE: packages/server/src/repositories/diagnosisRepo.ts
import { randomUUID } from 'node:crypto';
import type { DiagnosisResult } from '@exam/shared';
import { db } from '../db/index.js';

// 诊断结果仓储：缓存 AI 诊断输出，避免重复调用。

interface DiagnosisRow {
  id: string;
  bank_id: string | null;
  results: string; // JSON
  created_at: number;
}

export interface DiagnosisRecord {
  id: string;
  bankId: string | null;
  results: DiagnosisResult[];
  createdAt: number;
}

function toRecord(row: DiagnosisRow): DiagnosisRecord {
  return {
    id: row.id,
    bankId: row.bank_id,
    results: JSON.parse(row.results) as DiagnosisResult[],
    createdAt: row.created_at,
  };
}

export const diagnosisRepo = {
  /** 保存诊断结果 */
  save(bankId: string | null, results: DiagnosisResult[]): string {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO diagnosis_results (id, bank_id, results, created_at)
       VALUES (@id, @bank_id, @results, @created_at)`,
    ).run({
      id,
      bank_id: bankId,
      results: JSON.stringify(results),
      created_at: now,
    });
    return id;
  },

  /** 获取最新一条诊断结果 */
  getLatest(bankId?: string): DiagnosisRecord | undefined {
    if (bankId) {
      const row = db
        .prepare('SELECT * FROM diagnosis_results WHERE bank_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(bankId) as DiagnosisRow | undefined;
      return row ? toRecord(row) : undefined;
    }
    const row = db
      .prepare('SELECT * FROM diagnosis_results WHERE bank_id IS NULL ORDER BY created_at DESC LIMIT 1')
      .get() as DiagnosisRow | undefined;
    return row ? toRecord(row) : undefined;
  },
};
```

### packages/server/src/services/masteryService.ts — NEW
判分后 streak 更新 + 自动 setMastered 逻辑。

```typescript
// FILE: packages/server/src/services/masteryService.ts
import { masteryRepo } from '../repositories/masteryRepo.js';
import { wrongBookRepo } from '../repositories/wrongBookRepo.js';

// 掌握度闭环服务（Slice 2）：判分后自动追踪连续答对次数。
// 达标阈值 = 连续答对 3 次 → 标记 mastered → 从错题本消失。

const MASTERY_THRESHOLD = 3;

/**
 * 判分后调用：更新掌握度状态。
 * - 正确：递增连续计数，达标则标记 mastered + 同步错题本。
 * - 错误：重置连续计数（仅重置 streak，不取消错题本"已掌握"标记）。
 * 返回 true 表示本题刚达标（通知前端可展示鼓励提示）。
 *
 * FIX: 答错时只重置 streak，不调用 wrongBookRepo.setMastered(false)。
 * 原因：掌握后偶尔错一次不应立即取消已掌握状态，应由用户手动管理。
 */
export function checkMasteryAfterGrade(questionId: string, isCorrect: boolean): boolean {
  if (isCorrect) {
    const consecutive = masteryRepo.incrementCorrect(questionId);
    if (consecutive >= MASTERY_THRESHOLD) {
      // 同步错题本：标记"已掌握"（从错题本列表消失，可恢复）
      wrongBookRepo.setMastered(questionId, true);
      return true;
    }
    return false;
  } else {
    masteryRepo.resetConsecutive(questionId);
    // FIX: 仅重置 streak，不调用 wrongBookRepo.setMastered(questionId, false)
    // 掌握后的偶尔失误不应自动取消错题本的已掌握标记
    return false;
  }
}
```

### packages/server/src/routes/quiz.ts:74-92 — MODIFY
grade handler 后追加 mastery hook 调用。

```typescript
// FILE: packages/server/src/routes/quiz.ts — MODIFIED (grade handler + finish endpoint)
// ── Changes ──
// 1. Import masteryService + snapshotRepo
// 2. After attemptRepo.record(), call checkMasteryAfterGrade
// 3. Add `mastered` to GradeResponse
// 4. Add POST /api/practice/:id/finish endpoint

// ── New imports (add at top) ──
import { checkMasteryAfterGrade } from '../services/masteryService.js';
import { snapshotRepo } from '../repositories/snapshotRepo.js';

// ── GradeResponse 扩展 ──
export interface GradeResponse {
  attemptId: string;
  isCorrect: boolean;
  correctAnswer: AnswerValue;
  mastered: boolean; // 新增：本题是否刚达标
}

// ── 替换后的 grade handler ──
app.post<{ Body: GradeRequest }>('/api/quiz/grade', async (req, reply) => {
  const { questionId, userAnswer } = req.body ?? {};
  if (!questionId || userAnswer === undefined) {
    return reply.code(400).send({ error: 'questionId/userAnswer 必填' });
  }
  const question = questionRepo.get(questionId);
  if (!question) return reply.code(404).send({ error: '题目不存在' });

  const isCorrect = gradeQuestion(question, userAnswer);
  const attemptId = attemptRepo.record(questionId, userAnswer, isCorrect);

  // Slice 2: 掌握度闭环
  const mastered = checkMasteryAfterGrade(questionId, isCorrect);

  const res: GradeResponse = {
    attemptId,
    isCorrect,
    correctAnswer: question.answer,
    mastered,
  };
  return res;
});

// ── Slice 3: 新增 finish endpoint ──
app.post<{ Params: { id: string } }>('/api/practice/:id/finish', async (req, reply) => {
  const session = practiceRepo.get(req.params.id);
  if (!session) return reply.code(404).send({ error: '练习会话不存在' });

  const sc = buildScorecard(session.id, session.questionIds);

  // 保存学情快照到 insight_snapshots 表（供趋势追踪用）
  // 使用 session.id 作为 sessionId 实现幂等（UNIQUE 约束）
  const snapshotId = snapshotRepo.save(
    session.id,           // sessionId — 幂等键
    session.bankId,       // bankId
    sc.total,             // total — 题目总数（buildScorecard 产出）
    sc.correct,           // correct — 正确数
    sc.accuracy,          // accuracy — 正确率 0..1
    sc.byTag,             // byTag — [{tag, total, correct}]
    sc.byType,            // byType — [{type, total, correct}]
  );

  return { scorecard: sc, snapshotId };
});
```

### packages/server/src/routes/quiz.ts — MODIFY (finish endpoint)
新增 `POST /api/practice/:id/finish`。

（已在上方 quiz.ts 代码块中合并，避免重复。）

### packages/client/src/api/client.ts — MODIFY
新增 `finishPractice` / `getSnapshotHistory` / `getDiagnosis` / 计划 CRUD 等 REST 方法。

```typescript
// FILE: packages/client/src/api/client.ts — MODIFIED (add coach + snapshot endpoints)
// ── Add these imports ──
import type {
  // ... existing imports ...
  FinishPracticeResponse,  // Slice 3
  TrendHistoryResponse,    // Slice 4
  DiagnosisResult,         // Slice 5
  LearningPlan,            // Slice 6
  LearningTask,            // Slice 6
} from '@exam/shared';

// ── Add to the api object ──

  // ── Slice 3：完成练习（成绩单 + 快照保存） ──
  finishPractice: (id: string) =>
    req<FinishPracticeResponse>(`/api/practice/${id}/finish`, { method: 'POST' }),

  // ── Slice 4：趋势历史 ──
  getTrendHistory: (bankId?: string) =>
    req<TrendHistoryResponse>(
      `/api/insights/history${bankId ? `?bankId=${encodeURIComponent(bankId)}` : ''}`,
    ),

  // ── Slice 5：诊断 ──
  getDiagnosis: (bankId?: string) =>
    req<{ results: DiagnosisResult[]; createdAt?: number }>(
      `/api/coach/diagnosis/latest${bankId ? `?bankId=${encodeURIComponent(bankId)}` : ''}`,
    ),

  // ── Slice 6：学习计划 ──
  listPlans: () => req<LearningPlan[]>('/api/coach/plan'),
  getPlanTasks: (planId: string) => req<LearningTask[]>(`/api/coach/plan/${planId}/tasks`),
  updateTaskStatus: (taskId: string, status: LearningTask['status']) =>
    req<void>(`/api/coach/task/${taskId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
```

### packages/client/src/pages/QuizPage.tsx — MODIFY (finish)
`finish()` 改为 POST /practice/:id/finish。

```typescript
// FILE: packages/client/src/pages/QuizPage.tsx — MODIFIED (finish function + autoStart + shuffle)
// ── Changes ──
// 1. finish() calls api.finishPractice instead of direct scorecard build
// 2. Props extended with autoStart
// 3. initialScope consumes full PracticeScope including shuffle

// ── Modified Props ──
interface Props {
  initialScope?: Partial<PracticeScope> | null;
  autoStart?: boolean; // 新增：一键开练时自动开始
  onNavigateWrong?: () => void;
}

// ── Modified finish function ──
  async function finish() {
    if (!session) return;
    try {
      const resp = await api.finishPractice(session.id);
      setScorecard(resp.scorecard);
    } catch (e) {
      setError((e as Error).message);
    }
  }

// ── Modified useEffect for initialScope ──
  useEffect(() => {
    if (initialScope?.bankId) setBankId(initialScope.bankId);
    if (initialScope?.mode) setMode(initialScope.mode);
    if (initialScope?.shuffle) setShuffle(initialScope.shuffle);
    if (initialScope?.tag) {
      setTag(initialScope.tag);
      setMode('byTag');
    }
    if (initialScope?.type) {
      setQType(initialScope.type);
      setMode('byType');
    }
  }, [initialScope]);

// ── New useEffect: auto-start when autoStart is true ──
  useEffect(() => {
    if (autoStart && initialScope?.bankId && !session) {
      // Delay slightly to ensure state updates from initialScope effect are applied
      const timer = setTimeout(() => start(), 100);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, initialScope?.bankId]);
```

### packages/server/src/insights/snapshotHistory.ts — NEW
趋势查询逻辑：整体 + per-tag 时间序列，JSON1 查询。

```typescript
// FILE: packages/server/src/insights/snapshotHistory.ts
import type { TrendPoint, TagTrendPoint, TrendHistoryResponse } from '@exam/shared';
import { snapshotRepo } from '../repositories/snapshotRepo.js';

// 趋势追踪：从 insight_snapshots 表查询历史快照，构建整体正确率曲线 + 按标签趋势。

/**
 * 构建趋势数据（Slice 4）。
 * bankId 可选：限定某题库，否则全量聚合。
 */
export function buildTrendHistory(bankId?: string): TrendHistoryResponse {
  const snapshots = snapshotRepo.listAll(bankId);

  // 整体正确率曲线
  const overall: TrendPoint[] = snapshots.map((s) => ({
    ts: s.createdAt,
    accuracy: s.accuracy,
    total: s.total,
  }));

  // 按标签趋势：展平每个快照的 byTag 数组
  const byTag: TagTrendPoint[] = [];
  for (const s of snapshots) {
    for (const entry of s.byTag) {
      const total = entry.total;
      if (total === 0) continue;
      byTag.push({
        ts: s.createdAt,
        tag: entry.tag,
        accuracy: total > 0 ? entry.correct / total : 0,
        total,
      });
    }
  }

  return { overall, byTag };
}
```

### packages/server/src/routes/insights.ts — MODIFY
新增 `GET /api/insights/history` 路由。

```typescript
// FILE: packages/server/src/routes/insights.ts — MODIFIED (add history route)
// ── New import (add at top) ──
import { buildTrendHistory } from '../insights/snapshotHistory.js';

// ── Add this new route inside registerInsightsRoutes ──
  // ── Slice 4：趋势历史（REST 即时） ──
  app.get<{ Querystring: { bankId?: string } }>('/api/insights/history', async (req) => {
    return buildTrendHistory(req.query?.bankId);
  });
```

### packages/client/src/components/TrendChart.tsx — NEW
纯 CSS/SVG 趋势图组件（整体曲线 + 每知识点折线）。

```tsx
// FILE: packages/client/src/components/TrendChart.tsx
import { useMemo } from 'react';
import type { TrendHistoryResponse } from '@exam/shared';

interface Props {
  data: TrendHistoryResponse;
}

// 纯 SVG 趋势图（Slice 4）。整体正确率折线 + 按标签趋势。
// 模式 InsightsPanel.tsx 的 Ring/bar-row 纯 CSS/SVG 风格（DEC-26：不引图表库）。

const COLORS = ['#4f8ef7', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

export function TrendChart({ data }: Props) {
  const { overall, byTag } = data;

  // 按标签分组
  const tagGroups = useMemo(() => {
    const map = new Map<string, { ts: number; accuracy: number; total: number }[]>();
    for (const pt of byTag) {
      const arr = map.get(pt.tag) ?? [];
      arr.push({ ts: pt.ts, accuracy: pt.accuracy, total: pt.total });
      map.set(pt.tag, arr);
    }
    // 按最新正确率降序，取前 6 条标签
    return [...map.entries()]
      .map(([tag, points]) => ({ tag, points }))
      .sort((a, b) => {
        const aLast = a.points[a.points.length - 1]?.accuracy ?? 0;
        const bLast = b.points[b.points.length - 1]?.accuracy ?? 0;
        return bLast - aLast;
      })
      .slice(0, 6);
  }, [byTag]);

  if (overall.length === 0) {
    return <p className="muted">暂无趋势数据。完成更多练习后可查看趋势。</p>;
  }

  return (
    <div className="card">
      <h3 style={{ fontSize: 15, margin: '0 0 12px' }}>正确率趋势</h3>

      {/* 整体正确率折线图 */}
      <OverallLineChart points={overall} />

      {/* 按标签趋势条形 */}
      {tagGroups.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>按知识点趋势</h3>
          {tagGroups.map((g, i) => (
            <TagTrendRow key={g.tag} tag={g.tag} points={g.points} color={COLORS[i % COLORS.length]!} />
          ))}
        </>
      )}
    </div>
  );
}

// ── 整体正确率折线图（SVG） ──

function OverallLineChart({ points }: { points: { ts: number; accuracy: number; total: number }[] }) {
  const W = 320;
  const H = 140;
  const PAD = { top: 10, right: 10, bottom: 24, left: 36 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  if (points.length < 2) {
    const pt = points[0]!;
    const cx = PAD.left + plotW / 2;
    const cy = PAD.top + (1 - pt.accuracy) * plotH;
    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        <AxisLabels pad={PAD} plotH={plotH} />
        <circle cx={cx} cy={cy} r={4} fill="var(--accent)" />
        <text x={cx} y={cy - 8} textAnchor="middle" fill="var(--text)" fontSize={11}>
          {Math.round(pt.accuracy * 100)}%
        </text>
      </svg>
    );
  }

  const tsMin = points[0]!.ts;
  const tsMax = points[points.length - 1]!.ts;
  const tsRange = Math.max(tsMax - tsMin, 1);
  const xOf = (ts: number) => PAD.left + ((ts - tsMin) / tsRange) * plotW;
  const yOf = (acc: number) => PAD.top + (1 - acc) * plotH;

  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.ts).toFixed(1)},${yOf(p.accuracy).toFixed(1)}`).join(' ');

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      <AxisLabels pad={PAD} plotH={plotH} />
      {[0, 0.25, 0.5, 0.75, 1].map((v) => (
        <line
          key={v}
          x1={PAD.left}
          y1={yOf(v)}
          x2={W - PAD.right}
          y2={yOf(v)}
          stroke="var(--border)"
          strokeWidth={0.5}
        />
      ))}
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={i} cx={xOf(p.ts)} cy={yOf(p.accuracy)} r={3} fill="var(--accent)" />
      ))}
    </svg>
  );
}

function AxisLabels({ pad, plotH }: { pad: { top: number; left: number; bottom: number; right: number }; plotH: number }) {
  return (
    <>
      {[0, 0.5, 1].map((v) => (
        <text
          key={v}
          x={pad.left - 4}
          y={pad.top + (1 - v) * plotH + 4}
          textAnchor="end"
          fill="var(--muted)"
          fontSize={10}
        >
          {Math.round(v * 100)}%
        </text>
      ))}
    </>
  );
}

// ── 按标签趋势行（迷你条形 + 最新正确率） ──

function TagTrendRow({ tag, points, color }: {
  tag: string;
  points: { ts: number; accuracy: number; total: number }[];
  color: string;
}) {
  const latest = points[points.length - 1]!;
  const pct = Math.round(latest.accuracy * 100);
  const prev = points.length >= 2 ? points[points.length - 2]! : null;
  const delta = prev ? Math.round((latest.accuracy - prev.accuracy) * 100) : 0;
  const deltaLabel = delta > 0 ? `↑${delta}` : delta < 0 ? `↓${Math.abs(delta)}` : '';

  return (
    <div className="bar-row">
      <div className="bar-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
        {tag}
      </div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="bar-val muted">
        {pct}%
        {deltaLabel && (
          <span style={{ marginLeft: 4, color: delta > 0 ? 'var(--ok)' : delta < 0 ? 'var(--err)' : 'var(--muted)', fontSize: 11 }}>
            {deltaLabel}
          </span>
        )}
        <span style={{ marginLeft: 4, fontSize: 11 }}>({latest.total}题)</span>
      </div>
    </div>
  );
}
```

### packages/server/src/insights/diagnosisCollector.ts — NEW
深度错因诊断数据汇集：join attempts×questions + 干扰项聚合 + tutor 会话。

```typescript
// FILE: packages/server/src/insights/diagnosisCollector.ts
import type { AnswerValue, QuestionType } from '@exam/shared';
import { db } from '../db/index.js';
import { readSessionHistory } from '../ai/sessionHistory.js';

// 诊断数据采集器：汇集错题详情 + 干扰项统计 + 答疑上下文。

interface WrongAttemptRow {
  question_id: string;
  stem: string;
  type: string;
  options: string;  // JSON
  answer: string;   // JSON
  user_answer: string; // JSON
  tags: string | null; // JSON
}

export interface DiagnosisInput {
  questionId: string;
  stem: string;
  options: string[];
  correctAnswer: AnswerValue;
  userAnswer: AnswerValue;
  type: QuestionType;
  tags: string[];
}

export interface DiagnosisContext {
  wrongAttempts: DiagnosisInput[];
  distractorStats: DistractorStat[];
  tutorHighlights: string[];
}

export interface DistractorStat {
  questionId: string;
  stem: string;
  option: string;
  selectedCount: number;
  totalAttempts: number;
}

/** 采集诊断上下文：错题详情 + 干扰项统计 + 答疑要点 */
export async function collectDiagnosisContext(bankId?: string): Promise<DiagnosisContext> {
  const wrongAttempts = queryWrongAttempts(bankId);
  const distractorStats = aggregateDistractors(bankId);
  const tutorHighlights = await collectTutorHighlights(bankId);

  return { wrongAttempts, distractorStats, tutorHighlights };
}

function queryWrongAttempts(bankId?: string): DiagnosisInput[] {
  let sql = `
    SELECT q.id AS question_id, q.stem, q.type, q.options, q.answer,
           a.user_answer, q.tags
    FROM attempts a
    JOIN questions q ON q.id = a.question_id
    WHERE a.is_correct = 0
  `;
  const params: unknown[] = [];
  if (bankId) {
    sql += ' AND q.bank_id = ?';
    params.push(bankId);
  }
  sql += ' ORDER BY a.answered_at DESC LIMIT 50';

  const rows = db.prepare(sql).all(...params) as WrongAttemptRow[];
  return rows.map((row) => ({
    questionId: row.question_id,
    stem: row.stem,
    options: JSON.parse(row.options) as string[],
    correctAnswer: JSON.parse(row.answer) as AnswerValue,
    userAnswer: JSON.parse(row.user_answer) as AnswerValue,
    type: row.type as QuestionType,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
  }));
}

/** 干扰项统计：每题的错误选项被选次数 */
function aggregateDistractors(bankId?: string): DistractorStat[] {
  let sql = `
    SELECT q.id AS question_id, q.stem, q.options, q.answer,
           a.user_answer, COUNT(a.id) AS cnt
    FROM attempts a
    JOIN questions q ON q.id = a.question_id
    WHERE a.is_correct = 0
  `;
  const params: unknown[] = [];
  if (bankId) {
    sql += ' AND q.bank_id = ?';
    params.push(bankId);
  }
  sql += ' GROUP BY q.id, a.user_answer ORDER BY cnt DESC LIMIT 30';

  const rows = db.prepare(sql).all(...params) as {
    question_id: string;
    stem: string;
    options: string;
    answer: string;
    user_answer: string;
    cnt: number;
  }[];

  const stats: DistractorStat[] = [];
  for (const row of rows) {
    const options = JSON.parse(row.options) as string[];
    const userAnswer = JSON.parse(row.user_answer) as AnswerValue;

    let optionText: string;
    if (typeof userAnswer === 'number') {
      optionText = options[userAnswer] ?? `选项${userAnswer}`;
    } else if (Array.isArray(userAnswer)) {
      optionText = userAnswer.map((i) => options[i] ?? `选项${i}`).join('+');
    } else {
      optionText = userAnswer === true ? '正确' : '错误';
    }

    stats.push({
      questionId: row.question_id,
      stem: row.stem.slice(0, 40),
      option: optionText,
      selectedCount: row.cnt,
      totalAttempts: row.cnt,
    });
  }
  return stats;
}

async function collectTutorHighlights(bankId?: string): Promise<string[]> {
  let sessions: { jsonl_path: string }[];
  if (bankId) {
    sessions = db
      .prepare(
        `SELECT ts.jsonl_path FROM tutor_sessions ts
         JOIN questions q ON q.id = ts.question_id
         WHERE q.bank_id = ?`,
      )
      .all(bankId) as { jsonl_path: string }[];
  } else {
    sessions = db.prepare('SELECT jsonl_path FROM tutor_sessions').all() as { jsonl_path: string }[];
  }

  const highlights: string[] = [];
  for (const s of sessions) {
    const turns = await readSessionHistory(s.jsonl_path);
    const userAsks = turns.filter((t) => t.role === 'user').slice(1);
    for (const ask of userAsks) {
      const trimmed = ask.content.slice(0, 60);
      if (trimmed) highlights.push(trimmed);
    }
  }
  return highlights.slice(0, 15);
}
```

### packages/server/src/ai/diagnosisPrompts.ts — NEW
诊断 prompt + buildDiagnosisPrompt。

```typescript
// FILE: packages/server/src/ai/diagnosisPrompts.ts
import type { DiagnosisContext } from '../insights/diagnosisCollector.js';

// 错误诊断 prompt：把错题详情喂给模型，产出结构化错误分类。

export const DIAGNOSIS_SYSTEM_PROMPT = `你是一位学习诊断专家。分析学生的错题记录，对每道错题进行错误归因分类。

错误分类固定为以下四种之一：
- concept_confusion：概念混淆（对知识点理解有误，选了相似但错误的选项）
- calculation_error：计算/推理失误（理解正确但过程出错）
- misread：审题失误（看错题意、漏看条件、误解选项）
- knowledge_gap：知识盲区（完全没有相关知识储备）

要求：
- 只输出 JSON 数组，不要任何解释、不要 markdown 代码围栏。
- 每个元素字段：questionId、stem（题干前 60 字）、userAnswer（学生选了什么）、
  correctAnswer（正确答案）、errorCategory（上述四种之一）、distractorNote（一句话分析干扰项）。
- 题干过长时截取前 60 字即可。
- 答案用选项文本表示（如"A. xxx"），不要用下标数字。`;

/** 构建诊断输入文本 */
export function buildDiagnosisPrompt(ctx: DiagnosisContext): string {
  const attemptLines = ctx.wrongAttempts.map((a) => {
    const optionsText = a.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(' | ');
    const correctText = formatAnswer(a.correctAnswer, a.options);
    const userText = formatAnswer(a.userAnswer, a.options);
    return [
      `【题ID】${a.questionId}`,
      `【题干】${a.stem}`,
      `【选项】${optionsText}`,
      `【正确答案】${correctText}`,
      `【学生作答】${userText}`,
      `【标签】${a.tags.length > 0 ? a.tags.join(', ') : '无'}`,
    ].join('\n');
  });

  const distractorLines = ctx.distractorStats.slice(0, 10).map((d) =>
    `  - ${d.stem}… → 错选"${d.option}"（${d.selectedCount}次）`,
  );

  const highlightLines = ctx.tutorHighlights.length > 0
    ? ctx.tutorHighlights.map((h) => `  - ${h}`).join('\n')
    : '  （暂无答疑记录）';

  return `${DIAGNOSIS_SYSTEM_PROMPT}

---

【错题记录】（共 ${ctx.wrongAttempts.length} 道）
${attemptLines.join('\n\n')}

【干扰项统计】
${distractorLines.length > 0 ? distractorLines.join('\n') : '  （暂无统计数据）'}

【学生答疑关注点】
${highlightLines}

请对每道错题进行错误归因分析。`;
}

function formatAnswer(value: unknown, options: string[]): string {
  if (typeof value === 'boolean') return value ? '正确' : '错误';
  if (typeof value === 'number') {
    const letter = String.fromCharCode(65 + value);
    return `${letter}. ${options[value] ?? '(越界)'}`;
  }
  if (Array.isArray(value)) {
    return value
      .map((i) => `${String.fromCharCode(65 + i)}. ${options[i] ?? '(越界)'}`)
      .join('+');
  }
  return String(value);
}
```

### packages/server/src/import/diagnosisSchema.ts — NEW
错因归类 zod schema（固定枚举 + 跨字段校验）。

```typescript
// FILE: packages/server/src/import/diagnosisSchema.ts
import { z } from 'zod';

// Zod schema for AI diagnosis output (model after questionSchema.ts superRefine pattern).

const ERROR_CATEGORIES = ['concept_confusion', 'calculation_error', 'misread', 'knowledge_gap'] as const;

export const diagnosisItemSchema = z.object({
  questionId: z.string().min(1, 'questionId 不能为空'),
  stem: z.string().min(1, '题干不能为空'),
  userAnswer: z.string().min(1, '学生作答不能为空'),
  correctAnswer: z.string().min(1, '正确答案不能为空'),
  errorCategory: z.enum(ERROR_CATEGORIES, {
    errorMap: () => ({ message: `errorCategory 必须是 ${ERROR_CATEGORIES.join('/')} 之一` }),
  }),
  distractorNote: z.string().default(''),
});

export const diagnosisArraySchema = z.array(diagnosisItemSchema);

/** 校验 AI 诊断输出；失败抛出可读错误 */
export function validateDiagnosisResults(raw: unknown): z.infer<typeof diagnosisArraySchema> {
  return diagnosisArraySchema.parse(raw);
}
```

### packages/server/src/routes/coach.ts — NEW
registerCoachRoutes：诊断 SSE + 计划/任务 CRUD。

```typescript
// FILE: packages/server/src/routes/coach.ts
import type { FastifyInstance } from 'fastify';
import type { AiService } from '../ai/AiService.js';
import type { AiPlan, DiagnosisResult, LearningTask } from '@exam/shared';
import { collectDiagnosisContext } from '../insights/diagnosisCollector.js';
import { buildDiagnosisPrompt, DIAGNOSIS_SYSTEM_PROMPT } from '../ai/diagnosisPrompts.js';
import { validateDiagnosisResults } from '../import/diagnosisSchema.js';
import { diagnosisRepo } from '../repositories/diagnosisRepo.js';
import { learningDataCollector } from '../insights/LearningDataCollector.js';
import { buildPlanPrompt, PLAN_SYSTEM_PROMPT } from '../ai/planPrompts.js';
import { validatePlan } from '../import/planSchema.js';
import { planRepo } from '../repositories/planRepo.js';
import { openSse } from './sseWriter.js';

// Coach 路由（Slice 5 & 6）：诊断 + 计划生成 + 任务管理。

// 通用：从 AI 返回文本中提取 JSON 数组/对象
function extractJson(text: string): unknown {
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      return JSON.parse(text.slice(arrStart, arrEnd + 1));
    } catch { /* fallback */ }
  }
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try {
      return JSON.parse(text.slice(objStart, objEnd + 1));
    } catch { /* fallback */ }
  }
  throw new Error('AI 未返回可识别的 JSON');
}

export function registerCoachRoutes(app: FastifyInstance, ai: AiService): void {

  // ── Slice 5：错误诊断（SSE 流式 + 结构化保存） ──

  app.post<{ Body: { bankId?: string } }>('/api/coach/diagnosis', async (req, reply) => {
    const bankId = req.body?.bankId;
    const sse = openSse(reply);

    try {
      const ctx = await collectDiagnosisContext(bankId);
      if (ctx.wrongAttempts.length === 0) {
        sse.error('暂无错题记录，无需诊断');
        return;
      }

      const prompt = buildDiagnosisPrompt(ctx);
      const raw = await ai.runOnce(DIAGNOSIS_SYSTEM_PROMPT, prompt);

      sse.delta(raw);

      const json = extractJson(raw);
      const results = validateDiagnosisResults(json);

      const id = diagnosisRepo.save(bankId ?? null, results);

      sse.done();
    } catch (err) {
      sse.error((err as Error).message);
    }
  });

  // 获取最新诊断结果（缓存）
  app.get<{ Querystring: { bankId?: string } }>('/api/coach/diagnosis/latest', async (req) => {
    const record = diagnosisRepo.getLatest(req.query?.bankId);
    if (!record) return { results: [] };
    return { results: record.results, createdAt: record.createdAt };
  });

  // ── Slice 6：学习计划生成 + 任务管理 ──

  app.post<{ Body: { bankId?: string } }>('/api/coach/plan', async (req, reply) => {
    const bankId = req.body?.bankId;
    const sse = openSse(reply);

    try {
      const snapshot = await learningDataCollector.collect(bankId);
      if (snapshot.totalAttempts === 0) {
        sse.error('暂无做题记录，无法生成计划');
        return;
      }

      const diagnosis = diagnosisRepo.getLatest(bankId);
      const diagnosisResults = diagnosis?.results ?? [];

      const prompt = buildPlanPrompt(snapshot, diagnosisResults);
      const raw = await ai.runOnce(PLAN_SYSTEM_PROMPT, prompt);

      sse.delta(raw);

      const json = extractJson(raw);
      const plan = validatePlan(json);

      const { planId, taskCount } = planRepo.createPlan(plan.title, plan.phases);

      sse.done();
    } catch (err) {
      sse.error((err as Error).message);
    }
  });

  // 列出所有学习计划
  app.get('/api/coach/plan', async () => {
    return planRepo.listPlans();
  });

  // 列出某计划的所有任务
  app.get<{ Params: { id: string } }>('/api/coach/plan/:id/tasks', async (req, reply) => {
    const plan = planRepo.getPlan(req.params.id);
    if (!plan) return reply.code(404).send({ error: '计划不存在' });
    return planRepo.listTasks(req.params.id);
  });

  // 更新任务状态
  app.patch<{ Params: { id: string }; Body: { status: LearningTask['status'] } }>(
    '/api/coach/task/:id/status',
    async (req, reply) => {
      const { status } = req.body ?? {};
      if (!status || !['pending', 'in_progress', 'done'].includes(status)) {
        return reply.code(400).send({ error: 'status 必须是 pending/in_progress/done' });
      }
      const ok = planRepo.updateTaskStatus(req.params.id, status);
      if (!ok) return reply.code(404).send({ error: '任务不存在' });
      return reply.code(204).send();
    },
  );
}
```

### packages/client/src/components/DiagnosisPanel.tsx — NEW
诊断结果面板（错因分布 + 按知识点聚合）。

```tsx
// FILE: packages/client/src/components/DiagnosisPanel.tsx
import type { DiagnosisResult, ErrorCategory } from '@exam/shared';

interface Props {
  results: DiagnosisResult[];
}

// 错误诊断面板（Slice 5）：错误分布条形图 + 按分类/标签明细。
// 模式 InsightsPanel.tsx 的 bar-row 纯 CSS/SVG 风格。

const CATEGORY_LABEL: Record<ErrorCategory, string> = {
  concept_confusion: '概念混淆',
  calculation_error: '计算失误',
  misread: '审题失误',
  knowledge_gap: '知识盲区',
};

const CATEGORY_COLOR: Record<ErrorCategory, string> = {
  concept_confusion: '#ef4444',
  calculation_error: '#f59e0b',
  misread: '#8b5cf6',
  knowledge_gap: '#6b7280',
};

export function DiagnosisPanel({ results }: Props) {
  if (results.length === 0) {
    return (
      <div className="card">
        <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>错因诊断</h3>
        <p className="muted">暂无诊断数据。点击"生成诊断报告"开始分析。</p>
      </div>
    );
  }

  const categoryMap = new Map<ErrorCategory, number>();
  for (const r of results) {
    categoryMap.set(r.errorCategory, (categoryMap.get(r.errorCategory) ?? 0) + 1);
  }
  const categories = [...categoryMap.entries()].sort((a, b) => b[1] - a[1]);

  const grouped = new Map<ErrorCategory, DiagnosisResult[]>();
  for (const r of results) {
    const arr = grouped.get(r.errorCategory) ?? [];
    arr.push(r);
    grouped.set(r.errorCategory, arr);
  }

  return (
    <div className="card">
      <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>错因诊断</h3>
      <p className="muted" style={{ marginBottom: 12 }}>
        共分析 {results.length} 道错题，按错误类型分布如下：
      </p>

      {categories.map(([cat, count]) => {
        const pct = Math.round((count / results.length) * 100);
        return (
          <div key={cat} className="bar-row">
            <div className="bar-label">{CATEGORY_LABEL[cat]}</div>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{ width: `${pct}%`, background: CATEGORY_COLOR[cat] }}
              />
            </div>
            <div className="bar-val muted">
              {count}题 ({pct}%)
            </div>
          </div>
        );
      })}

      {categories.map(([cat]) => {
        const items = grouped.get(cat) ?? [];
        return (
          <div key={cat} style={{ marginTop: 16 }}>
            <h4 style={{ fontSize: 13, margin: '0 0 6px', color: CATEGORY_COLOR[cat] }}>
              {CATEGORY_LABEL[cat]} ({items.length}题)
            </h4>
            <ul style={{ paddingLeft: 20, margin: 0 }}>
              {items.map((r) => (
                <li key={r.questionId} style={{ marginBottom: 4 }}>
                  <span style={{ fontSize: 13 }}>{r.stem}</span>
                  <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>
                    选了"{r.userAnswer}" → 应选"{r.correctAnswer}"
                  </span>
                  {r.distractorNote && (
                    <div className="muted" style={{ fontSize: 12, marginLeft: 4 }}>
                      {r.distractorNote}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
```

### packages/server/src/ai/planPrompts.ts — NEW
计划生成 prompt + buildPlanPrompt。

```typescript
// FILE: packages/server/src/ai/planPrompts.ts
import type { LearningSnapshot, DiagnosisResult } from '@exam/shared';

// 学习计划生成 prompt（Slice 6）。

export const PLAN_SYSTEM_PROMPT = `你是一位学习规划师。基于学生的学情数据和错题诊断，制定个性化的学习计划。

要求：
- 只输出 JSON 对象，不要任何解释、不要 markdown 代码围栏。
- JSON 结构：{ "title": "计划标题", "phases": [...] }
- phases 是阶段数组，每阶段包含 title、description、tasks 数组。
- 每个 task 包含 title 和 scope（PracticeScope 对象）。
- scope 结构：{ "bankId": "题库id", "mode": "all|undone|wrong|byType|byTag", "shuffle": true }
  - mode=byTag 时 scope.tag 为知识点标签
  - mode=byType 时 scope.type 为 "single"|"multiple"|"boolean"
- 计划应分 2-3 个阶段，从薄弱点专项训练到综合巩固。
- 每阶段 2-4 个具体可执行的任务。
- 优先安排错误率最高的知识点。
- 阶段描述说明训练目标和预期效果。`;

export function buildPlanPrompt(
  snapshot: LearningSnapshot,
  diagnosis: DiagnosisResult[],
): string {
  const pct = (snapshot.accuracy * 100).toFixed(1);
  const weakLines = snapshot.weakTags
    .slice(0, 8)
    .map((t) => `  - ${t.tag}：错 ${t.wrong} / 共 ${t.total} 题（错误率 ${Math.round((t.wrong / t.total) * 100)}%）`)
    .join('\n');

  const diagnosisLines = diagnosis.length > 0
    ? diagnosis
        .slice(0, 15)
        .map((d) => `  - [${d.errorCategory}] ${d.stem} → ${d.distractorNote}`)
        .join('\n')
    : '  （暂无诊断数据）';

  const categoryCounts = new Map<string, number>();
  for (const d of diagnosis) {
    categoryCounts.set(d.errorCategory, (categoryCounts.get(d.errorCategory) ?? 0) + 1);
  }
  const categoryLines = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cat, cnt]) => `  - ${cat}: ${cnt} 题`)
    .join('\n');

  return `${PLAN_SYSTEM_PROMPT}

---

【学生学情概览】
- 累计作答：${snapshot.totalAttempts} 次
- 整体正确率：${pct}%

【薄弱知识点】
${weakLines || '  （暂无）'}

【错误分类分布】
${categoryLines || '  （暂无诊断数据）'}

【错题诊断详情】
${diagnosisLines}

请根据以上数据制定个性化学习计划。`;
}
```

### packages/server/src/import/planSchema.ts — NEW
计划/任务 zod schema（阶段 + 任务列表，任务含 PracticeScope）。

```typescript
// FILE: packages/server/src/import/planSchema.ts
import { z } from 'zod';

// Zod schema for AI plan output (model after questionSchema.ts superRefine pattern).

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
  phases: z.array(phaseSchema).min(1, '至少一个阶段'),
});

export const planArraySchema = z.array(planSchema);

/**
 * 校验 AI 计划输出。
 * AI 可能返回单个对象或数组（数组时取第一个）。
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
```

### packages/client/src/components/PlanPanel.tsx — NEW
学习计划面板（阶段列表 + 任务卡片 + 一键开练按钮）。

```tsx
// FILE: packages/client/src/components/PlanPanel.tsx
import { useState } from 'react';
import type { AiPhase, LearningPlan, LearningTask, PracticeScope } from '@exam/shared';
import { api } from '../api/client.js';

interface Props {
  plans: LearningPlan[];
  onStartTask?: (scope: PracticeScope) => void;
  onRefresh?: () => void;
}

// 学习计划面板（Slice 6）：阶段折叠 + 任务卡片 + "一键开练"按钮。

export function PlanPanel({ plans, onStartTask, onRefresh }: Props) {
  if (plans.length === 0) {
    return (
      <div className="card">
        <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>学习计划</h3>
        <p className="muted">暂无学习计划。点击"生成学习计划"创建个性化训练方案。</p>
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ fontSize: 15, margin: '0 0 12px' }}>学习计划</h3>
      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} onStartTask={onStartTask} onRefresh={onRefresh} />
      ))}
    </div>
  );
}

function PlanCard({ plan, onStartTask, onRefresh }: {
  plan: LearningPlan;
  onStartTask?: (scope: PracticeScope) => void;
  onRefresh?: () => void;
}) {
  const [tasks, setTasks] = useState<LearningTask[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (!expanded && tasks === null) {
      setLoading(true);
      try {
        const t = await api.getPlanTasks(plan.id);
        setTasks(t);
      } catch { /* ignore */ }
      setLoading(false);
    }
    setExpanded(!expanded);
  }

  async function updateTaskStatus(taskId: string, status: LearningTask['status']) {
    try {
      await api.updateTaskStatus(taskId, status);
      setTasks((prev) =>
        prev ? prev.map((t) => (t.id === taskId ? { ...t, status } : t)) : prev,
      );
      onRefresh?.();
    } catch { /* ignore */ }
  }

  const completedCount = tasks?.filter((t) => t.status === 'done').length ?? 0;
  const totalCount = tasks?.length ?? plan.phases.reduce((s, p) => s + p.tasks.length, 0);

  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div
        onClick={toggle}
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <div style={{ fontWeight: 600 }}>{plan.title}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {plan.phases.length} 阶段 · {totalCount} 任务
            {totalCount > 0 && ` · 完成 ${completedCount}/${totalCount}`}
          </div>
        </div>
        <span style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▸</span>
      </div>

      {loading && <div className="muted" style={{ marginTop: 8 }}>加载中...</div>}

      {expanded && tasks && (
        <div style={{ marginTop: 12 }}>
          {plan.phases.map((phase, pi) => {
            const phaseTasks = tasks.filter((t) => t.phaseIndex === pi);
            return (
              <PhaseSection
                key={pi}
                phase={phase}
                phaseIndex={pi}
                tasks={phaseTasks}
                onStartTask={onStartTask}
                onUpdateStatus={updateTaskStatus}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function PhaseSection({ phase, phaseIndex, tasks, onStartTask, onUpdateStatus }: {
  phase: AiPhase;
  phaseIndex: number;
  tasks: LearningTask[];
  onStartTask?: (scope: PracticeScope) => void;
  onUpdateStatus: (taskId: string, status: LearningTask['status']) => void;
}) {
  const [open, setOpen] = useState(phaseIndex === 0);
  const completed = tasks.filter((t) => t.status === 'done').length;

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 0',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div>
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            阶段 {phaseIndex + 1}：{phase.title}
          </span>
          <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
            {completed}/{tasks.length}
          </span>
        </div>
        <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▸</span>
      </div>

      {open && (
        <>
          {phase.description && (
            <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>{phase.description}</p>
          )}
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onStart={() => onStartTask?.(task.scope)}
              onStatusChange={(s) => onUpdateStatus(task.id, s)}
            />
          ))}
        </>
      )}
    </div>
  );
}

function TaskCard({ task, onStart, onStatusChange }: {
  task: LearningTask;
  onStart: () => void;
  onStatusChange: (status: LearningTask['status']) => void;
}) {
  const STATUS_LABEL: Record<LearningTask['status'], string> = {
    pending: '待开始',
    in_progress: '进行中',
    done: '已完成',
  };

  const STATUS_ICON: Record<LearningTask['status'], string> = {
    pending: '○',
    in_progress: '◐',
    done: '●',
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 0',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span
        style={{ cursor: 'pointer', fontSize: 16, color: task.status === 'done' ? 'var(--ok)' : 'var(--muted)' }}
        onClick={() => {
          const next = task.status === 'done' ? 'pending' : 'done';
          onStatusChange(next);
        }}
        title="点击切换完成状态"
      >
        {STATUS_ICON[task.status]}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, textDecoration: task.status === 'done' ? 'line-through' : 'none' }}>
          {task.title}
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          {STATUS_LABEL[task.status]}
          {task.scope.mode === 'byTag' && task.scope.tag && ` · ${task.scope.tag}`}
          {task.scope.mode === 'byType' && task.scope.type && ` · ${task.scope.type}`}
        </div>
      </div>
      <button
        className="btn ghost"
        style={{ fontSize: 12, padding: '2px 8px' }}
        onClick={onStart}
      >
        一键开练
      </button>
    </div>
  );
}
```

### packages/client/src/pages/InsightsPage.tsx — MODIFY
集成趋势图、诊断面板、计划面板，扩展回调 props。

```tsx
// FILE: packages/client/src/pages/InsightsPage.tsx — MODIFIED (trend + diagnosis + plan)
// Full replacement: integrates TrendChart (Slice 4), DiagnosisPanel (Slice 5), PlanPanel (Slice 6)

import { useEffect, useState } from 'react';
import type { Bank, LearningSnapshot, LearningPlan, DiagnosisResult, PracticeScope, TrendHistoryResponse } from '@exam/shared';
import { api } from '../api/client.js';
import { streamSse } from '../api/sse.js';
import { Markdown } from '../components/Markdown.js';
import { InsightsPanel } from '../components/InsightsPanel.js';
import { TrendChart } from '../components/TrendChart.js';
import { DiagnosisPanel } from '../components/DiagnosisPanel.js';
import { PlanPanel } from '../components/PlanPanel.js';
import type { DrillFilter } from '../App.js';

interface Props {
  onDrillToQuiz?: (filter: DrillFilter) => void;
  onDrillToWrong?: (filter: DrillFilter) => void;
  onStartTask?: (scope: PracticeScope) => void;
}

// 学情分析 v3：结构化快照 + 趋势 + 诊断 + 学习计划。
export function InsightsPage({ onDrillToQuiz, onStartTask }: Props = {}) {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankId, setBankId] = useState<string>('');
  const [snapshot, setSnapshot] = useState<LearningSnapshot | null>(null);
  const [trend, setTrend] = useState<TrendHistoryResponse | null>(null);
  const [report, setReport] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  // Slice 5: 诊断状态
  const [diagnosisResults, setDiagnosisResults] = useState<DiagnosisResult[]>([]);
  const [diagnosisRunning, setDiagnosisRunning] = useState(false);

  // Slice 6: 计划状态
  const [plans, setPlans] = useState<LearningPlan[]>([]);
  const [planRunning, setPlanRunning] = useState(false);

  useEffect(() => {
    api.listBanks().then(setBanks).catch(() => {});
  }, []);

  // 范围变化即刷新结构化快照 + 趋势 + 诊断 + 计划
  useEffect(() => {
    setError('');
    api.insightsSnapshot(bankId || undefined).then(setSnapshot).catch((e) => setError((e as Error).message));
    api.getTrendHistory(bankId || undefined).then(setTrend).catch(() => setTrend(null));
    api.getDiagnosis(bankId || undefined).then((d) => setDiagnosisResults(d.results)).catch(() => setDiagnosisResults([]));
    api.listPlans().then(setPlans).catch(() => setPlans([]));
  }, [bankId]);

  function analyze() {
    setReport('');
    setError('');
    setRunning(true);
    streamSse(
      '/api/insights/analyze',
      bankId ? { bankId } : {},
      {
        onDelta: (t) => setReport((r) => r + t),
        onDone: () => setRunning(false),
        onError: (m) => {
          setError(m);
          setRunning(false);
        },
      },
    );
  }

  // Slice 5: 生成诊断报告
  function runDiagnosis() {
    setDiagnosisRunning(true);
    setDiagnosisResults([]);
    streamSse(
      '/api/coach/diagnosis',
      bankId ? { bankId } : {},
      {
        onDelta: () => {},
        onDone: () => {
          setDiagnosisRunning(false);
          api.getDiagnosis(bankId || undefined).then((d) => setDiagnosisResults(d.results)).catch(() => {});
        },
        onError: (m) => {
          setError(m);
          setDiagnosisRunning(false);
        },
      },
    );
  }

  // Slice 6: 生成学习计划
  function runPlan() {
    setPlanRunning(true);
    streamSse(
      '/api/coach/plan',
      bankId ? { bankId } : {},
      {
        onDelta: () => {},
        onDone: () => {
          setPlanRunning(false);
          api.listPlans().then(setPlans).catch(() => {});
        },
        onError: (m) => {
          setError(m);
          setPlanRunning(false);
        },
      },
    );
  }

  const hasData = snapshot && snapshot.totalAttempts > 0;

  return (
    <div>
      <h1>学情分析</h1>
      <p className="muted">基于你的做题记录和答疑内容，归纳薄弱知识点、诊断错因、生成学习计划。</p>

      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <select className="input" value={bankId} onChange={(e) => setBankId(e.target.value)} style={{ flex: 1 }}>
          <option value="">全部题库</option>
          {banks.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <button className="btn" onClick={analyze} disabled={running || !hasData}>
          {running ? '生成中…' : 'AI 报告'}
        </button>
        <button className="btn" onClick={runDiagnosis} disabled={diagnosisRunning || !hasData}>
          {diagnosisRunning ? '诊断中…' : '错因诊断'}
        </button>
        <button className="btn" onClick={runPlan} disabled={planRunning || !hasData}>
          {planRunning ? '生成中…' : '学习计划'}
        </button>
      </div>

      {error && <div className="error">⚠ {error}</div>}

      {hasData ? (
        <>
          <InsightsPanel
            snapshot={snapshot!}
            onDrillTag={(tag) => onDrillToQuiz?.({ bankId: bankId || undefined, tag })}
          />

          {trend && trend.overall.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <TrendChart data={trend} />
            </div>
          )}

          {/* Slice 5: 诊断面板 */}
          <div style={{ marginTop: 16 }}>
            <DiagnosisPanel results={diagnosisResults} />
          </div>

          {/* Slice 6: 学习计划面板 */}
          <div style={{ marginTop: 16 }}>
            <PlanPanel plans={plans} onStartTask={onStartTask} onRefresh={() => api.listPlans().then(setPlans)} />
          </div>
        </>
      ) : (
        <p className="muted">暂无做题记录，先去刷几道题吧。</p>
      )}

      {report && (
        <div className="report" style={{ marginTop: 16 }}>
          <Markdown text={report} />
        </div>
      )}
    </div>
  );
}
```

### packages/client/src/pages/QuizPage.tsx — MODIFY (autoStart)
消费完整 PracticeScope（含 shuffle），支持 autoStart。

（已在上方 QuizPage finish 代码块中合并。）

### packages/client/src/App.tsx — MODIFY
DrillFilter → PracticeScope 扩展，新增 startTaskQuiz。

```tsx
// FILE: packages/client/src/App.tsx — MODIFIED (PracticeScope + startTaskQuiz)
import { useState } from 'react';
import type { PracticeScope, QuestionType } from '@exam/shared';
import { QuizPage } from './pages/QuizPage.js';
import { BanksPage } from './pages/BanksPage.js';
import { WrongBookPage } from './pages/WrongBookPage.js';
import { InsightsPage } from './pages/InsightsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

type Tab = 'quiz' | 'banks' | 'wrong' | 'insights' | 'settings';

const TABS: { key: Tab; label: string }[] = [
  { key: 'quiz', label: '刷题' },
  { key: 'banks', label: '题库' },
  { key: 'wrong', label: '错题本' },
  { key: 'insights', label: '学情' },
  { key: 'settings', label: '设置' },
];

// 跨页下钻筛选（FR3.4）：学情薄弱点 → 刷题/错题按标签筛选
export interface DrillFilter {
  bankId?: string;
  tag?: string;
  type?: QuestionType;
}

export function App() {
  const [tab, setTab] = useState<Tab>('quiz');
  const [quizScope, setQuizScope] = useState<Partial<PracticeScope> | null>(null);
  const [autoStart, setAutoStart] = useState(false);
  const [wrongFilter, setWrongFilter] = useState<DrillFilter | null>(null);

  // 学情下钻到刷题（按标签）
  function drillToQuiz(filter: DrillFilter) {
    setQuizScope({ bankId: filter.bankId, tag: filter.tag, mode: filter.tag ? 'byTag' : 'all' });
    setAutoStart(false);
    setTab('quiz');
  }

  // 学情下钻 / 成绩单跳转到错题本
  function drillToWrong(filter?: DrillFilter) {
    setWrongFilter(filter ?? {});
    setTab('wrong');
  }

  // Slice 6: 一键开练 —— 从学习计划任务直接进入刷题
  function startTaskQuiz(scope: PracticeScope) {
    setQuizScope(scope);
    setAutoStart(true);
    setTab('quiz');
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">考试助手</div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={t.key === tab ? 'tab active' : 'tab'}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="content">
        {tab === 'quiz' && (
          <QuizPage
            initialScope={quizScope}
            autoStart={autoStart}
            onNavigateWrong={() => drillToWrong()}
          />
        )}
        {tab === 'banks' && <BanksPage />}
        {tab === 'wrong' && <WrongBookPage initialFilter={wrongFilter} />}
        {tab === 'insights' && (
          <InsightsPage
            onDrillToQuiz={drillToQuiz}
            onDrillToWrong={drillToWrong}
            onStartTask={startTaskQuiz}
          />
        )}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
```

### packages/server/src/index.ts — MODIFY
注册 registerCoachRoutes(app, ai)。

```typescript
// FILE: packages/server/src/index.ts — MODIFIED (register coach routes)
// ── New import (add at top) ──
import { registerCoachRoutes } from './routes/coach.js';

// ── Add after registerInsightsRoutes(app, ai) ──
  registerCoachRoutes(app, ai);
```

## Slices

### Slice 1: Foundation — types + schema + repos

**Files**: `packages/shared/src/types.ts`, `packages/server/src/db/schema.ts`, `packages/server/src/repositories/masteryRepo.ts`, `packages/server/src/repositories/snapshotRepo.ts`, `packages/server/src/repositories/planRepo.ts`

#### Automated Verification:
- [x] Type checking passes: `npm run check`
- [x] Tests pass: `npm test`

#### Manual Verification:
- [x] 新 4 张表在 schema.ts 的 SCHEMA_SQL 内，`CREATE TABLE IF NOT EXISTS` 可幂等执行
- [x] masteryRepo / snapshotRepo / planRepo 的 CRUD 方法签名正确，Row → Entity 映射完整
- [x] 复合索引 `idx_attempts_question_time` 存在于 schema.ts

### Slice 2: Mastery Loop — streak + grade hook + auto-master

**Files**: `packages/server/src/services/masteryService.ts`, `packages/server/src/routes/quiz.ts`

#### Automated Verification:
- [x] Type checking passes: `npm run check`
- [x] Tests pass: `npm test`
- [x] `grep -r "masteryService" packages/server/src/ | wc -l` returns >= 2

#### Manual Verification:
- [x] 连续答对 3 次后 `wrong_book_state.is_mastered` 自动变为 1
- [x] 答错一次后 `consecutive_correct` 归 0（仅重置 streak，不取消已掌握标记）
- [x] 手动取消掌握后 streak 重新计数

### Slice 3: Snapshot & Finish — practice completion → snapshot

**Files**: `packages/server/src/routes/quiz.ts`, `packages/client/src/api/client.ts`, `packages/client/src/pages/QuizPage.tsx`

#### Automated Verification:
- [x] Type checking passes: `npm run check`
- [x] Tests pass: `npm test`
- [x] `curl -s -X POST http://localhost:3000/api/practice/{id}/finish` returns Scorecard JSON + insight_snapshots 表多一行

#### Manual Verification:
- [x] 点击"完成 · 看成绩单"后 insight_snapshots 表落一行，重复点击不重复落（UNIQUE session_id 幂等）
- [x] 成绩单正常渲染

### Slice 4: Trend Tracking — historical snapshots → trend curves

**Files**: `packages/server/src/insights/snapshotHistory.ts`, `packages/server/src/routes/insights.ts`, `packages/client/src/components/TrendChart.tsx`, `packages/client/src/pages/InsightsPage.tsx`

#### Automated Verification:
- [x] Type checking passes: `npm run check`
- [x] Tests pass: `npm test`
- [x] `curl -s "http://localhost:3000/api/insights/history"` returns array of snapshot entries with timestamps

#### Manual Verification:
- [x] 学情页进入后若有多次练习快照，可见整体正确率时间曲线
- [x] 每知识点趋势折线正确渲染，点击某知识点可下钻

### Slice 5: Diagnosis — deep error-cause + distractor analysis + AI

**Files**: `packages/server/src/insights/diagnosisCollector.ts`, `packages/server/src/ai/diagnosisPrompts.ts`, `packages/server/src/import/diagnosisSchema.ts`, `packages/server/src/routes/coach.ts`, `packages/client/src/components/DiagnosisPanel.tsx`

#### Automated Verification:
- [x] Type checking passes: `npm run check`
- [x] Tests pass: `npm test`
- [x] `grep -r "ErrorCategory" packages/shared/src/ | wc -l` returns >= 1
- [x] `grep -r "runOnce\|diagnosisSchema" packages/server/src/ | wc -l` returns >= 2

#### Manual Verification:
- [x] 点击"生成诊断报告"后 AI 产出错因归类（含干扰项分析），结果落库
- [x] 诊断面板显示错因分布条形图，按知识点聚合

### Slice 6: Plans & Tasks + Full Integration

**Files**: `packages/server/src/ai/planPrompts.ts`, `packages/server/src/import/planSchema.ts`, `packages/server/src/routes/coach.ts`, `packages/client/src/components/PlanPanel.tsx`, `packages/client/src/pages/InsightsPage.tsx`, `packages/client/src/pages/QuizPage.tsx`, `packages/client/src/App.tsx`, `packages/server/src/index.ts`

#### Automated Verification:
- [x] Type checking passes: `npm run check`
- [x] Tests pass: `npm test`
- [x] `curl -s http://localhost:3000/api/coach/plan` returns plan + tasks JSON
- [x] `grep -r "registerCoachRoutes" packages/server/src/index.ts | wc -l` returns 1

#### Manual Verification:
- [x] 点击"生成学习计划"后 AI 产出分阶段计划，任务卡片含"一键开练"按钮
- [x] 点击任务"开始练习"后跳转到 QuizPage 并预置完整 PracticeScope（含 mode+shuffle），自动开始
- [x] 学情页面板完整呈现：快照 → 趋势图 → 诊断 → 计划 → AI 报告
- [x] 薄弱点点击可下钻到刷题/错题（DrillFilter 已扩展到 PracticeScope）

## Desired End State

```typescript
// 用户进学情页 → 即时看到结构化面板 + 趋势图（REST，无 AI 开销）
// 点"生成诊断报告" → AI 深度分析错因（含干扰项），结构化落库
// 点"生成学习计划" → AI 产出分阶段计划 + 一键开练任务，落库
// 点任务的"开始练习" → 跳转 QuizPage，预置 PracticeScope，自动开始
// 练习完成 → POST /finish → 快照落库 + 成绩单渲染
// 连续答对 3 次 → mastery_states 自动标记掌握 → 错题本软标记联动
// 趋势图显示历史快照，AI 能解读"X 在进步、Y 在退步"
```

## File Map

```
packages/shared/src/types.ts                     # MODIFY — 4 新表类型 + 错因枚举 + 趋势类型 + GradeResponse 扩展
packages/server/src/db/schema.ts                 # MODIFY — 4 新表 DDL + 1 复合索引
packages/server/src/repositories/masteryRepo.ts   # NEW — mastery_states CRUD
packages/server/src/repositories/snapshotRepo.ts  # NEW — insight_snapshots CRUD
packages/server/src/repositories/planRepo.ts      # NEW — learning_plans + learning_tasks CRUD
packages/server/src/repositories/diagnosisRepo.ts # NEW — diagnosis_results CRUD
packages/server/src/services/masteryService.ts    # NEW — streak 更新 + 自动 setMastered
packages/server/src/insights/snapshotHistory.ts   # NEW — 趋势查询（JSON1）
packages/server/src/insights/diagnosisCollector.ts # NEW — 深度错因数据汇集
packages/server/src/ai/diagnosisPrompts.ts        # NEW — 诊断 prompt + buildDiagnosisPrompt
packages/server/src/ai/planPrompts.ts             # NEW — 计划生成 prompt
packages/server/src/import/diagnosisSchema.ts     # NEW — 错因 zod schema
packages/server/src/import/planSchema.ts          # NEW — 计划/任务 zod schema
packages/server/src/routes/coach.ts               # NEW — registerCoachRoutes（诊断 + 计划）
packages/server/src/routes/quiz.ts                # MODIFY — grade hook + finish endpoint
packages/server/src/routes/insights.ts            # MODIFY — +history endpoint
packages/server/src/index.ts                      # MODIFY — registerCoachRoutes
packages/client/src/api/client.ts                 # MODIFY — +finishPractice / history / coach APIs
packages/client/src/pages/InsightsPage.tsx        # MODIFY — +趋势图 +诊断面板 +计划面板
packages/client/src/pages/QuizPage.tsx            # MODIFY — finish→POST + autoStart + shuffle 消费
packages/client/src/App.tsx                       # MODIFY — DrillFilter→PracticeScope + startTaskQuiz
packages/client/src/components/TrendChart.tsx      # NEW — 纯 CSS/SVG 趋势图
packages/client/src/components/DiagnosisPanel.tsx  # NEW — 诊断结果面板
packages/client/src/components/PlanPanel.tsx       # NEW — 学习计划面板
```

## Ordering Constraints

1. **Slice 1 先行**（地基）：所有后续切片依赖 types + schema + repos
2. **Slice 2-3 独立于 4-5-6**：掌握闭环与快照是独立数据层，可并行于上层功能
3. **Slice 4 依赖 Slice 3**：趋势数据来自快照表
4. **Slice 5 独立于 4**：诊断不依赖趋势
5. **Slice 6 最后**：整合所有面板到 InsightsPage + QuizPage autoStart + App drillFilter
6. **层优先约束**：每个切片内按 types → repo/service → route → client 顺序

## Verification Notes

- **无 migration 机制**：所有新表用 `CREATE TABLE IF NOT EXISTS`（`schema.ts` 惯例）。零 ALTER TABLE。
- **setMastered 幂等**：`wrongBookRepo.ts:18` 的 `ON CONFLICT DO UPDATE` 天然幂等，自动/手动调用不冲突。
- **UNIQUE(session_id)**：insight_snapshots 的 session_id UNIQUE 约束确保 /finish 多次调用不重复落库。
- **req<T>() 空 body 脆弱**（`1410d48`）：新 DELETE/空 body POST 端点需验证 Content-Type 处理。
- **strict 模式数组索引**（`c6aebc4`）：新聚合代码测试先 `expect(arr.length).toBeGreaterThan(0)` 再 `arr[0]`。
- **JSON 列查询**：insight_snapshots.by_tag 用 `json_each` + `json_extract`（SQLite JSON1），需确认编译包含 JSON1 扩展（better-sqlite3 默认包含）。

## Performance Considerations

- **mastery hook O(1)**：判分后只做一次 `masteryRepo.incrementCorrect`/`reset`，不查历史 attempts。
- **趋势查询 JSON1**：`json_each` 对 snapshot.by_tag 展开，快照数量 = 练习完成次数（通常几十到几百），无性能压力。
- **诊断数据量**：一次诊断涉及该 bank 全量 wrong attempts join questions，量级 = 做题总量（通常几百到几千），单次查询无问题。
- **AI 调用成本**：`runOnce` 一次调用 = 一次模型请求，按需触发（非自动），成本可控。

## Migration Notes

**新表（无数据迁移需求）**：
- `question_mastery`：空表起步，首次判分时按需创建行（getOrCreate）
- `insight_snapshots`：空表起步，首次练习完成时写入
- `diagnosis_results`：空表起步，首次诊断时写入
- `learning_plans` / `learning_tasks`：空表起步，首次生成计划时写入

**无 ALTER TABLE**：不改已有 8 张表的任何列。新数据全部落新表。

**回滚策略**：新表独立，回滚只需从 `SCHEMA_SQL` 删除对应 `CREATE TABLE` 语句（或直接 DROP TABLE）。

## Pattern References

- `packages/server/src/repositories/practiceRepo.ts` — 新 repo 的完整范本（Row interface + toXxx + named params + JSON 列处理）
- `packages/server/src/repositories/wrongBookRepo.ts` — UPSERT 幂等范本（setMastered 的 `ON CONFLICT DO UPDATE`）
- `packages/server/src/import/parseWithAi.ts` — 结构化 AI 产出范本（runOnce + extractJsonArray + zod）
- `packages/server/src/import/questionSchema.ts` — zod schema + superRefine 跨字段校验范本
- `packages/client/src/components/InsightsPanel.tsx` — 纯 SVG/CSS 可视化范本（Ring + bar-row）
- `packages/client/src/api/client.ts:10-35` — `req<T>()` REST 包装范本
- `packages/client/src/api/sse.ts:16-66` — SSE 流式消费范本

## Developer Context

（摘自 discover + research checkpoint，所有决策已固定）

**Q (discover: DEC-29..36)**: 架构/存储/产出形态/掌握判定/错因分析/趋势粒度/AI时机/范围 — 全部已确认（见 research Developer Context）
**Q (research checkpoint)**: 掌握计数方式 → 增量列；快照触发 → 练习完成时；AI 结构化 → runOnce+zod+固定枚举
**Q (design checkpoint)**: 计划/任务模型 → 两表；干扰项 → 后端聚合一份共用；缓存失效 → 新增题量+任务完成；闭环 → streak 单一驱动

## Design History

- Slice 1: Foundation — approved as generated
- Slice 2: Mastery Loop — approved as generated
- Slice 3: Snapshot & Finish — approved as generated
- Slice 4: Trend Tracking — approved as generated
- Slice 5: Diagnosis — approved as generated
- Slice 6: Plans & Tasks + Integration — approved as generated

## References

- `.rpiv/artifacts/discover/2026-07-18_15-05-28-deep-ai-insights-frd.md` — FRD（DEC-29..36，OQ1..8）
- `.rpiv/artifacts/research/2026-07-18_16-02-57_deep-ai-insights.md` — Research（全部问题已解答）
- `.rpiv/artifacts/designs/2026-07-18_12-38-42-v2-module-completeness-design.md` — v2 设计（新表全流程范例）
- `.rpiv/artifacts/plans/2026-07-18_12-40-49-v2-module-completeness-plan.md` — v2 计划（地基层优先分片）
