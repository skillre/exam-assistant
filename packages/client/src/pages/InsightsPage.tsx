import { useEffect, useState } from 'react';
import type { Bank } from '@exam/shared';
import { api } from '../api/client.js';
import { streamSse } from '../api/sse.js';

// 学情分析：可选题库范围，SSE 流式生成分析报告。
export function InsightsPage() {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankId, setBankId] = useState<string>('');
  const [report, setReport] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listBanks().then(setBanks).catch(() => {});
  }, []);

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

  return (
    <div>
      <h1>学情分析</h1>
      <p className="muted">基于你的做题记录和答疑内容，AI 归纳薄弱知识点与复习建议。</p>

      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <select className="input" value={bankId} onChange={(e) => setBankId(e.target.value)}>
          <option value="">全部题库</option>
          {banks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button className="btn" onClick={analyze} disabled={running}>
          {running ? '分析中…' : '开始分析'}
        </button>
      </div>

      {error && <div className="error">⚠ {error}</div>}
      {report && <div className="report">{report}</div>}
      {!report && !running && !error && (
        <p className="muted">选择范围后点“开始分析”。</p>
      )}
    </div>
  );
}
