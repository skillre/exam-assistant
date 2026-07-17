import { useEffect, useState } from 'react';
import type { Bank, Question, GradeResponse } from '@exam/shared';
import { api } from '../api/client.js';
import { QuestionCard } from '../components/QuestionCard.js';
import { TutorPanel } from '../components/TutorPanel.js';

// 刷题页：选题库 → 逐题作答判分 → 每题可展开 AI 讲解/答疑。
export function QuizPage() {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankId, setBankId] = useState('');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [idx, setIdx] = useState(0);
  const [graded, setGraded] = useState<GradeResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listBanks().then(setBanks).catch((e) => setError((e as Error).message));
  }, []);

  async function loadBank(id: string) {
    setBankId(id);
    setError('');
    setGraded(null);
    setIdx(0);
    try {
      setQuestions(await api.listQuestions(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const current = questions[idx];

  async function onGrade(answer: Question['answer']) {
    if (!current) return;
    try {
      const r = await api.grade({ questionId: current.id, userAnswer: answer });
      setGraded(r);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function next() {
    setGraded(null);
    setIdx((i) => Math.min(i + 1, questions.length - 1));
  }
  function prev() {
    setGraded(null);
    setIdx((i) => Math.max(i - 1, 0));
  }

  return (
    <div>
      <h1>刷题</h1>
      {error && <div className="error">⚠ {error}</div>}

      <div className="card">
        <label>选择题库</label>
        <select value={bankId} onChange={(e) => loadBank(e.target.value)}>
          <option value="">— 请选择 —</option>
          {banks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        {banks.length === 0 && <p className="muted">还没有题库，先去「导入」页添加题目。</p>}
      </div>

      {current && (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="muted">
              第 {idx + 1} / {questions.length} 题
            </span>
          </div>
          <QuestionCard
            key={current.id}
            question={current}
            graded={graded}
            onSubmit={onGrade}
          />
          {graded && (
            <TutorPanel questionId={current.id} attemptId={graded.attemptId} />
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={prev} disabled={idx === 0}>
              上一题
            </button>
            <span className="spacer" />
            <button className="btn" onClick={next} disabled={idx >= questions.length - 1}>
              下一题
            </button>
          </div>
        </>
      )}
    </div>
  );
}
