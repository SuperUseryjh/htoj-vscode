import * as vscode from "vscode";
import { training } from "../api/endpoints";
import type { ProblemContext, ProblemListItem, TrainingItem } from "../api/types";
import type { Session } from "../session";
import { log, logError } from "../util/logger";
import {
  actionItem,
  LOADING_CHILDREN_TEXT,
  LOADING_ROOT_TEXT,
  logViewState,
  messageItem,
  moreItem,
  PageState,
  problemTreeItem,
} from "./common";

export const TRAINING_VIEW_ID = "trainings";

/** 题单树的节点类型（题单与题目是两类节点，必须区分开） */
export type TrainingNode =
  | { kind: "training"; value: TrainingItem; key: string }
  | { kind: "chapter"; label: string; key: string }
  | { kind: "problem"; value: ProblemListItem; key: string; context: ProblemContext }
  | { kind: "join"; tid: number; key: string }
  | { kind: "more" }
  | { kind: "message"; text: string; icon?: string };

function pageSize(): number {
  return vscode.workspace.getConfiguration("htoj").get<number>("pageSize") ?? 50;
}

/** 题单视图：题单 → 章节 → 题目 */
export class TrainingTreeProvider implements vscode.TreeDataProvider<TrainingNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly state = new PageState<TrainingItem>(pageSize());
  private readonly children = new Map<number, TrainingNode[]>();
  private readonly loadingChildren = new Set<number>();

  constructor(private readonly session: Session) {}

  refresh(): void {
    this.state.reset();
    this.state.pageSize = pageSize();
    this.children.clear();
    this.loadingChildren.clear();
    this.emitter.fire();
  }

  /** 参加成功后就地更新状态并清掉子节点缓存，重新展开时会按已参加重新加载 */
  markAttended(tid: number): void {
    const record = this.state.items.find((item) => item.id === tid);
    if (record) {
      record.isAttend = true;
    }
    this.children.delete(tid);
    this.emitter.fire();
  }

  async loadMore(): Promise<void> {
    if (!this.session.isLoggedIn) {
      log("[题单] 未登录，跳过加载");
      return;
    }
    log(`[题单] 开始加载第 ${this.state.page + 1} 页（limit=${this.state.pageSize}）`);
    await this.state.loadNext(async (page) => {
      const result = await training.list(this.session.client, {
        currentPage: page,
        limit: this.state.pageSize,
      });
      return { records: result.records, total: result.total };
    });
    if (this.state.error) {
      logError("[题单] 加载失败", this.state.error);
    } else {
      log(`[题单] 加载完成：已有 ${this.state.items.length}/${this.state.total} 条`);
    }
    this.emitter.fire();
  }

  getTreeItem(node: TrainingNode): vscode.TreeItem {
    switch (node.kind) {
      case "join":
        return actionItem(
          "开始练习（参加该题单）",
          "play",
          "htoj.joinTraining",
          [node.tid],
          "该题单尚未参加，参加后即可查看并提交题目",
        );
      case "training": {
        const record = node.value;
        const progress =
          record.totalCount && record.totalCount > 0
            ? `${record.completeCount ?? 0} / ${record.totalCount}`
            : `${record.problemCount} 题`;
        const item = new vscode.TreeItem(record.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${progress}${record.isAttend ? " · 已参与" : ""}`;
        item.iconPath = new vscode.ThemeIcon("list-ordered");
        item.tooltip = new vscode.MarkdownString(
          [
            `**${record.title}**`,
            "",
            record.subtitle ? `> ${record.subtitle}` : "",
            `- 题单号：${record.trainingNo ?? record.id}`,
            `- 题目数：${record.problemCount}`,
            `- 进度：${progress}`,
            record.isAttend ? "- 已参与" : "- 未参与（展开后可参加）",
            "",
            "_展开查看题目_",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        // 用 contextValue 区分参与状态，右键菜单据此决定是否显示「开始练习」
        item.contextValue = record.isAttend ? "htoj.training" : "htoj.training.unattended";
        return item;
      }
      case "chapter": {
        const group = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        group.iconPath = new vscode.ThemeIcon("bookmark");
        group.contextValue = "htoj.chapter";
        return group;
      }
      case "problem":
        return problemTreeItem(node.value, { context: node.context });
      case "more":
        return moreItem(TRAINING_VIEW_ID, this.state.items.length, this.state.total, this.state.loading);
      case "message":
        return messageItem(node.text, node.icon);
    }
  }

  getChildren(node?: TrainingNode): TrainingNode[] {
    if (node) {
      return node.kind === "training" ? this.childrenOf(node.value) : [];
    }
    logViewState("题单", this.state, `loggedIn=${this.session.isLoggedIn}`);
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

    const nodes: TrainingNode[] = this.state.items.map((value) => ({
      kind: "training" as const,
      value,
      key: String(value.id),
    }));
    if (this.state.hasMore) {
      nodes.push({ kind: "more" });
    }
    return nodes;
  }

  private childrenOf(item: TrainingItem): TrainingNode[] {
    const cached = this.children.get(item.id);
    if (cached) {
      return cached;
    }
    if (!this.loadingChildren.has(item.id)) {
      void this.loadTrainingProblems(item);
    }
    return [{ kind: "message", text: LOADING_CHILDREN_TEXT, icon: "loading~spin" }];
  }

  private async loadTrainingProblems(item: TrainingItem): Promise<void> {
    this.loadingChildren.add(item.id);
    log(`[题单] 展开「${item.title}」(tid=${item.id})，加载题目中…`);
    try {
      const result = await training.problems(this.session.client, {
        tid: item.id,
        currentPage: 1,
        limit: 200,
      });
      const collected: TrainingNode[] = [];
      // 从题单里打开题目时带上 tid，提交才会归属到该题单
      const context: ProblemContext = { tid: item.id };
      for (const chapter of result.records) {
        const problems = chapter.problemVOList ?? [];
        if (chapter.trainingChapterVO?.title) {
          collected.push({
            kind: "chapter",
            label: chapter.trainingChapterVO.title,
            key: `c-${item.id}-${chapter.trainingChapterVO.id}`,
          });
        }
        for (const record of problems) {
          collected.push({
            kind: "problem",
            value: record,
            key: `p-${item.id}-${record.pid}`,
            context,
          });
        }
      }
      const nodes: TrainingNode[] = [];
      // 未参加时把「开始练习」放在最前面，不用跳出编辑器就能参加
      if (!item.isAttend) {
        nodes.push({ kind: "join", tid: item.id, key: `join-${item.id}` });
      }
      nodes.push(...collected);
      if (collected.length === 0) {
        nodes.push({ kind: "message", text: "该题单暂无题目", icon: "info" });
      }
      log(`[题单] 「${item.title}」加载完成：${result.records.length} 个章节 / ${collected.length} 个节点`);
      this.children.set(item.id, nodes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`[题单] 「${item.title}」题目加载失败`, error);
      // 未参与的题单后端会直接拒绝（400「请先点击开始练习！」），
      // 这里换成可直接点击的「开始练习」节点，而不是甩一行原始报错
      const notJoined = item.isAttend === false || message.includes("开始练习");
      this.children.set(
        item.id,
        notJoined
          ? [{ kind: "join", tid: item.id, key: `join-${item.id}` }]
          : [{ kind: "message", text: `加载失败：${message}`, icon: "error" }],
      );
    } finally {
      this.loadingChildren.delete(item.id);
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
