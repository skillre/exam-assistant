import Fastify from 'fastify';
import { getDb } from './db/index.js';
import { DATA_DIR } from './config/paths.js';
import { AiService } from './ai/AiService.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerModelRoutes } from './routes/models.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  // 建库/建表 + 确保数据目录存在（Phase 1 验收：启动即建 app.db 六表）
  getDb();

  // pi SDK 集成层单例（Phase 2）。provider 变更后经 ai.reloadProviders() 热更。
  const ai = await AiService.create();

  const app = Fastify({ logger: true });

  app.get('/api/health', async () => ({ ok: true, dataDir: DATA_DIR }));

  registerProviderRoutes(app, ai);
  registerModelRoutes(app, ai);

  // 后续 phase 在此注册 routes（import / quiz / tutor / insights）

  await app.listen({ port: PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
