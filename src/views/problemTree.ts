import * as vscode from "vscode";
import { problem } from "../api/endpoints";
import type { ProblemListItem } from "../api/types";
import type { Session } from "../session";
import { log, logError } from "../util/logger";
import {
  LOADING_ROOT_TEXT,
  logViewState,
  messageItem,
  moreItem,
  PageState,
  problemTreeItem,
  type ViewNode,
} from "./common";

export const PROBLEM_VIEW_ID = "problems";

function pageSize(): number {
  return vscode.workspace.getConfiguration("htoj").get<number>("pageSize") ?? 50;
}

/** 题目列表视图 */
export class ProblemTreeProvider implements vscode.TreeDataProvider<ViewNode<ProblemListItem>> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly state = new PageState<ProblemListItem>(pageSize());
  private keyword: string | undefined;

  constructor(private readonly session: Session) {}

  refresh(): void {
    this.state.reset();
    this.state.pageSize = pageSize();
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
      case "item":
        return problemTreeItem(node.value);
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
      return [];
    }
    logViewState("题目", this.state, `loggedIn=${this.session.isLoggedIn}`);
    if (!this.session.isLoggedIn) {
      return [];
    }
    if (this.state.isEmpty) {
      if (this.state.error) {
        return [{ kind: "message", text: `加载失败：${this.state.error}`, icon: "error" }];
      }
      if (!this.state.loading) {
        void this.loadMore();
      }
      return [{ kind: "message", text: LOADING_ROOT_TEXT, icon: "loading~spin" }];
    }

    const nodes: ViewNode<ProblemListItem>[] = this.state.items.map((value) => ({
      kind: "item" as const,
      value,
      key: String(value.pid),
    }));
    if (this.state.hasMore) {
      nodes.push({ kind: "more" });
    }
    return nodes;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
