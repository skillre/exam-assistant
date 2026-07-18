import type { GradeResponse } from '@exam/shared';

interface Props {
  total: number;
  current: number;
  // questionId → 该题的判分结果（已答过的题）
  gradedById: Record<string, GradeResponse | undefined>;
  questionIds: string[];
  onJump: (idx: number) => void;
}

// v2 FR1.4：题号导航。已答对=绿、已答错=红、未答=灰，当前题高亮。
export function QuestionNav({ total, current, gradedById, questionIds, onJump }: Props) {
  return (
    <div className="qnav">
      {Array.from({ length: total }, (_, i) => {
        const qid = questionIds[i];
        const g = qid ? gradedById[qid] : undefined;
        let cls = 'qnav-cell';
        if (i === current) cls += ' current';
        if (g) cls += g.isCorrect ? ' correct' : ' wrong';
        return (
          <button key={i} className={cls} onClick={() => onJump(i)} title={`第 ${i + 1} 题`}>
            {i + 1}
          </button>
        );
      })}
    </div>
  );
}
