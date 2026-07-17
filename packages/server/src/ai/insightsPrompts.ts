import type { LearningSnapshot } from '@exam/shared';

// 学情分析 prompt：把 LearningDataCollector 汇集的快照喂给模型，产出错因归纳 + 学习建议。

export const INSIGHTS_SYSTEM_PROMPT = `你是一位学习数据分析师兼学习教练。
基于学生的做题数据和答疑记录，给出简洁、可操作的学情分析。要求：
- 先概述整体表现（做题量、正确率）。
- 指出最薄弱的 2-4 个知识点，说明依据（错题分布）。
- 若有答疑关注点，结合它们分析学生卡在哪类问题上。
- 给出 3 条以内的具体复习建议。
- 用简洁清楚的中文，不要空泛套话。`;

/** 把学情快照渲染成喂给模型的输入文本 */
export function buildInsightsPrompt(snapshot: LearningSnapshot): string {
  const pct = (snapshot.accuracy * 100).toFixed(1);
  const weakLines =
    snapshot.weakTags.length > 0
      ? snapshot.weakTags
          .map((t) => `  - ${t.tag}：错 ${t.wrong} / 共 ${t.total} 题`)
          .join('\n')
      : '  （暂无错题标签数据）';
  const highlightLines =
    snapshot.tutorHighlights.length > 0
      ? snapshot.tutorHighlights.map((h) => `  - ${h}`).join('\n')
      : '  （暂无答疑记录）';

  return `${INSIGHTS_SYSTEM_PROMPT}

---

【做题总量】${snapshot.totalAttempts}
【正确率】${pct}%
【按知识点的错题分布】
${weakLines}
【答疑关注点（学生追问过的问题）】
${highlightLines}

请给出这位学生的学情分析与复习建议。`;
}
