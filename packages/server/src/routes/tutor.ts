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
				// 建/复用该题答疑会话（一题一会话，复用不重复建）
				const existing = tutorSessionRepo.getByQuestion(questionId);
				let firstPrompt: string;
				if (existing) {
					session = await ai.openTutorSession(existing.jsonlPath);
					// 已有会话：作为新一轮讲解请求（历史里已有题目上下文）
					firstPrompt = "请再次讲解这道题，说明为什么正确答案成立。";
				} else {
					const created = await ai.createTutorSession({
						systemPrompt: TUTOR_SYSTEM_PROMPT,
					});
					session = created.session;
					tutorSessionRepo.create(questionId, created.jsonlPath);
					firstPrompt = buildExplainPrompt(
						question,
						attempt.userAnswer,
						attempt.isCorrect,
					);
				}

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
