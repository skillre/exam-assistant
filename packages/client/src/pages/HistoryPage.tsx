import { Fragment, useEffect, useState } from "react";
import type { PracticeHistoryItem, Scorecard } from "@exam/shared";
import { api, downloadCsv } from "../api/client.js";

// 第四批 ②：练习历史页（#/history）—— 会话列表 → 详情（成绩单）→ 重练/重开/继续。

interface Props {
	// 重练/重开：复用 App 的一键开练链路（setQuizScope + autoStart + navigate quiz）
	onDrillQuiz: (scope: PracticeHistoryItem["scope"], autoStart: boolean) => void;
	// 继续：写入 localStorage 续做键后跳刷题页（QuizPage 挂载时自动恢复）
	onResumeSession: (sessionId: string) => void;
}

const SCOPE_LABEL: Record<string, string> = {
	all: "全部题目",
	undone: "仅未做",
	wrong: "仅错过",
	byType: "按题型",
	byTag: "按知识点",
};

function fmtTime(ms: number): string {
	return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

export function HistoryPage({ onDrillQuiz, onResumeSession }: Props) {
	const [items, setItems] = useState<PracticeHistoryItem[] | null>(null);
	const [error, setError] = useState("");
	const [detail, setDetail] = useState<Scorecard | null>(null);
	const [detailId, setDetailId] = useState<string | null>(null);

	const load = () => {
		setError("");
		api.practiceHistory().then(setItems).catch((e) => setError((e as Error).message));
	};

	useEffect(() => {
		load();
	}, []);

	async function openDetail(id: string) {
		if (detailId === id) {
			setDetailId(null);
			setDetail(null);
			return;
		}
		setDetailId(id);
		try {
			setDetail(await api.getScorecard(id));
		} catch (e) {
			setError((e as Error).message);
		}
	}

	function redo(item: PracticeHistoryItem) {
		onDrillQuiz(item.scope, true);
	}

	function resume(item: PracticeHistoryItem) {
		onResumeSession(item.id);
	}

	function isStaticScope(item: PracticeHistoryItem): boolean {
		return item.scope.mode === "all" || item.scope.mode === "byType" || item.scope.mode === "byTag";
	}

	return (
		<div>
			<h1>练习历史</h1>
			{error && <div className="error">⚠ {error}</div>}
			{!items && !error && <p className="muted">加载中…</p>}
			{items && items.length === 0 && (
				<p className="muted">还没有练习记录，去「刷题」页开始第一次练习吧。</p>
			)}
			{items && items.length > 0 && (
				<table className="history-table">
					<thead>
						<tr>
							<th>时间</th>
							<th>题库</th>
							<th>范围</th>
							<th>题数</th>
							<th>正确率</th>
							<th>状态</th>
							<th>操作</th>
						</tr>
					</thead>
					<tbody>
						{items.map((it) => (
							<Fragment key={it.id}>
							<tr>
								<td>{fmtTime(it.createdAt)}</td>
								<td>{it.bankName}</td>
								<td>{SCOPE_LABEL[it.scope.mode] ?? it.scope.mode}</td>
								<td>{it.questionCount}</td>
								<td>
									{it.answered > 0
										? `${Math.round(it.accuracy * 100)}%（${it.correct}/${it.answered}）`
										: "—"}
								</td>
								<td>
									{it.completed ? (
										<span className="badge ok">已完成</span>
									) : (
										<span className="badge">未完成</span>
									)}
								</td>
								<td>
									{it.completed || isStaticScope(it) ? (
										<button className="btn" onClick={() => redo(it)}>
											{it.completed ? "重练" : "重开"}
										</button>
									) : (
										<button className="btn" onClick={() => resume(it)}>
											继续
										</button>
									)}
									<button className="btn" onClick={() => openDetail(it.id)}>
										{detailId === it.id ? "收起" : "详情"}
									</button>
								</td>
							</tr>
							{detailId === it.id && (
								<tr>
									<td colSpan={7}>
										{detail ? (
											<div className="card">
												<h3>成绩单</h3>
												<p>
													已答 {detail.answered}/{detail.total} 题，正确{" "}
													{detail.correct} 题
													（{detail.answered > 0
														? `${Math.round(detail.accuracy * 100)}%`
														: "—"}
													）
												</p>
												{detail.byType.length > 0 && (
													<p className="muted">
														按题型：{" "}
														{detail.byType
															.map(
																(t) =>
																	`${t.type} ${t.correct}/${t.total}`,
															)
															.join("、")}
													</p>
												)}
												{detail.byTag.length > 0 && (
													<p className="muted">
														按知识点：{" "}
														{detail.byTag
															.map(
																(t) =>
																	`${t.tag} ${t.correct}/${t.total}`,
															)
															.join("、")}
													</p>
												)}
											</div>
										) : (
											<p className="muted">加载中…</p>
										)}
									</td>
								</tr>
							)}
							</Fragment>
						))}
					</tbody>
				</table>
			)}
			{items && items.length > 0 && (
				<p className="muted">
					只显示最近 30 次练习。数据保存在本机部署的服务器上，与刷题/错题本联动。
				</p>
			)}
		</div>
	);
}

export async function exportWrongCsv(): Promise<void> {
	await downloadCsv("/api/export/wrong.csv", `exam-wrong-${new Date().toISOString().slice(0, 10)}.csv`);
}
