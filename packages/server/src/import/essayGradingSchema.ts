import { z } from "zod";

// 第五批：主观题 AI 评分输出的 zod 校验（参照 diagnosisSchema 模式）。
// AI 输出不可信：isCorrect 必须 boolean、feedback 必须非空字符串，多余键忽略。

export const essayGradingSchema = z.object({
	isCorrect: z.boolean(),
	feedback: z.string().min(1, "feedback 不能为空"),
});
