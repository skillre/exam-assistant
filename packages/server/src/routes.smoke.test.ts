import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerImportRoutes } from "./routes/import.js";
import { registerQuizRoutes } from "./routes/quiz.js";
import { registerBankRoutes } from "./routes/banks.js";

// 第三批 卫生⑪：路由层 HTTP 冒烟（审计 R7：路由层 0 测试）。
// 自建 Fastify 按 register*Routes 组装 + AiService 桩（不依赖真实 AI / provider Key），
// 不 import index.ts（顶层 listen）。DATA_DIR 指向临时目录隔离。

let tempDir: string;
let app: ReturnType<typeof Fastify>;
let bankId: string;

// AiService 桩：覆盖路由注册所需的最小面（AI 路径不测）
const aiStub = {
	reloadProviders: async () => {},
	testProvider: async (): Promise<{ ok: boolean; message: string }> => ({
		ok: true,
		message: "ok",
	}),
	listModels: () => [],
	setModel: () => {},
	runOnce: async () => "[]",
	createTutorSession: async () => ({ session: {}, jsonlPath: "" }),
	openTutorSession: async () => ({}),
	streamPrompt: async () => {},
} as never;

beforeAll(async () => {
	tempDir = mkdtempSync(join(tmpdir(), "exam-routes-"));
	process.env.DATA_DIR = tempDir;
	const { getDb } = await import("./db/index.js");
	getDb();

	app = Fastify();
	await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
	registerProviderRoutes(app, aiStub);
	registerModelRoutes(app, aiStub);
	registerImportRoutes(app, aiStub);
	registerQuizRoutes(app);
	registerBankRoutes(app);
	await app.ready();
});

afterAll(async () => {
	await app.close();
	const { closeDb } = await import("./db/index.js");
	closeDb();
	rmSync(tempDir, { recursive: true, force: true });
});

const post = (url: string, body: unknown) =>
	app.inject({ method: "POST", url, payload: body });

describe("HTTP 全链路（routes.smoke，评审 S3）", () => {
	it("建库 → 导入（commit 2 题）", async () => {
		const b = await post("/api/banks", { name: "冒烟库" });
		expect(b.statusCode).toBe(201);
		bankId = b.json().id as string;

		const imp = await post("/api/import/commit", {
			bankId,
			questions: [
				{
					type: "single",
					stem: "1+1=?",
					options: ["1", "2"],
					answer: 1,
					explanation: "",
					tags: [],
				},
				{
					type: "boolean",
					stem: "地球是圆的",
					options: [],
					answer: true,
					explanation: "",
					tags: [],
				},
			],
		});
		expect(imp.statusCode).toBe(201); // import commit 统一 201（含已存在库场景）
		expect(imp.json().count).toBe(2);
	});

	it("练习：start → 判分 2 题 → graded 返回完整判分态", async () => {
		const s = await post("/api/practice/start", {
			scope: { bankId, mode: "all" },
		});
		expect(s.statusCode).toBe(200);
		const session = s.json() as { id: string; questionIds: string[] };
		expect(session.questionIds).toHaveLength(2);

		const [q1, q2] = session.questionIds;
		expect(q1).toBeTypeOf("string");
		expect(q2).toBeTypeOf("string");
		const g1 = await post("/api/quiz/grade", { questionId: q1, userAnswer: 1 });
		const g2 = await post("/api/quiz/grade", {
			questionId: q2,
			userAnswer: false,
		});
		expect(g1.json().isCorrect).toBe(true);
		expect(g2.json().isCorrect).toBe(false);

		const graded = await app.inject({
			method: "GET",
			url: `/api/practice/${session.id}/graded`,
		});
		const g = graded.json() as Record<
			string,
			{
				attemptId: string;
				isCorrect: boolean;
				correctAnswer: unknown;
				answeredAt: number;
			}
		>;
		expect(Object.keys(g)).toHaveLength(2);
		expect(g[q1!]!.attemptId).toBeTypeOf("string");
		expect(g[q1!]!.answeredAt).toBeTypeOf("number");
	});

	it("错题本：答错的题出现在列表", async () => {
		const w = await app.inject({
			method: "GET",
			url: `/api/quiz/wrong?bankId=${bankId}`,
		});
		const items = w.json() as {
			question: { id: string };
			wrongCount: number;
		}[];
		expect(items).toHaveLength(1);
		expect(items[0]!.wrongCount).toBe(1);
	});

	it("练习完成 → 快照落库（幂等）", async () => {
		const s = await post("/api/practice/start", {
			scope: { bankId, mode: "all" },
		});
		const session = s.json() as { id: string };
		const f1 = await post(`/api/practice/${session.id}/finish`, {});
		expect(f1.statusCode).toBe(200);
		expect(f1.json().snapshotId).toBeTypeOf("string");
		// 幂等重放：snapshotId null（同 session 不重复落点）
		const f2 = await post(`/api/practice/${session.id}/finish`, {});
		expect(f2.json().snapshotId).toBeNull();
	});

	it("provider：配 Key 入库 → 列表脱敏（无 apiKey 字段）", async () => {
		const p = await post("/api/providers", {
			name: "测试Provider",
			baseUrl: "https://api.test.com/v1",
			api: "openai-completions",
			apiKey: "sk-test-secret-key",
			models: [{ id: "m1", name: "模型1" }],
		});
		expect(p.statusCode).toBe(201); // POST 创建 201

		const list = await app.inject({ method: "GET", url: "/api/providers" });
		const providers = list.json() as {
			name: string;
			configured: boolean;
			apiKey?: string;
		}[];
		const mine = providers.find((x) => x.name === "测试Provider")!;
		expect(mine.configured).toBe(true);
		expect("apiKey" in mine).toBe(false); // 密文永不回传前端
		expect(JSON.stringify(mine)).not.toContain("sk-test-secret-key");
	});

	it("校验错误：缺必填返回 4xx 且 message 可读", async () => {
		const bad = await post("/api/quiz/grade", { questionId: "nope" });
		expect(bad.statusCode).toBe(400);
		expect(bad.json().error).toBeTypeOf("string");
	});

	it("删库级联：题目/错题清空", async () => {
		const del = await app.inject({
			method: "DELETE",
			url: `/api/banks/${bankId}`,
		});
		expect(del.statusCode).toBe(204);
		const qs = await app.inject({
			method: "GET",
			url: `/api/banks/${bankId}/questions`,
		});
		expect(qs.statusCode).toBe(404);
		const wrong = await app.inject({ method: "GET", url: "/api/quiz/wrong" });
		expect((wrong.json() as unknown[]).length).toBe(0);
	});
});
