import * as vscode from "vscode";
import { problem } from "../api/endpoints";
import type { ProblemContext, ProblemDetail, ProblemListItem } from "../api/types";
import type { Session } from "../session";
import { log, logError } from "../util/logger";
import {
  LOADING_ROOT_TEXT,
  logViewState,
  messageItem,
  moreItem,
  PageState,
  PINNED_GROUP_LABEL,
  type PinnedRef,
  PinnedStore,
  problemTreeItem,
  type ViewNode,
} from "./common";

export const PROBLEM_VIEW_ID = "problems";

/** 「手动添加的题目」持久化用的 key（值是一组 PinnedRef，id 为 pid） */
const PINNED_KEY = "htoj.pinnedProblems";

/** 手动添加的题目：展示数据 + 打开时要带的上下文 */
interface PinnedProblem {
  item: ProblemListItem;
  context?: ProblemContext;
}

function pageSize(): number {
  return vscode.workspace.getConfiguration("htoj").get<number>("pageSize") ?? 50;
}

/** PinnedRef.extra ←→ ProblemContext 互转（cid/tid/gid 三种上下文） */
function contextFromExtra(extra?: Record<string, number>): ProblemContext | undefined {
  if (!extra) {
    return undefined;
  }
  const context: ProblemContext = {};
  for (const key of ["cid", "tid", "gid"] as const) {
    if (extra[key]) {
      context[key] = extra[key];
    }
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

function refExtra(context?: ProblemContext): Record<string, number> | undefined {
  if (!context) {
    return undefined;
  }
  const extra: Record<string, number> = {};
  for (const key of ["cid", "tid", "gid"] as const) {
    if (context[key]) {
      extra[key] = context[key];
    }
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/** 详情接口只给 problemBaseVO，树里要的是列表项那一套，转一下 */
function toListItem(detail: ProblemDetail, pid: number): ProblemListItem {
  const base = detail.problemBaseVO;
  return {
    pid,
    problemId: base.problemId,
    title: base.title,
    difficulty: base.difficulty,
    owner: null,
    type: base.type,
    tags: base.tags ?? [],
    acStatus: base.historyResult ?? {
      id: detail.accepted ? 4 : 2,
      name: detail.accepted ? "已通过" : "未提交",
      shortName: null,
      chineseName: null,
    },
    total: base.total,
    ac: base.ac,
    rn: null,
  };
}

/** 题目列表视图 */
export class ProblemTreeProvider implements vscode.TreeDataProvider<ViewNode<ProblemListItem>> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly state = new PageState<ProblemListItem>(pageSize());
  private keyword: string | undefined;
  /** 手动添加的题目（小组题、比赛题这类在列表里翻不到的） */
  private readonly pinned: PinnedStore<PinnedProblem>;

  constructor(
    private readonly session: Session,
    memento?: vscode.Memento,
  ) {
    this.pinned = new PinnedStore<PinnedProblem>(
      PINNED_KEY,
      memento,
      (entry) => entry.item.pid,
      async (ref) => this.fetchProblem(ref),
    );
  }

  /** 拉一道题；比赛题/题单题必须带上下文，否则后端返回「该题目不可见」 */
  private async fetchProblem(ref: PinnedRef): Promise<PinnedProblem> {
    const context = contextFromExtra(ref.extra);
    const detail = await problem.detail(this.session.client, ref.id, context);
    return { item: toListItem(detail, ref.id), context };
  }

  refresh(): void {
    this.state.reset();
    this.state.pageSize = pageSize();
    this.pinned.invalidate();
    this.emitter.fire();
  }

  async loadPinned(): Promise<void> {
    if (!this.session.isLoggedIn || this.pinned.isLoaded) {
      return;
    }
    await this.pinned.load();
    this.emitter.fire();
  }

  /** 按链接添加一道题；同一 pid 重复添加只会刷新顺序 */
  async addPinned(pid: number, context?: ProblemContext): Promise<ProblemListItem | undefined> {
    const entry = await this.pinned.add({ id: pid, extra: refExtra(context) });
    this.emitter.fire();
    return entry?.item;
  }

  async removePinned(pid: number): Promise<void> {
    await this.pinned.remove(pid);
    this.emitter.fire();
  }

  setKeyword(keyword: string | undefined): void {
    this.keyword = keyword?.trim() || undefined;
    void vscode.commands.executeCommand("setContext", "htoj.hasSearch", Boolean(this.keyword));
    this.refresh();
  }

  getKeyword(): string | undefined {
    return this.keyword;
  }

  async loadMore(): Promise<void> {
    if (!this.session.isLoggedIn) {
      log("[题目] 未登录，跳过加载");
      return;
    }
    const nextPage = this.state.page + 1;
    log(`[题目] 开始加载第 ${nextPage} 页（limit=${this.state.pageSize} keyword=${this.keyword ?? "无"}）`);
    await this.state.loadNext(async (page) => {
      const result = await problem.list(this.session.client, {
        currentPage: page,
        limit: this.state.pageSize,
        keyword: this.keyword,
      });
      return { records: result.records, total: result.total };
    });
    if (this.state.error) {
      logError("[题目] 加载失败", this.state.error);
      this.notifyFailureOnce();
    } else {
      log(`[题目] 加载完成：已有 ${this.state.items.length}/${this.state.total} 条`);
    }
    this.emitter.fire();
  }

  private failureNotified = false;

  private notifyFailureOnce(): void {
    if (this.failureNotified) {
      return;
    }
    this.failureNotified = true;
    void vscode.window
      .showWarningMessage(`核桃OJ：题目列表加载失败 —— ${this.state.error}`, "查看日志", "重新登录")
      .then((choice) => {
        if (choice === "查看日志") {
          void vscode.commands.executeCommand("htoj.showLogs");
        } else if (choice === "重新登录") {
          void vscode.commands.executeCommand("htoj.login");
        }
      });
  }

  getTreeItem(node: ViewNode<ProblemListItem>): vscode.TreeItem {
    switch (node.kind) {
      case "pinned": {
        const item = new vscode.TreeItem(
          `${PINNED_GROUP_LABEL}的题目`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.description = `${this.pinned.list.length} 道`;
        item.iconPath = new vscode.ThemeIcon("pin");
        item.tooltip = new vscode.MarkdownString(
          "通过题目链接手动添加的题目。\n\n_右键可以移除；小组题、比赛题这类在列表里翻不到的可以这样加。_",
        );
        return item;
      }
      case "item": {
        const item = problemTreeItem(node.value, { context: node.context });
        if (node.pinned) {
          // 手动添加的单独一个 contextValue，好挂「移除」菜单
          item.contextValue = "htoj.problemPinned";
        }
        return item;
      }
      case "more":
        return moreItem(PROBLEM_VIEW_ID, this.state.items.length, this.state.total, this.state.loading);
      case "message":
        return messageItem(node.text, node.icon);
      case "group":
        return messageItem(node.label);
    }
  }

  getChildren(node?: ViewNode<ProblemListItem>): ViewNode<ProblemListItem>[] {
    if (node) {
      if (node.kind === "pinned") {
        return this.pinned.list.map((entry) => ({
          kind: "item" as const,
          value: entry.item,
          key: `pinned-${entry.item.pid}`,
          pinned: true,
          context: entry.context,
        }));
      }
      return [];
    }
    logViewState("题目", this.state, `loggedIn=${this.session.isLoggedIn}`);
    if (!this.session.isLoggedIn) {
      return [];
    }
    if (!this.pinned.isLoaded) {
      void this.loadPinned();
    }

    const nodes: ViewNode<ProblemListItem>[] = [];
    // 「已添加的题目」固定排在最前面；没有内容时整个分组不出现
    if (this.pinned.list.length > 0) {
      nodes.push({ kind: "pinned" });
    }
    if (this.state.isEmpty) {
      if (this.state.error) {
        nodes.push({ kind: "message", text: `加载失败：${this.state.error}`, icon: "error" });
        return nodes;
      }
      if (!this.state.loading) {
        void this.loadMore();
      }
      nodes.push({ kind: "message", text: LOADING_ROOT_TEXT, icon: "loading~spin" });
      return nodes;
    }

    nodes.push(
      ...this.state.items.map((value) => ({ kind: "item" as const, value, key: String(value.pid) })),
    );
    if (this.state.hasMore) {
      nodes.push({ kind: "more" });
    }
    return nodes;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
