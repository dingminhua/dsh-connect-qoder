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
| `qoder2api`（Go） | <https://github.com/Zhengyuuuui/qoder2api> | cosy 协议 wire behavior 的参照实现：自定义 Base64 编码与重排、MD5 签名（`cosy&<SECRET>&<date>`）、RSA/AES 会话封装、指纹派生、jobToken 交换、SSE 信封与增量形状、错误分类、签到端点。本项目**未复制其源码**，按其文档与运行行为独立实现为 TypeScript（`src/cosy.ts` / `src/upstream.ts`） | 仓库未附独立 LICENSE，README 声明其源自 `wangtufly/QCCG`（**GPL-3.0**，见下） |
| `QCCG`（qoder2api 的上游） | <https://github.com/wangtufly/QCCG> | qoder2api 声明的协议源头。本项目仅经 qoder2api 了解协议行为，未接触其源码 | **GPL-3.0** |
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

本项目的插件图标（`icons/dsh-connect-qoder-128.png`、`icons/dsh-connect-qoder-64.png`，以及 `src/client/icon.ts` 中内联的 base64 副本）**不是本项目原创的美术作品**，而是取自**本机安装的 Qoder 桌面客户端**自身的应用图标：

| 来源 | 路径 | 处理 |
| --- | --- | --- |
| Qoder 桌面版（国际版）应用图标 | `/Applications/Qoder.app/Contents/Resources/application-icons/qoder-dark.png`（1024×1024，深色磁贴 + 白色 Q 字标） | 按 alpha 包围盒裁掉四周透明边，降采样为 128px / 64px |

选择 `qoder-dark`（而非 `qoder-light`，即透明底黑 Q）的原因：DSH 的设置卡片为深色背景，透明底黑 Q 在该背景下不可辨；深色磁贴自带底色，深浅主题下均可读，且与同作者其他插件「自带底色的磁贴」外观一致。

- **使用性质**：**指示性使用（nominative use）**——本插件是第三方客户端，图标用于**标识它所连接的服务**，不表示 Qoder 官方出品、背书或授权。
- **权利归属**：`Qoder` 名称与图标是厂商的商标，图标美术作品的版权归厂商所有，**不适用本项目的 MIT 许可**；本项目仅随包分发该图标以标识所连接的服务。
- **可替换性**：若厂商对上述使用有异议，替换图标只需重新生成 `icons/` 下两个 PNG 并重跑一次 `src/client/icon.ts` 的生成脚本（见该文件头部注释），不影响任何代码逻辑。

## 六、随包分发

本文件已列入 `package.json` 的 `files` 白名单，随 npm 包一同分发，确保最终用户在安装包内即可看到完整的第三方声明。README（中英双语）中的「致谢」章节与本文件互为索引。
