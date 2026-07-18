import type { FastifyInstance } from 'fastify';
import type { ImportCommitRequest, ImportCommitResponse, ParseResult } from '@exam/shared';
import type { AiService } from '../ai/AiService.js';
import { parseTextWithAi } from '../import/parseWithAi.js';
import { parseFileBuffer, extractText, isStructuredFile } from '../import/parseFile.js';
import { validateDrafts } from '../import/questionSchema.js';
import { bankRepo } from '../repositories/bankRepo.js';
import { questionRepo } from '../repositories/questionRepo.js';

// Phase 3：题目导入。两条路径——粘贴文本(AI 解析) + 结构化文件(不走 AI)。
// 都先返回草稿供前端确认，再 commit 入库（FR1.3）。

export function registerImportRoutes(app: FastifyInstance, ai: AiService): void {
  // 粘贴文本 → AI 解析为草稿（DEC-11 一次性会话）
  app.post<{ Body: { text?: string } }>('/api/import/parse-text', async (req, reply) => {
    const text = req.body?.text;
    if (!text || !text.trim()) {
      return reply.code(400).send({ error: 'text 必填' });
    }
    try {
      const questions = await parseTextWithAi(ai, text);
      const res: ParseResult = { questions };
      return res;
    } catch (err) {
      return reply.code(400).send({ error: `解析失败：${(err as Error).message}` });
    }
  });

  // 文件导入(multipart)。结构化(.json/.csv/.xlsx)走确定性解析；
  // 文本类(.txt/.md/.docx)提取文字后走 AI 识别（同粘贴文本）。
  app.post('/api/import/parse-file', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: '缺少文件' });
    const buf = await file.toBuffer();
    try {
      if (isStructuredFile(file.filename)) {
        const questions = parseFileBuffer(file.filename, buf);
        const res: ParseResult = { questions };
        return res;
      }
      const text = await extractText(file.filename, buf);
      if (text === null) {
        return reply.code(400).send({
          error: '不支持的文件类型（文本类：.txt / .md / .docx；结构化：.json / .csv / .xlsx）',
        });
      }
      if (!text.trim()) {
        return reply.code(400).send({ error: '文件里没有可读取的文字' });
      }
      const questions = await parseTextWithAi(ai, text);
      const res: ParseResult = { questions };
      return res;
    } catch (err) {
      return reply.code(400).send({ error: `解析失败：${(err as Error).message}` });
    }
  });

  // 确认入库：可指定已有 bankId 或用 bankName 新建题库
  app.post<{ Body: ImportCommitRequest }>('/api/import/commit', async (req, reply) => {
    const { bankId, bankName, questions } = req.body ?? {};
    if (!Array.isArray(questions) || questions.length === 0) {
      return reply.code(400).send({ error: 'questions 不能为空' });
    }
    // 入库前再次校验草稿（前端可能编辑过，评审：不信任前端）
    let validated;
    try {
      validated = validateDrafts(questions, questions[0]?.source ?? 'file');
    } catch (err) {
      return reply.code(400).send({ error: `题目校验失败：${(err as Error).message}` });
    }

    let targetBankId = bankId;
    if (!targetBankId) {
      if (!bankName || !bankName.trim()) {
        return reply.code(400).send({ error: '需提供 bankId 或 bankName' });
      }
      targetBankId = bankRepo.create(bankName.trim()).id;
    } else if (!bankRepo.get(targetBankId)) {
      return reply.code(404).send({ error: '指定的题库不存在' });
    }

    const count = questionRepo.insertMany(targetBankId, validated);
    const res: ImportCommitResponse = { bankId: targetBankId, count };
    return reply.code(201).send(res);
  });
}
