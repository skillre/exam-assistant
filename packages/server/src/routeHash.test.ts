import { describe, it, expect } from "vitest";
import { parseTabFromHash } from "@exam/shared";

// 第三批 体验①：hash 路由解析（浏览器实测取消后改为代码级验证——用户决定 2026-08-12）。
// 覆盖：合法 tab / 空 hash / 非法 hash 回退 / #/ 前缀形式。

// 第四批：新增 history 第 6 个 tab（App.tsx TABS 同步）
const KEYS = ["quiz", "banks", "wrong", "insights", "history", "settings"] as const;

describe("parseTabFromHash（轻量 hash 路由解析）", () => {
	it("合法 hash 返回对应 tab（#/ 前缀与裸 hash 均可）", () => {
		expect(parseTabFromHash("#/wrong", KEYS, "quiz")).toBe("wrong");
		expect(parseTabFromHash("#wrong", KEYS, "quiz")).toBe("wrong");
		expect(parseTabFromHash("#/settings", KEYS, "quiz")).toBe("settings");
		expect(parseTabFromHash("#/quiz", KEYS, "quiz")).toBe("quiz");
	});

	it("history 为合法 tab（第四批新增）", () => {
		expect(parseTabFromHash("#/history", KEYS, "quiz")).toBe("history");
	});

	it("空 hash 回退默认（刷题页）", () => {
		expect(parseTabFromHash("", KEYS, "quiz")).toBe("quiz");
		expect(parseTabFromHash("#", KEYS, "quiz")).toBe("quiz");
	});

	it("非法 hash 回退默认（#/bogus 不崩）", () => {
		expect(parseTabFromHash("#/bogus", KEYS, "quiz")).toBe("quiz");
		expect(parseTabFromHash("#/WRONG", KEYS, "quiz")).toBe("quiz"); // 大小写敏感
		expect(parseTabFromHash("#/quiz/extra", KEYS, "quiz")).toBe("quiz");
	});

	it("自定义 validKeys/fallback 参数化", () => {
		expect(parseTabFromHash("#/a", ["a", "b"], "b")).toBe("a");
		expect(parseTabFromHash("#/zzz", ["a", "b"], "b")).toBe("b");
	});
});
