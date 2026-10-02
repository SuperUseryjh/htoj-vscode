/**
 * API 层测试：跑 src/api 的真实代码，校验与线上接口的对接。
 * 需要登录的用例在未提供 HTOJ_TOKEN 时自动跳过。
 *
 * 运行：bun test
 */
import { describe, expect, test } from "bun:test";
import { HtojClient } from "../src/api/client";
import { auth, contest, problem, training, user } from "../src/api/endpoints";

const TIMEOUT = 30_000;
const token = process.env.HTOJ_TOKEN;

const client = new HtojClient({
  getToken: () => token,
  getZone: () => "cpp",
});

const authed = token ? test : test.skip;

describe("认证", () => {
  test(
    "微信扫码登录：能拿到二维码与 sessionId",
    async () => {
      const result = await auth.qrCode(client);
      expect(result.sessionId).toBeTruthy();
      expect(result.ticketBase64.length).toBeGreaterThan(100);
    },
    TIMEOUT,
  );
});

describe("题目", () => {
  test(
    "题目列表分页结构正确",
    async () => {
      const page = await problem.list(client, { currentPage: 1, limit: 5 });
      expect(page.records.length).toBeGreaterThan(0);
      expect(page.total).toBeGreaterThan(1000);
      expect(page.records[0].pid).toBeGreaterThan(0);
      expect(page.records[0].problemId).toMatch(/^[A-Za-z]+\d+$/);
    },
    TIMEOUT,
  );

  test(
    "按关键词搜索能命中",
    async () => {
      const page = await problem.list(client, { keyword: "P1000", limit: 5 });
      expect(page.records.some((record) => record.problemId === "P1000")).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "详情返回题面与判题配置",
    async () => {
      const detail = await problem.detail(client, 22169438826624);
      expect(detail.problemBaseVO.title).toBeTruthy();
      expect(detail.problemBaseVO.content).toBeTruthy();
      // ioMode 是提交时必须回传的数字
      const ioMode = detail.problemOjDetailVO?.ioMode?.id;
      expect(ioMode === 1 || ioMode === 2).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "语言与题库字典非空",
    async () => {
      expect((await problem.languages(client)).length).toBeGreaterThan(0);
      expect((await problem.warehouses(client)).length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});

describe("题单", () => {
  test(
    "题单列表与题单题目",
    async () => {
      const list = await training.list(client, { limit: 20 });
      expect(list.records.length).toBeGreaterThan(0);

      // get-training-problem-list 要求题单已参与，否则返回 400「请先点击开始练习！」
      const joined = list.records.find((record) => record.isAttend);
      if (!joined) {
        console.warn("当前账号没有已参与的题单，跳过题单题目校验");
        return;
      }

      const detail = await training.problems(client, {
        tid: joined.id,
        currentPage: 1,
        limit: 5,
      });
      expect(Array.isArray(detail.records)).toBe(true);
    },
    TIMEOUT,
  );
});

describe("比赛", () => {
  test(
    "比赛列表、详情与题目",
    async () => {
      const list = await contest.list(client, { limit: 3 });
      expect(list.records.length).toBeGreaterThan(0);

      const info = await contest.info(client, { cid: list.records[0].id });
      expect(info.title).toBeTruthy();
      expect([-1, 0, 1]).toContain(info.status);
    },
    TIMEOUT,
  );

  authed(
    "比赛题目必须带 cid：不带会被拒绝，带上才能拿到题面",
    async () => {
      const list = await contest.list(client, { limit: 10 });
      // 找一个有题目的比赛
      let target: { cid: number; pid: number } | undefined;
      for (const item of list.records) {
        if (item.problemCount <= 0) {
          continue;
        }
        try {
          const problems = await contest.problems(client, { cid: item.id, limit: 5 });
          if (problems.records.length > 0) {
            target = { cid: item.id, pid: problems.records[0].pid };
            break;
          }
        } catch {
          // 无权限的比赛跳过
        }
      }
      if (!target) {
        console.warn("没有可访问的比赛题目，跳过用例");
        return;
      }

      // 不带 cid：后端按「该题目不可见」拒绝
      let rejected = false;
      try {
        await problem.detail(client, target.pid);
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);

      // 带上 cid：正常返回
      const detail = await problem.detail(client, target.pid, { cid: target.cid });
      expect(detail.problemBaseVO.title).toBeTruthy();
    },
    TIMEOUT,
  );
});

describe("登录态", () => {
  authed(
    "能读取当前用户",
    async () => {
      const me = await user.me(client);
      expect(me.uid).toBeTruthy();
      expect(me.nickname || me.username).toBeTruthy();
    },
    TIMEOUT,
  );

  authed(
    "能读取提交记录",
    async () => {
      const page = await problem.submissionList(client, { pid: 22169438826624, limit: 5 });
      expect(page.total).toBeGreaterThanOrEqual(0);
      for (const record of page.records) {
        expect(record.submitId).toBeGreaterThan(0);
        expect(typeof record.status?.name).toBe("string");
      }
    },
    TIMEOUT,
  );
});
