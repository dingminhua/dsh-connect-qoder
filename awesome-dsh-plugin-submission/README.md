# 市场收录目录（Awesome DSH Plugin Submission）

本目录存放本项目提交到 [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 注册表的**草稿**。正式提交以 PR 形式存在于该仓库，本目录是本地镜像与操作说明。

## 当前状态

- **正式提交**：已发出 → [PR #7229](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7229) `Add dingminhua/dsh-connect-qoder (model)`，2026-10-12 16:54 UTC 开，改动只有 `data/plugins/dingminhua__dsh-connect-qoder.yml` 一个文件（+6 行）。
- **等待评审中**（截至 2026-10-15）：CI `check` + `Submission gate` 持续 pass，`mergeable=MERGEABLE` / `mergeable_state=clean`，0 评论、0 review——全绿排队，不是被打回。上游按批合并（近三批在 10-13 05h / 10-13 16h / 10-14 17h 各消化十几到三十几条），队列里仍有 900+ 条开放投稿；近 500 条已合并样本的「创建 → 合并」中位数约 177 小时（7 天半）。**不要重开 PR，也不要留言催评**；若检查失败，在同一分支推修复即可，无需新 PR。
- **条目 yml 与本地草稿逐字节一致**，无需改动：描述里不含数字，插件继续发版不影响条目准确性。PR body 只是自述，已随版本刷新（npm 0.5.0、33 个 spec 文件 / 588 用例；其中 `live-intl-session.spec.ts` 是需要真实凭据的实机套件，无环境变量时整文件自跳）。
- **npm 包名**：`@dmh2002/dsh-connect-qoder`。**注意**：无作用域的 `dsh-connect-qoder` 已被他人占用（发布者 `gghskl`，仓库 `hdhgsysh/dsh-connect-qoder`，实为 `eghrhegpe` 那份「读本机登录」的实现，已在注册表内）。本项目是**另一条技术路线**（用户自备 PAT + cosy 网关），因此发布在作用域名下；仓库名与插件在 DSH 内的标识（settings 命名空间、`/plugins/dsh-connect-qoder/…` 路由、CLI 程序名）**不变**。
- **前置要求**（依据 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)）：
  - [x] 仓库 `package.json` 声明 `dsh.bundle` manifest（`dsh.bundle.patch: ./cordis.patch.yml`）
  - [x] 已发布到 npm（首发 `0.3.0`，当前 `0.5.0`；映射由 registry 从包的 `repository` 字段自动采集，**条目里不要手写 `npm:` 键，会被校验拒绝**）
  - [x] 仓库打了 `dsh-plugin` topic（另按本作者同族仓库约定补了 `dsh-plugin-market` / `dsh-plugins`，以及 `deepseek-harness` / `qoder` / `model`）
  - [x] 仓库创建满 1 天（2026-10-11 创建。现行规则**没有**提交数门槛——历史长短反映开发习惯而非质量，见 contributing 的说明）
- **截图**：声明在**本项目自己仓库**根目录的 [`screenshots.json`](../screenshots.json)（四张实机图：设置卡片 / 模型管理 / composer 积分 / 模型选择器）

## 与已有同名条目的区别（已写进 PR #7229 的 body）

注册表里已有 `eghrhegpe/dsh-connect-qoder`（npm `@eghrhegpe/dsh-connect-qoder`），它读**本机 Qoder 桌面端登录态**、零配置。本项目：

- 凭据走**官方 PAT**（`pt-…` → jobToken → cosy 签名会话），**不读不写**桌面端本地登录文件；
- 多账号池（PAT vault）+ 一键签到 + 一键测试 + 自动换号；
- 逐模型的上游思考档位与上下文档位选择，能力只按上游明确公布的给（未核实一律不预勾）。

评审对重复条目的规则是「谁更好」而非先来后到；两条描述不同、实现路线不同——提 PR 时把这段差异写清楚即可。

## 收录目录规范

- 每个插件一个 YAML：`data/plugins/<owner>__<repo>.yml`
- 字段：
  - `url`：与仓库地址**完全一致**
  - `name`：`owner/repo`
  - `category`：有效值之一（本项目为 `model`）
  - `description.en`：必填，一行，以句号结尾；含 `: ` 必须加引号
  - `description.zh`：可选，维护者会补
- **描述必须属实**：它会被当作对插件的声明，与代码逐条核对（写「46 个工具」就得真有 46 个）。只说功能，不带最高级形容词与营销词——夸大是让好插件被打回的头号原因。
- 硬性要求：`dsh.bundle` manifest（**只声明 `dsh.client` 会被直接打回**）、仓库有真实可用的代码、创建满 1 天、活跃维护、带 `dsh-plugin` topic。
- 红线：纯聚合包不收（收插件不收 bundle）；依赖必须解析到原作者仓库或其 npm 包；PR 不得动别人的条目。
- README（`README.md` / `README.zh.md`）由脚本生成，**不要手工编辑**；改 YAML 后执行：
  ```sh
  npm ci
  node scripts/generate-readme.mjs
  ```
- 一个 PR 最多收录 3 条；只改自己的条目。

## 更新步骤（改条目内容时）

1. 修改本目录的 `dingminhua__dsh-connect-qoder.yml` 草稿
2. 在 fork 分支上同步修改 `data/plugins/dingminhua__dsh-connect-qoder.yml`
3. 重新生成 README（见上）
4. 推送，PR 自动重跑 CI
