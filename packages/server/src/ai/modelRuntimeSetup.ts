import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { providerRepo } from '../repositories/providerRepo.js';

// DEC-21（实现优化）：不写 models.json 文件、也不用 setRuntimeApiKey。
// 直接从 SQLite 读 provider（解密 Key）→ ModelRuntime.registerProvider 全量注册到内存。
// Key 明文只存活于内存，落盘的只有 SQLite 里的 AES-GCM 密文。

/**
 * 从 DB provider 构建一个内存态 ModelRuntime。
 * 每次 provider 变更后重建（AiService.reloadProviders 调用）。
 */
export async function buildModelRuntime(): Promise<ModelRuntime> {
  // modelsPath: null → 不读任何 models.json 文件（provider 全部运行时注册）
  const runtime = await ModelRuntime.create({ modelsPath: null });

  for (const p of providerRepo.listWithKeys()) {
    if (!p.apiKey) continue; // 未配 Key 的 provider 跳过，不注册
    runtime.registerProvider(p.id, {
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey, // 仅内存
      api: p.api as never, // 'openai-completions' 等，运行时由用户配置
      models: p.models.map((m) => ({ id: m.id, name: m.name })),
    });
  }

  return runtime;
}
