import { useMemo, useState } from "react";
import { QUESTION_TYPE_LABEL } from "@exam/shared";
import type { Question, AnswerValue, GradeResponse } from "@exam/shared";

interface Props {
	question: Question;
	graded?: GradeResponse | null;
	onSubmit: (answer: AnswerValue) => void;
	disabled?: boolean;
	// 第五批：AI 评分请求中（essay 提交后等待 LLM 判分，按钮禁用 + 文案提示）
	pending?: boolean;
}

// 渲染一道题：按题型收集作答；判分后高亮正确/错误。
export function QuestionCard({ question, graded, onSubmit, disabled, pending }: Props) {
	const [single, setSingle] = useState<number | null>(null);
	const [multi, setMulti] = useState<number[]>([]);
	const [bool, setBool] = useState<boolean | null>(null);
	const [essayText, setEssayText] = useState("");

	const isGraded = !!graded;

	const canSubmit = useMemo(() => {
		if (isGraded) return false;
		if (question.type === "single") return single !== null;
		if (question.type === "multiple") return multi.length > 0;
		if (question.type === "boolean") return bool !== null;
		return essayText.trim().length > 0;
	}, [isGraded, question.type, single, multi, bool, essayText]);

	function submit() {
		if (question.type === "single" && single !== null) onSubmit(single);
		else if (question.type === "multiple")
			onSubmit([...multi].sort((a, b) => a - b));
		else if (question.type === "boolean" && bool !== null) onSubmit(bool);
		else if (question.type === "essay" && essayText.trim()) onSubmit(essayText.trim());
	}

	function optionClass(idx: number): string {
		const base = "option";
		if (!isGraded) {
			const sel =
				(question.type === "single" && single === idx) ||
				(question.type === "multiple" && multi.includes(idx));
			return sel ? `${base} selected` : base;
		}
		// 判分后：正确答案标绿；用户错选标红
		const correct = graded!.correctAnswer;
		const isCorrectOpt =
			(typeof correct === "number" && correct === idx) ||
			(Array.isArray(correct) && correct.includes(idx));
		const userPicked =
			(question.type === "single" && single === idx) ||
			(question.type === "multiple" && multi.includes(idx));
		if (isCorrectOpt) return `${base} correct`;
		if (userPicked && !isCorrectOpt) return `${base} wrong`;
		return base;
	}

	// 第三批 体验②：键盘支持（单选/判断 role=radio+方向键自动选中，多选 role=checkbox+空格切换）
	function selectOption(idx: number) {
		if (isGraded || disabled) return;
		if (question.type === "single") setSingle(idx);
		else if (question.type === "multiple")
			setMulti((m) =>
				m.includes(idx) ? m.filter((x) => x !== idx) : [...m, idx],
			);
		else setBool(idx === 0); // boolean 分支 [true,false] 索引：0=true 1=false
	}

	function optionKeyDown(e: React.KeyboardEvent, idx: number, total: number) {
		if (e.key === " " || e.key === "Enter") {
			e.preventDefault();
			selectOption(idx);
		} else if (
			(e.key === "ArrowDown" || e.key === "ArrowRight") &&
			idx < total - 1
		) {
			e.preventDefault();
			focusOption(idx + 1);
			// 单选/判断：方向键移动即选中（radio 语义）
			if (question.type !== "multiple") selectOption(idx + 1);
		} else if ((e.key === "ArrowUp" || e.key === "ArrowLeft") && idx > 0) {
			e.preventDefault();
			focusOption(idx - 1);
			if (question.type !== "multiple") selectOption(idx - 1);
		}
	}

	function focusOption(idx: number) {
		const els = document.querySelectorAll(`[data-opt="${question.id}"]`);
		(els[idx] as HTMLElement | undefined)?.focus();
	}

	const optRole = question.type === "multiple" ? "checkbox" : "radio";

	return (
		<div className="card">
			<div className="row" style={{ marginBottom: 10 }}>
				<span className="badge">{QUESTION_TYPE_LABEL[question.type]}</span>
				{question.tags?.map((t) => (
					<span key={t} className="badge">
						{t}
					</span>
				))}
				{isGraded && (
					<span className={graded!.isCorrect ? "badge ok" : "badge bad"}>
						{graded!.isCorrect ? "✓ 正确" : "✗ 错误"}
					</span>
				)}
			</div>

			<div style={{ fontSize: 16, marginBottom: 14 }}>{question.stem}</div>

			{question.type === "boolean" ? (
				<>
					{[true, false].map((v, idx) => {
						const label = v ? "正确" : "错误";
						let cls = "option";
						if (!isGraded) cls = bool === v ? "option selected" : "option";
						else {
							const correct = graded!.correctAnswer === v;
							if (correct) cls = "option correct";
							else if (bool === v) cls = "option wrong";
						}
						return (
							<div
								key={label}
								className={cls}
								data-opt={question.id}
								role="radio"
								tabIndex={0}
								aria-checked={!isGraded && bool === v}
								onClick={() => !isGraded && !disabled && setBool(v)}
								onKeyDown={(e) => optionKeyDown(e, idx, 2)}
							>
								{label}
							</div>
						);
					})}
				</>
			) : (
				question.options.map((opt, idx) => (
					<div
						key={idx}
						className={optionClass(idx)}
						data-opt={question.id}
						role={optRole}
						tabIndex={0}
						aria-checked={
							question.type === "multiple"
								? multi.includes(idx)
								: !isGraded && single === idx
						}
						onClick={() => {
							if (isGraded || disabled) return;
							if (question.type === "single") setSingle(idx);
							else
								setMulti((m) =>
									m.includes(idx) ? m.filter((x) => x !== idx) : [...m, idx],
								);
						}}
						onKeyDown={(e) => optionKeyDown(e, idx, question.options.length)}
					>
						<span className="muted">{String.fromCharCode(65 + idx)}.</span>{" "}
						{opt}
					</div>
				))
			)}

			{question.type === "essay" && !isGraded && (
				<textarea
					className="essay-input"
					rows={4}
					placeholder="输入你的答案……"
					value={essayText}
					disabled={disabled}
					onChange={(e) => setEssayText(e.target.value)}
				/>
			)}

			{isGraded && graded?.feedback && (
				<div className="tutor">
					<strong>批改意见：</strong>
					{graded.feedback}
				</div>
			)}

			{isGraded && question.explanation && (
				<div className="tutor">
					<strong>解析：</strong>
					{question.explanation}
				</div>
			)}

			{!isGraded && (
				<div className="row" style={{ marginTop: 12 }}>
					<button
						className="btn"
						disabled={!canSubmit || disabled || pending}
						onClick={submit}
					>
						{pending ? "AI 批改中…" : "提交作答"}
					</button>
				</div>
			)}
		</div>
	);
}
