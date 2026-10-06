import * as vscode from "vscode";
import { problem as problemApi } from "../api/endpoints";
import type {
  JudgeStatus,
  ProblemContext,
  ProblemDetail,
  SubmissionAnswer,
  SubmissionDetail,
  SubmissionRecord,
  TestJudgeResult,
} from "../api/types";
import type { Session } from "../session";
import { log } from "../util/logger";
import { statusIcon } from "./common";

export interface ProblemPanelDeps {
  session: Session;
  /** 新建 / 打开本地代码文件 */
  onOpenCodeFile(pid: number, problemId: string, context?: ProblemContext): Promise<void>;
  /** 提交当前代码（OJ 编程题） */
  onSubmit(pid: number, context?: ProblemContext): Promise<void>;
  /** 提交答案（选择题 / 客观题） */
  onSubmitAnswers(
    pid: number,
    context: ProblemContext | undefined,
    payload: { kind: "choice" | "objective"; code?: string; answers?: Record<string, string> },
  ): Promise<void>;
  /** 自测运行（不产生提交记录） */
  onSelfTest(
    pid: number,
    context: ProblemContext | undefined,
    userInput: string,
  ): Promise<TestJudgeResult>;
  /** 在浏览器中打开题目 */
  onOpenInBrowser(pid: number, context?: ProblemContext): void;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 用 VSCode 内置 markdown 渲染器把 Markdown 转成 HTML */
async function renderMarkdown(markdown: string): Promise<string> {
  try {
    const extension = vscode.extensions.getExtension("vscode.markdown-language-features");
    if (extension && !extension.isActive) {
      await extension.activate();
    }
    const html = await vscode.commands.executeCommand<string>("markdown.api.render", markdown);
    if (typeof html === "string" && html.length > 0) {
      return html;
    }
  } catch {
    // 内置渲染器不可用时退化为纯文本
  }
  return `<pre class="raw">${escapeHtml(markdown)}</pre>`;
}

interface KatexStyle {
  /** 扩展根目录，需要加进 webview 的 localResourceRoots */
  root: vscode.Uri;
  /** katex.min.css 的路径 */
  file: vscode.Uri;
}

/**
 * 找到内置 markdown-math 扩展提供的 KaTeX 样式表。
 *
 * KaTeX 对每个公式会输出两份内容：`.katex-mathml`（供读屏器）和 `.katex-html`（视觉版），
 * 前者靠 katex.min.css 里的 clip 规则隐藏。VSCode 的 markdown 预览会自动注入这份 CSS，
 * 但 webview 不会——不注入就会看到「原文 + 渲染结果」重复显示。
 */
function findKatexStyle(): KatexStyle | undefined {
  const extension = vscode.extensions.getExtension("vscode.markdown-math");
  const styles: unknown = extension?.packageJSON?.contributes?.["markdown.previewStyles"];
  if (!extension || !Array.isArray(styles)) {
    return undefined;
  }
  const relative = styles.find(
    (item): item is string => typeof item === "string" && item.includes("katex"),
  );
  if (!relative) {
    return undefined;
  }
  return {
    root: extension.extensionUri,
    file: vscode.Uri.joinPath(extension.extensionUri, relative.replace(/^\.\//, "")),
  };
}

/**
 * 评测状态 → 短标签（AC / WA / TLE…）。
 * 后端的 shortName 经常是 null，所以按 id 兜底。
 */
const STATUS_TAGS: Record<number, string> = {
  0: "AC",
  1: "PE",
  2: "TLE",
  3: "MLE",
  4: "WA",
  5: "RE",
  6: "OLE",
  7: "CE",
  8: "SE",
  [-10]: "Judging",
  99: "等待中",
};

/**
 * webview 脚本里要用到的正则，**必须**以字符串常量的形式放在模板外，再用 JSON.stringify 注进去。
 *
 * 模板字符串会把 `\{`、`\s`、`\d` 这类「未知转义」的反斜杠吃掉（`/\s/` 到运行时变成 `/s/`），
 * 直接写在模板里的正则字面量会静默失效——客观题的选项渲染不出来就是这个原因。
 */
const OBJECTIVE_PLACEHOLDER_PATTERN =
  "\\{\\{\\s*(input|select|multiselect|textarea)\\(\\s*(\\d+(?:-\\d+)?)\\s*\\)\\s*\\}\\}";
const SAMPLE_LANG_PATTERN = "language-(input|output)(\\d+)";

function statusTag(status?: JudgeStatus | null): string {
  return status?.shortName || STATUS_TAGS[status?.id ?? -1] || status?.name || "未知";
}

/** 折叠状态下也要能一眼看出「什么时候、多少分、什么结果」 */
function renderSubmissionItem(
  record: SubmissionRecord,
  detail: SubmissionDetail | undefined,
  open: boolean,
): string {
  const { color } = statusIcon(record.status?.id ?? -1);
  const meta = [record.language, record.time === null ? undefined : `${record.time}ms`, record.memory === null ? undefined : `${record.memory}KB`]
    .filter(Boolean)
    .join(" · ");
  return `<details class="sub" data-submit-id="${record.submitId}"${open ? " open" : ""}>
  <summary>
    <span class="sub-tag" style="color:${color}">${escapeHtml(statusTag(record.status))}</span>
    <span class="sub-score">${record.score === null ? "-" : `${record.score} 分`}</span>
    <span class="sub-time">${escapeHtml(new Date(record.submitTime).toLocaleString())}</span>
    <span class="sub-meta">${escapeHtml(meta)}</span>
  </summary>
  <div class="sub-body" data-pending="${detail ? "0" : "1"}">${
    detail ? renderSubmissionResult(detail) : `<p class="muted">展开后加载评测详情…</p>`
  }</div>
</details>`;
}

/** 提交结果 → HTML 片段 */
export function renderSubmissionResult(detail: SubmissionDetail): string {
  const rows: string[] = [];
  const groups = detail.caseGroups ?? [];
  for (const group of groups) {
    for (const item of group.caseResult ?? []) {
      const status = item.status ?? { id: -1, name: "未知" };
      const { color } = statusIcon(status.id);
      rows.push(
        `<tr>
           <td>#${item.seq}</td>
           <td><span style="color:${color}">${escapeHtml(status.name ?? "未知")}</span></td>
           <td>${item.score ?? "-"}</td>
           <td>${item.time ?? "-"}</td>
           <td>${item.memory ?? "-"}</td>
         </tr>`,
      );
    }
  }

  // 选择题没有测试点，只有提交时选的选项
  const cases =
    rows.length > 0
      ? `<table class="cases">
           <thead><tr><th>测试点</th><th>状态</th><th>分数</th><th>用时(ms)</th><th>内存(KB)</th></tr></thead>
           <tbody>${rows.join("")}</tbody>
         </table>`
      : detail.language === "choice" && detail.userCode
        ? `<p class="muted">我的选择：${escapeHtml(detail.userCode)}</p>`
        : `<p class="muted">没有测试点明细。</p>`;

  const accepted = detail.resultCode === 1;
  const summary = accepted
    ? `<p class="ok">评测通过${detail.score === null ? "" : `，得分 <b>${detail.score}</b>`}</p>`
    : detail.resultCode === 0
      ? `<p class="muted">评测中…</p>`
      : `<p class="bad">${escapeHtml(detail.status?.name ?? "评测未通过")}${
          detail.score === null ? "" : `，得分 <b>${detail.score}</b>`
        }</p>`;

  return `
    ${summary}
    <p class="muted">提交号 ${detail.submitId}${detail.language ? ` · ${escapeHtml(detail.language)}` : ""}</p>
    ${answerTable(detail.answers) ?? cases}
  `;
}

/** 客观题逐题批改结果（-1 未作答 1 正确 2 错误 3 已作答） */
const ANSWER_STATUS_TEXT: Record<number, { text: string; color: string }> = {
  [-1]: { text: "未作答", color: "var(--vscode-descriptionForeground)" },
  1: { text: "正确", color: "#00B42A" },
  2: { text: "错误", color: "#FF1D27" },
  3: { text: "已作答", color: "#6850ff" },
};

function answerTable(answers: SubmissionAnswer[] | null | undefined): string | undefined {
  if (!answers?.length) {
    return undefined;
  }
  const rows = answers.map((item) => {
    const status = ANSWER_STATUS_TEXT[item.status] ?? ANSWER_STATUS_TEXT[-1];
    return `<tr>
      <td>#${escapeHtml(item.id)}</td>
      <td>${escapeHtml(item.myAnswer ?? "-")}</td>
      <td>${item.answer ? escapeHtml(item.answer) : "-"}</td>
      <td><span style="color:${status.color}">${status.text}</span></td>
      <td>${item.myScore === null || item.myScore < 0 ? "-" : item.myScore}${
        item.score === null ? "" : ` / ${item.score}`
      }</td>
    </tr>`;
  });
  return `<table class="cases">
    <thead><tr><th>小题</th><th>我的答案</th><th>正确答案</th><th>状态</th><th>得分</th></tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>`;
}

/** 自测运行结果 → HTML 片段 */
function renderTestResult(result: TestJudgeResult): string {
  const ok = result.resultCode === 1;
  const status = result.status?.chineseName || result.status?.name || (ok ? "运行通过" : "运行失败");
  const meta = [
    result.time === null ? undefined : `用时 ${result.time}ms`,
    result.memory === null ? undefined : `内存 ${result.memory}KB`,
  ]
    .filter(Boolean)
    .join(" · ");
  const head =
    result.resultCode === 0
      ? `<p class="muted">运行中…</p>`
      : `<p class="${ok ? "ok" : "bad"}">${escapeHtml(status)}${meta ? ` · ${escapeHtml(meta)}` : ""}</p>`;
  const block = (label: string, value?: string | null): string =>
    value
      ? `<p class="muted selftest-label">${label}</p><pre class="selftest-out">${escapeHtml(value)}</pre>`
      : "";
  // 标准输出和 stderr 都非空就都显示：程序打印过东西却被藏起来是最容易踩的坑
  const body = `${block("输出", result.userOutput)}${block("错误输出", result.stderr)}`;
  const empty = result.resultCode !== 0 && !body && !result.userInput;
  return `${head}${block("输入", result.userInput)}${body}${block("期望输出", result.expectedOutput)}${
    empty ? `<p class="muted">运行结束，没有输出。</p>` : ""
  }`;
}

/**
 * 题目大类。接口的 `problemBaseVO.type`：1=OJ 编程题 2=选择题 5=客观题。
 * 选择题和客观题都是「提交答案」而不是提交代码，面板要换一套交互。
 */
type ProblemKind = "oj" | "choice" | "objective";

function problemKind(problem: ProblemDetail): ProblemKind {
  switch (problem.problemBaseVO.type) {
    case 2:
      return "choice";
    case 5:
      return "objective";
    default:
      return "oj";
  }
}

interface BuildHtmlOptions {
  bodyHtml: string;
  accepted: boolean;
  contextHint?: string;
  /** 题目大类，决定工具栏和作答区 */
  kind: ProblemKind;
  /** 提交记录列表的 HTML（折叠项） */
  submissionsHtml: string;
  /** KaTeX 样式表的 webview URI，取不到时不注入 */
  katexUri?: string;
  /** webview 的资源源，CSP 里需要放行 */
  cspSource: string;
}

function buildHtml(problem: ProblemDetail, options: BuildHtmlOptions): string {
  const { bodyHtml, accepted, contextHint, kind, submissionsHtml, katexUri, cspSource } = options;
  const interactive = kind !== "oj";
  const base = problem.problemBaseVO;
  const oj = problem.problemOjDetailVO;
  const nonce = `${Date.now()}${Math.random()}`.replace(/\W/g, "");
  const tags = (base.tags ?? []).map((tag) => `<span class="tag">${escapeHtml(tag.name)}</span>`).join("");
  const meta = [
    base.difficulty ? `<span class="tag diff">${escapeHtml(base.difficulty.name)}</span>` : "",
    tags,
  ]
    .filter(Boolean)
    .join("");
  // 元信息做成卡片：时空限制和文件 IO 是「看错就爆零」的东西，塞在一行灰字里太容易被划过去
  const cards: Array<{ label: string; value: string; hint?: string; accent?: boolean }> = [];
  if (kind === "oj" && oj) {
    cards.push({ label: "时间限制", value: `${oj.timeLimit} ms` });
    cards.push({ label: "内存限制", value: `${oj.memoryLimit} MB` });
    cards.push({ label: "输入输出", value: oj.ioMode?.name ?? "-" });
    // 不能只看文件名：标准 IO 题的 ioReadFileName 也有值（默认 case.in），要靠 ioMode 区分
    if (oj.ioMode?.id === 2) {
      cards.push({ label: "读入文件", value: oj.ioReadFileName ?? "-", accent: true });
      cards.push({ label: "输出文件", value: oj.ioWriteFileName ?? "-", accent: true });
    }
  } else {
    cards.push({ label: "题目类型", value: kind === "choice" ? "选择题" : "客观题" });
  }
  cards.push({
    label: "通过率",
    value: base.total > 0 ? `${((base.ac / base.total) * 100).toFixed(1)}%` : "-",
    hint: base.total > 0 ? `${base.ac} / ${base.total}` : undefined,
  });
  const infoCards = `<div class="info-cards">${cards
    .map(
      (card) => `<div class="info-card${card.accent ? " accent" : ""}">
    <span class="k">${escapeHtml(card.label)}</span>
    <span class="v">${escapeHtml(card.value)}${card.hint ? `<small>${escapeHtml(card.hint)}</small>` : ""}</span>
  </div>`,
    )
    .join("")}</div>`;
  // 选择题的选项直接由接口下发；客观题的选项藏在题面 markdown 里，交给脚本按占位符生成
  const choice = problem.problemChoiceDetailVO;
  const multi = choice?.choiceType === 4;
  const choicesHtml =
    kind === "choice" && choice
      ? `<div class="choices"${multi ? ` data-multi="1"` : ""}>${(choice.options ?? [])
          .map(
            (option, index) => `<label class="choice-option">
  <input type="${multi ? "checkbox" : "radio"}" name="choice" value="${escapeHtml(option.id)}" class="choice-input" />
  <span class="choice-letter">${String.fromCharCode(65 + index)}.</span>
  <span class="choice-body">${escapeHtml(option.label)}
    ${option.picUrl ? `<img src="${escapeHtml(option.picUrl)}" alt="" />` : ""}
  </span>
</label>`,
          )
          .join("")}</div>`
      : "";
  // 只有编程题能自测；输入上限与网页端一致（手动输入 1MB）
  const selfTestHtml =
    kind === "oj"
      ? `<section id="selftest-section">
  <h2>自测运行</h2>
  <p class="muted">不产生提交记录。测试输入上限 1MB，更大的输入请用命令「核桃OJ: 运行自测」从文件读取。</p>
  <textarea id="selftest-input" class="selftest-input" placeholder="在这里粘贴测试输入（可留空）"></textarea>
  <div class="toolbar">
    <button data-action="selfTest" class="primary">运行自测</button>
  </div>
  <div id="selftest-result" class="selftest-result"></div>
</section>`
      : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline' ${cspSource}; font-src ${cspSource} https: data:; script-src 'nonce-${nonce}';" />
${katexUri ? `<link rel="stylesheet" href="${katexUri}" />` : ""}
<style>
  /* KaTeX 为了无障碍会输出一份 .katex-mathml，靠 katex.min.css 的 clip 规则隐藏。
     katex.min.css 没加载成功时这里兜底，否则会看到「原文 + 渲染结果」重复两遍。 */
  .katex-mathml {
    position: absolute;
    clip: rect(1px, 1px, 1px, 1px);
    width: 1px;
    height: 1px;
    overflow: hidden;
  }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 0 20px 40px;
    line-height: 1.7;
    word-break: break-word;
  }
  header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 12px 0 10px; border-bottom: 1px solid var(--vscode-panel-border); z-index: 2; }
  h1 { font-size: 1.4em; margin: 0 0 6px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.92em; }
  .tag { display: inline-block; padding: 0 6px; margin: 0 6px 4px 0; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.85em; }
  .tag.diff { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .tag.ctx { background: var(--vscode-inputValidation-infoBorder, #007acc); color: #fff; }
  .toolbar { margin: 10px 0 4px; display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    font-family: inherit; font-size: inherit; cursor: pointer;
    padding: 4px 12px; border: none; border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
  }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { opacity: 0.9; }
  button:disabled { opacity: 0.5; cursor: default; }
  section { margin-top: 20px; }
  section h2 { font-size: 1.05em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  pre, code { font-family: var(--vscode-editor-font-family, monospace); }
  pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; overflow-x: auto; }
  pre.raw { white-space: pre-wrap; }
  table.cases { border-collapse: collapse; width: 100%; margin-top: 8px; }
  table.cases th, table.cases td { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; text-align: left; }
  table.cases th { background: var(--vscode-editorWidget-background); }
  /* 题面 markdown 里的表格：只拿到渲染后的 HTML，没有预览用的 CSS，不补样式就是没边框的一坨 */
  #description table {
    border-collapse: collapse;
    margin: 10px 0;
    max-width: 100%;
  }
  #description th, #description td {
    border: 1px solid var(--vscode-panel-border);
    padding: 4px 10px;
    text-align: left;
  }
  #description th { background: var(--vscode-editorWidget-background); font-weight: 600; }
  #description img { max-width: 100%; }
  /* 样例：输入 / 输出左右并列，窄了就自动换行堆叠 */
  .sample-pair { display: flex; flex-wrap: wrap; gap: 12px; margin: 10px 0; }
  .sample-col { flex: 1 1 260px; min-width: 0; }
  .sample-title {
    margin-bottom: 4px;
    font-size: 0.9em;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
  }
  .sample-body { margin: 0; }
  #description blockquote {
    margin: 8px 0;
    padding: 2px 12px;
    border-left: 3px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .ok { color: #00B42A; font-weight: 600; }
  .bad { color: #FF1D27; font-weight: 600; }
  .muted { color: var(--vscode-descriptionForeground); }
  .accepted { color: #00B42A; }
  /* 题目元信息卡片：时空限制 / IO 方式 / 通过率 */
  .info-cards { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 2px; }
  .info-card {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 96px;
    padding: 6px 12px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    background: var(--vscode-editorWidget-background);
  }
  .info-card .k { font-size: 0.78em; color: var(--vscode-descriptionForeground); }
  .info-card .v { font-size: 1.1em; font-weight: 600; }
  .info-card .v small { margin-left: 6px; font-size: 0.72em; font-weight: 400; color: var(--vscode-descriptionForeground); }
  /* 文件 IO 的文件名写错就整题 0 分，用链接色单独标出来 */
  .info-card.accent { border-color: var(--vscode-textLink-foreground); }
  .info-card.accent .v { color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family, monospace); }
  /* 提交记录：默认只露「状态 / 得分 / 时间」一行，展开才看测试点 */
  details.sub {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    margin: 6px 0;
    background: var(--vscode-editorWidget-background);
  }
  details.sub > summary {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 0.95em;
    user-select: none;
  }
  /* summary 用了 flex，默认的三角会被浏览器去掉，这里自己画一个 */
  details.sub > summary::before {
    content: "▸";
    color: var(--vscode-descriptionForeground);
  }
  details.sub[open] > summary::before { content: "▾"; }
  .sub-tag { font-weight: 700; min-width: 4.5em; }
  .sub-score { min-width: 4em; }
  .sub-time { color: var(--vscode-descriptionForeground); }
  .sub-meta { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .sub-body { padding: 0 10px 8px; }
  .sub-body > p:first-child { margin-top: 0; }
  /* 选择题选项 */
  .choices { margin-top: 8px; }
  .choice-option {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  .choice-option:hover { background: var(--vscode-list-hoverBackground); }
  .choice-letter { font-weight: 600; }
  .choice-body img { display: block; margin-top: 6px; max-width: 100%; max-height: 160px; }
  /* 客观题：占位符被替换成的作答控件 */
  .objective-input {
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 3px;
    padding: 2px 6px;
    min-width: 12em;
  }
  textarea.objective-input { width: 100%; min-height: 4em; vertical-align: top; }
  .choices .objective-input { min-width: 0; }
  .objective-option { display: flex; gap: 8px; align-items: flex-start; padding: 2px 0; cursor: pointer; }
  #description label.objective-option { margin-left: 0; }
  /* 自测运行：输入框 + 输出回显 */
  .selftest-input {
    display: block;
    width: 100%;
    min-height: 5em;
    box-sizing: border-box;
    resize: vertical;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 4px;
    padding: 8px;
  }
  .selftest-result { margin-top: 8px; }
  .selftest-label { margin: 8px 0 0; font-size: 0.92em; }
  .selftest-out {
    margin: 4px 0 0;
    max-height: 320px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(base.problemId)} ${escapeHtml(base.title)} ${accepted ? '<span class="accepted">✓ 已通过</span>' : ""}</h1>
  ${contextHint ? `<div class="meta"><span class="tag ctx">${escapeHtml(contextHint)}</span></div>` : ""}
  <div class="meta">${meta}</div>
  ${infoCards}
  <div class="toolbar">
    ${
      interactive
        ? `<button data-action="submitAnswers" class="primary">提交答案</button>`
        : `<button data-action="code" class="primary">新建/打开代码文件</button>
    <button data-action="submit" class="primary">提交当前文件</button>`
    }
    <button data-action="refresh">刷新</button>
    <button data-action="browser">在浏览器中打开</button>
  </div>
</header>
<section>
  <h2>题目描述</h2>
  <div id="description">${bodyHtml}</div>
  ${choicesHtml}
</section>
${selfTestHtml}
<section id="submissions-section">
  <h2>提交记录</h2>
  <div id="submissions">${submissionsHtml}</div>
</section>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const KIND = "${kind}";

  /**
   * 客观题的题面里用 【{{ select(1) }}】【{{ multiselect(2) }}】【{{ input(3) }}】【{{ textarea(4) }}】
   * 这类占位符出题，选项就是紧跟其后的一串列表项。这里把占位符换成真正的作答控件。
   * 单选/多选的选项值取 A、B、C…（与前端 use-mdown-transform 一致）。
   */
  const PLACEHOLDER = new RegExp(${JSON.stringify(OBJECTIVE_PLACEHOLDER_PATTERN)}, "g");

  /**
   * 占位符可能落在任意层级（段落里、列表项里、引用块里），选项列表也未必是它的兄弟节点——
   * 网站用 md-editor-v3 渲染，插件用 VS Code 的 markdown-it，两套管线的 DOM 结构不保证一致。
   * 所以这里按文本节点找占位符，选项列表则按文档顺序往后找最近的 <ul>。
   */
  const fillObjective = (root) => {
    if (!root) return;

    const targets = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      // 代码块里的占位符是示例，不动
      if (textNode.parentElement && textNode.parentElement.closest("pre")) continue;
      PLACEHOLDER.lastIndex = 0;
      const matches = [...(textNode.nodeValue || "").matchAll(PLACEHOLDER)];
      if (matches.length > 0) {
        targets.push({ node: textNode, matches });
      }
    }

    /** 文档顺序里，host 之后最近的那个列表 */
    const listAfter = (host) => {
      const all = Array.from(root.querySelectorAll("*"));
      for (let i = all.indexOf(host) + 1; i < all.length; i++) {
        if (all[i].tagName === "UL") return all[i];
      }
      return null;
    };

    for (const target of targets) {
      const host = target.node.parentElement;
      if (!host) continue;
      for (const match of target.matches) {
        const [raw, type, id] = match;
        if (type === "input" || type === "textarea") {
          const control =
            type === "input"
              ? '<input autocomplete="off" type="text" name="' + id + '" class="objective-input" />'
              : '<textarea autocomplete="off" name="' + id + '" class="objective-input"></textarea>';
          host.innerHTML = host.innerHTML.replace(raw, '<span id="p' + id + '">' + control + "</span>");
          continue;
        }
        // 单选 / 多选：选项来自后面那个列表
        const list = listAfter(host);
        if (!list) continue;
        host.innerHTML = host.innerHTML.replace(raw, "");
        Array.from(list.querySelectorAll("li")).forEach((li, index) => {
          const label = document.createElement("label");
          label.className = "objective-option";
          const input = document.createElement("input");
          input.type = type === "select" ? "radio" : "checkbox";
          input.name = id;
          input.className = "objective-input";
          input.value = String.fromCharCode(65 + index);
          const body = document.createElement("span");
          body.innerHTML = li.innerHTML;
          label.append(input, body);
          li.replaceWith(label);
        });
      }
    }
  };

  /**
   * 样例成对出现（围栏语言标记是 input1 / output1 / input2 / output2），
   * 渲染出来是上下四块，对照着看要来回滚。这里按语言标记（markdown-it 的
   * langPrefix 会留下 language-input1）把同一组并成左右两栏，并补上「输入 #1 / 输出 #1」标题。
   */
  const SAMPLE_LANG = new RegExp(${JSON.stringify(SAMPLE_LANG_PATTERN)});
  const sampleInfo = (pre) => {
    const code = pre.querySelector("code");
    const raw = ((code && code.className) || "") + " " + (pre.className || "");
    const matched = SAMPLE_LANG.exec(raw);
    return matched ? { kind: matched[1], index: matched[2] } : null;
  };
  const buildSamples = (root) => {
    if (!root) return;
    const blocks = Array.from(root.querySelectorAll("pre")).filter((pre) => sampleInfo(pre));
    for (let i = 0; i < blocks.length; i++) {
      const input = blocks[i];
      const inputInfo = sampleInfo(input);
      if (!inputInfo || inputInfo.kind !== "input") continue;
      // 只有紧跟着的那一块是同一组输出时才配对，避免把别的代码块卷进来
      const output = blocks[i + 1];
      const outputInfo = output && sampleInfo(output);
      if (!outputInfo || outputInfo.kind !== "output" || outputInfo.index !== inputInfo.index) continue;

      const pair = document.createElement("div");
      pair.className = "sample-pair";
      const inputCol = document.createElement("div");
      inputCol.className = "sample-col";
      const outputCol = document.createElement("div");
      outputCol.className = "sample-col";
      // 先把容器插回文档，再把两个块挪进去。反过来写（先 append 块、后 replaceWith）会让容器
      // 变成自己的后代，抛 HierarchyRequestError，样例会整段消失
      input.replaceWith(pair);
      pair.append(inputCol, outputCol);
      for (const [column, block, info] of [
        [inputCol, input, inputInfo],
        [outputCol, output, outputInfo],
      ]) {
        const title = document.createElement("div");
        title.className = "sample-title";
        title.textContent = (info.kind === "input" ? "输入 #" : "输出 #") + info.index;
        // 用渲染器给的类名换掉原样式，高亮出来的内层结构保留
        block.className = "sample-body";
        column.append(title, block);
      }
      i += 1; // 输出那块已经并进去了
    }
  };

  /** 收集当前作答：客观题按小题号、选择题按选项 id */
  const readAnswers = () => {
    const answers = {};
    const box = document.getElementById("description");
    if (box) {
      const byName = new Map();
      box.querySelectorAll("input.objective-input, textarea.objective-input").forEach((el) => {
        if (!byName.has(el.name)) byName.set(el.name, []);
        byName.get(el.name).push(el);
      });
      for (const [name, list] of byName) {
        if (list[0].type === "checkbox") {
          const picked = list.filter((el) => el.checked).map((el) => el.value).sort();
          if (picked.length) answers[name] = picked.join(",");
        } else if (list[0].type === "radio") {
          const picked = list.find((el) => el.checked);
          if (picked) answers[name] = picked.value;
        } else {
          const value = list[0].value.trim();
          if (value) answers[name] = value;
        }
      }
    }
    const code = Array.from(document.querySelectorAll(".choice-input:checked"))
      .map((el) => el.value)
      .join(",");
    return { answers, code };
  };

  document.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      const message = { type: "action", action };
      if (action === "submitAnswers") Object.assign(message, readAnswers());
      if (action === "selfTest") {
        const box = document.getElementById("selftest-input");
        const text = box ? box.value : "";
        // 手动输入超过 1MB 服务端会拒，先在本地拦下来
        if (new TextEncoder().encode(text).length > 1048576) {
          document.getElementById("selftest-result").innerHTML =
            '<p class="bad">测试输入超过 1MB（服务端手动输入上限）。请改用命令「核桃OJ: 运行自测」从文件读取。</p>';
          return;
        }
        message.input = text;
        document.getElementById("selftest-result").innerHTML = '<p class="muted">正在运行自测…</p>';
      }
      vscode.postMessage(message);
    });
  });

  // 折叠项展开时才去拉评测详情，避免一打开面板就发一堆请求
  const requestDetail = (item) => {
    const body = item.querySelector(".sub-body");
    if (!body || body.dataset.pending !== "1") return;
    body.dataset.pending = "0";
    body.innerHTML = '<p class="muted">加载评测详情…</p>';
    vscode.postMessage({ type: "submissionDetail", submitId: Number(item.dataset.submitId) });
  };
  const bindSubmissions = (root) => {
    root.querySelectorAll("details.sub").forEach((item) => {
      item.addEventListener("toggle", () => {
        if (item.open) requestDetail(item);
      });
      if (item.open) requestDetail(item);
    });
  };
  bindSubmissions(document);

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "submissions") {
      const box = document.getElementById("submissions");
      box.innerHTML = message.html;
      bindSubmissions(box);
    } else if (message.type === "submissionDetail") {
      const item = document.querySelector('details.sub[data-submit-id="' + message.submitId + '"]');
      const body = item && item.querySelector(".sub-body");
      if (body) {
        body.dataset.pending = "0";
        body.innerHTML = message.html;
      }
    } else if (message.type === "selfTestResult") {
      const box = document.getElementById("selftest-result");
      if (box) box.innerHTML = message.html;
    } else if (message.type === "scroll") {
      const target = document.querySelector(message.selector);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (message.type === "busy") {
      document.querySelectorAll("button").forEach((btn) => (btn.disabled = message.value));
    }
  });

  // --- 渲染后的 DOM 后处理 -------------------------------------------------
  // 放在所有监听注册完之后再执行：这类操作一旦抛异常会中断整段脚本，按钮、提交记录、
  // 自测就全都失效（样例配对就踩过这个坑），所以这里兜住，失败了也保面板可用。
  try {
    const description = document.getElementById("description");
    if (KIND === "objective") fillObjective(description);
    buildSamples(description);
  } catch (error) {
    console.error("[htoj] 题面后处理失败：", error);
  }
</script>
</body>
</html>`;
}

/** 题目详情面板 */
export class ProblemPanel implements vscode.Disposable {
  private static current: ProblemPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private pid: number;
  private context: ProblemContext | undefined;
  private problem: ProblemDetail | undefined;
  /** 本题的提交记录（按时间倒序，接口就是这个顺序） */
  private submissions: SubmissionRecord[] = [];
  /** 已拉取过的评测详情，展开折叠项时直接用缓存 */
  private readonly details = new Map<number, SubmissionDetail>();
  /** 当前默认展开的那条；未设置时展开最新一条 */
  private expandedSubmitId: number | undefined;
  /** KaTeX 样式表的 webview URI（取不到则为 undefined） */
  private readonly katexUri: string | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly deps: ProblemPanelDeps,
    pid: number,
    context: ProblemContext | undefined,
    katexFile: vscode.Uri | undefined,
  ) {
    this.panel = panel;
    this.pid = pid;
    this.context = context;
    this.katexUri = katexFile ? panel.webview.asWebviewUri(katexFile).toString() : undefined;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: { type: string; action?: string; submitId?: number }) =>
        void this.handleMessage(message),
      null,
      this.disposables,
    );
  }

  static async show(
    deps: ProblemPanelDeps,
    pid: number,
    context?: ProblemContext,
  ): Promise<ProblemPanel> {
    if (ProblemPanel.current) {
      if (ProblemPanel.current.pid !== pid) {
        // 换题目了，提交记录缓存一并清掉
        ProblemPanel.current.submissions = [];
        ProblemPanel.current.details.clear();
        ProblemPanel.current.expandedSubmitId = undefined;
      }
      ProblemPanel.current.pid = pid;
      ProblemPanel.current.context = context;
      // 不传列 = 留在它原来那一栏，别把它拽到当前焦点所在的编辑器栏里
      ProblemPanel.current.panel.reveal(undefined, false);
      await ProblemPanel.current.load();
      return ProblemPanel.current;
    }

    // 公式的样式表来自内置 markdown-math 扩展，需要把它的目录加进可访问资源
    const katex = findKatexStyle();
    const panel = vscode.window.createWebviewPanel(
      "htoj.problem",
      "题目",
      // 默认开在右侧分屏，左边留给代码
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: katex ? [katex.root] : [],
      },
    );
    const instance = new ProblemPanel(panel, deps, pid, context, katex?.file);
    ProblemPanel.current = instance;
    await instance.load();
    return instance;
  }

  static get active(): ProblemPanel | undefined {
    return ProblemPanel.current;
  }

  get currentPid(): number {
    return this.pid;
  }

  get currentProblem(): ProblemDetail | undefined {
    return this.problem;
  }

  get currentContext(): ProblemContext | undefined {
    return this.context;
  }

  /** 重新加载题目并渲染 */
  async load(): Promise<void> {
    this.panel.webview.html = `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:20px">
      <p>正在加载题目…</p></body></html>`;
    try {
      // 比赛题目必须带 cid，否则后端返回「该题目不可见」
      log(
        `[面板] 加载题目 pid=${this.pid}`,
        this.context && Object.keys(this.context).length ? `上下文=${JSON.stringify(this.context)}` : "无上下文",
      );
      const [detail] = await Promise.all([
        problemApi.detail(this.deps.session.client, this.pid, this.context),
        this.fetchSubmissions(),
      ]);
      this.problem = detail;
      await this.render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("[面板] 题目加载失败：", message);
      this.panel.webview.html = `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:20px">
        <h3>题目加载失败</h3><p>${escapeHtml(message)}</p></body></html>`;
    }
  }

  /**
   * 提交完成后刷新提交记录：刚拿到的评测详情直接进缓存，省一次请求，
   * 列表刷新后最新一条默认展开，正好就是这条。
   */
  async showResult(detail: SubmissionDetail): Promise<void> {
    this.details.set(detail.submitId, detail);
    this.expandedSubmitId = detail.submitId;
    await this.fetchSubmissions();
    await this.post({ type: "submissions", html: this.renderSubmissionList() });
    await this.post({ type: "scroll", selector: "#submissions-section" });
  }

  /** 把面板滚到提交记录（「查看本题提交记录」命令用） */
  focusSubmissions(): void {
    void this.post({ type: "scroll", selector: "#submissions-section" });
  }

  /** webview 刚设置完 html 时可能还没就绪，postMessage 会返回 false，这里重试几次 */
  private async post(message: unknown): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await this.panel.webview.postMessage(message)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  setBusy(value: boolean): void {
    void this.panel.webview.postMessage({ type: "busy", value });
  }

  /** 拉本题的提交记录，失败不影响题面展示 */
  private async fetchSubmissions(): Promise<void> {
    const pid = this.pid;
    if (!this.deps.session.isLoggedIn) {
      this.submissions = [];
      return;
    }
    try {
      const result = await problemApi.submissionList(this.deps.session.client, {
        pid,
        limit: 20,
        // 注意：不要带 gid，见 submissionList 里的说明
        cid: this.context?.cid,
        tid: this.context?.tid,
      });
      if (pid !== this.pid) {
        return; // 期间切了题目，丢弃这次结果
      }
      this.submissions = result.records ?? [];
    } catch (error) {
      log(`[面板] 提交记录加载失败：${error instanceof Error ? error.message : String(error)}`);
      this.submissions = [];
    }
    this.expandedSubmitId ??= this.submissions[0]?.submitId;
  }

  /** 提交记录列表：最新一条展开，其余折叠（只露状态 / 得分 / 时间） */
  private renderSubmissionList(): string {
    if (!this.deps.session.isLoggedIn) {
      return `<p class="muted">登录后可以查看本题的提交记录。</p>`;
    }
    if (this.submissions.length === 0) {
      return `<p class="muted">本题还没有提交记录。点击「提交当前文件」试试。</p>`;
    }
    const expanded = this.expandedSubmitId ?? this.submissions[0]?.submitId;
    return this.submissions
      .map((record) =>
        renderSubmissionItem(
          record,
          this.details.get(record.submitId),
          record.submitId === expanded,
        ),
      )
      .join("");
  }

  /** 把一次自测结果回填到面板的自测区（命令行入口拿到结果后也走这里） */
  showSelfTestResult(result: TestJudgeResult): void {
    void this.post({ type: "selfTestResult", html: renderTestResult(result) });
  }

  /** 面板里的「运行自测」：输入交给扩展去跑，结果原地回填 */
  private async runSelfTest(userInput: string): Promise<void> {
    this.setBusy(true);
    await this.post({ type: "selfTestResult", html: `<p class="muted">正在运行自测…</p>` });
    try {
      const result = await this.deps.onSelfTest(this.pid, this.context, userInput);
      await this.post({ type: "selfTestResult", html: renderTestResult(result) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[面板] 自测失败：${message}`);
      await this.post({
        type: "selfTestResult",
        html: `<p class="bad">自测失败：${escapeHtml(message)}</p>`,
      });
    } finally {
      this.setBusy(false);
    }
  }

  /** 折叠项被展开时才去拉这条提交的评测详情 */
  private async loadSubmissionDetail(submitId: number): Promise<void> {
    const cached = this.details.get(submitId);
    if (cached) {
      void this.panel.webview.postMessage({
        type: "submissionDetail",
        submitId,
        html: renderSubmissionResult(cached),
      });
      return;
    }
    try {
      const detail = await problemApi.submissionDetail(this.deps.session.client, submitId);
      this.details.set(submitId, detail);
      void this.panel.webview.postMessage({
        type: "submissionDetail",
        submitId,
        html: renderSubmissionResult(detail),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[面板] 提交 ${submitId} 详情加载失败：${message}`);
      void this.panel.webview.postMessage({
        type: "submissionDetail",
        submitId,
        html: `<p class="bad">评测详情加载失败：${escapeHtml(message)}</p>`,
      });
    }
  }

  private async render(): Promise<void> {
    if (!this.problem) {
      return;
    }
    const base = this.problem.problemBaseVO;
    const body = await renderMarkdown(base.content ?? "");
    this.panel.title = `${base.problemId} ${base.title}`;
    this.panel.webview.html = buildHtml(this.problem, {
      bodyHtml: body,
      accepted: this.problem.accepted,
      contextHint: this.contextHint(),
      kind: problemKind(this.problem),
      submissionsHtml: this.renderSubmissionList(),
      katexUri: this.katexUri,
      cspSource: this.panel.webview.cspSource,
    });
  }

  /** 面板顶部用来提示「这是从比赛/题单里打开的题目」 */
  private contextHint(): string | undefined {
    const context = this.context;
    if (!context) {
      return undefined;
    }
    const parts: string[] = [];
    if (context.cid) {
      parts.push("比赛题目");
    }
    if (context.tid) {
      parts.push("题单题目");
    }
    if (parts.length === 0 && context.gid) {
      parts.push("小组题目");
    }
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }

  private async handleMessage(message: {
    type: string;
    action?: string;
    submitId?: number;
    code?: string;
    answers?: Record<string, string>;
    input?: string;
  }): Promise<void> {
    // 展开某条提交记录时才拉详情
    if (message.type === "submissionDetail" && typeof message.submitId === "number") {
      await this.loadSubmissionDetail(message.submitId);
      return;
    }
    if (message.type !== "action" || !this.problem) {
      return;
    }
    switch (message.action) {
      case "code":
        await this.deps.onOpenCodeFile(this.pid, this.problem.problemBaseVO.problemId, this.context);
        break;
      case "submit":
        await this.deps.onSubmit(this.pid, this.context);
        break;
      case "submitAnswers": {
        const kind = problemKind(this.problem);
        const answers = message.answers ?? {};
        // 选择题交的是选项 id，客观题交的是小题号 → 答案
        const empty = kind === "choice" ? !message.code : Object.keys(answers).length === 0;
        if (empty) {
          void vscode.window.showWarningMessage("还没有作答，先选/填一下再提交。");
          break;
        }
        await this.deps.onSubmitAnswers(this.pid, this.context, {
          kind: kind === "choice" ? "choice" : "objective",
          code: message.code,
          answers,
        });
        break;
      }
      case "selfTest":
        await this.runSelfTest(message.input ?? "");
        break;
      case "refresh":
        await this.load();
        break;
      case "browser":
        this.deps.onOpenInBrowser(this.pid, this.context);
        break;
    }
  }

  dispose(): void {
    if (ProblemPanel.current === this) {
      ProblemPanel.current = undefined;
    }
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
