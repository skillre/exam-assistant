import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// snapshotHistory 依赖 SQLite 快照数据：临时 DATA_DIR + 动态 import。

let tempDir: string;
let db: import("better-sqlite3").Database;
let buildTrendHistory: (
	bankId?: string,
) => import("@exam/shared").TrendHistoryResponse;

async function saveSnapshot(
	sessionId: string,
	bankId: string,
	total: number,
	correct: number,
	byTag: { tag: string; total: number; correct: number }[],
) {
	const { snapshotRepo } = await import("../repositories/snapshotRepo.js");
	snapshotRepo.save({
		sessionId,
		bankId,
		total,
		correct,
		accuracy: correct / total,
		byTag,
		byType: [],
	});
}

beforeAll(async () => {
	tempDir = mkdtempSync(join(tmpdir(), "exam-trend-"));
	process.env.DATA_DIR = tempDir;
	const dbMod = await import("../db/index.js");
	db = dbMod.getDb();
	db.prepare(
		`INSERT INTO banks (id, name, created_at) VALUES ('b1', '库1', 0)`,
	).run();
	db.prepare(
		`INSERT INTO banks (id, name, created_at) VALUES ('b2', '库2', 0)`,
	).run();
	buildTrendHistory = (await import("./snapshotHistory.js")).buildTrendHistory;
});

afterAll(async () => {
	const { closeDb } = await import("../db/index.js");
	closeDb();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("buildTrendHistory（双维时间序列，D34）", () => {
	it("空快照返回空序列（不报错）", () => {
		const t = buildTrendHistory("b1");
		expect(t.overall).toEqual([]);
		expect(t.byTag).toEqual([]);
	});

	it("整体曲线按时间正序（旧→新）", async () => {
		await saveSnapshot(randomUUID(), "b1", 10, 5, [
			{ tag: "代数", total: 5, correct: 2 },
		]);
		await new Promise((r) => setTimeout(r, 2));
		await saveSnapshot(randomUUID(), "b1", 10, 8, [
			{ tag: "代数", total: 5, correct: 4 },
		]);

		const t = buildTrendHistory("b1");
		expect(t.overall).toHaveLength(2);
		// 正序：第一个点正确率 0.5，第二个 0.8
		expect(t.overall[0]!.accuracy).toBeCloseTo(0.5);
		expect(t.overall[1]!.accuracy).toBeCloseTo(0.8);
		expect(t.overall[0]!.ts).toBeLessThanOrEqual(t.overall[1]!.ts);
	});

	it("按标签趋势含 tag 字段，正确率按快照点聚合", () => {
		const t = buildTrendHistory("b1");
		const tagPoints = t.byTag.filter((p) => p.tag === "代数");
		expect(tagPoints).toHaveLength(2);
		expect(tagPoints[0]!.accuracy).toBeCloseTo(2 / 5);
		expect(tagPoints[1]!.accuracy).toBeCloseTo(4 / 5);
		expect(tagPoints[0]!.ts).toBeLessThanOrEqual(tagPoints[1]!.ts);
	});

	it("按库隔离：b2 快照不进 b1 趋势", async () => {
		await saveSnapshot(randomUUID(), "b2", 10, 3, [
			{ tag: "英语", total: 10, correct: 3 },
		]);
		const b1 = buildTrendHistory("b1");
		expect(b1.byTag.every((p) => p.tag !== "英语")).toBe(true);
		const b2 = buildTrendHistory("b2");
		expect(b2.byTag).toHaveLength(1);
		expect(b2.byTag[0]!.tag).toBe("英语");
	});
});
