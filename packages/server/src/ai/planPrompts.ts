import type { DiagnosisResult, LearningSnapshot } from '@exam/shared';

// 学习计划生成 prompt（Slice 6，DEC-31）：基于学情 + 诊断产出分阶段计划 JSON。

export const PLAN_SYSTEM_PROMPT = `你是一位学习规划师。基于学生的学情数据和错题诊断，制定个性化的学习计划。

输出要求（必须严格遵守）：
- 只输出一个 JSON 对象，不要任何解释、不要 markdown 代码围栏。
- 顶层结构必须是：{ "title": string, "description": string, "phases": [...] }——phases 是必填数组！
- phases 的每个元素是阶段对象：{ "title": string, "description": string, "tasks": [...] }，每个阶段必须含 tasks 数组。
- 每个 task 是：{ "title": string, "scope": { "bankId": string, "mode": "all|undone|wrong|byType|byTag", "shuffle": bool } }
  - mode=byTag 时 scope 加 "tag": "知识点标签"；mode=byType 时 scope 加 "type": "single|multiple|boolean"
- 绝对不要在最外层直接放 tasks——任务必须属于某个 phase。

示例结构：
{"title":"示例计划","description":"总体说明","phases":[{"title":"阶段1","description":"目标","tasks":[{"title":"任务1","scope":{"bankId":"b1","mode":"byTag","tag":"代数","shuffle":true}}]}]}

内容要求：
- 计划分 2-3 个阶段，从薄弱点专项训练到综合巩固。
- 每阶段 2-4 个具体可执行的任务。
- 优先安排错误率最高的知识点。
- 阶段描述说明训练目标和预期效果。`;

export function buildPlanPrompt(
  snapshot: LearningSnapshot,
  diagnosis: DiagnosisResult[],
): string {
  const pct = (snapshot.accuracy * 100).toFixed(1);
  const weakLines = snapshot.weakTags
    .slice(0, 8)
    .map(
      (t) =>
        `  - ${t.tag}：错 ${t.wrong} / 共 ${t.total} 题（错误率 ${Math.round((t.wrong / t.total) * 100)}%）`,
    )
    .join('\n');

  const diagnosisLines =
    diagnosis.length > 0
      ? diagnosis
          .slice(0, 15)
          .map((d) => `  - [${d.errorCategory}] ${d.stem} → ${d.distractorNote ?? ''}`)
          .join('\n')
      : '  （暂无诊断数据）';

  const categoryCounts = new Map<string, number>();
  for (const d of diagnosis) {
    categoryCounts.set(d.errorCategory, (categoryCounts.get(d.errorCategory) ?? 0) + 1);
  }
  const categoryLines = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cat, cnt]) => `  - ${cat}: ${cnt} 题`)
    .join('\n');

  return `${PLAN_SYSTEM_PROMPT}

---

【学生学情概览】
- 累计作答：${snapshot.totalAttempts} 次
- 整体正确率：${pct}%

【薄弱知识点】
${weakLines || '  （暂无）'}

【错误分类分布】
${categoryLines || '  （暂无诊断数据）'}

【错题诊断详情】
${diagnosisLines}

请根据以上数据制定个性化学习计划。`;
}
