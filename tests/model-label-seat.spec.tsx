// @vitest-environment jsdom
/**
 * 注册几条、要不要 key —— 这是**宿主的声明**决定的，不是本插件挑的。
 *
 * 背景：`conversation.input.model.label` 由宿主
 * `@deepseek-ai/dsh-client-ui-model-selection` 声明。改口之前它是 `single`：
 * 只有一格，所有注册共用 `undefined` 那格，`entriesOfSlot` 去重后只剩优先级最小
 * 的第一条，其余**永远轮不到**且没有任何日志。这就是三家连接器被迫按 -101 /
 * -102 / -105 互相压价的原因——不是谁写错了，是槽的基数。
 *
 * `keyed` 是这次要对齐的契约：每个 `options.key` 自成一格，owner 逐行派发
 * `{ entryKey: provider.id }`，没人贡献的 provider 落到宿主自己的 fallback。
 *
 * 这份用例要防的失败是**两个方向都静默**（本仓库的 catch 只打一行 console.error）：
 *
 *   - keyed 的两条打到 `single` 宿主：第二条抛
 *     `single slot … already has a registration at priority …`，第一条已落地，
 *     半注册，页面看不出异常；
 *   - 无 key 的一条打到 `keyed` 宿主：抛 `keyed slot … requires options.key`，
 *     标签直接消失。
 *
 * 两条都用**真的** `SlotCore`（`@deepseek-ai/dsh-client-ui-slots`）声明出来跑，
 * 所以约束是宿主的，不是这份用例编的。
 */
import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  declaredSlotKind,
  type ModelLabelSeatKind,
  modelLabelSeats,
  registerModelLabelSeats,
} from '../src/client/model-label-seat.ts'
import { QODER_MODEL_LABEL_PROVIDERS, QODER_MODEL_LABEL_PRIORITY, QODER_MODEL_LABEL_SLOT } from '../src/client/QoderModelLabel.tsx'

const SLOT = QODER_MODEL_LABEL_SLOT

/** 一处可以抢格的地方；只在**类型**上收窄。 */
interface ClaimableSlot {
  register(options: { name: string, priority?: number, key?: string }, component: unknown): () => void
  entries(key: string): readonly { options: { key?: string, priority?: number } }[]
  entriesOfSlot(key: string): readonly { component: unknown, options: { key?: string } }[]
  spec(key: string): { kind?: string } | undefined
}

/**
 * 按 `kind` 声明好模型标签槽的 core。
 *
 * `root` 携带子表：那是**声明**不是抢格，所以不涉及优先级。声明才是 `register()`
 * 校验的依据，也正是这份用例的重点——同一份插件代码在两种契约下必须表现不同，
 * 而差异只来自宿主的声明。
 */
function core(kind: ModelLabelSeatKind): ClaimableSlot {
  const slotCore = new SlotCore()
  ;(slotCore as unknown as {
    register(options: { name: string, children: Record<string, { kind: string, scope: string }> }, component: unknown): void
  }).register({ name: 'root', children: { [SLOT]: { kind, scope: 'session' } } }, () => null)
  return slotCore as unknown as ClaimableSlot
}

/** 按客户端入口的做法补上 `locale`，再注册席位。 */
function claim(slotCore: ClaimableSlot): void {
  const seats = modelLabelSeats({
    name: SLOT,
    kind: declaredSlotKind(slotCore, SLOT),
    providerIds: QODER_MODEL_LABEL_PROVIDERS,
    priority: QODER_MODEL_LABEL_PRIORITY,
  })
  // 组件替身：只认"谁注册进来了"，不渲染。
  for (const seat of seats) slotCore.register({ ...seat, locale: 'qoder' } as never, () => null)
}

describe('declaredSlotKind', () => {
  it('读出宿主实际声明的 kind', () => {
    expect(declaredSlotKind(core('single'), SLOT)).toBe('single')
    expect(declaredSlotKind(core('keyed'), SLOT)).toBe('keyed')
    expect(declaredSlotKind(core('list'), SLOT)).toBe('list')
  })

  it('槽还没声明时返回 undefined，而不是猜一个', () => {
    // inject 回调可能在父座位挂载前就跑。这里猜一次，等于随机挑一种席位形状。
    expect(declaredSlotKind(new SlotCore(), SLOT)).toBeUndefined()
  })

  it('检视不了的时候返回 undefined', () => {
    // 老宿主没有 spec、服务未就绪抛错、出现不认识的 kind —— 三者都必须退回
    // 保守的单格形状，而不是把注册路径整个带崩。
    expect(declaredSlotKind(undefined, SLOT)).toBeUndefined()
    expect(declaredSlotKind({}, SLOT)).toBeUndefined()
    expect(declaredSlotKind({ spec: () => { throw new Error('not ready') } }, SLOT)).toBeUndefined()
    expect(declaredSlotKind({ spec: () => ({ kind: 'something-new' }) }, SLOT)).toBeUndefined()
  })
})

describe('modelLabelSeats', () => {
  it('single 宿主上只要一条，且不带 key', () => {
    const seats = modelLabelSeats({ name: SLOT, kind: 'single', providerIds: QODER_MODEL_LABEL_PROVIDERS, priority: QODER_MODEL_LABEL_PRIORITY })
    expect(seats).toEqual([{ name: SLOT, priority: QODER_MODEL_LABEL_PRIORITY }])
    // 关键：**没有** key。single 宿主上带 key 什么都换不来（条目照样落在共用的
    // undefined 格里），却会招来反方向的 bug。
    expect(seats[0]).not.toHaveProperty('key')
  })

  it('keyed 宿主上每个 provider 一条', () => {
    const seats = modelLabelSeats({ name: SLOT, kind: 'keyed', providerIds: QODER_MODEL_LABEL_PROVIDERS, priority: QODER_MODEL_LABEL_PRIORITY })
    expect(seats.map(seat => seat.key)).toEqual(['qoder', 'qoder-global'])
    expect(seats.every(seat => seat.priority === QODER_MODEL_LABEL_PRIORITY)).toBe(true)
  })

  it('list / chain 上一条都不注册——它们的座位要本插件并不提供的选项', () => {
    // `list` 要 `options.id`、`chain` 要 `options.select`，单条兜底会被注册器
    // **拒绝**。一份注册不了的计划比没有计划更糟：它看起来像尝试过。空表才诚实。
    for (const kind of ['list', 'chain'] as const) {
      expect(modelLabelSeats({ name: SLOT, kind, providerIds: QODER_MODEL_LABEL_PROVIDERS, priority: QODER_MODEL_LABEL_PRIORITY }))
        .toEqual([])
    }
  })

  it('provider 列表为空时退回单条，而不是一条都不注册', () => {
    // keyed 但零条 → 标签静默消失，三种失败里最坏的一种。形状不对但画得出东西，
    // 胜于形状正确但什么都不画。
    expect(modelLabelSeats({ name: SLOT, kind: 'keyed', providerIds: [], priority: QODER_MODEL_LABEL_PRIORITY }))
      .toEqual([{ name: SLOT, priority: QODER_MODEL_LABEL_PRIORITY }])
  })
})

describe('把计划放到真账本上跑', () => {
  it('single 宿主：一条干净落地，且只有一格渲染', () => {
    const slotCore = core('single')
    // 默认优先级上的竞争者——就是让本插件曾经静默输掉的那一幕。
    slotCore.register({ name: SLOT, priority: 0 }, () => 'host')
    expect(() => claim(slotCore)).not.toThrow()
    expect(slotCore.entries(SLOT)).toHaveLength(2)
    // 格子只解析出一个赢家。
    expect(slotCore.entriesOfSlot(SLOT)).toHaveLength(1)
  })

  it('keyed 宿主：两条与宿主的贡献者三方共存，一个都不丢', () => {
    const slotCore = core('keyed')
    slotCore.register({ name: SLOT, priority: 0, key: 'deepseek-official' }, () => 'host')
    expect(() => claim(slotCore)).not.toThrow()
    // 三格三赢家。这正是这次改动的目的：single 下同样的三条会变成一赢两静默丢。
    const cells = slotCore.entriesOfSlot(SLOT)
    expect(cells).toHaveLength(3)
    expect(cells.map(entry => entry.options.key).sort()).toEqual(['deepseek-official', 'qoder', 'qoder-global'])
  })

  it('无 key 的那条会被 keyed 宿主拒绝——这就是要读 kind 的原因', () => {
    // 不是假设：宿主改口那天，每个已发布版本都会撞上它。
    const slotCore = core('keyed')
    expect(() => slotCore.register({ name: SLOT, priority: QODER_MODEL_LABEL_PRIORITY }, () => null))
      .toThrow(/requires options\.key/)
  })

  it('第二条会被 single 宿主拒绝——这就是只注册一条的原因', () => {
    // 反方向：在 single 宿主上按 provider 注册，第一条已落地、第二条抛错。
    const slotCore = core('single')
    const seats = modelLabelSeats({ name: SLOT, kind: 'keyed', providerIds: QODER_MODEL_LABEL_PROVIDERS, priority: QODER_MODEL_LABEL_PRIORITY })
    slotCore.register(seats[0]!, () => null)
    expect(() => slotCore.register(seats[1]!, () => null))
      .toThrow(/already has a registration/)
  })
})

describe('provider 清单就是组件自己认的那份', () => {
  it('与 QODER_COMPOSER_PROVIDERS 的键完全一致', () => {
    // 注册与渲染必须对「哪些行是我的」有同一个答案，否则会出现：为某个 provider
    // 注册了席位，而它的行却走进外来分支（在 keyed 宿主上就是静默退回裸名字）。
    expect([...QODER_MODEL_LABEL_PROVIDERS]).toEqual(['qoder', 'qoder-global'])
  })
})

describe('registerModelLabelSeats', () => {
  it('registers every seat and releases them all, in reverse order', () => {
    const order: string[] = []
    const dispose = registerModelLabelSeats(
      [{ name: SLOT, key: 'a', priority: 1 }, { name: SLOT, key: 'b', priority: 1 }],
      seat => {
        order.push(`register ${seat.key ?? '(none)'}`)
        return () => order.push(`dispose ${seat.key ?? '(none)'}`)
      },
    )
    expect(order).toEqual(['register a', 'register b'])
    dispose()
    // Reverse: the last seat claimed is the first released, which is the only
    // order that stays correct if a later seat ever depends on an earlier one.
    expect(order).toEqual(['register a', 'register b', 'dispose b', 'dispose a'])
  })

  it('ROLLS BACK the seats that already landed when a later one is refused', () => {
    // The bug this prevents: a plain `.map()` loses the disposers of the seats
    // that succeeded, because they were only held by the array the throw
    // discarded. The ledger keeps those entries forever, the caller believes it
    // failed, and nothing can release them.
    const slotCore = core('single')
    const seats = modelLabelSeats({
      name: SLOT,
      kind: 'keyed',
      providerIds: QODER_MODEL_LABEL_PROVIDERS,
      priority: QODER_MODEL_LABEL_PRIORITY,
    })
    // Force the shape mismatch a plain `.map()` would produce on a single host.
    expect(() => registerModelLabelSeats(seats, seat => slotCore.register(seat, () => null)))
      .toThrow(/already has a registration/)
    // Nothing left behind: the first seat was released by the rollback.
    expect(slotCore.entries(SLOT)).toHaveLength(0)
    expect(slotCore.entriesOfSlot(SLOT)).toHaveLength(0)
  })

  it('leaves no orphan when the FIRST seat is refused', () => {
    const slotCore = core('keyed')
    expect(() => registerModelLabelSeats(
      [{ name: SLOT, priority: QODER_MODEL_LABEL_PRIORITY }], // no key on a keyed host
      seat => slotCore.register(seat, () => null),
    )).toThrow(/requires options\.key/)
    expect(slotCore.entries(SLOT)).toHaveLength(0)
  })

  it('does not let a throwing disposer mask the original refusal', () => {
    // A broken unwinder must not turn one refusal into a crash with no cause.
    expect(() => registerModelLabelSeats(
      [{ name: SLOT, key: 'a', priority: 1 }, { name: SLOT, key: 'b', priority: 1 }],
      seat => {
        if (seat.key === 'b') throw new Error('refused')
        return () => { throw new Error('dispose exploded') }
      },
    )).toThrow('refused')
  })

  it('每次调用都把底层 disposer 全跑一遍；重复 dispose 会再跑一遍', () => {
    // 释放路径会跑两次（re-inject 释放一次，apply 再拆一次）。这里钉住组合
    // disposer 实际委托了什么：它**不去重**，幂等性来自注册器自己那层保护。
    // 只对着空操作断言「不抛」——那样无论组合器做什么都会绿。
    const calls: string[] = []
    const dispose = registerModelLabelSeats(
      [{ name: SLOT, key: 'a', priority: 1 }, { name: SLOT, key: 'b', priority: 1 }],
      seat => () => calls.push(String(seat.key)),
    )
    dispose()
    expect(calls).toEqual(['b', 'a'])
    dispose()
    expect(calls).toEqual(['b', 'a', 'b', 'a'])
  })

  it('空计划不释放任何东西，也不抛', () => {
    const dispose = registerModelLabelSeats([], () => { throw new Error('must not be called') })
    expect(() => dispose()).not.toThrow()
  })
})
