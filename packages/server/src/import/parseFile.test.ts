import { describe, it, expect } from "vitest";
import { parseFileBuffer, isStructuredFile } from "./parseFile.js";
import { toCsv } from "../export/csv.js";

// 第三批 卫生⑪：导入解析测试（JSON/CSV/xlsx + 畸形输入容错，审计 R7 缺口）。
// 第六批起：parseFileBuffer 返回 { questions, errors }——坏行给出 行号+原因，不再整文件拒绝。

const single = {
	type: "single",
	stem: "1+1=?",
	options: ["1", "2"],
	answer: 1,
	explanation: "等于2",
	tags: ["基础"],
};

describe("isStructuredFile", () => {
	it("识别 json/csv/xlsx/xls", () => {
		expect(isStructuredFile("a.json")).toBe(true);
		expect(isStructuredFile("a.csv")).toBe(true);
		expect(isStructuredFile("a.xlsx")).toBe(true);
		expect(isStructuredFile("a.xls")).toBe(true);
		expect(isStructuredFile("a.txt")).toBe(false);
		expect(isStructuredFile("a.docx")).toBe(false);
	});
});

describe("parseFileBuffer JSON", () => {
	it("合法数组解析为草稿", () => {
		const { questions, errors } = parseFileBuffer(
			"t.json",
			Buffer.from(JSON.stringify([single])),
		);
		expect(errors).toHaveLength(0);
		expect(questions).toHaveLength(1);
		expect(questions[0]!.stem).toBe("1+1=?");
		expect(questions[0]!.answer).toBe(1);
		expect(questions[0]!.tags).toEqual(["基础"]);
	});

	it("畸形 JSON 抛可读错误", () => {
		expect(() => parseFileBuffer("t.json", Buffer.from("{bad json"))).toThrow(
			"JSON 文件无法解析",
		);
	});

	it("结构不符（缺字段/错类型）逐条给出错误而非整文件抛错", () => {
		const { questions, errors } = parseFileBuffer(
			"t.json",
			Buffer.from(JSON.stringify([{ stem: "缺字段" }, single])),
		);
		expect(questions).toHaveLength(1);
		expect(errors).toHaveLength(1);
		expect(errors[0]!.row).toBe(1);
		expect(errors[0]!.errors.length).toBeGreaterThan(0);
	});

	it("非法题型枚举被逐条拒绝", () => {
		const { questions, errors } = parseFileBuffer(
			"t.json",
			Buffer.from(JSON.stringify([{ ...single, type: "fill" }])),
		);
		expect(questions).toHaveLength(0);
		expect(errors[0]!.errors.join("；")).toContain("single");
	});

	// 第五批：essay 成为合法题型
	it("essay 题合法（answer=参考答案文本，非空）", () => {
		const { questions } = parseFileBuffer(
			"t.json",
			Buffer.from(
				JSON.stringify([
					{
						type: "essay",
						stem: "简述 TCP 三次握手",
						options: [],
						answer: "SYN, SYN-ACK, ACK",
						explanation: "评分要点：三个报文段",
						tags: ["网络"],
					},
				]),
			),
		);
		expect(questions).toHaveLength(1);
		expect(questions[0]!.type).toBe("essay");
		expect(questions[0]!.answer).toBe("SYN, SYN-ACK, ACK");
	});

	it("essay 空参考答案被拒绝", () => {
		const { errors } = parseFileBuffer(
			"t.json",
			Buffer.from(
				JSON.stringify([
					{ type: "essay", stem: "简述", options: [], answer: "   " },
				]),
			),
		);
		expect(errors).toHaveLength(1);
	});
});

describe("parseFileBuffer CSV", () => {
	it("表头+数据行解析（options/tags 用 | 分隔）", () => {
		const csv =
			"type,stem,options,answer,explanation,tags\nsingle,1+1=?,1|2,1,等于2,基础\nboolean,地球是圆的,,true,,常识\n";
		const { questions, errors } = parseFileBuffer("t.csv", Buffer.from(csv));
		expect(errors).toHaveLength(0);
		expect(questions).toHaveLength(2);
		expect(questions[0]!.type).toBe("single");
		expect(questions[0]!.options).toEqual(["1", "2"]);
		expect(questions[1]!.type).toBe("boolean");
		expect(questions[1]!.answer).toBe(true);
		expect(questions[1]!.tags).toEqual(["常识"]);
	});

	it("UTF-8 BOM（前端下载模板/Excel 另存）不再破坏表头", () => {
		const csv =
			"\uFEFFtype,stem,options,answer,explanation,tags\nsingle,1+1=?,1|2,1,等于2,基础\n";
		const { questions, errors } = parseFileBuffer("t.csv", Buffer.from(csv, "utf8"));
		expect(errors).toHaveLength(0);
		expect(questions).toHaveLength(1);
		expect(questions[0]!.stem).toBe("1+1=?");
	});

	it("GBK 编码（Windows Excel 导出）中文不乱码", () => {
		// 手写 GBK 字节：表头「题型,题干,选项,答案」+ 数据「单选,你好,1|2,1」
		// 题型=CC E2 D0 CD，题干=CC E2 B8 C9，选项=D1 A1 CF EE，答案=B4 F0 B0 B8
		// 单选=B5 A5 D1 A1，你好=C4 E3 BA C3
		const bytes = Buffer.from([
			0xcc, 0xe2, 0xd0, 0xcd, 0x2c, 0xcc, 0xe2, 0xb8, 0xc9, 0x2c, 0xd1, 0xa1, 0xcf, 0xee,
			0x2c, 0xb4, 0xf0, 0xb0, 0xb8, 0x0a, 0xb5, 0xa5, 0xd1, 0xa1, 0x2c, 0xc4, 0xe3, 0xba,
			0xc3, 0x2c, 0x31, 0x7c, 0x32, 0x2c, 0x31, 0x0a,
		]);
		const { questions, errors } = parseFileBuffer("t.csv", bytes);
		expect(errors).toHaveLength(0);
		expect(questions).toHaveLength(1);
		expect(questions[0]!.type).toBe("single");
		expect(questions[0]!.stem).toBe("你好");
	});

	it("中文表头 + 中文题型 + 字母答案", () => {
		const csv =
			"题型,题干,选项,答案,解析,标签\n单选题,1+1=?,1|2,B,等于2,基础\n多选题,选语言,Python|HTML|Java|CSS,AC,,编程\n";
		const { questions, errors } = parseFileBuffer("t.csv", Buffer.from(csv));
		expect(errors).toHaveLength(0);
		expect(questions).toHaveLength(2);
		expect(questions[0]!.type).toBe("single");
		expect(questions[0]!.answer).toBe(1); // B → 1
		expect(questions[1]!.type).toBe("multiple");
		expect(questions[1]!.answer).toEqual([0, 2]); // AC → 0,2
	});

	it("判断题 对/错、多选 顿号/逗号分隔 均识别", () => {
		const csv =
			"type,stem,options,answer\nboolean,地球是圆的,正确|错误,对\nmultiple,选语言,Python|HTML|Java|CSS,0、2\nsingle,地球的卫星是？,月球|火星|金星,0\n";
		const { questions, errors } = parseFileBuffer("t.csv", Buffer.from(csv));
		expect(errors).toHaveLength(0);
		expect(questions[0]!.answer).toBe(true);
		expect(questions[1]!.answer).toEqual([0, 2]);
		expect(questions[2]!.answer).toBe(0);
	});

	it("CSV essay 行：answer 列=裸文本参考答案", () => {
		const csv =
			"type,stem,options,answer,explanation,tags\nessay,简述 TCP 握手,,\"SYN, SYN-ACK, ACK\",评分要点,网络\n";
		const { questions } = parseFileBuffer("t.csv", Buffer.from(csv));
		expect(questions).toHaveLength(1);
		expect(questions[0]!.type).toBe("essay");
		expect(questions[0]!.answer).toBe("SYN, SYN-ACK, ACK");
		expect(questions[0]!.options).toEqual([]);
	});

	it("导出 CSV 往返（含 BOM + JSON 编码的 options/answer 列）", () => {
		const rows: unknown[][] = [
			["type", "stem", "options", "answer", "explanation", "tags"],
			["single", "1+1=?", JSON.stringify(["1", "2"]), JSON.stringify(0), "", "基础"],
			["multiple", "选语言", JSON.stringify(["Python", "HTML"]), JSON.stringify([0, 1]), "", "编程"],
			["boolean", "地球是圆的", JSON.stringify(["正确", "错误"]), JSON.stringify(true), "", "常识"],
			["essay", "简述握手", JSON.stringify([]), JSON.stringify("SYN, ACK"), "要点", "网络"],
		];
		const csv = toCsv(rows); // 导出即带 BOM
		const { questions, errors } = parseFileBuffer("roundtrip.csv", Buffer.from(csv, "utf8"));
		expect(errors).toHaveLength(0);
		expect(questions).toHaveLength(4);
		expect(questions[0]!.options).toEqual(["1", "2"]);
		expect(questions[0]!.answer).toBe(0);
		expect(questions[1]!.answer).toEqual([0, 1]);
		expect(questions[2]!.answer).toBe(true);
		expect(questions[3]!.answer).toBe("SYN, ACK");
	});

	it("坏行不拖垮全文件：好行照常返回，坏行给行号与原因", () => {
		const csv =
			"type,stem,options,answer\nessay,简述握手,,参考\nsingle,地球的卫星是？,月球|火星|金星,0\nbadtype,坏题,opt1|opt2,0\nboolean,判断,正确|错误,\n";
		const { questions, errors } = parseFileBuffer("t.csv", Buffer.from(csv));
		expect(questions).toHaveLength(2); // essay + single 通过
		expect(errors).toHaveLength(2);
		expect(errors[0]!.row).toBe(4); // 第 4 行 type=badtype
		expect(errors[0]!.errors.join("；")).toContain("题型");
		expect(errors[1]!.row).toBe(5); // 第 5 行判断题答案空
		expect(errors[1]!.errors.join("；")).toContain("判断");
	});

	it("列数不一致行（未加引号的逗号）给出行错误而非整文件抛错", () => {
		const csv = "type,stem,options,answer\nmultiple,选语言,Python|HTML|Java|CSS,0,2\n";
		const { questions, errors } = parseFileBuffer("t.csv", Buffer.from(csv));
		expect(questions).toHaveLength(0);
		expect(errors).toHaveLength(1);
		expect(errors[0]!.row).toBe(2);
		expect(errors[0]!.errors.join("；")).toContain("列数");
	});

	it("1 起下标兼容：共 N 个选项时 answer=N 视作最后一个", () => {
		const csv = "type,stem,options,answer\nsingle,4选项,甲|乙|丙|丁,4\n";
		const { questions, errors } = parseFileBuffer("t.csv", Buffer.from(csv));
		expect(errors).toHaveLength(0);
		expect(questions[0]!.answer).toBe(3);
	});

	it("畸形 CSV（空文件/只有表头）不抛非预期异常", () => {
		expect(() => parseFileBuffer("t.csv", Buffer.from(""))).not.toThrow();
		expect(() =>
			parseFileBuffer("t.csv", Buffer.from("type,stem,options,answer\n")),
		).not.toThrow();
	});
});

describe("parseFileBuffer xlsx", () => {
	it("xlsx 解析（sheet 行 → 草稿，单选/判断）", () => {
		const XLSX = require("xlsx") as typeof import("xlsx");
		const ws = XLSX.utils.aoa_to_sheet([
			["type", "stem", "options", "answer", "explanation", "tags"],
			["single", "1+1=?", "1|2", "1", "等于2", "基础"],
			["boolean", "地球是圆的", "", "true", "", "常识"],
		]);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
		const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

		const { questions, errors } = parseFileBuffer("t.xlsx", buf);
		expect(errors).toHaveLength(0);
		expect(questions).toHaveLength(2);
		expect(questions[0]!.type).toBe("single");
		expect(questions[0]!.answer).toBe(1);
		expect(questions[1]!.type).toBe("boolean");
		expect(questions[1]!.answer).toBe(true);
		expect(questions[1]!.tags).toEqual(["常识"]);
	});

	it("Excel 首行为标题行时自动定位表头", () => {
		const XLSX = require("xlsx") as typeof import("xlsx");
		const ws = XLSX.utils.aoa_to_sheet([
			["高一物理题库导入"],
			["type", "stem", "options", "answer", "explanation", "tags"],
			["single", "1+1=?", "1|2", "1", "", ""],
		]);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
		const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

		const { questions, errors } = parseFileBuffer("t.xlsx", buf);
		expect(errors).toHaveLength(0);
		expect(questions).toHaveLength(1);
		expect(questions[0]!.stem).toBe("1+1=?");
	});

	it("常见排版：题目/选项A-D分列/答案 也能导入", () => {
		const XLSX = require("xlsx") as typeof import("xlsx");
		const ws = XLSX.utils.aoa_to_sheet([
			["题目", "选项A", "选项B", "选项C", "答案"],
			["1+1=?", "1", "2", "3", "B"],
		]);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
		const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

		const { questions, errors } = parseFileBuffer("t.xlsx", buf);
		expect(errors).toHaveLength(0);
		expect(questions).toHaveLength(1);
		expect(questions[0]!.type).toBe("single");
		expect(questions[0]!.options).toEqual(["1", "2", "3"]);
		expect(questions[0]!.answer).toBe(1); // B → 1
	});

	it("Excel 数字单元格答案正常", () => {
		const XLSX = require("xlsx") as typeof import("xlsx");
		const ws = XLSX.utils.aoa_to_sheet([
			["type", "stem", "options", "answer"],
			["single", "1+1=?", "1|2", 1], // 数字单元格
		]);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
		const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

		const { questions, errors } = parseFileBuffer("t.xlsx", buf);
		expect(errors).toHaveLength(0);
		expect(questions[0]!.answer).toBe(1);
	});

	it("空 sheet 的 xlsx：无有效题（返回空或抛均可，不崩）", () => {
		const XLSX = require("xlsx") as typeof import("xlsx");
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Sheet1");
		const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
		expect(() => parseFileBuffer("t.xlsx", buf)).not.toThrow();
	});

	it("非 xlsx 内容（伪文件）给出可读错误而非崩溃", () => {
		expect(() => parseFileBuffer("t.xlsx", Buffer.from("not an xlsx at all"))).toThrow(
			/表头未识别|无法解析/,
		);
	});
});
