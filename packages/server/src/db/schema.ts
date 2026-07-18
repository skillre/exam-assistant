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
`;
