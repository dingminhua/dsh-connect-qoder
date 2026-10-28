# 设计方案：dsh-connect-qoder

> **目标**：把 Qoder（通义灵码国际 / 国内）接入 DeepSeek Harness（DSH）。
> **表现形式**：与插件家族一致（`dsm-*` 卡片外观），基准实现为
> [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy)。
> **内核**：DSH 官方不提供 Qoder 的 OpenAI 兼容端点，官方 SDK 只是 agent 启动器，
> 因此本项目直接实现 cosy 网关协议的最小客户端。

---

## 一、边界：不做什么

**不做插件之间的联动。** 本插件只对 DSH 宿主负责：自己的 provider、自己的凭据、
自己的账号池、自己的读数。它不探测、不读写其他插件的配置 / 落盘 / 内存状态，不
订阅或替别的插件发事件，也不参与需要两方约定协议的协作——「联合面板」「统一账号池」
「跨插件的会话路由」这类活一律不做。

理由不是能力问题，而是三条边界一旦跨过就回不来：

- **凭据边界**：账号池里的 PAT 是本插件保管的东西。任何跨插件共享都意味着它要离开
  这个边界，而对方怎么存、怎么落盘、会不会写进日志，不在本插件的控制里。
- **故障归因**：联动出问题时，用户看到的是「装了这个就不对」，两边日志各说各话。
  不联动，每次失败就只有一个可能的责任方。
- **版本耦合**：联动的两端必须一起发版、一起测、一起修，而两个插件的宿主基线、
  发版节奏本来就不必相同。

第一个被这条边界裁掉的功能，是 1.10.0 引入、1.12.0 移除的**跨连接器余额对比**
（issue #14）：别的连接器的模型被选中时，本区域也把积分胶囊画出来。它让本插件去
解释另一个插件的存在，读数还出现在一个根本不经过 Qoder 计费的会话里；要对比两边
余额，切一下模型即可，不需要两个插件就「同时显示」达成一致。

**共享插槽**上的占位冲突同理：`conversation.input.left` 是 list 插槽，另一个插件
停在那里可能把读数挤到看不见。本插件的回答是给自己多留一个可选席位
（`creditPosition`：输入框工具栏 / 输入框下方），由用户换位置，而不是去和对方协商
谁先谁后。

与「不联动」不矛盾的三件事，划在这里免得被读成同一类：

- **读宿主的公开投影**（`modelSelection`）不算联动——那是宿主对所有插件公开的契约，
  不是插件之间的私约。本插件据此判断「当前会话是不是在用我的模型」，仅此而已。
- **同族借鉴**（卡片外观、已修缺陷的教训，见第二节）是**源码级**的，不是运行期
  的：两个插件装在同一台机器上也互不感知、互不调用。
- **单槽的委托渲染**——宿主槽位机制下的降级策略，见下一段。它不读对方状态、不约定
  私有事件，换谁来当邻居都一样。

### 唯一的例外：模型选择器标签槽的委托

会调用到别的插件代码的地方只有一处：宿主的模型选择器标签槽
（`conversation.input.model.label`，见 `src/client/QoderModelLabel.tsx`）。

它是 **single 槽**——priority 升序、最低者渲染，一个槽只容一个占位者。本插件用
`-1` 占住它之后，**所有** provider 的模型行都交给它来画。对不属于本插件的行，
`foreign` 分支从槽位账本里取下一个注册项（跳过自己），把宿主的 ownerProps 四项原样
转给它、并渲染成**子元素**；账本里没有别人，就画 `model.name`。

这不是「联动」，而是**不抢占**：single 槽只有一个占位者，本插件占了槽却只画自己的
东西，别家插件的徽标就会在用户眼前消失——那比「不合作」更糟。委托只经过宿主公开的
槽位账本与 ownerProps 契约：不按名字找某个插件，不读它的配置 / 落盘 / 内存，也不与它
约定事件。账本里是谁就委托给谁。

`tests/model-label.spec.tsx` 的「外来 provider 的委托」一节把这条钉住：被委托的组件
必须作为子元素渲染（它有自己的 hooks；直接函数调用会把两边的 hook 序列混在一起）。

---

## 二、与 workbuddy 的分工

| 层 | 来源 | 取什么 |
|---|---|---|
| 插件外壳 / 外观 | `dsh-connect-workbuddy` | 卡片结构、`dsm-*` CSS、`settingsScope` 配置回写、路由形态、发布工程、CI |
| 连接内核 | 自行实现（`src/cosy.ts` / `src/upstream.ts`） | Qoder 的 cosy 协议：自定义 Base64、MD5 签名、RSA/AES 会话、指纹派生、jobToken 交换、SSE 增量解析 |
| 已修缺陷的教训 | `dsh-connect-workbuddy` | 「平台标记 ≠ 模型原生能力」「声明可关闭思考不等于真的能关」等已踩过的坑（见第六节） |

关键差异（**合理**差异，非缺口）：

- **凭据**：workbuddy 读桌面端本地加密凭据（`auth.ts` / `at-rest.ts` / `oauth.ts`）；
  本插件用用户自备的 PAT（`credentials.ts`）+ 本地 vault（`accounts.ts`）。
- **签到**：两边都有每日签到，但端点不同——WorkBuddy 有专用 checkin 端点，Qoder
  的签到藏在 `sash/api/v1/me/campaigns`（活动/权益）+ `…/{campaignId}/claim` 里，
  名字没有「签到」二字，照 checkin / signin / reward 猜路径一律 404（早期据此
  误判为「没有签到」，已修正）。国际版的活动只下发给带设备风控头的请求，
  三件套由 `device-risk.ts` 读本机 Qoder 客户端的 UMID 组件产出。
- **工具调用恢复**：workbuddy 需要 `dsml-recovery.ts` / `markup-diagnosis.ts`，
  因为其上游**不**发原生 tool_calls；Qoder 上游**原生**发 `delta.tool_calls`
  （见 `src/upstream.ts` 的解析与 `src/shim.ts` 的直写），故不需要这两个模块。

---

## 三、模块结构

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
| `upstream.ts` | `exchangeJobToken` / `fetchModels` / `chatStream` / `fetchUsage` / `fetchCampaignFeed`；错误分类 |
| `credentials.ts` | PAT 校验、`qoderAccountId`（sha256 前 16 位）、掩码 |
| `accounts.ts` | 本地 vault（`$DSH_HOME/.qoder-accounts.<region>.json`，0600），三源去重合并 |
| `account-pool.ts` / `-store.ts` / `-run.ts` | 账号池排序（`rankPool`）、测量落盘、批量测试 |
| `off-thinking.ts` | 「可关闭思考」的校正表与种子（见第六节） |
| `native-modality.ts` | 模型原生多模态表与图片默认值（见第六节） |
| `shim.ts` | loopback 服务：入站校验、SSE 翻译、首字节前故障转移 |
| `adapter.ts` | pi-ai 装配：代际门控、思考档位映射、模型描述符 |
| `web-status.ts` | 浏览器路由：usage / account-credits / campaigns / accounts / pool / transfer / probe / `__save` |
| `index.ts` | 装配中枢：双区域栈、配置 schema、目录管注册 |
| `bin.ts` | CLI：`doctor` / `status` / `logout` |

---

## 四、凭据与账号池

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

**每日签到已接通**（CN 与国际版），所以池的批量动作是 `checkin` / `test` 两个，
另有逐账号的 `remove`。签到**先查状态再领取**（幂等），且只在你点按钮时执行——
不提供自动签到。

---

## 五、推理与上下文

- **推理**：Qoder 的推理线上量是**布尔** `model_config.is_reasoning`，不是 effort
  档位。所以 `qoderThinkingLevelMap` 只能表达 `off`（且仅
  `canDisableThinking` 的模型提供），所有 effort 档位映射 `null`。
- **上下文档位**：从上游 `context_config` 解析模型**声明的**档位
  （`contextTiers`），用户按档选择；预算只在该档位确实被声明时生效，否则回落
  原生值（`applyContextBudgets`）——不发明一个上游不认的值。

---

## 六、从 workbuddy 继承的「已修缺陷」教训（重点）

这三条是同一个形状的问题：**上游的声明字段不可全信**。解法也相同：按**精确
model id** 键控的人工核对表 + 只在有依据时才给默认值，其余留 `unknown`（宁可
少给，也不要每次都失败/撒谎）。

### 6.1 平台标记 ≠ 模型原生能力（`native-modality.ts`）

上游目录的 `supportsImages`（Qoder 的 `is_vl`）是**平台**的图片输入声明，不是
**模型**的原生能力，且它对几乎每个模型都是 `true`。直接采信等于让一个上游字段
替本插件下能力结论——它在某个模型上猜错时，用户按下去请求必失败。所以本插件不
拿它当答案，只认一张按**精确 model id** 键控的核对表，表外一律 `unknown`
（不预勾选）。

**这张表本身也被上游打脸过，这才是本节真正的教训。** 旧表按厂商命名推断，把
`kimi-k2.7-code` 标成 `text`，并断言 DeepSeek-V4-Pro / GLM-5.2 是纯文本。
2026-10-29 实测（发一张画着数字 `7` 的 PNG，问「图片里是哪一个数字」——读不到
图的模型答不出 7）：**两区域目录并集里的 14 个模型全部答对**，包括上述几条。
所以当前目录里**没有**纯文本模型，旧结论是从名字推的、没有实测支撑。

于是登记依据改为**厂商文档 + 真机实测**，主键换成**内部短 id**：显示名会随
模型迭代改名（`Qwen3.7-Max` → `Qwen3.8-Max` 真实发生过），旧表四个 `qwen3.x`
键因此全部失配——按短 id 键控才不会在上游改名时悄悄失效，厂商名保留为别名键。

解法不变：`NATIVE_MODALITY_BY_MODEL_ID` + `imageDefaultFor`（只有确认
`multimodal` 才预勾选；`supportsImages:false` 仍可否决），**不虚构**条目。
**与 workbuddy 的差异**：对方面向已核对过的数据源，本项目没有同等来源，于是用
真机实测自建依据——但结论必须是**测出来的**，不是从模型名字推出来的。

**同轮的另一条教训**：`mmodel` 起初在这轮实测里每次都失败，症状正是「纯文本
模型」；追下去真因是上游投递 `body: "null"` 空帧把 `parseStreamDelta` 打成
TypeError。**「测出来失败」要先排除「是我们的代码在失败」**，否则一个解析崩溃
会被登记成一条模型能力事实，而错误的事实比 unknown 更糟。

### 6.2 声明「可关闭思考」≠ 真的能关（`off-thinking.ts`）

workbuddy 实测：声明可关闭的模型里有一部分对 `reasoning_effort:"off"` 回 400，
且错误体不点名参数。由于该档位写进运行时描述符，失败会在**此后每一次请求**上
重演，用户读到的是「这个模型坏了」。

解法：`REFUSES_OFF_MODEL_IDS` + `offDefaultFor` + `defaultOffModelIds`（首读种子）
+ `withEffectiveOff`（把用户选择盖印到运行时目录）。**差异**：本项目暂无实测拒绝
样本，故拒绝集**留空而非虚构**——默认行为等同 0.1.0（不倒退），一旦实测到只需
加一行即可开始隐藏。代价不对称是这里的取舍依据：提供一个必然失败的档位，代价是
用户该模型的每一次请求；藏起一个本可用的档位，代价只是一个选项。

### 6.3 图片勾选必须独立持久（`imageModelKeys`）

workbuddy 用独立的 `imageModelIds`；本项目早期把图片勾选**耦合进** `lastCatalog`
快照，目录一被重写就可能连带改变某个模型的图像答案。现改为独立集合
（`regions.<region>.imageModelKeys`），运行时只从它派生图像能力。

---

## 七、安全

- **PAT 不出进程**：pi-ai 只与本地 shim 对话；shim 用 cosy 会话做上游请求。
- **shim 入站校验**：先查 Host / Origin（仅接受 `127.0.0.1`）/ Content-Type，
  再做 `timingSafeEqual` bearer 比对；body 有大小上限。
- **脱敏**：任何上游文本在落盘/回传前经 `redactUpstreamText`
  （`key=secret` 保留键名抹值；裸 `pt-` token 整段替换）。
- **vault 权限**：`0600`（目录 `0700`），写入走原子替换 + 文件锁。
- **不读桌面端登录文件**：与 workbuddy 不同，本插件不接触、不修改 Qoder 桌面端
  的任何本地凭据。

---

## 八、源头与致谢

- 外观与工程骨架：[`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT）—— 各源文件头部均带标注。
- cosy 协议行为参照：[`qoder2api`](https://github.com/Zhengyuuuui/qoder2api) / `QCCG`（其声明为 GPL-3.0）。
  本项目**未复制其源码**，按其文档与运行行为独立实现为 TypeScript。
  合规细节见 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
- 商标：Qoder 名称是厂商商标，此处仅用于标识本插件所连接的服务；插件图标沿用 LaoDing 插件家族通用的 LD 品牌标（与 dsh-connect-trae / dsh-connect-workbuddy 字节一致），不使用厂商商标图形。
