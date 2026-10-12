# 第三方开源声明（Third-Party Notices）

> 本文件记录本项目在设计、实现与外观上参考或借鉴的开源项目，以及各自的许可证与合规要求。
>
> 通用平台与构建依赖（`@deepseek-ai/*`、`react`、`typescript`、`tsdown`、`vitest` 等）的许可证随各自 npm 包自动携带，不属于本文档范围。
>
> 若你对本文件的完整性有疑问或发现遗漏，请提交 issue 或 PR。

## 一、项目缘起

本项目是把 **Qoder（通义灵码国际 / 国内）模型接入 DeepSeek Harness（DSH）** 的独立实现：DSH 官方不提供 Qoder 的 OpenAI 兼容端点，官方 SDK 只是 agent 启动器，因此本项目直接实现 cosy 协议的最小客户端（自定义 Base64、MD5 签名、RSA/AES 会话、指纹派生、jobToken 交换、SSE 增量解析），并参照同作者的 workbuddy 插件工程组织 host↔client 结构。

## 二、参考项目清单

### 与 Qoder / cosy 接入直接相关

| 项目 | 仓库 | 参考内容 | 许可证 |
| --- | --- | --- | --- |
| `qoder2api`（Go） | <https://github.com/Zhengyuuuui/qoder2api> | cosy 协议 wire behavior 的参照实现：自定义 Base64 编码与重排、MD5 签名（`cosy&<SECRET>&<date>`）、RSA/AES 会话封装、指纹派生、jobToken 交换、SSE 信封与增量形状、错误分类。本项目**未复制其源码**，按其文档与运行行为独立实现为 TypeScript（`src/cosy.ts` / `src/upstream.ts`） | 仓库未附独立 LICENSE，README 声明其源自 `wangtufly/QCCG`（**GPL-3.0**，见下） |
| `QCCG`（qoder2api 的上游） | <https://github.com/wangtufly/QCCG> | qoder2api 声明的协议源头。本项目仅经 qoder2api 了解协议行为，未接触其源码 | **GPL-3.0** |
| `Qoder-Daily`（青龙脚本） | <https://github.com/L0NE-6/Qoder-Daily> | **每日签到**的协议参照：`sash/api/v1/me/campaigns` 拉活动 + `…/{campaignId}/claim` 领取的请求形状、`jt-` 令牌与 `cosy-clienttype` 头、幂等判定（`CLAIMED` / 409 / `replayed`），以及国际版所需设备风控三件套（`Cosy-MachineToken` / `MachineCode` / `MachineType`）由本机 UMID 组件产出的思路。本项目**未复制其源码**，按其文档与本机实测行为独立实现为 TypeScript（`src/upstream.ts` 的签到部分 / `src/device-risk.ts`），并补了它没有的两点：逐账号「先查后领」的幂等，以及取不到设备身份时**如实报错**而不是静默降级成「今天没有活动」 | **MIT** |
| Qoder 官方 SDK（agent 启动器） | 厂商随 IDE 分发的 TypeScript 类型定义（本地 `/tmp/sdk`） | 仅用于**类型核对**（usage 形状、cosy 头字段名），未复制其实现 | 厂商内部许可（不随本项目分发） |

> **GPL-3.0 合规说明**：本项目与 `QCCG`（GPL-3.0）之间**没有源码级衍生关系**——cosy 协议是公开的请求/响应行为（可通过抓包与文档观察），本项目按该行为**独立实现**全部加解密、签名与会话逻辑，不复制、不修改、不链接其任何源码。GPL 的传染性不适用于「仅参照协议行为、clean-room 独立实现」的作品；本项目自身以 MIT 发布，与之不存在再分发冲突。若你对这一判断有异议或发现任何源码级相似，请提交 issue。

### 与 DSH 插件结构 / 外观相关

| 项目 | 仓库 | 参考内容 | 许可证 |
| --- | --- | --- | --- |
| `dsh-connect-workbuddy` | <https://github.com/dingminhua/dsh-connect-workbuddy> | 插件工程结构的基准：host↔client 路由形态、设置卡片交互模型（区域 tab / 模型勾选 / 用量 / 探测）、loopback shim 模式、`web-status.ts` 路由、npm 发布工程（package.json / RELEASING / README 结构 / dsh-line 测试） | **MIT**（Copyright (c) 2026 LaoDing） |
| `dsh-connect-trae` | <https://github.com/dingminhua/dsh-connect-trae> | 经 `dsh-connect-workbuddy` 转引的 DSH 插件卡片外观与发布工程基准 | **MIT**（Copyright (c) 2026 LaoDing） |
| `dsh-codex-connect` | <https://github.com/franksong2702/dsh-codex-connect> | DSH 插件结构与 pi-ai provider 注册的参照（经 `dsh-connect-workbuddy` 转引） | **Apache-2.0** |

## 三、Apache-2.0 特别说明

`dsh-codex-connect` 采用 **Apache License 2.0**。本项目对它的参考是**间接的**：经由 `dsh-connect-workbuddy` 转引其 DSH 插件结构与 provider 注册思路。即便如此，本项目仍遵守 Apache-2.0 第 4 条的要求：

- **保留声明**：在该项目条目中标注其许可证为 Apache-2.0，并注明「经 `dsh-connect-workbuddy` 转引」的事实路径。
- **NOTICE 文件**：`dsh-codex-connect` 未随其仓库提供独立的 `NOTICE` 文本文件；若上游后续补充，本项目将同步将其内容纳入本文件。
- **改动声明**：本项目**未修改** `dsh-codex-connect` 的源码；适配器装配与插件注册为独立实现。
- **专利与商标**：本项目不主张 `dsh-codex-connect` 作者的任何专利许可或商标权利。

## 四、本项目的使用方式

- **借鉴设计思路 + 独立实现**：关键模块均为本项目独立编写（cosy 加解密、签名、会话、shim、适配器装配），并在各源文件头部注释中标注所参考的具体项目与模式。
- **不复制源码**：全部参考项目均只借鉴设计思路或协议行为，未复制、修改或再分发其源文件（含 GPL-3.0 的 `QCCG` 与无独立 LICENSE 的 `qoder2api`）。
- **版权声明保留**：所有参考项目的版权归各自作者所有。
- **后续引入依赖时**：引入任何新的 Qoder 相关外部依赖、或复用其他项目代码时，必须同步更新本文件，并遵守对应许可证的署名与声明要求。

## 五、图标来源与商标说明

本项目的插件图标（`icons/dsh-connect-qoder-128.png`、`icons/dsh-connect-qoder-64.png`，以及 `src/client/icon.ts` 中内联的 base64 副本）是 **LaoDing 插件家族通用的 LD 品牌标**（蓝紫渐变圆角磁贴 + 白色字标），与 `dsh-connect-trae` / `dsh-connect-workbuddy` 的图标**字节一致**——家族约定：图标标识「这是同一家族的插件」，产品区分由卡片标题、描述与配色承载。该美术作品由本作者原创，随本项目 MIT 许可分发。

- **0.2.0 曾用过 Qoder 桌面客户端的应用图标本体**（从 `/Applications/Qoder.app/…/application-icons/qoder-dark.png` 降采样），属**指示性使用**；0.3.0 起已改回家族 LD 标，**不再随包分发任何第三方美术作品**。
- **商标**：`Qoder`、`通义灵码` 名称与各自图标是厂商的商标，本项目仅在描述兼容关系的意义上使用其名称，不表示 Qoder 官方出品、背书或授权；相关权利归各自所有。
- **可替换性**：替换图标只需重新生成 `icons/` 下两个 PNG 并同步 `src/client/icon.ts` 的 data URI（见该文件头部注释），不影响任何代码逻辑。

## 六、随包分发

本文件已列入 `package.json` 的 `files` 白名单，随 npm 包一同分发，确保最终用户在安装包内即可看到完整的第三方声明。README（中英双语）中的「致谢」章节与本文件互为索引。
