/**
 * dsh-exam 普通 dsh.client 插件入口。
 *
 * 形态（与 DSH 生态一致，非动态 cordis_define 包）：
 * - 导出 `inject: string[]`（本包依赖的 Client Cordis 服务名）与 `apply(ctx)`；
 * - 构建产物为单文件 bundle：`window.__ModuleLoader__.load({ id: '@exam/dsh-exam', factory })`
 *   （tsdown banner/postBanner 包裹），工厂内 require("react") 等由 DSH web 的模块表提供。
 *
 * 注册（全部经 ctx.slots.inject + ctx.slots.register，随 fiber 卸载自动注销）：
 * - sidebar.footer.action  id 'exam-assistant'        —— 侧栏底部入口按钮（owner: { wide }）
 * - shell.overlay         id 'exam-assistant'         —— 全屏原生面板（关闭时渲染 null，不拦截交互）
 * - settings.section      id 'exam-assistant'         —— 紧凑设置/状态页（owner: { close }）
 *
 * 生命周期：样式注入 <style data-plugin>、locale、slot 注册全部挂在 ctx.effect 上，
 * 插件 stop/update/卸载时按 Fiber 逆序清理；无全局泄漏。
 */
import type { Context } from '@deepseek-ai/cordis';
import { examAssistantCss } from './styles.generated.ts';
import './contract.ts';
import { ExamSidebarAction } from './SidebarAction.tsx';
import { ExamOverlay } from './ExamOverlay.tsx';
import { ExamSettingsSection } from './SettingsSection.tsx';

/** 本包依赖的 Client 服务名（对应 package.json `dsh.client.inject` 的包级声明）。 */
export const inject = ['slots'];

const PLUGIN_ID = '@exam/dsh-exam';
const ENTRY_ID = 'exam-assistant';

export function apply(ctx: Context): void {
  // 1. 样式注入：<style data-plugin="@exam/dsh-exam">，随 Fiber 卸载移除。
  //    client-modules 的 claimStyles 按 data-plugin 认领 <style> 标签，HMR/卸载可精确回收。
  ctx.effect(() => {
    const style = document.createElement('style');
    style.setAttribute('data-plugin', PLUGIN_ID);
    style.textContent = examAssistantCss;
    document.head.append(style);
    return () => style.remove();
  });

  // 2. 侧栏底部入口（list/root；等待 DSH shell 声明该槽后同步注册）。
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: ENTRY_ID,
        order: 100,
        label: () => '考试助手',
      },
      ExamSidebarAction,
    ),
  );

  // 3. 全屏原生面板（list/root；点击穿透由 CSS opt-in，关闭时渲染 null）。
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: ENTRY_ID,
        order: 100,
      },
      ExamOverlay,
    ),
  );

  // 4. 设置页（list/root；owner 提供 close()）。
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: ENTRY_ID,
        order: 300,
        label: () => '考试助手',
      },
      ExamSettingsSection,
    ),
  );
}
