# 核桃 OJ for VS Code

在 VS Code 里刷[核桃OJ](https://htoj.com.cn)：浏览题目 / 题单 / 比赛，用本地文件写代码，一键提交并直接看到评测结果与测试点明细。

> 这是一个第三方非官方扩展，与核桃编程官方无关。

## 功能

- **题目**：列表浏览、关键词搜索、难度与通过率展示，点击打开题面
- **题单**：题单列表，展开后按章节显示题目与参与进度；未参加的题单可直接在树里「开始练习」
- **比赛**：比赛列表（赛制 / 状态 / 剩余时间），展开查看比赛题目；未报名的比赛可直接报名，密码场次会提示输入；已报名但未开始的比赛可在树里「开始比赛」（会提示确认并开启计时）
- **比赛成绩**：展开比赛（或查过一次榜单）后，比赛行与详情块会显示我的当前得分和排名；**OI 赛制不显示**
- **比赛倒计时**：状态栏常驻显示比赛剩余时间，最后 5 分钟转为警示配色，点击在浏览器打开该场比赛
  - 可选「跟随自动」（自动盯我参与的、最快结束的一场）、关闭，或在比赛节点右键「设为倒计时目标」指定某一场
  - **灵活时间制**的比赛按后端的 `remainTime` 走个人计时（不是拿比赛窗口结束时间硬算）；还没点「开始比赛」时显示的是比赛窗口剩余，并会在状态栏里标明
- **客观题 / 选择题**：非编程题也能在面板里作答提交——客观题按题面里的 `{{ select(1) }}`、`{{ input(2) }}` 占位符渲染成选项与填空，选择题直接列出选项；提交后逐题显示对错、正确答案与得分
- **题目详情面板**：Markdown 渲染题面、时空限制、标签，直接内置提交与刷新按钮；文件 IO 题会在顶部标出要求的输入/输出文件名
- **一键提交**：读取当前文件内容提交，轮询评测结果，测试点表格原地回填（在题面面板里点提交时焦点不在代码上，会自动去分屏里找这道题的代码文件；分屏也找不到就让你选文件）
- **本地代码管理**：按题目自动生成代码文件，文件头写入 `pid` 标记，提交时自动识别题目
- **提交记录**：题面面板底部按时间倒序列出本题历史提交，最新一条默认展开；折叠时只显示状态（AC / WA / TLE / MLE…）、得分和时间，展开才拉该次的测试点明细

## 安装

### 从 VSIX 安装

下载仓库根目录的 `htoj-vscode-*.vsix`，然后：

1. VS Code 中按 `Ctrl+Shift+P`
2. 执行 **Extensions: Install from VSIX...**
3. 选择该文件
4. 安装后执行 **Developer: Reload Window**

### 从源码运行

```bash
bun install
bun run compile        # 构建到 dist/
```

然后在 VS Code 里按 `F5` 启动扩展开发宿主（需要 `.vscode/launch.json`）。

## 登录

扩展提供三种登录方式（状态栏左下角用户名 → 「打开菜单」，或命令面板搜索 `核桃OJ`）：

| 方式 | 说明 |
| --- | --- |
| **微信扫码** | 推荐。弹出二维码，用微信扫码并在手机上确认即可 |
| **手机号 + 密码** | 需要账号已设置密码 |
| **粘贴 Token** | 兜底方案，见下方步骤 |

### 关于短信验证码登录

**插件内无法实现短信验证码登录。** 核桃OJ 的发送验证码接口强制校验腾讯验证码票据：

```
空 ticket        → {"errCode":1011,"errMsg":"参数异常"}
伪造 ticket      → {"errCode":2024,"errMsg":"票据校验异常"}
```

票据只能由腾讯 TCaptcha 组件在已备案域名的浏览器页面中生成，扩展的 Webview 域名无法通过校验。请改用微信扫码登录。

### 手动获取 Token

1. 浏览器登录 <https://htoj.com.cn>
2. 打开 DevTools → Application → Local Storage → `https://htoj.com.cn`
3. 复制 `KEY_USER_LOGIN_TOKEN` 的值
4. 在 VS Code 执行 `核桃OJ: 登录（粘贴 Token）`，粘贴进去

Token 使用 VS Code 的 SecretStorage 保存，不会写入工作区文件。

## 使用

1. 点击活动栏的核桃图标（若未登录，侧栏会显示登录引导）
2. 在「题目」视图点开一道题，详情面板在编辑器区域打开
3. 点「新建/打开代码文件」，插件会在工作区 `htoj/` 下生成 `P1000.cpp`（或 `.py`）
4. 写代码，然后 `Ctrl+Alt+Enter` 提交（或点面板上的「提交当前文件」）
5. 评测完成后结果会显示在面板底部，包含每个测试点的状态 / 分数 / 用时 / 内存

生成的代码文件头部带标记，提交时会自动识别题目：

```cpp
// @htoj pid=22169438826624 problemId=P1000
// 题目：P1000
// 链接：https://htoj.com.cn/cpp/oj/problem/detail?pid=22169438826624
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `核桃OJ: 登录（微信扫码）` | 扫码登录 |
| `核桃OJ: 登录（手机号 + 密码）` | 密码登录 |
| `核桃OJ: 登录（粘贴 Token）` | 粘贴 token 登录 |
| `核桃OJ: 退出登录` | 清除本地 token |
| `核桃OJ: 切换题库语言（C++ / Python）` | 切换 `cpp` / `python` 分区 |
| `核桃OJ: 搜索题目` | 按编号或名称过滤题目列表 |
| `核桃OJ: 提交当前文件` | 提交当前编辑器内容 |
| `核桃OJ: 查看本题提交记录` | 打开题面面板并滚到提交记录列表 |
| `核桃OJ: 新建/打开本地代码文件` | 为当前题目创建代码文件 |
| `核桃OJ: 查看日志` | 打开输出面板中的调试日志 |
| `核桃OJ: 选择倒计时比赛` | 指定状态栏倒计时盯哪一场比赛（或改为自动 / 关闭） |
| `核桃OJ: 打开菜单` | 状态栏入口 |

快捷键：编辑器获得焦点且当前文件带 `@htoj` 标记时，`Ctrl+Alt+Enter`（macOS `Cmd+Alt+Enter`）提交。

## 设置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `htoj.zone` | `cpp` | 题库语言分区，对应站点 `/cpp/` 与 `/py/` |
| `htoj.apiBase` | `https://api.htoj.com.cn` | 接口网关地址 |
| `htoj.pageSize` | `20` | 每页加载条数。注意服务端对每页条数有上限，超出会被截断 |
| `htoj.defaultLanguage` | `C++17 With O2` | 提交使用的语言名称 |
| `htoj.codeDirectory` | `htoj` | 代码文件存放目录（相对工作区根目录） |
| `htoj.pollIntervalMs` | `2000` | 评测结果轮询间隔 |
| `htoj.pollTimeoutMs` | `60000` | 评测结果轮询超时 |

## 排查问题

扩展的调试日志会写入 **输出 → 核桃OJ**（`核桃OJ: 查看日志`）。日志包含环境信息、每次 HTTP 请求的完整 URL / 状态码 / `errCode` / 耗时，以及各视图的加载决策，遇到问题先看这里。

## 已知限制

- 仅支持 OJ 编程题，选择题 / 客观题的提交结构不同，暂未实现
- 比赛报名若需要填写额外报名信息（`registerState = 1`），仍需到网页端完成
- 测试点明细接口 `get-submission-case-list` 被网关屏蔽（返回 403），结果表格数据取自 `get-submission-detail`
- 评测结果只能轮询，服务端不提供推送

## 开发

```bash
bun install
bun run compile     # 构建
bun run watch       # 监听构建
bun run check       # 类型检查
bun run test        # 跑测试
bun run package     # 生产构建
```

### 测试

测试用 bun 原生测试运行器，`bunfig.toml` 里通过 preload 把 `vscode` 模块替换成 `test/vscode-stub.ts`，因此可以直接在 Node 环境里跑树视图逻辑。

```bash
bun test
```

部分用例会请求线上接口。设置 `HTOJ_TOKEN` 后还会跑登录态用例，未设置时自动跳过：

```bash
HTOJ_TOKEN=<你的 JWT> bun test
```

### 打包 VSIX

```bash
bun run package                                  # esbuild 打包到 dist/
bun x @vscode/vsce package --no-dependencies     # 产出 htoj-vscode-<version>.vsix
```

`--no-dependencies` 是因为依赖已被 esbuild 打进 `dist/extension.js`。

> vsce 只识别 npm / yarn，执行 `vscode:prepublish` 时会调用 `npm run`。机器上只有 bun 的话，需要在 PATH 里放一个转发脚本 `npm.cmd`，内容为两行：`@echo off` 和 `bun %*`。（CI 里有正经 npm，不需要这个 shim。）

### 发布

推送 `vX.Y.Z` 形式的 tag 会触发 `.github/workflows/release.yml`：类型检查 → 跑测试 → 打包 → 创建 GitHub Release 并把 `.vsix` 挂上去。

```bash
# 版本号和 tag 必须一致，workflow 会校验
bun re/bump-version.ts 1.0.1
git commit -am "chore: 1.0.1"
git tag v1.0.1
git push origin main --tags
```

想同时发到 VS Code 插件市场，走的是 **OIDC 可信发布**（`vsce publish --oidc`）：不用存任何长期 token，workflow 用 GitHub 自己的 OIDC 身份去换一个短期凭证。前提是在市场后台给这个仓库配一条 trusted publishing 策略：

- Repository：本仓库（`<owner>/htoj-vscode`）
- Workflow file：`release.yml`
- Publisher：`YaoOnion`（与 `package.json` 的 `publisher` 一致）

配好之前推 tag，最后那步发布可能会失败——构建、Release 与 `.vsix` 不受影响。

## 许可

GNU General Public License v3.0 or later（许可证全文见扩展仓库中的 `LICENSE`）。
