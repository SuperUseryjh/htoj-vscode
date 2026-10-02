/**
 * 核桃OJ 接口返回的数据结构。
 * 字段名与真实响应保持一致（详见 docs/API.md）。
 */

/** 网关统一响应体 */
export interface ApiEnvelope<T> {
  errCode?: number;
  data: T;
  errMsg?: string;
  /** 部分老接口用小写 */
  errcode?: number;
  errmsg?: string;
}

/** 网关自身的错误响应（非业务服务返回） */
export interface GatewayError {
  code: number;
  message: string;
}

/** 分页结构 */
export interface Pagination<T> {
  records: T[];
  total: number;
  size: number;
  current: number;
  pages: number;
  orders: unknown[];
  searchCount: boolean;
}

export interface IdName {
  id: number;
  name: string;
}

/**
 * 打开题目 / 提交时携带的上下文。
 * 比赛题目必须带 cid，否则 get-problem-detail 会直接返回「该题目不可见」。
 */
export interface ProblemContext {
  /** 比赛 id */
  cid?: number;
  /** 小组 id */
  gid?: number;
  /** 题单 id */
  tid?: number;
}

export interface Difficulty extends IdName {
  color: string;
}

export interface Tag extends IdName {}

/** 题目作答状态：0 通过 / 4 答案错误 / -10 评测中 …… */
export interface JudgeStatus extends IdName {
  shortName: string | null;
  chineseName: string | null;
}

export interface AcStatus extends IdName {
  shortName: string | null;
  chineseName: string | null;
}

export interface OwnerVo {
  uid: string;
  nickname: string;
  avatar: string;
  ccfLevel?: string | null;
  authenticationIcon?: string | null;
  userId?: number | null;
}

// ---------------------------------------------------------------------------
// 题目
// ---------------------------------------------------------------------------

/** 题目列表项 */
export interface ProblemListItem {
  /** 内部数字 id，详情/提交都用它 */
  pid: number;
  /** 展示编号，如 P1000 / LGP11576 */
  problemId: string;
  title: string;
  difficulty: Difficulty | null;
  owner: OwnerVo | null;
  /** 1=OJ 编程题 2=选择题 5=客观题 */
  type: number;
  tags: Tag[];
  acStatus: AcStatus;
  total: number;
  ac: number;
  rn: number | null;
}

export interface ProblemBaseVO {
  id: number;
  problemId: string;
  title: string;
  content: string;
  difficulty: Difficulty | null;
  source: IdName | null;
  type: number;
  tags: Tag[];
  showProblemSolution: boolean;
  showJudgeRecord: boolean;
  zone: string;
  total: number;
  ac: number;
  wid: number | null;
  historyResult: JudgeStatus | null;
}

/** 选择题的一个选项 */
export interface ChoiceOption {
  /** 提交时用它，多选按逗号拼接 */
  id: string;
  label: string;
  picUrl?: string | null;
}

/** 选择题（type=2）专有数据 */
export interface ProblemChoiceDetailVO {
  /** 2=单选 4=多选，对应前端的 CHOICE_TYPES */
  choiceType: number;
  options: ChoiceOption[];
}

/**
 * 客观题（type=5）逐题批改结果。
 * 题目本身写在 `content` 的 markdown 里，用 `{{ select(1) }}` / `{{ input(2) }}` 这类占位符出题；
 * 正确答案由后端保存，只有允许看答案时才会下发 `answer`。
 */
export interface SubmissionAnswer {
  /** 小题号，如 "1"，也可能是区间 "1-3" */
  id: string;
  myAnswer: string | null;
  answer: string | null;
  /** -1=未作答 1=正确 2=错误 3=已作答 */
  status: number;
  score: number | null;
  myScore: number | null;
}

export interface ProblemOjDetailVO {
  problemLanguage: IdName[];
  /** ioMode.id：1 = 标准IO，2 = 文件IO */
  ioMode: { id: number; name: string };
  sampleCaseList: unknown;
  /** 毫秒 */
  timeLimit: number;
  /** MB */
  memoryLimit: number;
  stackLimit: number;
  judgeMode: { value: string; name: string };
  /** 文件 IO 题要求读入的文件名（仅 ioMode.id === 2 时有意义） */
  ioReadFileName: string;
  /** 文件 IO 题要求输出的文件名（仅 ioMode.id === 2 时有意义） */
  ioWriteFileName: string;
}

export interface GuideConfigVo {
  guideProblemId: number;
  guideModelAnswer: string;
  guideBudge: string | null;
  guideTrainingId: number;
  guideBudgeId: number | null;
  guideTrainingBudgeId: number | null;
}

export interface ProblemDetail {
  problemBaseVO: ProblemBaseVO;
  problemChoiceDetailVO: ProblemChoiceDetailVO | null;
  problemOjDetailVO: ProblemOjDetailVO | null;
  problemObjectiveDetailVO: unknown | null;
  ownerVo: OwnerVo | null;
  isGuide: boolean | null;
  isGuideTraining: boolean | null;
  /** 标程（部分题目返回） */
  modelAnswer: string | null;
  budge: string | null;
  budgeName: string | null;
  likeCount: number;
  dislikeCount: number;
  gid: number | null;
  noPrev: boolean;
  noNext: boolean;
  /** 当前用户是否已通过 */
  accepted: boolean;
  hideResult: boolean | null;
  additionalFiles: unknown | null;
  like: boolean;
  dislike: boolean;
}

// ---------------------------------------------------------------------------
// 提交 / 评测
// ---------------------------------------------------------------------------

/** 提交记录 */
export interface SubmissionRecord {
  uid: string;
  submitId: number;
  username: string;
  pid: number;
  displayPid: string;
  title: string;
  submitTime: number;
  status: JudgeStatus;
  time: number | null;
  memory: number | null;
  language: string;
  score: number | null;
  cid: number;
  tid: number;
  gid: number;
  /** 1=核桃OJ 2=核桃编程APP */
  source: number;
}

/** 单个测试点结果 */
export interface CaseResult {
  seq: number;
  status: JudgeStatus;
  time: number | null;
  memory: number | null;
  score: number | null;
}

export interface CaseGroup {
  groupScore: number;
  caseResult: CaseResult[];
}

/** 提交详情（评测结果） */
export interface SubmissionDetail {
  submitId: number;
  /** 0=评测中，非 0 表示已结束 */
  resultCode: number;
  status?: JudgeStatus | null;
  score: number | null;
  time: number | null;
  memory: number | null;
  language: string;
  type: number;
  firstAc: boolean;
  userCode: string | null;
  caseGroups: CaseGroup[] | null;
  additionalCaseResults: CaseResult[] | null;
  /** 客观题（type=5）的逐题作答结果 */
  answers: SubmissionAnswer[] | null;
  showAiButton: boolean | null;
  canCreateProblemSolution: boolean | null;
  tid: number | null;
  unfinishedProblemNum: number | null;
  hideResult: boolean | null;
}

/** 自测运行结果 */
export interface TestJudgeResult {
  status: JudgeStatus;
  resultCode: number;
  time: number | null;
  memory: number | null;
  userInput: string | null;
  userOutput: string | null;
  userOutputFile: string | null;
  expectedOutput: string | null;
  stderr: string | null;
}

/** 提交请求体 */
export interface SubmitProblemBody {
  /** 内部 pid */
  id: number;
  /** 1=标准IO 2=文件IO */
  ioMode: number;
  language: string;
  code: string;
  costTime?: number;
  cid?: number;
  tid?: number;
  gid?: number;
}

// ---------------------------------------------------------------------------
// 题单
// ---------------------------------------------------------------------------

export interface TrainingItem {
  id: number;
  trainingNo: string | null;
  title: string;
  subtitle: string | null;
  description: string | null;
  author: string | null;
  ownerVo: OwnerVo | null;
  auth: number;
  problemCount: number;
  acCount: number | null;
  completeCount: number | null;
  totalCount: number | null;
  gmtModified: number | null;
  nextPid: number | null;
  zone: string;
  languages: string[] | null;
  status: number | null;
  isAttend: boolean | null;
  imMark: number | null;
  productLineIds: unknown | null;
}

/** 题单题目列表里的一「章」 */
export interface TrainingChapterProblem {
  trainingChapterVO: {
    id: number;
    title: string;
    sort?: number;
  } | null;
  problemVOList: ProblemListItem[] | null;
  nextPid: number | null;
  isAttend: boolean | null;
}

// ---------------------------------------------------------------------------
// 比赛
// ---------------------------------------------------------------------------

export interface ContestItem {
  id: number;
  author: string | null;
  title: string;
  type: number;
  /** 注意：是对象 { id, name }，不是字符串 */
  typeDesc: IdName;
  ioType: number | null;
  ioTypeName?: string | null;
  description: string | null;
  /** -1=未开始 0=进行中 1=已结束 */
  status: number;
  /** 注意：是对象 { id, name }，不是字符串 */
  statusDesc: IdName;
  matchType?: number | null;
  matchTypeDesc?: IdName | null;
  now: number;
  startTime: number;
  endTime: number;
  duration: number;
  sealRank: number;
  openPrint: boolean;
  openRank: boolean;
  count: number;
  submitCount: number | null;
  problemCount: number;
  registered: boolean | null;
  started: boolean | null;
  remainTime: number | null;
  contestRemainTime: number | null;
  avatarList: unknown[] | null;
  needPassword: boolean | null;
  gid: number | null;
  owner: string | null;
  zone: string | null;
}

/** 比赛题目里当前用户对该题的状态，注意多带一个 score */
export interface ContestProblemStatus {
  id: number;
  name: string;
  score: number | null;
}

/** 比赛题目 */
export interface ContestProblem {
  id: number;
  /** 实测是数字（题目序号），展示题号请用 indexTitle */
  displayId: number;
  cid: number;
  pid: number;
  displayTitle: string;
  /** 题号，如 A / B */
  indexTitle: string;
  type: number;
  color: string | null;
  ac: number | null;
  total: number | null;
  status: ContestProblemStatus | null;
  difficulty: Difficulty | null;
  /** 实测样本为 null，具体类型未确认，故不参与展示 */
  difficultyDesc: unknown;
  tags: Tag[] | null;
  problemId: string;
  rn: number | null;
}

/**
 * 比赛成绩表里的一行（只取当前用户需要的字段）。
 * 查自己那行要按 keyword=userId 搜，再按 uid 匹配（见前端 ScoreService.fetchMyRow）。
 */
export interface ContestScoreRow {
  id: number;
  uid: string;
  nickname: string;
  rank: number;
  totalScore: number;
  totalTime: number | null;
  problemScoreList: unknown;
}

// ---------------------------------------------------------------------------
// 用户 / 登录
// ---------------------------------------------------------------------------

export interface UserInfo {
  uid: string;
  userId: number;
  countryCode: string;
  countryShort: string;
  phoneNumber: string;
  setPassword: boolean;
  username: string;
  signature: string | null;
  nickname: string;
  avatar: string;
  isAdmin: boolean;
  token: string;
  hasAccount: boolean | null;
  myZone: string | null;
  language: string | null;
  province: string | null;
  city: string | null;
}

export interface CountryCode {
  country: string;
  name: string;
  short: string;
  code: string;
  regular: string;
}

/** 扫码登录：查询扫码结果 */
export interface QrLoginCheck {
  qrCodeStatus: number;
  token?: string;
  userInfo?: UserInfo | null;
}

/** 登录接口（如密码登录）返回的 token */
export interface LoginToken {
  token: string;
  [key: string]: unknown;
}
