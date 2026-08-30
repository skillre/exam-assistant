/**
 * Client 类型契约装配（编译期专用，bundle 零运行时依赖）。
 *
 * DSH 的 SlotMap / Context 增强采用 `declare module` 声明合并，只有被编译程序
 * 加载的 .d.ts 才会生效。本文件以 type-only import 引入各 Slot 声明包与
 * dsh-client-runtime 的 client 类型入口，使以下契约对本包可见：
 * - '@deepseek-ai/dsh-client-runtime/client' → ctx.slots、GlobalStandardProps
 * - '@deepseek-ai/dsh-client-ui-sidebar/client'  → 'sidebar.footer.action'（owner: { wide }）
 * - '@deepseek-ai/dsh-client-ui-layout/client'   → 'shell.overlay'（list/root）
 * - '@deepseek-ai/dsh-client-ui-settings/client' → 'settings.section'（owner: { close }）
 *
 * rolldown/tsdown 构建时 type-only import 全部被擦除，不会产生 require。
 */
import type {} from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';

export {};
