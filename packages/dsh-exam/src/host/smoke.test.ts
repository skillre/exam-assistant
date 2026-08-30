/**
 * Host 骨架冒烟测试：ExamService（service.ts）+ HTTP 路由（index.ts）。
 *
 * 用真实 `node:http` server 驱动 `registerExamRoutes` 注册的路由处理器，
 * 覆盖 JSON 响应、状态码、方法（405）、异常映射（400/503/500）与 prefix 兜底。
 * 不依赖真实 Cordis 运行时：registerExamRoutes 的 `webServer` 参数是结构类型，
 * 这里用最小 fake（register 返回 disposer）满足之。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
import type { LlmProviderInfo } from '@deepseek-ai/dsh-llm';
import { openExamStore } from './store.ts';
import { createExamService, type ExamService } from './service.ts';
import { createExamLlm, createFakeLlmService, finishStop, textDelta, type ExamLlm } from './llm.ts';
import { registerExamRoutes, resolveLlmRoute, type LlmRoute } from './index.ts';

/** 最小 fake WebServer：按 DSH 语义匹配（exact 优先，prefix 最长优先）。 */
interface FakeWebServer extends Server {
  register: WebServer['register'];
  handlers: Map<string, (req: any, res: any) => void | Promise<void>>;
}

function fakeWebServer(): FakeWebServer {
  const exact = new Map<string, (req: any, res: any) => void | Promise<void>>();
  const prefixes = new Map<string, (req: any, res: any) => void | Promise<void>>();
  const handlers = new Map<string, (req: any, res: any) => void | Promise<void>>();
  const register: WebServer['register'] = (route) => {
    const path = route.path;
    if (route.kind === 'exact') exact.set(path, route.handler);
    else prefixes.set(path, route.handler);
    handlers.set(path, route.handler);
    return () => {
      if (route.kind === 'exact') exact.delete(path);
      else prefixes.delete(path);
      handlers.delete(path);
    };
  };
  // 预置 match 分派：请求进来时按真实语义选 handler。
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const exactHandler = exact.get(pathname);
    if (exactHandler) {
      void exactHandler(req, res);
      return;
    }
    let best: { path: string; handler: (req: any, res: any) => void | Promise<void> } | undefined;
    for (const [path, handler] of prefixes) {
      if (pathname === path || pathname.startsWith(`${path}/`)) {
        if (!best || path.length > best.path.length) best = { path, handler };
      }
    }
    if (best) void best.handler(req, res);
    else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return Object.assign(server, { handlers, register });
}

/** registerExamRoutes 只用到 info/warn。 */
const fakeLogger = { info() {}, warn() {} } as unknown as Parameters<typeof registerExamRoutes>[3];

/** withServer 的 llm 装配选项。 */
interface WithServerOptions {
  /** 路由层 llm 面（provider/model 解析）；缺省 = 无 provider。 */
  llm?: LlmRoute;
  /** 服务层 llm 门面；缺省 = 不接线（EXAM_LLM_UNAVAILABLE 路径）。 */
  examLlm?: ExamLlm;
  /** store: false = 降级模式（store 未打开，如打开失败后）。 */
  store?: boolean;
}

async function withServer(
  run: (base: string, service: ExamService, disposers: Array<() => void>) => Promise<void>,
  options: WithServerOptions = {},
): Promise<void> {
  const store = options.store === false ? undefined : await openExamStore(':memory:');
  const service = createExamService({ store, llm: options.examLlm });
  const webServer = fakeWebServer();
  const llm: LlmRoute = options.llm ?? { listProviders: () => [], listModels: async () => [] };
  const disposers = registerExamRoutes(webServer as unknown as WebServer, service, llm, fakeLogger);
  await new Promise<void>((resolveListen) => webServer.listen(0, '127.0.0.1', resolveListen));
  const { port } = webServer.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, service, disposers);
  } finally {
    await new Promise<void>((resolveClose) => webServer.close(() => resolveClose()));
    for (const dispose of disposers.reverse()) dispose();
    service.close();
  }
}

async function fetchJson(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

test('GET /exam/api/health → 200 且结构完整', async () => {
  await withServer(async (base, service) => {
    const { status, body } = await fetchJson(base, '/exam/api/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'exam');
    assert.equal(body.store.ok, true);
    assert.equal(body.store.closed, false);
    assert.equal(body.banks, 0);
    assert.equal(body.llmReady, false);
  });
});

test('POST/GET /exam/api/banks 往返，空名 400，错误方法 405', async () => {
  await withServer(async (base) => {
    // 创建
    const created = await fetchJson(base, '/exam/api/banks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: ' 单元测试题库 ' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.bank.name, '单元测试题库');
    const bankId = created.body.bank.id;
    assert.ok(typeof bankId === 'string' && bankId.length > 0);

    // 列表
    const listed = await fetchJson(base, '/exam/api/banks');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.banks.length, 1);
    assert.equal(listed.body.banks[0].id, bankId);

    // 空名 → 400 EXAM_BANK_NAME_REQUIRED
    const empty = await fetchJson(base, '/exam/api/banks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'EXAM_BANK_NAME_REQUIRED');

    // 非法 body → 400 EXAM_INVALID_BODY
    const bad = await fetchJson(base, '/exam/api/banks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'EXAM_INVALID_BODY');

    // 错误方法 → 405 + Allow
    const del = await fetchJson(base, '/exam/api/banks', { method: 'DELETE' });
    assert.equal(del.status, 405);
  });
});

test('store 关闭后 → 503 EXAM_STORE_CLOSED；未匹配 /exam/api/* → 404 JSON', async () => {
  await withServer(async (base, service) => {
    service.close();
    const health = await fetchJson(base, '/exam/api/health');
    assert.equal(health.status, 503);
    assert.equal(health.body.ok, false);
    const banks = await fetchJson(base, '/exam/api/banks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(banks.status, 503);
    assert.equal(banks.body.error.code, 'EXAM_STORE_CLOSED');

    // prefix 兜底：/exam/api/unknown → JSON 404
    const miss = await fetchJson(base, '/exam/api/unknown');
    assert.equal(miss.status, 404);
    assert.equal(miss.body.error.code, 'EXAM_NOT_FOUND');
  });
});

test('store 未打开（降级模式）→ health 503 可读错误；banks → 503 EXAM_STORE_UNAVAILABLE', async () => {
  await withServer(
    async (base) => {
      const health = await fetchJson(base, '/exam/api/health');
      assert.equal(health.status, 503);
      assert.equal(health.body.ok, false);
      assert.equal(health.body.store.ok, false);
      assert.equal(health.body.store.path, '(unopened)');
      assert.ok(
        typeof health.body.error === 'string' && health.body.error.length > 0,
        '降级 health 应带可读 error',
      );

      const banks = await fetchJson(base, '/exam/api/banks');
      assert.equal(banks.status, 503);
      assert.equal(banks.body.error.code, 'EXAM_STORE_UNAVAILABLE');

      const created = await fetchJson(base, '/exam/api/banks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      });
      assert.equal(created.status, 503);
      assert.equal(created.body.error.code, 'EXAM_STORE_UNAVAILABLE');
    },
    { store: false },
  );
});

// ---------------------------------------------------------------------------
// POST /exam/api/llm/test
// ---------------------------------------------------------------------------

/** 读取 SSE 响应，解析为事件数组。 */
async function readSse(base: string, path: string, init?: RequestInit): Promise<{ status: number; events: any[] }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  const events: any[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      events.push(JSON.parse(line.slice(6)));
    }
  }
  return { status: res.status, events };
}

test('POST /exam/api/llm/test：无可用 provider → 503 JSON 可读错误', async () => {
  await withServer(async (base) => {
    const res = await fetchJson(base, '/exam/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '你好' }),
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'EXAM_LLM_NO_PROVIDER');
  });
});

test('POST /exam/api/llm/test：缺 prompt → 400；错误方法 → 405', async () => {
  const providers: LlmProviderInfo[] = [{ id: 'deepseek', name: 'DeepSeek' }];
  await withServer(
    async (base) => {
      const missing = await fetchJson(base, '/exam/api/llm/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error.code, 'EXAM_INVALID_BODY');

      const get = await fetchJson(base, '/exam/api/llm/test');
      assert.equal(get.status, 405);
    },
    { llm: { listProviders: () => providers, listModels: async () => [] } },
  );
});

test('POST /exam/api/llm/test：SSE 成功流（delta → done），缺省 provider/model 自动解析', async () => {
  const providers: LlmProviderInfo[] = [{ id: 'deepseek', name: 'DeepSeek' }];
  const examLlm = createExamLlm(
    createFakeLlmService(async function* () {
      yield textDelta('你');
      yield textDelta('好');
      yield finishStop();
    }),
  );
  await withServer(
    async (base) => {
      const { status, events } = await readSse(base, '/exam/api/llm/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: ' 你好 ' }),
      });
      assert.equal(status, 200);
      assert.deepEqual(events[0], { type: 'delta', text: '你' });
      assert.deepEqual(events[1], { type: 'delta', text: '好' });
      assert.equal(events[2].type, 'done');
      assert.equal(events[2].result.text, '你好');
      assert.equal(events[2].result.finish, 'stop', 'done.result.finish 应为字符串（finish.kind 归一化，与 Client 契约一致）');
      assert.equal(events[2].result.provider, 'deepseek');
      assert.equal(events[2].result.model, 'deepseek-chat');
    },
    {
      llm: {
        listProviders: () => providers,
        listModels: async (provider) => {
          assert.equal(provider, 'deepseek');
          return [{ provider, id: 'deepseek-chat', name: 'DeepSeek Chat' }];
        },
      },
      examLlm,
    },
  );
});

test('POST /exam/api/llm/test：服务未接线 llm → SSE error 事件（可读错误码）', async () => {
  const providers: LlmProviderInfo[] = [{ id: 'deepseek', name: 'DeepSeek' }];
  await withServer(
    async (base) => {
      const { status, events } = await readSse(base, '/exam/api/llm/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', provider: 'deepseek', model: 'm' }),
      });
      assert.equal(status, 200); // SSE 已开始
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'error');
      assert.equal(events[0].error.code, 'EXAM_LLM_UNAVAILABLE');
    },
    { llm: { listProviders: () => providers, listModels: async () => [] } },
  );
});

// ---------------------------------------------------------------------------
// Phase 1：题目 CRUD / 练习全流程 / 错题本（HTTP 层）
// ---------------------------------------------------------------------------

test('Phase1 题目 CRUD：创建/列表/更新/删除 + 400/404 语义', async () => {
  await withServer(async (base) => {
    // 建题库
    const bank = await fetchJson(base, '/exam/api/banks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'P1 题库' }),
    });
    const bankId = bank.body.bank.id;

    // 创建题目
    const created = await fetchJson(base, `/exam/api/banks/${bankId}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'single', stem: '1+1=?', options: ['1', '2'], answer: '1', tags: ['数学'] }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.question.type, 'single');
    assert.equal(created.body.question.answer, '1');
    assert.equal(created.body.question.deletedAt, null, 'DTO 透出 deletedAt（正常题目为 null）');
    const qid = created.body.question.id;

    // 列表
    const listed = await fetchJson(base, `/exam/api/banks/${bankId}/questions`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.questions.length, 1);
    assert.equal(listed.body.questions[0].id, qid);

    // 更新
    const updated = await fetchJson(base, `/exam/api/questions/${qid}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: '2', explanation: '1+1=2' }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.question.answer, '2');

    // 非法题型 → 400 EXAM_INVALID_BODY（essay 自 Phase 2 起为合法题型）
    const bad = await fetchJson(base, `/exam/api/banks/${bankId}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'matching', stem: 'x', options: [], answer: 1 }),
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'EXAM_INVALID_BODY');

    // 题库不存在 → 404 EXAM_BANK_NOT_FOUND
    const noBank = await fetchJson(base, '/exam/api/banks/nope/questions');
    assert.equal(noBank.status, 404);
    assert.equal(noBank.body.error.code, 'EXAM_BANK_NOT_FOUND');

    // 题目不存在 → 404 EXAM_QUESTION_NOT_FOUND
    const noQ = await fetchJson(base, '/exam/api/questions/ghost', { method: 'DELETE' });
    assert.equal(noQ.status, 404);
    assert.equal(noQ.body.error.code, 'EXAM_QUESTION_NOT_FOUND');

    // 删除 → 204，再删 404
    const del = await fetchJson(base, `/exam/api/questions/${qid}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    const delAgain = await fetchJson(base, `/exam/api/questions/${qid}`, { method: 'DELETE' });
    assert.equal(delAgain.status, 404);
  });
});

test('Phase4.1 练习历史删除：DELETE 204 → history 不再含 → 再删 404；作答保留', async () => {
  await withServer(async (base) => {
    const bank = await fetchJson(base, '/exam/api/banks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'P41 删除题库' }),
    });
    const bankId = bank.body.bank.id;
    const q = await fetchJson(base, `/exam/api/banks/${bankId}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'single', stem: 's', options: ['A', 'B'], answer: 'A' }),
    });
    const started = await fetchJson(base, '/exam/api/practice/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
    });
    assert.equal(started.status, 201);
    const pid = started.body.practice.id;

    // 答一题：作答保留语义的证据链（删除会话后 attempts 仍在）
    const graded = await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ practiceId: pid, questionId: q.body.question.id, answer: 'A' }),
    });
    assert.equal(graded.status, 200);

    // 错误方法 → 405（Allow 更新为 GET/PATCH/DELETE）
    const wrong = await fetchJson(base, `/exam/api/practice/${pid}`, { method: 'POST' });
    assert.equal(wrong.status, 405);

    // 删除 → 204；history 不再含该条；再删 → 404
    const del = await fetchJson(base, `/exam/api/practice/${pid}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    const history = await fetchJson(base, '/exam/api/practice/history');
    assert.equal(
      (history.body.sessions as Array<{ id: string }>).some((s) => s.id === pid),
      false,
      '删除后历史列表不含该会话',
    );
    const delAgain = await fetchJson(base, `/exam/api/practice/${pid}`, { method: 'DELETE' });
    assert.equal(delAgain.status, 404);
    assert.equal(delAgain.body.error.code, 'EXAM_PRACTICE_NOT_FOUND');
  });
});

test('Phase1 练习全流程：start → grade → scorecard → finish → resume + 校验错误', async () => {
  await withServer(async (base) => {
    const bank = await fetchJson(base, '/exam/api/banks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'P1 练习题库' }),
    });
    const bankId = bank.body.bank.id;
    const mk = (type: string, stem: string, answer: unknown) =>
      fetchJson(base, `/exam/api/banks/${bankId}/questions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, stem, options: type === 'boolean' ? [] : ['A', 'B'], answer }),
      });
    const q1 = (await mk('single', '选 A', 'A')).body.question;
    const q2 = (await mk('multiple', '选 AB', ['A', 'B'])).body.question;
    const q3 = (await mk('boolean', '真命题', 'true')).body.question;

    // start（shuffle + 固定 seed，确定性）
    const started = await fetchJson(base, '/exam/api/practice/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bankId, scope: { mode: 'all' }, shuffle: true, seed: 'p1' }),
    });
    assert.equal(started.status, 201);
    const practice = started.body.practice;
    assert.equal(practice.status, 'active');
    assert.equal(practice.questionIds.length, 3);
    assert.deepEqual(new Set(practice.questionIds), new Set([q1.id, q2.id, q3.id]));

    // 非法 scope → 400 EXAM_INVALID_BODY
    const badScope = await fetchJson(base, '/exam/api/practice/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bankId, scope: { mode: 'bogus' } }),
    });
    assert.equal(badScope.status, 400);

    // 判分：q1 对、q2 错（缺项）
    const g1 = await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ practiceId: practice.id, questionId: q1.id, answer: 'A' }),
    });
    assert.equal(g1.status, 200);
    assert.equal(g1.body.isCorrect, true);
    const g2 = await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ practiceId: practice.id, questionId: q2.id, answer: ['A'] }),
    });
    assert.equal(g2.body.isCorrect, false);
    assert.equal(g2.body.attempt.questionId, q2.id);

    // 题目不在会话内 → 400 EXAM_QUESTION_NOT_IN_PRACTICE（另建会话验证）
    const small = await fetchJson(base, '/exam/api/practice/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bankId, scope: { mode: 'byType', type: 'single' } }),
    });
    const notIn = await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ practiceId: small.body.practice.id, questionId: q2.id, answer: ['A', 'B'] }),
    });
    assert.equal(notIn.status, 400);
    assert.equal(notIn.body.error.code, 'EXAM_QUESTION_NOT_IN_PRACTICE');

    // 进度下标 PATCH + 非法下标 400
    const patched = await fetchJson(base, `/exam/api/practice/${practice.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentIndex: 1 }),
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.practice.currentIndex, 1);
    const badIndex = await fetchJson(base, `/exam/api/practice/${practice.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentIndex: -1 }),
    });
    assert.equal(badIndex.status, 400);

    // scorecard：3 题，answered 2，correct 1
    const sc = await fetchJson(base, `/exam/api/practice/${practice.id}/scorecard`);
    assert.equal(sc.status, 200);
    assert.equal(sc.body.scorecard.total, 3);
    assert.equal(sc.body.scorecard.answered, 2);
    assert.equal(sc.body.scorecard.correct, 1);
    assert.equal(sc.body.scorecard.accuracy, 0.5);

    // finish → status finished + scorecard
    const finished = await fetchJson(base, `/exam/api/practice/${practice.id}/finish`, { method: 'POST' });
    assert.equal(finished.status, 200);
    assert.equal(finished.body.practice.status, 'finished');
    assert.ok(finished.body.practice.finishedAt !== null);
    assert.equal(finished.body.scorecard.total, 3);

    // resume：finished 会话 + 每题最新作答
    const resumed = await fetchJson(base, `/exam/api/practice/${practice.id}`);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.practice.status, 'finished');
    assert.deepEqual(
      resumed.body.latestAttempts.map((a: { questionId: string }) => a.questionId).sort(),
      [q1.id, q2.id].sort(),
    );

    // 不存在的会话 → 404 EXAM_PRACTICE_NOT_FOUND
    const missing = await fetchJson(base, '/exam/api/practice/ghost');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'EXAM_PRACTICE_NOT_FOUND');
  });
});

test('Phase1 错题本：答错入册 → 列表 → 掌握标记 → includeMastered 语义', async () => {
  await withServer(async (base) => {
    const bank = await fetchJson(base, '/exam/api/banks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'P1 错题题库' }),
    });
    const bankId = bank.body.bank.id;
    const q = (
      await fetchJson(base, `/exam/api/banks/${bankId}/questions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'single', stem: '2+2=?', options: ['3', '4'], answer: '4' }),
      })
    ).body.question;

    // 独立判分一次（答错入册）
    const practice = (
      await fetchJson(base, '/exam/api/practice/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
      })
    ).body.practice;
    await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ practiceId: practice.id, questionId: q.id, answer: '3' }),
    });

    // 列表（默认排除已掌握）
    const list = await fetchJson(base, '/exam/api/wrong');
    assert.equal(list.status, 200);
    assert.equal(list.body.wrong.length, 1);
    assert.equal(list.body.wrong[0].questionId, q.id);
    assert.equal(list.body.wrong[0].wrongCount, 1);

    // bankId 过滤
    const filtered = await fetchJson(base, `/exam/api/wrong?bankId=${bankId}`);
    assert.equal(filtered.body.wrong.length, 1);
    const otherFilter = await fetchJson(base, '/exam/api/wrong?bankId=ghost');
    assert.equal(otherFilter.body.wrong.length, 0);

    // 掌握标记
    const mastered = await fetchJson(base, `/exam/api/wrong/${q.id}/master`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mastered: true }),
    });
    assert.equal(mastered.status, 200);
    assert.equal(mastered.body.wrong.mastered, true);
    assert.equal((await fetchJson(base, '/exam/api/wrong')).body.wrong.length, 0, '默认排除已掌握');
    assert.equal((await fetchJson(base, '/exam/api/wrong?includeMastered=true')).body.wrong.length, 1);

    // 题目不存在 → 404
    const noQ = await fetchJson(base, '/exam/api/wrong/ghost/master', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mastered: true }),
    });
    assert.equal(noQ.status, 404);
    assert.equal(noQ.body.error.code, 'EXAM_QUESTION_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Phase 2：essay 批改 / Tutor / AI 导入 / 学情 / 计划 / 练习历史（HTTP 层）
// ---------------------------------------------------------------------------

const POST_JSON = { 'content-type': 'application/json' } as const;

/**
 * 按 system prompt 选择回复文本的 fake llm（Phase 2 冒烟用）：
 * 命中则把整段文本拆成两个 text-delta（验证流式透传），未命中返回空回复。
 * 注：ai.ts 的 gradeEssay/导入/诊断/计划走 options.system；Tutor 的 system
 * 在 messages[0]（role=system）里，两种都要兜底。
 */
function llmResponding(pick: (system: string | undefined) => string): ExamLlm {
  return createExamLlm(
    createFakeLlmService(async function* (options) {
      const systemMessage = options.messages.find((m) => m.role === 'system');
      const systemText =
        options.system ??
        (systemMessage?.content?.find((b) => b.type === 'text')?.text as string | undefined);
      const text = pick(systemText);
      if (text.length === 0) {
        yield finishStop();
        return;
      }
      const mid = Math.floor(text.length / 2);
      yield textDelta(text.slice(0, mid));
      yield textDelta(text.slice(mid));
      yield finishStop();
    }),
  );
}

/** 默认 provider/模型路由（deepseek → deepseek-chat）。 */
const DEFAULT_ROUTE: WithServerOptions['llm'] = {
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
  listModels: async (provider) => [{ provider, id: 'deepseek-chat', name: 'DeepSeek Chat' }],
};

/** 建题库 + 建题（返回 { bankId, question }）。 */
async function mkBankAndQuestion(
  base: string,
  bankName: string,
  question: Record<string, unknown>,
): Promise<{ bankId: string; question: any }> {
  const bank = await fetchJson(base, '/exam/api/banks', {
    method: 'POST',
    headers: POST_JSON,
    body: JSON.stringify({ name: bankName }),
  });
  const bankId = bank.body.bank.id;
  const created = await fetchJson(base, `/exam/api/banks/${bankId}/questions`, {
    method: 'POST',
    headers: POST_JSON,
    body: JSON.stringify(question),
  });
  return { bankId, question: created.body.question };
}

/** 向既有题库追加题目（同题库多题场景用）。 */
async function mkQuestion(base: string, bankId: string, question: Record<string, unknown>): Promise<any> {
  const created = await fetchJson(base, `/exam/api/banks/${bankId}/questions`, {
    method: 'POST',
    headers: POST_JSON,
    body: JSON.stringify(question),
  });
  return created.body.question;
}

test('Phase2 essay 批改：SSE 全链路（delta → done）+ 校验错误', async () => {
  const gradingJson = JSON.stringify({
    score: 85,
    verdict: 'correct',
    feedback: '结构清晰，要点完整。',
    reference: '要点一；要点二',
  });
  const examLlm = llmResponding((system) => (system?.includes('批改教师') ? gradingJson : ''));
  await withServer(
    async (base) => {
      // 建 essay 题（options=[] answer=null 放行）+ 客观题（对照）
      const { bankId, question: essay } = await mkBankAndQuestion(base, 'essay 题库', {
        type: 'essay',
        stem: '论述题：简述 TCP 三次握手的过程与意义。',
        options: [],
        answer: null,
      });
      assert.equal(essay.type, 'essay');
      assert.deepEqual(essay.options, []);
      assert.equal(essay.answer, null);
      const { question: single } = await mkBankAndQuestion(base, 'essay 题库', {
        type: 'single',
        stem: '1+1=?',
        options: ['1', '2'],
        answer: '1',
      });
      const practice = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;

      // 非 essay 题 → 400 EXAM_NOT_ESSAY（流未开始，JSON 错误）
      const notEssay = await fetchJson(base, '/exam/api/grading/essay', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ questionId: single.id, userAnswer: 'x' }),
      });
      assert.equal(notEssay.status, 400);
      assert.equal(notEssay.body.error.code, 'EXAM_NOT_ESSAY');

      // 空作答 → 400 EXAM_ESSAY_ANSWER_REQUIRED
      const empty = await fetchJson(base, '/exam/api/grading/essay', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ questionId: essay.id, userAnswer: '   ' }),
      });
      assert.equal(empty.status, 400);
      assert.equal(empty.body.error.code, 'EXAM_ESSAY_ANSWER_REQUIRED');

      // practiceId 不存在 → 404 EXAM_PRACTICE_NOT_FOUND
      const noPractice = await fetchJson(base, '/exam/api/grading/essay', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ questionId: essay.id, userAnswer: 'x', practiceId: 'ghost' }),
      });
      assert.equal(noPractice.status, 404);
      assert.equal(noPractice.body.error.code, 'EXAM_PRACTICE_NOT_FOUND');

      // 成功流：delta（LLM 原文）→ done { result: { attemptId, grading } }
      const { status, events } = await readSse(base, '/exam/api/grading/essay', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ questionId: essay.id, practiceId: practice.id, userAnswer: 'TCP 三次握手是……' }),
      });
      assert.equal(status, 200);
      assert.equal(events[0].type, 'delta');
      assert.ok(typeof events[0].text === 'string' && events[0].text.length > 0);
      const done = events[events.length - 1];
      assert.equal(done.type, 'done');
      assert.ok(typeof done.result.attemptId === 'string' && done.result.attemptId.length > 0);
      assert.equal(done.result.grading.score, 85);
      assert.equal(done.result.grading.verdict, 'correct');
      assert.equal(done.result.grading.feedback, '结构清晰，要点完整。');
      assert.equal(done.result.grading.reference, '要点一；要点二');
      assert.equal(done.result.grading.isCorrect, true);

      // 作答已记录（scorecard answered/correct=1），答对不入错题本
      const sc = await fetchJson(base, `/exam/api/practice/${practice.id}/scorecard`);
      assert.equal(sc.body.scorecard.answered, 1);
      assert.equal(sc.body.scorecard.correct, 1);
      const wrong = await fetchJson(base, '/exam/api/wrong?includeMastered=true');
      assert.equal(wrong.body.wrong.length, 0);
    },
    { llm: DEFAULT_ROUTE, examLlm },
  );
});

test('Phase2 quiz/grade 对 essay 题 → 400 EXAM_INVALID_QUESTION（提示走批改接口）', async () => {
  await withServer(async (base) => {
    const { bankId, question } = await mkBankAndQuestion(base, 'essay 拦截题库', {
      type: 'essay',
      stem: '简答：什么是 REST？',
      options: [],
      answer: null,
    });
    const practice = (
      await fetchJson(base, '/exam/api/practice/start', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
      })
    ).body.practice;
    const graded = await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ practiceId: practice.id, questionId: question.id, answer: 'REST 是……' }),
    });
    assert.equal(graded.status, 400);
    assert.equal(graded.body.error.code, 'EXAM_INVALID_QUESTION');
  });
});

test('Phase2 Tutor：自由问答 + 绑定题目 + 会话列表 + 校验错误', async () => {
  const tutorReply = '这道题的关键在于理解握手序号与确认号的配合。';
  const examLlm = llmResponding((system) => (system?.includes('讲题助手') ? tutorReply : ''));
  await withServer(
    async (base) => {
      // 自由问答（无 sessionId → 新建会话）
      const chat1 = await readSse(base, '/exam/api/tutor/chat', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ message: '给我讲讲怎么复习网络协议' }),
      });
      assert.equal(chat1.status, 200);
      assert.equal(chat1.events[0].type, 'delta');
      const done1 = chat1.events[chat1.events.length - 1];
      assert.equal(done1.type, 'done');
      assert.ok(typeof done1.result.sessionId === 'string' && done1.result.sessionId.length > 0);
      assert.ok(typeof done1.result.messageId === 'string' && done1.result.messageId.length > 0);
      assert.equal(done1.result.reply, tutorReply);
      assert.equal(done1.result.model, 'deepseek-chat');

      // 续聊同会话（历史上下文保留）
      const chat2 = await readSse(base, '/exam/api/tutor/chat', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ sessionId: done1.result.sessionId, message: '再讲细一点' }),
      });
      const done2 = chat2.events[chat2.events.length - 1];
      assert.equal(done2.result.sessionId, done1.result.sessionId);
      assert.notEqual(done2.result.messageId, done1.result.messageId);

      // 会话列表：自由问答会话 questionId 缺省省略；title = 首条用户消息摘要
      const sessions1 = (await fetchJson(base, '/exam/api/tutor/sessions')).body.sessions;
      assert.equal(sessions1.length, 1);
      assert.equal(sessions1[0].id, done1.result.sessionId);
      assert.equal(sessions1[0].questionId, undefined);
      assert.ok(
        typeof sessions1[0].title === 'string' && sessions1[0].title.length > 0,
        '自由问答会话应生成可读 title（首条消息摘要）',
      );

      // 绑定题目：从题目页入口（questionId）开启会话
      const { bankId, question } = await mkBankAndQuestion(base, 'tutor 题库', {
        type: 'single',
        stem: '选 A',
        options: ['A. 甲', 'B. 乙'],
        answer: 'A',
      });
      const chat3 = await readSse(base, '/exam/api/tutor/chat', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ questionId: question.id, message: '这题为什么选甲？' }),
      });
      assert.equal(chat3.events[chat3.events.length - 1].type, 'done');
      const sessions2 = (await fetchJson(base, '/exam/api/tutor/sessions')).body.sessions;
      assert.equal(sessions2.length, 2);
      const bound = sessions2.find((s: any) => s.questionId === question.id);
      assert.ok(bound !== undefined, '绑定题目的会话应带 questionId');
      assert.equal(bound.bankId, bankId);
      assert.ok(
        typeof bound.title === 'string' && bound.title.startsWith('题目讲解'),
        '绑定题目会话 title 应以「题目讲解」开头（题干摘要）',
      );

      // 删除会话：DELETE 204 → 列表少一条；详情 404
      const del = await fetchJson(base, `/exam/api/tutor/sessions/${done1.result.sessionId}`, {
        method: 'DELETE',
      });
      assert.equal(del.status, 204);
      const sessions3 = (await fetchJson(base, '/exam/api/tutor/sessions')).body.sessions;
      assert.equal(sessions3.length, 1);
      assert.equal(sessions3[0].id, bound.id, '删除后仅剩绑定题会话');
      const deletedDetail = await fetchJson(base, `/exam/api/tutor/sessions/${done1.result.sessionId}`, {
        method: 'GET',
      });
      assert.equal(deletedDetail.status, 404);
      assert.equal(deletedDetail.body.error.code, 'EXAM_TUTOR_SESSION_NOT_FOUND');

      // 校验错误
      const emptyMsg = await fetchJson(base, '/exam/api/tutor/chat', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ message: '   ' }),
      });
      assert.equal(emptyMsg.status, 400);
      assert.equal(emptyMsg.body.error.code, 'EXAM_TUTOR_MESSAGE_REQUIRED');
      const noSession = await fetchJson(base, '/exam/api/tutor/chat', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ sessionId: 'ghost', message: 'hi' }),
      });
      assert.equal(noSession.status, 404);
      assert.equal(noSession.body.error.code, 'EXAM_TUTOR_SESSION_NOT_FOUND');
    },
    { llm: DEFAULT_ROUTE, examLlm },
  );
});

test('Phase2 AI 导入：generate 草稿 → commit 入库 + 校验错误', async () => {
  const importJson = JSON.stringify([
    {
      type: 'single',
      stem: 'TCP 的握手次数是？',
      options: ['A. 一次', 'B. 两次', 'C. 三次'],
      answer: 'C',
      explanation: '三次握手',
      tags: ['网络'],
      topics: ['传输层', 'TCP 连接'],
    },
    { type: 'boolean', stem: 'UDP 是面向连接的。', options: [], answer: 'false', tags: ['网络'], topics: ['传输层'] },
  ]);
  const examLlm = llmResponding((system) => (system?.includes('出题专家') ? importJson : ''));
  await withServer(
    async (base) => {
      const bank = await fetchJson(base, '/exam/api/banks', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ name: '导入题库' }),
      });
      const bankId = bank.body.bank.id;
      const longText =
        '这是一段超过五十个字符的复习资料文本，用来验证 AI 文本导入向导从粘贴资料生成题目草稿的完整链路是否正常工作。';

      // 草稿（不落库；t5 响应携带 draftId 供刷新恢复）
      const generated = await fetchJson(base, '/exam/api/import/generate', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ text: longText }),
      });
      assert.equal(generated.status, 200);
      assert.equal(generated.body.questions.length, 2);
      assert.equal(generated.body.questions[0].type, 'single');
      assert.equal(generated.body.questions[0].answer, 'C');
      assert.deepEqual(generated.body.questions[0].topics, ['传输层', 'TCP 连接'], '草稿携带规范化 topics');
      assert.equal(generated.body.questions[1].type, 'boolean');
      assert.equal(typeof generated.body.draftId, 'string');

      // 短文本 → 400 EXAM_IMPORT_EMPTY
      const short = await fetchJson(base, '/exam/api/import/generate', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ text: '太短了' }),
      });
      assert.equal(short.status, 400);
      assert.equal(short.body.error.code, 'EXAM_IMPORT_EMPTY');

      // 题库不存在 → 404 EXAM_BANK_NOT_FOUND
      const noBank = await fetchJson(base, '/exam/api/import/commit', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ bankId: 'ghost', questions: generated.body.questions }),
      });
      assert.equal(noBank.status, 404);
      assert.equal(noBank.body.error.code, 'EXAM_BANK_NOT_FOUND');

      // 入库
      const committed = await fetchJson(base, '/exam/api/import/commit', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ bankId, questions: generated.body.questions }),
      });
      assert.equal(committed.status, 200);
      assert.equal(committed.body.count, 2);
      assert.equal(committed.body.questions.length, 2);
      assert.equal(typeof committed.body.batchId, 'string');
      const listed = await fetchJson(base, `/exam/api/banks/${bankId}/questions`);
      assert.equal(listed.body.questions.length, 2);
      const qSingle = listed.body.questions.find((q: any) => q.stem.includes('TCP 的握手次数'));
      const qBoolean = listed.body.questions.find((q: any) => q.stem.includes('UDP'));
      assert.ok(qSingle && qBoolean, '两题都已入库');
      assert.deepEqual(qSingle.topics, ['传输层', 'tcp连接'], '导入 topics 落库（标签规范化）');
      assert.equal(qSingle.topicsSource, 'import', '导入路径 topicsSource=import');
      assert.deepEqual(qBoolean.topics, ['传输层'], '第二题 topics 落库');
      assert.equal(qBoolean.topicsSource, 'import');

      // 批次幂等：同 batchId 重发 → replayed:true 零写入（列表仍 2 题）
      const replayed = await fetchJson(base, '/exam/api/import/commit', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ bankId, questions: generated.body.questions, batchId: committed.body.batchId }),
      });
      assert.equal(replayed.status, 200);
      assert.equal(replayed.body.replayed, true);
      assert.equal(replayed.body.count, 2);
      const afterReplay = await fetchJson(base, `/exam/api/banks/${bankId}/questions`);
      assert.equal(afterReplay.body.questions.length, 2, '批次重放零写入');

      // 原子失败（t5）：第 2 题 stem 全空白（败在服务校验）→ 400 + **整批回滚零残留**
      //（行为变更：不再"部分成功"，批次行不存在 → 客户端重试整批重跑）。
      const partial = await fetchJson(base, '/exam/api/import/commit', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({
          bankId,
          questions: [generated.body.questions[0], { type: 'single', stem: '   ', options: ['A. 甲'], answer: 'A' }],
        }),
      });
      assert.equal(partial.status, 400);
      assert.equal(partial.body.error.code, 'EXAM_INVALID_QUESTION');
      const afterAtomic = await fetchJson(base, `/exam/api/banks/${bankId}/questions`);
      assert.equal(afterAtomic.body.questions.length, 2, '原子失败整批回滚，无半批残留');
    },
    { llm: DEFAULT_ROUTE, examLlm },
  );
});

test('Phase2 学情：insights 聚合正确性 + diagnose（fake llm）', async () => {
  const diagnosisJson = JSON.stringify({
    summary: '整体处于中等水平，单选失分较多。',
    weaknesses: ['single'],
    suggestions: ['加强单选专项训练'],
  });
  const examLlm = llmResponding((system) => (system?.includes('学情分析') ? diagnosisJson : ''));
  await withServer(
    async (base) => {
      // 空数据 → 全零摘要（近 7 天含空档日）
      const emptyInsight = (await fetchJson(base, '/exam/api/insights')).body.insight;
      assert.equal(emptyInsight.totalAttempts, 0);
      assert.equal(emptyInsight.correctAttempts, 0);
      assert.equal(emptyInsight.accuracy, 0);
      assert.equal(emptyInsight.daily.length, 7);
      assert.equal(emptyInsight.finishedPractices, 0);

      // 造数据：1 对 1 错（同题库两题）
      const { bankId, question: q1 } = await mkBankAndQuestion(base, '学情题库', {
        type: 'single',
        stem: '选 A',
        options: ['A. 甲', 'B. 乙'],
        answer: 'A',
      });
      const q2 = await mkQuestion(base, bankId, {
        type: 'single',
        stem: '选 B',
        options: ['A. 甲', 'B. 乙'],
        answer: 'B',
      });
      const practice = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;
      await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: q1.id, answer: 'A' }),
      });
      await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: q2.id, answer: 'A' }),
      });

      const insight = (await fetchJson(base, '/exam/api/insights')).body.insight;
      assert.equal(insight.totalAttempts, 2);
      assert.equal(insight.correctAttempts, 1);
      assert.equal(insight.accuracy, 0.5);
      assert.equal(insight.wrongTop.length, 1);
      assert.equal(insight.wrongTop[0].questionId, q2.id);
      // t13 相对判定：single 样本 2 < 3 → 不判定薄弱（样本门槛）
      assert.deepEqual(insight.weakTypes, []);
      assert.equal(insight.byType.single.answered, 2);

      // diagnose（LLM）：结构化建议（字符串条目兼容）+ 持久化记录（t13）
      const diag = await fetchJson(base, '/exam/api/insights/diagnose', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({}),
      });
      assert.equal(diag.status, 200);
      assert.equal(diag.body.diagnosis.summary, '整体处于中等水平，单选失分较多。');
      assert.deepEqual(diag.body.diagnosis.weaknesses, ['single']);
      assert.deepEqual(diag.body.diagnosis.suggestions, [{ text: '加强单选专项训练' }]);
      assert.ok(typeof diag.body.diagnosis.id === 'string' && diag.body.diagnosis.id.length > 0);

      // 诊断历史（t13）：GET 列表含刚落库的一条
      const diagList = await fetchJson(base, '/exam/api/insights/diagnoses');
      assert.equal(diagList.status, 200);
      assert.equal(diagList.body.diagnoses.length, 1);
      assert.equal(diagList.body.diagnoses[0].id, diag.body.diagnosis.id);
    },
    { llm: DEFAULT_ROUTE, examLlm },
  );
});

test('Phase2 学习计划：generate 落库 / 手动新建 / 追加 / 完成 / 列表 / 404', async () => {
  const planJson = JSON.stringify([{ title: '复习错题' }, { title: '专项训练', note: '每天 20 分钟' }]);
  const examLlm = llmResponding((system) => (system?.includes('学习规划') ? planJson : ''));
  await withServer(
    async (base) => {
      // LLM 生成并落库
      const generated = await fetchJson(base, '/exam/api/plans/generate', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ title: '我的复习计划' }),
      });
      assert.equal(generated.status, 201);
      assert.equal(generated.body.plan.source, 'llm');
      assert.equal(generated.body.plan.title, '我的复习计划');
      assert.equal(generated.body.items.length, 2);
      assert.equal(generated.body.items[0].title, '复习错题');
      assert.equal(generated.body.items[0].status, 'pending');
      const planId = generated.body.plan.id;
      const itemId = generated.body.items[0].id;

      // 手动新建
      const manual = await fetchJson(base, '/exam/api/plans', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ title: '手动计划', items: ['背单词'] }),
      });
      assert.equal(manual.status, 201);
      assert.equal(manual.body.plan.source, 'manual');
      assert.equal(manual.body.items.length, 1);

      // 列表（created_at DESC）
      const plans = (await fetchJson(base, '/exam/api/plans')).body.plans;
      assert.equal(plans.length, 2);
      assert.equal(plans[0].source, 'manual', '最新创建在前');

      // 追加条目
      const added = await fetchJson(base, `/exam/api/plans/${planId}/items`, {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ titles: ['真题演练'] }),
      });
      assert.equal(added.status, 201);
      assert.equal(added.body.items.length, 3);

      // 完成条目
      const done = await fetchJson(base, `/exam/api/plans/${planId}/items/${itemId}`, {
        method: 'PATCH',
        headers: POST_JSON,
        body: JSON.stringify({ done: true }),
      });
      assert.equal(done.status, 200);
      assert.equal(done.body.item.status, 'done');
      assert.ok(done.body.item.completedAt !== null);

      // 单计划详情
      const one = await fetchJson(base, `/exam/api/plans/${planId}`);
      assert.equal(one.status, 200);
      assert.equal(one.body.items.length, 3);
      assert.equal(one.body.items.find((i: any) => i.id === itemId).status, 'done');

      // 404：计划 / 条目
      const noPlan = await fetchJson(base, '/exam/api/plans/ghost');
      assert.equal(noPlan.status, 404);
      assert.equal(noPlan.body.error.code, 'EXAM_PLAN_NOT_FOUND');
      const noItem = await fetchJson(base, `/exam/api/plans/${planId}/items/ghost`, {
        method: 'PATCH',
        headers: POST_JSON,
        body: JSON.stringify({ done: true }),
      });
      assert.equal(noItem.status, 404);
      assert.equal(noItem.body.error.code, 'EXAM_PLAN_ITEM_NOT_FOUND');

      // 空 titles → 400
      const emptyTitles = await fetchJson(base, `/exam/api/plans/${planId}/items`, {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ titles: [] }),
      });
      assert.equal(emptyTitles.status, 400);
      assert.equal(emptyTitles.body.error.code, 'EXAM_INVALID_BODY');

      // t13：删除单条条目 → 204 → 详情少一条；删除计划 → 204 → 列表/详情 404
      const delItem = await fetchJson(base, `/exam/api/plans/${planId}/items/${itemId}`, { method: 'DELETE' });
      assert.equal(delItem.status, 204);
      const afterItemDel = await fetchJson(base, `/exam/api/plans/${planId}`);
      assert.equal(afterItemDel.status, 200);
      assert.equal(afterItemDel.body.items.length, 2);

      const delPlan = await fetchJson(base, `/exam/api/plans/${planId}`, { method: 'DELETE' });
      assert.equal(delPlan.status, 204);
      const afterPlanDel = await fetchJson(base, `/exam/api/plans/${planId}`);
      assert.equal(afterPlanDel.status, 404);
      assert.equal(afterPlanDel.body.error.code, 'EXAM_PLAN_NOT_FOUND');
      const repeatDel = await fetchJson(base, `/exam/api/plans/${planId}`, { method: 'DELETE' });
      assert.equal(repeatDel.status, 404);

      // t13：window 非法 → 400；合法窗口 → 200 且回显 windowDays
      const badWindow = await fetchJson(base, '/exam/api/insights?window=10');
      assert.equal(badWindow.status, 400);
      const goodWindow = await fetchJson(base, '/exam/api/insights?window=30');
      assert.equal(goodWindow.status, 200);
      assert.equal(goodWindow.body.insight.windowDays, 30);
      assert.equal(goodWindow.body.insight.daily.length, 30);
    },
    { llm: DEFAULT_ROUTE, examLlm },
  );
});

test('t12 计划状态自动机（HTTP）：条目全 done → GET plans status=completed；回退 → active', async () => {
  await withServer(async (base) => {
    // 手动计划：两条条目
    const created = await fetchJson(base, '/exam/api/plans', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ title: '自动机计划', items: ['复习 A', '复习 B'] }),
    });
    assert.equal(created.status, 201);
    const planId = created.body.plan.id;
    const createdItems = created.body.items as Array<{ id: string }>;
    const itemA = createdItems[0]!;
    const itemB = createdItems[1]!;

    const planStatus = async (): Promise<string> => {
      const plans = (await fetchJson(base, '/exam/api/plans')).body.plans;
      const found = plans.find((p: any) => p.id === planId);
      assert.ok(found, '计划应在列表中');
      return found.status;
    };

    // 初始 active；完成 1/2 → 仍 active
    assert.equal(await planStatus(), 'active');
    const doneA = await fetchJson(base, `/exam/api/plans/${planId}/items/${itemA.id}`, {
      method: 'PATCH',
      headers: POST_JSON,
      body: JSON.stringify({ done: true }),
    });
    assert.equal(doneA.status, 200);
    assert.equal(await planStatus(), 'active', '存在 pending 时保持 active');

    // 完成 2/2 → completed
    const doneB = await fetchJson(base, `/exam/api/plans/${planId}/items/${itemB.id}`, {
      method: 'PATCH',
      headers: POST_JSON,
      body: JSON.stringify({ done: true }),
    });
    assert.equal(doneB.status, 200);
    assert.equal(await planStatus(), 'completed', '全 done → completed');

    // 单计划详情同样反映 completed
    const one = await fetchJson(base, `/exam/api/plans/${planId}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.plan.status, 'completed');

    // 回退一项 → active
    const unDone = await fetchJson(base, `/exam/api/plans/${planId}/items/${itemA.id}`, {
      method: 'PATCH',
      headers: POST_JSON,
      body: JSON.stringify({ done: false }),
    });
    assert.equal(unDone.status, 200);
    assert.equal(unDone.body.item.status, 'pending');
    assert.equal(await planStatus(), 'active', '存在 pending → active');
  });
});

test('Phase2 练习历史：active 附 answeredCount / finished 附 scorecard', async () => {
  await withServer(async (base) => {
    const { bankId, question: q1 } = await mkBankAndQuestion(base, '历史题库', {
      type: 'single',
      stem: '选 A',
      options: ['A. 甲', 'B. 乙'],
      answer: 'A',
    });
    const q2 = await mkQuestion(base, bankId, {
      type: 'single',
      stem: '选 B',
      options: ['A. 甲', 'B. 乙'],
      answer: 'B',
    });

    // active 会话：作答 1 题不 finish
    const active = (
      await fetchJson(base, '/exam/api/practice/start', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
      })
    ).body.practice;
    await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ practiceId: active.id, questionId: q1.id, answer: 'A' }),
    });

    // finished 会话（两题都答）
    const finished = (
      await fetchJson(base, '/exam/api/practice/start', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
      })
    ).body.practice;
    await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ practiceId: finished.id, questionId: q1.id, answer: 'A' }),
    });
    await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ practiceId: finished.id, questionId: q2.id, answer: 'B' }),
    });
    await fetchJson(base, `/exam/api/practice/${finished.id}/finish`, { method: 'POST' });

    const history = (await fetchJson(base, '/exam/api/practice/history')).body.sessions;
    assert.equal(history.length, 2);
    const activeItem = history.find((s: any) => s.practice.id === active.id);
    assert.equal(activeItem.practice.status, 'active');
    assert.equal(activeItem.answeredCount, 1);
    assert.equal(activeItem.scorecard, undefined, 'active 会话不带 scorecard');
    const finishedItem = history.find((s: any) => s.practice.id === finished.id);
    assert.equal(finishedItem.practice.status, 'finished');
    assert.equal(finishedItem.answeredCount, 2);
    assert.equal(finishedItem.scorecard.total, 2);
    assert.equal(finishedItem.scorecard.answered, 2);
    assert.equal(finishedItem.scorecard.correct, 2);
  });
});

test('Phase4.3 计数修复：历史 answeredCount 按题去重且含 essay；grading 查询 200/404', async () => {
  const gradingJson = JSON.stringify({
    score: 85,
    verdict: 'correct',
    feedback: '结构清晰。',
    reference: '要点一',
  });
  const examLlm = llmResponding((system) => (system?.includes('批改教师') ? gradingJson : ''));
  await withServer(
    async (base) => {
      const { bankId, question: q1 } = await mkBankAndQuestion(base, '计数修复题库', {
        type: 'single',
        stem: '选 A',
        options: ['A. 甲', 'B. 乙'],
        answer: 'A',
      });
      const essay = await mkQuestion(base, bankId, {
        type: 'essay',
        stem: '简述 TCP 三次握手。',
        options: [],
        answer: null,
      });
      const practice = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;

      // 同题判两次（同答案重答）→ answeredCount 按题去重仍计 1，latest 仍是正确
      await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: q1.id, answer: 'A' }),
      });
      await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: q1.id, answer: 'A' }),
      });

      // essay 批改（SSE 成功）→ 计数应计入
      const { events } = await readSse(base, '/exam/api/grading/essay', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ questionId: essay.id, practiceId: practice.id, userAnswer: '客户端先发 SYN…' }),
      });
      const done = events[events.length - 1];
      assert.equal(done.type, 'done');
      const attemptId: string = done.result.attemptId;
      assert.equal(done.result.grading.isCorrect, true);

      const history = (await fetchJson(base, '/exam/api/practice/history')).body.sessions;
      const item = history.find((s: any) => s.practice.id === practice.id);
      assert.equal(item.answeredCount, 2, '按题去重（q1 两次判分仅 1）+ essay 计入');

      await fetchJson(base, `/exam/api/practice/${practice.id}/finish`, { method: 'POST' });
      const sc = (await fetchJson(base, `/exam/api/practice/${practice.id}/scorecard`)).body.scorecard;
      assert.equal(sc.answered, 2, 'scorecard 与 history 口径一致');
      assert.equal(sc.correct, 2);

      // GET /exam/api/grading/:attemptId（练习内回看数据源）
      const found = await fetchJson(base, `/exam/api/grading/${attemptId}`);
      assert.equal(found.status, 200);
      assert.equal(found.body.grading.attemptId, attemptId);
      assert.equal(found.body.grading.feedback, '结构清晰。');
      const missing = await fetchJson(base, '/exam/api/grading/ghost-attempt');
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.code, 'EXAM_ESSAY_GRADING_NOT_FOUND');
    },
    { llm: DEFAULT_ROUTE, examLlm },
  );
});

/**
 * Phase2 SSE 断开中止回归（t6 修复）：客户端 abort 后，底层 LLM 调用必须收到
 * 已中止的 signal（t5 实证缺陷：断开后 fake llm 继续跑完）。
 * 流式请求：读取首个 chunk 后 abort，轮询底层 signal 是否被中止。
 */
async function sseAbortObserves(base: string, path: string, body: unknown): Promise<boolean> {
  const controller = new AbortController();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: POST_JSON,
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  await reader.read(); // 首个 data 块（delta）
  controller.abort();
  try {
    await reader.read();
  } catch {
    // 读取随 abort 失败是预期行为
  }
  // 等待服务端把 abort 传播到底层 LLM（上限 3s）
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (observedLlmSignal?.aborted === true) return true;
  }
  return observedLlmSignal?.aborted === true;
}

/** 最近一次底层 stream 收到的合并 signal（测试观测点）。 */
let observedLlmSignal: AbortSignal | undefined;

/** fake llm：yield 一个 delta 后阻塞等待 signal 中止（3s 上限），用于断开回归。 */
function llmBlockingUntilAbort(): ExamLlm {
  return createExamLlm(
    createFakeLlmService(async function* (options) {
      observedLlmSignal = options.signal;
      yield textDelta('x');
      const deadline = Date.now() + 3000;
      while (observedLlmSignal?.aborted !== true && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (observedLlmSignal?.aborted !== true) {
        throw new Error('fake llm: signal was not aborted within 3s');
      }
      yield finishStop();
    }),
  );
}

test('Phase2 SSE 断开中止：grading/essay 与 tutor/chat 客户端 abort 后底层 LLM signal 中止', async () => {
  // ── grading/essay ──
  const gradingExamLlm = llmBlockingUntilAbort();
  await withServer(
    async (base) => {
      const { bankId, question } = await mkBankAndQuestion(base, '断开题库', {
        type: 'essay',
        stem: '简答：什么是抽象类？',
        options: [],
        answer: null,
      });
      const practice = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;
      const aborted = await sseAbortObserves(base, '/exam/api/grading/essay', {
        questionId: question.id,
        practiceId: practice.id,
        userAnswer: '抽象类是……',
      });
      assert.equal(aborted, true, 'grading/essay：客户端断开后底层 LLM signal 应被中止');
    },
    { llm: DEFAULT_ROUTE, examLlm: gradingExamLlm },
  );

  // ── tutor/chat ──
  observedLlmSignal = undefined;
  const tutorExamLlm = llmBlockingUntilAbort();
  await withServer(
    async (base) => {
      const aborted = await sseAbortObserves(base, '/exam/api/tutor/chat', {
        message: '给我讲讲多态',
      });
      assert.equal(aborted, true, 'tutor/chat：客户端断开后底层 LLM signal 应被中止');
    },
    { llm: DEFAULT_ROUTE, examLlm: tutorExamLlm },
  );
});

// ---------------------------------------------------------------------------
// Phase 4：练习内 AI 解析（P 个性化 SSE / G 通用写回）
// ---------------------------------------------------------------------------

/**
 * Phase 4 fake llm：按 system 提示词路由响应——
 * - 含「批改教师」→ gradingJson（essay 批改链路复用）；
 * - 含「你的作答分析」（EXPLAIN_SYSTEM 特征）→ personalized(callIndex)，计数；
 * - 含「辅导老师」（EXPLAIN_SYSTEM_GENERIC）→ generic(callIndex)，计数；
 * - 其余 → 空回复（finishStop）。
 * 整段文本拆两个 text-delta（验证流式透传），与既有 llmResponding 同构。
 */
function phase4Llm(opts: {
  gradingJson?: string;
  personalized?: (callIndex: number) => string;
  generic?: (callIndex: number) => string;
}): { llm: ExamLlm; calls: { personalized: number; generic: number } } {
  const calls = { personalized: 0, generic: 0 };
  const llm = createExamLlm(
    createFakeLlmService(async function* (options) {
      const systemMessage = options.messages.find((m) => m.role === 'system');
      const systemText =
        options.system ??
        (systemMessage?.content?.find((b) => b.type === 'text')?.text as string | undefined);
      let text = '';
      if (systemText?.includes('批改教师')) {
        text = opts.gradingJson ?? '';
      } else if (systemText?.includes('你的作答分析')) {
        text = opts.personalized === undefined ? '' : opts.personalized(calls.personalized++);
      } else if (systemText?.includes('辅导老师')) {
        text = opts.generic === undefined ? '' : opts.generic(calls.generic++);
      }
      if (text.length === 0) {
        yield finishStop();
        return;
      }
      const mid = Math.floor(text.length / 2);
      yield textDelta(text.slice(0, mid));
      yield textDelta(text.slice(mid));
      yield finishStop();
    }),
  );
  return { llm, calls };
}

/** Phase 4 SSE 流式请求快捷体（POST JSON，期望 SSE 成功流时用）。 */
function postExplain(base: string, body: unknown, init?: RequestInit): Promise<{ status: number; events: any[] }> {
  return readSse(base, '/exam/api/practice/explain', {
    method: 'POST',
    headers: POST_JSON,
    body: JSON.stringify(body),
    ...init,
  });
}

/** Phase 4 流前校验断言用（期望 JSON 错误响应：400/404/409/503，流未开始）。 */
function postExplainJson(base: string, body: unknown): Promise<{ status: number; body: any }> {
  return fetchJson(base, '/exam/api/practice/explain', {
    method: 'POST',
    headers: POST_JSON,
    body: JSON.stringify(body),
  });
}

test('Phase4 P 形态 SSE 全链路：delta→done→落库；缓存命中零 LLM；GET 探测两态；force 重新解析覆盖单份最新', async () => {
  const V1 = '【正确答案解析】第一版个性化解析内容，针对学生的错误作答展开。';
  const V2 = '【正确答案解析】第二版重新生成的解析，覆盖旧内容为单份最新。';
  const { llm, calls } = phase4Llm({
    personalized: (n) => (n === 0 ? V1 : V2),
  });
  await withServer(
    async (base) => {
      const { bankId, question } = await mkBankAndQuestion(base, '解析题库', {
        type: 'single',
        stem: '地球绕太阳公转周期是？',
        options: ['一天', '一年'],
        answer: '1',
      });
      const practice = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;
      // 判分（答错）——防泄露硬边界的前置。
      await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: question.id, answer: '0' }),
      });

      // 未命中缓存：缓存探测 404 → 生成路径 SSE delta* → done(cached:false) 落库。
      const missProbe = await fetchJson(
        base,
        `/exam/api/practice/explain?practiceId=${encodeURIComponent(practice.id)}&questionId=${encodeURIComponent(question.id)}`,
      );
      assert.equal(missProbe.status, 404);
      assert.equal(missProbe.body.error.code, 'EXAM_EXPLANATION_NOT_FOUND');

      const first = await postExplain(base, { practiceId: practice.id, questionId: question.id });
      assert.equal(first.status, 200);
      const firstDeltas = first.events.filter((e) => e.type === 'delta');
      assert.equal(firstDeltas.length, 2, 'fake llm 拆两个 delta');
      assert.deepEqual(
        firstDeltas.map((e) => e.text).join(''),
        V1,
        'delta 原文透传',
      );
      const done1 = first.events.find((e) => e.type === 'done');
      assert.ok(done1, '应有 done 事件');
      assert.equal(done1.result.cached, false);
      assert.ok(typeof done1.result.explanationId === 'string' && done1.result.explanationId.length > 0);
      assert.equal(done1.result.content, V1);
      assert.equal(done1.result.model, 'deepseek-chat');
      assert.equal(calls.personalized, 1);

      // 二次调用（非 force）：命中缓存直接 done(cached:true)，零 delta、零 LLM 调用。
      const cached = await postExplain(base, { practiceId: practice.id, questionId: question.id });
      assert.equal(cached.events.length, 1, '缓存命中零 delta');
      assert.equal(cached.events[0].type, 'done');
      assert.equal(cached.events[0].result.cached, true);
      assert.equal(cached.events[0].result.content, V1);
      assert.equal(cached.events[0].result.explanationId, undefined, 'cached=true 无 explanationId');
      assert.equal(calls.personalized, 1, '缓存命中不得调用 LLM');

      // GET 探测命中：200 { explanation }。
      const hitProbe = await fetchJson(
        base,
        `/exam/api/practice/explain?practiceId=${encodeURIComponent(practice.id)}&questionId=${encodeURIComponent(question.id)}`,
      );
      assert.equal(hitProbe.status, 200);
      assert.equal(hitProbe.body.explanation.content, V1);
      assert.equal(hitProbe.body.explanation.model, 'deepseek-chat');
      assert.equal(typeof hitProbe.body.explanation.createdAt, 'number');

      // force 重新解析：跳过缓存直调 LLM，覆盖同键旧行（单份最新，id 刷新）。
      const forced = await postExplain(base, {
        practiceId: practice.id,
        questionId: question.id,
        force: true,
      });
      const doneF = forced.events.find((e) => e.type === 'done');
      assert.ok(doneF);
      assert.equal(doneF.result.cached, false);
      assert.equal(doneF.result.content, V2);
      assert.notEqual(doneF.result.explanationId, done1.result.explanationId, 'INSERT OR REPLACE 换新行 id');
      assert.equal(calls.personalized, 2);

      // 覆盖后：GET 探测与非 force POST 都只见新内容。
      const probe2 = await fetchJson(
        base,
        `/exam/api/practice/explain?practiceId=${encodeURIComponent(practice.id)}&questionId=${encodeURIComponent(question.id)}`,
      );
      assert.equal(probe2.status, 200);
      assert.equal(probe2.body.explanation.content, V2);
      const cached2 = await postExplain(base, { practiceId: practice.id, questionId: question.id });
      assert.equal(cached2.events[0].result.cached, true);
      assert.equal(cached2.events[0].result.content, V2);
      assert.equal(calls.personalized, 2, 'force 后的非 force 调用仍走缓存');
    },
    { llm: DEFAULT_ROUTE, examLlm: llm },
  );
});

test('Phase4 P 形态校验错误矩阵：未判分 409 / essay 400 / 404 族 / 缺字段 400 / 方法 405', async () => {
  const { llm } = phase4Llm({
    gradingJson: JSON.stringify({ score: 80, verdict: 'correct', feedback: '要点完整。' }),
    personalized: () => '不应被调用',
  });
  await withServer(
    async (base) => {
      const { bankId, question: essay } = await mkBankAndQuestion(base, '校验题库', {
        type: 'essay',
        stem: '简述闭包的概念。',
        options: [],
        answer: null,
      });
      const single = await mkQuestion(base, bankId, {
        type: 'single',
        stem: '1+1=?',
        options: ['1', '2'],
        answer: '1',
      });
      const practice = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;
      const explainPath = '/exam/api/practice/explain';
      const probeUrl = (pid: string, qid: string) =>
        `${explainPath}?practiceId=${encodeURIComponent(pid)}&questionId=${encodeURIComponent(qid)}`;

      // 不存在族：practice / question → 404。
      const noPractice = await postExplainJson(base, { practiceId: 'nope', questionId: single.id });
      assert.equal(noPractice.status, 404);
      assert.equal(noPractice.body.error.code, 'EXAM_PRACTICE_NOT_FOUND');
      const noQuestion = await postExplainJson(base, { practiceId: practice.id, questionId: 'nope' });
      assert.equal(noQuestion.status, 404);
      assert.equal(noQuestion.body.error.code, 'EXAM_QUESTION_NOT_FOUND');

      // 会话开始后追加的题不在题单内 → EXAM_QUESTION_NOT_IN_PRACTICE。
      const late = await mkQuestion(base, bankId, {
        type: 'single',
        stem: '晚到题',
        options: ['a', 'b'],
        answer: '0',
      });
      const notIn = await postExplainJson(base, { practiceId: practice.id, questionId: late.id });
      assert.equal(notIn.status, 400); // 既有词汇表：NOT_IN_PRACTICE 属 400 组（Phase 1 起约定，零回归不动）
      assert.equal(notIn.body.error.code, 'EXAM_QUESTION_NOT_IN_PRACTICE');

      // 未判分 → 409 EXAM_NOT_GRADED（防泄露硬边界；POST 与 GET 探测同链）。
      const notGraded = await postExplainJson(base, { practiceId: practice.id, questionId: single.id });
      assert.equal(notGraded.status, 409);
      assert.equal(notGraded.body.error.code, 'EXAM_NOT_GRADED');
      const probeNotGraded = await fetchJson(base, probeUrl(practice.id, single.id));
      assert.equal(probeNotGraded.status, 409);
      assert.equal(probeNotGraded.body.error.code, 'EXAM_NOT_GRADED');

      // 缺字段 / 非法体 → 400 EXAM_INVALID_BODY。
      const missing = await postExplainJson(base, { practiceId: practice.id });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error.code, 'EXAM_INVALID_BODY');
      const badProbe = await fetchJson(base, `${explainPath}?questionId=${single.id}`);
      assert.equal(badProbe.status, 400);
      assert.equal(badProbe.body.error.code, 'EXAM_INVALID_BODY');

      // 方法不允许：PUT → 405（Allow: GET, POST）。
      const wrongMethod = await fetchJson(base, explainPath, { method: 'PUT' });
      assert.equal(wrongMethod.status, 405);

      // essay 题：先经批改接口产生 attempt（通过 409 关），再解析 → 400
      // EXAM_INVALID_QUESTION（校验链顺序：attempt 检查在 essay 拒绝之前）。
      const gradedEssay = await postExplainJson(base, { practiceId: practice.id, questionId: essay.id });
      assert.equal(gradedEssay.status, 409, 'essay 未批改时同样先撞 409 边界');
      const grading = await readSse(base, '/exam/api/grading/essay', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({
          questionId: essay.id,
          practiceId: practice.id,
          userAnswer: '闭包是函数与其词法环境的组合。',
        }),
      });
      const gradingDone = grading.events.find((e) => e.type === 'done');
      assert.ok(gradingDone, 'essay 批改应成功');
      const essayExplain = await postExplainJson(base, { practiceId: practice.id, questionId: essay.id });
      assert.equal(essayExplain.status, 400);
      assert.equal(essayExplain.body.error.code, 'EXAM_INVALID_QUESTION');
      const essayProbe = await fetchJson(base, probeUrl(practice.id, essay.id));
      assert.equal(essayProbe.status, 400);

      // 单选已判分但无缓存 + 无 provider 的场景在「503」用例覆盖；
      // 这里最后确认 single 判分后 GET 探测仍是 404（有 attempt、无缓存行）。
      await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: single.id, answer: '1' }),
      });
      const probeUncached = await fetchJson(base, probeUrl(practice.id, single.id));
      assert.equal(probeUncached.status, 404);
      assert.equal(probeUncached.body.error.code, 'EXAM_EXPLANATION_NOT_FOUND');
      void bankId;
    },
    { llm: DEFAULT_ROUTE, examLlm: llm },
  );
});

test('Phase4 provider 未配置：P 未命中缓存 → 503 EXAM_LLM_NO_PROVIDER（JSON，流未开始）；G 形态 → 503', async () => {
  const { llm, calls } = phase4Llm({ personalized: () => '不应被调用', generic: () => '不应被调用' });
  await withServer(
    async (base) => {
      const { bankId, question } = await mkBankAndQuestion(base, '无路由题库', {
        type: 'single',
        stem: '选择：2+2=?',
        options: ['3', '4'],
        answer: '1',
      });
      const practice = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;
      await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: question.id, answer: '1' }),
      });

      // P 形态：已判分但缓存未命中，且注册表无可用 provider → 流前 503 JSON。
      const noRoute = await postExplainJson(base, { practiceId: practice.id, questionId: question.id });
      assert.equal(noRoute.status, 503);
      assert.equal(noRoute.body.error.code, 'EXAM_LLM_NO_PROVIDER');
      assert.equal(calls.personalized, 0);

      // G 形态：同样无可用路由 → 503（服务层 requireLlmRoute；llm 已接线故为
      // EXAM_LLM_UNAVAILABLE——provider/model 缺省解析失败语义）。
      const gNoRoute = await fetchJson(base, `/exam/api/questions/${question.id}/explain-generic`, {
        method: 'POST',
        headers: POST_JSON,
        body: '{}',
      });
      assert.equal(gNoRoute.status, 503);
      assert.equal(calls.generic, 0);
      void bankId;
    },
    // 注意：examLlm 接线（ai 门面存在）但 LlmRoute 注册表为空。
    { llm: { listProviders: () => [], listModels: async () => [] }, examLlm: llm },
  );
});

test('Phase4 取消零落库：非 force abort 后 GET 404；force abort 后旧内容原样保留', async () => {
  const V1 = '【正确答案解析】第一版已落库的安全内容。';

  // ── 场景 A：首次生成即取消 → 零写入（GET 探测 404）──
  let observedA: AbortSignal | undefined;
  const blockingLlm = createExamLlm(
    createFakeLlmService(async function* (options) {
      observedA = options.signal;
      yield textDelta('部分内容');
      const deadline = Date.now() + 3000;
      while (observedA?.aborted !== true && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (observedA?.aborted !== true) throw new Error('fake llm: signal was not aborted within 3s');
      yield finishStop();
    }),
  );
  await withServer(
    async (base) => {
      const { bankId, question } = await mkBankAndQuestion(base, '取消题库A', {
        type: 'single',
        stem: '取消场景题',
        options: ['甲', '乙'],
        answer: '0',
      });
      const practice = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;
      await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: question.id, answer: '1' }),
      });
      const aborted = await sseAbortObserves(base, '/exam/api/practice/explain', {
        practiceId: practice.id,
        questionId: question.id,
      });
      assert.equal(aborted, true, 'practice/explain：客户端断开后底层 LLM signal 应被中止');
      const probe = await fetchJson(
        base,
        `/exam/api/practice/explain?practiceId=${encodeURIComponent(practice.id)}&questionId=${encodeURIComponent(question.id)}`,
      );
      assert.equal(probe.status, 404, '取消后零落库：缓存探测仍 404');
      assert.equal(probe.body.error.code, 'EXAM_EXPLANATION_NOT_FOUND');
    },
    { llm: DEFAULT_ROUTE, examLlm: blockingLlm },
  );

  // ── 场景 B：已有 v1 落库，force 重新解析中途取消 → 旧行原样保留 ──
  let observedB: AbortSignal | undefined;
  let callB = 0;
  const firstThenBlockingLlm = createExamLlm(
    createFakeLlmService(async function* (options) {
      callB += 1;
      if (callB === 1) {
        const mid = Math.floor(V1.length / 2);
        yield textDelta(V1.slice(0, mid));
        yield textDelta(V1.slice(mid));
        yield finishStop();
        return;
      }
      observedB = options.signal;
      yield textDelta('重新生成的半截');
      const deadline = Date.now() + 3000;
      while (observedB?.aborted !== true && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (observedB?.aborted !== true) throw new Error('fake llm: signal was not aborted within 3s');
      yield finishStop();
    }),
  );
  await withServer(
    async (base) => {
      const { bankId, question } = await mkBankAndQuestion(base, '取消题库B', {
        type: 'single',
        stem: 'force 取消场景题',
        options: ['甲', '乙'],
        answer: '0',
      });
      const practice = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;
      await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: question.id, answer: '1' }),
      });
      // 先完整生成 v1。
      const first = await postExplain(base, { practiceId: practice.id, questionId: question.id });
      const done1 = first.events.find((e) => e.type === 'done');
      assert.ok(done1 && done1.result.cached === false);
      // force 重新解析 → 中途断开。
      const aborted = await sseAbortObserves(base, '/exam/api/practice/explain', {
        practiceId: practice.id,
        questionId: question.id,
        force: true,
      });
      assert.equal(aborted, true, 'force 重新解析断开应中止底层调用');
      // 旧内容原样保留（取消的重新解析零写入）。
      const probe = await fetchJson(
        base,
        `/exam/api/practice/explain?practiceId=${encodeURIComponent(practice.id)}&questionId=${encodeURIComponent(question.id)}`,
      );
      assert.equal(probe.status, 200);
      assert.equal(probe.body.explanation.content, V1, 'force 取消后旧内容不动');
      assert.equal(callB, 2);
    },
    { llm: DEFAULT_ROUTE, examLlm: firstThenBlockingLlm },
  );
});

test('Phase4 answer_norm 多选顺序无关：[C,A] 与 [A,C] 同键命中；不同集合为新键', async () => {
  const P1 = '【正确答案解析】多选题第一版：逐项说明 A 与 C 为何正确。';
  const P2 = '【正确答案解析】换键后的新解析：针对 [A,B] 的作答。';
  const { llm, calls } = phase4Llm({
    personalized: (n) => (n === 0 ? P1 : P2),
  });
  await withServer(
    async (base) => {
      const { bankId, question } = await mkBankAndQuestion(base, '多选解析题库', {
        type: 'multiple',
        stem: '下列哪些是哺乳动物？',
        options: ['鲸鱼', '鲨鱼', '蝙蝠', '鳄鱼'],
        answer: ['A', 'C'],
      });
      const practice = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;
      const grade = (answer: string[]) =>
        fetchJson(base, '/exam/api/quiz/grade', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ practiceId: practice.id, questionId: question.id, answer }),
        });

      // 第一次作答乱序 ['C','A'] → 生成 P1。
      await grade(['C', 'A']);
      const first = await postExplain(base, { practiceId: practice.id, questionId: question.id });
      const done1 = first.events.find((e) => e.type === 'done');
      assert.ok(done1 && done1.result.cached === false && done1.result.content === P1);

      // 重做同集合不同顺序 ['A','C'] → 同一 norm 键 → 命中缓存（顺序无关）。
      await grade(['A', 'C']);
      const hit = await postExplain(base, { practiceId: practice.id, questionId: question.id });
      const doneHit = hit.events.find((e) => e.type === 'done');
      assert.ok(doneHit, '应有 done');
      assert.equal(doneHit.result.cached, true, '顺序不同的同集合必须命中同一缓存键');
      assert.equal(doneHit.result.content, P1);
      assert.equal(calls.personalized, 1);

      // 换集合 ['A','B'] → 新键 → 再次生成。
      await grade(['A', 'B']);
      const second = await postExplain(base, { practiceId: practice.id, questionId: question.id });
      const done2 = second.events.find((e) => e.type === 'done');
      assert.ok(done2 && done2.result.cached === false && done2.result.content === P2);
      assert.equal(calls.personalized, 2);
    },
    { llm: DEFAULT_ROUTE, examLlm: llm },
  );
});

test('Phase4 G 形态：空体请求写回 explanation → GET questions 可见；重复调用覆盖；essay 400；404', async () => {
  const G1 = '【正确答案解析】通用解析第一版。';
  const G2 = '【正确答案解析】通用解析第二版（重新生成覆盖）。';
  const { llm, calls } = phase4Llm({
    generic: (n) => (n === 0 ? G1 : G2),
    gradingJson: JSON.stringify({ score: 70, verdict: 'correct', feedback: '尚可。' }),
  });
  await withServer(
    async (base) => {
      const { bankId, question } = await mkBankAndQuestion(base, 'G 形态题库', {
        type: 'single',
        stem: '光速约为？',
        options: ['30 万 km/s', '60 万 km/s'],
        answer: '0',
      });
      const essay = await mkQuestion(base, bankId, {
        type: 'essay',
        stem: '论述：光的波粒二象性。',
        options: [],
        answer: null,
      });

      // 空请求体合法（provider/model 可选）→ 生成并写回。
      const first = await fetchJson(base, `/exam/api/questions/${question.id}/explain-generic`, {
        method: 'POST',
        headers: POST_JSON,
      });
      assert.equal(first.status, 200);
      assert.equal(first.body.question.explanation, G1);
      assert.equal(first.body.question.updatedAt >= first.body.question.createdAt, true);
      assert.equal(calls.generic, 1);

      // 经题目列表接口可见（持久化生效，非内存态）。
      const listed = await fetchJson(base, `/exam/api/banks/${bankId}/questions`);
      const row = listed.body.questions.find((q: any) => q.id === question.id);
      assert.equal(row.explanation, G1);

      // 重复调用 = 「重新解析」覆盖。
      const second = await fetchJson(base, `/exam/api/questions/${question.id}/explain-generic`, {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({}),
      });
      assert.equal(second.status, 200);
      assert.equal(second.body.question.explanation, G2);
      const relisted = await fetchJson(base, `/exam/api/banks/${bankId}/questions`);
      const row2 = relisted.body.questions.find((q: any) => q.id === question.id);
      assert.equal(row2.explanation, G2);
      assert.equal(calls.generic, 2);

      // essay 题 → 400 EXAM_INVALID_QUESTION（与 P 形态一致拒绝）。
      const essayG = await fetchJson(base, `/exam/api/questions/${essay.id}/explain-generic`, {
        method: 'POST',
        headers: POST_JSON,
        body: '{}',
      });
      assert.equal(essayG.status, 400);
      assert.equal(essayG.body.error.code, 'EXAM_INVALID_QUESTION');

      // 题目不存在 → 404。
      const missing = await fetchJson(base, '/exam/api/questions/nope/explain-generic', {
        method: 'POST',
        headers: POST_JSON,
        body: '{}',
      });
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.code, 'EXAM_QUESTION_NOT_FOUND');

      // 子路径不匹配仍走 prefix 兜底 → 404 JSON。
      const stray = await fetchJson(base, `/exam/api/questions/${question.id}/unknown-sub`, { method: 'POST' });
      assert.equal(stray.status, 404);
    },
    { llm: DEFAULT_ROUTE, examLlm: llm },
  );
});

test('Phase4 缓存命中不依赖 LLM 路由解析：provider 撤除后同 store 仍 cached:true', async () => {
  const V1 = '【正确答案解析】先在有 provider 的服务里生成的解析。';
  const { llm, calls } = phase4Llm({ personalized: () => V1 });
  const store = await openExamStore(':memory:');
  const service = createExamService({ store, llm });
  try {
    // 阶段一：带 provider 的路由 —— 判分并生成落库。
    const server1 = fakeWebServer();
    registerExamRoutes(server1 as unknown as WebServer, service, DEFAULT_ROUTE, fakeLogger);
    await new Promise<void>((resolveListen) => server1.listen(0, '127.0.0.1', resolveListen));
    const base1 = `http://127.0.0.1:${(server1.address() as AddressInfo).port}`;
    try {
      const { bankId, question } = await mkBankAndQuestion(base1, '跨路由题库', {
        type: 'single',
        stem: '缓存短路题',
        options: ['x', 'y'],
        answer: '0',
      });
      const practice = (
        await fetchJson(base1, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;
      await fetchJson(base1, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: question.id, answer: '0' }),
      });
      const gen = await postExplain(base1, { practiceId: practice.id, questionId: question.id });
      const doneGen = gen.events.find((e) => e.type === 'done');
      assert.ok(doneGen && doneGen.result.cached === false);
    } finally {
      await new Promise<void>((resolveClose) => server1.close(() => resolveClose()));
    }

    // 阶段二：同一 store/service 换「无任何 provider」的路由 —— 缓存命中
    // 不要求 LLM 路由可解析（命中路径在 requireLlmRoute 之前短路）。
    const server2 = fakeWebServer();
    registerExamRoutes(server2 as unknown as WebServer, service, { listProviders: () => [], listModels: async () => [] }, fakeLogger);
    await new Promise<void>((resolveListen) => server2.listen(0, '127.0.0.1', resolveListen));
    const base2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
    try {
      const history = (await fetchJson(base2, '/exam/api/practice/history')).body.sessions;
      const practiceId = history[0].practice.id;
      const resumed = (await fetchJson(base2, `/exam/api/practice/${practiceId}`)).body;
      const questionId = resumed.latestAttempts[0].questionId;
      const cached = await postExplain(base2, { practiceId, questionId });
      assert.equal(cached.status, 200);
      const done = cached.events.find((e) => e.type === 'done');
      assert.ok(done, '无 provider 时命中缓存也应返回 done（而非 503）');
      assert.equal(done.result.cached, true);
      assert.equal(done.result.content, V1);
      assert.equal(calls.personalized, 1, '全程仅阶段一一次 LLM 调用');
      // force 在无 provider 下必须失败：重新解析绕不开路由解析。
      const forced = await postExplainJson(base2, { practiceId, questionId, force: true });
      assert.equal(forced.status, 503);
    } finally {
      await new Promise<void>((resolveClose) => server2.close(() => resolveClose()));
    }
  } finally {
    service.close();
  }
});

test('Phase4.2 resolveLlmRoute 默认路由链：显式指定 > DSH 默认（含思考深度）> 第一个 provider', async () => {
  const fakeLlm = {
    listProviders: () => [
      { id: 'first-provider', name: 'First' },
      { id: 'default-provider', name: 'Default' },
    ],
    listModels: async (provider: string) =>
      provider === 'default-provider'
        ? [{ provider, id: 'default-model', name: 'Default Model' }]
        : [{ provider, id: 'first-model', name: 'First Model' }],
  } as unknown as LlmRoute;

  // ① 未显式指定 → DSH 默认（provider/model/reasoningEffort 全继承；t5 defaultRouteProvider 每请求调用）
  const r1 = await resolveLlmRoute(fakeLlm, undefined, undefined, () => ({
    provider: 'default-provider',
    model: 'default-model',
    reasoningEffort: 'max',
  }));
  assert.equal(r1.provider, 'default-provider');
  assert.equal(r1.model, 'default-model');
  assert.equal(r1.reasoningEffort, 'max');

  // ② 显式 provider 优先于默认（effort 不继承）
  const r2 = await resolveLlmRoute(fakeLlm, 'first-provider', undefined, () => ({
    provider: 'default-provider',
    model: 'default-model',
    reasoningEffort: 'max',
  }));
  assert.equal(r2.provider, 'first-provider');
  assert.equal(r2.model, 'first-model');
  assert.equal(r2.reasoningEffort, undefined);

  // ③ 无默认路由 → 回退第一个 provider 及其第一个模型（原行为）
  const r3 = await resolveLlmRoute(fakeLlm);
  assert.equal(r3.provider, 'first-provider');
  assert.equal(r3.model, 'first-model');
  assert.equal(r3.reasoningEffort, undefined);

  // ④ 默认 provider 未注册 → 回退第一个 provider（防御）
  const r4 = await resolveLlmRoute(fakeLlm, undefined, undefined, () => ({ provider: 'ghost', model: 'm' }));
  assert.equal(r4.provider, 'first-provider');
  assert.equal(r4.model, 'first-model');
});

// ---------------------------------------------------------------------------
// t1 领域正确性（HTTP 层）：空范围 / finished 守卫 / essay 归属 / 跨会话隔离 / 软删除
// ---------------------------------------------------------------------------

test('t1 空范围 start → 400 EXAM_EMPTY_PRACTICE_SCOPE（不建 active 空会话）', async () => {
  await withServer(async (base) => {
    const { bankId } = await mkBankAndQuestion(base, 't1 空范围题库', {
      type: 'single',
      stem: 's',
      options: ['A'],
      answer: 'A',
    });
    // wrong 模式但错题本为空 → 0 题
    const emptyWrong = await fetchJson(base, '/exam/api/practice/start', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ bankId, scope: { mode: 'wrong' } }),
    });
    assert.equal(emptyWrong.status, 400);
    assert.equal(emptyWrong.body.error.code, 'EXAM_EMPTY_PRACTICE_SCOPE');
    // byType 无匹配题型 → 0 题
    const emptyType = await fetchJson(base, '/exam/api/practice/start', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ bankId, scope: { mode: 'byType', type: 'essay' } }),
    });
    assert.equal(emptyType.status, 400);
    assert.equal(emptyType.body.error.code, 'EXAM_EMPTY_PRACTICE_SCOPE');
    // 历史中无残留空会话
    const history = await fetchJson(base, '/exam/api/practice/history');
    assert.equal(history.body.sessions.length, 0);
  });
});

test('t1 finished 守卫：客观 grade 409 / PATCH currentIndex 409 / essay 批改 409（流前 JSON）', async () => {
  const gradingJson = JSON.stringify({ score: 85, verdict: 'correct', feedback: '结构清晰', reference: '要点' });
  const examLlm = llmResponding((system) => (system?.includes('批改教师') ? gradingJson : ''));
  await withServer(
    async (base) => {
      const bank = await fetchJson(base, '/exam/api/banks', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ name: 't1 finished 题库' }),
      });
      const bankId = bank.body.bank.id;
      const mk = (body: Record<string, unknown>) =>
        fetchJson(base, `/exam/api/banks/${bankId}/questions`, {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify(body),
        });
      const single = (await mk({ type: 'single', stem: '1+1', options: ['1', '2'], answer: '1' })).body.question;
      const essay = (await mk({ type: 'essay', stem: '论述题', options: [], answer: null })).body.question;
      const practice = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;

      // 正常判分 → finish
      await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: single.id, answer: '1' }),
      });
      const finished = await fetchJson(base, `/exam/api/practice/${practice.id}/finish`, { method: 'POST' });
      assert.equal(finished.status, 200);

      // 客观判分 → 409 EXAM_PRACTICE_FINISHED
      const g = await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: single.id, answer: '1' }),
      });
      assert.equal(g.status, 409);
      assert.equal(g.body.error.code, 'EXAM_PRACTICE_FINISHED');
      // PATCH currentIndex → 409
      const p = await fetchJson(base, `/exam/api/practice/${practice.id}`, {
        method: 'PATCH',
        headers: POST_JSON,
        body: JSON.stringify({ currentIndex: 1 }),
      });
      assert.equal(p.status, 409);
      assert.equal(p.body.error.code, 'EXAM_PRACTICE_FINISHED');
      // essay 批改 → 流前 409 JSON（finished 会话禁止继续判分）
      const e = await fetchJson(base, '/exam/api/grading/essay', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ questionId: essay.id, practiceId: practice.id, userAnswer: '我的论述' }),
      });
      assert.equal(e.status, 409);
      assert.equal(e.body.error.code, 'EXAM_PRACTICE_FINISHED');
      // 只读路径不受影响
      const sc = await fetchJson(base, `/exam/api/practice/${practice.id}/scorecard`);
      assert.equal(sc.body.scorecard.answered, 1);
    },
    { llm: DEFAULT_ROUTE, examLlm },
  );
});

test('t1 gradeEssay 归属校验：question 不属于 practice → 400 EXAM_QUESTION_NOT_IN_PRACTICE', async () => {
  const gradingJson = JSON.stringify({ score: 85, verdict: 'correct', feedback: '好' });
  const examLlm = llmResponding((system) => (system?.includes('批改教师') ? gradingJson : ''));
  await withServer(
    async (base) => {
      // 两个独立题库各一道 essay：A 的会话里没有 B 的题
      const { bankId: bankA, question: essayA } = await mkBankAndQuestion(base, 't1 归属 A', {
        type: 'essay',
        stem: 'A 论述',
        options: [],
        answer: null,
      });
      const { question: essayB } = await mkBankAndQuestion(base, 't1 归属 B', {
        type: 'essay',
        stem: 'B 论述',
        options: [],
        answer: null,
      });
      const practiceA = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId: bankA, scope: { mode: 'all' } }),
        })
      ).body.practice;
      // 会外题目 → 400（流前 JSON，不调 LLM）
      const outside = await fetchJson(base, '/exam/api/grading/essay', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ questionId: essayB.id, practiceId: practiceA.id, userAnswer: 'x' }),
      });
      assert.equal(outside.status, 400);
      assert.equal(outside.body.error.code, 'EXAM_QUESTION_NOT_IN_PRACTICE');
      // 会内题目照常放行（SSE done）
      const ok = await readSse(base, '/exam/api/grading/essay', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ questionId: essayA.id, practiceId: practiceA.id, userAnswer: 'A 的论述' }),
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.events.at(-1)?.type, 'done');
      assert.equal(ok.events.at(-1)?.result.grading.score, 85);
    },
    { llm: DEFAULT_ROUTE, examLlm },
  );
});

test('t1 跨会话同题回归（HTTP）：resume/scorecard/history 按会话域作答，不串味', async () => {
  await withServer(async (base) => {
    const bank = await fetchJson(base, '/exam/api/banks', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ name: 't1 跨会话题库' }),
    });
    const bankId = bank.body.bank.id;
    const q1 = (
      await fetchJson(base, `/exam/api/banks/${bankId}/questions`, {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ type: 'single', stem: '1+1', options: ['1', '2'], answer: '1' }),
      })
    ).body.question;
    // 两个会话都含 q1
    const p1 = (
      await fetchJson(base, '/exam/api/practice/start', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
      })
    ).body.practice;
    const p2 = (
      await fetchJson(base, '/exam/api/practice/start', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
      })
    ).body.practice;
    // p1 答错、p2 答对（p2 更晚 → 全局最新是答对）
    await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ practiceId: p1.id, questionId: q1.id, answer: '2' }),
    });
    await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ practiceId: p2.id, questionId: q1.id, answer: '1' }),
    });
    // resume：p1 看到 p1 的答错、p2 看到 p2 的答对
    const r1 = await fetchJson(base, `/exam/api/practice/${p1.id}`);
    assert.equal(r1.body.latestAttempts.length, 1);
    assert.equal(r1.body.latestAttempts[0].isCorrect, false);
    const r2 = await fetchJson(base, `/exam/api/practice/${p2.id}`);
    assert.equal(r2.body.latestAttempts[0].isCorrect, true);
    // scorecard：p1 correct=0、p2 correct=1
    const sc1 = await fetchJson(base, `/exam/api/practice/${p1.id}/scorecard`);
    assert.equal(sc1.body.scorecard.correct, 0);
    const sc2 = await fetchJson(base, `/exam/api/practice/${p2.id}/scorecard`);
    assert.equal(sc2.body.scorecard.correct, 1);
    // history answeredCount 按会话域：p1/p2 各 1（互不串味）
    const history = await fetchJson(base, '/exam/api/practice/history');
    const byId = new Map<string, any>(
      (history.body.sessions as any[]).map((s) => [String(s.practice.id), s] as [string, any]),
    );
    assert.equal(byId.get(p1.id).answeredCount, 1);
    assert.equal(byId.get(p2.id).answeredCount, 1);
  });
});

test('t1 软删除（HTTP）：删题后列表排除、成绩单/续做仍可解释、再判分 404、重复删 404', async () => {
  await withServer(async (base) => {
    const bank = await fetchJson(base, '/exam/api/banks', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ name: 't1 软删除题库' }),
    });
    const bankId = bank.body.bank.id;
    const mk = (body: Record<string, unknown>) =>
      fetchJson(base, `/exam/api/banks/${bankId}/questions`, {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify(body),
      });
    const q1 = (await mk({ type: 'single', stem: 'q1', options: ['1', '2'], answer: '1' })).body.question;
    const q2 = (await mk({ type: 'single', stem: 'q2', options: ['1', '2'], answer: '2' })).body.question;
    const practice = (
      await fetchJson(base, '/exam/api/practice/start', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
      })
    ).body.practice;
    await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ practiceId: practice.id, questionId: q1.id, answer: '1' }),
    });

    // 删除 q1 → 204；重复删除 → 404（与删除不存在同语义）
    const del = await fetchJson(base, `/exam/api/questions/${q1.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    const delAgain = await fetchJson(base, `/exam/api/questions/${q1.id}`, { method: 'DELETE' });
    assert.equal(delAgain.status, 404);
    assert.equal(delAgain.body.error.code, 'EXAM_QUESTION_NOT_FOUND');
    // 列表排除已删题
    const listed = await fetchJson(base, `/exam/api/banks/${bankId}/questions`);
    assert.deepEqual(listed.body.questions.map((q: any) => q.id), [q2.id]);
    // 再判分已删题 → 404
    const regrade = await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ practiceId: practice.id, questionId: q1.id, answer: '1' }),
    });
    assert.equal(regrade.status, 404);
    assert.equal(regrade.body.error.code, 'EXAM_QUESTION_NOT_FOUND');

    // finished 历史仍可解释：scorecard total 含已删题、作答可见；resume 题单保留
    await fetchJson(base, `/exam/api/practice/${practice.id}/finish`, { method: 'POST' });
    const sc = await fetchJson(base, `/exam/api/practice/${practice.id}/scorecard`);
    assert.equal(sc.body.scorecard.total, 2, 'total 含软删除题目');
    assert.equal(sc.body.scorecard.answered, 1);
    const resumed = await fetchJson(base, `/exam/api/practice/${practice.id}`);
    // 同毫秒建题时 question_ids 按 id ASC 排序（UUID 随机）——集合比较，不假设创建顺序
    assert.deepEqual(
      [...(resumed.body.practice.questionIds as string[])].sort(),
      [q1.id, q2.id].sort(),
      '会话题单原样保留（含已删题）',
    );
    assert.deepEqual(
      resumed.body.latestAttempts.map((a: any) => a.questionId),
      [q1.id],
      '已删题的作答仍可回看',
    );
  });
});

// ---------------------------------------------------------------------------
// t5：AI 幂等事务与可靠性（HTTP 契约回归）
// ---------------------------------------------------------------------------

test('t5 Tutor clientMessageId 幂等：done 重放零 LLM + 跨会话冲突 409（SSE error）', async () => {
  let llmCalls = 0;
  const examLlm = llmResponding((system) => {
    llmCalls += 1;
    return system?.includes('讲题助手') ? '这是幂等回复。' : '';
  });
  await withServer(
    async (base) => {
      // 首次：显式 clientMessageId → done（replayed:false，LLM 调用一次）
      const first = await readSse(base, '/exam/api/tutor/chat', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ message: '你好', clientMessageId: 'cm-1' }),
      });
      const done1 = first.events[first.events.length - 1];
      assert.equal(done1.type, 'done');
      const sessionId = done1.result.sessionId;
      const messageId = done1.result.messageId;
      assert.equal(done1.result.replayed, false);
      assert.equal(llmCalls, 1);

      // 会话只落 1 user + 1 assistant（幂等不重复写）
      const msgs1 = (await fetchJson(base, `/exam/api/tutor/sessions/${sessionId}`)).body.messages;
      assert.equal(msgs1.length, 2);
      assert.equal(msgs1.filter((m: any) => m.role === 'user').length, 1);

      // 重放：同 clientMessageId + 同 sessionId → replayed:true，零 LLM 调用
      const replay = await readSse(base, '/exam/api/tutor/chat', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ sessionId, message: '你好', clientMessageId: 'cm-1' }),
      });
      const done2 = replay.events[replay.events.length - 1];
      assert.equal(done2.type, 'done');
      assert.equal(done2.result.replayed, true);
      assert.equal(done2.result.sessionId, sessionId);
      assert.equal(done2.result.messageId, messageId);
      assert.equal(llmCalls, 1, '重放零 LLM 调用');
      const msgs2 = (await fetchJson(base, `/exam/api/tutor/sessions/${sessionId}`)).body.messages;
      assert.equal(msgs2.length, 2, '重放不落库');

      // 另建会话（无 clientMessageId → 新 turn）
      const other = await readSse(base, '/exam/api/tutor/chat', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ message: '另一个会话' }),
      });
      const otherSessionId = other.events[other.events.length - 1].result.sessionId;
      assert.equal(llmCalls, 2);

      // 冲突：cm-1 已属于 sessionId，却用 otherSessionId → 409（SSE error，流内抛出）
      const conflict = await readSse(base, '/exam/api/tutor/chat', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ sessionId: otherSessionId, message: '你好', clientMessageId: 'cm-1' }),
      });
      const errEvent = conflict.events[conflict.events.length - 1];
      assert.equal(errEvent.type, 'error');
      assert.equal(errEvent.error.code, 'EXAM_TUTOR_TURN_CONFLICT');
      assert.equal(llmCalls, 2, '冲突路径零 LLM 调用');
    },
    { llm: DEFAULT_ROUTE, examLlm },
  );
});

test('t5 Tutor SSE 错误：流中失败 → error 事件携带 sessionId/turnId/retryable', async () => {
  // 空回复 → 服务层抛 EXAM_LLM_STREAM_FAILED（meta 附 sessionId/turnId/retryable）。
  const examLlm = llmResponding(() => '');
  await withServer(
    async (base) => {
      const res = await readSse(base, '/exam/api/tutor/chat', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ message: '你好' }),
      });
      assert.equal(res.status, 200);
      const err = res.events[res.events.length - 1];
      assert.equal(err.type, 'error');
      assert.equal(err.error.code, 'EXAM_LLM_STREAM_FAILED');
      assert.equal(typeof err.sessionId, 'string');
      assert.ok(err.sessionId.length > 0);
      assert.equal(typeof err.turnId, 'string');
      assert.ok(err.turnId.length > 0);
      assert.equal(err.retryable, true, '非取消错误应可重试');
    },
    { llm: DEFAULT_ROUTE, examLlm },
  );
});

test('t5 Tutor 会话 close/delete 路由：close 幂等 + closed guard 409 + delete 204→404', async () => {
  const examLlm = llmResponding((system) => (system?.includes('讲题助手') ? '回复' : ''));
  await withServer(
    async (base) => {
      const chat = await readSse(base, '/exam/api/tutor/chat', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ message: '你好' }),
      });
      const sessionId = chat.events[chat.events.length - 1].result.sessionId;

      // close → status=closed
      const closed = await fetchJson(base, `/exam/api/tutor/sessions/${sessionId}/close`, {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({}),
      });
      assert.equal(closed.status, 200);
      assert.equal(closed.body.session.status, 'closed');

      // close 幂等：已 closed 再 close 仍 200 closed
      const closed2 = await fetchJson(base, `/exam/api/tutor/sessions/${sessionId}/close`, {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({}),
      });
      assert.equal(closed2.status, 200);
      assert.equal(closed2.body.session.status, 'closed');

      // closed guard：对已关闭会话发消息 → 流前 JSON 409
      const guard = await fetchJson(base, '/exam/api/tutor/chat', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ sessionId, message: '还在吗' }),
      });
      assert.equal(guard.status, 409);
      assert.equal(guard.body.error.code, 'EXAM_TUTOR_SESSION_CLOSED');

      // delete → 204；随后 GET → 404
      const del = await fetchJson(base, `/exam/api/tutor/sessions/${sessionId}`, { method: 'DELETE' });
      assert.equal(del.status, 204);
      const after = await fetchJson(base, `/exam/api/tutor/sessions/${sessionId}`);
      assert.equal(after.status, 404);
      assert.equal(after.body.error.code, 'EXAM_TUTOR_SESSION_NOT_FOUND');
    },
    { llm: DEFAULT_ROUTE, examLlm },
  );
});

test('t5 导入草稿路由：GET 恢复 / draftId 提交消费 409 / discard 204 / ghost 404', async () => {
  const importJson = JSON.stringify([
    {
      type: 'single',
      stem: '三次握手次数？',
      options: ['A. 一', 'B. 两', 'C. 三'],
      answer: 'C',
      explanation: '三次握手',
      tags: ['网络'],
      topics: ['传输层', 'TCP 连接'],
    },
    { type: 'boolean', stem: 'UDP 面向连接。', options: [], answer: 'false', tags: ['网络'], topics: ['传输层'] },
  ]);
  const examLlm = llmResponding((system) => (system?.includes('出题专家') ? importJson : ''));
  await withServer(
    async (base) => {
      const bank = await fetchJson(base, '/exam/api/banks', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ name: '草稿题库' }),
      });
      const bankId = bank.body.bank.id;
      const longText =
        '这是一段超过五十个字符的复习资料文本，用来验证导入草稿的持久化恢复、消费与丢弃的完整契约是否可靠运作。';
      const generate = async () => {
        const res = await fetchJson(base, '/exam/api/import/generate', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ text: longText }),
        });
        assert.equal(res.status, 200);
        return res.body.draftId as string;
      };

      // draftId 1：GET 恢复 → draftId 提交（消费）→ 再次 GET 409
      const draftId = await generate();
      const draft = await fetchJson(base, `/exam/api/import/drafts/${draftId}`);
      assert.equal(draft.status, 200);
      assert.equal(draft.body.questions.length, 2);

      const committed = await fetchJson(base, '/exam/api/import/commit', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ bankId, draftId }),
      });
      assert.equal(committed.status, 200);
      assert.equal(committed.body.count, 2);
      assert.equal(committed.body.questions.length, 2);
      assert.deepEqual(committed.body.questions[0].topics, ['传输层', 'tcp连接'], 'draftId 提交透传 topics（标签规范化）');
      assert.equal(committed.body.questions[0].topicsSource, 'import', 'draftId 提交 topicsSource=import');

      const consumed = await fetchJson(base, `/exam/api/import/drafts/${draftId}`);
      assert.equal(consumed.status, 409);
      assert.equal(consumed.body.error.code, 'EXAM_IMPORT_DRAFT_CONSUMED');

      // draftId 2：discard → 204；随后 GET 409
      const draftId2 = await generate();
      const discard = await fetchJson(base, `/exam/api/import/drafts/${draftId2}/discard`, {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({}),
      });
      assert.equal(discard.status, 204);
      const afterDiscard = await fetchJson(base, `/exam/api/import/drafts/${draftId2}`);
      assert.equal(afterDiscard.status, 409);
      assert.equal(afterDiscard.body.error.code, 'EXAM_IMPORT_DRAFT_CONSUMED');

      // ghost → 404
      const ghost = await fetchJson(base, '/exam/api/import/drafts/ghost');
      assert.equal(ghost.status, 404);
      assert.equal(ghost.body.error.code, 'EXAM_IMPORT_DRAFT_NOT_FOUND');
    },
    { llm: DEFAULT_ROUTE, examLlm },
  );
});

test('t9 题库生命周期 + 题目过滤/批量 + questionIds 范围（HTTP）', async () => {
  await withServer(async (base) => {
    // 建库 + 3 题
    const created = await fetchJson(base, '/exam/api/banks', {
      method: 'POST', headers: POST_JSON, body: JSON.stringify({ name: 't9 题库' }),
    });
    assert.equal(created.status, 201);
    const bankId = created.body.bank.id;

    const mk = (stem: string, extra: object = {}) =>
      fetchJson(base, `/exam/api/banks/${bankId}/questions`, {
        method: 'POST', headers: POST_JSON,
        body: JSON.stringify({ type: 'single', stem, options: ['A. 1', 'B. 2'], answer: 'A', ...extra }),
      });
    const q1 = await mk('一元一次方程', { tags: ['数学'], explanation: '移项' });
    const q2 = await mk('勾股定理', { tags: ['数学', '几何'] });
    const q3 = await mk('历史题', { tags: ['历史'] });
    assert.equal(q1.status, 201);

    // 题目列表过滤：q / type / tags / hasExplanation / sort
    let list = await fetchJson(base, `/exam/api/banks/${bankId}/questions?q=方程`);
    assert.deepEqual(list.body.questions.map((x: any) => x.id), [q1.body.question.id]);
    list = await fetchJson(base, `/exam/api/banks/${bankId}/questions?tags=数学`);
    assert.equal(list.body.questions.length, 2);
    list = await fetchJson(base, `/exam/api/banks/${bankId}/questions?hasExplanation=true`);
    assert.equal(list.body.questions.length, 1);
    list = await fetchJson(base, `/exam/api/banks/${bankId}/questions?type=single&sort=createdAt:desc`);
    assert.equal(list.body.questions.length, 3);

    // 批量：tag / move / delete / restore
    const bulkTag = await fetchJson(base, '/exam/api/questions/bulk', {
      method: 'POST', headers: POST_JSON,
      body: JSON.stringify({ op: 'tag', questionIds: [q1.body.question.id, q2.body.question.id], tag: '重点', add: true }),
    });
    assert.equal(bulkTag.status, 200);
    assert.equal(bulkTag.body.applied, 2);
    list = await fetchJson(base, `/exam/api/banks/${bankId}/questions?tags=重点`);
    assert.equal(list.body.questions.length, 2);

    const bulkMove = await fetchJson(base, '/exam/api/questions/bulk', {
      method: 'POST', headers: POST_JSON,
      body: JSON.stringify({ op: 'move', questionIds: [q3.body.question.id], bankId }),
    });
    assert.equal(bulkMove.status, 200);

    const bulkDel = await fetchJson(base, '/exam/api/questions/bulk', {
      method: 'POST', headers: POST_JSON,
      body: JSON.stringify({ op: 'delete', questionIds: [q2.body.question.id] }),
    });
    assert.equal(bulkDel.status, 200);
    const afterDel = await fetchJson(base, `/exam/api/banks/${bankId}/questions`);
    assert.equal(afterDel.body.questions.length, 2);

    const bulkRestore = await fetchJson(base, '/exam/api/questions/bulk', {
      method: 'POST', headers: POST_JSON,
      body: JSON.stringify({ op: 'restore', questionIds: [q2.body.question.id] }),
    });
    assert.equal(bulkRestore.status, 200);
    assert.equal((await fetchJson(base, `/exam/api/banks/${bankId}/questions`)).body.questions.length, 3);

    // 题库生命周期：rename / archive / restore / delete
    const renamed = await fetchJson(base, `/exam/api/banks/${bankId}`, {
      method: 'PATCH', headers: POST_JSON, body: JSON.stringify({ name: '改名' }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.bank.name, '改名');

    let banks = (await fetchJson(base, '/exam/api/banks')).body.banks;
    assert.equal(banks.length, 1);
    await fetchJson(base, `/exam/api/banks/${bankId}/archive`, { method: 'POST' });
    banks = (await fetchJson(base, '/exam/api/banks')).body.banks;
    assert.equal(banks.length, 0, '归档后默认列表排除');
    const archived = (await fetchJson(base, '/exam/api/banks?includeArchived=true')).body.banks;
    assert.equal(archived.length, 1);
    await fetchJson(base, `/exam/api/banks/${bankId}/restore`, { method: 'POST' });

    const delResp = await fetchJson(base, `/exam/api/banks/${bankId}`, { method: 'DELETE' });
    assert.equal(delResp.status, 204);
    banks = (await fetchJson(base, '/exam/api/banks')).body.banks;
    assert.equal(banks.length, 0, '软删除后默认列表排除');
    const withDeleted = (await fetchJson(base, '/exam/api/banks?includeDeleted=true')).body.banks;
    assert.equal(withDeleted.length, 1);
    await fetchJson(base, `/exam/api/banks/${bankId}/restore`, { method: 'POST' });

    // questionIds 范围（错题重练）
    const wrongIds = [q1.body.question.id, q3.body.question.id];
    const practice = await fetchJson(base, '/exam/api/practice/start', {
      method: 'POST', headers: POST_JSON,
      body: JSON.stringify({ bankId, scope: { mode: 'wrong', questionIds: wrongIds } }),
    });
    assert.equal(practice.status, 201);
    assert.deepEqual(practice.body.practice.questionIds, wrongIds);
    assert.deepEqual(practice.body.practice.scope, { mode: 'wrong', questionIds: wrongIds });

    // 不存在于 bank 的 questionIds → 404 EXAM_QUESTION_NOT_FOUND
    const badPractice = await fetchJson(base, '/exam/api/practice/start', {
      method: 'POST', headers: POST_JSON,
      body: JSON.stringify({ bankId, scope: { mode: 'wrong', questionIds: ['ghost'] } }),
    });
    assert.equal(badPractice.status, 404);
    assert.equal(badPractice.body.error.code, 'EXAM_QUESTION_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// t1：P2 知识标注端点 / P3 深解析副产品写回 / depth 校验
// ---------------------------------------------------------------------------

test('P2 applyTopics（POST /questions/topics）：批量写回 + 校验（1-4 个 / 与 tags 冲突 / 空 / 不存在 / 整批回滚）', async () => {
  await withServer(async (base) => {
    const { bankId } = await mkBankAndQuestion(base, '标注题库', {
      type: 'single',
      stem: 's1',
      options: ['A. 一', 'B. 二'],
      answer: 'A',
      tags: ['主题'],
    });
    const q2 = await mkQuestion(base, bankId, {
      type: 'single',
      stem: 's2',
      options: ['A. 一', 'B. 二'],
      answer: 'A',
      tags: ['主题'],
    });
    const q3 = await mkQuestion(base, bankId, {
      type: 'single',
      stem: 's3',
      options: ['A. 一', 'B. 二'],
      answer: 'A',
      tags: [],
    });

    // 有效写回（规范化 + topicsSource batch）。
    const ok = await fetchJson(base, '/exam/api/questions/topics', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({
        items: [
          { questionId: q2.id, topics: [' 知识1 ', '知识2'] },
          { questionId: q3.id, topics: ['知识3'] },
        ],
      }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { updated: 2 });

    let listed = (await fetchJson(base, `/exam/api/banks/${bankId}/questions`)).body.questions;
    assert.deepEqual((listed as any[]).find((q: any) => q.id === q2.id)!.topics, ['知识1', '知识2'], '规范化后写回');
    assert.deepEqual((listed as any[]).find((q: any) => q.id === q3.id)!.topics, ['知识3']);

    // 与主题 tag 同项 → 400 EXAM_INVALID_BODY。
    const conflict = await fetchJson(base, '/exam/api/questions/topics', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ items: [{ questionId: q2.id, topics: ['主题'] }] }),
    });
    assert.equal(conflict.status, 400);
    assert.equal(conflict.body.error.code, 'EXAM_INVALID_BODY');

    // 空 topics → 400。
    const empty = await fetchJson(base, '/exam/api/questions/topics', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ items: [{ questionId: q2.id, topics: [] }] }),
    });
    assert.equal(empty.status, 400);

    // 不存在的题目（活跃）→ 404。
    const ghost = await fetchJson(base, '/exam/api/questions/topics', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ items: [{ questionId: 'ghost', topics: ['知识'] }] }),
    });
    assert.equal(ghost.status, 404);
    assert.equal(ghost.body.error.code, 'EXAM_QUESTION_NOT_FOUND');

    // 整批回滚：前项合法 + 后项冲突 → 全部不写。
    const rollback = await fetchJson(base, '/exam/api/questions/topics', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({
        items: [
          { questionId: q3.id, topics: ['知识9'] },
          { questionId: q2.id, topics: ['主题'] },
        ],
      }),
    });
    assert.equal(rollback.status, 400);
    listed = (await fetchJson(base, `/exam/api/banks/${bankId}/questions`)).body.questions;
    assert.deepEqual((listed as any[]).find((q: any) => q.id === q3.id)!.topics, ['知识3'], '整批回滚：q3 不被覆盖');
  });
});

test('P2 topic-suggestions（POST /banks/:id/topic-suggestions）：LLM 生成建议 + 缺失兜底 [首个 tag] / 无 tag → []', async () => {
  const fakeLlm = createExamLlm(
    createFakeLlmService(async function* (options) {
      const systemText = options.system ?? '';
      if (systemText.includes('知识图谱标注员')) {
        // 按题目内容判别（与批量索引无关，顺序确定）：含「识别架构领域」→ 命中；
        // 无 tag → 空；其余（有 tag 未命中）→ 空（回退 [首个 tag]）。
        const userMsg = options.messages.find((m) => m.role === 'user');
        const raw = userMsg?.content?.find((b) => b.type === 'text')?.text ?? '';
        const start = raw.indexOf('[');
        const batch = (start === -1 ? [] : JSON.parse(raw.slice(start))) as {
          index: number;
          stem: string;
          tags: string[] | null;
        }[];
        const out: { index: number; topics: string[] }[] = [];
        for (const item of batch) {
          if (item.stem.includes('识别架构领域')) out.push({ index: item.index, topics: ['架构治理', '数据架构'] });
          else if (!item.tags || item.tags.length === 0) out.push({ index: item.index, topics: [] });
          else out.push({ index: item.index, topics: [] });
        }
        yield textDelta(JSON.stringify(out));
      }
      yield finishStop();
    }),
  );
  await withServer(
    async (base) => {
      const { bankId } = await mkBankAndQuestion(base, '标注题库', {
        type: 'single',
        stem: '识别架构领域的第一题',
        options: ['A. 一', 'B. 二'],
        answer: 'A',
        tags: ['togaf'],
      });
      await mkQuestion(base, bankId, {
        type: 'single',
        stem: '架构治理的第二题',
        options: ['A. 一', 'B. 二'],
        answer: 'A',
        tags: ['架构'],
      });
      await mkQuestion(base, bankId, {
        type: 'single',
        stem: '数据架构的第三题',
        options: ['A. 一', 'B. 二'],
        answer: 'A',
        tags: [],
      });
      const res = await fetchJson(base, `/exam/api/banks/${bankId}/topic-suggestions`, {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ limit: 10 }),
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.items));
      assert.equal(res.body.items.length, 3, '客观题都出建议（essay 跳过）');
      const byTags = new Map(
        (res.body.items as any[]).map((it: any) => [it.currentTags?.[0] ?? '__none__', it]),
      );
      assert.deepEqual(byTags.get('togaf')!.suggestedTopics, ['架构治理', '数据架构'], 'LLM 命中');
      assert.deepEqual(byTags.get('架构')!.suggestedTopics, ['架构'], '空 topics 回退 [首个 tag]');
      assert.deepEqual(byTags.get('__none__')!.suggestedTopics, [], '无 tag → []');
    },
    { llm: DEFAULT_ROUTE, examLlm: fakeLlm },
  );
});

test('P2 topic-suggestions questionIds：显式指定 → 仅对这批生成建议 + 校验错误（非法/不存在/跨库/essay）', async () => {
  const fakeLlm = createExamLlm(
    createFakeLlmService(async function* (options) {
      const systemText = options.system ?? '';
      if (systemText.includes('知识图谱标注员')) {
        const userMsg = options.messages.find((m) => m.role === 'user');
        const raw = userMsg?.content?.find((b) => b.type === 'text')?.text ?? '';
        const start = raw.indexOf('[');
        const batch = (start === -1 ? [] : JSON.parse(raw.slice(start))) as { index: number; stem: string }[];
        const out = batch.map((item) => ({ index: item.index, topics: ['知识A', '知识B'] }));
        yield textDelta(JSON.stringify(out));
      }
      yield finishStop();
    }),
  );
  await withServer(
    async (base) => {
      const { bankId, question } = await mkBankAndQuestion(base, '显式题库', {
        type: 'single',
        stem: '第一题',
        options: ['A. 一', 'B. 二'],
        answer: 'A',
        tags: ['主题'],
      });
      const q2 = await mkQuestion(base, bankId, {
        type: 'single',
        stem: '第二题',
        options: ['A. 一', 'B. 二'],
        answer: 'A',
        tags: ['主题'],
      });
      const qEssay = await mkQuestion(base, bankId, {
        type: 'essay',
        stem: '主观题',
        options: [],
        answer: null,
      });
      const otherBank = await fetchJson(base, '/exam/api/banks', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ name: '另一个题库' }),
      });
      const otherId = otherBank.body.bank.id;
      const otherQ = await mkQuestion(base, otherId, {
        type: 'single',
        stem: '别的库的题',
        options: ['A. 一', 'B. 二'],
        answer: 'A',
      });

      // 只对显式指定的题目生成建议（无视默认挑选题量，这里 limit 故意不传）。
      const res = await fetchJson(base, `/exam/api/banks/${bankId}/topic-suggestions`, {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ questionIds: [q2.id, question.id] }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(
        (res.body.items as any[]).map((it: any) => it.questionId),
        [q2.id, question.id],
        '按传入顺序只返回这批题（essay 不混入）',
      );
      for (const it of res.body.items) assert.deepEqual(it.suggestedTopics, ['知识a', '知识b']);

      // 非法形态（非字符串数组 / 空数组 / 超 20 个）→ 400 EXAM_INVALID_BODY。
      for (const bad of ['abc', [], new Array(21).fill('x')]) {
        const badRes = await fetchJson(base, `/exam/api/banks/${bankId}/topic-suggestions`, {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ questionIds: bad }),
        });
        assert.equal(badRes.status, 400);
        assert.equal(badRes.body.error.code, 'EXAM_INVALID_BODY');
      }

      // 不存在的题目 → 404 EXAM_QUESTION_NOT_FOUND。
      const ghost = await fetchJson(base, `/exam/api/banks/${bankId}/topic-suggestions`, {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ questionIds: ['ghost'] }),
      });
      assert.equal(ghost.status, 404);
      assert.equal(ghost.body.error.code, 'EXAM_QUESTION_NOT_FOUND');

      // 跨库题目 → 404 EXAM_QUESTION_NOT_FOUND。
      const cross = await fetchJson(base, `/exam/api/banks/${bankId}/topic-suggestions`, {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ questionIds: [otherQ.id] }),
      });
      assert.equal(cross.status, 404);
      assert.equal(cross.body.error.code, 'EXAM_QUESTION_NOT_FOUND');

      // essay 题 → 400 EXAM_INVALID_QUESTION。
      const essay = await fetchJson(base, `/exam/api/banks/${bankId}/topic-suggestions`, {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ questionIds: [qEssay.id] }),
      });
      assert.equal(essay.status, 400);
      assert.equal(essay.body.error.code, 'EXAM_INVALID_QUESTION');
    },
    { llm: DEFAULT_ROUTE, examLlm: fakeLlm },
  );
});

test('P3 深解析副产品：剥离末尾 JSON topics 行 + 写回 topics（返回正文不含该行）', async () => {
  const DEEP_BODY = '【思路拆解】先判断考点。\n\n【逐项排除】A 错，B 对。\n\n【考点延伸】架构治理相关。\n\n【你的作答分析】选 A 混淆了。\n\n【易错陷阱】警惕偷换概念。';
  const deepContent = `${DEEP_BODY}\n\n{"topics":["架构治理","数据架构"]}`;
  const { llm } = phase4Llm({ personalized: () => deepContent });
  await withServer(
    async (base) => {
      const { bankId, question } = await mkBankAndQuestion(base, '解析题库', {
        type: 'single',
        stem: '识别架构领域的核心？',
        options: ['A. 一', 'B. 二'],
        answer: '1',
        tags: ['togaf'],
      });
      const practice = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;
      await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: question.id, answer: '0' }),
      });

      const deep = await postExplain(base, {
        practiceId: practice.id,
        questionId: question.id,
        depth: 'deep',
      });
      assert.equal(deep.status, 200);
      const done = deep.events.find((e) => e.type === 'done');
      assert.ok(done, '应有 done 事件');
      assert.equal(done.result.depth, 'deep');
      assert.equal(done.result.content, DEEP_BODY, '剥离 JSON topics 行后的正文');
      assert.ok(!done.result.content.includes('{"topics"'), '返回正文不含 JSON 行');

      const listed = (await fetchJson(base, `/exam/api/banks/${bankId}/questions`)).body.questions;
      const updated = listed.find((q: any) => q.id === question.id);
      assert.deepEqual(updated!.topics, ['架构治理', '数据架构'], '深档副产物写回 topics');
    },
    { llm: DEFAULT_ROUTE, examLlm: llm },
  );
});

test('M4 个性化上下文：deep 档注入该题答错次数 / 知识点正确率 / 相似题', async () => {
  let capturedUser: string | undefined;
  const fakeLlm = createExamLlm(
    createFakeLlmService(async function* (options) {
      const userMsg = options.messages.find((m) => m.role === 'user');
      capturedUser = userMsg?.content?.find((b) => b.type === 'text')?.text as string | undefined;
      yield textDelta('【思路拆解】解析。');
      yield finishStop();
    }),
  );
  await withServer(
    async (base) => {
      const { bankId, question: q1 } = await mkBankAndQuestion(base, '上下文题库', {
        type: 'single',
        stem: '识别架构领域的核心？',
        options: ['A. 一', 'B. 二'],
        answer: '1',
        tags: ['togaf'],
        topics: ['架构治理'],
      });
      const q2 = await mkQuestion(base, bankId, {
        type: 'single',
        stem: '识别架构领域的方法？',
        options: ['A. 甲', 'B. 乙'],
        answer: '1',
        tags: ['togaf'],
        topics: ['架构治理'],
      });
      const practice = (
        await fetchJson(base, '/exam/api/practice/start', {
          method: 'POST',
          headers: POST_JSON,
          body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
        })
      ).body.practice;
      // q1 答错、q2 答对（同知识点，供正确率聚合与相似题判别）。
      await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: q1.id, answer: '0' }),
      });
      await fetchJson(base, '/exam/api/quiz/grade', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ practiceId: practice.id, questionId: q2.id, answer: '1' }),
      });

      const deep = await postExplain(base, {
        practiceId: practice.id,
        questionId: q1.id,
        depth: 'deep',
      });
      assert.equal(deep.status, 200);
      assert.ok(capturedUser !== undefined, '本次调用应捕获到 deep user 消息');
      assert.ok(capturedUser!.includes('个性化上下文：'), '注入上下文段');
      assert.ok(capturedUser!.includes('该题历史答错 1 次'), '答错次数聚合');
      assert.ok(capturedUser!.includes('知识点「架构治理」正确率 50%'), '知识点正确率（同知识点题目聚合）');
      assert.ok(capturedUser!.includes('作答 2 题，对 1 题'));
      assert.ok(capturedUser!.includes('相似题：「识别架构领域的方法？」'), '同知识点相似题（关键词重叠≥2）');
    },
    { llm: DEFAULT_ROUTE, examLlm: fakeLlm },
  );
});

test('practice/explain：depth 非法 → 400（POST 与 GET probe 一致）', async () => {
  await withServer(async (base) => {
    const { bankId, question } = await mkBankAndQuestion(base, '解析题库', {
      type: 'single',
      stem: 's',
      options: ['A. 一', 'B. 二'],
      answer: '1',
      tags: [],
    });
    const practice = (
      await fetchJson(base, '/exam/api/practice/start', {
        method: 'POST',
        headers: POST_JSON,
        body: JSON.stringify({ bankId, scope: { mode: 'all' } }),
      })
    ).body.practice;
    await fetchJson(base, '/exam/api/quiz/grade', {
      method: 'POST',
      headers: POST_JSON,
      body: JSON.stringify({ practiceId: practice.id, questionId: question.id, answer: '0' }),
    });
    const badPost = await postExplainJson(base, {
      practiceId: practice.id,
      questionId: question.id,
      depth: 'ultra',
    });
    assert.equal(badPost.status, 400);
    assert.equal(badPost.body.error.code, 'EXAM_INVALID_BODY');
    const badGet = await fetchJson(
      base,
      `/exam/api/practice/explain?practiceId=${encodeURIComponent(practice.id)}&questionId=${encodeURIComponent(question.id)}&depth=ultra`,
    );
    assert.equal(badGet.status, 400);
  });
});
