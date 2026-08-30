/**
 * 加载器冒烟：模拟 DSH web 的 window.__ModuleLoader__，验证
 * dist/client/client.js 的包裹格式与导出形状（不渲染 React，不调用 apply）。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'client', 'client.js');

let captured = null;
globalThis.window = globalThis;
globalThis.__ModuleLoader__ = { load: (handoff) => { captured = handoff; } };

await import(bundlePath);

if (!captured) throw new Error('bundle did not call window.__ModuleLoader__.load');
if (captured.id !== '@exam/dsh-exam') throw new Error(`unexpected id: ${captured.id}`);

const mod = captured.factory((spec) => require(spec));
if (!Array.isArray(mod.inject)) throw new Error('exports.inject is not an array');
if (typeof mod.apply !== 'function') throw new Error('exports.apply is not a function');
console.log('bundle ok:', captured.id, '| inject =', JSON.stringify(mod.inject), '| apply =', typeof mod.apply);
