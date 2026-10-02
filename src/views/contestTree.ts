import * as vscode from "vscode";
import { contest } from "../api/endpoints";
import type { ContestItem, ContestProblem, ProblemContext } from "../api/types";
import type { Session } from "../session";
import { log, logError } from "../util/logger";
import {
  LOADING_CHILDREN_TEXT,
  LOADING_ROOT_TEXT,
  logViewState,
  messageItem,
  moreItem,
  PageState,
  problemTreeItem,
} from "./common";

export const CONTEST_VIEW_ID = "contests";

export type ContestNode =
  | { kind: "contest"; value: ContestItem; key: string }
  | { kind: "detail"; value: ContestItem; key: string; forceStart?: boolean }
  | { kind: "problem"; value: ContestProblem; key: string; context: ProblemContext }
  | { kind: "more" }
  | { kind: "message"; text: string; icon?: string };

/** 我在某场比赛里的得分与排名 */
interface MyRank {
  score: number;
  rank: number;
}

/**
 * OI 赛制不显示得分和排名（和前端一致：OI 榜在比赛期间不对外实时排名）。
 * 其余赛制只有报过名 / 开过赛才查，否则榜单里也没有我这一行。
 */
function showsMyRank(record: ContestItem): boolean {
  return record.type !== 1 && (record.registered === true || record.started === true);
}

/**
 * 比赛在「详情」块上提供的操作，条件与前端一致：
 * 未报名 → 报名；进行中且已报名但没点开始 → 开始比赛（会开启计时）。
 */
type ContestAction = "register" | "start" | "none";

function contestAction(record: ContestItem, forceStart = false): ContestAction {
  if (!record.registered) {
    return "register";
  }
  if (forceStart || (record.status === 0 && record.started === false)) {
    return "start";
  }
  return "none";
}

function pageSize(): number {
  return vscode.workspace.getConfiguration("htoj").get<number>("pageSize") ?? 50;
}

function contestStatusIcon(status: number): vscode.ThemeIcon {
  switch (status) {
    case 0:
      return new vscode.ThemeIcon("debug-start", new vscode.ThemeColor("charts.green"));
    case -1:
      return new vscode.ThemeIcon("clock");
    default:
      return new vscode.ThemeIcon("check");
  }
}

function formatDuration(remainMs: number | null | undefined): string | undefined {
  if (!remainMs || remainMs <= 0) {
    return undefined;
  }
  const totalMinutes = Math.floor(remainMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}天${hours}时`;
  }
  if (hours > 0) {
    return `${hours}时${minutes}分`;
  }
  return `${minutes}分`;
}

/** 展开比赛后的「比赛详情」信息块，同时承载报名 / 开始比赛两个前置操作 */
function contestDetailItem(
  record: ContestItem,
  forceStart = false,
  myRank?: MyRank,
): vscode.TreeItem {
  const action = contestAction(record, forceStart);
  const registered = Boolean(record.registered);
  const label =
    action === "register"
      ? "比赛详情 · 点此报名"
      : action === "start"
        ? "比赛详情 · 点此开始比赛"
        : "比赛详情";
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

  // 比赛那一行已经写了赛制/状态/剩余时间，这里补上它没说的信息
  const timeHint = record.status === 1 ? "已结束" : `至 ${shortTime(record.endTime)}`;
  item.description = [
    `${record.problemCount} 题`,
    `${record.count} 人`,
    timeHint,
    myRank ? `得分 ${myRank.score}` : undefined,
    myRank ? `排名 ${myRank.rank}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  item.iconPath =
    action === "none"
      ? new vscode.ThemeIcon("info")
      : new vscode.ThemeIcon("add", new vscode.ThemeColor("charts.blue"));

  const footer =
    action === "register"
      ? "_点击此行报名参加（会先弹出确认）_"
      : action === "start"
        ? "_点击此行开始比赛（会开启计时，先弹出确认）_"
        : "_已报名，展开下方题目即可作答_";

  item.tooltip = new vscode.MarkdownString(
    [
      "**比赛详情**",
      "",
      `- 赛制：${record.typeDesc?.name ?? "-"}`,
      `- 状态：${record.statusDesc?.name ?? "-"}`,
      `- 题目数：${record.problemCount}`,
      `- 报名人数：${record.count}`,
      `- 开始：${new Date(record.startTime).toLocaleString()}`,
      `- 结束：${new Date(record.endTime).toLocaleString()}`,
      `- 报名状态：${registered ? "已报名" : "未报名"}`,
      registered ? `- 比赛状态：${record.started ? "已开始" : "未开始"}` : "",
      record.needPassword ? "- 该场比赛需要密码" : "",
      myRank ? `- 我的得分：**${myRank.score}**` : "",
      myRank ? `- 我的排名：**${myRank.rank}**` : "",
      showsMyRank(record) && !myRank ? "- 我的得分/排名：榜单里暂时没有我的成绩" : "",
      "",
      footer,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  item.contextValue =
    action === "register"
      ? "htoj.contestDetail.unregistered"
      : action === "start"
        ? "htoj.contestDetail.needstart"
        : "htoj.contestDetail";
  if (action === "register") {
    item.command = {
      command: "htoj.joinContest",
      title: "报名比赛",
      arguments: [record.id, record.gid ?? undefined],
    };
  } else if (action === "start") {
    item.command = {
      command: "htoj.startContest",
      title: "开始比赛",
      arguments: [record.id, record.gid ?? undefined],
    };
  }
  return item;
}

function shortTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 比赛视图：比赛 → 比赛题目 */
export class ContestTreeProvider implements vscode.TreeDataProvider<ContestNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly state = new PageState<ContestItem>(pageSize());
  private readonly children = new Map<number, ContestNode[]>();
  private readonly loadingChildren = new Set<number>();
  /** cid → 我的得分与排名。展开过一场就缓存下来，比赛那一行也能直接显示 */
  private readonly myRanks = new Map<number, MyRank>();

  constructor(private readonly session: Session) {}

  refresh(): void {
    this.state.reset();
    this.state.pageSize = pageSize();
    this.children.clear();
    this.loadingChildren.clear();
    this.myRanks.clear();
    this.emitter.fire();
  }

  /**
   * 状态栏倒计时用：我参与的、正在进行中的比赛，按结束时间由近到远排序。
   * 剩余时间用本地的 endTime 现算，服务端返回的 remainTime 只是快照，不能用来走秒。
   */
  activeContests(): ContestItem[] {
    const now = Date.now();
    return this.state.items
      .filter(
        (item) =>
          item.status === 0 &&
          (item.registered === true || item.started === true) &&
          item.endTime > now,
      )
      .sort((a, b) => a.endTime - b.endTime);
  }

  /** 已加载的比赛（倒计时选择器用），不改动内部状态 */
  loadedContests(): ContestItem[] {
    return [...this.state.items];
  }

  /** 状态栏倒计时用：视图没被打开时 getChildren 不会被调用，这里主动补一次加载 */
  async ensureLoaded(): Promise<void> {
    if (!this.session.isLoggedIn || this.state.page > 0 || this.state.loading) {
      return;
    }
    await this.loadMore();
  }

  /** 报名成功后就地更新状态并清掉子节点缓存，重新展开时会按已报名重新加载 */
  markRegistered(cid: number): void {
    const record = this.state.items.find((item) => item.id === cid);
    if (record) {
      record.registered = true;
    }
    this.children.delete(cid);
    this.emitter.fire();
  }

  /** 开始比赛成功后就地更新状态并清掉子节点缓存，重新展开时会当作已开始加载题目 */
  markStarted(cid: number): void {
    const record = this.state.items.find((item) => item.id === cid);
    if (record) {
      record.started = true;
    }
    this.children.delete(cid);
    this.emitter.fire();
  }

  async loadMore(): Promise<void> {
    if (!this.session.isLoggedIn) {
      log("[比赛] 未登录，跳过加载");
      return;
    }
    log(`[比赛] 开始加载第 ${this.state.page + 1} 页（limit=${this.state.pageSize}）`);
    await this.state.loadNext(async (page) => {
      const result = await contest.list(this.session.client, {
        currentPage: page,
        limit: this.state.pageSize,
      });
      return { records: result.records, total: result.total };
    });
    if (this.state.error) {
      logError("[比赛] 加载失败", this.state.error);
    } else {
      log(`[比赛] 加载完成：已有 ${this.state.items.length}/${this.state.total} 条`);
    }
    this.emitter.fire();
  }

  getTreeItem(node: ContestNode): vscode.TreeItem {
    switch (node.kind) {
      case "detail":
        return contestDetailItem(node.value, node.forceStart, this.myRanks.get(node.value.id));
      case "contest": {
        const record = node.value;
        const typeName = record.typeDesc?.name ?? "-";
        const statusName = record.statusDesc?.name ?? "-";
        const remain =
          record.status === 0 ? formatDuration(record.contestRemainTime ?? record.remainTime) : undefined;
        const myRank = this.myRanks.get(record.id);
        const item = new vscode.TreeItem(record.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = [
          typeName,
          statusName,
          remain ? `剩 ${remain}` : undefined,
          myRank ? `得分 ${myRank.score}` : undefined,
          myRank ? `排名 ${myRank.rank}` : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
        item.iconPath = contestStatusIcon(record.status);
        item.tooltip = new vscode.MarkdownString(
          [
            `**${record.title}**`,
            "",
            `- 赛制：${typeName}`,
            `- 状态：${statusName}`,
            `- 题目数：${record.problemCount}`,
            `- 报名人数：${record.count}`,
            `- 开始：${new Date(record.startTime).toLocaleString()}`,
            `- 结束：${new Date(record.endTime).toLocaleString()}`,
            record.registered ? "- 已报名" : "- 未报名（展开后可报名）",
            "",
            "_单击展开题目；右键可在浏览器中打开_",
          ].join("\n"),
        );
        // 报名入口挂在展开后的「比赛详情」块上，这里不需要再区分状态
        item.contextValue = "htoj.contest";
        return item;
      }
      case "problem": {
        const record = node.value;
        return problemTreeItem(
          {
            pid: record.pid,
            problemId: record.indexTitle || String(record.displayId),
            title: record.displayTitle || record.problemId,
            difficulty: record.difficulty,
            // 比赛题目列表里 ac/total 常为 null，此时不展示通过率
            ac: record.ac,
            total: record.total,
            tags: record.tags,
            status: record.status,
          },
          // 题目编号放描述前缀，题目本身的编号（P13034）放在标题前缀里
          { descriptionPrefix: record.problemId, context: node.context },
        );
      }
      case "more":
        return moreItem(CONTEST_VIEW_ID, this.state.items.length, this.state.total, this.state.loading);
      case "message":
        return messageItem(node.text, node.icon);
    }
  }

  getChildren(node?: ContestNode): ContestNode[] {
    if (node) {
      return node.kind === "contest" ? this.childrenOf(node.value) : [];
    }
    logViewState("比赛", this.state, `loggedIn=${this.session.isLoggedIn}`);
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

    const nodes: ContestNode[] = this.state.items.map((value) => ({
      kind: "contest" as const,
      value,
      key: String(value.id),
    }));
    if (this.state.hasMore) {
      nodes.push({ kind: "more" });
    }
    return nodes;
  }

  private childrenOf(item: ContestItem): ContestNode[] {
    const cached = this.children.get(item.id);
    if (cached) {
      return cached;
    }
    if (!this.loadingChildren.has(item.id)) {
      void this.loadContestProblems(item);
    }
    return [{ kind: "message", text: LOADING_CHILDREN_TEXT, icon: "loading~spin" }];
  }

  /**
   * 查我在本场比赛的得分与排名。
   * 榜单没有「只查我」的参数，只能按 keyword=userId 搜一遍再按 uid 匹配（前端也是这么干的）。
   */
  private async loadMyRank(item: ContestItem): Promise<MyRank | undefined> {
    if (!showsMyRank(item)) {
      return undefined;
    }
    const me = this.session.currentUser;
    if (!me) {
      return undefined;
    }
    try {
      const page = await contest.scoreboard(this.session.client, {
        cid: item.id,
        gid: item.gid ?? undefined,
        keyword: String(me.userId),
        currentPage: 1,
        limit: 20,
      });
      const row = page.records?.find((record) => record.uid === me.uid);
      if (!row) {
        log(`[比赛] 「${item.title}」榜单里没有我的成绩`);
        return undefined;
      }
      log(`[比赛] 「${item.title}」我的得分 ${row.totalScore}，排名 ${row.rank}`);
      return { score: row.totalScore, rank: row.rank };
    } catch (error) {
      logError(`[比赛] 「${item.title}」成绩表查询失败`, error);
      return undefined;
    }
  }

  private async loadContestProblems(item: ContestItem): Promise<void> {
    this.loadingChildren.add(item.id);
    log(`[比赛] 展开「${item.title}」(cid=${item.id})，加载题目中…`);
    try {
      // 题目列表和成绩表并行拉；成绩表失败不影响题目列表
      const [result, myRank] = await Promise.all([
        contest.problems(this.session.client, {
          cid: item.id,
          gid: item.gid ?? undefined,
          currentPage: 1,
          limit: 100,
        }),
        this.loadMyRank(item),
      ]);
      if (myRank) {
        this.myRanks.set(item.id, myRank);
      }
      // 比赛题目必须把 cid 一路带到详情/提交，否则后端会返回「该题目不可见」
      const gid = item.gid ?? undefined;
      const context: ProblemContext = { cid: item.id, gid };
      const nodes: ContestNode[] = [
        // 详情信息块固定放在第一项，未报名时它本身就是报名入口
        { kind: "detail", value: item, key: `detail-${item.id}` },
      ];
      const problems = result.records ?? [];
      nodes.push(
        ...problems.map((record) => ({
          kind: "problem" as const,
          value: record,
          key: `p-${item.id}-${record.pid}`,
          context,
        })),
      );
      if (problems.length === 0) {
        nodes.push({
          kind: "message",
          text: item.registered ? "该比赛暂无题目（或未开赛）" : "暂无可见题目，报名后可能解锁",
          icon: "info",
        });
      }
      log(`[比赛] 「${item.title}」加载完成：${nodes.length} 个节点`);
      this.children.set(item.id, nodes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 已报名但没点「开始比赛」时后端会拒发题目，这是预期内的，把详情块切成「开始比赛」入口
      if (message.includes("开始比赛")) {
        log(`[比赛] 「${item.title}」还没点开始比赛，改为展示开始入口`);
        this.children.set(item.id, [
          { kind: "detail", value: item, key: `detail-${item.id}`, forceStart: true },
          { kind: "message", text: "点击上方「开始比赛」后才能查看题目", icon: "info" },
        ]);
      } else {
        logError(`[比赛] 「${item.title}」题目加载失败`, error);
        this.children.set(item.id, [{ kind: "message", text: `加载失败：${message}`, icon: "error" }]);
      }
    } finally {
      this.loadingChildren.delete(item.id);
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
