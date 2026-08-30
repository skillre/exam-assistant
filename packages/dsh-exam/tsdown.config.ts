/**
 * tsdown 构建配置 —— 产出普通 dsh.client 单文件 bundle。
 *
 * 目标格式（与 DSH 官方 dsh.client 包一致，见 dsh-client-locale/lib/client.js 等）：
 *   window.__ModuleLoader__.load({
 *     id: "@exam/dsh-exam",
 *     factory: (require) => { ... CJS chunk ...; return module.exports; }
 *   });
 *
 * - banner：打开 __ModuleLoader__.load 调用并定义 factory 作用域内的 module/exports；
 * - footer：return module.exports 并闭合调用（client-modules materialize 读取工厂返回值）；
 * - external（deps.neverBundle）：react / react/jsx-runtime（DSH web 模块表提供），@deepseek-ai/*（各包自带 bundle）；
 * - entryFileNames: client.js —— client-modules 按 exports["./client"] 解析 bundle，
 *   要求路径以 /client.js 结尾（bundleSuffix = "/client.js"）。
 */
import { defineConfig } from 'tsdown';

const PLUGIN_ID = '@exam/dsh-exam';

export default defineConfig({
  entry: ['src/client/index.tsx'],
  format: ['cjs'],
  platform: 'browser',
  target: 'es2020',
  outDir: 'dist/client',
  clean: true,
  sourcemap: false,
  minify: false,
  treeshake: true,
  deps: {
    neverBundle: [/^react($|\/)/, /^@deepseek-ai\//],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(PLUGIN_ID)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
    footer: `\treturn module.exports;\n\t}\n});`,
  },
});
