import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { getDb } from './db/index.js';
import { DATA_DIR } from './config/paths.js';
import { AiService } from './ai/AiService.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerModelRoutes } from './routes/models.js';
import { registerImportRoutes } from './routes/import.js';
import { registerQuizRoutes } from './routes/quiz.js';
import { registerBankRoutes } from './routes/banks.js';
import { registerTutorRoutes } from './routes/tutor.js';
import { registerInsightsRoutes } from './routes/insights.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  // 建库/建表 + 确保数据目录存在（Phase 1 验收：启动即建 app.db 六表）
  getDb();

  // pi SDK 集成层单例（Phase 2）。provider 变更后经 ai.reloadProviders() 热更。
  const ai = await AiService.create();

  const app = Fastify({ logger: true });

  // 文件导入需 multipart（Phase 3 parse-file）。限制 5MB。
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });

  app.get('/api/health', async () => ({ ok: true, dataDir: DATA_DIR }));

  registerProviderRoutes(app, ai);
  registerModelRoutes(app, ai);
  registerImportRoutes(app, ai);
  registerQuizRoutes(app);
  registerBankRoutes(app);
  registerTutorRoutes(app, ai);
  registerInsightsRoutes(app, ai);

  await app.listen({ port: PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
