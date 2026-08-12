// REST API client（DEC-5：前端只经这些接口，绝不碰 Key）。
// SSE 流式接口（explain/ask/analyze）在 sse.ts，这里只放普通 REST。
import type {
	Bank,
	Question,
	QuestionDraft,
	GradeRequest,
	GradeResponse,
	ImportCommitRequest,
	ImportCommitResponse,
	ParseResult,
	Provider,
	ProviderUpsert,
	ModelInfo,
	ActiveModelSelection,
	PracticeScope,
	PracticeSession,
	PracticeGraded,
	FinishPracticeResponse,
	Scorecard,
	WrongBookItem,
	WrongBookQuery,
	LearningSnapshot,
	TrendHistoryResponse,
	DiagnosisResult,
	LearningPlan,
	LearningTask,
	TaskStatus,
	ValidateDraftsResponse,
	ConnTestResult,
	BankWithCount,
	QuestionUpsert,
	MoveCopyRequest,
	ApplyTagsRequest,
	AffectedCountResponse,
} from "@exam/shared";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
	// 只在带 body 时声明 JSON 头：空 body 的 DELETE/GET 带上 application/json
	// 会被 Fastify 以 FST_ERR_CTP_EMPTY_JSON_BODY 拒（400 Bad Request）。
	// FormData（multipart）也不能手设 Content-Type，交给浏览器带 boundary。
	const hasBody = init?.body !== undefined && init?.body !== null;
	const isForm =
		typeof FormData !== "undefined" && init?.body instanceof FormData;
	const headers: Record<string, string> = {
		...(hasBody && !isForm ? { "Content-Type": "application/json" } : {}),
		...((init?.headers as Record<string, string>) ?? {}),
	};
	const resp = await fetch(url, { ...init, headers });
	if (!resp.ok) {
		let msg = `请求失败 (${resp.status})`;
		try {
			const j = await resp.json();
			if (j?.error) msg = j.error;
		} catch {
			/* ignore */
		}
		throw new Error(msg);
	}
	if (resp.status === 204) return undefined as T;
	return resp.json() as Promise<T>;
}

export const api = {
	// ── 题库 / 题目 ──
	listBanks: () => req<Bank[]>("/api/banks"),
	listQuestions: (bankId: string) =>
		req<Question[]>(`/api/banks/${bankId}/questions`),
	deleteBank: (bankId: string) =>
		req<void>(`/api/banks/${bankId}`, { method: "DELETE" }),

	// ── v2：题库管理 ──
	listBanksWithCounts: () => req<BankWithCount[]>("/api/banks/with-counts"),
	listTags: () => req<string[]>("/api/tags"),
	createBank: (name: string) =>
		req<Bank>("/api/banks", { method: "POST", body: JSON.stringify({ name }) }),
	renameBank: (id: string, name: string) =>
		req<Bank>(`/api/banks/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ name }),
		}),
	addQuestion: (bankId: string, q: QuestionUpsert) =>
		req<Question>(`/api/banks/${bankId}/questions`, {
			method: "POST",
			body: JSON.stringify(q),
		}),
	updateQuestion: (qid: string, q: QuestionUpsert) =>
		req<Question>(`/api/questions/${qid}`, {
			method: "PUT",
			body: JSON.stringify(q),
		}),
	deleteQuestion: (qid: string) =>
		req<void>(`/api/questions/${qid}`, { method: "DELETE" }),
	moveCopyQuestions: (body: MoveCopyRequest) =>
		req<AffectedCountResponse>("/api/questions/move-copy", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	applyTags: (body: ApplyTagsRequest) =>
		req<AffectedCountResponse>("/api/questions/apply-tags", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	// ── 导入 ──
	parseText: (text: string) =>
		req<ParseResult>("/api/import/parse-text", {
			method: "POST",
			body: JSON.stringify({ text }),
		}),
	parseFile: (file: File) => {
		const fd = new FormData();
		fd.append("file", file);
		// multipart：不要手动设 Content-Type，交给浏览器带 boundary
		return req<ParseResult>("/api/import/parse-file", {
			method: "POST",
			body: fd,
			headers: {},
		});
	},
	commitImport: (body: ImportCommitRequest) =>
		req<ImportCommitResponse>("/api/import/commit", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	// ── 刷题 ──
	grade: (body: GradeRequest) =>
		req<GradeResponse>("/api/quiz/grade", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	// ── v2：练习会话 ──
	startPractice: (scope: PracticeScope) =>
		req<PracticeSession>("/api/practice/start", {
			method: "POST",
			body: JSON.stringify({ scope }),
		}),
	getPractice: (id: string) => req<PracticeSession>(`/api/practice/${id}`),
	savePracticeIndex: (id: string, currentIndex: number) =>
		req<void>(`/api/practice/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ currentIndex }),
		}),
	getScorecard: (id: string) => req<Scorecard>(`/api/practice/${id}/scorecard`),
	// v3 Slice 3：练习完成（成绩单 + 快照落库）
	finishPractice: (id: string) =>
		req<FinishPracticeResponse>(`/api/practice/${id}/finish`, { method: "POST" }),
	// P0-2：续做恢复已答判分态（questionId → 最新作答含 attemptId）
	getPracticeGraded: (id: string) =>
		req<PracticeGraded>(`/api/practice/${id}/graded`),

	// ── v2：错题本增强 ──
	listWrong: (q: WrongBookQuery = {}) => {
		const p = new URLSearchParams();
		if (q.bankId) p.set("bankId", q.bankId);
		if (q.type) p.set("type", q.type);
		if (q.tag) p.set("tag", q.tag);
		if (q.includeMastered) p.set("includeMastered", "1");
		const qs = p.toString();
		return req<WrongBookItem[]>(`/api/quiz/wrong${qs ? `?${qs}` : ""}`);
	},
	setMastered: (questionId: string, mastered: boolean) =>
		req<void>(`/api/quiz/wrong/${questionId}/master`, {
			method: "POST",
			body: JSON.stringify({ mastered }),
		}),

	// ── v2：学情快照（结构化，REST 即时）──
	insightsSnapshot: (bankId?: string) =>
		req<LearningSnapshot>(
			`/api/insights/snapshot${bankId ? `?bankId=${encodeURIComponent(bankId)}` : ""}`,
		),
	// v3 Slice 4：趋势历史（时间序列，REST 即时）
	getTrendHistory: (bankId?: string) =>
		req<TrendHistoryResponse>(
			`/api/insights/history${bankId ? `?bankId=${encodeURIComponent(bankId)}` : ""}`,
		),

	// ── v2：导入草稿校验 ──
	validateDrafts: (questions: QuestionDraft[]) =>
		req<ValidateDraftsResponse>("/api/import/validate", {
			method: "POST",
			body: JSON.stringify({ questions }),
		}),

	// ── 答疑历史 ──
	tutorHistory: (questionId: string) =>
		req<{ messages: { role: "user" | "assistant"; content: string }[] }>(
			`/api/tutor/history?questionId=${encodeURIComponent(questionId)}`,
		),

	// ── v3：AI 学习教练（Slice 5/6）──
	// 诊断：SSE 流式（POST），latest 走 REST（FR5.3 缓存）
	runDiagnosis: (bankId?: string) =>
		req<{ ok: true }>("/api/coach/diagnosis", {
			method: "POST",
			body: JSON.stringify(bankId ? { bankId } : {}),
		}),
	getDiagnosisLatest: (bankId?: string) =>
		req<{ results: DiagnosisResult[]; createdAt?: number }>(
			`/api/coach/diagnosis/latest${bankId ? `?bankId=${encodeURIComponent(bankId)}` : ""}`,
		),
	// 计划：SSE 流式生成（POST），列表/任务走 REST
	runPlan: (bankId?: string) =>
		req<{ ok: true }>("/api/coach/plan", {
			method: "POST",
			body: JSON.stringify(bankId ? { bankId } : {}),
		}),
	listPlans: () => req<LearningPlan[]>("/api/coach/plan"),
	getPlanTasks: (planId: string) => req<LearningTask[]>(`/api/coach/plan/${planId}/tasks`),
	updateTaskStatus: (taskId: string, status: TaskStatus) =>
		req<void>(`/api/coach/task/${taskId}/status`, {
			method: "PATCH",
			body: JSON.stringify({ status }),
		}),

	// ── Provider / 模型（DEC-19/20）──
	listProviders: () => req<Provider[]>("/api/providers"),
	createProvider: (body: ProviderUpsert) =>
		req<Provider>("/api/providers", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	updateProvider: (id: string, body: ProviderUpsert) =>
		req<Provider>(`/api/providers/${id}`, {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	deleteProvider: (id: string) =>
		req<void>(`/api/providers/${id}`, { method: "DELETE" }),
	testProvider: (id: string) =>
		req<ConnTestResult>(`/api/providers/${id}/test`, { method: "POST" }),
	listModels: () => req<ModelInfo[]>("/api/models"),
	// P0-3：读回当前激活模型（设置页刷新后仍能展示）
	getActiveModel: () => req<ActiveModelSelection | null>("/api/models/active"),
	setActiveModel: (body: ActiveModelSelection) =>
		req<{ ok: true }>("/api/settings/model", {
			method: "POST",
			body: JSON.stringify(body),
		}),
};

export type { QuestionDraft };
