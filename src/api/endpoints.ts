import { HETAO_API_BASE, type HtojClient, type QueryValue } from "./client";
import type {
  ContestItem,
  ContestProblem,
  ContestScoreRow,
  CountryCode,
  Difficulty,
  IdName,
  LoginToken,
  Pagination,
  ProblemDetail,
  ProblemListItem,
  QrLoginCheck,
  SubmissionDetail,
  SubmissionRecord,
  TestJudgeResult,
  TrainingChapterProblem,
  TrainingItem,
  UserInfo,
} from "./types";
import { encodeCredential } from "../util/xor";

/** 登录相关接口（api.hetao101.com），不需要 zone 头 */
export const auth = {
  countryCodes(client: HtojClient) {
    return client.get<CountryCode[]>("/login/v2/countryCodes", {
      base: HETAO_API_BASE,
      siteScoped: false,
      headers: { app_id: "com.hetao101.oj", HT_PLATFORM: "htojWeb" },
    });
  },

  /**
   * 手机号 + 密码登录。无需验证码票据。
   * 注意：手机号与密码都要经过 XOR 混淆。
   */
  loginByPassword(
    client: HtojClient,
    params: { phoneNumber: string; password: string; countryCode?: string; short?: string },
  ) {
    return client.post<LoginToken>("/login/v2/account/oauth/password", {
      base: HETAO_API_BASE,
      siteScoped: false,
      headers: { app_id: "com.hetao101.oj", HT_PLATFORM: "htojWeb", HT_SYSTEM: "web", HT_VERSION: "1.0.0" },
      body: {
        phoneNumber: encodeCredential(params.phoneNumber),
        password: encodeCredential(params.password),
        countryCode: params.countryCode ?? "86",
        short: params.short ?? "CN",
      },
    });
  },

  /**
   * 短信验证码登录（第二步）。
   * 第一步「发送验证码」需要腾讯验证码票据，插件内无法生成，故不提供发送能力。
   */
  loginByVerifyCode(
    client: HtojClient,
    params: { phoneNumber: string; verifyCode: string; countryCode?: string; short?: string },
  ) {
    return client.post<LoginToken>("/login/v2/account/oauth/verifyCode", {
      base: HETAO_API_BASE,
      siteScoped: false,
      headers: { app_id: "com.hetao101.oj", HT_PLATFORM: "htojWeb", HT_SYSTEM: "web", HT_VERSION: "1.0.0" },
      body: {
        phoneNumber: encodeCredential(params.phoneNumber),
        verifyCode: params.verifyCode,
        countryCode: params.countryCode ?? "86",
        short: params.short ?? "CN",
      },
    });
  },

  /** 微信小程序扫码登录：获取二维码 */
  qrCode(client: HtojClient) {
    return client.get<{ ticketBase64: string; sessionId: string }>(
      "/login/v1/wechat/miniprogram/qrcode",
      {
        base: HETAO_API_BASE,
        siteScoped: false,
        query: { mode: "htbcxas" },
        headers: { app_id: "com.hetao101.oj", HT_PLATFORM: "htojWeb", HT_SYSTEM: "web", HT_VERSION: "1.0.0" },
      },
    );
  },

  /** 微信小程序扫码登录：轮询扫码结果 */
  qrCodeCheck(client: HtojClient, sessionId: string) {
    return client.get<QrLoginCheck>("/login/v1/wechat/miniprogram/loginCheck", {
      base: HETAO_API_BASE,
      siteScoped: false,
      query: { sid: sessionId },
      headers: { app_id: "com.hetao101.oj", HT_PLATFORM: "htojWeb", HT_SYSTEM: "web", HT_VERSION: "1.0.0" },
    });
  },
};

/** 站点接口：题目 / 提交 */
export const problem = {
  list(
    client: HtojClient,
    query: {
      currentPage?: number;
      limit?: number;
      keyword?: string;
      wid?: number;
      difficulties?: number[];
      tagId?: number[];
      answerStatus?: number[];
    },
  ) {
    const q: Record<string, QueryValue> = {
      currentPage: query.currentPage ?? 1,
      limit: query.limit ?? 50,
      keyword: query.keyword,
      wid: query.wid,
    };
    // 多选参数是逗号拼接的字符串
    if (query.difficulties?.length) {
      q.difficulties = query.difficulties.join(",");
    }
    if (query.tagId?.length) {
      q.tagId = query.tagId.join(",");
    }
    if (query.answerStatus?.length) {
      q.answerStatus = query.answerStatus.join(",");
    }
    return client.get<Pagination<ProblemListItem>>("/api/code-community/api/get-problem-list", { query: q });
  },

  detail(client: HtojClient, problemId: number, ctx: { cid?: number; tid?: number; gid?: number } = {}) {
    return client.get<ProblemDetail>("/api/htoj-biz-gateway/api/get-problem-detail", {
      query: { problemId, ...ctx },
    });
  },

  languages(client: HtojClient) {
    return client.get<IdName[]>("/api/code-community/api/get-language");
  },

  /**
   * 提交代码 / 答案，返回 submitId。
   * 编程题传 `code` + `ioMode`；客观题传 `answers` + `language: "objective"`；
   * 选择题传 `code`（选项 id 逗号拼接）+ `language: "choice" | "multipleChoice"`。
   */
  submit(client: HtojClient, body: {
    id: number;
    language: string;
    /** 编程题必填：1 标准IO / 2 文件IO */
    ioMode?: number;
    code?: string;
    /** 客观题答案：{ 小题号: "A" | "A,C" | "填空内容" }，值必须是字符串 */
    answers?: Record<string, string>;
    costTime?: number;
    cid?: number;
    tid?: number;
    gid?: number;
  }) {
    return client.post<number>("/api/code-community/api/submit-problem-judge", { body });
  },

  /** 自测运行，返回 testJudgeKey */
  testSubmit(client: HtojClient, body: {
    id: number;
    ioMode: number;
    language: string;
    code: string;
    userInput?: string;
    cid?: number;
    tid?: number;
    gid?: number;
  }) {
    return client.post<string>("/api/code-community/api/submit-problem-test-judge", { body });
  },

  testResult(client: HtojClient, testJudgeKey: string) {
    return client.get<TestJudgeResult>("/api/code-community/api/get-test-judge-result", {
      query: { testJudgeKey },
    });
  },

  /** 提交详情（评测结果） */
  submissionDetail(client: HtojClient, submitId: number) {
    return client.get<SubmissionDetail>("/api/htoj-biz-gateway/api/get-submission-detail", {
      query: { submitId },
    });
  },

  submissionList(
    client: HtojClient,
    query: { currentPage?: number; limit?: number; pid?: number; cid?: number; tid?: number; gid?: number },
  ) {
    const { limit, ...rest } = query;
    return client.get<Pagination<SubmissionRecord>>(
      "/api/code-community/api/get-my-submission-list",
      // 后端硬限制每页最多 20 条，传大了直接 errCode 401「每页最多显示20条记录」
      { query: { currentPage: 1, ...rest, limit: Math.min(limit ?? 20, 20) } },
    );
  },

  publicSubmissionList(
    client: HtojClient,
    query: { currentPage?: number; limit?: number; problemID?: string; status?: number; language?: string; username?: string },
  ) {
    return client.get<Pagination<SubmissionRecord>>(
      "/api/code-community/api/get-submission-list",
      { query: { currentPage: 1, limit: 20, ...query } },
    );
  },

  warehouses(client: HtojClient) {
    return client.get<Array<{ value: number; label: string }>>("/api/code-community/api/warehouse/list");
  },

  difficulties(client: HtojClient) {
    return client.get<{ difficulty: Array<Difficulty & { type: string; value: number; label: string }> }>(
      "/api/code-community/api/zone-data-list",
      { query: { types: "difficulty" } },
    );
  },

  replyCount(client: HtojClient, id: number) {
    return client.get<number>("/api/code-community-forum/internal/problem/getProblemReplyCount", {
      query: { id },
    });
  },
};

/** 题单 */
export const training = {
  list(client: HtojClient, query: { currentPage?: number; limit?: number; keyword?: string }) {
    return client.get<Pagination<TrainingItem>>("/api/code-community/api/get-training-list", {
      query: { currentPage: 1, limit: 50, ...query },
    });
  },

  detail(client: HtojClient, query: { tid: number; gid?: number }) {
    return client.get<TrainingItem>("/api/code-community/api/get-training-detail", { query });
  },

  problems(
    client: HtojClient,
    query: { tid: number; gid?: number; tcid?: number; currentPage?: number; limit?: number },
  ) {
    return client.get<Pagination<TrainingChapterProblem>>(
      "/api/code-community/api/get-training-problem-list",
      { query: { currentPage: 1, limit: 20, ...query } },
    );
  },

  /** 开始练习（参加题单）。未参加时 get-training-problem-list 会直接返回 400 */
  register(client: HtojClient, body: { tid: number }) {
    return client.post("/api/code-community/api/register-training", { body });
  },
};

/** 比赛 */
export const contest = {
  list(
    client: HtojClient,
    query: { currentPage?: number; limit?: number; keyword?: string; status?: number[]; type?: number[] },
  ) {
    // 注意：这里的 页码/每页条数 必须回填调用方传进来的值，
    // 写死成 1 会让「加载更多」每次都拿到同一页
    const q: Record<string, QueryValue> = {
      currentPage: query.currentPage ?? 1,
      limit: query.limit ?? 20,
      keyword: query.keyword,
    };
    if (query.status?.length) {
      q.status = query.status.join(",");
    }
    if (query.type?.length) {
      q.type = query.type.join(",");
    }
    return client.get<Pagination<ContestItem>>("/api/code-community/api/get-contest-list", { query: q });
  },

  info(client: HtojClient, query: { cid: number; gid?: number; currentPage?: number; limit?: number }) {
    return client.get<ContestItem>("/api/code-community/api/get-contest-info", { query });
  },

  problems(client: HtojClient, query: { cid: number; gid?: number; currentPage?: number; limit?: number }) {
    return client.get<Pagination<ContestProblem>>("/api/code-community/api/get-contest-problem", {
      query: { currentPage: 1, limit: 100, ...query },
    });
  },

  /** 报名比赛。返回 registerState：0 校验未通过 1 待收集信息 2 无需报名直接解锁 3 已报名 */
  register(client: HtojClient, body: { cid: number; password?: string; gid?: number }) {
    return client.post<{ registerState: number }>("/api/code-community/api/register-contest", {
      body,
    });
  },

  /** 开始比赛（会开启计时）。报名后未开始的话 get-contest-problem 会返回「请先开始比赛」 */
  start(client: HtojClient, body: { cid: number; gid?: number }) {
    return client.post("/api/code-community/api/start-contest", { body });
  },

  /**
   * 比赛成绩表。榜单没有「只查我」的参数，前端是拿 keyword=userId 搜一遍再按 uid 匹配自己那行。
   */
  scoreboard(
    client: HtojClient,
    query: { cid: number; gid?: number; keyword?: string; currentPage?: number; limit?: number },
  ) {
    return client.get<Pagination<ContestScoreRow>>("/api/code-community/api/get-contest-scoreboard", {
      query: { currentPage: 1, limit: 20, ...query },
    });
  },

  typeList(client: HtojClient) {
    return client.get<IdName[]>("/api/code-community/api/get-contest-type-list");
  },

  statusList(client: HtojClient) {
    return client.get<IdName[]>("/api/code-community/api/get-contest-status-list");
  },
};

/** 用户 */
export const user = {
  /** 需要登录，distinguish=1 时若 token 无效会返回 401 */
  me(client: HtojClient) {
    return client.get<UserInfo>("/api/htoj-biz-gateway/api/get-user-info", {
      query: { distinguish: 1 },
    });
  },
};
