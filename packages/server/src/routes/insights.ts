import type { FastifyInstance } from "fastify";
import type { AiService } from "../ai/AiService.js";
import { learningDataCollector } from "../insights/LearningDataCollector.js";
import {
	buildInsightsPrompt,
	INSIGHTS_SYSTEM_PROMPT,
} from "../ai/insightsPrompts.js";
import { openSse } from "./sseWriter.js";
import { buildTrendHistory } from "../insights/snapshotHistory.js";

// Phase 7：错因归纳 + 学情分析（SSE 流式）。
// 跨源汇集（DEC-12）→ 一次性分析会话 → 流式推报告。分析是无状态一次性任务，
// 用临时讲解会话跑完即弃（不落 tutor_sessions）。

export function registerInsightsRoutes(
	app: FastifyInstance,
	ai: AiService,
): void {
	// v2：结构化学情快照（REST 即时返回，非 SSE，DEC-24）。空记录返回空快照而非 409，
	// 让前端面板能显示「暂无数据」。
	app.get<{ Querystring: { bankId?: string } }>(
		"/api/insights/snapshot",
		async (req) => {
			return learningDataCollector.collect(req.query?.bankId);
		},
	);

	// v3 Slice 4：趋势历史（REST 即时，D34 双维时间序列）
	app.get<{ Querystring: { bankId?: string } }>(
		"/api/insights/history",
		async (req) => {
			return buildTrendHistory(req.query?.bankId);
		},
	);

	app.post<{ Body: { bankId?: string } }>(
		"/api/insights/analyze",
		async (req, reply) => {
			const bankId = req.body?.bankId;

			const snapshot = await learningDataCollector.collect(bankId);
			if (snapshot.totalAttempts === 0) {
				return reply
					.code(409)
					.send({ error: "暂无做题记录，先做几道题再来分析" });
			}

			const sse = openSse(reply);
			let session:
				| Awaited<ReturnType<typeof ai.createTutorSession>>["session"]
				| undefined;
			try {
				const created = await ai.createTutorSession({
					systemPrompt: INSIGHTS_SYSTEM_PROMPT,
				});
				session = created.session;
				const prompt = buildInsightsPrompt(snapshot);
				await ai.streamPrompt(session, prompt, (chunk) => sse.delta(chunk));
				sse.done();
			} catch (err) {
				session?.dispose();
				sse.error((err as Error).message);
			} finally {
				session?.dispose();
			}
		},
	);
}
