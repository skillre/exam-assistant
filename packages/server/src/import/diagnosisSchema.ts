import { z } from "zod";

// 错因归类 zod schema（Slice 5，DEC-33）：固定枚举 + 跨字段校验。

const ERROR_CATEGORIES = [
	"concept_confusion",
	"calculation_error",
	"misread",
	"knowledge_gap",
] as const;

export const diagnosisItemSchema = z.object({
	questionId: z.string().min(1, "questionId 不能为空"),
	stem: z.string().min(1, "题干不能为空"),
	userAnswer: z.string().min(1, "学生作答不能为空"),
	correctAnswer: z.string().min(1, "正确答案不能为空"),
	errorCategory: z.enum(ERROR_CATEGORIES, {
		errorMap: () => ({
			message: `errorCategory 必须是 ${ERROR_CATEGORIES.join("/")} 之一`,
		}),
	}),
	distractorNote: z.string().default(""),
});

export const diagnosisArraySchema = z.array(diagnosisItemSchema);

/** 校验 AI 诊断输出；失败抛出可读错误 */
export function validateDiagnosisResults(
	raw: unknown,
): z.infer<typeof diagnosisArraySchema> {
	return diagnosisArraySchema.parse(raw);
}
