import { useEffect, useState, useCallback } from 'react';
import type {
  Bank,
  Question,
  GradeResponse,
  PracticeSession,
  PracticeMode,
  PracticeScope,
  Scorecard as ScorecardData,
  QuestionType,
} from '@exam/shared';
import { api } from '../api/client.js';
import { QuestionCard } from '../components/QuestionCard.js';
import { TutorPanel } from '../components/TutorPanel.js';
import { QuestionNav } from '../components/QuestionNav.js';
import { Scorecard } from '../components/Scorecard.js';

const LS_KEY = 'exam.activePracticeSession';

interface Props {
  // 学情下钻/错题跳转带入的初始筛选（FR3.4）
  initialScope?: Partial<PracticeScope> | null;
  onNavigateWrong?: () => void;
}

// 刷题页 v2：范围选择 → 练习会话 → 题号导航 + 进度续做 → 成绩单。
export function QuizPage({ initialScope, onNavigateWrong }: Props = {}) {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankId, setBankId] = useState('');
  const [mode, setMode] = useState<PracticeMode>('all');
  const [qType, setQType] = useState<QuestionType | ''>('');
  const [tag, setTag] = useState('');
  const [shuffle, setShuffle] = useState(false);

  const [session, setSession] = useState<PracticeSession | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [idx, setIdx] = useState(0);
  const [gradedById, setGradedById] = useState<Record<string, GradeResponse | undefined>>({});
  const [scorecard, setScorecard] = useState<ScorecardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listBanks().then(setBanks).catch((e) => setError((e as Error).message));
  }, []);

  // 下钻进入：预填题库/标签范围
  useEffect(() => {
    if (initialScope?.bankId) setBankId(initialScope.bankId);
    if (initialScope?.mode) setMode(initialScope.mode);
    if (initialScope?.tag) {
      setTag(initialScope.tag);
      setMode('byTag');
    }
  }, [initialScope]);

  // 挂载时尝试续做上次会话（FR1.3）
  useEffect(() => {
    const saved = localStorage.getItem(LS_KEY);
    if (!saved) return;
    resumeSession(saved).catch(() => localStorage.removeItem(LS_KEY));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadSessionQuestions(s: PracticeSession) {
    // 按 session.questionIds 的定序拉取题目（乱序也保持落库顺序）
    const all = await api.listQuestions(s.bankId);
    const byId = new Map(all.map((q) => [q.id, q]));
    const ordered = s.questionIds.map((id) => byId.get(id)).filter((q): q is Question => !!q);
    setQuestions(ordered);
  }

  async function resumeSession(id: string) {
    const s = await api.getPractice(id);
    setSession(s);
    setBankId(s.bankId);
    await loadSessionQuestions(s);
    setIdx(s.currentIndex);
    setScorecard(null);
    setGradedById({});
    localStorage.setItem(LS_KEY, s.id);
  }

  async function start() {
    setError('');
    setScorecard(null);
    if (!bankId) {
      setError('请先选择题库');
      return;
    }
    const scope: PracticeScope = {
      bankId,
      mode,
      shuffle,
      ...(mode === 'byType' && qType ? { type: qType } : {}),
      ...(mode === 'byTag' && tag ? { tag } : {}),
    };
    try {
      const s = await api.startPractice(scope);
      setSession(s);
      await loadSessionQuestions(s);
      setIdx(0);
      setGradedById({});
      localStorage.setItem(LS_KEY, s.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const current = questions[idx];
  const graded = current ? gradedById[current.id] : undefined;

  async function onGrade(answer: Question['answer']) {
    if (!current) return;
    try {
      const r = await api.grade({ questionId: current.id, userAnswer: answer });
      setGradedById((m) => ({ ...m, [current.id]: r }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const persistIndex = useCallback(
    (nextIdx: number) => {
      if (session) api.savePracticeIndex(session.id, nextIdx).catch(() => {});
    },
    [session],
  );

  function jump(i: number) {
    const clamped = Math.max(0, Math.min(i, questions.length - 1));
    setIdx(clamped);
    persistIndex(clamped);
  }

  async function finish() {
    if (!session) return;
    try {
      setScorecard(await api.getScorecard(session.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function reset() {
    setSession(null);
    setQuestions([]);
    setScorecard(null);
    setGradedById({});
    setIdx(0);
    localStorage.removeItem(LS_KEY);
  }

  async function removeBank() {
    if (!bankId) return;
    if (!confirm('删除该题库？其题目、作答记录和答疑历史都会一并清除。')) return;
    try {
      await api.deleteBank(bankId);
      setBanks((bs) => bs.filter((b) => b.id !== bankId));
      setBankId('');
      reset();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // 键盘操作（FR1.6，渐进增强）
  useEffect(() => {
    if (!current || scorecard) return;
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft') jump(idx - 1);
      else if (e.key === 'ArrowRight') jump(idx + 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, idx, scorecard, questions.length]);

  const MODE_LABEL: Record<PracticeMode, string> = {
    all: '全部题目',
    undone: '仅未做',
    wrong: '仅错过',
    byType: '按题型',
    byTag: '按知识点',
  };

  return (
    <div>
      <h1>刷题</h1>
      {error && <div className="error">⚠ {error}</div>}

      {!session && (
        <div className="card">
          <label>选择题库</label>
          <div className="row">
            <select value={bankId} onChange={(e) => setBankId(e.target.value)} style={{ flex: 1 }}>
              <option value="">— 请选择 —</option>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            {bankId && (
              <button className="btn danger" onClick={removeBank}>
                删除题库
              </button>
            )}
          </div>
          {banks.length === 0 && <p className="muted">还没有题库，先去「导入」页添加题目。</p>}

          <label>练习范围</label>
          <div className="row">
            <select value={mode} onChange={(e) => setMode(e.target.value as PracticeMode)}>
              {(Object.keys(MODE_LABEL) as PracticeMode[]).map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
            {mode === 'byType' && (
              <select value={qType} onChange={(e) => setQType(e.target.value as QuestionType)}>
                <option value="">选题型</option>
                <option value="single">单选</option>
                <option value="multiple">多选</option>
                <option value="boolean">判断</option>
              </select>
            )}
            {mode === 'byTag' && (
              <input
                placeholder="知识点标签"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                style={{ flex: 1 }}
              />
            )}
          </div>

          <label className="row" style={{ cursor: 'pointer', marginTop: 12 }}>
            <input
              type="checkbox"
              checked={shuffle}
              onChange={(e) => setShuffle(e.target.checked)}
              style={{ width: 'auto' }}
            />
            <span>乱序练习</span>
          </label>

          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" onClick={start}>
              开始练习
            </button>
          </div>
        </div>
      )}

      {session && scorecard && (
        <Scorecard
          data={scorecard}
          onReviewWrong={() => onNavigateWrong?.()}
          onRestart={reset}
        />
      )}

      {session && !scorecard && current && (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="muted">
              第 {idx + 1} / {questions.length} 题
            </span>
            <div className="spacer" />
            <button className="btn ghost" onClick={reset}>
              退出练习
            </button>
          </div>

          <QuestionNav
            total={questions.length}
            current={idx}
            gradedById={gradedById}
            questionIds={questions.map((q) => q.id)}
            onJump={jump}
          />

          <QuestionCard key={current.id} question={current} graded={graded} onSubmit={onGrade} />
          {graded && <TutorPanel questionId={current.id} attemptId={graded.attemptId} />}

          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => jump(idx - 1)} disabled={idx === 0}>
              上一题
            </button>
            <span className="spacer" />
            {idx >= questions.length - 1 ? (
              <button className="btn" onClick={finish}>
                完成 · 看成绩单
              </button>
            ) : (
              <button className="btn" onClick={() => jump(idx + 1)}>
                下一题
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
