import { useEffect, useState } from 'react';
import type {
  Bank,
  DiagnosisResult,
  LearningPlan,
  LearningSnapshot,
  PracticeScope,
  TrendHistoryResponse,
} from '@exam/shared';
import { api } from '../api/client.js';
import { streamSse } from '../api/sse.js';
import { Markdown } from '../components/Markdown.js';
import { InsightsPanel } from '../components/InsightsPanel.js';
import { TrendChart } from '../components/TrendChart.js';
import { DiagnosisPanel } from '../components/DiagnosisPanel.js';
import { PlanPanel } from '../components/PlanPanel.js';
import type { DrillFilter } from '../App.js';

interface Props {
  onDrillToQuiz?: (filter: DrillFilter) => void;
  onDrillToWrong?: (filter: DrillFilter) => void;
  onStartTask?: (scope: PracticeScope) => void;
}

// 学情分析 v3：结构化快照 + 趋势 + 错因诊断 + 学习计划。
// 面板数据全走 REST 即时（FR5.1，不耗模型）；AI 深度产出按需触发（SSE + 落库缓存，DEC-35）。
export function InsightsPage({ onDrillToQuiz, onDrillToWrong, onStartTask }: Props = {}) {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankId, setBankId] = useState<string>('');
  const [snapshot, setSnapshot] = useState<LearningSnapshot | null>(null);
  const [trend, setTrend] = useState<TrendHistoryResponse | null>(null);
  const [report, setReport] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  // Slice 5: 诊断状态
  const [diagnosisResults, setDiagnosisResults] = useState<DiagnosisResult[]>([]);
  const [diagnosisRunning, setDiagnosisRunning] = useState(false);

  // Slice 6: 计划状态
  const [plans, setPlans] = useState<LearningPlan[]>([]);
  const [planRunning, setPlanRunning] = useState(false);

  useEffect(() => {
    api
      .listBanks()
      .then(setBanks)
      .catch(() => {});
  }, []);

  // 范围变化即刷新：结构化快照 + 趋势 + 诊断缓存 + 计划列表（全部 REST 即时）
  useEffect(() => {
    setError('');
    api
      .insightsSnapshot(bankId || undefined)
      .then(setSnapshot)
      .catch((e) => setError((e as Error).message));
    api
      .getTrendHistory(bankId || undefined)
      .then(setTrend)
      .catch(() => setTrend(null));
    api
      .getDiagnosisLatest(bankId || undefined)
      .then((d) => setDiagnosisResults(d.results))
      .catch(() => setDiagnosisResults([]));
    api
      .listPlans()
      .then(setPlans)
      .catch(() => setPlans([]));
  }, [bankId]);

  async function analyze() {
    setReport('');
    setError('');
    setRunning(true);
    try {
      await streamSse('/api/insights/analyze', bankId ? { bankId } : {}, {
        onDelta: (t) => setReport((r) => r + t),
        onDone: () => setRunning(false),
        onError: (m) => {
          setError(m);
          setRunning(false);
        },
      });
    } catch (e) {
      setError((e as Error)?.message ?? '学情分析失败');
    } finally {
      // P0-1 保留：兜底复位，按钮不永久卡"生成中…"
      setRunning(false);
    }
  }

  // Slice 5: 生成诊断报告（SSE → 结构化落库 → 刷新缓存展示）
  async function runDiagnosis() {
    setError('');
    setDiagnosisRunning(true);
    setDiagnosisResults([]);
    try {
      await streamSse('/api/coach/diagnosis', bankId ? { bankId } : {}, {
        onDelta: () => {}, // 诊断是结构化产出：最终结果从缓存接口读，不展示原始 JSON
        onDone: () => {
          api
            .getDiagnosisLatest(bankId || undefined)
            .then((d) => setDiagnosisResults(d.results))
            .catch(() => {});
        },
        onError: (m) => {
          setError(m);
        },
      });
    } catch (e) {
      setError((e as Error)?.message ?? '诊断生成失败');
    } finally {
      setDiagnosisRunning(false);
    }
  }

  // Slice 6: 生成学习计划（SSE → 落两表 → 刷新计划列表）
  async function runPlan() {
    setError('');
    setPlanRunning(true);
    try {
      await streamSse('/api/coach/plan', bankId ? { bankId } : {}, {
        onDelta: () => {}, // 结构化产出：结果从计划列表读
        onDone: () => {
          api
            .listPlans()
            .then(setPlans)
            .catch(() => {});
        },
        onError: (m) => {
          setError(m);
        },
      });
    } catch (e) {
      setError((e as Error)?.message ?? '计划生成失败');
    } finally {
      setPlanRunning(false);
    }
  }

  const hasData = snapshot && snapshot.totalAttempts > 0;

  return (
    <div>
      <h1>学情分析</h1>
      <p className="muted">基于你的做题记录和答疑内容，归纳薄弱知识点、诊断错因、生成学习计划。</p>

      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <select
          className="input"
          value={bankId}
          onChange={(e) => setBankId(e.target.value)}
          style={{ flex: 1 }}
        >
          <option value="">全部题库</option>
          {banks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button className="btn" onClick={analyze} disabled={running || !hasData}>
          {running ? '生成中…' : 'AI 报告'}
        </button>
        <button className="btn" onClick={runDiagnosis} disabled={diagnosisRunning || !hasData}>
          {diagnosisRunning ? '诊断中…' : '错因诊断'}
        </button>
        <button className="btn" onClick={runPlan} disabled={planRunning || !hasData}>
          {planRunning ? '生成中…' : '学习计划'}
        </button>
      </div>

      {error && <div className="error">⚠ {error}</div>}

      {hasData ? (
        <>
          <InsightsPanel
            snapshot={snapshot!}
            onDrillTag={(tag) => onDrillToQuiz?.({ bankId: bankId || undefined, tag })}
            onDrillWrong={() => onDrillToWrong?.({ bankId: bankId || undefined })}
          />

          {trend && trend.overall.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <TrendChart data={trend} />
            </div>
          )}

          {/* Slice 5: 诊断面板 */}
          <div style={{ marginTop: 16 }}>
            <DiagnosisPanel results={diagnosisResults} />
          </div>

          {/* Slice 6: 学习计划面板 */}
          <div style={{ marginTop: 16 }}>
            <PlanPanel
              plans={plans}
              onStartTask={onStartTask}
              onRefresh={() => api.listPlans().then(setPlans)}
            />
          </div>
        </>
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
