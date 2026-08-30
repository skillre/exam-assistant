#!/usr/bin/env node
/**
 * css-to-ts 生成器：把 src/client/styles.css 转成 src/client/styles.generated.ts。
 *
 * 原因：dsh.client bundle 是单文件（__ModuleLoader__ 工厂格式），CSS 不能作为独立资源
 * 被 script 标签加载；因此把命名空间样式内联为 TS 字符串，由插件 apply() 注入
 * <style data-plugin="..."> 标签（client-modules 的 claimStyles 会按 data-plugin 认领/回收）。
 *
 * 用法：node scripts/css-to-ts.mjs
 * 产物：src/client/styles.generated.ts（提交到仓库，typecheck 可见）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cssPath = join(root, 'src', 'client', 'styles.css');
const outPath = join(root, 'src', 'client', 'styles.generated.ts');

const css = readFileSync(cssPath, 'utf8');
// 模板字符串转义：反引号与 ${ 是仅有的两个风险点
const escaped = css.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');

const generated = `/**
 * 生成文件，勿手改 —— 由 scripts/css-to-ts.mjs 从 styles.css 生成。
 * 见 styles.css 顶部注释（命名空间/theme token 规则）。
 */
export const examAssistantCss: string = \`${escaped}\`;
`;

writeFileSync(outPath, generated, 'utf8');
console.log(`styles.css (${css.length} chars) -> styles.generated.ts (${generated.length} chars)`);
