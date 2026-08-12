import type { AnswerValue, QuestionType } from "@exam/shared";
import { db } from "../db/index.js";
import { readSessionHistory } from "../ai/sessionHistory.js";

// 诊断数据采集器（Slice 5，DEC-33）：汇集错题详情 + 干扰项统计 + 答疑上下文，
// 作为 AI 错因归类的结构化输入信号。

interface WrongAttemptRow {
	question_id: string;
	stem: string;
	type: string;
	options: string; // JSON
	answer: string; // JSON
	user_answer: string; // JSON
	tags: string | null; // JSON
}

export interface DiagnosisInput {
	questionId: string;
	stem: string;
	options: string[];
	correctAnswer: AnswerValue;
	userAnswer: AnswerValue;
	type: QuestionType;
	tags: string[];
}

/** 干扰项统计（扁平版，Slice0 对账 T8）：每题被错选的选项 */
export interface DistractorStat {
	questionId: string;
	stem: string;
	option: string;
	selectedCount: number;
	totalAttempts: number;
}

export interface DiagnosisContext {
	wrongAttempts: DiagnosisInput[];
	distractorStats: DistractorStat[];
	tutorHighlights: string[];
}

function parseJson<T>(raw: string, fallback: T): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/** 采集诊断上下文：错题详情 + 干扰项统计 + 答疑要点 */
export async function collectDiagnosisContext(
	bankId?: string,
): Promise<DiagnosisContext> {
	const wrongAttempts = queryWrongAttempts(bankId);
	const distractorStats = aggregateDistractors(bankId);
	const tutorHighlights = await collectTutorHighlights(bankId);

	return { wrongAttempts, distractorStats, tutorHighlights };
}

function queryWrongAttempts(bankId?: string): DiagnosisInput[] {
	let sql = `
    SELECT q.id AS question_id, q.stem, q.type, q.options, q.answer,
           a.user_answer, q.tags
    FROM attempts a
    JOIN questions q ON q.id = a.question_id
    WHERE a.is_correct = 0
  `;
	const params: unknown[] = [];
	if (bankId) {
		sql += " AND q.bank_id = ?";
		params.push(bankId);
	}
	sql += " ORDER BY a.answered_at DESC LIMIT 50";

	const rows = db.prepare(sql).all(...params) as WrongAttemptRow[];
	return rows.map((row) => ({
		questionId: row.question_id,
		stem: row.stem,
		options: parseJson(row.options, [] as string[]),
		correctAnswer: parseJson(row.answer, 0 as AnswerValue),
		userAnswer: parseJson(row.user_answer, 0 as AnswerValue),
		type: row.type as QuestionType,
		tags: row.tags ? parseJson(row.tags, [] as string[]) : [],
	}));
}

/** 干扰项统计：每题被错选的选项及其次数 */
function aggregateDistractors(bankId?: string): DistractorStat[] {
	let sql = `
    SELECT q.id AS question_id, q.stem, q.options,
           a.user_answer, COUNT(a.id) AS cnt
    FROM attempts a
    JOIN questions q ON q.id = a.question_id
    WHERE a.is_correct = 0
  `;
	const params: unknown[] = [];
	if (bankId) {
		sql += " AND q.bank_id = ?";
		params.push(bankId);
	}
	sql += " GROUP BY q.id, a.user_answer ORDER BY cnt DESC LIMIT 30";

	const rows = db.prepare(sql).all(...params) as {
		question_id: string;
		stem: string;
		options: string;
		user_answer: string;
		cnt: number;
	}[];

	const totalByQuestion = new Map<string, number>();
	for (const r of rows) {
		totalByQuestion.set(
			r.question_id,
			(totalByQuestion.get(r.question_id) ?? 0) + r.cnt,
		);
	}

	const stats: DistractorStat[] = [];
	for (const r of rows) {
		const options = parseJson(r.options, [] as string[]);
		const userAnswer = parseJson(r.user_answer, 0 as AnswerValue);
		const optionText = formatOption(userAnswer, options);
		if (!optionText) continue;
		stats.push({
			questionId: r.question_id,
			stem: r.stem,
			option: optionText,
			selectedCount: r.cnt,
			totalAttempts: totalByQuestion.get(r.question_id) ?? r.cnt,
		});
	}
	return stats;
}

function formatOption(value: unknown, options: string[]): string {
	if (typeof value === "number") {
		return `${String.fromCharCode(65 + value)}. ${options[value] ?? "(越界)"}`;
	}
	if (Array.isArray(value)) {
		return value
			.map(
				(i) =>
					`${String.fromCharCode(65 + i)}. ${options[i as number] ?? "(越界)"}`,
			)
			.join("+");
	}
	return "";
}

/** 从答疑会话 JSONL 提炼学生追问（skipFirstUserTurn 语义：跳过注入的讲解 prompt） */
async function collectTutorHighlights(bankId?: string): Promise<string[]> {
	let rows: { question_id: string; jsonl_path: string }[];
	if (bankId) {
		rows = db
			.prepare(
				`SELECT ts.question_id, ts.jsonl_path FROM tutor_sessions ts
         JOIN questions q ON q.id = ts.question_id
         WHERE q.bank_id = ?`,
			)
			.all(bankId) as { question_id: string; jsonl_path: string }[];
	} else {
		rows = db
			.prepare("SELECT question_id, jsonl_path FROM tutor_sessions")
			.all() as { question_id: string; jsonl_path: string }[];
	}

	const highlights: string[] = [];
	for (const r of rows) {
		const turns = readSessionHistory(r.jsonl_path, true);
		const userAsks = turns.filter((t) => t.role === "user");
		for (const ask of userAsks) {
			const trimmed = ask.content.slice(0, 60);
			if (trimmed) highlights.push(trimmed);
		}
	}
	return highlights.slice(0, 20);
}
