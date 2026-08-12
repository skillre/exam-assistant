// FILE: packages/client/src/pages/InsightsPage.tsx — MODIFIED (add trend section)
// ── Changes ──
// 1. Add trend state
// 2. Fetch trend data on bankId change
// 3. Add TrendChart between InsightsPanel and AI report

// ── New import ──
import type { TrendHistoryResponse } from '@exam/shared';
import { TrendChart } from '../components/TrendChart.js';

// ── New state (add inside InsightsPage) ──
  const [trend, setTrend] = useState<TrendHistoryResponse | null>(null);

// ── New effect: fetch trend on bankId change (add after snapshot effect) ──
  useEffect(() => {
    api
      .getTrendHistory(bankId || undefined)
      .then(setTrend)
      .catch(() => setTrend(null));
  }, [bankId]);

// ── JSX: insert TrendChart between InsightsPanel and AI report ──
// Replace the JSX section after InsightsPanel with:

      {hasData ? (
        <>
          <InsightsPanel
            snapshot={snapshot!}
            onDrillTag={(tag) => onDrillToQuiz?.({ bankId: bankId || undefined, tag })}
          />
          {trend && trend.overall.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <TrendChart data={trend} />
            </div>
          )}
        </>
      ) : (
        <p className="muted">暂无做题记录，先去刷几道题吧。</p>
      )}

      {report && (
        <div className="report" style={{ marginTop: 16 }}>
          <Markdown text={report} />
        </div>
      )}
