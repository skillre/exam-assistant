import { QUESTION_TYPE_LABEL } from '@exam/shared';
import type { Scorecard as ScorecardData } from '@exam/shared';

interface Props {
  data: ScorecardData;
  onReviewWrong: () => void;
  onRestart: () => void;
}


// v2 FR1.5：成绩单。纯 CSS 条形，不引图表库（DEC-26）。
export function Scorecard({ data, onReviewWrong, onRestart }: Props) {
  const pct = Math.round(data.accuracy * 100);
  return (
    <div className="card">
      <h2>练习成绩单</h2>
      <div className="row" style={{ gap: 24, marginBottom: 16 }}>
        <div className="score-big">
          <div className="score-num">{pct}%</div>
          <div className="muted">正确率</div>
        </div>
        <div>
          <div>共 {data.total} 题，已答 {data.answered} 题</div>
          <div className="ok">答对 {data.correct} 题</div>
          <div className="error">答错 {data.wrongQuestionIds.length} 题</div>
        </div>
      </div>

      {data.byType.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, margin: '12px 0 8px' }}>按题型</h3>
          {data.byType.map((t) => (
            <BarRow
              key={t.type}
              label={QUESTION_TYPE_LABEL[t.type]}
              correct={t.correct}
              total={t.total}
            />
          ))}
        </>
      )}

      {data.byTag.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, margin: '12px 0 8px' }}>按知识点</h3>
          {data.byTag.map((t) => (
            <BarRow key={t.tag} label={t.tag} correct={t.correct} total={t.total} />
          ))}
        </>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        {data.wrongQuestionIds.length > 0 && (
          <button className="btn ghost" onClick={onReviewWrong}>
            查看错题（{data.wrongQuestionIds.length}）
          </button>
        )}
        <button className="btn" onClick={onRestart}>
          再练一套
        </button>
      </div>
    </div>
  );
}

function BarRow({ label, correct, total }: { label: string; correct: number; total: number }) {
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
  return (
    <div className="bar-row">
      <div className="bar-label">{label}</div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="bar-val muted">
        {correct}/{total}
      </div>
    </div>
  );
}
