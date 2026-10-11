# 更新日志（Changelog）

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.2.0 (2026-01-01)

与同族插件 `dsh-connect-workbuddy`（参考实现）对齐外观与能力，同时贴合 Qoder 的 PAT 上游现实。

### Features

- **多账号池（PAT）** —— 每区域一个 `$DSH_HOME/.qoder-accounts.<region>.json` 本地 vault（0600），叠加设置 PAT 与环境变量，三者按 settings → env → vault 去重合并；卡片可新增 / 移除 / 改名账号，也可显式选择某账号服务（`regions.<region>.accountId`，留空自动）。
- **账号池按实测排序与故障转移** —— 「测一测」批量对每个成员发真实请求，结果落 `$DSH_HOME/.qoder-pool.<region>.json`；聊天流在首字节前按 `rankPool`（可用性 → 额度从高到低 → 到期最近 → id）自动换账号，失败回写 `live-request` 探测记录。Qoder **没有每日签到**，故 `checkinSupported` 恒为 `false`、卡片不出现签到列。
- **账号转移（导入 / 导出）** —— 按区域导出 vault 账号为传输文件，预览后按索引导入；跨区域域名（`qoder.com.cn` / `qoder.sh`）正向匹配，不匹配的记录计入 `skipped`。
- **PAT 校验与增删** —— 新增 PAT 时经 Qoder `JobToken` 交换校验并取回显示名，失败即拒绝；移除只删 vault 条目，不碰设置 PAT / 环境变量。
- **上下文预算（context tiers）** —— 从上游 `context_config` 解析模型声明的档位，卡片按档位选择上下文预算，仅在已声明档位内生效（否则回落原生值）。
- **积分读数进 composer** —— `conversation.input.left` 插槽（order 4）按区域显示 `QD CN` / `QD AI` 与当前账号余额，受每区域 `showCreditsInMainUi`（默认开，opt-out）控制；每账号明细走 `account-credits` 路由。
- **CLI 增强** —— `doctor` 增报 pi-ai 代际、宿主心跳存活、vault 账号计数；`status` 增报凭据来源与当前剩余积分；新增 `logout [--region cn|global]` 清除本区域 vault 账号与账号池测量副本。
- **回环路由扩展** —— 新增 `usage`（每区域快照）、`account-credits`、`accounts add/remove`、`pool test/remove`、`transfer export/preview/import`、`__save`（两段式合并，防部分写入误删兄弟区域）。

### Changed

- **客户端对齐同族 `dsm-*` 视觉语言** —— `dsm-qoder-*` 组件类 + 与 workbuddy 逐字一致的共享 `.dsm-plugin-card*` / `.dsm-btn*`；文案迁移到 `row.*` / `composer.*` 双语键；新增账号池表、账号转移面板、PAT 新增表单、composer 积分读数与忙碌遮罩等组件。
- **PI 代际兼容桥** —— 适配器按 `piAiRuntimeInfo()` 代际门控：legacy pi-ai 把 0.87 形态 transcript 折回 0.85 形态（system 消息与 tools 折叠到 `systemPrompt`/`tools`），modern 代际原样透传；Qoder 上游接受 user-first 会话，故不注入兜底 system prompt。
- **推理档位** —— Qoder 推理线上量是布尔 `model_config.is_reasoning`（非 effort 档），故 `qoderThinkingLevelMap` 只表达 `off`（仅 `canDisableThinking` 模型提供），各 effort 档位映射 `null`。
- **插件图标** —— 改用 Qoder 桌面版**应用图标本体**（`icon.icns` 解出的白底黑 Q），替换此前那张与深色卡片几乎融为一体的黑底磁贴；共享 `.dsm-plugin-card-icon`（32×32、radius 7px）与 workbuddy 逐字节一致。
- **探针结果文案统一** —— 抽出 `client/probe-label.ts` 作为**唯一**渲染规则：模型行与账号池表此前各写一套（耗时一处毫秒一处秒、恢复时刻一处只有时:分:秒一处是日期+时间），同一份测量两种说法；并补回缺失的耗时（`probeOkMs`）与上游给出的恢复时刻（`probeRateLimitedAt` / `probeOutOfCreditAt` + 相对时长）。

### Fixed

- **图片输入的默认值不再采信平台标记** —— 上游 `is_vl` 是**平台**声明而非模型原生能力（内置目录里几乎全是 `true`，连纯文本模型也是），据此默认勾选会在纯文本模型上开出图片输入、一发图即 400。改为按精确 model id 键控的人工核对表（`native-modality.ts`），只有文档确认 `multimodal` 才预勾选，未核实一律不勾。
- **图片勾选改为独立持久集合** `regions.<region>.imageModelKeys`（原与 `lastCatalog` 快照耦合，目录重写可能连带改变图像答案），运行时只从该集合派生图像能力。
- **「可关闭思考」增加校正机制** —— 上游声明的 `canDisableThinking` 不可全信（workbuddy 实测有模型对 `reasoning_effort:"off"` 直接 400，且失败会在此后每次请求重演）。新增 `off-thinking.ts`：拒绝集 + 首读种子 + 运行时盖印。本插件暂无实测样本，拒绝集留空而非虚构（行为不倒退，有样本时加一行即可生效）。
- **脱敏缺陷** —— `redactUpstreamText` 原实现 `'$1[redacted]'` 把含密钥的捕获组原样保留，等于没有脱敏；改为 `key=` 保留键名抹值、裸 `pt-` token 整段替换。
- **账号删除改为二次确认** —— vault 是这些账号的**唯一**存储位置，硬删无法找回（workbuddy 的删除是可找回的「暂时隐藏」，故它不需要确认）；两步内联确认替代一键删除。
- **探针结果按区域分别存放** —— 原为扁平命名空间，切换 tab 会串台；改为与 workbuddy 同构的按区域键控，刷新目录不再丢失已测结果。
- **账号池目标下拉补失效项** —— 已保存但已下架的 `targetModelId` 缺少自己的 option 时，受控 select 会退回显示第一项而值仍是旧 id（显示与取值分叉，下次保存又把旧 id 写回）；补一个 disabled 的失效项。

### Docs

- README / README.en.md（双语）更新为 0.2.0 的多账号池、转移、上下文预算与 composer 积分能力。
- 新增 [`docs/DESIGN.md`](docs/DESIGN.md)：模块结构、凭据与账号池、以及从 workbuddy 继承的三条「已修缺陷」教训与取舍依据。
- 新增 `scripts/probe-cosy.mjs`（不依赖宿主直连 cosy 链路验证）与 `scripts/dump-vault.mjs`（只读 dump vault / 账号池测量），并加 `pnpm run probe:cosy` / `probe:vault` 入口。

### Tests

- 测试覆盖从 9 个 spec / 82 用例扩到 **21 个 spec / 349 用例**：为此前零测试的 host 模块补齐规格（account-pool 三件套、accounts vault、credentials、transfer、probe、credential-recovery、web-status 全路由、adapter、native-modality、off-thinking，并扩展 catalog）。
- 测试基建对齐 workbuddy：per-file 隔离 `DSH_HOME`（`tests/setup-per-file-home.ts` + `vitest.config.ts` 的 env 隔离），避免 vault/账号池/心跳文件在用例间互相污染。

## 0.1.0 (2026-01-01)

首个公开发布版本。

### Features

- **双区域并行接入** —— 国内版注册为 `qoder` provider（`gateway.qoder.com.cn`），国际版注册为 `qoder-global` provider（`api1.qoder.sh`）；有 PAT 的区域其模型出现在 DSH 模型选择器里，两个 provider 可同时使用。
- **PAT 凭据** —— 设置卡片内粘贴（`regions.<region>.pat`）或环境变量（`QODER_PERSONAL_ACCESS_TOKEN` / `QODERCN_PERSONAL_ACCESS_TOKEN`），设置项优先；凭据只写入本地插件配置，从不进入网络请求。
- **模型目录与倍率** —— 从 cosy 网关实时拉取模型清单，价格因子以内嵌 `· xN.NN` 显示；逐项勾选启用（`enabledModelKeys`），保存立即生效；上游不可达时回退内置静态目录。
- **用量概览** —— 每区域只读展示基础额度 / 附加额度 / 组织额度的已用、总量、剩余、占比与到期时间。
- **模型可用性测试** —— 卡片内对单个模型「测一测」，直达上游确认可用性，限流 / 凭据无效 / 内容审核分别报因。
- **区域开关（opt-out）** —— 每个区域右侧勾选框，显式取消勾选即把该 provider 从选择器整体撤下；账号配置全部保留，重新勾选即恢复。
- **安全 loopback shim** —— 每区域一个随机端口 + 进程内随机 secret，真实 PAT 不交给 pi-ai。
- **命令行诊断** —— `dsh-connect-qoder doctor|status [--json]`，无需浏览器即可确认 PAT 来源、指纹派生与上游可达性。

### Docs

- README / README.en.md（双语）、CHANGELOG、THIRD_PARTY_NOTICES、RELEASING（发布流程）。
- 收录草稿：`awesome-dsh-plugin-submission/`（Awesome DSH Plugin 注册表）。

### 说明

- 首次发布按 `RELEASING.md` 流程执行；`npm publish` 若走暂存发布（staged publishing），需 2FA 批准后再核对 registry。
