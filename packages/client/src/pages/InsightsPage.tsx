import { useEffect, useState } from 'react';
import type { Bank, LearningSnapshot } from '@exam/shared';
import { api } from '../api/client.js';
import { streamSse } from '../api/sse.js';
import { Markdown } from '../components/Markdown.js';
import { InsightsPanel } from '../components/InsightsPanel.js';
import type { DrillFilter } from '../App.js';

interface Props {
  onDrillToQuiz?: (filter: DrillFilter) => void;
  onDrillToWrong?: (filter: DrillFilter) => void;
}

// 学情分析 v2：进页即拉结构化快照（REST），面板先出；AI 文本报告按需生成（SSE）。
export function InsightsPage({ onDrillToQuiz }: Props = {}) {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankId, setBankId] = useState<string>('');
  const [snapshot, setSnapshot] = useState<LearningSnapshot | null>(null);
  const [report, setReport] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listBanks().then(setBanks).catch(() => {});
  }, []);

  // 范围变化即刷新结构化快照（FR3.3：REST 即时，无需点按钮）
  useEffect(() => {
    setError('');
    api
      .insightsSnapshot(bankId || undefined)
      .then(setSnapshot)
      .catch((e) => setError((e as Error).message));
  }, [bankId]);

  function analyze() {
    setReport('');
    setError('');
    setRunning(true);
    streamSse(
      '/api/insights/analyze',
      bankId ? { bankId } : {},
      {
        onDelta: (t) => setReport((r) => r + t),
        onDone: () => setRunning(false),
        onError: (m) => {
          setError(m);
          setRunning(false);
        },
      },
    );
  }

  const hasData = snapshot && snapshot.totalAttempts > 0;

  return (
    <div>
      <h1>学情分析</h1>
      <p className="muted">基于你的做题记录和答疑内容，归纳薄弱知识点与复习建议。</p>

      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <select className="input" value={bankId} onChange={(e) => setBankId(e.target.value)} style={{ flex: 1 }}>
          <option value="">全部题库</option>
          {banks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button className="btn" onClick={analyze} disabled={running || !hasData}>
          {running ? '生成中…' : '生成 AI 报告'}
        </button>
      </div>

      {error && <div className="error">⚠ {error}</div>}

      {hasData ? (
        <InsightsPanel
          snapshot={snapshot!}
          onDrillTag={(tag) => onDrillToQuiz?.({ bankId: bankId || undefined, tag })}
        />
      ) : (
        <p className="muted">暂无做题记录，先去刷几道题吧。</p>
      )}

      {report && (
        <div className="report" style={{ marginTop: 16 }}>
          <Markdown text={report} />
        </div>
      )}
    </div>
  );
}
