import { describe, it, expect } from "vitest";
import { parseFileBuffer, isStructuredFile } from "./parseFile.js";

// 第三批 卫生⑪：导入解析测试（JSON/CSV/xlsx + 畸形输入容错，审计 R7 缺口）。
// xlsx 是第三方解析面（原型污染/ReDoS advisory），畸形输入必须不抛非预期异常。

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
		const drafts = parseFileBuffer(
			"t.json",
			Buffer.from(JSON.stringify([single])),
		);
		expect(drafts).toHaveLength(1);
		expect(drafts[0]!.stem).toBe("1+1=?");
		expect(drafts[0]!.answer).toBe(1);
		expect(drafts[0]!.tags).toEqual(["基础"]);
	});

	it("畸形 JSON 抛可读错误", () => {
		expect(() => parseFileBuffer("t.json", Buffer.from("{bad json"))).toThrow(
			"JSON 文件无法解析",
		);
	});

	it("结构不符（缺字段/错类型）被 zod 拒绝", () => {
		expect(() =>
			parseFileBuffer(
				"t.json",
				Buffer.from(JSON.stringify([{ stem: "缺字段" }])),
			),
		).toThrow();
		expect(() =>
			parseFileBuffer(
				"t.json",
				Buffer.from(JSON.stringify([{ ...single, answer: "不是数字" }])),
			),
		).toThrow();
	});

	it("非法题型枚举被拒绝", () => {
		expect(() =>
			parseFileBuffer(
				"t.json",
				Buffer.from(JSON.stringify([{ ...single, type: "essay" }])),
			),
		).toThrow();
	});
});

describe("parseFileBuffer CSV", () => {
	it("表头+数据行解析（options/tags 用 | 分隔）", () => {
		const csv =
			"type,stem,options,answer,explanation,tags\nsingle,1+1=?,1|2,1,等于2,基础\nboolean,地球是圆的,,true,,常识\n";
		const drafts = parseFileBuffer("t.csv", Buffer.from(csv));
		expect(drafts).toHaveLength(2);
		expect(drafts[0]!.type).toBe("single");
		expect(drafts[0]!.options).toEqual(["1", "2"]);
		expect(drafts[1]!.type).toBe("boolean");
		expect(drafts[1]!.answer).toBe(true);
		expect(drafts[1]!.tags).toEqual(["常识"]);
	});

	it("畸形 CSV（空文件/只有表头）不抛非预期异常", () => {
		// 空文件 → 空数组（合法）；只有表头 → 空数组；都不崩
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

		const drafts = parseFileBuffer("t.xlsx", buf);
		expect(drafts).toHaveLength(2);
		expect(drafts[0]!.type).toBe("single");
		expect(drafts[0]!.answer).toBe(1);
		expect(drafts[1]!.type).toBe("boolean");
		expect(drafts[1]!.answer).toBe(true);
		expect(drafts[1]!.tags).toEqual(["常识"]);
	});

	it("空 sheet 的 xlsx：无有效题（返回空或抛均可，不崩）", () => {
		const XLSX = require("xlsx") as typeof import("xlsx");
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Sheet1");
		const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
		expect(() => parseFileBuffer("t.xlsx", buf)).not.toThrow();
	});

	it("非 xlsx 内容（伪文件）容错不崩", () => {
		expect(() =>
			parseFileBuffer("t.xlsx", Buffer.from("not an xlsx at all")),
		).not.toThrow();
	});
});
