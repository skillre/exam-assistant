import Database from "better-sqlite3";
import { db } from "./index.js";
import { DB_PATH } from "../config/paths.js";

// 第五批：questions.type CHECK 约束扩 'essay'。
// 新库由 SCHEMA_SQL 直接建好；但既有库（远程 Docker 卷）的 SQLite CHECK 约束
// 无法 ALTER，且重建 questions 表会牵连所有外键引用表（attempts/mastery 等），
// 故用官方保留的 writable_schema 机制就地改写建表语句（幂等 + 备份 + 失败回滚）。
// 注意：better-sqlite3 默认开 SQLITE_DBCONFIG_DEFENSIVE，禁止改 sqlite_master，
// 必须用 { unsafe: true } 的独立连接执行；主连接保持安全模式。
// ponytail: 一次性启动迁移，不建通用迁移框架；若未来再有 DDL 变更再评估。

const OLD_CHECK = "CHECK(type IN ('single','multiple','boolean'))";
const NEW_CHECK = "CHECK(type IN ('single','multiple','boolean','essay'))";

export function migrateEssayCheck(): void {
	const row = db
		.prepare(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name='questions'",
		)
		.get() as { sql: string } | undefined;
	if (!row?.sql) return;
	if (row.sql.includes("'essay'")) return; // 已迁移，幂等
	if (!row.sql.includes(OLD_CHECK)) return; // 非预期 DDL，保守不动

	const backup = row.sql;
	const patched = backup.replace(OLD_CHECK, NEW_CHECK);
	const raw = new Database(DB_PATH);
	raw.unsafeMode(true); // 关闭 SQLITE_DBCONFIG_DEFENSIVE，允许改 sqlite_master
	raw.exec("PRAGMA writable_schema = ON");
	try {
		raw
			.prepare(
				"UPDATE sqlite_master SET sql = ? WHERE type='table' AND name='questions'",
			)
			.run(patched);
		// 校验改写生效，失败则回滚原文本
		const verify = raw
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type='table' AND name='questions'",
			)
			.get() as { sql: string } | undefined;
		if (!verify?.sql?.includes("'essay'")) {
			raw
				.prepare(
					"UPDATE sqlite_master SET sql = ? WHERE type='table' AND name='questions'",
				)
				.run(backup);
			throw new Error("迁移失败：questions CHECK 改写未生效，已回滚");
		}
		// 递增 schema cookie，让连接重解析表定义
		raw.pragma(
			`schema_version = ${(raw.pragma("schema_version", { simple: true }) as number) + 1}`,
		);
	} finally {
		raw.exec("PRAGMA writable_schema = OFF");
		raw.close();
	}
}
