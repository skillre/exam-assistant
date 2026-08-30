/**
 * t6 集成终审静态检查脚本（reviewer 预置，t6 执行时运行）。
 *
 * 用途：对照 .codebase-review/16-ai-reliability-idempotency-design.md §4/§5
 * 与 t1/t3 交付范围，对 packages/dsh-exam 源码做只读一致性断言。
 * 纯静态检查：不编译、不运行服务、不改任何文件。
 *
 * 运行：node specs/verification/scripts/check-t6-integration.mjs
 * 退出码：0 = 全部通过；1 = 存在 FAIL（供 CI/终审门禁使用）。
 * 注意：本脚本在 t1/t3/t5 完成前运行会大面积 FAIL，属预期；t6 收口时运行。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const p = (rel) => join(root, 'packages/dsh-exam/src', rel);
const read = (rel) => {
  const f = p(rel);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
};

const results = [];
const check = (id, area, ok, detail) => results.push({ id, area, ok: !!ok, detail });

const store = read('host/store.ts') ?? '';
const contract = read('host/contract.ts') ?? '';
const errors = read('host/errors.ts') ?? '';
const index = read('host/index.ts') ?? '';
const service = read('host/service.ts') ?? '';
const ai = read('host/ai.ts') ?? '';
const tools = read('host/tools.ts') ?? '';
const api = read('client/api.ts') ?? '';
const sse = read('client/sse.ts') ?? '';
const aiTools = read('client/AiTools.tsx') ?? '';
const insights = read('client/Insights.tsx') ?? '';
const wrongView = read('client/WrongView.tsx') ?? '';
const overlay = read('client/ExamOverlay.tsx') ?? '';
const workspace = read('client/ExamWorkspace.tsx') ?? '';
const styles = read('client/styles.css') ?? '';
const storeTest = read('host/store.test.ts') ?? '';
const serviceTest = existsSync(p('host/service-ai-reliability.test.ts')) ? read('host/service-ai-reliability.test.ts') : null;

// ── A. 迁移（设计 §4；版本号容忍 t1/t5 叠加） ──────────────────────────────
const migCount = (store.match(/MIGRATIONS/g) ?? []).length;
const v6Tables = ['tutor_turns', 'import_batches', 'import_drafts'];
check('A1', '迁移', /user_version\s*=\s*6|schemaVersion\s*=\s*6|MIGRATIONS\.length\s*[>=]/.test(store) || store.includes('v6'), `MIGRATIONS 存在（计数线索 ${migCount}）；t6 需核对最终版本号`);
check('A2', '迁移', v6Tables.every((t) => store.includes(`CREATE TABLE IF NOT EXISTS ${t}`)), `v6 三表齐备: ${v6Tables.map((t) => (store.includes(`CREATE TABLE IF NOT EXISTS ${t}`) ? t : `缺 ${t}`)).join(' / ')}`);
check('A3', '迁移', store.includes(`'pending','streaming','done','failed','cancelled'`), 'tutor_turns.state CHECK 五态');
check('A4', '迁移', store.includes('idx_tutor_turns_session') && store.includes('idx_tutor_messages_turn'), 'tutor turns/messages 索引');
check('A5', '迁移', store.includes('ALTER TABLE tutor_messages ADD COLUMN turn_id'), 'tutor_messages.turn_id 列');
check('A6', '迁移', store.includes('import_batch_id') && store.includes('import_item_key') && store.includes('idx_questions_import_key'), 'questions 批次幂等列 + 部分唯一索引');
check('A7', '迁移', store.includes('prompt_version') && store.includes('question_updated_at'), 'explanations 版本列');
check('A8', '迁移', store.includes('UPDATE explanations') && store.includes('question_updated_at'), '存量缓存 question_updated_at 回填');
check('A9', '迁移', store.includes('ALTER TABLE essay_gradings ADD COLUMN provider'), 'essay_gradings provider/tokens 列');
check('A10', '迁移', /foreign_key_check|PRAGMA foreign_key_check/.test(store), '迁移后 FK 校验机制存在');
check('A11', '迁移', storeTest.includes('v6') || storeTest.includes('user_version=6'), 'store.test 有 v6 迁移用例');

// ── B. 契约（设计 §5 contract.ts） ─────────────────────────────────────────
check('B1', '契约', contract.includes('clientMessageId?: string'), 'ChatTutorRequest.clientMessageId');
check('B2', '契约', contract.includes('turnId?') && contract.includes('replayed?'), 'ChatTutorResultDto.turnId/replayed');
check('B3', '契约', /sessionId\?.*turnId\?.*retryable\?|retryable\?: boolean/.test(contract), 'Tutor SSE error 元数据（sessionId/turnId/retryable）');
check('B4', '契约', contract.includes('draftId') && contract.includes('ImportGenerateResultDto'), 'ImportGenerateResultDto {questions, draftId}');
check('B5', '契约', contract.includes('batchId') && contract.includes('EXAM_IMPORT_DUPLICATE_ITEM') === false, 'CommitImportRequest.batchId/draftId（DUPLICATE_ITEM 属错误码另查）');
check('B6', '契约', contract.includes('promptVersion') && contract.includes('questionUpdatedAt'), 'ExplainResultDto/ExplanationDto 版本字段');
check('B7', '契约', contract.includes('provider?: string') && contract.includes('finishReason'), 'EssayGradingDto.provider / tokens 字段');

// ── C. 错误码与 HTTP 映射 ──────────────────────────────────────────────────
const newCodes = ['EXAM_TUTOR_SESSION_CLOSED', 'EXAM_TUTOR_TURN_IN_FLIGHT', 'EXAM_TUTOR_TURN_CONFLICT',
  'EXAM_IMPORT_DRAFT_NOT_FOUND', 'EXAM_IMPORT_DRAFT_CONSUMED', 'EXAM_IMPORT_BATCH_CONFLICT', 'EXAM_IMPORT_DUPLICATE_ITEM'];
const missingContract = newCodes.filter((c) => !contract.includes(c));
const missingErrors = newCodes.filter((c) => !errors.includes(c));
check('C1', '错误码', missingContract.length === 0, missingContract.length ? `contract.ts 缺: ${missingContract.join(',')}` : 'contract.ts 7 新码齐备');
check('C2', '错误码', missingErrors.length === 0, missingErrors.length ? `errors.ts 缺: ${missingErrors.join(',')}` : 'errors.ts 7 新码齐备');
const four09 = newCodes.filter((c) => c.includes('TUTOR') || c.includes('CONSUMED') || c.includes('CONFLICT'));
check('C3', '错误码', four09.every((c) => index.includes(c)), 'mapServiceError 409 分支（TUTOR_*/CONSUMED/CONFLICT）');
check('C4', '错误码', index.includes('EXAM_IMPORT_DRAFT_NOT_FOUND') || index.includes("404"), 'DRAFT_NOT_FOUND → 404 映射');

// ── D. 路由（设计 §5 index.ts） ────────────────────────────────────────────
check('D1', '路由', index.includes('tutor/sessions') && index.includes('/close'), 'POST /tutor/sessions/:id/close');
check('D2', '路由', /sessions\/.*DELETE|method === 'DELETE'/.test(index), 'DELETE /tutor/sessions/:id');
check('D3', '路由', index.includes('import/drafts'), 'GET /import/drafts/:id（含 discard 或恢复路由）');
check('D4', '路由', index.includes('defaultRouteProvider') || index.includes('defaultRoute?'), 'registerExamRoutes 默认模型动态解析（defaultRouteProvider）');
check('D5', '路由', index.includes('AbortController'), '路由层 AbortController（JSON 端点断开中止）');

// ── E. t1 领域正确性 ───────────────────────────────────────────────────────
check('E1', 't1', store.includes('getLatestAttemptByPracticeQuestion'), 'store 按 practice+question 定向查询');
check('E2', 't1', /getLatestAttemptByPracticeQuestion/.test(service) || /latestByPractice/.test(service), 'service resume/scorecard/history 使用定向查询');
check('E3', 't1', /finished/.test(service) && /EXAM_PRACTICE_/.test(service), 'finished 会话禁止判分/改索引（t6 需核对具体码）');
check('E4', 't1', /gradeEssay[\s\S]{0,600}?EXAM_QUESTION_NOT_IN_PRACTICE|question.*practice/.test(service), 'gradeEssay 校验题目属于 practice');
check('E5', 't1', service.includes('withTransaction') || store.includes('withTransaction'), '多写路径事务能力（withTransaction）');
check('E6', 't1', /EXAM_EMPTY_PRACTICE_SCOPE|EMPTY_SCOPE|empty scope|空范围/.test(service + contract), '空范围建会话 → 稳定领域错误（t1 落地为 EXAM_EMPTY_PRACTICE_SCOPE）');

// ── F. t3 客户端加固与无障碍静态面 ─────────────────────────────────────────
check('F1', 't3', wrongView.includes('AbortController'), 'WrongView 独立 AbortController');
check('F2', 't3', /busy|Busy|disabled=\{.*(generating|busy)/.test(insights), 'Insights 计划操作 busy 防护');
check('F3', 't3', /aria-selected/.test(workspace + aiTools), 'tab aria-selected');
check('F4', 't3', /role="tab"|role='tab'/.test(aiTools) && /role="tabpanel"|role='tabpanel'/.test(aiTools), 'aria tab/tabpanel 角色');
check('F5', 't3', /aria-controls/.test(insights + workspace), '展开项 aria-controls');
check('F6', 't3', /Tab|tabIndex|keydown/.test(overlay), 'Overlay focus trap / 键盘导航');
check('F7', 't3', /min-(height|width):\s*44px/.test(styles), '44px 触达目标（移动端）');
check('F8', 't3', /prefers-reduced-motion/.test(styles), 'prefers-reduced-motion 保留');
check('F9', 't3', /@media \(max-width: 860px\)/.test(styles), '移动端响应式媒体查询保留');

// ── G. 客户端 ↔ Host 契约联动（t5 客户端接线） ────────────────────────────
check('G1', '契约联动', api.includes('clientMessageId'), 'api.chatTutor 带 clientMessageId');
check('G2', '契约联动', /fetchImportDraft|import\/drafts/.test(api), 'api 草稿恢复接口');
check('G3', '契约联动', api.includes('batchId') || api.includes('draftId'), 'api.commitImport 批次/草稿幂等参数');
check('G4', '契约联动', /closeTutorSession|sessions\/.*\/close/.test(api), 'api.closeTutorSession');
check('G5', '契约联动', /retryable|meta/.test(sse), 'sse onError 元数据解析');

// ── H. 测试面（t5 新增套件） ───────────────────────────────────────────────
check('H1', '测试', serviceTest !== null, 'service-ai-reliability.test.ts 存在（设计 §7 新套件）');
check('H2', '测试', /trimTutorHistory/.test(ai), 'ai.ts trimTutorHistory 纯函数');
check('H3', '测试', /EXPLAIN_PROMPT_VERSION/.test(ai), 'ai.ts EXPLAIN_PROMPT_VERSION 常量');
check('H4', '测试', /computeTutorInputBudget/.test(ai), 'ai.ts computeTutorInputBudget');
check('H5', '测试', /single.?flight|inFlight|IN_FLIGHT/.test(service + index), 'explain single-flight / turn in-flight 判定');
check('H6', '测试', /sweepGhostSessions|sweepImportDrafts/.test(store), '幽灵会话/草稿 TTL 清扫');

// ── 输出 ───────────────────────────────────────────────────────────────────
const byArea = {};
for (const r of results) (byArea[r.area] ??= []).push(r);
const areas = ['迁移', '契约', '错误码', '路由', 't1', 't3', '契约联动', '测试'];
let fail = 0, pass = 0;
for (const area of areas) {
  const list = byArea[area] ?? [];
  console.log(`\n[${area}]`);
  for (const r of list) {
    if (r.ok) pass++;
    else fail++;
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.id} ${r.detail}`);
  }
}
console.log(`\n==== t6 静态检查：${pass} 通过 / ${fail} 失败（基线时点后 t1/t3/t5 未落地前预期大量 FAIL） ====`);
process.exit(fail > 0 ? 1 : 0);
