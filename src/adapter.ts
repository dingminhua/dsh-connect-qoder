/**
 * The Qoder pi-ai providers: loopback-backed adapters registered into the
 * Harness LLM seam, assembled from public `dsh-llm-pi-ai` extension points.
 * One instance per region — `qoder` for the CN gateway, `qoder-global` for
 * the international one — each pointing at its own shim and catalog so the
 * two regions serve simultaneously.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）——
 * pi-ai provider 的装配（createProvider + openAICompletionsApi + inert auth
 * plane + 用 shim 的进程内 secret 当 apiKey）与 profile 组装沿用其做法。
 *
 * @module dsh-connect-qoder/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, Context, CredentialStore, Message, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy, type RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId, type LlmModelInfo, type LlmResolvedModelInfo, type PreparedAdapterCall } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { QoderShim } from './shim.ts'
import { modelDisplayName } from './catalog.ts'
import type { QoderCatalog, QoderModelInfo } from './catalog.ts'
import { defaultEffortFor } from './default-effort.ts'
import { modelBadgeOf } from './model-badge.ts'
import type { QoderModelBadge } from './model-badge.ts'
import type { QoderRegion } from './upstream.ts'
import { piAiRuntimeInfo } from './pi-ai-runtime.ts'
import type { PiAiGeneration } from './pi-ai-runtime.ts'

/** Provider route this bundle owns for the domestic (CN) gateway. */
export const QODER_PROVIDER = 'qoder'

/** Provider route this bundle owns for the international gateway. */
export const QODER_GLOBAL_PROVIDER = 'qoder-global'

/** The provider id each region registers as. */
export const QODER_PROVIDERS: Readonly<Record<QoderRegion, string>> = {
  cn: QODER_PROVIDER,
  global: QODER_GLOBAL_PROVIDER,
}

/** Region a provider route id belongs to. */
export function regionOfProvider(provider: string): QoderRegion | undefined {
  for (const [region, id] of Object.entries(QODER_PROVIDERS) as [QoderRegion, string][]) {
    if (id === provider) return region
  }
  return undefined
}

/** Human-readable provider name, shown in the DSH model picker. */
export const QODER_PROVIDER_DISPLAY_NAMES: Readonly<Record<QoderRegion, string>> = {
  cn: 'Qoder',
  global: 'Qoder Global',
}

/** Provider idle ceiling while one stream read is outstanding. */
export const QODER_STREAM_IDLE_TIMEOUT_MS = 300_000

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * Image-request budgets at the dsh-llm-pi-ai defaults.
 *
 * `maxRequestImages` / `imageOffloadCountQuantum` joined this set in host
 * 0.2.2-rc.1: a request carrying more retained image occurrences than the bound
 * fails with `IMAGE_OFFLOAD_REQUIRED`, naming how many of the oldest to offload.
 * They are **required** on `ResolvedPiAiProviderProfile` because this plugin
 * assembles that profile by hand instead of going through `resolveProfile` —
 * so the host's `?? 50` / `?? min(10, maxRequestImages)` defaulting never runs
 * for us. Omitting them does not throw: it silently leaves the Qoder route
 * without a count bound while every host-owned route has one.
 *
 * 50 is the Azure OpenAI limit the host aligned to; `10` is the host's default
 * offload step (rewrites the request prefix once per ten new images rather than
 * once per image). Raise the bound only against a measured gateway limit.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
  maxRequestImages: 50,
  imageOffloadCountQuantum: 10,
} as const

/** Inert pi-ai auth plane: the route authenticates only through the shim secret. */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {},
  },
  authContext: {},
} as unknown as { credentials: CredentialStore; authContext: AuthContext }

export interface QoderAdapterOptions {
  shim: QoderShim
  catalog: QoderCatalog
  provider?: string
  displayName?: string
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Override the pi-ai generation gate (see {@link piAiRuntimeInfo}); tests
   * inject both branches because this checkout only ever RESOLVES one of
   * them. Production callers leave it unset.
   */
  piAiGeneration?: PiAiGeneration
  /**
   * 该区域的重试预算（issue #24）。缺席 = 宿主默认。
   *
   * 由 `resolveRetryPolicy` 校验并冻结：本插件**不自己**校验范围，把宿主的
   * 报错原样交给调用方（它的文案已经写明哪个字段越界）。
   */
  retryPolicy?: RetryPolicyConfig | undefined
  /** 与 `retryPolicy` 配套的诊断路径（报错时指名字段所属）。 */
  retryPolicyPath?: string
  /**
   * 用户为每个模型保存的**默认**思考强度（模型 key → 档位名）。
   *
   * 一个**取值器**，不是捕获下来的快照：这是用户随时能改的设置，捕获一份会让
   * 改动直到重载才生效。生产读的是活的区域槽；测试传字面量。
   *
   * 缺席的键 = 「跟随上游声明的默认档」—— 见 `src/default-effort.ts`。
   */
  defaultThinkingEfforts?: () => Readonly<Record<string, string | undefined>>
}

/**
 * 一个随目录自动保鲜的 `configuredMaxTokens` 表（issue #35）。
 *
 * 宿主 `dsh-llm-pi-ai` 的 `modelInfo()` 这样取值：
 *
 *     const configuredMaxTokens = profile.configuredMaxTokens.get(model)
 *     ...configuredMaxTokens === void 0 ? {} : { defaultMaxTokens: configuredMaxTokens }
 *
 * **命中才返回**。此前往里塞 `new Map()`，于是 `defaultMaxTokens` 对本插件的
 * 每个模型恒为 `undefined`，三个下游一起落空：billion-context 的输出上限（两个
 * 上报通道都读这个字段）、DSH 实际下发的 `max_tokens`、压缩预留。
 *
 * 三个实现要点，都是报告人实测点出来的：
 *
 * 1. **键是 pi model id**（`toPiModel().id`，也就是 `info.key`），不是
 *    `displayName`。宿主 `get(model)` 收到的是前者；用显示名做键会得到一张
 *    「看着有内容、但永远命中不了」的表，与空表等价。
 * 2. **用数组身份判失效**：目录被 `catalog.set(deriveCatalog(...))` **整体替换**，
 *    而 `set()` 只在非空时替换，所以数组身份是可靠信号。不这样做的话，用户点
 *    「从 Qoder 刷新」之后宿主读到的仍是装配时那一份 —— 也就是这个 issue 的
 *    另一半。
 * 3. **懒填 + 缓存**：命中一次之后走原生 `Map.get`，不再每次重算整张表。
 *
 * `maxOutputTokens` 不是正数的模型**不写进表**：`defaultMaxTokens: 0` 会被
 * 下游当成「上限就是 0」，而缺席（`undefined`）才是诚实的「不知道」。
 *
 * 继承 `Map` 而不是返回普通对象：宿主的类型是 `Map<string, number>`，且它自己
 * 也可能会 `set()`（我们缓存到 `super.set` 之后两者互不干扰）。
 */
function liveMaxTokens(catalog: QoderCatalog, baseUrl: () => string, providerId: string): Map<string, number> {
  /** 上次算表时看到的那份目录（**数组身份**，见上面第 2 点）。 */
  let seen: readonly unknown[] | undefined
  /** 那次算出来的表。 */
  let fresh = new Map<string, number>()
  /** 目录换了几代。缓存要跟着它一起失效。 */
  let generation = 0
  /** 缓存属于哪一代；`-1` 表示还没建立。 */
  let cachedGeneration = -1

  const table = (): Map<string, number> => {
    const models = catalog.current()
    if (models !== seen) {
      seen = models
      generation += 1
      fresh = new Map()
      for (const info of models) {
        const pi = toPiModel(info, baseUrl(), providerId)
        if (typeof pi.maxTokens === 'number' && pi.maxTokens > 0) fresh.set(pi.id, pi.maxTokens)
      }
    }
    return fresh
  }

  // 命中值缓存到原生 Map，但**目录换代就必须整个丢掉**。
  //
  // 第一版直接把命中值 `super.set()` 之后就返回，目录换掉时旧键仍然命中那份陈旧
  // 缓存 —— 用户点「从 Qoder 刷新」看到旧上限。`tests/adapter.spec.ts` 的
  // 「目录刷新后新值生效」当场抓到了它。
  return new (class extends Map<string, number> {
    override get(key: string): number | undefined {
      const current = table()
      if (generation !== cachedGeneration) {
        super.clear()
        cachedGeneration = generation
      }
      const own = super.get(key)
      if (own !== undefined) return own
      const value = current.get(key)
      if (value !== undefined) super.set(key, value)
      return value
    }
  })()
}

export interface QoderAdapter {
  adapter: PiAiAdapter
  invalidate: () => void
  /** Which pi-ai generation this checkout resolved (diagnostic for `bin doctor`). */
  piAiGeneration: PiAiGeneration
}

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type QoderThinkingLevel = typeof THINKING_LEVELS[number]
type QoderThinkingLevelMap = Partial<Record<'off' | QoderThinkingLevel, string | null>>

/** pi-ai input modalities: images only when Qoder advertises them. */
export function qoderModelInput(info: QoderModelInfo): ('text' | 'image')[] {
  return info.supportsImages === true ? ['text', 'image'] : ['text']
}

/**
 * The DSH-facing thinking level map for one Qoder model.
 *
 * **只映射上游真正声明的档位**（workbuddy 的 `workBuddyThinkingLevelMap` 同规）。
 * Qoder 的 `thinking_config.enabled.efforts` 会逐模型声明档位，且**不统一**：
 * Qwen 系是 `xhigh / low / medium`，DeepSeek/GLM 系是 `high / low / max`。
 * 把六个 DSH 档位全部置 null 会让 DSH 的模型设置里出现一排「可选但无效」的
 * 档位 —— 用户选了也不起作用。正确做法是：声明了的档位映射到**同名**的真实档位，
 * 没声明的映射为 `null`（DSH 据此不提供该档）。
 *
 * 上游声明可以关闭思考时额外提供 `off`；不能关闭则 `off` 映射为 null（DSH
 * 不提供「关闭」）。非推理模型没有 map。
 *
 * 注意：这与「请求线怎么带档位」是两件事 —— shim 侧按
 * `reasoningEffort` + `parameters.reasoning_effort` 发送（见 shim.ts）。
 */
export function qoderThinkingLevelMap(info: QoderModelInfo): QoderThinkingLevelMap | undefined {
  if (!info.supportsThinking) return undefined
  const declared = info.thinkingEfforts ?? []
  const supported = THINKING_LEVELS.filter(level =>
    (declared as readonly string[]).includes(level))
  // **必须至少有一个真实档位，否则不能返回 map。**
  //
  // DSH 内核（dsh-llm）对推理元数据是硬校验的：
  //   - `if (reasoning.efforts.length === 0) throw INVALID_MODEL_REASONING`
  //   - dsh-llm-pi-ai 的 `getSupportedThinkingLevels()` 把
  //     `thinkingLevelMap[level] === null` 判为不支持，于是「全 null 的 map」
  //     解析出**零个**档位。
  // 一旦某个模型那样，**整条 provider 路由作废** —— 用户在 DSH 里看到的是
  // 「Provider is not configured: <provider>」，而不是「这个模型没有档位」。
  // 实测：`auto` 与 `qmodel_latest` 上游不声明 efforts，正是这样把 qoder 整条
  // 路由打掉的（用户实拍）。
  //
  // 所以上游没声明档位时返回 `undefined`：DSH 把它读作「这个模型不提供推理」，
  // 于是不渲染档位选择器（正确的降级），而路由保持健康。
  if (supported.length === 0) return undefined
  const map: QoderThinkingLevelMap = {}
  for (const level of THINKING_LEVELS) map[level] = supported.includes(level) ? level : null
  if (info.canDisableThinking === true) map.off = 'off'
  return map
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(
  info: QoderModelInfo,
  baseUrl: string,
  providerId: string,
): Model<Api> {
  const thinkingLevelMap = qoderThinkingLevelMap(info)
  return {
    id: info.key,
    // DSH 面的显示名 = 模型名 + 上游倍率（workbuddy 的 workBuddyDisplayName 同规，
    // 也就是 `GLM-5.3 · x0.79` 那种写法）。用户实拍「没有倍数显示」指的就是这里：
    // 卡片自己的选择器早就会把倍率画在名字旁边，但 **DSH 内置的模型选择器**读的是
    // 这一行 —— 它此前只拿到裸名字，于是同一个模型在两处显示得不一样。
    // 纯显示用途：DSH 侧所有关联都按模型 id 做（选择器的当前项、会话事件、
    // agent 默认模型设置、请求线上的 `model: <id>`），改名不会影响任何一处。
    name: modelDisplayName(info),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: qoderModelInput(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxOutputTokens,
    reasoning: thinkingLevelMap !== undefined,
    ...thinkingLevelMap === undefined ? {} : { thinkingLevelMap },
    // `supportsDeveloperRole: false` 是**必须**的，不是保守起见。
    //
    // pi-ai 的 openai-completions API 这样决定系统提示词的角色：
    //     const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole
    //     const role = useDeveloperRole ? 'developer' : 'system'
    // Qoder 上游只接受 `system` / `assistant` / `user` / `tool` / `function`，
    // 收到 `developer` 会直接 400：
    //     "developer is not one of ['system', 'assistant', 'user', 'tool', 'function']"
    // （用户实拍）。
    //
    // 这个分支只在**同时**满足「reasoning 为真」与「compat 未显式关闭」时才走。
    // 我此前让档位真正生效（reasoning 从 false 变 true）恰好把第一个条件打开了，
    // 于是第二个条件默认值（开启）开始起作用 —— 两个改动叠加才暴露出来。
    compat: {
      supportsReasoningEffort: thinkingLevelMap !== undefined,
      supportsDeveloperRole: false,
      // 0.2.2-rc.1 起宿主开始**真的**读这个能力：为 false 时，对话中途的
      // system 文本会被包成 user 角色的 `<system-reminder>`（闭合标签转义），
      // 而不是以 system 角色直发。0.2.1 是无论能力如何都按 system 发。
      //
      // 这里**显式写 false**，把「跟随宿主默认」变成一条写下来的决定：
      // Qoder 网关已知只收 `system/assistant/user/tool/function`（连
      // `developer` 都会 400，见上面 supportsDeveloperRole），中途插系统角色
      // 没有实测过，因此保守取「改写成 reminder」这一侧 —— 它在两种上游语义
      // 下都读得通。若哪天实测网关接受中途 system，把它改成 true 即可。
      supportsMidConvoSystemMessages: false,
    },
  } as unknown as Model<Api>
}

/**
 * 把**逐模型**的默认档位报给宿主的适配器；顺带把促销胶囊挂进模型目录。
 *
 * ## 为什么需要默认档（第一件事）
 *
 * 宿主把 `reasoning.defaultEffort` **物化进每一个没指名档位的请求**
 * （`LlmRuntime.resolveCallWithInfo`），而 DSH 的模型选择器也从同一份元数据取
 * 「当前档位」与选项表（`ui-model-selection` 的 `catalog.reasoningFor`）。默认档
 * 缺席时，用户看到的就是 **Default** —— 即使上游明明声明了默认档（卡片那一行
 * 写着的「medium（上游默认）」）。
 *
 * 用户的原话正是这一句：「这里既然有默认设置选择的思考强度，选择的时候就应该
 * 直接进入到这个对应的默认设置，而不是跳动到 default」。
 *
 * ## 为什么不能靠 `profile.reasoning`
 *
 * `profile.reasoning` 是**路由级**的一个常量，而 Qoder 的档位是**逐模型**的：
 * Qwen 系 `low/medium/xhigh`，DeepSeek/GLM 系 `low/high/max`。一条常量配不上一份
 * 花名册 —— 用它当默认，要么对某些模型报出一个它**没声明**的档位（宿主会以
 * `UNSUPPORTED_REASONING_EFFORT` 拒掉整个请求），要么对另一些模型报出一个它声明
 * 了却不是上游默认的档位。逐模型的答案只能逐模型给。
 *
 * ## 改哪两处
 *
 * `resolveModel` 与 `prepareCall` 都返回模型元数据，而 `prepareCall` 返回的那份
 * 才是**真正**随请求走的那份（`resolveModel` 只服务于目录与选择器）。两处都要
 * 改，否则界面上是 Default、请求里却带着档位（或反过来）。
 *
 * ## 为什么胶囊要在这里挂（第二件事）
 *
 * `LlmModelInfo.badge` 只走**目录**这条路：它是 `listModels()` 的返回值，宿主把它
 * 原样搬运到选择器的 `props.model.badge`。`resolveModel()` 返回的那份**不带**它
 * （宿主的 `normalizeModelInfo` 不复制这个字段），请求与 Session 事件也不带 ——
 * 所以想显示胶囊，只能从 `listModels()` 走，别指望在 `resolveModel()` 里塞。
 *
 * 这也是「同族插件三个各自有胶囊」唯一可行的通道：标签槽是 single 槽，只有一个
 * 占位者渲染所有行，别人只会复现**数据**里的胶囊，不会替我们画。见
 * 同族仓库 dsh-connect-workbuddy 的 `docs/MODEL-LABEL-SPEC.md` 与
 * `src/model-badge.ts`。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 它的 `EffortNormalizingAdapter` 是同一件事（它的 issue #179），
 *   `listModels` 的展开写法与理由也沿用自它。
 */
class DefaultEffortAdapter extends PiAiAdapter {
  /**
   * 一个模型在调用方没指名档位时该用哪一档；`undefined` = 该模型不提供推理。
   *
   * 读的是**活的**目录与**活的**保存表（见 `resolveDefaultEffort`），所以目录
   * 刷新或用户改设置后，下一次解析就是新的答案。
   */
  private readonly defaultEffort: (model: string) => string | undefined

  /**
   * 该模型此刻该挂的选择器胶囊；`undefined` = 不挂。
   *
   * 与 `defaultEffort` 一样是**取值器**而不是快照：胶囊的判定依赖时钟（夜间窗口
   * 会开也会关），而宿主重建目录的时机不由我们决定。每次 `listModels()` 现问一次，
   * 答案就是那一刻的。
   */
  private readonly modelBadge: (model: string) => QoderModelBadge | undefined

  constructor(
    config: ConstructorParameters<typeof PiAiAdapter>[0],
    defaultEffort: (model: string) => string | undefined = () => undefined,
    modelBadge: (model: string) => QoderModelBadge | undefined = () => undefined,
  ) {
    super(config)
    this.defaultEffort = defaultEffort
    this.modelBadge = modelBadge
  }

  /**
   * 目录：宿主 `listModels()` 的答案，给自己那几行各挂一枚胶囊，**别的一个字段
   * 都不动**。
   *
   * 为什么是展开 `{ ...model, ...(badge ? { badge } : {}) }` 而不是在对象字面量里
   * 直写 `badge`：本插件的 peer 范围仍从 `0.1.7-rc.1` 起，那一版的 `LlmModelInfo`
   * 没有这个字段。
   *
   * **实测（2026-11-08：把 `@deepseek-ai/dsh-llm@0.1.7-rc.1` 的类型直接当 paths 映射
   * 编译，不是推断）**：
   *
   * | 写法 | 0.1.7 结果 |
   * | --- | --- |
   * | `return { provider, id, name, badge }`，回调**带** `: LlmModelInfo` 注解 | ❌ `TS2353` |
   * | 同上，回调**不写**注解（就是本文件的形状） | ✅ 通过 —— 无上下文类型则不做多余属性检查 |
   * | `{ ...model, ...(badge ? { badge } : {}) }` | ✅ 通过（有无注解都通过） |
   *
   * 所以这不是硬约束，而是**抗**未来改动：给回调补一个 `: LlmModelInfo` 看起来只是
   * 「让类型更明确」，却会让直写那条路在 0.1.x 上突然编译不过，展开不受影响。
   * 旧宿主会在注册表里把 `badge` 静默丢掉，不报错、不崩 —— 这就是降级。
   *
   * 也没有任何版本探测：字段存在与否是**类型层**的事实，运行时只看得到
   * `undefined`，写了 `if (字段存在)` 也走同一个分支。
   *
   * 同一行里**没有**胶囊时返回的对象与 `super` 给出的逐字段相同（不写
   * `badge: undefined`）—— 宿主对「缺席」与「显式 undefined」的处理一样，但多一个
   * 键会让断言 `toEqual` 的失败信息多一行噪音。**更不能用 `null`**：注册表会在
   * `badge.text` 上抛错，那一整个 provider 会从目录里消失（进 `failures`）。
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await super.listModels(provider)
    return models.map((model) => {
      const badge = this.modelBadge(model.id)
      return { ...model, ...(badge === undefined ? {} : { badge }) }
    })
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return super.resolveModel(provider, model, signal).then(info => this.advertiseDefaultEffort(info))
  }

  override prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return super.prepareCall(provider, model, signal).then(call => ({
      ...call,
      model: this.advertiseDefaultEffort(call.model),
    }))
  }

  /**
   * 把默认档写进模型元数据。
   *
   * **绝不与档位表矛盾**：报一个该模型没有的档位，宿主会以
   * `UNSUPPORTED_REASONING_EFFORT` 拒掉整个请求 —— 那比「显示 Default」糟得多。
   */
  private advertiseDefaultEffort(info: LlmResolvedModelInfo): LlmResolvedModelInfo {
    if (info.reasoning === undefined) return info
    const effort = this.defaultEffort(info.id)
    if (effort === undefined) return info
    if (!info.reasoning.efforts.some(level => level.id === effort)) return info
    if (info.reasoning.defaultEffort === effort) return info
    return {
      ...info,
      reasoning: { ...info.reasoning, defaultEffort: ReasoningEffortId(effort) },
    }
  }
}

/**
 * Rewrite a pi-ai 0.87-shaped transcript into the 0.85 shape this plugin's
 * pi-ai understands — prompt AND tools.
 *
 * WHY THIS EXISTS: pi-ai 0.87's `normalizeContext` moves the system prompt
 * INTO `messages` as `{ role: 'system', content }`, and 0.85's own `Message`
 * union has no `system` variant — its token estimator then throws inside the
 * library. This plugin cannot patch the library, so it must not hand a 0.87
 * transcript to a 0.85 API object.
 *
 * The 0.87 transcript also carries the tool declarations on that leading
 * system message (`toolsAdded`/`toolsRemoved`) — the only place they live —
 * so the fold promotes them too, exactly the merge pi-ai 0.87's own
 * `getCurrentTools` performs, and leaves an existing top-level `tools` array
 * untouched.
 *
 * Unlike the sibling plugin, Qoder needs NO fallback system prompt: the Qoder
 * gateway accepts user-first conversations (there is no "first message must be
 * the system prompt" rule), so a transcript with no system message is passed
 * through as-is. All the 0.87-vs-0.85 shape work above is identical.
 *
 * Deliberately SHAPE-based within the legacy branch, not version-based, and
 * `withLegacyContext` generation-gates which API object consumes the result.
 *
 * LEGACY-ONLY (0.85). This produces the FLAT `{systemPrompt, tools, messages}`
 * shape that ONLY pi-ai 0.85 reads. Never hand its result to a 1.x api — 1.x
 * reads the prompt and tools from `messages[].toolsAdded` and would see none.
 * That is precisely the 0.2.1-rc.1 regression: `generationOf` misclassified
 * the 1.x major version as `legacy`, so this function was applied to a
 * transcript that pi-ai's `createModels` had already normalized, and the
 * request went out with no prompt and no tools. See {@link withLegacyContext}.
 * Type note: the parameter is the 0.85 `Context`, while pi-ai 1.x types the
 * api's second parameter as `TranscriptContext`; calling this with 1.x typings
 * is a TS2353 by design, which is exactly why the modern branch must not touch
 * it.
 */
export function adaptLegacyPiAiContext(context: Context): Context {
  if (context === null || typeof context !== 'object') return context
  if (context.systemPrompt) return context
  const messages = Array.isArray(context.messages) ? context.messages : undefined
  if (messages === undefined) return context

  const systemTexts: string[] = []
  const rest: Message[] = []
  const toolState = new Map<string, NonNullable<Context['tools']>[number]>()
  let sawSystemMessage = false
  for (const message of messages) {
    const role = (message as { role?: unknown } | null)?.role
    if (role !== 'system') {
      rest.push(message)
      continue
    }
    sawSystemMessage = true
    const text = systemTextOf(message)
    if (text !== '') systemTexts.push(text)
    replayToolState(message, toolState)
  }

  if (!sawSystemMessage) return context

  // systemPrompt stays ABSENT rather than '' so a provider never receives an
  // empty system message; an absent prompt is fine on the Qoder gateway.
  const systemPrompt = systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined
  const tools = Array.isArray(context.tools)
    ? undefined
    : [...toolState.values()]

  return {
    ...context,
    ...systemPrompt === undefined ? {} : { systemPrompt },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    messages: rest,
  }
}

/** Replay one 0.87 system message's tool deltas into `state`. */
function replayToolState(message: Message, state: Map<string, NonNullable<Context['tools']>[number]>): void {
  const removed = (message as { toolsRemoved?: unknown }).toolsRemoved
  if (Array.isArray(removed)) {
    for (const tool of removed) {
      const name = (tool as { name?: unknown } | null)?.name
      if (typeof name === 'string') state.delete(name)
    }
  }
  const added = (message as { toolsAdded?: unknown }).toolsAdded
  if (Array.isArray(added)) {
    for (const tool of added) {
      const name = (tool as { name?: unknown } | null)?.name
      if (typeof name === 'string') state.set(name, tool as NonNullable<Context['tools']>[number])
    }
  }
}

/** The text of one system message, whether it is a string or text blocks. */
function systemTextOf(message: Message): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown, text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') texts.push(candidate.text)
  }
  return texts.join('\n\n')
}

/**
 * Wrap one pi-ai API module so both stream entry points receive a context this
 * generation can actually consume.
 *
 * The gate is the plugin's own module, resolved via {@link piAiRuntimeInfo}
 * (manifest version of the copy this plugin resolves — no pi-ai import):
 *
 * - `legacy` (0.85) wants the flat `{systemPrompt, tools, messages}` shape, so
 *   a normalized transcript is UN-folded by {@link adaptLegacyPiAiContext}.
 * - `modern` (0.87+, incl. 1.x) wants the normalized transcript, which is
 *   already what it receives, so the api is passed through UNWRAPPED.
 *
 * WHY `modern` IS A PASS-THROUGH — and the 0.2.1-rc.1 regression this guards.
 * The normalizer that matters lives in pi-ai's **Models layer**
 * (`createModels().stream/streamSimple` → `normalizeContext(context)`), which
 * sits BETWEEN the host and the provider-facing api module. `PiAiAdapter`
 * registers this plugin's provider into that layer, so the api module is
 * handed an ALREADY-normalized transcript. Verified on the installed
 * 0.2.1-rc.1 host (pi-ai 1.x) with a real `createModels` + real
 * `openaiCompletionsApi()`: the api module receives
 * `{messages:[{role:'system',…toolsAdded}]}` and never a top-level
 * `systemPrompt`/`tools`.
 *
 * The 0.2.1-rc.1 regression was therefore NOT "the modern branch is empty". It
 * was {@link generationOf} failing to recognise the 1.x MAJOR version: its
 * `/^0\.(\d+)\./` pattern only matches a leading `0.`, so `1.1.0` / `1.3.0`
 * fell through to `legacy`. The plugin then applied
 * {@link adaptLegacyPiAiContext} — which UN-folds the transcript back into the
 * flat 0.85 shape — and handed that to a 1.x api that reads only
 * `context.messages`. Measured wire result on the real stack:
 *
 *   legacy branch (bug)  → roles ["user"],  system null,       tools 0
 *   modern branch (fix)  → roles ["system","user"], prompt intact, tools 1
 *
 * i.e. NO prompt and NO tools, silently. The fix is in the detector, not here:
 * this branch must stay a pass-through, because folding on top of what
 * `createModels` already normalized would prepend a SECOND (empty) system
 * message.
 */
function withLegacyContext(api: ProviderStreams, generation: PiAiGeneration): ProviderStreams {
  if (generation === 'modern') return api
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, legacyContextOf(context), options),
    streamSimple: (model, context, options) => api.streamSimple(model, legacyContextOf(context), options),
  }
}

/**
 * The context type one api module accepts — `transcript` for a modern host,
 * the flat envelope for a 0.85 one.
 */
type ApiContext = Parameters<ProviderStreams['stream']>[1]

/**
 * Re-shape a context into what the **legacy** (0.85) api module reads.
 *
 * pi-ai 1.3.0 made this a branded `TranscriptContext`:
 * "Only `normalizeContext()` produces this type, so a raw `Context` cannot reach
 * provider code by accident." That brand is correct for the modern path — the
 * api genuinely must not receive a hand-built envelope — but this branch exists
 * precisely to BUILD one, for a 0.85 api that has no such brand and no such
 * normalizer. The two casts below are therefore the generation boundary itself:
 *
 * - into `adaptLegacyPiAiContext`: the branded transcript is un-folded by reading
 *   only its `messages`/`systemPrompt`/`tools` fields;
 * - back out: the rebuilt envelope is what 0.85 consumes.
 *
 * This code is unreachable on a 1.3.0 host — `withLegacyContext` returns the api
 * unwrapped as soon as `generationOf()` reports `modern` — so the assertion can
 * never hand a hand-built envelope to a modern api at runtime.
 */
function legacyContextOf(context: ApiContext): ApiContext {
  return adaptLegacyPiAiContext(context as unknown as Context) as unknown as ApiContext
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 */
export function createQoderAdapter(options: QoderAdapterOptions): QoderAdapter {
  const { shim, catalog } = options
  const providerId = options.provider ?? QODER_PROVIDER
  const providerName = options.displayName ?? QODER_PROVIDER_DISPLAY_NAMES.cn

  const generation = options.piAiGeneration ?? piAiRuntimeInfo()?.generation ?? 'modern'
  const api = withLegacyContext(openAICompletionsApi(), generation)

  const buildModels = (): Model<Api>[] => {
    const baseUrl = `${shim.baseUrl}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl, providerId))
  }

  const base = createProvider({
    id: providerId,
    name: providerName,
    auth: {
      apiKey: {
        name: 'Qoder shim token',
        // **必须返回一个对象，绝不能返回 undefined。**
        //
        // pi-ai 的 `applyAuth` 只做存在性判断：
        //     const resolution = await this.getAuth(...)
        //     if (!resolution) throw new ModelsError('auth',
        //       `Provider is not configured: ${model.provider}`)
        // 返回 `undefined` 等于宣称「这个 provider 根本没配置」—— 用户在 DSH 里
        // 看到的正是那句 `Provider is not configured: qoder`（用户实拍）。
        //
        // 而真实凭据**不从这里来**：本 route 只通过 shim 的进程内 secret 认证，
        // secret 由 `PiAiAdapter` 的 `resolveApiKey` 逐请求提供给 pi-ai（见下方
        // `resolveApiKey: async () => shim.secret`）。所以这里报「没有 key」是
        // 诚实的、也是正确的 —— 只要它是一个对象。
        //
        // 形状对齐 dsh-llm-pi-ai 自己的 `harnessApiKeyAuth()`：即使 credential
        // 缺席也返回 `{ auth: {}, source }`，把是否真的需要 key 交给协议层判断。
        async resolve({ credential }) {
          const apiKey = credential?.key
          return {
            auth: apiKey === undefined || apiKey.length === 0 ? {} : { apiKey },
            source: 'Qoder shim token',
          }
        },
      },
    },
    models: buildModels(),
    api,
  })

  // `getModels` is delegated to a live read: stream dispatch still runs
  // through the constructed provider, while the catalog answer tracks the
  // upstream refresh.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName: providerName,
    streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
    // issue #24：只有用户真的配了（`retryPolicy` 非空）才交给宿主校验；
    // 否则维持原状的 `undefined`（= 宿主默认）。**不要**把三个 0 拼成一个
    // 策略对象传下去 —— 宿主的 `resolveBackoff` 会拒绝 `initialDelayMs: 0`。
    retryPolicy: resolveRetryPolicy(
      options.retryPolicy,
      options.retryPolicyPath ?? 'dsh-connect-qoder retryPolicy',
    ),
    // issue #35：宿主读这个表来定 `defaultMaxTokens`（见 `liveMaxTokens`）。
    // 空 Map = 所有模型都拿不到输出上限，三个下游一起落空。
    configuredMaxTokens: liveMaxTokens(catalog, () => `${shim.baseUrl}/v1`, providerId),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  /**
   * 一个模型在调用方**没指名档位**时该用哪一档。
   *
   * 对着**活的**目录与**活的**保存表解析 —— 答案是这两样东西的函数，而它们都在
   * 会话中途变（用户改了设置、目录刷新了）。任何一边被缓存下来，报上去的默认档
   * 与真正跑的那一档就会分家。
   */
  const resolveDefaultEffort = (model: string): string | undefined => {
    const info = catalog.current().find(entry => entry.key === model)
    if (info === undefined) return undefined
    return defaultEffortFor(info, options.defaultThinkingEfforts?.() ?? {})
  }

  /**
   * 一行目录此刻该挂的胶囊（`src/model-badge.ts` 的全部判定都在那里）。
   *
   * 同样对着**活的**目录：宿主问一次 `listModels()` 就是此刻的答案，而目录会被
   * 整体替换（换号、刷新、勾选变化），捕获一份快照会让胶囊跟着旧目录走到重启。
   *
   * 时钟在**每次**问的时候读：夜间窗口 22:00–08:00 会开也会关，冻结一个时刻等于
   * 让徽标在早上还挂着（`src/promo.ts` 文件头第 3 节「时段怎么算」是同一件事）。
   */
  const resolveModelBadge = (model: string): QoderModelBadge | undefined => {
    const info = catalog.current().find(entry => entry.key === model)
    return modelBadgeOf(info, new Date())
  }

  const adapter = new DefaultEffortAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.secret,
    ...(options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments }),
  }, resolveDefaultEffort, resolveModelBadge)

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
    piAiGeneration: generation,
  }
}