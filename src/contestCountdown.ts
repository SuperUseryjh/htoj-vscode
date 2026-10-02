import * as vscode from "vscode";
import { contest } from "./api/endpoints";
import type { Session } from "./session";
import { log, logError } from "./util/logger";
import type { ContestTreeProvider } from "./views/contestTree";

const STATE_KEY = "htoj.countdownTarget";
/** 重新对齐服务端剩余时间的间隔 */
const SYNC_INTERVAL_MS = 60_000;
/** 剩余不足这个时长时转成警示配色 */
const URGENT_MS = 5 * 60_000;

/** 倒计时盯哪一场：跟随自动 / 关闭 / 手动指定 */
export type CountdownMode = "auto" | "off" | "pin";

interface CountdownTarget {
  mode: CountdownMode;
  cid?: number;
  gid?: number;
  title?: string;
}

/**
 * 服务端时间快照。
 *
 * 剩余时间必须用服务端给的 `remainTime`，不能拿 `endTime` 硬减：
 * 灵活时间制的比赛是「点了开始比赛才开始计时」，个人限时往往短于比赛窗口，
 * 用窗口结束时间算会明显偏大。拿到 remainTime 后本地按秒递减，每分钟重新对齐一次。
 */
interface Snapshot {
  /** 拉快照时的本地时间戳 */
  anchor: number;
  /** 服务端当前时间戳，用来校正本机时钟（算「距开始」时用） */
  serverNow: number;
  /** 服务端报出的剩余秒数：已开始 = 个人剩余，未点开始 = 比赛窗口剩余 */
  remainSeconds: number;
  started: boolean;
  /** -1 未开始 / 0 进行中 / 1 已结束 */
  status: number;
  statusName: string;
  typeName: string;
  startTime: number;
  endTime: number;
  /** 比赛限时（秒）。小于窗口时长说明是灵活时间制 */
  duration: number;
}

/** 倒计时文本：跨天只到「时」，一天内精确到秒 */
function formatCountdown(remainMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainMs / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days}天${pad(hours)}时`;
  }
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

/** 比赛限时短于比赛窗口 = 灵活时间制（个人自己挑一段时间参赛） */
function isFlexibleWindow(record: { duration: number; startTime: number; endTime: number }): boolean {
  return record.duration * 1000 < record.endTime - record.startTime;
}

/** 选择器里的一项，附带选中后要写入的目标 */
type Choice = vscode.QuickPickItem & { apply: () => CountdownTarget };

/**
 * 状态栏常驻的比赛倒计时。
 * 目标可以是「跟随自动」「关闭」或某一场指定的比赛，选择结果存在 globalState 里。
 */
export class ContestCountdown implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly tickTimer: ReturnType<typeof setInterval>;
  private readonly syncTimer: ReturnType<typeof setInterval>;
  private target: CountdownTarget;
  private snapshot?: Snapshot;
  /** 当前快照所属的比赛，决定点击时打开哪一场 */
  private cid?: number;
  private gid?: number;
  private title = "";
  private syncing = false;
  /** 倒数到 0 之后重新问后端的节流点，避免每秒打一次接口 */
  private zeroRetryAt = 0;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: Session,
    private readonly tree: ContestTreeProvider,
  ) {
    this.target = context.globalState.get<CountdownTarget>(STATE_KEY) ?? { mode: "auto" };
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    this.tickTimer = setInterval(() => this.render(), 1000);
    this.syncTimer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
    log(`[倒计时] 启动，目标模式 = ${this.target.mode}`);
    void this.sync();
  }

  /** 手动指定盯哪一场（比赛节点的右键菜单） */
  async track(cid: number, gid?: number): Promise<void> {
    const known = this.tree.loadedContests().find((record) => record.id === cid);
    await this.setTarget({ mode: "pin", cid, gid, title: known?.title });
  }

  /** 选择器：跟随自动 / 关闭 / 指定某一场比赛 */
  async select(): Promise<void> {
    // 列表可能还没加载过（比赛视图没打开过），先等它一把
    await this.tree.ensureLoaded();

    const choices: Choice[] = [
      {
        label: "$(sync) 跟随自动",
        description: "自动盯着我参与的、最快结束的一场",
        picked: this.target.mode === "auto",
        apply: () => ({ mode: "auto" }),
      },
      {
        label: "$(circle-slash) 关闭比赛倒计时",
        description: "不再在状态栏显示",
        picked: this.target.mode === "off",
        apply: () => ({ mode: "off" }),
      },
      { label: "", kind: vscode.QuickPickItemKind.Separator, apply: () => this.target },
    ];

    const contests = this.tree.loadedContests().filter((record) => record.status !== 1);
    if (contests.length === 0) {
      choices.push({
        label: "$(info) 还没加载到比赛列表",
        description: "可以刷新左侧「比赛」视图，或稍后重试",
        apply: () => this.target,
      });
    }
    for (const record of contests) {
      choices.push({
        label: `$(clock) ${record.title}`,
        description: [
          record.statusDesc?.name ?? (record.status === 0 ? "进行中" : "未开始"),
          record.typeDesc?.name,
          `结束 ${new Date(record.endTime).toLocaleString()}`,
          isFlexibleWindow(record) ? "灵活时间制" : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        picked: this.target.mode === "pin" && this.target.cid === record.id,
        apply: () => ({ mode: "pin", cid: record.id, gid: record.gid ?? undefined, title: record.title }),
      });
    }

    const picked = await vscode.window.showQuickPick(choices, {
      title: "比赛倒计时",
      placeHolder: "选择要挂在状态栏倒计时的比赛",
    });
    if (!picked) {
      return;
    }
    await this.setTarget(picked.apply());
  }

  /** 与后端对一次时间。到点、刚开赛、刚登录都由调用方触发 */
  async sync(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.session.isLoggedIn || this.target.mode === "off") {
      this.snapshot = undefined;
      this.render();
      return;
    }
    const target = await this.resolve();
    if (!target) {
      this.snapshot = undefined;
      this.render();
      return;
    }
    if (this.syncing) {
      return;
    }

    this.syncing = true;
    try {
      const info = await contest.info(this.session.client, { cid: target.cid, gid: target.gid });
      this.snapshot = {
        anchor: Date.now(),
        serverNow: typeof info.now === "number" ? info.now : Date.now(),
        remainSeconds: info.remainTime ?? 0,
        started: info.started === true,
        status: info.status,
        statusName: info.statusDesc?.name ?? "-",
        typeName: info.typeDesc?.name ?? "-",
        startTime: info.startTime,
        endTime: info.endTime,
        duration: info.duration,
      };
      this.cid = info.id;
      this.gid = info.gid ?? target.gid;
      this.title = info.title || target.title;
      log(
        `[倒计时] 已对齐「${this.title}」：剩余 ${info.remainTime} 秒，` +
          `started=${info.started} status=${info.status}`,
      );
    } catch (error) {
      // 保留旧快照继续本地走秒，下个周期再试
      logError("[倒计时] 同步失败", error);
    } finally {
      this.syncing = false;
      this.render();
    }
  }

  private async setTarget(target: CountdownTarget): Promise<void> {
    this.target = target;
    this.snapshot = undefined;
    await this.context.globalState.update(STATE_KEY, target);
    log(`[倒计时] 目标已更新：${JSON.stringify(target)}`);
    await this.sync();
  }

  /** 当前应该盯哪一场 */
  private async resolve(): Promise<{ cid: number; gid?: number; title: string } | undefined> {
    if (this.target.mode === "pin" && typeof this.target.cid === "number") {
      return { cid: this.target.cid, gid: this.target.gid, title: this.target.title ?? "" };
    }
    if (this.target.mode === "auto") {
      let record = this.tree.activeContests()[0];
      if (!record) {
        // 比赛视图一直没打开过的话列表还是空的，等它加载一把再挑
        await this.tree.ensureLoaded();
        record = this.tree.activeContests()[0];
      }
      if (!record) {
        return undefined;
      }
      return { cid: record.id, gid: record.gid ?? undefined, title: record.title };
    }
    return undefined;
  }

  /** 以服务端时间为基准的本机「现在」，用来算距开始 / 距窗口结束 */
  private serverNowEstimate(): number {
    if (!this.snapshot) {
      return Date.now();
    }
    return this.snapshot.serverNow + (Date.now() - this.snapshot.anchor);
  }

  /** 个人计时剩余（仅在已点击「开始比赛」时有意义） */
  private personalRemainMs(): number {
    if (!this.snapshot) {
      return 0;
    }
    return Math.max(0, this.snapshot.remainSeconds * 1000 - (Date.now() - this.snapshot.anchor));
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    const snapshot = this.snapshot;
    if (!this.session.isLoggedIn || this.target.mode === "off" || !snapshot || snapshot.status === 1) {
      this.item.hide();
      return;
    }

    // 已点开始 = 个人倒计时；没点开始 = 离比赛窗口关闭还有多久
    let remainMs: number;
    let caption: string;
    let hint: string;
    if (snapshot.status === -1) {
      remainMs = snapshot.startTime - this.serverNowEstimate();
      caption = "距开始";
      hint = "比赛尚未开始";
    } else if (snapshot.started) {
      remainMs = this.personalRemainMs();
      caption = "个人";
      hint = isFlexibleWindow(snapshot) ? "灵活时间制，从点击开始比赛起计时" : "个人倒计时中";
    } else {
      remainMs = snapshot.endTime - this.serverNowEstimate();
      caption = "窗口剩";
      hint = isFlexibleWindow(snapshot)
        ? "灵活时间制：点「开始比赛」后才开始个人计时，现在是比赛窗口的截止时间"
        : "还没点「开始比赛」，能看到题目但不能计时";
    }

    if (remainMs <= 0) {
      remainMs = 0;
      // 到点了：去问后端要新状态（比赛开始 / 结束 / 个人时间用尽）。别每秒都问
      if (Date.now() >= this.zeroRetryAt) {
        this.zeroRetryAt = Date.now() + 30_000;
        void this.sync();
      }
    }

    const title = this.title.length > 12 ? `${this.title.slice(0, 12)}…` : this.title;
    this.item.text = `$(clock) ${title} ${caption} ${formatCountdown(remainMs)}`;

    const personalEnd =
      snapshot.started && snapshot.remainSeconds * 1000 > 0
        ? new Date(snapshot.anchor + snapshot.remainSeconds * 1000).toLocaleString()
        : undefined;
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**${this.title}**`,
        "",
        `- 赛制：${snapshot.typeName}`,
        `- 状态：${snapshot.statusName}`,
        `- 剩余：${formatCountdown(remainMs)}（${caption}）`,
        personalEnd ? `- 个人计时结束：${personalEnd}` : "",
        `- 比赛窗口：${new Date(snapshot.startTime).toLocaleString()} ~ ${new Date(snapshot.endTime).toLocaleString()}`,
        isFlexibleWindow(snapshot) ? "- 该场为灵活时间制，个人限时短于比赛窗口" : "",
        "",
        `_${hint}_`,
        "_左键在浏览器中打开该场比赛；用「核桃OJ: 选择倒计时比赛」可换一场或关掉_",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    this.item.command =
      this.cid === undefined
        ? undefined
        : {
            command: "htoj.openContestInBrowser",
            title: "在浏览器中打开比赛",
            arguments: [{ value: { id: this.cid, gid: this.gid } }],
          };

    const urgent = remainMs > 0 && remainMs < URGENT_MS;
    this.item.color = urgent ? new vscode.ThemeColor("statusBarItem.warningForeground") : undefined;
    this.item.backgroundColor = urgent
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    this.item.show();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.tickTimer);
    clearInterval(this.syncTimer);
    this.item.dispose();
  }
}
