import type { FastifyInstance } from "fastify";
import { rm } from "node:fs/promises";
import type {
	GradeRequest,
	GradeResponse,
	StartPracticeRequest,
	UpdatePracticeRequest,
	PracticeScope,
	Scorecard,
	Question,
	QuestionType,
} from "@exam/shared";
import { bankRepo } from "../repositories/bankRepo.js";
import { questionRepo } from "../repositories/questionRepo.js";
import { attemptRepo } from "../repositories/attemptRepo.js";
import { practiceRepo } from "../repositories/practiceRepo.js";
import { wrongBookRepo } from "../repositories/wrongBookRepo.js";
import { tutorSessionRepo } from "../repositories/tutorSessionRepo.js";
import { gradeQuestion } from "../grading/grade.js";
import { checkMasteryAfterGrade } from "../services/masteryService.js";
import { toCsv } from "../export/csv.js";
import { snapshotRepo } from "../repositories/snapshotRepo.js";
import type { AiService } from "../ai/AiService.js";
import { ESSAY_GRADING_SYSTEM } from "../ai/essayGradingPrompts.js";
import { essayGradingSchema } from "../import/essayGradingSchema.js";

// 主观题 AI 评分超时（毫秒）：LLM 挂起时不让 grade 无限等，降级为 5xx 可重试。
const ESSAY_GRADING_TIMEOUT_MS = 30_000;

// 第五批：主观题 AI 判分。AI 输出经 zod 校验，失败/超时一律抛错→grade 端点 5xx 且不落库。
async function gradeEssayWithAi(
	ai: Pick<AiService, "runOnce">,
	question: Question,
	userAnswer: string,
): Promise<{ isCorrect: boolean; feedback: string }> {
	const prompt = `题目：${question.stem}
参考答案：${typeof question.answer === "string" ? question.answer : ""}
评分要点：${question.explanation ?? ""}
考生答案：${userAnswer}`;
	const raw = await ai.runOnce(ESSAY_GRADING_SYSTEM, prompt, ESSAY_GRADING_TIMEOUT_MS);
	const parsed = essayGradingSchema.safeParse(JSON.parse(raw));
	if (!parsed.success) {
		throw new Error("AI 评分输出非法：" + parsed.error.issues.map((i) => i.message).join(";"));
	}
	return parsed.data;
}

// v2：按练习范围解析题目集（未做/错过/题型/标签），可乱序。
function resolveScopeQuestions(scope: PracticeScope): Question[] {
	let questions = questionRepo.listByBank(scope.bankId);

	switch (scope.mode) {
		case "undone": {
			const answered = attemptRepo.answeredQuestionIds(scope.bankId);
			questions = questions.filter((q) => !answered.has(q.id));
			break;
		}
		case "wrong": {
			const wrongIds = new Set(
				attemptRepo.listWrongDetailed().map((w) => w.question.id),
			);
			const mastered = wrongBookRepo.listMasteredIds();
			questions = questions.filter(
				(q) => wrongIds.has(q.id) && !mastered.has(q.id),
			);
			break;
		}
		case "byType":
			if (scope.type)
				questions = questions.filter((q) => q.type === scope.type);
			break;
		case "byTag":
			if (scope.tag)
				questions = questions.filter((q) =>
					(q.tags ?? []).includes(scope.tag!),
				);
			break;
		case "all":
		default:
			break;
	}

	if (scope.shuffle) shuffle(questions);
	return questions;
}

// Fisher-Yates 就地打乱
function shuffle<T>(arr: T[]): void {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j]!, arr[i]!];
	}
}

// Phase 4：刷题闭环。判分纯程序、确定性（DEC-3），每次作答落 attempt。

export function registerQuizRoutes(
	app: FastifyInstance,
	ai?: Pick<AiService, "runOnce">,
): void {
	// 题库列表
	app.get("/api/banks", async () => bankRepo.list());

	// 某题库的题目
	app.get<{ Params: { id: string } }>(
		"/api/banks/:id/questions",
		async (req, reply) => {
			const bank = bankRepo.get(req.params.id);
			if (!bank) return reply.code(404).send({ error: "题库不存在" });
			return questionRepo.listByBank(req.params.id);
		},
	);

	// 判分 + 落库。attemptId 回传供 tutor/explain 关联（评审 #4）。
	// v3 Slice 2：判分后挂掌握度闭环钩子（连续答对 3 次→已掌握→联动错题本）。
	app.post<{ Body: GradeRequest }>("/api/quiz/grade", async (req, reply) => {
		const { questionId, userAnswer } = req.body ?? {};
		if (!questionId || userAnswer === undefined) {
			return reply.code(400).send({ error: "questionId/userAnswer 必填" });
		}
		const question = questionRepo.get(questionId);
		if (!question) return reply.code(404).send({ error: "题目不存在" });

		// 第五批：essay 走 AI 评分（异步），客观题保持原有同步规则判分（契约不变）
		if (question.type === "essay") {
			if (typeof userAnswer !== "string" || userAnswer.trim() === "") {
				return reply.code(400).send({ error: "essay 题答案不能为空" });
			}
			if (!ai) {
				return reply.code(503).send({ error: "AI 未配置，无法批改主观题" });
			}
			let graded: { isCorrect: boolean; feedback: string };
			try {
				graded = await gradeEssayWithAi(ai, question, userAnswer);
			} catch (err) {
				// AI 失败/超时/输出非法：5xx 且不落库（前端可重试，不污染错题本）
				return reply.code(502).send({
					error: `主观题批改失败：${err instanceof Error ? err.message : "未知错误"}`,
				});
			}
			const attemptId = attemptRepo.record(questionId, userAnswer, graded.isCorrect);
			const mastered = checkMasteryAfterGrade(questionId, graded.isCorrect);
			return {
				attemptId,
				isCorrect: graded.isCorrect,
				correctAnswer: question.answer,
				feedback: graded.feedback,
				...(mastered ? { mastered: true } : {}),
			};
		}

		const isCorrect = gradeQuestion(question, userAnswer);
		const attemptId = attemptRepo.record(questionId, userAnswer, isCorrect);

		// Slice 2: 掌握度闭环（streak 更新 + 达标自动标记，返回刚达标标志）
		const mastered = checkMasteryAfterGrade(questionId, isCorrect);

		const res: GradeResponse = {
			attemptId,
			isCorrect,
			correctAnswer: question.answer,
			...(mastered ? { mastered: true } : {}),
		};
		return res;
	});

	// 错题本增强：错误次数/最近错误时间 + 已掌握软标记 + 筛选（DEC-28）
	app.get<{
		Querystring: {
			bankId?: string;
			type?: QuestionType;
			tag?: string;
			includeMastered?: string;
		};
	}>("/api/quiz/wrong", async (req) => {
		const { bankId, type, tag, includeMastered } = req.query ?? {};
		const mastered = wrongBookRepo.listMasteredIds();
		const withMastered = includeMastered === "1" || includeMastered === "true";
		return attemptRepo
			.listWrongDetailed()
			.filter((w) => {
				if (bankId && w.question.bankId !== bankId) return false;
				if (type && w.question.type !== type) return false;
				if (tag && !(w.question.tags ?? []).includes(tag)) return false;
				if (!withMastered && mastered.has(w.question.id)) return false;
				return true;
			})
			.map((w) => ({
				question: w.question,
				wrongCount: w.wrongCount,
				lastWrongAt: w.lastWrongAt,
				mastered: mastered.has(w.question.id),
			}));
	});

	// 标记/取消错题「已掌握」（软移除，可恢复，DEC-28）
	app.post<{ Params: { questionId: string }; Body: { mastered: boolean } }>(
		"/api/quiz/wrong/:questionId/master",
		async (req, reply) => {
			const q = questionRepo.get(req.params.questionId);
			if (!q) return reply.code(404).send({ error: "题目不存在" });
			if (typeof req.body?.mastered !== "boolean") {
				return reply.code(400).send({ error: "mastered 必须是布尔值" });
			}
			wrongBookRepo.setMastered(req.params.questionId, req.body.mastered);
			return reply.code(204).send();
		},
	);

	// ── v2：练习会话（范围/筛选/乱序/进度/成绩单，DEC-24/25） ──

	// 开始一套练习：按范围解析题目、定序落库，返回会话
	app.post<{ Body: StartPracticeRequest }>(
		"/api/practice/start",
		async (req, reply) => {
			const scope = req.body?.scope;
			if (!scope || !scope.bankId || !scope.mode) {
				return reply.code(400).send({ error: "scope.bankId/mode 必填" });
			}
			const bank = bankRepo.get(scope.bankId);
			if (!bank) return reply.code(404).send({ error: "题库不存在" });

			const questions = resolveScopeQuestions(scope);
			if (questions.length === 0) {
				return reply.code(409).send({ error: "该范围下没有题目" });
			}
			return practiceRepo.create(
				scope,
				questions.map((q) => q.id),
			);
		},
	);

	// 续做：读回练习会话（含定序题目 id 与进度指针）
	app.get<{ Params: { id: string } }>(
		"/api/practice/:id",
		async (req, reply) => {
			const session = practiceRepo.get(req.params.id);
			if (!session) return reply.code(404).send({ error: "练习会话不存在" });
			return session;
		},
	);

	// 保存续做进度指针
	app.patch<{ Params: { id: string }; Body: UpdatePracticeRequest }>(
		"/api/practice/:id",
		async (req, reply) => {
			const session = practiceRepo.get(req.params.id);
			if (!session) return reply.code(404).send({ error: "练习会话不存在" });
			const idx = req.body?.currentIndex;
			if (typeof idx !== "number" || idx < 0) {
				return reply.code(400).send({ error: "currentIndex 非法" });
			}
			practiceRepo.updateIndex(req.params.id, idx);
			return reply.code(204).send();
		},
	);

	// 成绩单：对本会话题目取每题最新一次作答，聚合正确率与分布
	app.get<{ Params: { id: string } }>(
		"/api/practice/:id/scorecard",
		async (req, reply) => {
			const session = practiceRepo.get(req.params.id);
			if (!session) return reply.code(404).send({ error: "练习会话不存在" });
			return buildScorecard(session.id, session.questionIds);
		},
	);

	// v3 Slice 3（D5）：练习完成 —— 成绩单 + 快照落库（幂等，session_id UNIQUE）。
	app.post<{ Params: { id: string } }>(
		"/api/practice/:id/finish",
		async (req, reply) => {
			const session = practiceRepo.get(req.params.id);
			if (!session) return reply.code(404).send({ error: "练习会话不存在" });

			const sc = buildScorecard(session.id, session.questionIds);
			const snapshot = snapshotRepo.save({
				sessionId: session.id, // 幂等键（UNIQUE）
				bankId: session.bankId,
				total: sc.total,
				correct: sc.correct,
				accuracy: sc.accuracy,
				byTag: sc.byTag,
				byType: sc.byType,
			});
			// 幂等重放（已落过）也返回成绩单；snapshotId 为 null 时前端可忽略
			return { scorecard: sc, snapshotId: snapshot?.id ?? null };
		},
	);

	// P0-2：已答判分态（续做恢复用）。questionId → 最新一次作答（含 correctAnswer）。
	app.get<{ Params: { id: string } }>(
		"/api/practice/:id/graded",
		async (req, reply) => {
			const session = practiceRepo.get(req.params.id);
			if (!session) return reply.code(404).send({ error: "练习会话不存在" });
			const latest = attemptRepo.latestAttempts(session.questionIds);
			const graded: Record<string, GradeResponse & { answeredAt: number }> = {};
			for (const qid of session.questionIds) {
				const att = latest.get(qid);
				if (!att) continue;
				const q = questionRepo.get(qid);
				if (!q) continue; // 题目已被删除：跳过，与成绩单口径一致
				graded[qid] = {
					attemptId: att.attemptId,
					isCorrect: att.isCorrect,
					correctAnswer: q.answer,
					answeredAt: att.answeredAt,
				};
			}
			return graded;
		},
	);

	// ── 第四批 ①：CSV 导出（RFC4180 手写转义，列与导入模板同构：type,stem,options,answer,explanation,tags）──
	app.get<{ Params: { bankId: string } }>(
		"/api/export/:bankId/questions.csv",
		async (req, reply) => {
			const bank = bankRepo.get(req.params.bankId);
			if (!bank) return reply.code(404).send({ error: "题库不存在" });
			const questions = questionRepo.listByBank(bank.id);
			const rows: unknown[][] = [
				["type", "stem", "options", "answer", "explanation", "tags"],
				...questions.map((q) => [
					q.type,
					q.stem,
					JSON.stringify(q.options ?? []),
					JSON.stringify(q.answer),
					q.explanation ?? "",
					(q.tags ?? []).join("|"),
				]),
			];
			// filename 用 ASCII（bank.id），中文文件名由前端 a.download 指定（HTTP 头不允许非 ASCII）
			return reply
				.header("Content-Type", "text/csv; charset=utf-8")
				.header(
					"Content-Disposition",
					`attachment; filename="exam-${bank.id}.csv"`,
				)
				.send(toCsv(rows));
		},
	);

	// 第四批 ①：全库错题导出（各题最新一次作答 is_correct=0），追加 wrong_answer 列。
	app.get("/api/export/wrong.csv", async (_req, reply) => {
		const questions = questionRepo.listAll();
		const latest = attemptRepo.latestWithAnswers(questions.map((q) => q.id));
		const wrong = questions.filter((q) => {
			const att = latest.get(q.id);
			return att !== undefined && !att.isCorrect;
		});
		const rows: unknown[][] = [
			["type", "stem", "options", "answer", "explanation", "tags", "wrong_answer"],
			...wrong.map((q) => [
				q.type,
				q.stem,
				JSON.stringify(q.options ?? []),
				JSON.stringify(q.answer),
				q.explanation ?? "",
				(q.tags ?? []).join("|"),
				JSON.stringify(latest.get(q.id)!.userAnswer),
			]),
		];
		return reply
			.header("Content-Type", "text/csv; charset=utf-8")
			.header(
				"Content-Disposition",
				`attachment; filename="exam-wrong-${new Date().toISOString().slice(0, 10)}.csv"`,
			)
			.send(toCsv(rows));
	});

	// ── 第四批 ②：练习历史（最近 30 个会话，倒序；正确率复用 buildScorecard）──
	app.get("/api/history/practices", async () => {
		const recent = practiceRepo.listRecent(30);
		return recent.map((r) => {
			const session = practiceRepo.get(r.id);
			const score = session ? buildScorecard(session.id, session.questionIds) : null;
			return {
				...r,
				correct: score?.correct ?? 0,
				total: score?.total ?? 0,
				accuracy: score?.accuracy ?? 0,
				answered: score?.answered ?? 0,
			};
		});
	});

	// 标记/取消错题"已掌握"（软标记，DEC-28）
	// 删除题库：先删该库答疑 JSONL 文件（避免孤儿），再删库（外键 CASCADE
	// 清 questions/attempts/tutor_sessions 行，DEC-13）。
	app.delete<{ Params: { id: string } }>(
		"/api/banks/:id",
		async (req, reply) => {
			const bank = bankRepo.get(req.params.id);
			if (!bank) return reply.code(404).send({ error: "题库不存在" });

			const jsonlPaths = tutorSessionRepo.listJsonlPathsByBank(req.params.id);
			await Promise.all(
				jsonlPaths.map((p) =>
					rm(p, { force: true }).catch(() => {
						/* 文件缺失忽略 */
					}),
				),
			);
			bankRepo.remove(req.params.id);
			return reply.code(204).send();
		},
	);
}

// v2：组装成绩单 —— 每题取最新一次作答，聚合正确率与分布。
// 第四批：模块私有改导出（history 路由复用；逻辑零改动）。
export function buildScorecard(sessionId: string, questionIds: string[]): Scorecard {
	const latest = attemptRepo.latestByQuestion(questionIds);
	const byTypeMap = new Map<QuestionType, { total: number; correct: number }>();
	const byTagMap = new Map<string, { total: number; correct: number }>();
	const wrongQuestionIds: string[] = [];
	let answered = 0;
	let correct = 0;

	for (const qid of questionIds) {
		const q = questionRepo.get(qid);
		if (!q) continue;
		const att = latest.get(qid);
		const t = byTypeMap.get(q.type) ?? { total: 0, correct: 0 };
		t.total += 1;
		const tags = (q.tags ?? []).length > 0 ? q.tags! : ["未分类"];
		for (const tag of tags) {
			const entry = byTagMap.get(tag) ?? { total: 0, correct: 0 };
			entry.total += 1;
			byTagMap.set(tag, entry);
		}
		if (att) {
			answered += 1;
			if (att.isCorrect) {
				correct += 1;
				t.correct += 1;
				for (const tag of tags) byTagMap.get(tag)!.correct += 1;
			} else {
				wrongQuestionIds.push(qid);
			}
		}
		byTypeMap.set(q.type, t);
	}

	return {
		sessionId,
		total: questionIds.length,
		answered,
		correct,
		accuracy: answered > 0 ? correct / answered : 0,
		byType: [...byTypeMap.entries()].map(([type, s]) => ({
			type,
			total: s.total,
			correct: s.correct,
		})),
		byTag: [...byTagMap.entries()].map(([tag, s]) => ({
			tag,
			total: s.total,
			correct: s.correct,
		})),
		wrongQuestionIds,
	};
}
