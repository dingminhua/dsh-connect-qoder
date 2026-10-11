/**
 * 哪些模型**真的**能关掉思考。
 *
 * 上游目录里 `thinking_config.disabled` 的有无被当成「可关闭思考」的声明，
 * 而 workbuddy 项目实测发现这类声明会**说错**：声明可关闭的模型里有一部分
 * 对 `reasoning_effort: "off"` 直接回 HTTP 400，且错误体不点名是哪个参数
 * （`extError.param` 为空）。由于该档位是被保存进「每模型选择」的，失败会在
 * **此后每一次请求**上重演，用户看到的不是「这个设置不对」，而是「这个模型
 * 坏了」。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 该项目 `off-thinking.ts` 正是为此而写：一张按**精确 model id** 键控的
 *   人工核对表（`REFUSES_OFF_MODEL_IDS`）+ `offDefaultFor` / `defaultOffModelIds`
 *   / `withEffectiveOff`。本插件照搬这套机制与「宁可少给一档、也不要每请求都
 *   失败」的不对称取舍。
 *
 * 与 workbuddy 的差异（重要）：对方面向 WorkBuddy 网关，有一份实测清单；
 * 本插件面向 Qoder 网关，**没有**同等实测数据，因此这里**不虚构**拒绝清单，
 * 改为「默认只对上游明确声明可关闭、且未列入已知拒绝集的模型提供 off」。
 * 空的拒绝集意味着默认行为仍由上游声明决定，但一旦实测到某个 id 拒绝，只需
 * 往 {@link REFUSES_OFF_MODEL_IDS} 里加一行即可开始隐藏，无需改逻辑。
 *
 * @module dsh-connect-qoder/off-thinking
 */

import type { QoderModelInfo } from './catalog.ts'

/**
 * 已观察到**拒绝** `reasoning_effort: "off"`（HTTP 400）的模型 id，
 * 即使它们声明了「可关闭思考」。
 *
 * 按精确 model id 键控，且刻意**不**按区域分：拒绝与否跟模型家族走，不跟网关走。
 * 代价是不对称的——提供一个必然失败的档位，代价是用户该模型的**每一次**请求；
 * 而藏起一个本可用的档位，代价只是少一个选项——所以本表宁可多藏。
 * 知道得更清楚的用户可以显式覆盖（见 {@link effectiveOff}）。
 *
 * 现状为空：本项目尚未在 Qoder 网关上实测到拒绝样本。留空即「只信上游声明」，
 * 这与本插件 0.1.0 的行为一致，属于**不倒退**的默认；一旦有实测样本，按上面的
 * 键控规则补条目即可。
 */
export const REFUSES_OFF_MODEL_IDS: ReadonlySet<string> = new Set<string>([])

/** 这条规则只需要模型自报的两个字段。 */
export interface QoderOffCapability {
  key: string
  supportsThinking: boolean
  canDisableThinking: boolean
}

/**
 * 在用户没有表态时，是否应当为某模型提供 `off` 档：上游声明减去已知拒绝的 id。
 *
 * 只有上游**显式**声明可关闭（`canDisableThinking === true`）才开启该档；
 * 缺失视为「未知」，保持不提供——与本插件对其它未声明能力的一贯处理一致。
 */
export function offDefaultFor(info: QoderOffCapability): boolean {
  return info.canDisableThinking === true && !REFUSES_OFF_MODEL_IDS.has(info.key)
}

/**
 * 默认应当提供 `off` 档的模型 id 集合。
 *
 * 用户的勾选框是一个普通集合：勾上=提供，取消=撤回。这里是**种子**——集合
 * 第一次被读取时填入的内容——让从未保存过的 profile 立刻显示正确默认值，
 * 而不必先保存一次。
 */
export function defaultOffModelIds(models: readonly QoderOffCapability[]): string[] {
  return models.filter(offDefaultFor).map(model => model.key)
}

/**
 * 把用户保存的 `off` 选择**盖印**到模型列表上，供**运行时**目录使用。
 *
 * 运行时描述符由适配器的 `qoderThinkingLevelMap` 构建，它只读模型自报的声明；
 * 因此校正后的答案必须在模型抵达适配器之前写到模型上。放在这里可以让适配器
 * 保持「声明进、档位表出」的纯函数，也让这张表紧挨着它所服务的规则。
 *
 * 这里**覆盖**声明字段而不是新增兄弟字段：该声明只有这一个消费者（同一张档位
 * 表），且从不被持久化到卡片能看到的地方（`toWebModel` 会丢掉
 * `canDisableThinking`，卡片的 `lastCatalog` 来自上游原始发现，而非这份盖印
 * 结果）。未声明推理的模型原样返回——没有档位需要校正。
 */
export function withEffectiveOff<T extends QoderOffCapability>(
  models: readonly T[],
  selection: ReadonlySet<string>,
): T[] {
  return models.map(model => {
    if (model.supportsThinking !== true) return model
    return { ...model, canDisableThinking: selection.has(model.key) } as T
  })
}

/** 便捷投影：把目录条目转成本模块需要的两个字段。 */
export function offCapabilityOf(info: QoderModelInfo): QoderOffCapability {
  return { key: info.key, supportsThinking: info.supportsThinking, canDisableThinking: info.canDisableThinking }
}
