import * as vscode from "vscode";
import type { ProblemContext } from "./api/types";
import type { Session } from "./session";

export interface ProblemRef {
  pid: number;
  problemId: string;
  /** 比赛 / 题单 / 小组上下文，提交时要一起带上 */
  context?: ProblemContext;
}

const MARKER_PATTERN =
  /@htoj\s+pid=(\d+)(?:\s+problemId=(\S+))?(?:\s+cid=(\d+))?(?:\s+tid=(\d+))?(?:\s+gid=(\d+))?/;

function configuredDirectory(): string {
  return vscode.workspace.getConfiguration("htoj").get<string>("codeDirectory") ?? "htoj";
}

function configuredLanguage(): string {
  return vscode.workspace.getConfiguration("htoj").get<string>("defaultLanguage") ?? "C++17 With O2";
}

function extensionFor(language: string): { ext: string; template: (ref: ProblemRef) => string } {
  if (/python/i.test(language)) {
    return {
      ext: "py",
      template: (ref) => `${header(ref, "#")}
import sys

def main():
    data = sys.stdin.read().split()
    # TODO

if __name__ == "__main__":
    main()
`,
    };
  }
  return {
    ext: "cpp",
    template: (ref) => `${header(ref, "//")}
#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    return 0;
}
`,
  };
}

function header(ref: ProblemRef, comment: string): string {
  const zone = vscode.workspace.getConfiguration("htoj").get<string>("zone") ?? "cpp";
  const marker = [`@htoj pid=${ref.pid}`, `problemId=${ref.problemId}`];
  const query = [`pid=${ref.pid}`];
  if (ref.context?.cid) {
    marker.push(`cid=${ref.context.cid}`);
    query.push(`cid=${ref.context.cid}`);
  }
  if (ref.context?.tid) {
    marker.push(`tid=${ref.context.tid}`);
    query.push(`tid=${ref.context.tid}`);
  }
  if (ref.context?.gid) {
    marker.push(`gid=${ref.context.gid}`);
    query.push(`gid=${ref.context.gid}`);
  }
  return [
    `${comment} ${marker.join(" ")}`,
    `${comment} 题目：${ref.problemId}`,
    `${comment} 链接：https://htoj.com.cn/${zone}/oj/problem/detail?${query.join("&")}`,
  ].join("\n");
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 60);
}

/** 从已打开的代码文件里解析出题目信息（读取文件头部注释标记） */
export function parseProblemFromDocument(document: vscode.TextDocument): ProblemRef | undefined {
  const head = document.getText(new vscode.Range(0, 0, Math.min(document.lineCount, 12), 0));
  const match = MARKER_PATTERN.exec(head);
  if (!match) {
    return undefined;
  }
  const [, pid, problemId, cid, tid, gid] = match;
  const context: ProblemContext = {};
  if (cid) {
    context.cid = Number(cid);
  }
  if (tid) {
    context.tid = Number(tid);
  }
  if (gid) {
    context.gid = Number(gid);
  }
  return {
    pid: Number(pid),
    problemId: problemId ?? "?",
    context: Object.keys(context).length > 0 ? context : undefined,
  };
}

/** 新建（或打开）题目对应的本地代码文件 */
export async function openCodeFile(session: Session, problem: ProblemRef): Promise<vscode.TextEditor> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("请先打开一个文件夹作为工作区，插件才能创建代码文件。");
  }

  const language = configuredLanguage();
  const { ext, template } = extensionFor(language);
  const directory = vscode.Uri.joinPath(folder.uri, configuredDirectory());
  const fileName = `${sanitize(problem.problemId)}.${ext}`;
  const fileUri = vscode.Uri.joinPath(directory, fileName);

  // 已有同名文件时按题目编号再搜一遍（标题变化导致文件名变化的情况）
  const existing = await findExistingFile(directory, problem.pid);
  const target = existing ?? fileUri;

  let created = false;
  try {
    await vscode.workspace.fs.stat(target);
  } catch {
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(target, Buffer.from(template(problem), "utf8"));
    created = true;
  }

  const document = await vscode.workspace.openTextDocument(target);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand("setContext", "htoj.isHtojFile", true);

  // 打开后顺手把标题补进文件名注释里（仅新建时提示）
  if (created) {
    void vscode.window.setStatusBarMessage(`已创建 ${fileName}`, 3000);
  }
  return editor;
}

/** 在目录里按 pid 标记找已存在的代码文件 */
async function findExistingFile(directory: vscode.Uri, pid: number): Promise<vscode.Uri | undefined> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(directory);
  } catch {
    return undefined;
  }
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File || !/\.(cpp|cc|cxx|py|txt)$/i.test(name)) {
      continue;
    }
    const candidate = vscode.Uri.joinPath(directory, name);
    try {
      const bytes = await vscode.workspace.fs.readFile(candidate);
      const head = Buffer.from(bytes).toString("utf8").slice(0, 500);
      const match = MARKER_PATTERN.exec(head);
      if (match && Number(match[1]) === pid) {
        return candidate;
      }
    } catch {
      // 忽略读取失败的文件
    }
  }
  return undefined;
}
