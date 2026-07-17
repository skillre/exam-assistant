import type { AnswerValue, Question } from '@exam/shared';

// 讲题老师角色 + 首条上下文拼装（OQ3）。
// createTutorSession 不单独走 system 通道，所以把角色设定 + 题目上下文
// 一起拼进该题答疑会话的首条 prompt。后续追问用同一会话，历史自动累积。

export const TUTOR_SYSTEM_PROMPT = `你是一位耐心、专业的讲题老师。学生刚做完一道客观题，你要针对这道题讲解。
要求：
- 先点明正确答案，再解释为什么对；若学生答错，具体说明错在哪、为什么错。
- 讲清背后的知识点，用简洁清楚的中文。
- 不要跑题，只围绕这道题及其相关知识。
- 如果学生继续追问，请结合这道题的上下文继续解答。`;

// 首条 prompt 内嵌同一角色设定（createTutorSession 不单独走 system 通道）
const TUTOR_ROLE = TUTOR_SYSTEM_PROMPT;

/** 把答案值渲染成人类可读文本（结合选项） */
function renderAnswer(question: Question, value: AnswerValue): string {
  if (question.type === 'boolean') {
    return value === true ? '正确' : '错误';
  }
  if (question.type === 'single' && typeof value === 'number') {
    return `${value}. ${question.options[value] ?? '(越界)'}`;
  }
  if (question.type === 'multiple' && Array.isArray(value)) {
    return value.map((i) => `${i}. ${question.options[i] ?? '(越界)'}`).join('；');
  }
  return String(value);
}

/** 首条 prompt：角色设定 + 题目 + 学生作答 + 判分结果（OQ3 上下文注入） */
export function buildExplainPrompt(
  question: Question,
  userAnswer: AnswerValue,
  isCorrect: boolean,
): string {
  const optionsText = question.options.map((o, i) => `  ${i}. ${o}`).join('\n');
  return `${TUTOR_ROLE}

---

【题目】${question.stem}
【题型】${question.type === 'single' ? '单选' : question.type === 'multiple' ? '多选' : '判断'}
【选项】
${optionsText}
【正确答案】${renderAnswer(question, question.answer)}
【学生作答】${renderAnswer(question, userAnswer)}
【判分结果】${isCorrect ? '答对' : '答错'}
${question.explanation ? `【原有解析】${question.explanation}` : ''}

请针对这道题给出讲解。`;
}
