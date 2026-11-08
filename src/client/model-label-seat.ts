/**
 * 模型标签槽要注册几条、每条用什么 key。
 *
 * 为什么这是 RUNTIME 问题而不是常量。`conversation.input.model.label` 由宿主
 * `@deepseek-ai/dsh-client-ui-model-selection` 声明；在它改口之前是 `single`，
 * 只有一格：
 *
 *   - `single`：所有注册共用 `undefined` 这一格，`entriesOfSlot` 按格去重后只剩
 *     优先级最小的第一条，其余**永远轮不到**，且任何 verbosity 下都没有日志。
 *   - `keyed`：每个 `options.key` 自成一格，N 条注册各占一格，优先级不再决定
 *     「谁可见」。
 *
 * 选择器是**逐行**派发的（owner props `{ provider, model, placement, selected }`），
 * 所以以 `provider.id` 为 key 的一格，正好是「这一行的装饰」。本插件有两个
 * provider id（`qoder` / `qoder-global`），于是 keyed 下就是两条注册。
 *
 * ⚠️ **改声明不够，宿主还必须传 `entryKey`。** 这是复核 `ui-model-selection@0.2.2-rc.1`
 * 实机产物时发现的：渲染该槽只有一个调用点，第三个参数只有 `fallback`、**没有
 * `entryKey`**。渲染器的 keyed 分支是
 * `find(e => e.options.key === opts?.entryKey)`，`opts.entryKey` 为 `undefined` 时
 * 匹配不到任何以 provider id 为 key 的条目，于是**每一行**都渲染 `opts.fallback`。
 * 插件侧注册成功、回调也跑了、无异常无日志，只是组件再也不会被调用。
 * 所以上游的最小改动是**两处**：声明改成 `keyed`，且调用点补
 * `{ entryKey: provider.id }`。只改声明会让全族标签一起静默消失。
 *
 * 为什么一个构建要同时带两种形状。插件无法知道跑在哪条宿主上，而两个方向
 * 都会**在页面上静默**失败（调用处的 catch 确实会打一行 console.error，但那是
 * 排查者的线索，不是用户的线索）：
 *
 *   - keyed 的两条打到 `single` 宿主上：第二条抛
 *     `single slot … already has a registration at priority …`，第一条已经落地，
 *     于是「半注册」——页面上看不出异常。
 *   - 无 key 的一条打到 `keyed` 宿主上：抛 `keyed slot … requires options.key`，
 *     标签直接消失。
 *
 * 所以运行时读 `ctx.slots.spec(key).kind`（0.1.7 与 0.2.2 都有这个公开访问器），
 * 再由它推导席位表。一个构建同时服务两条宿主，宿主改口那天不用重新发版。
 *
 * 优先级保留的理由。keyed 下 priority 不再决定可见性，但它仍是**同一格内**的
 * 裁决者：两个插件抢同一个 provider id、同优先级会抛，不同优先级取最小。
 * 于是 `-101` 从「军备竞赛的名次」变成「自己那两格的排序」，与 workbuddy、trae
 * 不再互相压制——这正是停战的实际含义。
 */

/** 宿主可能声明的槽位 kind。 */
export type ModelLabelSeatKind = 'single' | 'list' | 'keyed' | 'chain'

/** 一条 `register()` 的选项。 */
export interface ModelLabelSeat {
  name: string
  /** 恒存在：席位表由同一个配置的优先级生成。 */
  priority: number
  /** 只在 keyed 席位上出现；每个 key 是一格。 */
  key?: string
}

/**
 * 读一个槽**实际声明**的 kind；读不出来返回 `undefined`。
 *
 * `spec()` 是文档化的只读访问器（`SlotRegistry.spec`），0.1.7 与 0.2.2 都有。
 * 也是唯一能知道 kind 的途径：声明写在宿主包里，插件自己的 `SlotMap` 增强只
 * 说明本插件**希望**槽是什么，不代表运行中的宿主声明了什么。
 *
 * 任何异常——老宿主没有 `spec`、服务未就绪抛错、出现本构建不认识的 kind——
 * 都返回 `undefined`，调用方落回单格形状。那是保守方向：每个已发布版本本来就是
 * 这么注册的。
 *
 * @param slots - `slots` 服务（类型放宽：访问器是可选的）。
 * @param key - 要检查的槽位 key。
 * @returns 声明出来的 kind，或 `undefined`。
 */
export function declaredSlotKind(slots: unknown, key: string): ModelLabelSeatKind | undefined {
  const face = slots as { spec?: (slotKey: string) => { kind?: unknown } | undefined } | undefined
  if (face === undefined || typeof face.spec !== 'function') return undefined
  let spec: { kind?: unknown } | undefined
  try {
    spec = face.spec(key)
  } catch {
    // 访问器抛错 = 服务未就绪或不是这条线的形状。诚实的答案是不确定，不是猜。
    return undefined
  }
  const kind = spec?.kind
  if (kind === 'single' || kind === 'list' || kind === 'keyed' || kind === 'chain') return kind
  return undefined
}

/**
 * 本插件应该为模型标签槽注册的席位。
 *
 * `keyed` 下每个 provider id 一条：各自一格，各自只画属于那个 provider 的行；
 * 本插件不负责的 provider 落到宿主的 fallback（目录名 + 该模型自带的 badge）。
 *
 * 其余情况——包括 `undefined`（宿主无法被检视）——都是历史上那一条。那不是降级：
 * 那是 `single` 要求的形状，也是 inject 回调即将面对的未声明状态下的形状。
 *
 * keyed 但 provider 列表为空会一条都不注册（标签静默消失，三种失败里最坏的一种），
 * 所以退回单条：形状不对但画得出东西，胜于形状正确但什么都不画。
 *
 * @param params - 槽位 key、声明的 kind、本插件的 provider ids、优先级。
 * @returns 一个或多个 `register()` 选项，按注册顺序。
 */
export function modelLabelSeats(params: {
  name: string
  kind: ModelLabelSeatKind | undefined
  providerIds: readonly string[]
  priority: number
}): ModelLabelSeat[] {
  const { name, kind, providerIds, priority } = params
  // `list` 与 `chain` 不是 `single`：它们的 `register()` 要求本函数并不提供的选项
  // （`list` 要 `options.id`，`chain` 要 `options.select`），所以下面那条单条兜底
  // 会被**拒绝**——一份注册不了的计划比没有计划更糟，因为它看起来像尝试过。
  // 返回空表才是诚实的答案：本插件在这两种契约里没有座位。要服务它们得换设计
  // （按 id 过滤，或用 selector 选举），不是换个形状。
  if (kind === 'list' || kind === 'chain') return []
  if (kind === 'keyed' && providerIds.length > 0) {
    // 每个 key 同优先级：priority 是**格内**的裁决，这些格全属于本插件，
    // 没有可排的东西。
    return providerIds.map(id => ({ name, key: id, priority }))
  }
  return [{ name, priority }]
}

/**
 * Claim every planned seat, atomically, and hand back ONE disposer.
 *
 * WHY ATOMIC. The seat list is 2-3 entries on a `keyed` host, and `register()`
 * can throw on any ONE of them — a rival plugin claiming the same provider id at
 * the same priority, or the declaration collapsing mid-loop. A plain `.map()`
 * would then leave the earlier seats landed on the ledger with their disposers
 * unreachable (they were only ever held by the array that the throw discarded),
 * which is worse than failing outright: the component stays mounted, the caller
 * believes registration failed, and nothing will ever release those cells. On a
 * `single` host it also means the identity keeps a live entry that the next
 * `inject` re-run cannot displace without a priority clash.
 *
 * So a partial failure is rolled back in reverse order before the error is
 * rethrown, exactly as if it had never been attempted. The rethrow is important:
 * each caller already has a catch that logs, and swallowing here would hide the
 * refusal from the diagnostics that exist to explain it.
 *
 * A disposal that itself throws must not mask the original error, hence the
 * inner catch — the registry treats a second dispose as a no-op, and a broken
 * one must not turn one failure into a crash.
 *
 * @param seats - The plan from {@link modelLabelSeats}, in registration order.
 * @param register - Claims one seat and returns its disposer.
 * @returns One disposer that releases every seat, in reverse registration order.
 */
export function registerModelLabelSeats(
  seats: readonly ModelLabelSeat[],
  register: (seat: ModelLabelSeat) => () => void,
): () => void {
  const claimed: (() => void)[] = []
  try {
    for (const seat of seats) claimed.push(register(seat))
  } catch (error: unknown) {
    for (const dispose of [...claimed].reverse()) {
      try { dispose() } catch { /* already disposed by the slot service */ }
    }
    throw error
  }
  return () => {
    for (const dispose of [...claimed].reverse()) {
      try { dispose() } catch { /* already disposed by the slot service */ }
    }
  }
}
