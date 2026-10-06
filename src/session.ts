import * as vscode from "vscode";
import { DEFAULT_API_BASE, HtojApiError, HtojClient } from "./api/client";
import { auth, user } from "./api/endpoints";
import type { UserInfo } from "./api/types";
import { log, logError } from "./util/logger";

const TOKEN_KEY = "htoj.token";
/** 密码登录后留下的凭据，用于 token 过期时静默续期 */
const CREDENTIAL_KEY = "htoj.passwordCredential";

/** token 剩余寿命不足这个时长就提前续期，免得请求正好撞在过期点上 */
const RENEW_MARGIN_MS = 5 * 60 * 1000;

interface StoredCredential {
  phoneNumber: string;
  password: string;
}

/**
 * 从 JWT 里读 exp（只解析不验签，我们只需要知道什么时候过期）。
 * 不是 JWT、没有 exp 或格式不对时返回 undefined。
 */
function jwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function config() {
  return vscode.workspace.getConfiguration("htoj");
}

/** 登录态、zone、用户信息与共享的 HTTP 客户端 */
export class Session implements vscode.Disposable {
  private token: string | undefined;
  private userInfo: UserInfo | undefined;
  /** 密码登录时存的凭据；扫码 / 粘贴 Token 登录不会留下它 */
  private credential: StoredCredential | undefined;
  /** 正在进行的续期，避免并发请求各续一次 */
  private renewing: Promise<void> | undefined;

  private readonly emitter = new vscode.EventEmitter<void>();
  /** 登录状态或 zone 变化时触发，用于刷新各视图 */
  readonly onDidChange = this.emitter.event;

  readonly client: HtojClient;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.client = new HtojClient({
      getToken: () => this.token,
      getZone: () => this.zone,
      getApiBase: () => config().get<string>("apiBase") ?? DEFAULT_API_BASE,
      beforeRequest: () => this.ensureFreshToken(),
      log: (message) => log("[http]", message),
    });
  }

  get zone(): string {
    return config().get<string>("zone") ?? "cpp";
  }

  get isLoggedIn(): boolean {
    return Boolean(this.token);
  }

  get currentUser(): UserInfo | undefined {
    return this.userInfo;
  }

  get displayName(): string {
    return this.userInfo?.nickname || this.userInfo?.username || "未登录";
  }

  /** 从 SecretStorage 恢复 token 并校验有效性 */
  async restore(): Promise<void> {
    log("[session] restore：apiBase =", this.client.apiBase, "zone =", this.zone);
    this.token = await this.secrets.get(TOKEN_KEY);
    this.credential = await this.readCredential();
    if (!this.token) {
      log("[session] 本地没有已保存的 token");
      return;
    }
    log("[session] 找到已保存的 token，长度", this.token.length, "，正在校验…");
    // 上次退出时 token 可能已经过期，先尝试用保存的密码续期，省得用户手动登录
    await this.ensureFreshToken();
    try {
      this.userInfo = await user.me(this.client);
      log("[session] token 有效，用户：", this.userInfo.nickname);
    } catch (error) {
      log("[session] token 校验失败，已清除：", error instanceof Error ? error.message : String(error));
      await this.clearToken();
    }
  }

  /**
   * 用 token 登录并拉取用户信息，失败时抛出异常。
   * 扫码 / 粘贴 Token 登录会走这里，并清掉之前密码登录留下的凭据——
   * 否则换了账号之后，续期会把登录态悄悄切回上一个账号。
   */
  async loginWithToken(token: string): Promise<UserInfo> {
    const info = await this.applyToken(token);
    await this.forgetCredential();
    return info;
  }

  private async applyToken(token: string): Promise<UserInfo> {
    const previous = this.token;
    this.token = token.trim();
    log("[session] 校验新 token，长度", this.token.length);
    try {
      this.userInfo = await user.me(this.client);
    } catch (error) {
      this.token = previous;
      logError("[session] token 校验失败", error);
      throw error;
    }
    await this.secrets.store(TOKEN_KEY, this.token);
    log("[session] 登录成功：", this.userInfo.nickname, "uid =", this.userInfo.uid);
    this.emitter.fire();
    return this.userInfo;
  }

  /** 刷新用户信息 */
  async refreshUser(): Promise<UserInfo> {
    this.userInfo = await user.me(this.client);
    this.emitter.fire();
    return this.userInfo;
  }

  async logout(): Promise<void> {
    await this.clearToken();
    await this.forgetCredential();
  }

  private async clearToken(): Promise<void> {
    this.token = undefined;
    this.userInfo = undefined;
    await this.secrets.delete(TOKEN_KEY);
    this.emitter.fire();
  }

  // --- token 续期 -------------------------------------------------------

  /**
   * 站点请求前调用：token 快过期且留着密码凭据时，静默重新登录换一个新 token。
   *
   * 判断依据是 JWT 自带的 exp，而不是看接口报错——核桃的 errCode 401 也用于
   * 「每页最多显示20条记录」这类业务错误，拿它当「登录失效」会误判。
   */
  async ensureFreshToken(): Promise<void> {
    if (!this.token || !this.credential) {
      return;
    }
    const expiry = jwtExpiry(this.token);
    if (expiry === undefined || expiry - Date.now() > RENEW_MARGIN_MS) {
      return;
    }
    // 续期中的登录请求也会经过这个方法（此时 token 已换新，会在上面提前返回），
    // 所以这里只需等待已在跑的那次，不会自锁
    if (this.renewing) {
      return this.renewing;
    }
    this.renewing = this.renew().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  private async renew(): Promise<void> {
    const credential = this.credential;
    if (!credential) {
      return;
    }
    // 续期期间先摘下凭据：续期自己发出的请求（applyToken → user.me）会经过 ensureFreshToken，
    // 不摘掉的话它会去等待这次还没结束的续期，把自己锁死
    this.credential = undefined;
    log("[session] token 即将过期，用保存的密码自动续期…");
    try {
      const result = await auth.loginByPassword(this.client, credential);
      await this.applyToken(result.token);
      this.credential = credential;
      log("[session] 自动续期成功，新 token 已保存");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("[session] 自动续期失败：", message);
      this.credential = credential;
      // 网络问题（-1）留着凭据下次再试；其余基本是密码改了、账号异常，再试也没用
      if (error instanceof HtojApiError && error.code !== -1) {
        await this.forgetCredential();
        void vscode.window
          .showWarningMessage(`核桃OJ：自动续期失败（${message}），请重新登录。`, "登录")
          .then((choice) => {
            if (choice === "登录") {
              void vscode.commands.executeCommand("htoj.login");
            }
          });
      }
    }
  }

  private async readCredential(): Promise<StoredCredential | undefined> {
    const raw = await this.secrets.get(CREDENTIAL_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as StoredCredential;
      return parsed.phoneNumber && parsed.password ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async forgetCredential(): Promise<void> {
    if (!this.credential) {
      return;
    }
    this.credential = undefined;
    await this.secrets.delete(CREDENTIAL_KEY);
    log("[session] 已清除保存的密码凭据（不再自动续期）");
  }

  async setZone(zone: "cpp" | "python"): Promise<void> {
    await config().update("zone", zone, vscode.ConfigurationTarget.Global);
    this.emitter.fire();
  }

  notifyChanged(): void {
    this.emitter.fire();
  }

  // --- 登录方式 ---------------------------------------------------------

  /**
   * 手机号 + 密码登录（无需验证码票据）。
   * 成功后会把凭据存进 SecretStorage（走系统钥匙串），token 过期时自动续期；
   * 退出登录、或改用扫码 / 粘贴 Token 登录都会清除它。
   */
  async loginByPassword(phoneNumber: string, password: string): Promise<UserInfo> {
    const result = await auth.loginByPassword(this.client, { phoneNumber, password });
    const info = await this.applyToken(result.token);
    this.credential = { phoneNumber, password };
    await this.secrets.store(CREDENTIAL_KEY, JSON.stringify(this.credential));
    log("[session] 已保存密码凭据，token 过期后可自动续期");
    return info;
  }

  /** 短信验证码登录（验证码需自行通过官方渠道获取） */
  async loginByVerifyCode(phoneNumber: string, verifyCode: string): Promise<UserInfo> {
    const result = await auth.loginByVerifyCode(this.client, { phoneNumber, verifyCode });
    return this.loginWithToken(result.token);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
