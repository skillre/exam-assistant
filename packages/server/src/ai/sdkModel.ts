// 把我们简单的 { id, name } provider 模型描述扩展为 pi SDK registerProvider
// 所需的完整模型描述。对 OpenAI 兼容 provider 用通用默认值：
// 纯文本输入、非 reasoning、成本填 0（本地不做计费）、给一个宽松的上下文/输出上限。
// 这些字段只影响 SDK 的展示/预算逻辑，不改变实际请求正确性。

export interface SdkModelDescriptor {
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export function toSdkModel(id: string, name: string): SdkModelDescriptor {
  return {
    id,
    name,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}
