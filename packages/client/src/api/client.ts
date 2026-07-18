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
  Scorecard,
  WrongBookItem,
  WrongBookQuery,
  LearningSnapshot,
  ValidateDraftsResponse,
  ConnTestResult,
} from '@exam/shared';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
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
  listBanks: () => req<Bank[]>('/api/banks'),
  listQuestions: (bankId: string) => req<Question[]>(`/api/banks/${bankId}/questions`),
  deleteBank: (bankId: string) => req<void>(`/api/banks/${bankId}`, { method: 'DELETE' }),

  // ── 导入 ──
  parseText: (text: string) =>
    req<ParseResult>('/api/import/parse-text', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  parseFile: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    // multipart：不要手动设 Content-Type，交给浏览器带 boundary
    return req<ParseResult>('/api/import/parse-file', { method: 'POST', body: fd, headers: {} });
  },
  commitImport: (body: ImportCommitRequest) =>
    req<ImportCommitResponse>('/api/import/commit', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── 刷题 ──
  grade: (body: GradeRequest) =>
    req<GradeResponse>('/api/quiz/grade', { method: 'POST', body: JSON.stringify(body) }),

  // ── v2：练习会话 ──
  startPractice: (scope: PracticeScope) =>
    req<PracticeSession>('/api/practice/start', {
      method: 'POST',
      body: JSON.stringify({ scope }),
    }),
  getPractice: (id: string) => req<PracticeSession>(`/api/practice/${id}`),
  savePracticeIndex: (id: string, currentIndex: number) =>
    req<void>(`/api/practice/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ currentIndex }),
    }),
  getScorecard: (id: string) => req<Scorecard>(`/api/practice/${id}/scorecard`),

  // ── v2：错题本增强 ──
  listWrong: (q: WrongBookQuery = {}) => {
    const p = new URLSearchParams();
    if (q.bankId) p.set('bankId', q.bankId);
    if (q.type) p.set('type', q.type);
    if (q.tag) p.set('tag', q.tag);
    if (q.includeMastered) p.set('includeMastered', '1');
    const qs = p.toString();
    return req<WrongBookItem[]>(`/api/quiz/wrong${qs ? `?${qs}` : ''}`);
  },
  setMastered: (questionId: string, mastered: boolean) =>
    req<void>(`/api/quiz/wrong/${questionId}/master`, {
      method: 'POST',
      body: JSON.stringify({ mastered }),
    }),

  // ── v2：学情快照（结构化，REST 即时）──
  insightsSnapshot: (bankId?: string) =>
    req<LearningSnapshot>(
      `/api/insights/snapshot${bankId ? `?bankId=${encodeURIComponent(bankId)}` : ''}`,
    ),

  // ── v2：导入草稿校验 ──
  validateDrafts: (questions: QuestionDraft[]) =>
    req<ValidateDraftsResponse>('/api/import/validate', {
      method: 'POST',
      body: JSON.stringify({ questions }),
    }),

  // ── 答疑历史 ──
  tutorHistory: (questionId: string) =>
    req<{ messages: { role: 'user' | 'assistant'; content: string }[] }>(
      `/api/tutor/history?questionId=${encodeURIComponent(questionId)}`,
    ),

  // ── Provider / 模型（DEC-19/20）──
  listProviders: () => req<Provider[]>('/api/providers'),
  createProvider: (body: ProviderUpsert) =>
    req<Provider>('/api/providers', { method: 'POST', body: JSON.stringify(body) }),
  updateProvider: (id: string, body: ProviderUpsert) =>
    req<Provider>(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteProvider: (id: string) => req<void>(`/api/providers/${id}`, { method: 'DELETE' }),
  testProvider: (id: string) =>
    req<ConnTestResult>(`/api/providers/${id}/test`, { method: 'POST' }),
  listModels: () => req<ModelInfo[]>('/api/models'),
  setActiveModel: (body: ActiveModelSelection) =>
    req<{ ok: true }>('/api/settings/model', { method: 'POST', body: JSON.stringify(body) }),
};

export type { QuestionDraft };
