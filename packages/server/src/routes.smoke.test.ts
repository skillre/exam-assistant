import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import multipart from "@fastify/multipart";

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
	// 关键：必须在任何路由模块加载前设置 DATA_DIR（config/paths.ts 在模块加载时锁定路径）。
	// 第三批时路由为静态 import，beforeAll 设置晚于模块求值，测试数据曾写入默认 data/ 目录。
	process.env.DATA_DIR = tempDir;
	const { getDb } = await import("./db/index.js");
	getDb();

	app = Fastify();
	await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
	const { registerProviderRoutes } = await import("./routes/providers.js");
	const { registerModelRoutes } = await import("./routes/models.js");
	const { registerImportRoutes } = await import("./routes/import.js");
	const { registerQuizRoutes } = await import("./routes/quiz.js");
	const { registerBankRoutes } = await import("./routes/banks.js");
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

	// ── 第四批：导出 / 历史 / 标签计数（在删库级联测试之后追加，此时库已删——故先重建并单独造数）──
	it("第四批：导出 questions.csv / wrong.csv / history / tags/counts", async () => {
		// 重建题库与题目（删库级联后场景）
		const nb = await post("/api/banks", { name: "第四批库" });
		expect(nb.statusCode).toBe(201);
		const nbId = (nb.json() as { id: string }).id;
		const imp2 = await post("/api/import/commit", {
			bankId: nbId,
			questions: [
				{
					type: "single",
					stem: "含逗号,与引号\"题\"?",
					options: ["A", "B"],
					answer: 0,
					explanation: "解释含\n换行",
					tags: ["第四批标签"],
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
		expect(imp2.statusCode).toBe(201);
		const qs = await app.inject({
			method: "GET",
			url: `/api/banks/${nbId}/questions`,
		});
		const qsArr = qs.json() as Array<{ id: string; type: string }>;
		const qid = qsArr[0]!.id; // single：含特殊字符题
		const qid2 = qsArr[1]!.id; // boolean
		await post("/api/quiz/grade", { questionId: qid, userAnswer: 0 }); // 答对
		await post("/api/quiz/grade", { questionId: qid2, userAnswer: false }); // 答错 → 进错题

		// questions.csv：表头 6 列 + 转义（逗号/引号/换行）
		const csv = await app.inject({
			method: "GET",
			url: `/api/export/${nbId}/questions.csv`,
		});
		expect(csv.statusCode).toBe(200);
		const text = csv.body;
		expect(text.startsWith("\uFEFF")).toBe(true); // BOM
		expect(text).toContain("type,stem,options,answer,explanation,tags");
		expect(text).toContain('"含逗号,与引号""题""?"');
		expect(text).toContain('"解释含\n换行"');

		// wrong.csv：7 列含 wrong_answer，且含刚答错的 boolean 题（含用户错误作答 false）
		const wcsv = await app.inject({ method: "GET", url: "/api/export/wrong.csv" });
		expect(wcsv.statusCode).toBe(200);
		expect(wcsv.body).toContain("wrong_answer");
		expect(wcsv.body).toContain("boolean,地球是圆的,[],true,,,false");

		// tags/counts：只含该库标签且计数正确
		const tc = await app.inject({
			method: "GET",
			url: `/api/tags/counts?bankId=${nbId}`,
		});
		expect(tc.statusCode).toBe(200);
		expect(tc.json()).toEqual([{ tag: "第四批标签", count: 1 }]);
		const tcBad = await app.inject({ method: "GET", url: "/api/tags/counts" });
		expect(tcBad.statusCode).toBe(400); // bankId 必填

		// history：出现本次练习会话，completed=false（未 finish），有 correct/total
		const ses = await post("/api/practice/start", {
			scope: { bankId: nbId, mode: "all" },
		});
		const sid = (ses.json() as { id: string }).id;
		const hist = await app.inject({ method: "GET", url: "/api/history/practices" });
		expect(hist.statusCode).toBe(200);
		const items = hist.json() as Array<{
			id: string;
			bankName: string;
			completed: boolean;
			correct: number;
			total: number;
			accuracy: number;
			answered: number;
		}>;
		expect(items.length).toBeGreaterThan(0);
		const mine = items.find((x) => x.bankName === "第四批库")!;
		expect(mine.id).toBe(sid);
		expect(mine.completed).toBe(false);
		// 精确值断言（审计 R2 否决项）：已知 2 题 1 对 1 错 → correct=1, total=2, accuracy=0.5
		expect(mine.correct).toBe(1);
		expect(mine.total).toBe(2);
		expect(mine.accuracy).toBeCloseTo(0.5);
		expect(mine.answered).toBe(2);

		// finish 后 history completed=true（闭环：历史与快照联动）
		const fin = await app.inject({
			method: "POST",
			url: `/api/practice/${sid}/finish`,
		});
		expect(fin.statusCode).toBe(200);
		const hist2 = await app.inject({ method: "GET", url: "/api/history/practices" });
		const items2 = hist2.json() as Array<{ id: string; completed: boolean }>;
		expect(items2.find((x) => x.id === sid)!.completed).toBe(true);
	});
});
