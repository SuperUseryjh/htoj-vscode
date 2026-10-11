import * as vscode from "vscode";
import { auth } from "../api/endpoints";
import type { UserInfo } from "../api/types";
import type { Session } from "../session";

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 5 * 60 * 1000;

/** 腾讯验证码：SDK 与 appid 见 re/src/packages/core/utils/constant.ts */
const TCAPTCHA_SDK_URL = "https://turing.captcha.qcloud.com/TCaptcha.js";
const TCAPTCHA_APP_ID = "190559420";
/** 发送成功后按钮倒计时秒数 */
const SMS_COOLDOWN_SECONDS = 60;

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

/**
 * 短信验证码登录。
 *
 * 发送验证码接口强制校验腾讯 TCaptcha 票据，票据只能由腾讯验证码组件在**用户完成验证**后
 * 给出（无法本地生成，伪造会被服务端拒），所以这里弹一个可见面板：
 * 用户拖一下滑块 → 拿到 ticket/randstr → 插件侧调发送验证码 → 用户输入收到的验证码 → 登录。
 *
 * 返回登录成功后的用户信息；取消、关闭面板返回 undefined。
 */
export async function showSmsLoginPanel(
  session: Session,
  extensionUri: vscode.Uri,
): Promise<UserInfo | undefined> {
  const panel = vscode.window.createWebviewPanel(
    "htoj.login.sms",
    "核桃OJ 短信验证码登录",
    vscode.ViewColumn.Active,
    // 验证码是腾讯的 iframe，切走标签页时如果不保留上下文，回来就得重新拖一次
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
  );

  return new Promise<UserInfo | undefined>((resolve) => {
    let finished = false;

    const finish = (user?: UserInfo) => {
      if (finished) {
        return;
      }
      finished = true;
      panel.dispose();
      resolve(user);
    };

    const status = (text: string, kind: "info" | "error" = "info") => {
      void panel.webview.postMessage({ type: "status", text, kind });
    };

    panel.webview.onDidReceiveMessage(
      async (message: {
        type: string;
        phone?: string;
        code?: string;
        ticket?: string;
        randstr?: string;
      }) => {
        if (message.type === "send") {
          status("正在发送验证码…");
          try {
            await session.sendVerifyCode(
              message.phone ?? "",
              message.ticket ?? "",
              message.randstr ?? "",
            );
            void panel.webview.postMessage({
              type: "sent",
              text: "验证码已发送，请查看短信",
              cooldown: SMS_COOLDOWN_SECONDS,
            });
          } catch (error) {
            status(`发送失败：${describeError(error)}`, "error");
          }
        } else if (message.type === "login") {
          status("正在登录…");
          try {
            const user = await session.loginByVerifyCode(message.phone ?? "", message.code ?? "");
            status("登录成功");
            finish(user);
          } catch (error) {
            status(`登录失败：${describeError(error)}`, "error");
          }
        } else if (message.type === "cancel") {
          finish(undefined);
        }
      },
      undefined,
      [],
    );

    panel.onDidDispose(() => finish(undefined), undefined, []);
    panel.webview.html = buildSmsLoginHtml();
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildSmsLoginHtml(): string {
  const nonce = `${Date.now()}${Math.random()}`.replace(/\W/g, "");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data: https://turing.captcha.qcloud.com https://turing.captcha.gtimg.com; style-src 'unsafe-inline' https://turing.captcha.qcloud.com https://turing.captcha.gtimg.com; font-src https://turing.captcha.qcloud.com https://turing.captcha.gtimg.com; script-src 'nonce-${nonce}' https://turing.captcha.qcloud.com; frame-src https://turing.captcha.qcloud.com https://turing.captcha.gtimg.com; connect-src https://turing.captcha.qcloud.com https://turing.captcha.gtimg.com;" />
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    display: flex; flex-direction: column; align-items: center;
    padding: 28px 16px; gap: 14px;
  }
  h1 { font-size: 1.2em; margin: 0; }
  .field { width: 320px; }
  .row { display: flex; gap: 8px; align-items: center; }
  input {
    flex: 1; width: 100%; box-sizing: border-box; padding: 6px 8px;
    font-family: inherit; font-size: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }
  #status { min-height: 1.4em; max-width: 380px; text-align: center; color: var(--vscode-descriptionForeground); }
  #status.error { color: #FF1D27; }
  .toolbar { display: flex; gap: 8px; }
  button {
    font-family: inherit; font-size: inherit; cursor: pointer; padding: 4px 14px;
    white-space: nowrap; border: none; border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
</style>
</head>
<body>
  <h1>短信验证码登录</h1>
  <div class="field"><input id="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="手机号（11 位）" autocomplete="off" /></div>
  <div class="field row">
    <input id="code" type="text" inputmode="numeric" maxlength="8" placeholder="短信验证码" autocomplete="off" />
    <button id="send">获取验证码</button>
  </div>
  <div id="status">填入手机号后点「获取验证码」：会弹出腾讯验证码，拖动滑块完成验证后才会发送短信。</div>
  <div class="toolbar">
    <button id="login" class="primary">登录</button>
    <button id="cancel">取消</button>
  </div>
<script nonce="${nonce}">
  var vscode = acquireVsCodeApi();
  var TCAPTCHA_APP_ID = "${TCAPTCHA_APP_ID}";
  var TCAPTCHA_SDK_URL = "${TCAPTCHA_SDK_URL}";
  var COOLDOWN_SECONDS = ${SMS_COOLDOWN_SECONDS};

  var phoneEl = document.getElementById("phone");
  var codeEl = document.getElementById("code");
  var sendBtn = document.getElementById("send");
  var loginBtn = document.getElementById("login");
  var statusEl = document.getElementById("status");
  var sdkPromise = null;
  var cooldownTimer = null;

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind === "error" ? "error" : "";
  }

  function isPhoneNumber(value) {
    if (value.length !== 11 || value.charAt(0) !== "1") {
      return false;
    }
    for (var i = 0; i < value.length; i++) {
      var c = value.charAt(i);
      if (c < "0" || c > "9") {
        return false;
      }
    }
    return true;
  }

  function startCooldown(seconds) {
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
    }
    var left = seconds;
    sendBtn.disabled = true;
    sendBtn.textContent = "重发（" + left + "s）";
    cooldownTimer = setInterval(function () {
      left = left - 1;
      if (left <= 0) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
        sendBtn.disabled = false;
        sendBtn.textContent = "重新获取";
      } else {
        sendBtn.textContent = "重发（" + left + "s）";
      }
    }, 1000);
  }

  function loadCaptchaSdk() {
    if (sdkPromise) {
      return sdkPromise;
    }
    sdkPromise = new Promise(function (resolve, reject) {
      if (typeof window.TencentCaptcha === "function") {
        resolve();
        return;
      }
      var script = document.createElement("script");
      script.src = TCAPTCHA_SDK_URL;
      script.onload = function () {
        resolve();
      };
      script.onerror = function () {
        sdkPromise = null;
        reject(new Error("腾讯验证码组件加载失败，请检查网络或代理"));
      };
      document.head.appendChild(script);
    });
    return sdkPromise;
  }

  sendBtn.addEventListener("click", function () {
    var phone = phoneEl.value.trim();
    if (!isPhoneNumber(phone)) {
      setStatus("请输入 11 位手机号", "error");
      return;
    }
    setStatus("正在加载腾讯验证码…");
    sendBtn.disabled = true;
    loadCaptchaSdk()
      .then(function () {
        var captcha = new window.TencentCaptcha(
          TCAPTCHA_APP_ID,
          function (res) {
            if (res && res.ret === 0 && res.ticket) {
              setStatus("验证通过，正在发送验证码…");
              vscode.postMessage({ type: "send", phone: phone, ticket: res.ticket, randstr: res.randstr });
            } else {
              setStatus("未完成验证，可重试", "error");
              sendBtn.disabled = false;
            }
          },
          {},
        );
        captcha.show();
      })
      .catch(function (error) {
        setStatus(error && error.message ? error.message : String(error), "error");
        sendBtn.disabled = false;
      });
  });

  loginBtn.addEventListener("click", function () {
    var phone = phoneEl.value.trim();
    var code = codeEl.value.trim();
    if (!isPhoneNumber(phone)) {
      setStatus("请输入 11 位手机号", "error");
      return;
    }
    if (!code) {
      setStatus("请输入收到的短信验证码", "error");
      return;
    }
    loginBtn.disabled = true;
    setStatus("正在登录…");
    vscode.postMessage({ type: "login", phone: phone, code: code });
  });

  document.getElementById("cancel").addEventListener("click", function () {
    vscode.postMessage({ type: "cancel" });
  });

  codeEl.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      loginBtn.click();
    }
  });

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (message.type === "status") {
      setStatus(message.text, message.kind);
      if (message.kind === "error") {
        loginBtn.disabled = false;
        if (!cooldownTimer) {
          sendBtn.disabled = false;
        }
      }
      return;
    }
    if (message.type === "sent") {
      setStatus(message.text || "验证码已发送");
      startCooldown(message.cooldown || COOLDOWN_SECONDS);
      codeEl.focus();
    }
  });
</script>
</body>
</html>`;
}
