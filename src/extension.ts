import * as vscode from "vscode";
import { HtojApiError } from "./api/client";
import { contest, problem, training } from "./api/endpoints";
import type { ProblemContext, ProblemDetail, SubmissionDetail, TestJudgeResult } from "./api/types";
import { openCodeFile, parseProblemFromDocument } from "./codeFile";
import { ContestCountdown } from "./contestCountdown";
import { Session } from "./session";
import { getChannel, log, logError } from "./util/logger";
import { ContestTreeProvider } from "./views/contestTree";
import { ProblemPanel } from "./views/problemPanel";
import { showQrLoginPanel } from "./views/loginPanel";
import { ProblemTreeProvider } from "./views/problemTree";
import { TrainingTreeProvider } from "./views/trainingTree";

function config() {
  return vscode.workspace.getConfiguration("htoj");
}

function zoneSlug(): string {
  return config().get<string>("zone") ?? "cpp";
}

function browserUrl(path: string): vscode.Uri {
  return vscode.Uri.parse(`https://htoj.com.cn/${zoneSlug()}${path}`);
}

/** 题目页路径。比赛/题单/小组题目必须带上对应 id，否则网页端也会提示不可见 */
function problemPagePath(pid: number, context?: ProblemContext): string {
  const query = [`pid=${pid}`];
  if (context?.cid) {
    query.push(`cid=${context.cid}`);
  }
  if (context?.tid) {
    query.push(`tid=${context.tid}`);
  }
  if (context?.gid) {
    query.push(`gid=${context.gid}`);
  }
  return `/oj/problem/detail?${query.join("&")}`;
}

/** 合并两份上下文，后者优先 */
function mergeContext(
  base?: ProblemContext,
  override?: ProblemContext,
): ProblemContext | undefined {
  const merged: ProblemContext = { ...base, ...override };
  for (const key of ["cid", "tid", "gid"] as const) {
    if (!merged[key]) {
      delete merged[key];
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof HtojApiError) {
    return error.isUnauthorized ? "登录已失效，请重新登录。" : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 解析命令参数里的题目信息。
 * 命令面板调用时传数字 pid；视图的右键菜单会把树节点对象传进来。
 */
function resolveProblemArg(
  arg: unknown,
): { pid: number; context?: ProblemContext } | undefined {
  if (typeof arg === "number") {
    return { pid: arg };
  }
  if (arg && typeof arg === "object") {
    const node = arg as {
      pid?: number;
      value?: { pid?: number };
      context?: ProblemContext;
    };
    if (typeof node.pid === "number") {
      return { pid: node.pid, context: node.context };
    }
    if (node.value && typeof node.value.pid === "number") {
      return { pid: node.value.pid, context: node.context };
    }
  }
  return undefined;
}

/**
 * 解析命令参数里的比赛信息。
 * 报名节点直接传 cid 数字；比赛树的右键菜单会传节点对象。
 */
function resolveContestArg(arg: unknown): { cid: number; gid?: number } | undefined {
  if (typeof arg === "number") {
    return { cid: arg };
  }
  if (arg && typeof arg === "object") {
    const node = arg as { value?: { id?: number; gid?: number | null } };
    if (node.value && typeof node.value.id === "number") {
      return { cid: node.value.id, gid: node.value.gid ?? undefined };
    }
  }
  return undefined;
}

/**
 * 从比赛链接里解析 cid / gid。
 * 支持整条链接（`.../contest/detail?cid=123&gid=456`）、参数片段（`cid=123&gid=456`）或纯数字 cid。
 */
function parseContestRef(input: string): { cid: number; gid?: number } | undefined {
  const text = input.trim();
  const cidText = /[?&#]?cid=(\d+)/.exec(text)?.[1] ?? (/^\d+$/.test(text) ? text : undefined);
  if (!cidText) {
    return undefined;
  }
  const gidText = /[?&#]?gid=(\d+)/.exec(text)?.[1];
  return { cid: Number(cidText), gid: gidText ? Number(gidText) : undefined };
}

/**
 * 从题目链接解析 pid 和上下文。
 * 比赛题/题单题/小组题必须把 cid / tid / gid 一起带上，否则后端返回「该题目不可见」。
 */
function parseProblemRef(input: string): { pid: number; context?: ProblemContext } | undefined {
  const text = input.trim();
  const pidText = /[?&#]?pid=(\d+)/.exec(text)?.[1] ?? (/^\d+$/.test(text) ? text : undefined);
  if (!pidText) {
    return undefined;
  }
  const context: ProblemContext = {};
  const cid = /[?&#]?cid=(\d+)/.exec(text)?.[1];
  const tid = /[?&#]?tid=(\d+)/.exec(text)?.[1];
  const gid = /[?&#]?gid=(\d+)/.exec(text)?.[1];
  if (cid) {
    context.cid = Number(cid);
  }
  if (tid) {
    context.tid = Number(tid);
  }
  if (gid) {
    context.gid = Number(gid);
  }
  return { pid: Number(pidText), context: Object.keys(context).length > 0 ? context : undefined };
}

/** 从题单链接解析 tid / gid（小组题单必须带 gid） */
function parseTrainingRef(input: string): { tid: number; gid?: number } | undefined {
  const text = input.trim();
  const tidText = /[?&#]?tid=(\d+)/.exec(text)?.[1] ?? (/^\d+$/.test(text) ? text : undefined);
  if (!tidText) {
    return undefined;
  }
  const gidText = /[?&#]?gid=(\d+)/.exec(text)?.[1];
  return { tid: Number(tidText), gid: gidText ? Number(gidText) : undefined };
}

/** 解析命令参数里的题单 tid：可能是数字，也可能是题单树的节点对象 */
function resolveTrainingArg(arg: unknown): number | undefined {
  if (typeof arg === "number") {
    return arg;
  }
  if (arg && typeof arg === "object") {
    const node = arg as { value?: { id?: number } };
    if (node.value && typeof node.value.id === "number") {
      return node.value.id;
    }
  }
  return undefined;
}

const PROVIDER_IDS = ["problems", "trainings", "contests"] as const;
type ProviderId = (typeof PROVIDER_IDS)[number];

/** 只考虑工作区里的真实文件，输出面板、webview 之类都不能拿来提交 */
function isSubmitCandidate(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file";
}

function baseName(fileName: string): string {
  return fileName.split(/[\\/]/).pop() ?? fileName;
}

/** 列出候选编辑器让用户挑；没有候选就直接弹「打开文件」 */
async function chooseSubmitEditor(
  candidates: vscode.TextEditor[],
): Promise<vscode.TextEditor | undefined> {
  type Choice = vscode.QuickPickItem & { editor?: vscode.TextEditor; open?: boolean };
  if (candidates.length > 0) {
    const items: Choice[] = candidates.map((editor) => ({
      label: `$(file-code) ${baseName(editor.document.fileName)}`,
      description: vscode.workspace.asRelativePath(editor.document.uri, false),
      editor,
    }));
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: "$(folder-opened) 打开其他文件…", open: true });

    const picked = await vscode.window.showQuickPick(items, {
      title: "提交代码",
      placeHolder: "要提交哪个文件里的代码？",
    });
    if (!picked) {
      return undefined;
    }
    if (picked.editor) {
      // 已经在某个分栏里打开着，就地显示，别把它挪到别的栏去
      return vscode.window.showTextDocument(picked.editor.document, {
        preview: false,
        viewColumn: picked.editor.viewColumn,
      });
    }
  }

  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    title: "选择要提交的代码文件",
    filters: { 代码文件: ["cpp", "cc", "cxx", "c", "py", "java", "txt"], 所有文件: ["*"] },
  });
  if (!uris?.length) {
    return undefined;
  }
  const document = await vscode.workspace.openTextDocument(uris[0]);
  // 开在旁边，题面面板不会被顶掉
  return vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside,
  });
}

/**
 * 选出要提交哪个编辑器里的代码。
 *
 * 在题目面板里点「提交当前文件」时焦点在 webview 上，`activeTextEditor` 是空的，
 * 这时从分屏里找代码文件（优先带 `@htoj` 标记的、pid 对得上的那一份）；
 * 分屏里也找不到唯一答案时，弹选择器让用户自己指定。
 */
async function pickSubmitEditor(pid?: number): Promise<vscode.TextEditor | undefined> {
  const active = vscode.window.activeTextEditor;
  if (active && isSubmitCandidate(active.document)) {
    return active;
  }

  const candidates = vscode.window.visibleTextEditors.filter((editor) =>
    isSubmitCandidate(editor.document),
  );
  const marked = candidates
    .map((editor) => ({ editor, ref: parseProblemFromDocument(editor.document) }))
    .filter((item) => item.ref !== undefined);
  const sameProblem = pid === undefined ? [] : marked.filter((item) => item.ref?.pid === pid);

  if (sameProblem.length === 1) {
    return sameProblem[0].editor;
  }
  if (marked.length === 1) {
    return marked[0].editor;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  return chooseSubmitEditor(candidates);
}

export function activate(context: vscode.ExtensionContext): void {
  const session = new Session(context.secrets);
  // 三个树都支持「按链接手动添加」，需要 globalState 做持久化
  const problemTree = new ProblemTreeProvider(session, context.globalState);
  const trainingTree = new TrainingTreeProvider(session, context.globalState);
  const contestTree = new ContestTreeProvider(session, context.globalState);

  log("================ 核桃OJ 扩展已激活 ================");
  log(
    "VSCode",
    vscode.version,
    "| Node",
    process.version,
    "| globalThis.fetch =",
    typeof globalThis.fetch,
  );
  log(
    "配置：apiBase =",
    config().get<string>("apiBase"),
    "zone =",
    config().get<string>("zone"),
    "pageSize =",
    config().get<number>("pageSize"),
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "htoj.menu";
  statusBar.show();

  const updateStatusBar = () => {
    if (!session.isLoggedIn) {
      statusBar.text = "$(sign-in) 核桃OJ：未登录";
      statusBar.tooltip = "点击登录";
      return;
    }
    const zone = zoneSlug() === "python" ? "Python" : "C++";
    statusBar.text = `$(account) ${session.displayName} · ${zone}`;
    statusBar.tooltip = `核桃OJ 已登录（${session.displayName}）`;
  };

  // ---------------------------------------------------------------------
  // 比赛倒计时（状态栏常驻，详见 contestCountdown.ts）
  // ---------------------------------------------------------------------
  const contestCountdown = new ContestCountdown(context, session, contestTree);
  // 每 5 分钟重拉一次比赛列表：新开赛 / 刚结束的场次都能被自动模式发现
  const contestListTimer = setInterval(() => {
    contestTree.refresh();
    void contestCountdown.sync();
  }, 5 * 60_000);

  context.subscriptions.push(contestCountdown, {
    dispose: () => clearInterval(contestListTimer),
  });

  // ---------------------------------------------------------------------
  // 视图
  // ---------------------------------------------------------------------
  context.subscriptions.push(
    vscode.window.createTreeView("htoj.problems", { treeDataProvider: problemTree }),
    vscode.window.createTreeView("htoj.trainings", { treeDataProvider: trainingTree }),
    vscode.window.createTreeView("htoj.contests", { treeDataProvider: contestTree }),
    problemTree,
    trainingTree,
    contestTree,
    session,
    statusBar,
  );

  const loadMoreMap: Record<ProviderId, () => Promise<void>> = {
    problems: () => problemTree.loadMore(),
    trainings: () => trainingTree.loadMore(),
    contests: () => contestTree.loadMore(),
  };

  session.onDidChange(() => {
    log("[session] 登录状态变化，刷新三个视图（已登录 =", session.isLoggedIn, "）");
    updateStatusBar();
    problemTree.refresh();
    trainingTree.refresh();
    contestTree.refresh();
    void contestCountdown.sync();
  });

  // 当前文件是否带 htoj 标记（用于快捷键生效范围）
  const syncEditorContext = () => {
    const editor = vscode.window.activeTextEditor;
    const isHtoj = Boolean(editor && parseProblemFromDocument(editor.document));
    void vscode.commands.executeCommand("setContext", "htoj.isHtojFile", isHtoj);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(syncEditorContext),
    vscode.workspace.onDidOpenTextDocument(syncEditorContext),
  );

  // ---------------------------------------------------------------------
  // 登录
  // ---------------------------------------------------------------------
  const requireLogin = (): boolean => {
    if (session.isLoggedIn) {
      return true;
    }
    void vscode.window.showWarningMessage("请先登录核桃OJ。", "登录").then((choice) => {
      if (choice === "登录") {
        void vscode.commands.executeCommand("htoj.login");
      }
    });
    return false;
  };

  /**
   * 统一登录入口：先让用户挑登录方式，再转给对应的具体命令。
   * 侧边栏欢迎语、状态栏菜单、requireLogin 的提示、题目列表的「重新登录」都走这里，
   * 新增登录方式时只改这一处 + 一个命令。
   */
  const doLoginMenu = async (): Promise<void> => {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "$(device-mobile) 微信扫码登录",
          description: "手机扫码并在微信里确认，最省事",
          value: "htoj.loginByQr",
        },
        {
          label: "$(key) 手机号 + 密码登录",
          description: "需要账号已设置密码",
          value: "htoj.loginByPassword",
        },
        {
          label: "$(clippy) 粘贴 Token 登录",
          description: "从浏览器 DevTools 复制 KEY_USER_LOGIN_TOKEN",
          value: "htoj.loginWithToken",
        },
      ],
      { title: "登录核桃OJ", placeHolder: "选择登录方式" },
    );
    if (picked) {
      await vscode.commands.executeCommand(picked.value);
    }
  };

  const doLoginByQr = async (): Promise<void> => {
    const token = await showQrLoginPanel(session, context.extensionUri);
    if (!token) {
      return;
    }
    try {
      const user = await session.loginWithToken(token);
      void vscode.window.showInformationMessage(`登录成功，欢迎 ${user.nickname || user.username}！`);
    } catch (error) {
      void vscode.window.showErrorMessage(`登录失败：${errorMessage(error)}`);
    }
  };

  const doLoginWithToken = async (): Promise<void> => {
    const token = await vscode.window.showInputBox({
      title: "粘贴核桃OJ Token",
      prompt: "在浏览器登录 htoj.com.cn 后，从 DevTools → Application → Local Storage 复制 KEY_USER_LOGIN_TOKEN 的值",
      placeHolder: "eyJhbGciOi...",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length < 20 ? "Token 看起来不完整" : undefined),
    });
    if (!token) {
      return;
    }
    try {
      const user = await session.loginWithToken(token);
      void vscode.window.showInformationMessage(`登录成功，欢迎 ${user.nickname || user.username}！`);
    } catch (error) {
      void vscode.window.showErrorMessage(`登录失败：${errorMessage(error)}`);
    }
  };

  const doLoginByPassword = async (): Promise<void> => {
    const phoneNumber = await vscode.window.showInputBox({
      title: "手机号登录（第 1/2 步）",
      prompt: "请输入手机号",
      placeHolder: "13800138000",
      ignoreFocusOut: true,
      validateInput: (value) => (/^1\d{10}$/.test(value.trim()) ? undefined : "请输入 11 位手机号"),
    });
    if (!phoneNumber) {
      return;
    }
    const password = await vscode.window.showInputBox({
      title: "手机号登录（第 2/2 步）",
      prompt: "请输入密码（账号需已设置密码）",
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) {
      return;
    }
    try {
      const user = await session.loginByPassword(phoneNumber.trim(), password);
      void vscode.window.showInformationMessage(`登录成功，欢迎 ${user.nickname || user.username}！`);
    } catch (error) {
      void vscode.window.showErrorMessage(`登录失败：${errorMessage(error)}`);
    }
  };

  // ---------------------------------------------------------------------
  // 打开题目 / 提交
  // ---------------------------------------------------------------------
  const panelDeps = {
    session,
    onOpenCodeFile: async (pid: number, problemId: string, context?: ProblemContext) => {
      try {
        await openCodeFile(session, { pid, problemId, context });
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessage(error));
      }
    },
    onSubmit: async (pid: number, context?: ProblemContext) => {
      await submitProblem(pid, context);
    },
    onSubmitAnswers: async (
      pid: number,
      context: ProblemContext | undefined,
      payload: { kind: "choice" | "objective"; code?: string; answers?: Record<string, string> },
    ) => {
      await submitAnswers(pid, context, payload);
    },
    onSelfTest: async (pid: number, context: ProblemContext | undefined, userInput: string) => {
      const target = await resolveTarget("自测", pid, context);
      if (!target) {
        throw new Error("没有选定要自测的代码文件。");
      }
      return runSelfTest(target, userInput);
    },
    onOpenInBrowser: (pid: number, context?: ProblemContext) => {
      void vscode.env.openExternal(browserUrl(problemPagePath(pid, context)));
    },
  };

  const openProblem = async (pid: number, context?: ProblemContext): Promise<void> => {
    if (!requireLogin()) {
      return;
    }
    await ProblemPanel.show(panelDeps, pid, context);
  };

  /** 提交 / 自测共用的一次「目标解析」结果 */
  interface SubmitTarget {
    editor: vscode.TextEditor;
    pid: number;
    context: ProblemContext | undefined;
    code: string;
    language: string;
    /** 题目详情，已确认是 OJ 编程题 */
    detail: ProblemDetail;
  }

  /**
   * 解析「要操作哪道题的哪份代码」：选编辑器 → 定位 pid → 拉题目详情。
   * 用户取消时返回 undefined；接口出错时抛出，交给调用方按自己的口径提示。
   */
  const resolveTarget = async (
    scope: string,
    pidArg?: number,
    contextArg?: ProblemContext,
  ): Promise<SubmitTarget | undefined> => {
    if (!requireLogin()) {
      return undefined;
    }
    const editor = await pickSubmitEditor(pidArg);
    if (!editor) {
      log(`[${scope}] 用户没有选定要操作的文件，已取消`);
      return undefined;
    }
    if (editor.document.isDirty) {
      await editor.document.save();
    }

    const fromFile = parseProblemFromDocument(editor.document);
    const panel = ProblemPanel.active;
    const pid = pidArg ?? fromFile?.pid ?? panel?.currentPid;
    if (!pid) {
      void vscode.window.showWarningMessage(
        "无法确定要操作哪道题：请先从题目列表打开题目，或使用「新建/打开本地代码文件」。",
      );
      return undefined;
    }

    // 比赛/题单题目的上下文：文件标记或当前面板里带的，显式传参优先
    const derived =
      fromFile?.pid === pid
        ? fromFile.context
        : panel?.currentPid === pid
          ? panel.currentContext
          : undefined;
    const context = mergeContext(derived, contextArg);

    const code = editor.document.getText();
    if (!code.trim()) {
      void vscode.window.showWarningMessage("当前文件是空的。");
      return undefined;
    }

    const language = /\.py$/i.test(editor.document.fileName)
      ? "Python3"
      : (config().get<string>("defaultLanguage") ?? "C++17 With O2");

    log(
      `[${scope}] 文件=${editor.document.fileName} pid=${pid}（来源：${
        pidArg !== undefined ? "参数" : fromFile ? "文件标记" : "当前面板"
      }）language=${language} 代码长度=${code.length}`,
      context ? `上下文=${JSON.stringify(context)}` : "无上下文",
    );

    const detail = await problem.detail(session.client, pid, context);
    // 选择题 / 客观题交的是答案不是代码，别让提交/自测把文件内容当成答案送上去
    if (detail.problemBaseVO.type !== 1) {
      void vscode.window.showWarningMessage("这是选择题/客观题，请在题面面板里作答后点「提交答案」。");
      return undefined;
    }
    return { editor, pid, context, code, language, detail };
  };

  /**
   * 提交前的体积检查。超过上限就不提交，改成提示去跑自测。
   * 返回 true 表示已经拦下这次提交。
   */
  const rejectOversizedCode = (
    code: string,
    pid: number,
    context: ProblemContext | undefined,
  ): boolean => {
    const maxBytes = config().get<number>("maxSubmitBytes") ?? 102400;
    if (maxBytes <= 0) {
      return false;
    }
    const bytes = Buffer.byteLength(code, "utf8");
    if (bytes <= maxBytes) {
      return false;
    }
    log(`[提交] 文件过大：${bytes} 字节 > 上限 ${maxBytes} 字节，已取消提交`);
    void vscode.window
      .showWarningMessage(
        `代码文件过大（${(bytes / 1024).toFixed(1)} KB，超过 ${(maxBytes / 1024).toFixed(1)} KB 上限），已取消提交。可以用「运行自测」验证代码是否跑得起来（自测不产生提交记录）。`,
        "运行自测",
      )
      .then((choice) => {
        if (choice === "运行自测") {
          void vscode.commands.executeCommand("htoj.selfTest", { pid, context });
        }
      });
    return true;
  };

  /** 提交代码并轮询评测结果 */
  const submitProblem = async (pidArg?: number, contextArg?: ProblemContext): Promise<void> => {
    try {
      const target = await resolveTarget("提交", pidArg, contextArg);
      if (!target) {
        return;
      }
      const { pid, context, code, language, detail } = target;
      if (rejectOversizedCode(code, pid, context)) {
        return;
      }
      const ioMode = detail.problemOjDetailVO?.ioMode?.id ?? 1;
      const displayId = detail.problemBaseVO.problemId;
      log(`[提交] 题目 ${displayId}，ioMode=${ioMode}`);
      await runSubmission(pid, context, displayId, { id: pid, ioMode, language, code, ...context });
    } catch (error) {
      logError("[提交] 失败", error);
      void vscode.window.showErrorMessage(`提交失败：${errorMessage(error)}`);
    }
  };

  /**
   * 提交选择题 / 客观题的答案。
   * 后端只接受字符串值，多选是逗号拼接的选项（客观题）或选项 id（选择题）。
   * 两类都不带 ioMode，靠 language 区分：客观题 "objective"，选择题 "choice"。
   */
  const submitAnswers = async (
    pid: number,
    context: ProblemContext | undefined,
    payload: { kind: "choice" | "objective"; code?: string; answers?: Record<string, string> },
  ): Promise<void> => {
    if (!requireLogin()) {
      return;
    }
    try {
      const detail = await problem.detail(session.client, pid, context);
      const displayId = detail.problemBaseVO.problemId;
      const body =
        payload.kind === "objective"
          ? { id: pid, language: "objective", answers: payload.answers ?? {}, ...context }
          : { id: pid, language: "choice", code: payload.code, ...context };
      log(
        `[提交] ${payload.kind} pid=${pid}（${displayId}）`,
        payload.kind === "objective"
          ? `答案=${JSON.stringify(payload.answers)}`
          : `选项=${payload.code}`,
        context ? `上下文=${JSON.stringify(context)}` : "无上下文",
      );
      await runSubmission(pid, context, displayId, body);
    } catch (error) {
      logError(`[提交] ${payload.kind} 失败`, error);
      void vscode.window.showErrorMessage(`提交失败：${errorMessage(error)}`);
    }
  };

  /** 轮询评测结果，直到 resultCode !== 0 */
  const pollSubmission = async (submitId: number): Promise<SubmissionDetail> => {
    const interval = config().get<number>("pollIntervalMs") ?? 2000;
    const timeout = config().get<number>("pollTimeoutMs") ?? 60000;
    const deadline = Date.now() + timeout;

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `评测中（提交号 ${submitId}）`,
        cancellable: true,
      },
      async (progress, token) => {
        for (;;) {
          progress.report({ message: "等待结果…" });
          const detail = await problem.submissionDetail(session.client, submitId);
          if (detail.resultCode !== 0) {
            return detail;
          }
          if (token.isCancellationRequested) {
            return detail;
          }
          if (Date.now() > deadline) {
            throw new Error(`评测超时（${timeout / 1000}s），可稍后用「查看本题提交记录」查看结果。`);
          }
          await new Promise((resolve) => setTimeout(resolve, interval));
        }
      },
    );
  };

  /** 提交 → 轮询 → 展示结果，OJ 与选择题/客观题共用 */
  const runSubmission = async (
    pid: number,
    context: ProblemContext | undefined,
    displayId: string,
    body: Parameters<typeof problem.submit>[1],
  ): Promise<void> => {
    const submitId = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在提交 ${displayId}…`,
        cancellable: false,
      },
      async (progress) => {
        const id = await problem.submit(session.client, body);
        log(`[提交] 提交成功，submitId=${id}`);
        progress.report({ message: "已提交，等待评测结果…" });
        return id;
      },
    );
    const result = await pollSubmission(submitId);
    await reportResult(pid, displayId, result, context);
  };

  /** 展示评测结果 */
  const reportResult = async (
    pid: number,
    displayId: string,
    detail: SubmissionDetail,
    context?: ProblemContext,
  ): Promise<void> => {
    const scoreText = detail.score === null ? "" : `，得分 ${detail.score}`;
    if (detail.resultCode === 1) {
      void vscode.window.showInformationMessage(`${displayId} 评测通过${scoreText}。`);
    } else {
      const statusName = detail.status?.name ?? "评测未通过";
      void vscode.window
        .showWarningMessage(`${displayId} ${statusName}${scoreText}。`, "查看详情")
        .then((choice) => {
          if (choice === "查看详情") {
            void ProblemPanel.show(panelDeps, pid, context).then((panel) => panel.showResult(detail));
          }
        });
    }

    const panel = ProblemPanel.active;
    if (panel && panel.currentPid === pid) {
      void panel.showResult(detail);
    } else {
      const opened = await ProblemPanel.show(panelDeps, pid, context);
      void opened.showResult(detail);
    }
  };

  // ---------------------------------------------------------------------
  // 自测运行（不产生提交记录）
  // ---------------------------------------------------------------------
  /** 手动输入走 userInput，服务端上限 1MB */
  const SELF_TEST_INPUT_LIMIT = 1024 * 1024;

  /**
   * 提交自测并轮询结果。
   * 与网页端行为一致：2 秒一次；自测没有 submissionId，只有 testJudgeKey。
   *
   * 进度条故意设成不可取消：一旦中途取消就会拿到 resultCode=0 的半成品，
   * 结果区只剩一句「运行中…」，输出就「看不见」了。超时上限已经能兜底。
   */
  const runSelfTest = async (
    target: SubmitTarget,
    userInput: string,
  ): Promise<TestJudgeResult> =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在运行自测…", cancellable: false },
      async (progress) => {
        const ioMode = target.detail.problemOjDetailVO?.ioMode?.id ?? 1;
        log(
          `[自测] pid=${target.pid} ioMode=${ioMode} language=${target.language} 输入长度=${userInput.length}`,
        );
        const testJudgeKey = await problem.testSubmit(session.client, {
          id: target.pid,
          ioMode,
          language: target.language,
          code: target.code,
          userInput,
          ...target.context,
        });
        log(`[自测] 已提交，testJudgeKey=${testJudgeKey}`);

        const interval = config().get<number>("pollIntervalMs") ?? 2000;
        const timeout = config().get<number>("pollTimeoutMs") ?? 60000;
        const deadline = Date.now() + timeout;
        for (;;) {
          progress.report({ message: "等待运行结果…" });
          const result = await problem.testResult(session.client, testJudgeKey);
          if (result.resultCode !== 0) {
            const size = (value: string | null | undefined) =>
              value === null || value === undefined ? "null" : `${value.length}字符`;
            log(
              `[自测] 结果 resultCode=${result.resultCode} status=${result.status?.name ?? "-"} ` +
                `输出=${size(result.userOutput)} 错误输出=${size(result.stderr)}`,
            );
            if (result.userOutput) {
              log(`[自测] 输出内容：${JSON.stringify(result.userOutput.slice(0, 500))}`);
            }
            if (result.stderr) {
              log(`[自测] 错误输出内容：${JSON.stringify(result.stderr.slice(0, 500))}`);
            }
            return result;
          }
          if (Date.now() > deadline) {
            throw new Error(`自测超时（${timeout / 1000}s）。`);
          }
          await new Promise((resolve) => setTimeout(resolve, interval));
        }
      },
    );

  /** 命令行自测的输入从哪来：文件 / 手动单行 / 空输入 */
  const pickSelfTestInput = async (): Promise<string | undefined> => {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "$(file) 从文件读取测试输入…", description: "适合多行或较大的输入", value: "file" as const },
        { label: "$(edit) 手动输入（单行）", description: "多行输入建议用题面面板里的自测区", value: "manual" as const },
        { label: "$(debug-start) 不输入，直接运行", value: "empty" as const },
      ],
      { title: "自测输入", placeHolder: "用哪份数据运行这次自测？" },
    );
    if (!picked) {
      return undefined;
    }
    if (picked.value === "empty") {
      return "";
    }
    if (picked.value === "manual") {
      return vscode.window.showInputBox({
        title: "自测输入（单行）",
        prompt: "服务端手动输入上限 1MB",
        ignoreFocusOut: true,
      });
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      title: "选择测试输入文件",
      filters: { 测试数据: ["in", "txt", "out", "ans"], 所有文件: ["*"] },
    });
    if (!uris?.length) {
      return undefined;
    }
    const bytes = await vscode.workspace.fs.readFile(uris[0]);
    if (bytes.byteLength > SELF_TEST_INPUT_LIMIT) {
      void vscode.window.showWarningMessage(
        `输入文件过大（${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB），服务端手动输入上限为 1MB。`,
      );
      return undefined;
    }
    return Buffer.from(bytes).toString("utf8");
  };

  /** 自测结果 → 纯文本（写进输出面板用） */
  const formatTestResult = (displayId: string, result: TestJudgeResult): string => {
    const status = result.status?.chineseName || result.status?.name || "未知";
    const lines = [`===== ${displayId} 自测（${status}） =====`];
    if (result.time !== null || result.memory !== null) {
      lines.push(`用时 ${result.time ?? "-"}ms · 内存 ${result.memory ?? "-"}KB`);
    }
    if (result.userInput) {
      lines.push("--- 输入 ---", result.userInput);
    }
    if (result.userOutput) {
      lines.push("--- 输出 ---", result.userOutput);
    }
    if (result.stderr) {
      lines.push("--- 错误输出 ---", result.stderr);
    }
    if (result.expectedOutput) {
      lines.push("--- 期望输出 ---", result.expectedOutput);
    }
    return lines.join("\n");
  };

  /** 命令行自测的结果：摘要弹窗 + 完整内容追加到输出面板 */
  const reportSelfTest = (displayId: string, result: TestJudgeResult): void => {
    const channel = getChannel();
    channel.appendLine("");
    channel.appendLine(formatTestResult(displayId, result));

    const ok = result.resultCode === 1;
    const status = result.status?.chineseName || result.status?.name || "未知";
    const meta = [
      result.time === null ? undefined : `${result.time}ms`,
      result.memory === null ? undefined : `${result.memory}KB`,
    ]
      .filter(Boolean)
      .join(" · ");
    const message = `自测${ok ? "通过" : "未通过"}：${status}${meta ? `（${meta}）` : ""}`;
    const chosen = ok
      ? vscode.window.showInformationMessage(message, "查看输出")
      : vscode.window.showWarningMessage(message, "查看输出");
    void chosen.then((choice) => {
      if (choice === "查看输出") {
        channel.show(true);
      }
    });
  };

  // ---------------------------------------------------------------------
  // 命令注册
  // ---------------------------------------------------------------------
  const register = (id: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register("htoj.login", doLoginMenu);
  register("htoj.loginByQr", doLoginByQr);
  register("htoj.loginWithToken", doLoginWithToken);
  register("htoj.loginByPassword", doLoginByPassword);

  register("htoj.logout", async () => {
    await session.logout();
    void vscode.window.showInformationMessage("已退出核桃OJ。");
  });

  register("htoj.switchZone", async () => {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "C++", description: "对应站点 /cpp/", value: "cpp" as const },
        { label: "Python", description: "对应站点 /py/", value: "python" as const },
      ],
      { title: "切换题库语言" },
    );
    if (picked) {
      await session.setZone(picked.value);
      void vscode.window.showInformationMessage(`已切换到 ${picked.label} 题库。`);
    }
  });

  register("htoj.refresh", () => {
    problemTree.refresh();
    trainingTree.refresh();
    contestTree.refresh();
    void contestCountdown.sync();
  });

  /** 选择倒计时盯哪一场（状态栏倒计时的设置入口） */
  register("htoj.selectCountdown", () => contestCountdown.select());

  /** 由比赛节点的右键菜单触发：把这一场设为倒计时目标 */
  register("htoj.trackContestCountdown", (arg?: unknown) => {
    const target = resolveContestArg(arg);
    if (!target) {
      void vscode.window.showWarningMessage("无法确定要跟踪哪场比赛。");
      return;
    }
    void contestCountdown.track(target.cid, target.gid);
  });

  register("htoj.loadMore", (viewId: ProviderId) => loadMoreMap[viewId]?.());

  register("htoj.searchProblem", async () => {
    if (!requireLogin()) {
      return;
    }
    const keyword = await vscode.window.showInputBox({
      title: "搜索题目",
      prompt: "输入题目编号或名称关键词（留空表示显示全部）",
      value: problemTree.getKeyword() ?? "",
      ignoreFocusOut: true,
    });
    if (keyword === undefined) {
      return;
    }
    problemTree.setKeyword(keyword);
  });

  register("htoj.clearSearch", () => problemTree.setKeyword(undefined));

  register("htoj.openProblem", (pid: number, context?: ProblemContext) => openProblem(pid, context));

  register("htoj.openInBrowser", (pid: number, context?: ProblemContext) => {
    void vscode.env.openExternal(browserUrl(problemPagePath(pid, context)));
  });

  // 由比赛节点的右键菜单触发，参数是树节点对象而不是 cid 本身
  register("htoj.openContestInBrowser", (arg?: unknown) => {
    const target = resolveContestArg(arg);
    if (!target) {
      void vscode.window.showWarningMessage("无法确定要打开哪场比赛。");
      return;
    }
    const query = [`cid=${target.cid}`];
    if (target.gid) {
      query.push(`gid=${target.gid}`);
    }
    void vscode.env.openExternal(browserUrl(`/oj/contest/detail?${query.join("&")}`));
  });

  /** 报名比赛：密码场次会先弹输入框，报名成功后刷新该比赛的题目 */
  register("htoj.joinContest", async (arg?: unknown) => {
    if (!requireLogin()) {
      return;
    }
    const target = resolveContestArg(arg);
    if (!target) {
      void vscode.window.showWarningMessage("无法确定要报名哪场比赛。");
      return;
    }
    const { cid, gid } = target;
    try {
      const info = await contest.info(session.client, { cid, gid });
      if (info.registered) {
        contestTree.markRegistered(cid);
        void vscode.window.showInformationMessage(`你已经报名了「${info.title}」。`);
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `确认报名「${info.title}」吗？`,
        {
          modal: true,
          detail: info.needPassword
            ? "该场比赛需要密码，下一步会提示输入。"
            : "报名后将可以查看并提交本场比赛的题目。",
        },
        "报名",
      );
      if (confirmed !== "报名") {
        log(`[报名] 用户取消：cid=${cid}`);
        return;
      }

      let password: string | undefined;
      if (info.needPassword) {
        password = await vscode.window.showInputBox({
          title: `报名「${info.title}」`,
          prompt: "该场比赛需要密码",
          password: true,
          ignoreFocusOut: true,
        });
        if (password === undefined) {
          return; // 用户取消
        }
      }

      log(`[报名] 提交报名 cid=${cid} gid=${gid ?? "无"} 有密码=${Boolean(password)}`);
      const { registerState } = await contest.register(session.client, { cid, password, gid });
      log(`[报名] 「${info.title}」registerState=${registerState}`);

      // registerState：0 校验未通过 1 待收集信息 2 无需报名直接解锁 3 已报名
      switch (registerState) {
        case 3:
          contestTree.markRegistered(cid);
          void vscode.window.showInformationMessage(`已报名「${info.title}」，展开即可查看题目。`);
          break;
        case 2:
          contestTree.markRegistered(cid);
          void vscode.window.showInformationMessage(`「${info.title}」无需报名，题目已解锁。`);
          break;
        case 1:
          void vscode.window
            .showWarningMessage(`「${info.title}」还需要填写报名信息，请到网页端完成。`, "在浏览器中打开")
            .then((choice) => {
              if (choice) {
                void vscode.env.openExternal(browserUrl(`/oj/contest/detail?cid=${cid}`));
              }
            });
          break;
        default:
          void vscode.window.showErrorMessage(
            `报名「${info.title}」失败：校验未通过${password ? "，请确认比赛密码是否正确" : ""}。`,
          );
      }
    } catch (error) {
      logError("[报名] 失败", error);
      void vscode.window.showErrorMessage(`报名失败：${errorMessage(error)}`);
    }
  });

  /** 开始比赛：会开启计时，需二次确认；成功后刷新该比赛的题目 */
  register("htoj.startContest", async (arg?: unknown) => {
    if (!requireLogin()) {
      return;
    }
    const target = resolveContestArg(arg);
    if (!target) {
      void vscode.window.showWarningMessage("无法确定要开始哪场比赛。");
      return;
    }
    const { cid, gid } = target;
    try {
      const info = await contest.info(session.client, { cid, gid });
      if (info.started) {
        contestTree.markStarted(cid);
        void vscode.window.showInformationMessage(`「${info.title}」已经开始，无需重复开始。`);
        return;
      }

      // 与网页端 StartContestConfirmModal 的文案保持一致
      const confirmed = await vscode.window.showWarningMessage(
        "是否立即开始比赛并开启计时？",
        {
          modal: true,
          detail: `开始「${info.title}」后将开始计时，且无法撤销。`,
        },
        "立即开赛",
        "稍后再说",
      );
      if (confirmed !== "立即开赛") {
        log(`[开始比赛] 用户取消：cid=${cid}`);
        return;
      }

      log(`[开始比赛] cid=${cid} gid=${gid ?? "无"}（${info.title}）`);
      await contest.start(session.client, { cid, gid });
      contestTree.markStarted(cid);
      // 个人计时的权威剩余时间只有后端知道，立刻对齐一次
      void contestCountdown.sync();
      void vscode.window.showInformationMessage(`已开始「${info.title}」，展开即可查看题目。`);
    } catch (error) {
      logError("[开始比赛] 失败", error);
      void vscode.window.showErrorMessage(`开始比赛失败：${errorMessage(error)}`);
    }
  });

  /**
   * 用比赛链接把比赛钉进列表。
   * 带 gid 的小组赛不会出现在 get-contest-list 里（接口不支持按 gid 过滤），只能自己加。
   */
  register("htoj.addContest", async () => {
    if (!requireLogin()) {
      return;
    }
    const input = await vscode.window.showInputBox({
      title: "添加比赛",
      prompt: "粘贴比赛链接；带 gid 的小组赛要把 gid 一起带上",
      placeHolder: "https://htoj.com.cn/cpp/oj/contest/detail?cid=22921376372096&gid=123",
      ignoreFocusOut: true,
      validateInput: (value) => (parseContestRef(value) ? undefined : "没识别出 cid，检查一下链接"),
    });
    if (!input) {
      return;
    }
    const ref = parseContestRef(input);
    if (!ref) {
      return;
    }
    log(`[比赛] 添加 cid=${ref.cid} gid=${ref.gid ?? "无"}`);
    try {
      const info = await contestTree.addPinned(ref.cid, ref.gid);
      void vscode.window.showInformationMessage(`已添加「${info?.title ?? ref.cid}」到比赛列表。`);
    } catch (error) {
      logError("[比赛] 添加失败", error);
      void vscode.window.showErrorMessage(`添加比赛失败：${errorMessage(error)}`);
    }
  });

  /** 移除手动添加的比赛（只影响插件列表） */
  register("htoj.removeContest", async (arg?: unknown) => {
    const target = resolveContestArg(arg);
    if (!target) {
      void vscode.window.showWarningMessage("无法确定要移除哪场比赛。");
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      "从比赛列表里移除这场？",
      { modal: true, detail: "只影响插件里的「已添加的比赛」，网页端不受影响。" },
      "移除",
    );
    if (confirmed !== "移除") {
      return;
    }
    await contestTree.removePinned(target.cid);
    log(`[比赛] 已移除 cid=${target.cid}`);
  });

  /**
   * 用题目链接把题目钉进列表。
   * 小组题、比赛题这类在题目列表里翻不到；链接里带的 cid / tid / gid 会一起记住，
   * 否则点进去是「该题目不可见」。
   */
  register("htoj.addProblem", async () => {
    if (!requireLogin()) {
      return;
    }
    const input = await vscode.window.showInputBox({
      title: "添加题目",
      prompt: "粘贴题目链接；比赛题 / 题单题 / 小组题要把 cid、tid、gid 一起带上",
      placeHolder: "https://htoj.com.cn/cpp/oj/problem/detail?pid=22169438826624",
      ignoreFocusOut: true,
      validateInput: (value) => (parseProblemRef(value) ? undefined : "没识别出 pid，检查一下链接"),
    });
    if (!input) {
      return;
    }
    const ref = parseProblemRef(input);
    if (!ref) {
      return;
    }
    log(
      `[题目] 添加 pid=${ref.pid}`,
      ref.context ? `上下文=${JSON.stringify(ref.context)}` : "无上下文",
    );
    try {
      const item = await problemTree.addPinned(ref.pid, ref.context);
      void vscode.window.showInformationMessage(
        `已添加「${item?.problemId ?? ref.pid} ${item?.title ?? ""}」到题目列表。`.trim(),
      );
    } catch (error) {
      logError("[题目] 添加失败", error);
      void vscode.window.showErrorMessage(`添加题目失败：${errorMessage(error)}`);
    }
  });

  register("htoj.removeProblem", async (arg?: unknown) => {
    const target = resolveProblemArg(arg);
    if (!target) {
      void vscode.window.showWarningMessage("无法确定要移除哪道题。");
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      "从题目列表里移除这道题？",
      { modal: true, detail: "只影响插件里的「已添加的题目」，网页端不受影响。" },
      "移除",
    );
    if (confirmed !== "移除") {
      return;
    }
    await problemTree.removePinned(target.pid);
    log(`[题目] 已移除 pid=${target.pid}`);
  });

  /** 用题单链接把题单钉进列表（小组题单不在 get-training-list 里） */
  register("htoj.addTraining", async () => {
    if (!requireLogin()) {
      return;
    }
    const input = await vscode.window.showInputBox({
      title: "添加题单",
      prompt: "粘贴题单链接；小组题单要把 gid 一起带上",
      placeHolder: "https://htoj.com.cn/cpp/oj/training/detail?tid=22338793157760&gid=123",
      ignoreFocusOut: true,
      validateInput: (value) => (parseTrainingRef(value) ? undefined : "没识别出 tid，检查一下链接"),
    });
    if (!input) {
      return;
    }
    const ref = parseTrainingRef(input);
    if (!ref) {
      return;
    }
    log(`[题单] 添加 tid=${ref.tid} gid=${ref.gid ?? "无"}`);
    try {
      const item = await trainingTree.addPinned(ref.tid, ref.gid);
      void vscode.window.showInformationMessage(`已添加题单「${item?.title ?? ref.tid}」。`);
    } catch (error) {
      logError("[题单] 添加失败", error);
      void vscode.window.showErrorMessage(`添加题单失败：${errorMessage(error)}`);
    }
  });

  register("htoj.removeTraining", async (arg?: unknown) => {
    const tid = resolveTrainingArg(arg);
    if (!tid) {
      void vscode.window.showWarningMessage("无法确定要移除哪个题单。");
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      "从题单列表里移除这个题单？",
      { modal: true, detail: "只影响插件里的「已添加的题单」，网页端不受影响。" },
      "移除",
    );
    if (confirmed !== "移除") {
      return;
    }
    await trainingTree.removePinned(tid);
    log(`[题单] 已移除 tid=${tid}`);
  });

  /** 开始练习（参加题单）：成功后刷新该题单的题目 */
  register("htoj.joinTraining", async (arg?: unknown) => {
    if (!requireLogin()) {
      return;
    }
    const tid = resolveTrainingArg(arg);
    if (!tid) {
      void vscode.window.showWarningMessage("无法确定要参加哪个题单。");
      return;
    }
    try {
      const detail = await training.detail(session.client, { tid });
      const confirmed = await vscode.window.showWarningMessage(
        `确认参加「${detail.title}」并开始练习吗？`,
        {
          modal: true,
          detail: "参加后将可以查看并提交该题单的题目。",
        },
        "开始练习",
      );
      if (confirmed !== "开始练习") {
        log(`[题单] 用户取消：tid=${tid}`);
        return;
      }

      log(`[题单] 开始练习 tid=${tid}（${detail.title}）`);
      await training.register(session.client, { tid });
      trainingTree.markAttended(tid);
      void vscode.window.showInformationMessage(`已参加「${detail.title}」，展开即可查看题目。`);
    } catch (error) {
      logError("[题单] 开始练习失败", error);
      void vscode.window.showErrorMessage(`参加题单失败：${errorMessage(error)}`);
    }
  });

  register("htoj.newCodeFile", async (arg?: unknown) => {
    if (!requireLogin()) {
      return;
    }
    // 命令面板里是数字参数，视图右键菜单传的是树节点
    const fromArg = resolveProblemArg(arg);
    const panel = ProblemPanel.active;
    const pid = fromArg?.pid ?? panel?.currentPid;
    const context = mergeContext(fromArg?.context ?? panel?.currentContext, undefined);
    if (!pid) {
      void vscode.window.showWarningMessage("请先从题目列表打开一道题目。");
      return;
    }
    try {
      const detail = await problem.detail(session.client, pid, context);
      await openCodeFile(session, {
        pid,
        problemId: detail.problemBaseVO.problemId,
        context,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  });

  register("htoj.submit", (pid?: number, context?: ProblemContext) => submitProblem(pid, context));

  /** 自测运行：命令行入口，输入从文件 / 手动 / 空值里选 */
  register("htoj.selfTest", async (arg?: unknown) => {
    const fromArg = resolveProblemArg(arg);
    try {
      const target = await resolveTarget("自测", fromArg?.pid, fromArg?.context);
      if (!target) {
        return;
      }
      const userInput = await pickSelfTestInput();
      if (userInput === undefined) {
        log("[自测] 用户没有指定输入，已取消");
        return;
      }
      const result = await runSelfTest(target, userInput);
      reportSelfTest(target.detail.problemBaseVO.problemId, result);
      // 题面面板开着的话，把结果也回填到面板的自测区，别只躺在输出面板里
      const panel = ProblemPanel.active;
      if (panel && panel.currentPid === target.pid) {
        panel.showSelfTestResult(result);
      }
    } catch (error) {
      logError("[自测] 失败", error);
      void vscode.window.showErrorMessage(`自测失败：${errorMessage(error)}`);
    }
  });

  register("htoj.showMySubmissions", async () => {
    if (!requireLogin()) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const fromFile = editor ? parseProblemFromDocument(editor.document) : undefined;
    const panel = ProblemPanel.active;
    const targetPid = fromFile?.pid ?? panel?.currentPid;
    if (!targetPid) {
      void vscode.window.showWarningMessage("请先打开一道题目或该题对应的代码文件。");
      return;
    }
    const context = mergeContext(
      fromFile?.pid === targetPid ? fromFile.context : panel?.currentContext,
      undefined,
    );
    // 提交记录就在题面面板里，打开面板再滚过去即可
    const opened = await ProblemPanel.show(panelDeps, targetPid, context);
    opened.focusSubmissions();
  });

  register("htoj.showLogs", () => {
    getChannel().show(true);
  });

  register("htoj.menu", async () => {
    const items: Array<{ label: string; run: () => void }> = [];
    if (session.isLoggedIn) {
      items.push({ label: "$(account) 已登录：点击查看操作", run: () => {} });
      items.push({ label: "$(sign-out) 退出登录", run: () => void vscode.commands.executeCommand("htoj.logout") });
    } else {
      items.push({ label: "$(sign-in) 登录", run: () => void vscode.commands.executeCommand("htoj.login") });
    }
    items.push({
      label: "$(globe) 切换题库语言",
      run: () => void vscode.commands.executeCommand("htoj.switchZone"),
    });
    items.push({ label: "$(refresh) 刷新所有列表", run: () => void vscode.commands.executeCommand("htoj.refresh") });
    items.push({
      label: "$(watch) 比赛倒计时：换一场 / 关闭",
      run: () => void vscode.commands.executeCommand("htoj.selectCountdown"),
    });
    items.push({ label: "$(output) 查看日志", run: () => void vscode.commands.executeCommand("htoj.showLogs") });

    const picked = await vscode.window.showQuickPick(items, { title: "核桃OJ" });
    picked?.run();
  });

  // ---------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------
  updateStatusBar();
  void vscode.commands.executeCommand("setContext", "htoj.hasSearch", false);
  syncEditorContext();

  void session
    .restore()
    .then(() => {
      log("[激活] token 恢复完成，已登录 =", session.isLoggedIn);
      updateStatusBar();
      if (session.isLoggedIn) {
        problemTree.refresh();
        trainingTree.refresh();
        contestTree.refresh();
      }
      void contestCountdown.sync();
    })
    .catch((error) => {
      logError("[激活] token 恢复失败", error);
    });
}

export function deactivate(): void {
  // 资源由 context.subscriptions 统一释放
}
