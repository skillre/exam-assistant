import { useMemo, useState } from 'react';
import { QUESTION_TYPE_LABEL } from '@exam/shared';
import type { Question, AnswerValue, GradeResponse } from '@exam/shared';

interface Props {
  question: Question;
  graded?: GradeResponse | null;
  onSubmit: (answer: AnswerValue) => void;
  disabled?: boolean;
}

// 渲染一道题：按题型收集作答；判分后高亮正确/错误。
export function QuestionCard({ question, graded, onSubmit, disabled }: Props) {
  const [single, setSingle] = useState<number | null>(null);
  const [multi, setMulti] = useState<number[]>([]);
  const [bool, setBool] = useState<boolean | null>(null);

  const isGraded = !!graded;

  const canSubmit = useMemo(() => {
    if (isGraded) return false;
    if (question.type === 'single') return single !== null;
    if (question.type === 'multiple') return multi.length > 0;
    return bool !== null;
  }, [isGraded, question.type, single, multi, bool]);

  function submit() {
    if (question.type === 'single' && single !== null) onSubmit(single);
    else if (question.type === 'multiple') onSubmit([...multi].sort((a, b) => a - b));
    else if (question.type === 'boolean' && bool !== null) onSubmit(bool);
  }

  function optionClass(idx: number): string {
    const base = 'option';
    if (!isGraded) {
      const sel =
        (question.type === 'single' && single === idx) ||
        (question.type === 'multiple' && multi.includes(idx));
      return sel ? `${base} selected` : base;
    }
    // 判分后：正确答案标绿；用户错选标红
    const correct = graded!.correctAnswer;
    const isCorrectOpt =
      (typeof correct === 'number' && correct === idx) ||
      (Array.isArray(correct) && correct.includes(idx));
    const userPicked =
      (question.type === 'single' && single === idx) ||
      (question.type === 'multiple' && multi.includes(idx));
    if (isCorrectOpt) return `${base} correct`;
    if (userPicked && !isCorrectOpt) return `${base} wrong`;
    return base;
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="badge">
          {QUESTION_TYPE_LABEL[question.type]}
        </span>
        {question.tags?.map((t) => (
          <span key={t} className="badge">
            {t}
          </span>
        ))}
        {isGraded && (
          <span className={graded!.isCorrect ? 'badge ok' : 'badge bad'}>
            {graded!.isCorrect ? '✓ 正确' : '✗ 错误'}
          </span>
        )}
      </div>

      <div style={{ fontSize: 16, marginBottom: 14 }}>{question.stem}</div>

      {question.type === 'boolean' ? (
        <>
          {[true, false].map((v) => {
            const label = v ? '正确' : '错误';
            let cls = 'option';
            if (!isGraded) cls = bool === v ? 'option selected' : 'option';
            else {
              const correct = graded!.correctAnswer === v;
              if (correct) cls = 'option correct';
              else if (bool === v) cls = 'option wrong';
            }
            return (
              <div
                key={label}
                className={cls}
                onClick={() => !isGraded && !disabled && setBool(v)}
              >
                {label}
              </div>
            );
          })}
        </>
      ) : (
        question.options.map((opt, idx) => (
          <div
            key={idx}
            className={optionClass(idx)}
            onClick={() => {
              if (isGraded || disabled) return;
              if (question.type === 'single') setSingle(idx);
              else
                setMulti((m) =>
                  m.includes(idx) ? m.filter((x) => x !== idx) : [...m, idx],
                );
            }}
          >
            <span className="muted">{String.fromCharCode(65 + idx)}.</span> {opt}
          </div>
        ))
      )}

      {isGraded && question.explanation && (
        <div className="tutor">
          <strong>解析：</strong>
          {question.explanation}
        </div>
      )}

      {!isGraded && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" disabled={!canSubmit || disabled} onClick={submit}>
            提交作答
          </button>
        </div>
      )}
    </div>
  );
}
