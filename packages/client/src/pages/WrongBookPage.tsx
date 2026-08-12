import { useCallback, useEffect, useState } from "react";
import type {
	Bank,
	Question,
	GradeResponse,
	WrongBookItem,
	QuestionType,
} from "@exam/shared";
import { api } from "../api/client.js";
import { QuestionCard } from "../components/QuestionCard.js";
import { TutorPanel } from "../components/TutorPanel.js";
import type { DrillFilter } from "../App.js";

interface Props {
	initialFilter?: DrillFilter | null;
}

// 错题本 v2：错误次数/最近错误时间 + 已掌握软标记 + 按题库/题型/标签筛选（FR2.1-2.4）。
export function WrongBookPage({ initialFilter }: Props = {}) {
	const [items, setItems] = useState<WrongBookItem[]>([]);
	const [banks, setBanks] = useState<Bank[]>([]);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [gradedById, setGradedById] = useState<Record<string, GradeResponse>>(
		{},
	);

	const [bankId, setBankId] = useState("");
	const [type, setType] = useState<QuestionType | "">("");
	const [tag, setTag] = useState("");
	const [includeMastered, setIncludeMastered] = useState(false);

	// 纯请求函数（参数显式传入，不依赖筛选 state——挂载时直接可用，避免双请求）
	const loadWrong = useCallback(
		(q: {
			bankId?: string;
			type?: QuestionType;
			tag?: string;
			includeMastered?: boolean;
		}) => {
			setLoading(true);
			setError("");
			api
				.listWrong({
					bankId: q.bankId,
					type: q.type,
					tag: q.tag,
					includeMastered: q.includeMastered ?? false,
				})
				.then(setItems)
				.catch((e) => setError((e as Error).message))
				.finally(() => setLoading(false));
		},
		[],
	);

	// 用户手动改筛选 → setState + 立即带新值加载（auditor 否决项：onChange 必须联动）
	const applyFilter = (
		patch: Partial<{
			bankId: string;
			type: QuestionType | "";
			tag: string;
			includeMastered: boolean;
		}>,
	) => {
		const next = { bankId, type, tag, includeMastered, ...patch };
		setBankId(next.bankId);
		setType(next.type);
		setTag(next.tag);
		setIncludeMastered(next.includeMastered);
		loadWrong({
			bankId: next.bankId || undefined,
			type: next.type || undefined,
			tag: next.tag || undefined,
			includeMastered: next.includeMastered,
		});
	};

	// 手动刷新 / 掌握标记后重载（用当前 state）
	const reload = useCallback(() => {
		loadWrong({
			bankId: bankId || undefined,
			type: type || undefined,
			tag: tag || undefined,
			includeMastered,
		});
	}, [bankId, type, tag, includeMastered, loadWrong]);

	useEffect(() => {
		api
			.listBanks()
			.then(setBanks)
			.catch(() => {});
	}, []);

	// 挂载：应用下钻筛选 + 只发 1 个 listWrong（闭环⑤：双请求合并）。
	// 仅依赖 initialFilter（includeMastered 变化走 applyFilter，避免双请求）。
	useEffect(() => {
		if (initialFilter?.bankId) setBankId(initialFilter.bankId);
		if (initialFilter?.tag) setTag(initialFilter.tag);
		if (initialFilter?.type) setType(initialFilter.type);
		loadWrong({
			bankId: initialFilter?.bankId || undefined,
			type: initialFilter?.type || undefined,
			tag: initialFilter?.tag || undefined,
			includeMastered: false,
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initialFilter]);

	async function onGrade(q: Question, answer: Question["answer"]) {
		try {
			const r = await api.grade({ questionId: q.id, userAnswer: answer });
			setGradedById((m) => ({ ...m, [q.id]: r }));
		} catch (e) {
			setError((e as Error).message);
		}
	}

	async function toggleMastered(questionId: string, mastered: boolean) {
		try {
			await api.setMastered(questionId, mastered);
			reload();
		} catch (e) {
			setError((e as Error).message);
		}
	}

	const fmtTime = (ms: number) =>
		new Date(ms).toLocaleString("zh-CN", { hour12: false });

	return (
		<div>
			<div className="row">
				<h1>错题本</h1>
				<span className="spacer" />
				<button className="btn ghost" onClick={reload}>
					刷新
				</button>
			</div>

			<div className="card">
				<div className="row">
		  <select
			  value={bankId}
			  onChange={(e) => applyFilter({ bankId: e.target.value })}
		  >
			<option value="">全部题库</option>
			{banks.map((b) => (
			  <option key={b.id} value={b.id}>
				{b.name}
			  </option>
			))}
		  </select>
		  <select
			  value={type}
			  onChange={(e) =>
				applyFilter({ type: e.target.value as QuestionType | "" })
			  }
		  >
			<option value="">全部题型</option>
			<option value="single">单选</option>
			<option value="multiple">多选</option>
			<option value="boolean">判断</option>
		  </select>
		  <input
			placeholder="按知识点标签筛选"
			value={tag}
			onChange={(e) => applyFilter({ tag: e.target.value })}
			style={{ flex: 1, minWidth: 140 }}
		  />
		  <label className="row" style={{ cursor: "pointer" }}>
			<input
			  type="checkbox"
			  checked={includeMastered}
			  onChange={(e) => applyFilter({ includeMastered: e.target.checked })}
			  style={{ width: "auto" }}
			/>
			<span className="muted">显示已掌握</span>
		  </label>
				</div>
			</div>

			{error && <div className="error">⚠ {error}</div>}
			{loading && <p className="muted">加载中…</p>}
			{!loading && items.length === 0 && (
				<p className="muted">没有符合条件的错题。</p>
			)}

			{items.map(({ question: q, wrongCount, lastWrongAt, mastered }) => {
				const g = gradedById[q.id];
				return (
					<div key={q.id} style={{ marginBottom: 20 }}>
						<div className="row" style={{ marginBottom: 6 }}>
							<span className="badge bad">错 {wrongCount} 次</span>
							<span className="muted" style={{ fontSize: 13 }}>
								最近错误：{fmtTime(lastWrongAt)}
							</span>
							{mastered && <span className="badge ok">已掌握</span>}
							<div className="spacer" />
							<button
								className={mastered ? "btn ghost" : "btn"}
								onClick={() => toggleMastered(q.id, !mastered)}
							>
								{mastered ? "取消掌握" : "标记已掌握"}
							</button>
						</div>
						<QuestionCard
							question={q}
							graded={g ?? null}
							onSubmit={(a) => onGrade(q, a)}
						/>
						{g && (
							<>
								{/* 闭环②：错题本回读该题答疑历史（含此前轮次），可直接继续追问 */}
								<TutorPanel
									questionId={q.id}
									attemptId={g.attemptId}
									autoLoadHistory
								/>
								{g.isCorrect && !mastered && (
									<div className="tutor ok">
										答对了！可以
										<button
											className="btn"
											style={{ marginLeft: 8 }}
											onClick={() => toggleMastered(q.id, true)}
										>
											标记已掌握
										</button>
									</div>
								)}
							</>
						)}
					</div>
				);
			})}
		</div>
	);
}
