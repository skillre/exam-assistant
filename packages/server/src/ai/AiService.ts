import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type { ModelInfo } from '@exam/shared';
import { SESSIONS_DIR } from '../config/paths.js';
import { providerRepo } from '../repositories/providerRepo.js';
import { settingsRepo } from '../repositories/settingsRepo.js';
import { buildModelRuntime } from './modelRuntimeSetup.js';

/**
 * pi SDK 集成层（DEC-5/7/9/21）。屏蔽 ModelRuntime/SessionManager 细节，
 * 对上层只暴露：一次性会话、文件持久化答疑会话、流式推送、模型列举/切换。
 * Key 从不离开本服务，绝不返回给任何 handler。
 */
export class AiService {
  private runtime!: ModelRuntime;
  private cwd: string;

  private constructor(cwd: string) {
    this.cwd = cwd;
  }

  static async create(cwd: string = process.cwd()): Promise<AiService> {
    const svc = new AiService(cwd);
    await svc.reloadProviders();
    return svc;
  }

  /** DEC-21：provider 在 DB 变更后重建内存 runtime + 重注入 Key */
  async reloadProviders(): Promise<void> {
    this.runtime = await buildModelRuntime();
  }

  /** 取当前激活模型；未设置则回退到第一个已配置 provider 的第一个模型 */
  private resolveActiveModel() {
    const active = settingsRepo.getActiveModel();
    if (active) {
      const m = this.runtime.getModel(active.providerId, active.modelId);
      if (m) return m;
    }
    // 回退：第一个已配置 provider 的首个模型
    for (const p of providerRepo.list()) {
      const first = p.models[0];
      if (!p.configured || !first) continue;
      const m = this.runtime.getModel(p.id, first.id);
      if (m) return m;
    }
    return undefined;
  }

  private requireModel() {
    const model = this.resolveActiveModel();
    if (!model) {
      throw new Error('没有可用模型：请先在设置页配置 provider 与 API Key');
    }
    return model;
  }

  /** 一次性会话（DEC-11：导入解析用），用完 dispose，不落 JSONL */
  async runOnce(systemPrompt: string, userPrompt: string): Promise<string> {
    const model = this.requireModel();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      modelRuntime: this.runtime,
      model,
      noTools: 'all',
      sessionManager: SessionManager.inMemory(this.cwd),
    });
    try {
      let out = '';
      const unsub = session.subscribe((e) => {
        if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
          out += e.assistantMessageEvent.delta;
        }
      });
      await session.prompt(buildSingleTurn(systemPrompt, userPrompt));
      unsub();
      return out.trim();
    } finally {
      session.dispose();
    }
  }

  /** 文件持久化答疑会话（DEC-7），返回会话 + 其 JSONL 路径 */
  async createTutorSession(opts: { systemPrompt: string }): Promise<{
    session: AgentSession;
    jsonlPath: string;
  }> {
    const model = this.requireModel();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      modelRuntime: this.runtime,
      model,
      noTools: 'all',
      sessionManager: SessionManager.create(this.cwd, SESSIONS_DIR),
    });
    const jsonlPath = session.sessionFile;
    if (!jsonlPath) {
      session.dispose();
      throw new Error('会话未生成持久化文件（sessionFile 为空）');
    }
    // systemPrompt 作为首条上下文由调用方注入到第一条 prompt（见 tutorPrompts）
    void opts;
    return { session, jsonlPath };
  }

  /** 按已存 JSONL 路径恢复答疑会话（服务重启后追问用，DEC-7） */
  async openTutorSession(jsonlPath: string): Promise<AgentSession> {
    const model = this.requireModel();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      modelRuntime: this.runtime,
      model,
      noTools: 'all',
      sessionManager: SessionManager.open(jsonlPath),
    });
    return session;
  }

  /**
   * 发送一条 prompt 并把 text_delta 逐块回调（供 SSE）。
   * Phase 5/6 都经此方法，统一 send+subscribe，不各自裸调 subscribe。
   */
  async streamPrompt(
    session: AgentSession,
    prompt: string,
    onDelta: (chunk: string) => void,
  ): Promise<void> {
    const unsub = session.subscribe((e) => {
      if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
        onDelta(e.assistantMessageEvent.delta);
      }
    });
    try {
      await session.prompt(prompt);
    } finally {
      unsub();
    }
  }

  /** GET /api/models 用：列出所有已配置 provider 的模型 */
  listModels(): ModelInfo[] {
    const out: ModelInfo[] = [];
    for (const p of providerRepo.list()) {
      if (!p.configured) continue;
      for (const m of p.models) {
        out.push({ providerId: p.id, modelId: m.id, name: `${p.name} / ${m.name}` });
      }
    }
    return out;
  }

  /** POST /api/settings/model 用：切换当前激活模型 */
  setModel(providerId: string, modelId: string): void {
    const model = this.runtime.getModel(providerId, modelId);
    if (!model) {
      throw new Error(`未找到模型 ${providerId}/${modelId}（provider 是否已配置？）`);
    }
    settingsRepo.setActiveModel({ providerId, modelId });
  }
}

/** 一次性调用把 system + user 合成单条 prompt（inMemory 会话无独立 system 通道时的简化） */
function buildSingleTurn(systemPrompt: string, userPrompt: string): string {
  return `${systemPrompt}\n\n---\n\n${userPrompt}`;
}
