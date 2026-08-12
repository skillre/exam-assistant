import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// 第五批：questions.type CHECK 扩 'essay' 的启动迁移（writable_schema 改写）。
// 真实路径：db/index.js 的 singleton 连接打开 {DATA_DIR}/app.db——
// 测试先手工造"旧版 app.db"（三题型 CHECK，未跑 SCHEMA_SQL），再触发 getDb/migrate。

const LEGACY_SQL = `
CREATE TABLE IF NOT EXISTS banks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('single','multiple','boolean')),
  stem TEXT NOT NULL,
  options TEXT NOT NULL,
  answer TEXT NOT NULL,
  explanation TEXT,
  tags TEXT,
  source TEXT,
  created_at INTEGER NOT NULL
);
`;

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "exam-migrate-"));
	process.env.DATA_DIR = dir;
});

afterAll(async () => {
	const { closeDb } = await import("./index.js");
	closeDb();
	rmSync(dir, { recursive: true, force: true });
});

describe("migrateEssayCheck", () => {
	it("旧库迁移后 essay 题可插入（此前 CHECK 会拒绝），存量列不变", async () => {
		// 造旧版 app.db（只有 questions 表，旧 CHECK）
		const legacy = new Database(join(dir, "app.db"));
		legacy.exec(LEGACY_SQL);
		legacy.close();

		const { db } = await import("./index.js");
		const { migrateEssayCheck } = await import("./migrate.js");

		db.prepare("INSERT INTO banks (id,name,created_at) VALUES ('b1','测试库',1)").run();

		// 迁移前：essay 插入被 CHECK 拒绝
		const pre = db.prepare(
			"INSERT INTO questions (id,bank_id,type,stem,options,answer,created_at) VALUES (?,?,?,?,?,?,?)",
		);
		expect(() =>
			pre.run("q1", "b1", "essay", "简述", "[]", '"参考"', 1),
		).toThrow(/CHECK/i);

		migrateEssayCheck();

		expect(() =>
			pre.run("q2", "b1", "essay", "简述", "[]", '"参考"', 2),
		).not.toThrow();
		const row = db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type='table' AND name='questions'",
			)
			.get() as { sql: string };
		expect(row.sql).toContain("'essay'");
		expect(row.sql.match(/'essay'/g)).toHaveLength(1);
	});

	it("幂等：重复迁移不报错、不重复改写", async () => {
		const { db } = await import("./index.js");
		const { migrateEssayCheck } = await import("./migrate.js");
		migrateEssayCheck();
		const row = db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type='table' AND name='questions'",
			)
			.get() as { sql: string };
		expect(row.sql.match(/'essay'/g)).toHaveLength(1);
	});

	// 新库（SCHEMA_SQL 已含 essay）场景 = 迁移后的同态：migrate 检测到 'essay' 直接跳过（见幂等用例）。
	// DATA_DIR 被 config/paths 在模块加载时锁定，无法在同一进程换库重测；SCHEMA_SQL 本身是静态文本。
});
