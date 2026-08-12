import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionHistory } from "./sessionHistory.js";

// readSessionHistory 是纯文件读取（无 DB 依赖），直接构造 JSONL 验证。
// 格式与 pi SDK 会话落盘一致：{"type":"message","id","parentId","timestamp","message":{role,content,timestamp}}。

function makeJsonl(
	lines: { role: "user" | "assistant"; text: string }[],
): string {
	return lines
		.map((l, i) =>
			JSON.stringify({
				type: "message",
				id: `m${i}`,
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				message: {
					role: l.role,
					content: [{ type: "text", text: l.text }],
					timestamp: 0,
				},
			}),
		)
		.join("\n");
}

function writeSession(
	lines: { role: "user" | "assistant"; text: string }[],
): string {
	const dir = mkdtempSync(join(tmpdir(), "exam-history-"));
	const path = join(dir, "session.jsonl");
	writeFileSync(path, makeJsonl(lines));
	return path;
}

const sample: { role: "user" | "assistant"; text: string }[] = [
	{ role: "user", text: "首条注入的讲解上下文：题目+正确答案（应被跳过）" },
	{ role: "assistant", text: "这道题的答案是 B，因为…" },
	{ role: "user", text: "为什么不能选 A？" },
	{ role: "assistant", text: "因为 A 混淆了概念…" },
];

describe("readSessionHistory", () => {
	it("默认 skipFirstUserTurn=false：返回全部 user/assistant 轮（collector 行为不变）", () => {
		const path = writeSession(sample);
		const turns = readSessionHistory(path);
		expect(turns).toHaveLength(4);
		expect(turns[0]).toEqual({
			role: "user",
			content: "首条注入的讲解上下文：题目+正确答案（应被跳过）",
		});
		expect(turns[1]!.role).toBe("assistant");
		rmSync(join(path, ".."), { recursive: true, force: true });
	});

	it("skipFirstUserTurn=true：跳过首条 user 轮，其余顺序不变", () => {
		const path = writeSession(sample);
		const turns = readSessionHistory(path, true);
		expect(turns).toHaveLength(3);
		// 首条变成 assistant 讲解，注入的 user 上下文消失
		expect(turns[0]).toEqual({
			role: "assistant",
			content: "这道题的答案是 B，因为…",
		});
		expect(turns[1]).toEqual({ role: "user", content: "为什么不能选 A？" });
		rmSync(join(path, ".."), { recursive: true, force: true });
	});

	it("文件不存在返回空数组（降级不抛）", () => {
		expect(readSessionHistory("/nonexistent/session.jsonl")).toEqual([]);
		expect(readSessionHistory("/nonexistent/session.jsonl", true)).toEqual([]);
	});

	it("非 message 条目与空文本被忽略", () => {
		const dir = mkdtempSync(join(tmpdir(), "exam-history-"));
		const path = join(dir, "session.jsonl");
		writeFileSync(
			path,
			[
				JSON.stringify({
					type: "thinking",
					id: "t1",
					parentId: null,
					timestamp: "",
					thinking: "…",
				}),
				...makeJsonl([
					{ role: "user", text: "   " },
					{ role: "user", text: "有效追问" },
				]).split("\n"),
			].join("\n"),
		);
		const turns = readSessionHistory(path, false);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.content).toBe("有效追问");
		rmSync(dir, { recursive: true, force: true });
	});
});
