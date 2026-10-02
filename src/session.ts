import * as vscode from "vscode";
import { DEFAULT_API_BASE, HtojClient } from "./api/client";
import { auth, user } from "./api/endpoints";
import type { UserInfo } from "./api/types";
import { log, logError } from "./util/logger";

const TOKEN_KEY = "htoj.token";

function config() {
  return vscode.workspace.getConfiguration("htoj");
}

/** 登录态、zone、用户信息与共享的 HTTP 客户端 */
export class Session implements vscode.Disposable {
  private token: string | undefined;
  private userInfo: UserInfo | undefined;

  private readonly emitter = new vscode.EventEmitter<void>();
  /** 登录状态或 zone 变化时触发，用于刷新各视图 */
  readonly onDidChange = this.emitter.event;

  readonly client: HtojClient;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.client = new HtojClient({
      getToken: () => this.token,
      getZone: () => this.zone,
      getApiBase: () => config().get<string>("apiBase") ?? DEFAULT_API_BASE,
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
    if (!this.token) {
      log("[session] 本地没有已保存的 token");
      return;
    }
    log("[session] 找到已保存的 token，长度", this.token.length, "，正在校验…");
    try {
      this.userInfo = await user.me(this.client);
      log("[session] token 有效，用户：", this.userInfo.nickname);
    } catch (error) {
      log("[session] token 校验失败，已清除：", error instanceof Error ? error.message : String(error));
      await this.clearToken();
    }
  }

  /** 用 token 登录并拉取用户信息，失败时抛出异常 */
  async loginWithToken(token: string): Promise<UserInfo> {
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
  }

  private async clearToken(): Promise<void> {
    this.token = undefined;
    this.userInfo = undefined;
    await this.secrets.delete(TOKEN_KEY);
    this.emitter.fire();
  }

  async setZone(zone: "cpp" | "python"): Promise<void> {
    await config().update("zone", zone, vscode.ConfigurationTarget.Global);
    this.emitter.fire();
  }

  notifyChanged(): void {
    this.emitter.fire();
  }

  // --- 登录方式 ---------------------------------------------------------

  /** 手机号 + 密码登录（无需验证码票据） */
  async loginByPassword(phoneNumber: string, password: string): Promise<UserInfo> {
    const result = await auth.loginByPassword(this.client, { phoneNumber, password });
    return this.loginWithToken(result.token);
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
