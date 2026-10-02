import type { ApiEnvelope, GatewayError } from "./types";

export const DEFAULT_API_BASE = "https://api.htoj.com.cn";
export const HETAO_API_BASE = "https://api.hetao101.com";

/** 核桃 OJ 站点接口的公共请求头（缺 Hetao-Oj-Zone 网关会直接报错） */
export const COMMON_HEADERS: Record<string, string> = {
  HT_PLATFORM: "htojWeb",
  HT_SYSTEM: "web",
  HT_VERSION: "1.0.0",
  app_id: "com.hetao101.oj",
};

export class HtojApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "HtojApiError";
  }

  get isUnauthorized(): boolean {
    return this.code === 401;
  }
}

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  /** 是否附加 Hetao-Oj-Zone / Authorization（站点接口需要，登录接口不需要） */
  siteScoped?: boolean;
  /** 走绝对地址时指定 base（默认站点网关） */
  base?: string;
  timeoutMs?: number;
}

export interface ClientDeps {
  getToken: () => string | undefined;
  getZone: () => string;
  /** 站点网关地址，可在设置里修改 */
  getApiBase?: () => string;
  /** 日志输出（注入以便在非 VSCode 环境下复用本模块） */
  log?: (message: string) => void;
}

function buildUrl(base: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path.startsWith("http") ? path : base + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 服务端有频控（返回「访问太频繁，请稍后再试！」），只读请求自动重试 */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof HtojApiError)) {
    return false;
  }
  if (error.code === 429) {
    return true;
  }
  return /频繁|稍后再试|too many/i.test(error.message);
}

export class HtojClient {
  constructor(private readonly deps: ClientDeps) {}

  get apiBase(): string {
    return this.deps.getApiBase?.() ?? DEFAULT_API_BASE;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const isWrite = options.method !== undefined && options.method !== "GET";
    const maxAttempts = isWrite ? 1 : 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.send<T>(path, options);
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts || !isRetryable(error)) {
          break;
        }
        await delay(700 * attempt);
      }
    }
    throw lastError;
  }

  private async send<T>(path: string, options: RequestOptions): Promise<T> {
    const {
      method = "GET",
      query,
      body,
      headers: extraHeaders,
      siteScoped = path.startsWith("/api/"),
      base,
      timeoutMs = 20000,
    } = options;

    const url = buildUrl(base ?? this.apiBase, path, query);
    const token = this.deps.getToken();

    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extraHeaders,
    };

    if (siteScoped) {
      Object.assign(headers, COMMON_HEADERS, { "Hetao-Oj-Zone": this.deps.getZone() });
      if (token) {
        headers.Authorization = token;
      }
    }

    this.trace(
      `--> ${method} ${url}`,
      siteScoped ? `[zone=${this.deps.getZone()} token=${token ? "有" : "无"}]` : "[登录接口]",
    );

    if (typeof globalThis.fetch !== "function") {
      throw new HtojApiError(
        -1,
        "当前运行环境没有全局 fetch（需要 Node 18+ / VSCode 1.85+），无法发起请求。",
      );
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.trace(`xx  ${method} ${url} 请求失败（${Date.now() - startedAt}ms）：${reason}`);
      throw new HtojApiError(-1, `网络请求失败：${reason}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const elapsed = Date.now() - startedAt;

    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      this.trace(`<-- HTTP ${response.status} ${url} 非 JSON：${text.slice(0, 200)}`);
      throw new HtojApiError(response.status, `接口返回了非 JSON 内容（HTTP ${response.status}）`);
    }

    // 网关自身的错误结构：{ code, message }
    if (!("errCode" in (payload as object)) && !("errcode" in (payload as object))) {
      const gateway = payload as GatewayError;
      this.trace(`<-- HTTP ${response.status} ${url} 网关错误：${gateway.code} ${gateway.message}`);
      throw new HtojApiError(
        gateway.code ?? response.status,
        gateway.message ?? `请求失败（HTTP ${response.status}）`,
      );
    }

    const envelope = payload as ApiEnvelope<T>;
    const code = envelope.errCode === undefined ? (envelope.errcode ?? 0) : envelope.errCode;
    const message =
      envelope.errCode === undefined
        ? (envelope.errmsg ?? "请求失败")
        : (envelope.errMsg ?? "请求失败");

    if (code !== 0) {
      this.trace(`<-- HTTP ${response.status} errCode=${code} ${elapsed}ms ${url} :: ${message}`);
      throw new HtojApiError(code, message);
    }

    const data = envelope.data;
    const asRecord = data as unknown as { records?: unknown[]; total?: number } | null;
    const shape = Array.isArray(data)
      ? `Array(${data.length})`
      : asRecord && typeof asRecord === "object" && Array.isArray(asRecord.records)
        ? `Page(${asRecord.records.length}/${asRecord.total})`
        : "object";
    this.trace(`<-- HTTP ${response.status} ok ${elapsed}ms ${shape} ${url}`);
    return data;
  }

  private trace(...parts: string[]): void {
    this.deps.log?.(parts.join(" "));
  }

  get<T>(path: string, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "GET" });
  }

  post<T>(path: string, options: Omit<RequestOptions, "method"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "POST" });
  }
}
