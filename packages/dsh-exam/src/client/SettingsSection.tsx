/**
 * settings.section 入口 —— 考试助手设置/状态页。
 *
 * Slot 契约（dsh-client-ui-settings/lib/types/client/contract/slots.d.ts）：
 * - 'settings.section': { kind: 'list'; scope: 'root'; owner: { close: () => void } }
 * - 注册选项：id/order/label；owner 提供 close()（关闭设置面板，状态归 shell）。
 *
 * Phase 3 s5：承接自 ExamWorkspace 迁出的健康卡 —— Host 状态（ok/异常 pill、
 * 数据目录、store schema、题库数量、LLM 接线、启动时间）+ 手动刷新；
 * 业务 UI 仍在 shell.overlay 全屏面板（「打开考试助手面板」入口）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { getHealth } from './api.ts';
import type { ExamErrorDto, ExamHealthDto } from './types.ts';
import { formatTime } from './ui-helpers.ts';
import { toggleExamOverlay } from './overlay-store.ts';

/** 本入口的完整 props 组合（owner { close } + 全局标准座位）。 */
export type ExamSettingsSectionProps = PropsRuntime<'settings.section'>;

type HealthState =
  | { phase: 'loading' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'ready'; health: ExamHealthDto };

export function ExamSettingsSection({ close }: ExamSettingsSectionProps) {
  const [health, setHealth] = useState<HealthState>({ phase: 'loading' });
  const abortRef = useRef<AbortController | null>(null);

  const loadHealth = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setHealth({ phase: 'loading' });
    try {
      const h = await getHealth(controller.signal);
      setHealth({ phase: 'ready', health: h });
    } catch (err) {
      setHealth({ phase: 'error', error: err as ExamErrorDto });
    }
  }, []);

  useEffect(() => {
    void loadHealth();
    return () => abortRef.current?.abort();
  }, [loadHealth]);

  return (
    <div className="exam-assistant-settings">
      <h2 className="exam-assistant-settings__title">考试助手</h2>
      <p className="exam-assistant-settings__desc">
        DSH 原生考试助手：普通 Host Cordis 插件（node:sqlite + /exam/api + DSH llm）+
        普通 dsh.client React 包（sidebar 入口 / 全屏面板 / 本设置页）。
      </p>

      {/* Host 健康卡（自 ExamWorkspace 迁入，Phase 3 s5） */}
      <div className="exam-assistant-settings__note">
        <div className="exam-assistant-row">
          <strong>数据目录 / Host 状态</strong>
          {health.phase === 'ready' ? (
            <span
              className={
                health.health.ok
                  ? 'exam-assistant-status exam-assistant-status--ok'
                  : 'exam-assistant-status exam-assistant-status--err'
              }
            >
              <span className="exam-assistant-status__dot" aria-hidden="true" />
              {health.health.ok ? '服务正常' : `服务异常${health.health.error ? `（${health.health.error}）` : ''}`}
            </span>
          ) : null}
          <button
            type="button"
            className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
            onClick={() => void loadHealth()}
          >
            刷新
          </button>
        </div>
        {health.phase === 'loading' ? (
          <div className="exam-assistant-skeleton">正在探测 /exam/api/health …</div>
        ) : health.phase === 'error' ? (
          <p className="exam-assistant-error">
            {health.error.code}: {health.error.message}
          </p>
        ) : (
          <dl className="exam-assistant-kv">
            <dt className="exam-assistant-kv__key">数据目录</dt>
            <dd className="exam-assistant-kv__value">{health.health.store.path}</dd>
            <dt className="exam-assistant-kv__key">store</dt>
            <dd className="exam-assistant-kv__value">
              {health.health.store.ok ? 'ok' : 'error'}
              {health.health.store.closed ? '（已关闭）' : ''} · schema v{health.health.store.schemaVersion}
            </dd>
            <dt className="exam-assistant-kv__key">题库数量</dt>
            <dd className="exam-assistant-kv__value">{health.health.banks}</dd>
            <dt className="exam-assistant-kv__key">DSH LLM</dt>
            <dd className="exam-assistant-kv__value">{health.health.llmReady ? '已接线' : '未接线'}</dd>
            <dt className="exam-assistant-kv__key">启动时间</dt>
            <dd className="exam-assistant-kv__value">{formatTime(health.health.startedAt)}</dd>
          </dl>
        )}
      </div>

      <p className="exam-assistant-settings__note">
        完整业务界面（题库 / 练习 / 错题本 / AI 学习 / 学情）在「考试助手」全屏面板中承载；
        本设置页只承担状态与入口。
      </p>

      <div className="exam-assistant-settings__actions">
        <button
          type="button"
          className="exam-assistant-button"
          onClick={() => {
            close();
            toggleExamOverlay();
          }}
        >
          打开考试助手面板
        </button>
        <button type="button" className="exam-assistant-button exam-assistant-button--ghost" onClick={close}>
          关闭设置
        </button>
      </div>
    </div>
  );
}
