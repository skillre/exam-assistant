import { masteryRepo } from '../repositories/masteryRepo.js';
import { wrongBookRepo } from '../repositories/wrongBookRepo.js';

// 掌握度闭环服务（Slice 2，DEC-32）：判分后自动追踪连续答对次数。
// 达标阈值 = 连续答对 3 次（D8，硬编码常量，不做环境变量覆盖——评审 C4）→ 标记 mastered → 联动错题本。

const MASTERY_THRESHOLD = 3;

/**
 * 判分后调用：更新掌握度状态。
 * - 正确：递增连续计数，达标则标记 mastered + 同步错题本软标记。
 * - 错误：重置连续计数（仅重置 streak，不取消错题本"已掌握"标记——掌握后偶尔错一次
 *   不应立即取消，由用户手动管理）。
 * 返回 true 表示本题刚达标（前端可展示鼓励提示）。
 */
export function checkMasteryAfterGrade(questionId: string, isCorrect: boolean): boolean {
  if (isCorrect) {
    const consecutive = masteryRepo.incrementCorrect(questionId);
    if (consecutive >= MASTERY_THRESHOLD) {
      // 同步两处掌握状态：mastery_states.mastered（真相源）+ 错题本软标记（联动）
      masteryRepo.setMastered(questionId, true);
      wrongBookRepo.setMastered(questionId, true);
      return true;
    }
    return false;
  }
  masteryRepo.reset(questionId);
  return false;
}
