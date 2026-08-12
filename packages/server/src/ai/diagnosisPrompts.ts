import type { DiagnosisContext } from "../insights/diagnosisCollector.js";

// 错误诊断 prompt（Slice 5，DEC-33）：把错题详情喂给模型，产出结构化错误分类（固定枚举）。

export const DIAGNOSIS_SYSTEM_PROMPT = `你是一位学习诊断专家。分析学生的错题记录，对每道错题进行错误归因分类。

错误分类固定为以下四种之一：
- concept_confusion：概念混淆（对知识点理解有误，选了相似但错误的选项）
- calculation_error：计算/推理失误（理解正确但过程出错）
- misread：审题失误（看错题意、漏看条件、误解选项）
- knowledge_gap：知识盲区（完全没有相关知识储备）

要求：
- 只输出 JSON 数组，不要任何解释、不要 markdown 代码围栏。
- 每个元素字段：questionId、stem（题干前 60 字）、userAnswer（学生选了什么）、
  correctAnswer（正确答案）、errorCategory（上述四种之一）、distractorNote（一句话分析干扰项）。
- 题干过长时截取前 60 字即可。
- 答案用选项文本表示（如"A. xxx"），不要用下标数字。`;

/** 构建诊断输入文本 */
export function buildDiagnosisPrompt(ctx: DiagnosisContext): string {
	const attemptLines = ctx.wrongAttempts.map((a) => {
		const optionsText = a.options
			.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`)
			.join(" | ");
		const correctText = formatAnswer(a.correctAnswer, a.options);
		const userText = formatAnswer(a.userAnswer, a.options);
		return [
			`【题ID】${a.questionId}`,
			`【题干】${a.stem}`,
			`【选项】${optionsText}`,
			`【正确答案】${correctText}`,
			`【学生作答】${userText}`,
			`【标签】${a.tags.length > 0 ? a.tags.join(", ") : "无"}`,
		].join("\n");
	});

	const distractorLines = ctx.distractorStats
		.slice(0, 10)
		.map((d) => `  - ${d.stem}… → 错选"${d.option}"（${d.selectedCount}次）`);

	const highlightLines =
		ctx.tutorHighlights.length > 0
			? ctx.tutorHighlights.map((h) => `  - ${h}`).join("\n")
			: "  （暂无答疑记录）";

	return `${DIAGNOSIS_SYSTEM_PROMPT}

---

【错题记录】（共 ${ctx.wrongAttempts.length} 道）
${attemptLines.join("\n\n")}

【干扰项统计】
${distractorLines.length > 0 ? distractorLines.join("\n") : "  （暂无统计数据）"}

【学生答疑关注点】
${highlightLines}

请对每道错题进行错误归因分析。`;
}

function formatAnswer(value: unknown, options: string[]): string {
	if (typeof value === "boolean") return value ? "正确" : "错误";
	if (typeof value === "number") {
		const letter = String.fromCharCode(65 + value);
		return `${letter}. ${options[value] ?? "(越界)"}`;
	}
	if (Array.isArray(value)) {
		return value
			.map(
				(i) =>
					`${String.fromCharCode(65 + (i as number))}. ${options[i as number] ?? "(越界)"}`,
			)
			.join("+");
	}
	return String(value);
}
