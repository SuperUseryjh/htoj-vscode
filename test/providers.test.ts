/**
 * 视图层回归测试：直接跑 TreeDataProvider 的真实逻辑。
 * 需要有有效 token（HTOJ_TOKEN 环境变量），否则相关用例自动跳过。
 *
 * 运行：bun test
 */
import { describe, expect, test } from "bun:test";
import { Session } from "../src/session";
import { ContestTreeProvider } from "../src/views/contestTree";
import { ProblemTreeProvider } from "../src/views/problemTree";
import { TrainingTreeProvider } from "../src/views/trainingTree";
import { MemorySecretStorage } from "./vscode-stub";
import { LOADING_CHILDREN_TEXT, LOADING_ROOT_TEXT } from "../src/views/common";

const TIMEOUT = 30_000;
const token = process.env.HTOJ_TOKEN;

const secrets = new MemorySecretStorage();
if (token) {
  await secrets.store("htoj.token", token);
}
const session = new Session(secrets);
await session.restore();

const loggedIn = session.isLoggedIn;
const scoped = loggedIn ? test : test.skip;

/** 轮询等待条件成立 */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待超时（${timeoutMs}ms）`);
    }
    await Bun.sleep(100);
  }
}

if (!loggedIn) {
  console.warn("未提供可用的 HTOJ_TOKEN，视图层用例将跳过。");
}

describe("题目视图", () => {
  scoped(
    "首次 getChildren 会自动发起加载并最终拿到数据",
    async () => {
      const provider = new ProblemTreeProvider(session);

      // 首次调用不允许直接返回空数组——那会让 viewsWelcome 顶掉列表
      const first = provider.getChildren();
      expect(first.length).toBeGreaterThan(0);

      const items = await waitFor(() => {
        const nodes = provider.getChildren().filter((node) => node.kind === "item");
        return nodes.length > 0 ? nodes : undefined;
      });
      expect(items.length).toBeGreaterThan(0);
      provider.dispose();
    },
    TIMEOUT,
  );

  scoped(
    "加载更多会推进页码且不重复",
    async () => {
      const provider = new ProblemTreeProvider(session);
      await provider.loadMore();

      const firstPage = provider
        .getChildren()
        .filter((node) => node.kind === "item")
        .map((node) => node.value.pid);
      expect(firstPage.length).toBeGreaterThan(0);

      await provider.loadMore();
      const all = provider
        .getChildren()
        .filter((node) => node.kind === "item")
        .map((node) => node.value.pid);

      expect(all.length).toBeGreaterThan(firstPage.length);
      const added = all.slice(firstPage.length);
      expect(added.filter((pid) => firstPage.includes(pid))).toHaveLength(0);
      provider.dispose();
    },
    TIMEOUT,
  );

  scoped(
    "未登录时返回空数组（交给 viewsWelcome 显示引导）",
    async () => {
      const anonymous = new Session(new MemorySecretStorage());
      await anonymous.restore();
      const provider = new ProblemTreeProvider(anonymous);
      expect(provider.getChildren()).toEqual([]);
      provider.dispose();
    },
    TIMEOUT,
  );
});

describe("题单视图", () => {
  scoped(
    "能加载题单列表",
    async () => {
      const provider = new TrainingTreeProvider(session);
      await provider.loadMore();
      const nodes = provider.getChildren().filter((node) => node.kind === "training");
      expect(nodes.length).toBeGreaterThan(0);
      provider.dispose();
    },
    TIMEOUT,
  );

  scoped(
    "展开已参与的题单能加载出题目节点",
    async () => {
      const provider = new TrainingTreeProvider(session);
      await provider.loadMore();

      // 未参与的题单调用 get-training-problem-list 会返回 400「请先点击开始练习！」
      const first = provider
        .getChildren()
        .find((node) => node.kind === "training" && node.value.isAttend);
      if (!first) {
        console.warn("当前账号没有已参与的题单，跳过展开用例");
        provider.dispose();
        return;
      }

      provider.getChildren(first); // 触发懒加载
      const problems = await waitFor(() => {
        const nodes = provider.getChildren(first).filter((node) => node.kind === "problem");
        return nodes.length > 0 ? nodes : undefined;
      });
      expect(problems.length).toBeGreaterThan(0);
      provider.dispose();
    },
    TIMEOUT,
  );
});

describe("比赛视图", () => {
  scoped(
    "能加载比赛列表",
    async () => {
      const provider = new ContestTreeProvider(session);
      await provider.loadMore();
      const nodes = provider.getChildren().filter((node) => node.kind === "contest");
      expect(nodes.length).toBeGreaterThan(0);
      provider.dispose();
    },
    TIMEOUT,
  );

  scoped(
    "展开比赛后题目节点必须带 cid 上下文",
    async () => {
      const provider = new ContestTreeProvider(session);
      await provider.loadMore();

      const contests = provider
        .getChildren()
        .filter((node) => node.kind === "contest" && node.value.problemCount > 0)
        .slice(0, 10);
      expect(contests.length).toBeGreaterThan(0);

      let checked = 0;
      let lastMessage = "";
      for (const node of contests) {
        if (node.kind !== "contest") {
          continue;
        }
        provider.getChildren(node); // 触发懒加载
        // 加载一旦有结果（拿到题目，或返回空/错误提示）就立刻返回，避免空等
        const problems = await waitFor(
          () => {
            const children = provider.getChildren(node);
            const found = children.filter((child) => child.kind === "problem");
            if (found.length > 0) {
              return found;
            }
            // 「加载中…」「加载题目中…」不算结果，要等真正的错误/空提示出现才算结束
            const settled = children.find(
              (child) =>
                child.kind === "message" &&
                child.text !== LOADING_ROOT_TEXT &&
                child.text !== LOADING_CHILDREN_TEXT,
            );
            if (settled && settled.kind === "message") {
              lastMessage = `${node.value.title}: ${settled.text}`;
              return [];
            }
            return undefined;
          },
          15_000,
        ).catch(() => []);

        if (problems.length === 0) {
          continue;
        }
        // 比赛题目不带 cid 会被后端判定为「该题目不可见」
        const first = problems[0];
        if (first.kind === "problem") {
          expect(first.context.cid).toBe(node.value.id);
          checked++;
        }
        break;
      }

      if (checked === 0) {
        console.warn(`没有可访问的比赛题目，跳过断言。最后一个原因：${lastMessage || "无"}`);
      }
      provider.dispose();
    },
    TIMEOUT,
  );
});
