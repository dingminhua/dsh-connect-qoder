/**
 * 一个模型在**调用方没有指名档位**时跑哪一档。
 *
 * ## 为什么需要这个模块
 *
 * 上游的 `model/list` 逐模型声明了档位表（`thinking_config.enabled.efforts`）
 * 与**自己的默认档**（`efforts[x].is_default`）。卡片那一行已经把这件事说清楚了：
 * 「思考强度 medium（上游默认）」。但 DSH 侧的模型选择器显示的是 **Default** ——
 * 因为适配器**没有把上游的默认档报上去**（`reasoning.defaultEffort` 缺席），
 * 宿主于是不知道该用哪一档，只能说「Default」。
 *
 * 用户的要求正是这一句：「这里既然有默认设置选择的思考强度，选择的时候就应该
 * 直接进入到这个对应的默认设置，而不是跳动到 default」。也就是说：**上游声明了
 * 默认档，就该在选择时落在那一档上**。
 *
 * ## 三条缝必须同时对上（缺一，用户看到的仍是 Default）
 *
 * 1. **适配器**要把默认档报给宿主（`LlmResolvedModelInfo.reasoning.defaultEffort`）。
 *    宿主在调用方没指名档位时，会把 `defaultEffort` **物化进每一个请求**
 *    （`LlmRuntime.resolveCallWithInfo`），而 DSH 的模型选择器也正是从这份元数据
 *    取「当前档位」与选项表（`ui-model-selection` 的 `catalog.reasoningFor`）。
 *    不报 ⇒ 选择器显示 Default、请求不带档位。
 * 2. **运行时目录**要认这个默认档，否则请求到了 shim 也无处可取。Qoder 的档位是
 *    **逐模型**的（Qwen 系 `low/medium/xhigh`，DeepSeek/GLM 系 `low/high/max`），
 *    一条路由级的常量配不上一份花名册 —— 这正是宿主那条路由级 `profile.reasoning`
 *    字段存在的理由。
 * 3. **shim** 侧要在「用户没保存过档位」时采用**请求里带下来的那一档**，而不是
 *    只认自己那张保存表。否则适配器报上去的默认档只停在界面上，请求体里仍然没有
 *    档位字段，上游用的还是它自己的默认 —— 界面与实际行为不一致。
 *
 * ## 取值优先级
 *
 * 用户的显式选择 > 上游声明的默认档 > 该模型声明的第一个档位。
 *
 * 用户的显式选择最高：它是一次明确的决定，胜过任何默认值。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 它的 `src/default-effort.ts` 是同一件事的实现（它的 issue #179），本模块
 *   沿用它的形状与理由。
 *
 * @module dsh-connect-qoder/default-effort
 */

/** DSH/pi-ai 认识的档位名。顺序即强度顺序。 */
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * 兜底档位：模型声明了档位表、但上游既没标默认档、用户也没选过时，用它。
 *
 * 它是**首选**兜底，因为 `medium` 是几个模型族唯一都有的中间档（实测 Qwen
 * `low/medium/xhigh`、DeepSeek `low/high/max`、GLM `low/high/max`、Kimi
 * `low/high/max`）。
 *
 * 但它**不是**唯一能兜的：`low/high/max` 这一族没有 `medium`。所以真正的兜底是
 * 「**该模型自己声明的中档**」——按强度排序取中间那一个。取最弱的那一档
 * （`low`）等于默认关掉思考，那不是兜底，那是把默认值调成了最差。
 */
export const QODER_FALLBACK_EFFORT = 'medium' as const

/** 这个模块读的那一小块模型描述。 */
export interface DefaultEffortSource {
  key: string
  /** 上游声明的档位表（已按强度升序）。 */
  thinkingEfforts?: readonly string[] | undefined
  /** 上游标为默认的档位。 */
  defaultThinkingEffort?: string | undefined
}

/**
 * 这个模型**真的**声明了哪些档位（按 DSH 的档位表过滤）。
 *
 * 上游的档位名不统一（`xhigh` / `max` 都在），但它们都是 DSH 认识的六个名字
 * 之一，所以过滤只排掉「上游偶尔冒出来的、不在 DSH 词表里的名字」。
 */
export function declaredEfforts(model: DefaultEffortSource): string[] {
  const declared = model.thinkingEfforts ?? []
  return THINKING_LEVELS.filter(level => (declared as readonly string[]).includes(level))
}

/**
 * 一个模型在调用方没指名档位时该用哪一档。
 *
 * @param model - 模型描述（带上游声明的档位表与默认档）。
 * @param saved - 用户保存的逐模型选择（模型 key → 档位名）。缺席的键 = 没选过。
 * @returns 一个**该模型声明过**的档位名；模型一个档位都没声明时返回 undefined。
 */
export function defaultEffortFor(
  model: DefaultEffortSource,
  saved: Readonly<Record<string, string | undefined>> = {},
): string | undefined {
  const declared = declaredEfforts(model)
  // 一个档位都没有 ⇒ 这个模型不提供推理强度。此时返回 undefined，让调用方按
  // 「不提供推理」处理 —— 编一个档位出来会让宿主报 UNSUPPORTED_REASONING_EFFORT。
  if (declared.length === 0) return undefined

  // 用户显式选过的档位优先（只要它还在该模型当前的档位表里）。
  const asked = saved[model.key]
  if (typeof asked === 'string' && declared.includes(asked)) return asked

  // 上游自己声明的默认档（卡片那一行写的就是它）。
  const upstream = model.defaultThinkingEffort
  if (typeof upstream === 'string' && declared.includes(upstream)) return upstream

  // 兜底：模型声明了档位表却没标默认档。
  //
  // 先试首选兜底 `medium`（几个模型族唯一都有的中间档）；它不在这张表里时
  // （`low/high/max` 那一族就没有它），取**该模型自己声明的中档** —— 按强度排序
  // 的中间那一个。取最弱的那一档（`low`）等于默认关掉思考，那不是兜底。
  if (declared.includes(QODER_FALLBACK_EFFORT)) return QODER_FALLBACK_EFFORT
  return declared[Math.floor((declared.length - 1) / 2)]!
}

/**
 * 卡片该给这个模型列出哪几档。
 *
 * 就是该模型**自己**声明的档位，不做本地化、不跨模型统一：各模型族的词表确实
 * 不同（`low/high/max` 对 `low/medium/xhigh`），合成一条阶梯只会列出选不动的行。
 */
export function selectableEfforts(model: DefaultEffortSource): string[] {
  return declaredEfforts(model)
}
