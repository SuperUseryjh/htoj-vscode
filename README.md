# 核桃 OJ for VS Code（开发仓库）

[核桃OJ](https://htoj.com.cn) 的第三方非官方 VS Code 扩展。

**用户向的说明（功能、安装、登录、命令、设置、常见问题）在 [README.plugin.md](README.plugin.md)** ——那份也是发布到插件市场的页面内容。本文件只讲这个仓库怎么构建、测试和发布。

> 第三方非官方扩展，与核桃编程官方无关。

## 仓库里各文件的分工

| 文件 | 作用 |
| --- | --- |
| `README.md` | 本文件：构建 / 测试 / 发布 |
| `README.plugin.md` | 插件市场页面。**打包时必须用 `--readme-path README.plugin.md` 指定它**，否则会把这份开发 README 传到市场上 |
| `RELEASE_NOTE.md` | GitHub Release 的正文（workflow 直接读它） |

## 环境要求

- [bun](https://bun.sh)：包管理、构建、测试运行器
- Node 22+：只有跑 `vsce` 打包时才需要（vsce 4.x 的硬要求）

## 开发

```bash
bun install
bun run compile     # 构建到 dist/
bun run watch       # 监听构建
bun run check       # 类型检查（tsc --noEmit）
bun run test        # 跑测试
bun run package     # 生产构建（esbuild --production）
```

在 VS Code 里按 `F5` 启动扩展开发宿主（配置见 `.vscode/launch.json`）。

### 目录结构

```
src/
  extension.ts      命令注册、提交 / 自测流程、状态栏与倒计时
  session.ts        登录态、zone、token 续期
  contestCountdown.ts  比赛倒计时（状态栏常驻项）
  codeFile.ts       代码文件的生成与 @htoj 标记解析
  api/              请求层（client）、端点封装（endpoints）、类型（types）
  views/            三个树视图 + 题面面板（problemPanel）+ 扫码登录面板（loginPanel）
  util/             日志、XOR（登录参数混淆）
test/               bun 测试；vscode 模块由 test/vscode-stub.ts 顶掉
docs/               逆向整理的接口文档
esbuild.js          构建脚本
```

## 测试

测试用 bun 原生测试运行器，`bunfig.toml` 里通过 preload 把 `vscode` 模块替换成 `test/vscode-stub.ts`，因此可以直接在 Node 环境里跑树视图逻辑。

```bash
bun test
```

部分用例会请求线上接口。设置 `HTOJ_TOKEN` 后还会跑登录态用例，未设置时自动跳过：

```bash
HTOJ_TOKEN=<你的 JWT> bun test
```

另外 `test/webview-template.test.ts` 是个静态检查：webview 的 JS 写在 TS 模板字符串里，模板会把 `\s`、`\d` 这类「未知转义」的反斜杠吃掉（`/\s/` 到运行时变成 `/s/`），正则一旦中招就静默失效。这个用例扫一遍模板里的字面文本，只放行合法转义。

## 打包 VSIX

```bash
bun run vsix        # 生产构建 + vsce package（已带上 --readme-path）
```

等价的完整命令：

```bash
bun run package
bun x @vscode/vsce@4 package --no-dependencies --readme-path README.plugin.md
```

- `--readme-path README.plugin.md`：市场页面用插件那份 README，见上表
- `--no-dependencies`：依赖已被 esbuild 打进 `dist/extension.js`

> vsce 只识别 npm / yarn，执行 `vscode:prepublish` 时会调用 `npm run`。机器上只有 bun 的话，需要在 PATH 里放一个转发脚本 `npm.cmd`，内容为两行：`@echo off` 和 `bun %*`。（CI 里有正经 npm，不需要这个 shim。）

## 发布

版本号的唯一来源是 `package.json`，发布说明的唯一来源是 `RELEASE_NOTE.md`（GitHub Release 的正文直接取这个文件）。**整个流程不依赖 tag。**

`.github/workflows/release.yml` 在任何 push（以及手动触发）时都会无条件跑完整流程：读版本号 → 类型检查 → 跑测试 → 打包 → 上传产物 → 创建/更新 GitHub Release（tag 由版本号生成 `vX.Y.Z`，标题取版本号，正文取 `RELEASE_NOTE.md`，并把 `.vsix` 挂上去）。

```bash
bun re/bump-version.ts 1.0.1     # 改 package.json 的版本号
# 然后更新 RELEASE_NOTE.md，写清这个版本改了什么
git commit -am "chore: 1.0.1"    # git hook 要求这两者至少改一个
git push                         # 不需要打 tag
```

> 版本号没升就 push 的话，Release 那步只是「更新同名 Release」，无害。

### Git hooks

`.githooks/pre-commit` 会拒绝「`package.json` 与 `RELEASE_NOTE.md` 都没改动」的提交——逼着每次提交至少带上版本号变更或发布说明：

```bash
bun run hooks:install            # 等价于 git config core.hooksPath .githooks
```

单次跳过检查：`git commit --no-verify`。

### 发布到插件市场（手动）

CI **不自动发布**到 VS Code 插件市场，改成手动上传一个文件：

1. 等 push 触发的 workflow 跑完，在 GitHub 的 Release 里下载 `htoj-vscode-<版本>.vsix`（或从该次运行的 Artifacts 里下）
2. 打开 <https://marketplace.visualstudio.com/manage/publishers/YaoOnion>，在「核桃 OJ」那一行点 **More Actions...**（⋯）→ **Update**，选中这个 `.vsix`
3. 等市场索引几分钟，用户即可收到更新

之所以不能自动化（两条自动化路径都走不通）：

- **`vsce publish --oidc`（GitHub OIDC 可信发布）**：市场侧的 token 交换接口直接返回 `Trusted Publishing is not supported`。vsce 4.0.0 还有 `api-version` 缺失的 bug（见 [#1337](https://github.com/microsoft/vscode-vsce/pull/1337)），但换成修好的 4.0.1-3 后仍然被市场拒绝——这条路目前对普通发布者没有开放配置入口。
- **`vsce publish` + PAT**：PAT 必须来自 Azure DevOps 组织，而现在**创建 Azure DevOps 组织要求先绑定 Azure 订阅**（账号下没有订阅时会提示 *To create an Azure DevOps organization, you need to link it to an Azure subscription*）。
- 同理，官方推荐的 Entra ID 工作负载身份（`vsce publish --azure-credential`）也需要 Azure 订阅。

如果以后有了 Azure 订阅，可以按[官方文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)配 Entra ID 联邦凭据，再把发布步骤加回 workflow；另一种免 Azure 的自动化是发到 [Open VSX](https://open-vsx.org)（`ovsx publish` + `OVSX_PAT`）。

## 许可

GNU General Public License v3.0（许可证全文见本仓库的 `LICENSE`）。
