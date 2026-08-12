import type { LearningSnapshot } from '@exam/shared';

interface Props {
  snapshot: LearningSnapshot;
  onDrillTag?: (tag: string) => void;
  // v3 闭环①：学情→错题本下钻入口
  onDrillWrong?: () => void;
}

// v2 FR3.1/3.3：结构化学情面板。纯 CSS/SVG，不引图表库（DEC-26）。
// 正确率环 + 薄弱知识点条形 + 答疑要点。薄弱点可点击下钻（FR3.4）。
export function InsightsPanel({ snapshot, onDrillTag, onDrillWrong }: Props) {
  const pct = Math.round(snapshot.accuracy * 100);
  // 薄弱点按错误率降序取前 8
  const weak = [...snapshot.weakTags]
    .filter((t) => t.total > 0)
    .sort((a, b) => b.wrong / b.total - a.wrong / a.total)
    .slice(0, 8);

  return (
    <div className="card">
      <div className="row" style={{ gap: 28, alignItems: 'center', marginBottom: 8 }}>
        <Ring pct={pct} />
        <div>
          <div style={{ fontSize: 15 }}>累计作答 {snapshot.totalAttempts} 次</div>
          <div className="muted">整体正确率 {pct}%</div>
        </div>
      </div>

      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>薄弱知识点</h3>
      {weak.length === 0 ? (
        <p className="muted">暂无足够数据。多做几道题后再来看。</p>
      ) : (
        weak.map((t) => {
          const errPct = Math.round((t.wrong / t.total) * 100);
          return (
            <div
              key={t.tag}
              className={`bar-row${onDrillTag ? ' clickable' : ''}`}
              onClick={() => onDrillTag?.(t.tag)}
              title={onDrillTag ? '点击按该知识点练习' : undefined}
            >
              <div className="bar-label">{t.tag}</div>
              <div className="bar-track">
                <div className="bar-fill bad" style={{ width: `${errPct}%` }} />
              </div>
              <div className="bar-val muted">
                错 {t.wrong}/{t.total}
              </div>
            </div>
          );
        })
      )}

      {snapshot.tutorHighlights.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>答疑要点</h3>
          <ul className="md" style={{ paddingLeft: 20 }}>
            {snapshot.tutorHighlights.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </>
      )}

      {onDrillWrong && (
        <button
          className="btn ghost"
          style={{ marginTop: 12 }}
          onClick={onDrillWrong}
        >
          查看错题本
        </button>
      )}
    </div>
  );
}

// 纯 SVG 正确率环
function Ring({ pct }: { pct: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <svg width="84" height="84" viewBox="0 0 84 84">
      <circle cx="42" cy="42" r={r} fill="none" stroke="var(--border)" strokeWidth="8" />
      <circle
        cx="42"
        cy="42"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="8"
        strokeDasharray={`${dash} ${c - dash}`}
        strokeLinecap="round"
        transform="rotate(-90 42 42)"
      />
      <text x="42" y="47" textAnchor="middle" fill="var(--text)" fontSize="18" fontWeight="700">
        {pct}%
      </text>
    </svg>
  );
}
