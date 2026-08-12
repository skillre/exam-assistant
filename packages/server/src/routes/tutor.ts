import type { FastifyInstance } from "fastify";
import type { AiService } from "../ai/AiService.js";
import { questionRepo } from "../repositories/questionRepo.js";
import { attemptRepo } from "../repositories/attemptRepo.js";
import { tutorSessionRepo } from "../repositories/tutorSessionRepo.js";
import { buildExplainPrompt, TUTOR_SYSTEM_PROMPT } from "../ai/tutorPrompts.js";
import { openSse } from "./sseWriter.js";
import { readSessionHistory } from "../ai/sessionHistory.js";

// Phase 5：AI 讲解（SSE 流式）。判分后对某题生成"为什么对/错"讲解，
//   首条 prompt 注入题目+作答+判分上下文（OQ3），建/复用该题答疑会话（DEC-7）。
// Phase 6：错题多轮答疑（ask）+ 历史回读（history）。同一 AgentSession 历史自动累积。
// 第三批 卫生⑩：会话创建 in-flight 锁——并发 explain 同题时只建一次会话（评审 C1，不动 schema）。

// 每题的会话创建锁：并发请求等待第一个完成创建，之后统一 getByQuestion → openTutorSession。
// 各请求持有独立 session 对象（不共享 AgentSession），避免并发 streamPrompt 冲突。
const sessionCreationLocks = new Map<string, Promise<void>>();

async function ensureTutorSession(
	ai: AiService,
	questionId: string,
): Promise<{ session: Awaited<ReturnType<typeof ai.openTutorSession>> }> {
	const existing = tutorSessionRepo.getByQuestion(questionId);
	if (existing)
		return { session: await ai.openTutorSession(existing.jsonlPath) };

	let lock = sessionCreationLocks.get(questionId);
	if (!lock) {
		lock = (async () => {
			const created = await ai.createTutorSession({
				systemPrompt: TUTOR_SYSTEM_PROMPT,
			});
			// 双检查：等待期间其他请求可能已登记（防并发双建，评审 R5）
			if (!tutorSessionRepo.getByQuestion(questionId)) {
				tutorSessionRepo.create(questionId, created.jsonlPath);
			}
			// 统一由调用方 openTutorSession 打开，避免同一 JSONL 被两个 session 对象持有
			created.session.dispose();
		})().finally(() => {
			sessionCreationLocks.delete(questionId);
		});
		sessionCreationLocks.set(questionId, lock);
	}
	await lock;
	const record = tutorSessionRepo.getByQuestion(questionId);
	if (!record) throw new Error("会话创建失败（未登记）");
	return { session: await ai.openTutorSession(record.jsonlPath) };
}

export function registerTutorRoutes(app: FastifyInstance, ai: AiService): void {
	// ── Phase 5：讲解 ────────────────────────────────────────
	app.post<{ Body: { questionId?: string; attemptId?: string } }>(
		"/api/tutor/explain",
		async (req, reply) => {
			const { questionId, attemptId } = req.body ?? {};
			if (!questionId || !attemptId) {
				return reply.code(400).send({ error: "questionId/attemptId 必填" });
			}
			const question = questionRepo.get(questionId);
			if (!question) return reply.code(404).send({ error: "题目不存在" });
			const attempt = attemptRepo.get(attemptId);
			if (!attempt) return reply.code(404).send({ error: "作答记录不存在" });

			const sse = openSse(reply);
			let session: Awaited<ReturnType<typeof ai.openTutorSession>> | undefined;
			try {
				// 建/复用该题答疑会话（一题一会话，in-flight 锁防并发双建）
				const hadSession = !!tutorSessionRepo.getByQuestion(questionId);
				const { session: s } = await ensureTutorSession(ai, questionId);
				session = s;
				const firstPrompt = hadSession
					? "请再次讲解这道题，说明为什么正确答案成立。"
					: buildExplainPrompt(question, attempt.userAnswer, attempt.isCorrect);

				await ai.streamPrompt(session, firstPrompt, (chunk) =>
					sse.delta(chunk),
				);
				sse.done();
			} catch (err) {
				session?.dispose();
				sse.error((err as Error).message);
			} finally {
				session?.dispose();
			}
		},
	);

	// ── Phase 6：多轮追问 ────────────────────────────────────
	app.post<{ Body: { questionId?: string; message?: string } }>(
		"/api/tutor/ask",
		async (req, reply) => {
			const { questionId, message } = req.body ?? {};
			if (!questionId || !message || !message.trim()) {
				return reply.code(400).send({ error: "questionId/message 必填" });
			}
			const record = tutorSessionRepo.getByQuestion(questionId);
			if (!record) {
				return reply
					.code(409)
					.send({ error: "该题尚无答疑会话，请先请求讲解" });
			}

			const sse = openSse(reply);
			let session: Awaited<ReturnType<typeof ai.openTutorSession>> | undefined;
			try {
				session = await ai.openTutorSession(record.jsonlPath);
				await ai.streamPrompt(session, message, (chunk) => sse.delta(chunk));
				sse.done();
			} catch (err) {
				session?.dispose();
				sse.error((err as Error).message);
			} finally {
				session?.dispose();
			}
		},
	);

	// ── Phase 6：历史回读（非 SSE，读回 JSONL 渲染对话） ──────
	app.get<{ Querystring: { questionId?: string } }>(
		"/api/tutor/history",
		async (req, reply) => {
			const questionId = req.query?.questionId;
			if (!questionId)
				return reply.code(400).send({ error: "questionId 必填" });
			const record = tutorSessionRepo.getByQuestion(questionId);
			if (!record) return { messages: [] };
			const messages = readSessionHistory(record.jsonlPath, true);
			return { messages };
		},
	);
}
