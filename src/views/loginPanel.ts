import * as vscode from "vscode";
import { auth } from "../api/endpoints";
import type { Session } from "../session";

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 5 * 60 * 1000;

/**
 * 微信小程序扫码登录。
 * 服务端不校验腾讯验证码票据，因此可以在插件内完整跑通。
 * 返回登录拿到的 token；用户取消或超时返回 undefined。
 */
export async function showQrLoginPanel(
  session: Session,
  extensionUri: vscode.Uri,
): Promise<string | undefined> {
  const panel = vscode.window.createWebviewPanel(
    "htoj.login",
    "核桃OJ 登录",
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [extensionUri] },
  );

  return new Promise<string | undefined>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    let sessionId: string | undefined;
    const startedAt = Date.now();

    const finish = (token?: string) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearInterval(timer);
      }
      panel.dispose();
      resolve(token);
    };

    const status = (text: string, kind: "info" | "error" = "info") => {
      void panel.webview.postMessage({ type: "status", text, kind });
    };

    const loadQrCode = async () => {
      status("正在获取二维码…");
      try {
        const result = await auth.qrCode(session.client);
        sessionId = result.sessionId;
        void panel.webview.postMessage({
          type: "qrcode",
          image: `data:image/jpeg;base64,${result.ticketBase64}`,
        });
        status("请使用微信扫码登录");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status(`二维码获取失败：${message}`, "error");
      }
    };

    const poll = async () => {
      if (finished || !sessionId) {
        return;
      }
      if (Date.now() - startedAt > MAX_POLL_MS) {
        status("二维码已过期，请点击「刷新二维码」重试", "error");
        return;
      }
      try {
        const result = await auth.qrCodeCheck(session.client, sessionId);
        const token = result.token?.trim();
        if (token) {
          status("登录成功");
          finish(token);
          return;
        }
        if (result.qrCodeStatus === 2) {
          status("已扫码，请在手机上确认");
        } else if (result.qrCodeStatus === 3) {
          status("已确认，正在登录…");
        }
      } catch {
        // 轮询失败重试即可，不打扰用户
      }
    };

    panel.webview.onDidReceiveMessage(
      (message: { type: string }) => {
        if (message.type === "refresh") {
          void loadQrCode();
        } else if (message.type === "cancel") {
          finish(undefined);
        }
      },
      undefined,
      [],
    );

    panel.onDidDispose(() => finish(undefined), undefined, []);

    panel.webview.html = buildLoginHtml();
    void loadQrCode();
    timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  });
}

function buildLoginHtml(): string {
  const nonce = `${Date.now()}${Math.random()}`.replace(/\W/g, "");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    display: flex; flex-direction: column; align-items: center;
    padding: 28px 16px; gap: 14px;
  }
  h1 { font-size: 1.2em; margin: 0; }
  #qr {
    width: 260px; height: 260px; object-fit: contain;
    background: #fff; padding: 8px; border-radius: 8px;
    border: 1px solid var(--vscode-panel-border);
  }
  #placeholder {
    width: 260px; height: 260px; display: flex; align-items: center; justify-content: center;
    background: var(--vscode-editorWidget-background); border-radius: 8px;
    color: var(--vscode-descriptionForeground);
  }
  #status { min-height: 1.4em; color: var(--vscode-descriptionForeground); }
  #status.error { color: #FF1D27; }
  .tip { font-size: 0.9em; color: var(--vscode-descriptionForeground); text-align: center; max-width: 380px; }
  .toolbar { display: flex; gap: 8px; }
  button {
    font-family: inherit; font-size: inherit; cursor: pointer; padding: 4px 14px;
    border: none; border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
  }
</style>
</head>
<body>
  <h1>扫码登录核桃OJ</h1>
  <div id="placeholder">二维码加载中…</div>
  <img id="qr" hidden alt="登录二维码" />
  <div id="status">正在准备…</div>
  <div class="tip">用微信扫描上方二维码，并在手机上确认登录。</div>
  <div class="toolbar">
    <button id="refresh">刷新二维码</button>
    <button id="cancel">取消</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const qr = document.getElementById("qr");
  const placeholder = document.getElementById("placeholder");
  const status = document.getElementById("status");

  document.getElementById("refresh").addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
  });
  document.getElementById("cancel").addEventListener("click", () => {
    vscode.postMessage({ type: "cancel" });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "qrcode") {
      qr.src = message.image;
      qr.hidden = false;
      placeholder.hidden = true;
    } else if (message.type === "status") {
      status.textContent = message.text;
      status.className = message.kind === "error" ? "error" : "";
    }
  });
</script>
</body>
</html>`;
}
