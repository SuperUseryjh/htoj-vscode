/**
 * 作答状态映射测试（纯函数，不发请求）。
 * 后端有两套枚举，且比赛题目的 id 与题目列表不同，必须以 name 为准。
 */
import { describe, expect, test } from "bun:test";
import { answerStatusIcon, answerStatusKind } from "../src/views/common";

describe("answerStatusKind", () => {
  test("题目列表 / 题单的 acStatus 枚举", () => {
    expect(answerStatusKind({ id: 4, name: "已通过" })).toBe("passed");
    expect(answerStatusKind({ id: 3, name: "未通过" })).toBe("failed");
    expect(answerStatusKind({ id: 2, name: "未提交" })).toBe("untried");
    // 未登录时后端给的是 1=未提交
    expect(answerStatusKind({ id: 1, name: "未提交" })).toBe("untried");
  });

  test("比赛题目的 status 枚举（同一 id 含义不同）", () => {
    // 比赛题目的 status 形如 { id, name, score }，其中 id=1 是 Accepted，
    // 不能按题目列表的枚举（4=已通过）解读，所以必须以 name 为准
    expect(answerStatusKind({ id: 1, name: "Accepted" })).toBe("passed");
    expect(answerStatusKind({ id: 3, name: "Wrong Answer" })).toBe("failed");
    expect(answerStatusKind({ id: 2, name: "Time Limit Exceeded" })).toBe("failed");
  });

  test("空值视为未提交", () => {
    expect(answerStatusKind(null)).toBe("untried");
    expect(answerStatusKind(undefined)).toBe("untried");
    expect(answerStatusKind({})).toBe("untried");
  });

  test("name 缺失时按 id 兜底", () => {
    expect(answerStatusKind({ id: 4 })).toBe("passed");
    expect(answerStatusKind({ id: 3 })).toBe("failed");
    expect(answerStatusKind({ id: 2 })).toBe("untried");
  });
});

describe("answerStatusIcon", () => {
  test("三种状态用不同图标", () => {
    expect((answerStatusIcon("passed") as { id: string }).id).toBe("pass-filled");
    expect((answerStatusIcon("failed") as { id: string }).id).toBe("circle-slash");
    expect((answerStatusIcon("untried") as { id: string }).id).toBe("circle-outline");
  });
});
