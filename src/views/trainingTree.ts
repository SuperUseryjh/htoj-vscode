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
  PINNED_GROUP_LABEL,
  type PinnedRef,
  PinnedStore,
  problemTreeItem,
} from "./common";

export const TRAINING_VIEW_ID = "trainings";

/** 「手动添加的题单」持久化用的 key（值是一组 PinnedRef，id 为 tid） */
const PINNED_KEY = "htoj.pinnedTrainings";

/** 题单树的节点类型（题单与题目是两类节点，必须区分开） */
export type TrainingNode =
  | { kind: "training"; value: TrainingItem; key: string; pinned?: boolean }
  /** 「已添加的题单」分组标题，只在有内容时出现 */
  | { kind: "pinned" }
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
  /** 手动添加的题单（小组题单之类列表里翻不到的） */
  private readonly pinned: PinnedStore<TrainingItem>;
  /**
   * 手动添加的题单如果是小组题单，得把 gid 记下来。
   * TrainingItem 里没有 gid 字段，而拿题目、交题目都要靠它。
   */
  private readonly pinnedGid = new Map<number, number>();

  constructor(
    private readonly session: Session,
    memento?: vscode.Memento,
  ) {
    this.pinned = new PinnedStore<TrainingItem>(
      PINNED_KEY,
      memento,
      (item) => item.id,
      async (ref) => this.fetchTraining(ref),
    );
  }

  private async fetchTraining(ref: PinnedRef): Promise<TrainingItem> {
    const gid = ref.extra?.gid;
    if (gid) {
      this.pinnedGid.set(ref.id, gid);
    }
    return training.detail(this.session.client, { tid: ref.id, gid });
  }

  refresh(): void {
    this.state.reset();
    this.state.pageSize = pageSize();
    this.children.clear();
    this.loadingChildren.clear();
    this.pinned.invalidate();
    this.pinnedGid.clear();
    this.emitter.fire();
  }

  /** 列表里的和手动添加的一起算 */
  private findTraining(tid: number): TrainingItem | undefined {
    return this.pinned.find(tid) ?? this.state.items.find((item) => item.id === tid);
  }

  async loadPinned(): Promise<void> {
    if (!this.session.isLoggedIn || this.pinned.isLoaded) {
      return;
    }
    await this.pinned.load();
    this.emitter.fire();
  }

  /** 按链接添加一个题单；同一 tid 重复添加只会刷新顺序 */
  async addPinned(tid: number, gid?: number): Promise<TrainingItem | undefined> {
    const item = await this.pinned.add({ id: tid, extra: gid ? { gid } : undefined });
    if (gid) {
      this.pinnedGid.set(tid, gid);
    }
    this.children.delete(tid);
    this.emitter.fire();
    return item;
  }

  async removePinned(tid: number): Promise<void> {
    await this.pinned.remove(tid);
    this.pinnedGid.delete(tid);
    this.children.delete(tid);
    this.emitter.fire();
  }

  /** 参加成功后就地更新状态并清掉子节点缓存，重新展开时会按已参加重新加载 */
  markAttended(tid: number): void {
    const record = this.findTraining(tid);
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
      case "pinned": {
        const item = new vscode.TreeItem(
          `${PINNED_GROUP_LABEL}的题单`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.description = `${this.pinned.list.length} 个`;
        item.iconPath = new vscode.ThemeIcon("pin");
        item.tooltip = new vscode.MarkdownString(
          "通过题单链接手动添加的题单。\n\n_右键可以移除；小组题单这类在列表里翻不到的可以这样加。_",
        );
        return item;
      }
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
        // contextValue 决定右键菜单：参与状态 + 是否手动添加，两段都要带上，
        // 缺了哪段都会丢菜单（未参与时要能「开始练习」，手动添加的要能「移除」）
        if (node.pinned) {
          item.contextValue = record.isAttend ? "htoj.trainingPinned" : "htoj.trainingPinned.unattended";
        } else {
          item.contextValue = record.isAttend ? "htoj.training" : "htoj.training.unattended";
        }
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
      if (node.kind === "pinned") {
        return this.pinned.list.map((value) => ({
          kind: "training" as const,
          value,
          key: `pinned-${value.id}`,
          pinned: true,
        }));
      }
      return node.kind === "training" ? this.childrenOf(node.value) : [];
    }
    logViewState("题单", this.state, `loggedIn=${this.session.isLoggedIn}`);
    if (!this.session.isLoggedIn) {
      return [];
    }
    if (!this.pinned.isLoaded) {
      void this.loadPinned();
    }

    const nodes: TrainingNode[] = [];
    // 「已添加的题单」固定排在最前面；没有内容时整个分组不出现
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
      ...this.state.items.map((value) => ({
        kind: "training" as const,
        value,
        key: String(value.id),
      })),
    );
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
    // 小组题单必须带 gid，否则返回的题目点进去是「该题目不可见」
    const gid = this.pinnedGid.get(item.id);
    log(`[题单] 展开「${item.title}」(tid=${item.id} gid=${gid ?? "无"})，加载题目中…`);
    try {
      const result = await training.problems(this.session.client, {
        tid: item.id,
        gid,
        currentPage: 1,
        limit: 200,
      });
      const collected: TrainingNode[] = [];
      // 从题单里打开题目时带上 tid，提交才会归属到该题单
      const context: ProblemContext = gid ? { tid: item.id, gid } : { tid: item.id };
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
