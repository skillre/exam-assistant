// FILE: packages/client/src/components/TrendChart.tsx
import { useMemo } from 'react';
import type { TrendHistoryResponse } from '@exam/shared';

interface Props {
  data: TrendHistoryResponse;
}

// 纯 SVG 趋势图（Slice 4）。整体正确率折线 + 按标签趋势。
// 模式 InsightsPanel.tsx 的 Ring/bar-row 纯 CSS/SVG 风格（DEC-26：不引图表库）。

const COLORS = ['#4f8ef7', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

export function TrendChart({ data }: Props) {
  const { overall, byTag } = data;

  // 按标签分组
  const tagGroups = useMemo(() => {
    const map = new Map<string, { ts: number; accuracy: number; total: number }[]>();
    for (const pt of byTag) {
      const arr = map.get(pt.tag) ?? [];
      arr.push({ ts: pt.ts, accuracy: pt.accuracy, total: pt.total });
      map.set(pt.tag, arr);
    }
    // 按最新正确率降序，取前 6 条标签
    return [...map.entries()]
      .map(([tag, points]) => ({ tag, points }))
      .sort((a, b) => {
        const aLast = a.points[a.points.length - 1]?.accuracy ?? 0;
        const bLast = b.points[b.points.length - 1]?.accuracy ?? 0;
        return bLast - aLast;
      })
      .slice(0, 6);
  }, [byTag]);

  if (overall.length === 0) {
    return <p className="muted">暂无趋势数据。完成更多练习后可查看趋势。</p>;
  }

  return (
    <div className="card">
      <h3 style={{ fontSize: 15, margin: '0 0 12px' }}>正确率趋势</h3>

      {/* 整体正确率折线图 */}
      <OverallLineChart points={overall} />

      {/* 按标签趋势条形 */}
      {tagGroups.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>按知识点趋势</h3>
          {tagGroups.map((g, i) => (
            <TagTrendRow key={g.tag} tag={g.tag} points={g.points} color={COLORS[i % COLORS.length]!} />
          ))}
        </>
      )}
    </div>
  );
}

// ── 整体正确率折线图（SVG） ──

function OverallLineChart({ points }: { points: { ts: number; accuracy: number; total: number }[] }) {
  const W = 320;
  const H = 140;
  const PAD = { top: 10, right: 10, bottom: 24, left: 36 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  if (points.length < 2) {
    // 单点：显示圆点而非折线
    const pt = points[0]!;
    const cx = PAD.left + plotW / 2;
    const cy = PAD.top + (1 - pt.accuracy) * plotH;
    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        <AxisLabels pad={PAD} plotH={plotH} />
        <circle cx={cx} cy={cy} r={4} fill="var(--accent)" />
        <text x={cx} y={cy - 8} textAnchor="middle" fill="var(--text)" fontSize={11}>
          {Math.round(pt.accuracy * 100)}%
        </text>
      </svg>
    );
  }

  // X/Y 缩放
  const tsMin = points[0]!.ts;
  const tsMax = points[points.length - 1]!.ts;
  const tsRange = Math.max(tsMax - tsMin, 1);
  const xOf = (ts: number) => PAD.left + ((ts - tsMin) / tsRange) * plotW;
  const yOf = (acc: number) => PAD.top + (1 - acc) * plotH;

  // 折线路径
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.ts).toFixed(1)},${yOf(p.accuracy).toFixed(1)}`).join(' ');

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      <AxisLabels pad={PAD} plotH={plotH} />
      {/* 网格线 */}
      {[0, 0.25, 0.5, 0.75, 1].map((v) => (
        <line
          key={v}
          x1={PAD.left}
          y1={yOf(v)}
          x2={W - PAD.right}
          y2={yOf(v)}
          stroke="var(--border)"
          strokeWidth={0.5}
        />
      ))}
      {/* 折线 */}
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
      {/* 数据点 */}
      {points.map((p, i) => (
        <circle key={i} cx={xOf(p.ts)} cy={yOf(p.accuracy)} r={3} fill="var(--accent)" />
      ))}
    </svg>
  );
}

function AxisLabels({ pad, plotH }: { pad: { top: number; left: number; bottom: number; right: number }; plotH: number }) {
  return (
    <>
      {[0, 0.5, 1].map((v) => (
        <text
          key={v}
          x={pad.left - 4}
          y={pad.top + (1 - v) * plotH + 4}
          textAnchor="end"
          fill="var(--muted)"
          fontSize={10}
        >
          {Math.round(v * 100)}%
        </text>
      ))}
    </>
  );
}

// ── 按标签趋势行（迷你条形 + 最新正确率） ──

function TagTrendRow({ tag, points, color }: {
  tag: string;
  points: { ts: number; accuracy: number; total: number }[];
  color: string;
}) {
  const latest = points[points.length - 1]!;
  const pct = Math.round(latest.accuracy * 100);
  // 趋势方向：与前一个点比较
  const prev = points.length >= 2 ? points[points.length - 2]! : null;
  const delta = prev ? Math.round((latest.accuracy - prev.accuracy) * 100) : 0;
  const deltaLabel = delta > 0 ? `↑${delta}` : delta < 0 ? `↓${Math.abs(delta)}` : '';

  return (
    <div className="bar-row">
      <div className="bar-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
        {tag}
      </div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="bar-val muted">
        {pct}%
        {deltaLabel && (
          <span style={{ marginLeft: 4, color: delta > 0 ? 'var(--ok)' : delta < 0 ? 'var(--err)' : 'var(--muted)', fontSize: 11 }}>
            {deltaLabel}
          </span>
        )}
        <span style={{ marginLeft: 4, fontSize: 11 }}>({latest.total}题)</span>
      </div>
    </div>
  );
}
