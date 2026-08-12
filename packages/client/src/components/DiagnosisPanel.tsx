// FILE: packages/client/src/components/DiagnosisPanel.tsx
import type { DiagnosisResult, ErrorCategory } from "@exam/shared";

interface Props {
	results: DiagnosisResult[];
}

// 错误诊断面板（Slice 5）：错误分布条形图 + 按分类/标签明细。
// 模式 InsightsPanel.tsx 的 bar-row 纯 CSS/SVG 风格。

const CATEGORY_LABEL: Record<ErrorCategory, string> = {
	concept_confusion: "概念混淆",
	calculation_error: "计算失误",
	misread: "审题失误",
	knowledge_gap: "知识盲区",
};

const CATEGORY_COLOR: Record<ErrorCategory, string> = {
	concept_confusion: "#ef4444",
	calculation_error: "#f59e0b",
	misread: "#8b5cf6",
	knowledge_gap: "#6b7280",
};

export function DiagnosisPanel({ results }: Props) {
	if (results.length === 0) {
		return (
			<div className="card">
				<h3 style={{ fontSize: 15, margin: "0 0 8px" }}>错因诊断</h3>
				<p className="muted">暂无诊断数据。点击"生成诊断报告"开始分析。</p>
			</div>
		);
	}

	// 按错误分类统计
	const categoryMap = new Map<ErrorCategory, number>();
	for (const r of results) {
		categoryMap.set(
			r.errorCategory,
			(categoryMap.get(r.errorCategory) ?? 0) + 1,
		);
	}
	const categories = [...categoryMap.entries()].sort((a, b) => b[1] - a[1]);

	// 按错误分类分组明细
	const grouped = new Map<ErrorCategory, DiagnosisResult[]>();
	for (const r of results) {
		const arr = grouped.get(r.errorCategory) ?? [];
		arr.push(r);
		grouped.set(r.errorCategory, arr);
	}

	return (
		<div className="card">
			<h3 style={{ fontSize: 15, margin: "0 0 8px" }}>错因诊断</h3>
			<p className="muted" style={{ marginBottom: 12 }}>
				共分析 {results.length} 道错题，按错误类型分布如下：
			</p>

			{/* 错误分类分布条形图 */}
			{categories.map(([cat, count]) => {
				const pct = Math.round((count / results.length) * 100);
				return (
					<div key={cat} className="bar-row">
						<div className="bar-label">{CATEGORY_LABEL[cat]}</div>
						<div className="bar-track">
							<div
								className="bar-fill"
								style={{ width: `${pct}%`, background: CATEGORY_COLOR[cat] }}
							/>
						</div>
						<div className="bar-val muted">
							{count}题 ({pct}%)
						</div>
					</div>
				);
			})}

			{/* 按分类明细 */}
			{categories.map(([cat]) => {
				const items = grouped.get(cat) ?? [];
				return (
					<div key={cat} style={{ marginTop: 16 }}>
						<h4
							style={{
								fontSize: 13,
								margin: "0 0 6px",
								color: CATEGORY_COLOR[cat],
							}}
						>
							{CATEGORY_LABEL[cat]} ({items.length}题)
						</h4>
						<ul style={{ paddingLeft: 20, margin: 0 }}>
							{items.map((r) => (
								<li key={r.questionId} style={{ marginBottom: 4 }}>
									<span style={{ fontSize: 13 }}>{r.stem}</span>
									<span
										className="muted"
										style={{ fontSize: 12, marginLeft: 6 }}
									>
										选了"{r.userAnswer}" → 应选"{r.correctAnswer}"
									</span>
									{r.distractorNote && (
										<div
											className="muted"
											style={{ fontSize: 12, marginLeft: 4 }}
										>
											{r.distractorNote}
										</div>
									)}
								</li>
							))}
						</ul>
					</div>
				);
			})}
		</div>
	);
}
