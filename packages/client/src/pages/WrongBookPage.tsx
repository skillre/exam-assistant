import { useEffect, useState } from 'react';
import type { Question, GradeResponse } from '@exam/shared';
import { api } from '../api/client.js';
import { QuestionCard } from '../components/QuestionCard.js';
import { TutorPanel } from '../components/TutorPanel.js';

// 错题本：做错过的题（去重到题粒度），可重做 + 看讲解。
export function WrongBookPage() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [error, setError] = useState('');
  const [gradedById, setGradedById] = useState<Record<string, GradeResponse>>({});

  function reload() {
    setError('');
    api.listWrong().then(setQuestions).catch((e) => setError((e as Error).message));
  }
  useEffect(reload, []);

  async function onGrade(q: Question, answer: Question['answer']) {
    try {
      const r = await api.grade({ questionId: q.id, userAnswer: answer });
      setGradedById((m) => ({ ...m, [q.id]: r }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="row">
        <h1>错题本</h1>
        <span className="spacer" />
        <button className="btn ghost" onClick={reload}>
          刷新
        </button>
      </div>
      {error && <div className="error">⚠ {error}</div>}
      {questions.length === 0 && <p className="muted">还没有错题。去刷几道题吧。</p>}

      {questions.map((q) => (
        <div key={q.id} style={{ marginBottom: 20 }}>
          <QuestionCard
            question={q}
            graded={gradedById[q.id] ?? null}
            onSubmit={(a) => onGrade(q, a)}
          />
          {gradedById[q.id] && (
            <TutorPanel questionId={q.id} attemptId={gradedById[q.id]!.attemptId} />
          )}
        </div>
      ))}
    </div>
  );
}
