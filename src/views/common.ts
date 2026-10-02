import * as vscode from "vscode";
import type { ProblemContext } from "../api/types";
import { log } from "../util/logger";

/** 树节点：数据项 / 加载更多 / 提示信息 / 分组 */
export type ViewNode<T> =
  | { kind: "item"; value: T; key: string }
  | { kind: "group"; label: string; key: string }
  | { kind: "more" }
  | { kind: "message"; text: string; icon?: string };

/** 「正在加载」提示文案。测试里需要据此区分「加载中」和「加载结束但没数据」 */
export const LOADING_ROOT_TEXT = "加载中…";
export const LOADING_CHILDREN_TEXT = "加载题目中…";

/** 分页状态机，被三个列表视图共用 */
export class PageState<T> {
  items: T[] = [];
  page = 0;
  total = 0;
  loading = false;
  error: string | undefined;

  constructor(public pageSize: number) {}

  get hasMore(): boolean {
    if (this.error) {
      return false;
    }
    // page === 0 表示还没加载过第一页：此时 total 也是 0，
    // 不能用 items.length < total 判断，否则会误判成「没有更多」而永远不发起请求。
    if (this.page === 0) {
      return true;
    }
    return this.items.length < this.total;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  reset(): void {
    this.items = [];
    this.page = 0;
    this.total = 0;
    this.error = undefined;
  }

  async loadNext(
    fetchPage: (page: number) => Promise<{ records: T[]; total: number }>,
  ): Promise<void> {
    if (this.loading) {
      log(`[page] 忽略加载请求：上一次加载尚未结束`);
      return;
    }
    if (!this.hasMore) {
      log(`[page] 忽略加载请求：没有更多数据（page=${this.page} items=${this.items.length} total=${this.total}）`);
      return;
    }
    this.loading = true;
    this.error = undefined;
    try {
      const result = await fetchPage(this.page + 1);
      this.page += 1;
      this.items = this.page === 1 ? result.records : this.items.concat(result.records);
      this.total = result.total;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }
}

/** 打印一次 getChildren 的决策依据，便于排查「加载不出来」 */
export function logViewState(view: string, state: PageState<unknown>, extra?: string): void {
  log(
    `[${view}] getChildren items=${state.items.length} total=${state.total} page=${state.page}` +
      ` loading=${state.loading} hasMore=${state.hasMore} error=${state.error ?? "无"}` +
      (extra ? ` ${extra}` : ""),
  );
}

/** 构造「加载更多」节点 */
export function moreItem(
  viewId: string,
  loaded: number,
  total: number,
  loading: boolean,
): vscode.TreeItem {
  const item = new vscode.TreeItem(
    loading ? "加载中…" : `加载更多（已加载 ${loaded} / ${total}）`,
    vscode.TreeItemCollapsibleState.None,
  );
  item.iconPath = new vscode.ThemeIcon(loading ? "loading~spin" : "ellipsis");
  item.command = loading
    ? undefined
    : { command: "htoj.loadMore", title: "加载更多", arguments: [viewId] };
  item.contextValue = "htoj.more";
  return item;
}

/** 构造提示信息节点 */
export function messageItem(text: string, icon?: string): vscode.TreeItem {
  const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon ?? "info");
  item.contextValue = "htoj.message";
  return item;
}

/**
 * 构造可点击的操作节点（如「报名比赛」「开始练习」）。
 * 树节点本身带 command，点一下就能执行，不必绕道右键菜单。
 */
export function actionItem(
  label: string,
  icon: string,
  command: string,
  args: unknown[],
  tooltip?: string,
): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor("charts.blue"));
  item.command = { command, title: label, arguments: args };
  item.contextValue = "htoj.action";
  if (tooltip) {
    item.tooltip = tooltip;
  }
  return item;
}

/**
 * 作答状态。注意后端有两套枚举，id 不能混用：
 * - 题目列表 / 题单题目的 `acStatus`：2=未提交，3=未通过，4=已通过（未登录时是 1=未提交）
 * - 比赛题目的 `status`：形如 { id: 1, name: "Accepted", score: 100 }
 * 所以以 name 为准，id 只作为兜底。
 */
export type AnswerStatusKind = "passed" | "failed" | "untried";

export function answerStatusKind(
  status?: { id?: number | null; name?: string | null } | null,
): AnswerStatusKind {
  if (!status) {
    return "untried";
  }
  const name = status.name ?? "";
  if (name.includes("已通过") || /accept/i.test(name)) {
    return "passed";
  }
  if (name.includes("未通过") || /wrong|error|exceed|fail/i.test(name)) {
    return "failed";
  }
  if (name.includes("未提交") || name.includes("未作答")) {
    return "untried";
  }
  // 兜底：题目列表的 acStatus 枚举
  if (status.id === 4) {
    return "passed";
  }
  if (status.id === 3) {
    return "failed";
  }
  return "untried";
}

/** 作答状态 → 图标（用图标表达状态，比文字更容易一眼扫出来） */
export function answerStatusIcon(kind: AnswerStatusKind): vscode.ThemeIcon {
  switch (kind) {
    case "passed":
      return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green"));
    case "failed":
      return new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("charts.red"));
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}

/** 把毫秒时间戳格式化成相对时间 */
export function formatTime(timestamp: number | null | undefined): string {
  if (!timestamp) {
    return "-";
  }
  const diff = Date.now() - timestamp;
  if (diff < 0) {
    return new Date(timestamp).toLocaleString();
  }
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) {
    return "刚刚";
  }
  if (diff < hour) {
    return `${Math.floor(diff / minute)} 分钟前`;
  }
  if (diff < day) {
    return `${Math.floor(diff / hour)} 小时前`;
  }
  if (diff < 30 * day) {
    return `${Math.floor(diff / day)} 天前`;
  }
  return new Date(timestamp).toLocaleDateString();
}

/** 提交状态 → 图标与颜色 */
export function statusIcon(statusId: number): { icon: string; color: string } {
  switch (statusId) {
    case 0:
      return { icon: "pass-filled", color: "#00B42A" };
    case -10:
    case 99:
      return { icon: "clock", color: "#FFC700" };
    default:
      return { icon: "error", color: "#FF1D27" };
  }
}

/** 统一的题目节点渲染（题目列表 / 题单 / 比赛三处共用） */
export interface ProblemTreeItemOptions {
  /** 描述前缀，比如比赛里的题号 A */
  descriptionPrefix?: string;
  /** 打开题目时要携带的上下文（比赛题目必须带 cid，否则后端会拒绝） */
  context?: ProblemContext;
}

/** 三个视图的题目记录结构略有差异，只取渲染需要的公共字段 */
export interface ProblemItemLike {
  pid: number;
  problemId: string;
  title: string;
  difficulty?: { id: number; name: string } | null;
  /** 通过数，比赛题目可能为 null */
  ac?: number | null;
  /** 尝试数，比赛题目可能为 null */
  total?: number | null;
  tags?: Array<{ id: number; name: string }> | null;
  /** 题目列表 / 题单里的作答状态 */
  acStatus?: { id?: number | null; name?: string | null } | null;
  /** 比赛题目里的作答状态 */
  status?: { id?: number | null; name?: string | null } | null;
}

export function problemTreeItem(
  record: ProblemItemLike,
  options: ProblemTreeItemOptions = {},
): vscode.TreeItem {
  const item = new vscode.TreeItem(
    `${record.problemId}  ${record.title}`,
    vscode.TreeItemCollapsibleState.None,
  );
  const rate =
    record.total && record.total > 0
      ? `${(((record.ac ?? 0) / record.total) * 100).toFixed(1)}%`
      : undefined;
  const parts = [options.descriptionPrefix, record.difficulty?.name, rate].filter(Boolean);
  item.description = parts.join(" · ");

  // 图标位留给作答状态：扫一眼就能看出这题做没做出来
  const statusInfo = record.acStatus ?? record.status;
  item.iconPath = answerStatusIcon(answerStatusKind(statusInfo));

  const status = statusInfo?.name;
  const tooltipLines = [
    `**${record.problemId} ${record.title}**`,
    "",
    // 状态放最前面，和图标一致
    status ? `- 状态：${status}` : "",
    record.difficulty ? `- 难度：${record.difficulty.name}` : "",
    record.total ? `- 通过：${record.ac ?? 0} / ${record.total}` : "",
    record.tags?.length ? `- 标签：${record.tags.map((tag) => tag.name).join("、")}` : "",
    "",
    "_点击查看题目详情_",
  ];
  item.tooltip = new vscode.MarkdownString(tooltipLines.filter(Boolean).join("\n"));
  item.contextValue = "htoj.problem";
  item.command = {
    command: "htoj.openProblem",
    title: "打开题目",
    arguments: [record.pid, options.context],
  };
  return item;
}
