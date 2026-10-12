<p align="center">
  <img src="icons/dsh-connect-qoder-128.png" width="128" alt="dsh-connect-qoder" />
</p>

<h1 align="center">dsh-connect-qoder</h1>

<p align="center"><b>把 Qoder（通义灵码国际 / 国内）的模型接入 DeepSeek Harness，并提供只读的用量概览与模型管理。</b></p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="#安装">安装</a> ·
  <a href="#工作原理">工作原理</a> ·
  <a href="#配置">配置</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="https://github.com/dingminhua/dsh-connect-qoder/issues">问题反馈</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-connect-qoder"><img src="https://img.shields.io/npm/v/dsh-connect-qoder?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-connect-qoder"><img src="https://img.shields.io/npm/d18m/dsh-connect-qoder?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/dingminhua/dsh-connect-qoder/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dingminhua/dsh-connect-qoder/ci.yml?branch=main&style=flat-square&label=tests" alt="test status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/dingminhua/dsh-connect-qoder?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/dingminhua/dsh-connect-qoder/stargazers"><img src="https://img.shields.io/github/stars/dingminhua/dsh-connect-qoder?style=flat-square" alt="GitHub stars"></a>
</p>

一个独立的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) bundle 插件。它把 Qoder 账号的模型接到 DSH 的模型选择器，同时提供模型管理与只读的用量概览。**国内版与国际版是两个并行的供应商（`qoder` / `qoder-global`），可同时使用**；插件设置卡片以 tab 区分两者，方便统一管理。

> Qoder 官方不提供 OpenAI 兼容端点（其官方 SDK 只是 agent 启动器），因此本插件直连 Qoder 的 cosy 网关，实现了协议的最小客户端，无需在 Qoder 桌面端登录——只需一个 PAT（Personal Access Token）。

## 功能特性

- **双供应商并行接入（国内版 + 国际版）** —— 国内版注册为 `qoder` provider（`gateway.qoder.com.cn`），国际版注册为 `qoder-global` provider（`api1.qoder.sh`）。**配置了 PAT 的区域其模型会出现在 DSH 模型选择器里**：两个区域都有 PAT 时两组同时可选，不同会话可以各选一边，互不干扰。**没有 PAT 的区域不列出任何模型**（一个请求也发不出去，列出来只会点到就失败）；配置 PAT 后「刷新模型」即可让模型自动出现——provider 本身始终注册着，因为它的设置卡片正是配置入口。模型名内嵌上游积分倍率（如 `qwen3.8 · x1.31`），与 Qoder 自身模型菜单一致。
- **插件卡片 tab 切换** —— 设置卡片顶部为「国内版 / 国际版」两个 tab，各含独立的 PAT、模型管理与用量概览；每个 tab 的目录、勾选与状态完全隔离。
- **可单独关闭任一版本供应商** —— 每个 tab 右侧有一个勾选框（默认都勾选）。**取消勾选即把该供应商从 DSH 模型选择器里彻底撤掉**（不是只藏起 tab）：它的路由与「设置 → 模型」页的目录条目一并摘除。PAT、用量与勾选**全部保留**，重新勾选即完整恢复。注意：若某会话此前选中的正是被关闭供应商的模型，该会话再调用会报 `NO_ADAPTER`。
- **模型管理** —— 从上游刷新完整模型目录，逐项勾选启用或禁用；模型行显示倍率（`· xN.NN`）、上下文/输出上限、是否支持推理与图像、默认/免费标记。勾选状态写入本地配置，立即同步到模型选择器。
- **模型可用性测试** —— 每个模型行有一个「测一测」按钮，直达上游确认该模型此刻能否使用：限流（429）报「被限流」、凭据无效报「凭据无效」、内容审核拒绝报「内容被审核拒绝」、额度耗尽报「额度已耗尽」，其余上游瞬时故障如实分类。探测在后台发起，**凭据不会传到页面**；结果不写入设置，也不改变你已保存的勾选。**它发的是真实请求**（会消耗少量上游额度），因此只能按单个模型手工点，没有「测试已勾选」这类批量按钮。
- **用量概览（只读）** —— 每个区域展示基础额度 / 附加额度 / 组织额度的已用、总量、剩余、占比与到期时间（来自 Qoder 的 `sash/api/v2/me/usage`）。查询是**只读**的、不消耗积分。
- **安全 loopback shim** —— 每区域一个随机端口 + 进程内随机 secret，真实 Qoder PAT **不交给 pi-ai**：pi-ai 只与本地 shim 对话，shim 用 cosy 会话做上游请求，PAT 永不出进程。
- **多账号池（PAT）** —— 每区域一个本地 vault `$DSH_HOME/.qoder-accounts.<region>.json`（0600），把设置 PAT、环境变量与 vault 账号三源去重合并；卡片可新增（粘贴 `pt-…`，经 `JobToken` 交换校验并取显示名）/ 移除 / 改名账号，也可显式选择某一账号服务（`regions.<region>.accountId`，留空自动按 settings → env → vault 选取）。
- **按实测排序与故障转移** —— 「测一测」批量对账号池每个成员发真实请求，结果落 `$DSH_HOME/.qoder-pool.<region>.json`；聊天流在首字节前按 `rankPool`（可用性 → 额度从高到低 → 到期最近 → id）自动换账号，失败回写 `live-request` 探测。Qoder **没有每日签到**，故账号池不出现签到列。
- **账号转移（导入 / 导出）** —— 按区域把 vault 账号导出为传输文件，预览后按索引导入；跨区域域名（`qoder.com.cn` / `qoder.sh`）正向匹配，不匹配的记录计入 `skipped`。
- **上下文预算** —— 从上游 `context_config` 解析模型声明的档位，按档位选择上下文预算，仅在已声明档位内生效（否则回落原生值）。
- **诚实的模型能力** —— 上游的 `is_vl` 是**平台**的图片输入声明而非模型原生能力（内置目录里几乎全是 `true`，连纯文本模型也是）。图片输入按**精确 model id** 的人工核对表只对文档确认多模态的模型预勾选，未核实的一律不勾，并在开关 tooltip 里说明「为什么没勾」；「关闭思考」同样只对上游显式声明、且不在已知拒绝集里的模型提供。宁可少给一个选项，也不要让用户按下去就失败。
- **composer 积分读数** —— 会话输入区（`conversation.input.left`）按区域显示 `QD CN` / `QD AI` 与当前账号余额，受每区域 `showCreditsInMainUi`（默认开，opt-out）控制；每账号明细走 `account-credits` 路由。
- **命令行诊断与现场验证** —— `dsh-connect-qoder doctor|status|logout [--json] [--region cn|global]`：`doctor` 报 PAT 来源、cosy 指纹派生、pi-ai 代际、宿主心跳存活与 vault 账号计数；`status` 报凭据来源、上游可达性与当前剩余积分；`logout` 清除指定区域的 vault 账号与账号池测量副本。另有 `pnpm run probe:cosy`（不依赖宿主直连 cosy 链路验证）与 `pnpm run probe:vault`（只读 dump vault / 账号池测量，PAT 只显示掩码）。

## 工作原理

```text
DSH PiAiAdapter（每个 provider 一套）
  -> 安全 loopback shim（每区域一个随机端口 + 进程内随机 secret）
  -> QoderUpstreamClient（cosy 协议最小客户端）
  -> 国内版 https://gateway.qoder.com.cn/algo/api/v2/...
  -> 国际版 https://api1.qoder.sh/algo/api/v2/...
  -> Qoder SSE（OpenAI 形状增量）
  -> DSH 本地执行工具并回传结果
```

国内版与国际版各持一套完整的运行时栈——上游客户端、模型 catalog、回环 shim、adapter——按区域配置（网关 / openapi / 目录路径）隔离，所以**两个区域的模型可以同时可选、被不同会话使用**。

凭据是 PAT（设置卡片 `regions.<region>.pat` 或环境变量，见[配置](#配置)），设置项优先。每次会话按需惰性交换 **jobToken**：PAT 只在这个交换请求里使用一次，之后的对外请求全部携带 cosy bearer（自定义 Base64 载荷 + MD5 签名）与「机器指纹」会话头。**PAT 从不进入 pi-ai，也从不外发到网关之外；本插件不读不写 Qoder 桌面端的本地登录文件。**

模型的 cosy 编码与签名细节（自定义字母表、`n/3` 重排、`cosy&<SECRET>&<date>` 签名、RSA/AES 会话封装）见 `src/cosy.ts` 的头部注释；错误分类（内容审核 / 限流 / 额度耗尽 / 瞬时故障）与 DSH 重试语义的对应见 `src/upstream.ts`。

## 安装

### 从发布包安装（推荐）

在 DSH 的「插件市场 / Bundles」中搜索 `dsh-connect-qoder` 安装启用；或

```bash
npm install -g dsh-connect-qoder   # 仅供 CLI（doctor/status）使用
```

### 从源码构建（开发）

```bash
git clone https://github.com/dingminhua/dsh-connect-qoder.git
cd dsh-connect-qoder
pnpm install
pnpm run check        # typecheck + test + build 全绿后再安装
```

把本仓库目录作为 bundle 安装进当前 DSH profile（Harness 内「插件管理 → 安装本地 bundle」，target 指向本仓库目录）。

### 验证安装

- 打开「设置 → 插件」应能看到 dsh-connect-qoder 的配置卡片（国内版 / 国际版两个 tab）。
- `dsh-connect-qoder doctor`（若全局安装）应输出两个区域的 PAT 状态与指纹派生。
- 配置 PAT 后，「刷新模型」应拉出该区域的真实模型清单；模型选择器出现 `Qoder` / `Qoder Global` 两个分组。

## 配置

### PAT（Personal Access Token）

在 Qoder 账户设置里创建 PAT（`pt-…` 开头）。两种提供方式，**设置卡片优先于环境变量**：

| 区域 | 发证入口 | 设置项 | 环境变量 |
| --- | --- | --- | --- |
| 国内版（qoder.com.cn） | 控制台 → 设置 → API 令牌 | 卡片「国内版」tab → 添加 PAT | `QODERCN_PERSONAL_ACCESS_TOKEN` |
| 国际版（qoder.sh） | 控制台 → Settings → Personal Access Tokens | 卡片「国际版」tab → 添加 PAT | `QODER_PERSONAL_ACCESS_TOKEN` |

- PAT 只保存到本地插件配置（`regions.<region>.pat`），从不上传、不进入任何网络请求。
- 未配置 PAT 的区域不列出任何模型；`doctor` 命令会指出哪个区域缺 PAT。
- **逐步操作说明见 [`docs/PAT.md`](docs/PAT.md)**（含创建流程、验证机制、优先级与常见问题）。

### 区域启停

卡片每个 tab 右侧的勾选框控制该区域是否参与模型选择（opt-out：**显式取消勾选才停用**）。停用只摘除路由与目录条目，配置全部保留。

### 多账号池与凭据来源

除设置 PAT 与环境变量外，每区域还有一个本地 vault（`$DSH_HOME/.qoder-accounts.<region>.json`，权限 0600）保存多个 PAT 账号。三源按 **settings → env → vault** 的优先级去重合并（同一个 PAT 只在最高优先级的来源里列出一次）。

- 卡片可新增（粘贴 `pt-…`，经 `JobToken` 交换校验并取回显示名）/ 移除 / 改名 vault 账号，也可显式选择某一账号服务（`regions.<region>.accountId`，留空自动）。
- 选中的凭据只用于会话的 jobToken 交换与后续 cosy 请求，从不进入 pi-ai 或页面。
- `logout [--region cn|global]` 会清除指定区域的 vault 账号与账号池测量副本（`$DSH_HOME/.qoder-accounts.<region>.json` 与 `.qoder-pool.<region>.json`）。

## 命令行诊断

```bash
dsh-connect-qoder doctor                # PAT 来源 + cosy 指纹派生 + pi-ai 代际 + 心跳 + vault 计数（纯本地，不发请求）
dsh-connect-qoder status                # 每区域凭据来源 + 上游模型目录可达性 + 剩余积分（需 PAT）
dsh-connect-qoder logout --region cn    # 清除指定区域的 vault 账号与账号池测量副本
dsh-connect-qoder doctor --json         # 机器可读输出
```

`status` 会真实交换一次 jobToken 并拉取模型目录（随后只读查询一次用量），因此需要对应区域的环境变量或 vault PAT；`doctor` 完全离线。

## 平台支持

| 平台 | 状态 |
| --- | --- |
| macOS | ✅ 已验证（开发与 CI） |
| Windows | ✅ CI 测试通过（上游请求走标准 fetch，无平台专属路径） |
| Linux | ✅ CI 测试通过 |

## 受支持的宿主范围

| 宿主 | peer 范围 |
| --- | --- |
| DSH（`@deepseek-ai/*`） | `>=0.1.7-rc.1 <0.3.0-0` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |

> 范围由 `tests/dsh-line.spec.ts` 强制：上界必须带 `-0`（DSH 至今只发预发布，`<0.3.0` 不挡任何东西）。

## 安全说明

- PAT 只写入本地插件配置（或环境变量），**从不进入任何网络请求**；对外请求一律使用 cosy 会话令牌（jobToken）+ 机器指纹头。
- 本地 shim 用随机端口的 loopback 服务 + 进程内 secret 鉴权，并校验 Host / Origin / Content-Type，请求体有 64MB 上限。
- 本插件只读你显式提供的 PAT；**不读取、不修改** Qoder 桌面端的本地登录/凭据文件。
- 诊断输出（`doctor` / `status` 与卡片探测）均脱敏，不打印任何令牌样式的字符串。

## 致谢

本项目建立在他人已公开的工作之上，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：

- [**Zhengyuuuui/qoder2api**](https://github.com/Zhengyuuuui/qoder2api)：cosy 协议 wire behavior 的参照实现（编码、签名、会话、指纹、jobToken、SSE 形状、错误分类）。本项目按其行为**独立实现**为 TypeScript，不复制其源码；该仓库未附独立 LICENSE，其 README 声明源自 `wangtufly/QCCG`（GPL-3.0）。
- [**dingminhua/dsh-connect-workbuddy**](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT）：插件工程结构、卡片交互模型、loopback shim 模式与 npm 发布工程的基准。
- [**dingminhua/dsh-connect-trae**](https://github.com/dingminhua/dsh-connect-trae)（MIT）：经 workbuddy 转引的卡片外观与发布工程基准。
- [**franksong2702/dsh-codex-connect**](https://github.com/franksong2702/dsh-codex-connect)（Apache-2.0）：经 workbuddy 转引的 DSH 插件结构与 pi-ai provider 注册参照。
- Qoder 官方 SDK 的类型定义：仅用于 usage/头的形状核对，不随本项目分发。

## License

MIT © LaoDing —— 详见 [LICENSE](LICENSE)。