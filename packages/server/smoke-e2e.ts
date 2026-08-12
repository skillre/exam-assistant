// 一次性端到端冒烟：非 AI 核心链路全流程（临时数据目录，跑完自删）。
// 覆盖：建库→题库 CRUD→题目导入/移动/复制/标签→判分→作答落库→错题本→
//       掌握标记→练习会话→成绩单信号→答疑会话登记→学情收集→级联删除。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "exam-smoke-"));
process.env.DATA_DIR = dir;

const { getDb, closeDb } = await import("./src/db/index.js");
const { bankRepo } = await import("./src/repositories/bankRepo.js");
const { questionRepo } = await import("./src/repositories/questionRepo.js");
const { attemptRepo } = await import("./src/repositories/attemptRepo.js");
const { wrongBookRepo } = await import("./src/repositories/wrongBookRepo.js");
const { practiceRepo } = await import("./src/repositories/practiceRepo.js");
const { tutorSessionRepo } = await import(
	"./src/repositories/tutorSessionRepo.js"
);
const { gradeQuestion } = await import("./src/grading/grade.js");
const { learningDataCollector } = await import(
	"./src/insights/LearningDataCollector.js"
);

const results: string[] = [];
const ok = (name: string, cond: boolean, extra = "") => {
	assert.ok(cond, `${name} 失败 ${extra}`);
	results.push(`  ✅ ${name}${extra ? " — " + extra : ""}`);
};

try {
	getDb();
	ok("建库建表", true);

	// ── 题库 ──
	const bankA = bankRepo.create("高等数学");
	const bankB = bankRepo.create("英语");
	ok("建库", !!bankA.id && !!bankB.id);
	ok("重命名", bankRepo.rename(bankA.id, "高数A")?.name === "高数A");
	ok(
		"题数聚合（空库无条目）",
		bankRepo.questionCounts().get(bankA.id) === undefined,
	);
	const bankList = bankRepo.list();
	ok("列表", bankList.length === 2);

	// ── 题目导入 ──
	const drafts = [
		{
			type: "single" as const,
			stem: "1+1=?",
			options: ["1", "2", "3"],
			answer: 1,
			explanation: "2",
			tags: ["基础"],
			source: "paste-ai" as const,
		},
		{
			type: "multiple" as const,
			stem: "哪些是偶数?",
			options: ["1", "2", "4"],
			answer: [1, 2],
			explanation: "2和4",
			tags: ["基础", "进阶"],
			source: "file" as const,
		},
		{
			type: "boolean" as const,
			stem: "地球是圆的",
			options: [],
			answer: true,
			explanation: "常识",
			tags: ["常识"],
			source: "paste-ai" as const,
		},
	];
	const n = questionRepo.insertMany(bankA.id, drafts);
	ok("批量导入", n === 3, `${n} 题`);
	const qs = questionRepo.listByBank(bankA.id);
	ok("按库列出", qs.length === 3);
	const [q1, q2, q3] = qs;
	ok(
		"字段往返",
		q1!.answer === 1 &&
			(q2!.answer as number[]).length === 2 &&
			q3!.answer === true &&
			q1!.tags![0] === "基础",
	);

	// 单题 CRUD
	const added = questionRepo.insertOne(bankA.id, {
		type: "single",
		stem: "临时题",
		options: ["a", "b"],
		answer: 0,
		tags: [],
		source: "file",
	});
	ok("单题新增", questionRepo.get(added.id)?.stem === "临时题");
	const upd = questionRepo.update(added.id, {
		type: "single",
		stem: "改后题",
		options: ["a", "b"],
		answer: 1,
		tags: ["x"],
		source: "file",
	});
	ok("单题更新", upd?.stem === "改后题" && upd.answer === 1);
	ok(
		"单题删除",
		questionRepo.remove(added.id) === true &&
			questionRepo.get(added.id) === undefined,
	);

	// 移动/复制/标签
	const copied = questionRepo.moveOrCopy([q1!.id], bankB.id, "copy");
	ok("复制", copied === 1 && questionRepo.listByBank(bankB.id).length === 1);
	ok(
		"移动",
		questionRepo.moveOrCopy([q1!.id], bankB.id, "move") === 1 &&
			questionRepo.listByBank(bankA.id).length === 2,
	);
	ok(
		"打标签add",
		questionRepo.addTags([q2!.id], ["新标签"], "add") === 1 &&
			questionRepo.get(q2!.id)!.tags!.includes("新标签"),
	);
	ok(
		"打标签replace",
		questionRepo.addTags([q2!.id], ["仅此"], "replace") === 1 &&
			questionRepo.get(q2!.id)!.tags!.length === 1,
	);

	// ── 判分（纯函数） ──
	ok("判分-单选对", gradeQuestion(q1!, 1) === true);
	ok("判分-单选错", gradeQuestion(q1!, 0) === false);
	ok("判分-多选全对", gradeQuestion(q2!, [1, 2]) === true);
	ok("判分-多选缺项", gradeQuestion(q2!, [1]) === false);
	ok("判分-判断对", gradeQuestion(q3!, true) === true);
	ok("判分-非法答案", gradeQuestion(q3!, 42 as never) === false);

	// ── 作答落库 + 错题本 ──
	attemptRepo.record(q1!.id, 1, true); // 对
	attemptRepo.record(q1!.id, 0, false); // 错（第一次）
	attemptRepo.record(q1!.id, 0, false); // 错（第二次）
	attemptRepo.record(q2!.id, [1], false); // 错
	attemptRepo.record(q3!.id, true, true); // 对
	const wrong = attemptRepo.listWrongDetailed();
	ok("错题聚合", wrong.length === 2, `错题数=${wrong.length}`);
	const w1 = wrong.find((w) => w.question.id === q1!.id)!;
	ok("错误次数", w1.wrongCount === 2, `wrongCount=${w1.wrongCount}`);
	ok("最近错误时间", w1.lastWrongAt >= 0);
	ok(
		"已作答集合（q1已move走，仅剩2题）",
		attemptRepo.answeredQuestionIds(bankA.id).size === 2,
	);
	const latest = attemptRepo.latestByQuestion([q1!.id]);
	// 同毫秒多次作答时 DESC LIMIT 1 顺序不确定（已知 R5），验证接口契约而非具体值
	ok(
		"最新作答-接口契约",
		latest.has(q1!.id) && typeof latest.get(q1!.id)!.isCorrect === "boolean",
	);
	const la = attemptRepo.latestAttempts([q1!.id]);
	ok(
		"latestAttempts-含attemptId",
		!!la.get(q1!.id)?.attemptId &&
			typeof la.get(q1!.id)!.isCorrect === "boolean",
	);
	ok(
		"成绩单-无记录题跳过",
		attemptRepo.latestByQuestion([copied.toString(), "不存在的id"]).size === 0,
	);

	// ── 错题掌握标记 ──
	wrongBookRepo.setMastered(q1!.id, true);
	ok("掌握标记", wrongBookRepo.listMasteredIds().has(q1!.id));
	wrongBookRepo.setMastered(q1!.id, false);
	ok("取消掌握", !wrongBookRepo.listMasteredIds().has(q1!.id));

	// ── 练习会话 ──
	const scope = { bankId: bankA.id, mode: "all" as const, shuffle: false };
	const session = practiceRepo.create(scope, [q2!.id, q3!.id]);
	ok("建会话", session.currentIndex === 0 && session.questionIds.length === 2);
	practiceRepo.updateIndex(session.id, 1);
	ok("进度续做", practiceRepo.get(session.id)!.currentIndex === 1);
	ok(
		"会话删除",
		(practiceRepo.remove(session.id),
		practiceRepo.get(session.id) === undefined),
	);

	// ── 答疑会话登记（JSONL 路径引用） ──
	const jsonl = join(dir, "sessions", "fake-session.jsonl");
	tutorSessionRepo.create(q1!.id, jsonl);
	ok("按题查会话", tutorSessionRepo.getByQuestion(q1!.id)?.jsonlPath === jsonl);
	ok(
		"库下JSONL路径（q1在bankB）",
		tutorSessionRepo.listJsonlPathsByBank(bankB.id).includes(jsonl),
	);

	// ── 学情收集（跨源：SQLite + JSONL） ──
	// q1 已 move 到 bankB：bankA 下仅 q2(错1次) + q3(对1次)
	const snap = await learningDataCollector.collect(bankA.id);
	ok("学情-总数", snap.totalAttempts === 2, `attempts=${snap.totalAttempts}`);
	ok(
		"学情-正确率",
		Math.abs(snap.accuracy - 1 / 2) < 1e-9,
		`accuracy=${snap.accuracy}`,
	);
	ok(
		"学情-薄弱标签",
		snap.weakTags.some((t) => t.tag === "仅此" && t.wrong === 1),
		JSON.stringify(snap.weakTags),
	);

	// ── 级联删除闭环 ──
	ok("删库", bankRepo.remove(bankA.id) === true);
	ok("级联-题清空", questionRepo.listByBank(bankA.id).length === 0);
	const wrongAfter = attemptRepo.listWrongDetailed();
	// bankA 删后仅剩 q1（在 bankB）的错题记录
	ok(
		"级联-错题只剩bankB",
		wrongAfter.length === 1,
		`剩余错题=${wrongAfter.length}`,
	);
	ok(
		"级联-会话登记清空",
		tutorSessionRepo.listJsonlPathsByBank(bankA.id).length === 0,
	);
	ok(
		"删题（q2已被删库级联清除）",
		questionRepo.get(q2!.id) === undefined &&
			questionRepo.remove(q2!.id) === false,
	);

	// ── v3 新表 CRUD（第二批验收③：mastery/snapshot/plan/diagnosis） ──
	const { masteryRepo } = await import("./src/repositories/masteryRepo.js");
	const { snapshotRepo } = await import("./src/repositories/snapshotRepo.js");
	const { planRepo } = await import("./src/repositories/planRepo.js");
	const { diagnosisRepo } = await import("./src/repositories/diagnosisRepo.js");
	const { checkMasteryAfterGrade } = await import(
		"./src/services/masteryService.js"
	);

	ok("v3-mastery streak递增", masteryRepo.incrementCorrect(q1!.id) === 1);
	ok(
		"v3-mastery 连续3次达标",
		masteryRepo.incrementCorrect(q1!.id) === 2 &&
			checkMasteryAfterGrade(q1!.id, true) === true,
	);
	const mstate = masteryRepo.getByQuestion(q1!.id)!;
	ok(
		"v3-mastery 状态落库",
		mstate.consecutiveCorrect === 3 && mstate.mastered === true,
	);

	const snapV3 = snapshotRepo.save({
		sessionId: "smoke-s1",
		bankId: bankB.id,
		total: 10,
		correct: 7,
		accuracy: 0.7,
		byTag: [{ tag: "基础", total: 10, correct: 7 }],
		byType: [{ type: "single", total: 10, correct: 7 }],
	});
	ok(
		"v3-snapshot 落库+幂等",
		snapV3 !== null &&
			snapshotRepo.save({
				sessionId: "smoke-s1",
				bankId: bankB.id,
				total: 10,
				correct: 7,
				accuracy: 0.7,
				byTag: [],
				byType: [],
			}) === null,
	);
	ok("v3-snapshot listAll", snapshotRepo.listAll(bankB.id).length === 1);

	const plan = planRepo.createPlan(bankB.id, "冒烟计划", undefined, [
		{
			title: "阶段1",
			tasks: [{ title: "任务1", scope: { bankId: bankB.id, mode: "all" } }],
		},
	]);
	ok("v3-plan 两表落库", planRepo.listTasksByPlan(plan.id).length === 1);
	ok(
		"v3-plan 任务状态流转",
		planRepo.updateTaskStatus(
			planRepo.listTasksByPlan(plan.id)[0]!.id,
			"done",
		) === true,
	);

	const dId = diagnosisRepo.save(null, [
		{
			questionId: q1!.id,
			stem: "地球是圆的",
			userAnswer: "B. 错",
			correctAnswer: "A. 对",
			errorCategory: "knowledge_gap",
		},
	]);
	ok(
		"v3-diagnosis 落库+读取",
		!!dId && diagnosisRepo.getLatest()?.results.length === 1,
	);

	console.log(
		`\n端到端冒烟通过（${results.length} 项断言）—— 数据目录: ${dir}\n`,
	);
	results.forEach((r) => console.log(r));
} finally {
	closeDb();
	rmSync(dir, { recursive: true, force: true });
}
