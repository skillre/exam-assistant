import type { TrendHistoryResponse, TrendPoint, TagTrendPoint } from '@exam/shared';
import { snapshotRepo } from '../repositories/snapshotRepo.js';

// 趋势追踪（Slice 4，FR4/DEC-34）：从 insight_snapshots 表查询历史快照，
// 构建整体正确率曲线 + 按标签趋势（双维时间序列）。

/**
 * 构建趋势数据。bankId 可选：限定某题库，否则全量聚合。
 * 快照为练习完成时落库（D5），时间序列 = 按 created_at 倒序的快照列表（展示时即时间序）。
 */
export function buildTrendHistory(bankId?: string): TrendHistoryResponse {
  // listAll 返回倒序（新→旧）；趋势曲线需要时间正序，翻转
  const snapshots = snapshotRepo.listAll(bankId).reverse();

  const overall: TrendPoint[] = snapshots.map((s) => ({
    ts: s.createdAt,
    accuracy: s.accuracy,
    total: s.total,
  }));

  const byTag: TagTrendPoint[] = [];
  for (const s of snapshots) {
    for (const entry of s.byTag) {
      if (entry.total === 0) continue;
      byTag.push({
        ts: s.createdAt,
        tag: entry.tag,
        accuracy: entry.total > 0 ? entry.correct / entry.total : 0,
        total: entry.total,
      });
    }
  }

  return { overall, byTag };
}
