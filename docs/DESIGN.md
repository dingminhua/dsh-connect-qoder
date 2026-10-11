# 设计方案：dsh-connect-qoder

> **目标**：把 Qoder（通义灵码国际 / 国内）接入 DeepSeek Harness（DSH）。
> **表现形式**：与插件家族一致（`dsm-*` 卡片外观），基准实现为
> [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy)。
> **内核**：DSH 官方不提供 Qoder 的 OpenAI 兼容端点，官方 SDK 只是 agent 启动器，
> 因此本项目直接实现 cosy 网关协议的最小客户端。

---

## 一、与 workbuddy 的分工

| 层 | 来源 | 取什么 |
|---|---|---|
| 插件外壳 / 外观 | `dsh-connect-workbuddy` | 卡片结构、`dsm-*` CSS、`settingsScope` 配置回写、路由形态、发布工程、CI |
| 连接内核 | 自行实现（`src/cosy.ts` / `src/upstream.ts`） | Qoder 的 cosy 协议：自定义 Base64、MD5 签名、RSA/AES 会话、指纹派生、jobToken 交换、SSE 增量解析 |
| 已修缺陷的教训 | `dsh-connect-workbuddy` | 「平台标记 ≠ 模型原生能力」「声明可关闭思考不等于真的能关」等已踩过的坑（见第五节） |

关键差异（**合理**差异，非缺口）：

- **凭据**：workbuddy 读桌面端本地加密凭据（`auth.ts` / `at-rest.ts` / `oauth.ts`）；
  本插件用用户自备的 PAT（`credentials.ts`）+ 本地 vault（`accounts.ts`）。
- **签到**：WorkBuddy 有每日签到端点；Qoder **没有**，故 `pool.checkinSupported`
  恒为 `false`，卡片不渲染签到列。
- **工具调用恢复**：workbuddy 需要 `dsml-recovery.ts` / `markup-diagnosis.ts`，
  因为其上游**不**发原生 tool_calls；Qoder 上游**原生**发 `delta.tool_calls`
  （见 `src/upstream.ts` 的解析与 `src/shim.ts` 的直写），故不需要这两个模块。

---

## 二、模块结构

```text
DSH PiAiAdapter（qoder / qoder-global 各一套）
  -> 安全 loopback shim（每区域一个随机端口 + 进程内随机 secret）
  -> QoderUpstreamClient（cosy 协议最小客户端）
  -> https://gateway.qoder.com.cn/algo/api/v2/...   （国内）
  -> https://api1.qoder.sh/algo/api/v2/...          （国际）
  -> Qoder SSE（OpenAI 形状增量）
```

| 模块 | 职责 |
|---|---|
| `status-paths.ts` | node-free 契约中心：路由常量、DTO、区域/动作 helper |
| `cosy.ts` | 协议层：自定义 Base64、`n/3` 重排、签名、RSA/AES 会话、指纹 |
| `upstream.ts` | `exchangeJobToken` / `fetchModels` / `chatStream` / `fetchUsage`；错误分类 |
| `credentials.ts` | PAT 校验、`qoderAccountId`（sha256 前 16 位）、掩码 |
| `accounts.ts` | 本地 vault（`$DSH_HOME/.qoder-accounts.<region>.json`，0600），三源去重合并 |
| `account-pool.ts` / `-store.ts` / `-run.ts` | 账号池排序（`rankPool`）、测量落盘、批量测试 |
| `off-thinking.ts` | 「可关闭思考」的校正表与种子（见第五节） |
| `native-modality.ts` | 模型原生多模态表与图片默认值（见第五节） |
| `shim.ts` | loopback 服务：入站校验、SSE 翻译、首字节前故障转移 |
| `adapter.ts` | pi-ai 装配：代际门控、思考档位映射、模型描述符 |
| `web-status.ts` | 浏览器路由：usage / account-credits / accounts / pool / transfer / probe / `__save` |
| `index.ts` | 装配中枢：双区域栈、配置 schema、目录管注册 |
| `bin.ts` | CLI：`doctor` / `status` / `logout` |

---

## 三、凭据与账号池

三源按 **settings → env → vault** 优先级去重合并（同一个 PAT 只在最高优先级
来源里列出一次，id 由 PAT 本身派生，故重复项必然精确相同）：

| 来源 | 位置 | 说明 |
|---|---|---|
| settings | `regions.<region>.pat` | 卡片填写，优先 |
| env | `QODERCN_PERSONAL_ACCESS_TOKEN` / `QODER_PERSONAL_ACCESS_TOKEN` | 无 UI 场景 |
| vault | `$DSH_HOME/.qoder-accounts.<region>.json` | 多账号池，0600 |

账号池「实测优先」：`test` 批量对每个成员发真实探测，结果落
`$DSH_HOME/.qoder-pool.<region>.json`；聊天流在**首字节之前**按 `rankPool`
（可用性 → 额度从高到低 → 到期最近 → id）自动换账号。首字节之后绝不换账号
（那会让用户看到两个人拼出来的回答）。

**没有每日签到**，所以池只有 `test` / `remove` 两个动作。

---

## 四、推理与上下文

- **推理**：Qoder 的推理线上量是**布尔** `model_config.is_reasoning`，不是 effort
  档位。所以 `qoderThinkingLevelMap` 只能表达 `off`（且仅
  `canDisableThinking` 的模型提供），所有 effort 档位映射 `null`。
- **上下文档位**：从上游 `context_config` 解析模型**声明的**档位
  （`contextTiers`），用户按档选择；预算只在该档位确实被声明时生效，否则回落
  原生值（`applyContextBudgets`）——不发明一个上游不认的值。

---

## 五、从 workbuddy 继承的「已修缺陷」教训（重点）

这三条是同一个形状的问题：**上游的声明字段不可全信**。解法也相同：按**精确
model id** 键控的人工核对表 + 只在有依据时才给默认值，其余留 `unknown`（宁可
少给，也不要每次都失败/撒谎）。

### 5.1 平台标记 ≠ 模型原生能力（`native-modality.ts`）

上游目录的 `supportsImages`（Qoder 的 `is_vl`）是**平台**的图片输入声明，不是
**模型**的原生能力：它在内置目录里几乎对每个模型都是 `true`，连纯文本模型
（DeepSeek-V4-Pro、GLM-5.2、Kimi-K2.7-Code 等）也是 `true`。直接采信会在纯文本
模型上默认开出图片输入，用户一发图就 400。

解法：`NATIVE_MODALITY_BY_MODEL_ID` 表 + `imageDefaultFor`（只有文档确认
`multimodal` 才预勾选；`supportsImages:false` 仍可否决）。**与 workbuddy 的差异**：
对方面向已核对过的数据源，本项目**没有**同等来源，故不虚构条目，只登记少数可从
厂商命名确认的项，其余保持 `unknown`（= 不预勾选）——比信任平台标记严格更安全。

### 5.2 声明「可关闭思考」≠ 真的能关（`off-thinking.ts`）

workbuddy 实测：声明可关闭的模型里有一部分对 `reasoning_effort:"off"` 回 400，
且错误体不点名参数。由于该档位写进运行时描述符，失败会在**此后每一次请求**上
重演，用户读到的是「这个模型坏了」。

解法：`REFUSES_OFF_MODEL_IDS` + `offDefaultFor` + `defaultOffModelIds`（首读种子）
+ `withEffectiveOff`（把用户选择盖印到运行时目录）。**差异**：本项目暂无实测拒绝
样本，故拒绝集**留空而非虚构**——默认行为等同 0.1.0（不倒退），一旦实测到只需
加一行即可开始隐藏。代价不对称是这里的取舍依据：提供一个必然失败的档位，代价是
用户该模型的每一次请求；藏起一个本可用的档位，代价只是一个选项。

### 5.3 图片勾选必须独立持久（`imageModelKeys`）

workbuddy 用独立的 `imageModelIds`；本项目早期把图片勾选**耦合进** `lastCatalog`
快照，目录一被重写就可能连带改变某个模型的图像答案。现改为独立集合
（`regions.<region>.imageModelKeys`），运行时只从它派生图像能力。

---

## 六、安全

- **PAT 不出进程**：pi-ai 只与本地 shim 对话；shim 用 cosy 会话做上游请求。
- **shim 入站校验**：先查 Host / Origin（仅接受 `127.0.0.1`）/ Content-Type，
  再做 `timingSafeEqual` bearer 比对；body 有大小上限。
- **脱敏**：任何上游文本在落盘/回传前经 `redactUpstreamText`
  （`key=secret` 保留键名抹值；裸 `pt-` token 整段替换）。
- **vault 权限**：`0600`（目录 `0700`），写入走原子替换 + 文件锁。
- **不读桌面端登录文件**：与 workbuddy 不同，本插件不接触、不修改 Qoder 桌面端
  的任何本地凭据。

---

## 七、源头与致谢

- 外观与工程骨架：[`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT）—— 各源文件头部均带标注。
- cosy 协议行为参照：[`qoder2api`](https://github.com/Zhengyuuuui/qoder2api) / `QCCG`（其声明为 GPL-3.0）。
  本项目**未复制其源码**，按其文档与运行行为独立实现为 TypeScript。
  合规细节见 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
- 商标：Qoder 名称与图标是厂商商标，此处仅用于标识本插件所连接的服务。
