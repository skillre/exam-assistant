// AI 原生考试助手 — SQLite schema（6 表）。
// 以 TS 常量承载 DDL：单一真相源，tsc 编译后仍可用（避免 .sql 不被拷进 dist）。
// 外键级联删除依赖 PRAGMA foreign_keys=ON（在 db/index.ts 连接时开启）。

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS banks (          -- 题库
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (      -- 题目
  id          TEXT PRIMARY KEY,
  bank_id     TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK(type IN ('single','multiple','boolean')),
  stem        TEXT NOT NULL,
  options     TEXT NOT NULL,                -- JSON 数组
  answer      TEXT NOT NULL,                -- JSON: number | number[] | boolean
  explanation TEXT,
  tags        TEXT,                         -- JSON 字符串数组
  source      TEXT,                         -- 'paste-ai' | 'file'
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (       -- 做题记录
  id          TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_answer TEXT NOT NULL,                -- JSON
  is_correct  INTEGER NOT NULL,             -- 0/1
  answered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tutor_sessions ( -- 答疑会话（DEC-7：只存 JSONL 路径引用）
  id          TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  jsonl_path  TEXT NOT NULL,                -- \${DATA_DIR}/sessions/xxx.jsonl
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (      -- 模型 provider（DEC-19/20：前端配置，Key 加密存后端）
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,                -- 展示名，如 "DeepSeek"
  base_url    TEXT NOT NULL,
  api         TEXT NOT NULL,                -- 'openai-completions' 等
  models      TEXT NOT NULL,                -- JSON: [{ id, name }]
  api_key_enc TEXT NOT NULL,                -- AES-GCM 密文（DEC-19：永不回传前端）
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (   -- 单实例全局设置：当前激活 provider/model
  key   TEXT PRIMARY KEY,                   -- 'active_provider_id' | 'active_model_id'
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS practice_sessions ( -- v2：练习会话（范围/定序/进度续做）
  id            TEXT PRIMARY KEY,
  bank_id       TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  question_ids  TEXT NOT NULL,              -- JSON string[]（定序后的题目 id）
  current_index INTEGER NOT NULL DEFAULT 0,
  scope         TEXT NOT NULL,              -- JSON PracticeScope
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wrong_book_state ( -- v2：错题"已掌握"软标记（DEC-28）
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  is_mastered INTEGER NOT NULL DEFAULT 0,
  mastered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_questions_bank ON questions(bank_id);
CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts(question_id);
CREATE INDEX IF NOT EXISTS idx_tutor_question ON tutor_sessions(question_id);
CREATE INDEX IF NOT EXISTS idx_practice_bank ON practice_sessions(bank_id);

-- ── v3：AI 学习教练（DEC-30 快照落库 / DEC-32 掌握 / DEC-33 诊断） ──
-- 只加不改：既有表零 ALTER、零迁移（第二批红线）。

CREATE TABLE IF NOT EXISTS mastery_states (  -- 掌握判定：增量 streak（D1 Option A，不查历史 attempts）
  question_id         TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  consecutive_correct INTEGER NOT NULL DEFAULT 0,
  mastered            INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER
);

CREATE TABLE IF NOT EXISTS insight_snapshots (  -- 学情快照：练习完成时落库（D5），session_id 幂等
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL UNIQUE,
  bank_id     TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  total       INTEGER NOT NULL,
  correct     INTEGER NOT NULL,
  accuracy    REAL NOT NULL,
  by_tag      TEXT NOT NULL,  -- JSON: [{tag, total, correct}]
  by_type     TEXT NOT NULL,  -- JSON: [{type, total, correct}]
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_plans (  -- 学习计划（D2 两表：计划 + 任务）；bank_id 可空=全局计划（学情页"全部题库"范围）
  id          TEXT PRIMARY KEY,
  bank_id     TEXT REFERENCES banks(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  phases      TEXT NOT NULL,  -- JSON: AiPhase[]（AI 产出快照，供前端展示阶段）
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_tasks (  -- 计划任务：一键开练（scope JSON 直接喂 /api/practice/start）
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  phase_index  INTEGER NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  scope        TEXT NOT NULL,  -- JSON: PracticeScope
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS diagnosis_results (  -- AI 诊断缓存（FR5.3 缓存可追溯）
  id         TEXT PRIMARY KEY,
  bank_id    TEXT,  -- NULL = 全局
  results    TEXT NOT NULL,  -- JSON: DiagnosisResult[]
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_bank ON insight_snapshots(bank_id);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON learning_tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_plans_bank ON learning_plans(bank_id);
`;
