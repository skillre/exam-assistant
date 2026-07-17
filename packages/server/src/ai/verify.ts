/**
 * Phase 2 SDK 集成验证脚本（在运行环境经 SSH 执行）。
 *
 * 用法（运行环境）：
 *   1. 先经前端或直接 SQL 配置一个可用的 provider + Key，或设置下方环境变量临时注册：
 *        VERIFY_PROVIDER_ID / VERIFY_BASE_URL / VERIFY_API / VERIFY_MODEL_ID / VERIFY_API_KEY
 *   2. pnpm --filter @exam/server build && node packages/server/dist/ai/verify.js
 *
 * 验证点（对应 Phase 2 Success Criteria）：
 *   - runOnce() 返回非空模型文本
 *   - createTutorSession() 在 SESSIONS_DIR 生成 .jsonl
 *   - streamPrompt 回调被多次触发（流式）
 */
import { existsSync } from 'node:fs';
import { ModelRuntime, SessionManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { SESSIONS_DIR } from '../config/paths.js';

async function main() {
  const providerId = process.env.VERIFY_PROVIDER_ID ?? 'verify-provider';
  const baseUrl = process.env.VERIFY_BASE_URL;
  const api = process.env.VERIFY_API ?? 'openai-completions';
  const modelId = process.env.VERIFY_MODEL_ID;
  const apiKey = process.env.VERIFY_API_KEY;

  if (!baseUrl || !modelId || !apiKey) {
    console.error(
      '缺少环境变量：VERIFY_BASE_URL / VERIFY_MODEL_ID / VERIFY_API_KEY 必填（VERIFY_API 默认 openai-completions）',
    );
    process.exit(1);
  }

  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider(providerId, {
    name: 'Verify Provider',
    baseUrl,
    apiKey,
    api: api as never,
    models: [{ id: modelId, name: modelId }],
  });

  const model = runtime.getModel(providerId, modelId);
  if (!model) throw new Error(`registerProvider 后仍取不到模型 ${providerId}/${modelId}`);
  console.log('✅ registerProvider + getModel 成功');

  const cwd = process.cwd();

  // 1) runOnce 风格：一次性 inMemory 会话
  {
    const { session } = await createAgentSession({
      cwd,
      modelRuntime: runtime,
      model,
      noTools: 'all',
      sessionManager: SessionManager.inMemory(cwd),
    });
    let out = '';
    const unsub = session.subscribe((e) => {
      if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
        out += e.assistantMessageEvent.delta;
      }
    });
    await session.prompt('用一句话回答：1+1 等于几？');
    unsub();
    session.dispose();
    if (!out.trim()) throw new Error('runOnce 返回空文本');
    console.log('✅ runOnce 返回非空文本:', JSON.stringify(out.trim().slice(0, 80)));
  }

  // 2) createTutorSession 风格：文件持久化会话 + 流式回调计数
  {
    const { session } = await createAgentSession({
      cwd,
      modelRuntime: runtime,
      model,
      noTools: 'all',
      sessionManager: SessionManager.create(cwd, SESSIONS_DIR),
    });
    const jsonlPath = session.sessionFile;
    if (!jsonlPath) throw new Error('文件会话 sessionFile 为空');

    let deltaCount = 0;
    const unsub = session.subscribe((e) => {
      if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
        deltaCount += 1;
      }
    });
    await session.prompt('请分三点简要说明为什么天空是蓝色的。');
    unsub();
    session.dispose();

    if (!existsSync(jsonlPath)) throw new Error(`JSONL 未生成: ${jsonlPath}`);
    console.log('✅ createTutorSession 生成 JSONL:', jsonlPath);
    if (deltaCount <= 1) throw new Error(`streamPrompt 未见多次 delta（count=${deltaCount}）`);
    console.log(`✅ 流式 text_delta 回调触发 ${deltaCount} 次`);
  }

  console.log('\n🎉 Phase 2 SDK 集成验证全部通过');
}

main().catch((err) => {
  console.error('❌ 验证失败:', err);
  process.exit(1);
});
