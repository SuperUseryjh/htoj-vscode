import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("核桃OJ");
  }
  return channel;
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 写一行日志到「输出 → 核桃OJ」 */
export function log(...parts: unknown[]): void {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  getChannel().appendLine(`[${time}] ${parts.map(stringify).join(" ")}`);
}

/** 记录错误（含堆栈） */
export function logError(scope: string, error: unknown): void {
  log(`!! ${scope}`, error);
}

/** 记录一次失败的加载，并提示用户去开日志 */
export function logLoadFailure(scope: string, error: unknown): void {
  logError(scope, error);
  void vscode.window
    .showWarningMessage(`核桃OJ：${scope} 加载失败，详见输出面板。`, "查看日志")
    .then((choice) => {
      if (choice === "查看日志") {
        getChannel().show(true);
      }
    });
}
