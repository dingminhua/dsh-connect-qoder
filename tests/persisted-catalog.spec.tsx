// @vitest-environment jsdom
/**
 * 「保存后思考强度不见了」的回归测试（用户实拍，两个区域都会出现）。
 *
 * ## 被钉住的缺陷
 *
 * 卡片保存时手写了一份 `lastCatalog` 条目，读取端是另一份，两者从未对账：
 *
 * | 字段 | 读取端（`modelFromStored`，src/index.ts） | 卡片实际写入 | 后果 |
 * | --- | --- | --- | --- |
 * | `thinkingEfforts` | 要 `length > 0` | **没写** | 保存即丢档位 |
 * | `defaultThinkingEffort` | 要非空串 | **没写** | 同上 |
 * | `maxOutputTokens` | 要 number | 写的是 `maxTokens` | 永远读不回，回落 32768 |
 *
 * 有一处**必须说准**（本文件的第一版曾把这里写错）：schemastery **不会**剥掉
 * 未声明的键 —— 实测 `nativeContextWindow` / `maxTokens` 都会原样留在解析结果里，
 * 而缺席的 `z.array(...).required(false)` 会被**补成 `[]`** 而不是留 `undefined`。
 * 正因如此，`thinkingEfforts` 缺席时读回的是空数组，而读取端的判据是
 * `length > 0` —— 于是档位选择器消失；这才是缺陷的真实机制，而不是「被 schema
 * 剥掉」。
 *
 * 之所以**没有一条测试发现它**：既有的 `index.spec.ts` 那条往返测试是**手写**了
 * 一份「理想的」payload 去喂 schema —— 它证明的是「schema 不吞字段」，而不是
 * 「客户端真的写了这些字段」。真实保存路径（`buildModelsPayload` → 写入 → 读回）
 * 从未被任何测试执行过。
 *
 * 这个文件反过来：**调用真正的客户端函数**，把它的**真实输出**喂给**插件自己
 * 导出的 Config schema**，并按**读取端的判据**断言读回了什么。
 *
 * 保存的落地校验只比对 `key` 列表（见 `account-selection.ts` 的
 * `writeRegionModels`），所以字段丢失**永远不会**让一次保存失败 —— 这正是它
 * 能长期潜伏的原因，也是这里必须逐字段断言的理由。
 */
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { QODER_FALLBACK_MODELS, fallbackModelInfo } from '../src/catalog.ts'
import { toPersistedCatalogEntry, type QoderWebModel } from '../src/status-paths.ts'
import { buildModelsPayload, type QoderDraft } from '../src/client/QoderCard.tsx'

/**
 * Run one region's persisted slot through the plugin's OWN exported schema.
 *
 * Reading the schema out of `Config` (instead of re-declaring it here) is the
 * point: a hand-copied schema would drift alongside the bug instead of catching
 * it. `regions` is `asVolatile(z.dict(regionConfig))`, so the value comes back
 * as a live `{get()}` reference that must be unwrapped — after which it is the
 * `{ cn: <slot> }` dict, so the region slot is dug out here.
 */
function parseRegionSlot(slot: Record<string, unknown>): Record<string, unknown> {
  const regions = (Config as unknown as { dict: { regions: (input: unknown) => unknown } }).dict.regions
  const out = regions({ cn: slot })
  const unwrapped = (out !== null && typeof out === 'object' && 'get' in (out as object)
    ? (out as { get(): unknown }).get()
    : out) as Record<string, unknown>
  return (unwrapped['cn'] ?? {}) as Record<string, unknown>
}

/** The keys the Region schema declares for one `lastCatalog` entry. */
function declaredModelKeys(): string[] {
  const inner = (Config as unknown as {
    dict: { regions: { inner: { dict: { lastCatalog: { inner: { dict: Record<string, unknown> } } } } } }
  }).dict.regions.inner.dict.lastCatalog.inner.dict
  return Object.keys(inner)
}

/** One card row with everything the projection has to carry. */
function cardRow(overrides: Record<string, unknown> = {}): QoderWebModel {
  return {
    key: 'qfmodel',
    name: 'Qwen3.8-Flash',
    contextWindow: 400_000,
    nativeContextWindow: 400_000,
    maxTokens: 32_768,
    creditMultiplier: 0,
    supportsImages: true,
    supportsThinking: true,
    canDisableThinking: false,
    isDefault: false,
    isFree: true,
    isNew: false,
    thinkingEfforts: ['low', 'medium', 'xhigh'],
    defaultThinkingEffort: 'medium',
    contextTiers: [200_000, 400_000, 1_000_000],
    ...overrides,
  } as QoderWebModel
}

/** The draft the card holds while the user's edits are pending. */
function draftOf(over: Partial<QoderDraft> = {}): QoderDraft {
  return {
    enabledModelKeys: new Set(over.enabledModelKeys ?? ['qfmodel']),
    offModelKeys: new Set(over.offModelKeys ?? []),
    supportsImages: new Set(over.supportsImages ?? ['qfmodel']),
    contextBudgets: over.contextBudgets ?? { qfmodel: 400_000 },
    thinkingEfforts: over.thinkingEfforts ?? { qfmodel: 'xhigh' },
  }
}

/** The reader's criterion: `modelFromStored` only keeps `length > 0`. */
function readerSeesEfforts(entry: Record<string, unknown>): boolean {
  const raw = entry['thinkingEfforts']
  return Array.isArray(raw) && raw.length > 0
}

/** The models array out of a parsed region slot. */
function modelsOf(slot: Record<string, unknown>): Array<Record<string, unknown>> {
  return (slot['lastCatalog'] ?? []) as Array<Record<string, unknown>>
}

describe('保存的目录条目：客户端输出与读取端判据必须对齐', () => {
  it('投影出的字段全部是 schema 声明过的（凭空发明字段名会立刻变红）', () => {
    const written = Object.keys(toPersistedCatalogEntry(cardRow()))
    const declared = new Set(declaredModelKeys())
    expect(written.filter(key => !declared.has(key))).toEqual([])
  })

  it('不产出值为 undefined 的属性（严格 JSON codec 兼容）', () => {
    // 照 workbuddy 的 `toPersistedWorkBuddyModel` 同名用例写的 —— 投影改成
    // spread 之后，这条**从「锦上添花」变成「必需」**：
    // 显式 `undefined` 会挺过 `structuredClone`，被设置写入端那道严格 JSON
    // codec 拒收（`client api: settings/mutate rejected "ops"`），整次保存失败。
    // 卡片行里 `thinkingEfforts` / `defaultThinkingEffort` / `contextTiers` /
    // `supportsImages` 都是可选的，只要哪一个被无条件展开就会踩到这。
    const cases: QoderWebModel[] = [
      cardRow(),
      // 可选键全部缺席：最容易漏出 `undefined` 的形状。
      cardRow({
        thinkingEfforts: undefined,
        defaultThinkingEffort: undefined,
        contextTiers: undefined,
        supportsImages: undefined,
        creditMultiplier: undefined,
      }),
      // 空数组 / 空串：读取端判据同样不成立，必须按缺席剔除。
      cardRow({ thinkingEfforts: [], defaultThinkingEffort: '', contextTiers: [] }),
    ]
    for (const model of cases) {
      const persisted = toPersistedCatalogEntry(model) as unknown as Record<string, unknown>
      expect(Object.values(persisted).every(value => value !== undefined)).toBe(true)
      // JSON 往返必须无损，codec 才肯收。
      expect(JSON.parse(JSON.stringify(persisted))).toEqual(persisted)
    }
  })

  it('读取端要的字段一个都不能少（少一个就是静默丢失）', () => {
    const entry = toPersistedCatalogEntry(cardRow()) as unknown as Record<string, unknown>
    // 读取端真正消费的键：`thinkingEfforts`（判据 length>0）、
    // `defaultThinkingEffort`、`maxOutputTokens`、`contextTiers` 与几个布尔位。
    for (const key of ['thinkingEfforts', 'defaultThinkingEffort', 'maxOutputTokens', 'contextWindow', 'contextTiers']) {
      expect(Object.keys(entry), `落盘条目缺少读取端要的 ${key}`).toContain(key)
    }
  })

  it('把「客户端保存」的真实 payload 喂给真实 Config，并按读取端判据断言档位活着', () => {
    const payload = buildModelsPayload(draftOf(), [cardRow()])
    const entry = payload.lastCatalog[0] as unknown as Record<string, unknown>
    expect(entry['thinkingEfforts']).toEqual(['low', 'medium', 'xhigh'])

    const model = modelsOf(parseRegionSlot({ lastCatalog: payload.lastCatalog as never }))[0]!

    // 变异的根因：客户端不写这两个字段时，schema 把数组补成 `[]`，
    // `modelFromStored` 的 `length > 0` 不成立 → 档位选择器消失。
    expect(readerSeesEfforts(model)).toBe(true)
    expect(model['thinkingEfforts']).toEqual(['low', 'medium', 'xhigh'])
    expect(model['defaultThinkingEffort']).toBe('medium')
    expect(model['contextTiers']).toEqual([200_000, 400_000, 1_000_000])
    // 输出窗口按读取端要的名字往返（旧代码写 `maxTokens`，这里读到 undefined，
    // 于是模型回落到 32768 默认值）。
    expect(model['maxOutputTokens']).toBe(32_768)
    expect('maxTokens' in model).toBe(false)
  })

  it('旧客户端的 payload（本机落盘的真实形状）走同一遍：档位读不回来', () => {
    // 逐字照抄旧 buildModelsPayload 的输出：有 nativeContextWindow / maxTokens，
    // 没有 thinkingEfforts / defaultThinkingEffort。
    const oldEntry = {
      key: 'qfmodel', displayName: 'Qwen3.8-Flash', priceFactor: 0,
      contextWindow: 400_000, nativeContextWindow: 400_000, maxTokens: 32_768,
      supportsImages: true, supportsThinking: true, canDisableThinking: false,
      isDefault: false, isFree: true, isNew: false,
      contextTiers: [200_000, 400_000, 1_000_000],
    }
    const model = modelsOf(parseRegionSlot({ lastCatalog: [oldEntry] }))[0]!
    // 这条断言描述的是**修复前**的事实，用来证明缺陷机制（而不是修复行为）：
    // 数组被补成 []，读取端判据不成立 —— 这就是「思考强度不见了」。
    expect(model['thinkingEfforts']).toEqual([])
    expect(readerSeesEfforts(model)).toBe(false)
    // 并且输出窗口读不回来：读取端要 maxOutputTokens，旧客户端写的是 maxTokens。
    expect(model['maxOutputTokens']).toBeUndefined()
    expect(model['maxTokens']).toBe(32_768)
  })

  it('思考强度是**设置**：逐模型存进 region 槽，与目录条目各走各的', () => {
    const payload = buildModelsPayload(
      draftOf({ thinkingEfforts: { qfmodel: 'xhigh', gfmodel: 'low' } }),
      [cardRow()],
    )
    // 目录条目里的 `thinkingEfforts` 是上游声明的**档位集合**（数组）；
    // region 槽里的 `thinkingEfforts` 是用户的**选择**（模型 key → 档位）。
    // 同名不同物，必须分别落盘，否则读回时一个覆盖另一个。
    expect(payload.thinkingEfforts).toEqual({ qfmodel: 'xhigh', gfmodel: 'low' })
    expect(payload.lastCatalog[0]!.thinkingEfforts).toEqual(['low', 'medium', 'xhigh'])
    const slot = parseRegionSlot({
      lastCatalog: payload.lastCatalog as never,
      thinkingEfforts: payload.thinkingEfforts as never,
    })
    expect(slot['thinkingEfforts']).toEqual({ qfmodel: 'xhigh', gfmodel: 'low' })
  })

  it('上游没声明档位时不写空数组与空串（缺席 ≠ 声明过但一个都没有）', () => {
    const entry = toPersistedCatalogEntry(cardRow({
      thinkingEfforts: [],
      defaultThinkingEffort: '',
      contextTiers: [],
    })) as unknown as Record<string, unknown>
    // 缺席 = 上游没档位（诚实答案）；`[]` = 旧快照的产物。两者必须可分。
    expect('thinkingEfforts' in entry).toBe(false)
    expect('defaultThinkingEffort' in entry).toBe(false)
    expect('contextTiers' in entry).toBe(false)
  })

  it('图片勾选以草稿为准，不被模型上的旧值抹掉', () => {
    // 用户刚取消勾选；model 上仍是上次读到的 true。用模型值会让本次保存回滚它。
    expect(toPersistedCatalogEntry(cardRow({ supportsImages: true }), { supportsImages: false }).supportsImages).toBe(false)
    expect(toPersistedCatalogEntry(cardRow({ supportsImages: true })).supportsImages).toBe(true)
  })

  it('上下文窗口落盘存**原生**值（预算不是原生窗口）', () => {
    // 卡片行上的 contextWindow 已被预算改小，nativeContextWindow 才是上游原生值。
    // 存被 clamp 过的值，预算就会「焊死」在目录里，`applyContextBudgets` 再也
    // 改不回去 —— 预算本身另存在 region 槽的 contextBudgets 里。
    const entry = toPersistedCatalogEntry(cardRow({ contextWindow: 200_000, nativeContextWindow: 400_000 }))
    expect(entry.contextWindow).toBe(400_000)
  })

  it('兜底目录（未声明档位）也能被投影，且不产生 schema 不认的键', () => {
    const rows: QoderWebModel[] = QODER_FALLBACK_MODELS.map(info => {
      const m = fallbackModelInfo(info)
      return {
        key: m.key,
        name: m.displayName,
        contextWindow: m.contextWindow,
        nativeContextWindow: m.contextWindow,
        maxTokens: m.maxOutputTokens,
        creditMultiplier: m.priceFactor,
        supportsThinking: m.supportsThinking,
        ...m.thinkingEfforts === undefined ? {} : { thinkingEfforts: m.thinkingEfforts },
      }
    })
    const payload = buildModelsPayload(draftOf(), rows)
    const declared = new Set(declaredModelKeys())
    for (const entry of payload.lastCatalog as unknown as Array<Record<string, unknown>>) {
      expect(Object.keys(entry).filter(key => !declared.has(key))).toEqual([])
      // 兜底目录没声明档位 → 条目不带 `thinkingEfforts`（而不是带一个 `[]`）。
      expect('thinkingEfforts' in entry).toBe(false)
      expect(typeof entry['maxOutputTokens']).toBe('number')
    }
  })
})
