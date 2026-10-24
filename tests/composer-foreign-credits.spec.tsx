// @vitest-environment jsdom
/**
 * 跨连接器余额对比（issue #14）：会话选中的模型属于**别的连接器**时，本插件
 * 的积分读数是否仍然显示。
 *
 * 报告的场景：同时装了 qoder 与 workbuddy 两个连接器，想两个余额并排看、直接
 * 对比「哪家剩得少」再决定切哪家。根因是 gate 先按 provider 过滤——两张 provider
 * 映射表不相交，选了谁家的模型，另一家的胶囊立刻消失；位置设置（composer /
 * stats）救不了，它的判断在 provider 判断之后。
 *
 * 修法是给每个区域一个 opt-in 开关 `showCreditsForForeignModels`：provider 不属
 * 于本插件（或投影还没落地）时，第一个开了开关的区域照常渲染，`shown` / `enabled`
 * 两道原有开关照旧把关。胶囊标签（「QD CN」）与对方连接器自己的标签（如
 * 「WB CN」）天然可区分，不需要额外的来源标识。
 *
 * 这里钉住的性质：
 *   1. 默认关——别家 provider 下什么都不画，升级后行为与从前逐字一致；
 *   2. 开了才显示，且区域自己的显示/启用开关仍能把它关掉；
 *   3. 本插件 provider 的路径完全不受新设置影响；
 *   4. 对比态的悬停说「Qoder 侧」，不说「当前计费」——本会话根本不经 Qoder 计费；
 *   5. 写入只动目标区域的字段，隔壁区域与同区域其他字段存活。
 *
 * 参考：`tests/credit-position.spec.tsx`（同款 gate 挂载 harness）。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextRegionCreditsForeign } from '../src/status-paths.ts'
import { ComposerCreditsGate, composerCreditsRegionOf } from '../src/client/ComposerCreditsGate.tsx'
import { ComposerCredits } from '../src/client/ComposerCredits.tsx'

const act: typeof actFromReact = ((React as unknown as { act?: typeof actFromReact }).act
  ?? actTestUtils) as typeof actFromReact

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Mapper translator：能断言标签选了哪个区域、悬停用了哪条文案。 */
const t: any = (key: string, params?: Record<string, unknown>): string => {
  switch (key) {
    case 'composer.pointsCn': return 'QD CN'
    case 'composer.pointsGlobal': return 'QD AI'
    case 'composer.billingAccount': return `billing-right-now:${String(params?.name ?? '')}`
    case 'composer.compareBillingAccount': return `qoder-side:${String(params?.name ?? '')}`
    default: return params === undefined ? key : `${key}|${JSON.stringify(params)}`
  }
}

/** A settings scope stub whose snapshot is the given section. */
function scopeOf(value: unknown): any {
  return {
    getSnapshot: () => ({ status: 'ready', value, writable: true }),
    subscribe: () => () => {},
    set: async () => true,
  }
}

function signedInDoc(input: { region?: string, credits: number }): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'ddd',
    accountName: 'ddd',
    region: input.region ?? 'cn',
    credits: { total: input.credits },
    creditsAtMs: Date.now(),
    accounts: [{ id: 'ddd', accountName: 'ddd', selected: true }],
    models: [],
    enabledModelKeys: [],
    offModelKeys: [],
    imageModelKeys: [],
    selectionExplicit: false,
  }
}

/** 挂 gate 并回报触发器（胶囊本体）的文本与悬停。 */
async function mountGate(input: {
  provider?: string
  scope?: unknown
  position?: 'composer' | 'stats'
  doc?: Record<string, unknown>
}): Promise<{ text: string, title: string | null, drewTrigger: boolean, unmount: () => Promise<void> }> {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/account-credits')) {
      return { ok: true, status: 200, json: async () => [] } as Response
    }
    return { ok: true, status: 200, json: async () => input.doc ?? signedInDoc({ credits: 773 }) } as Response
  }))
  const useProjection = (): unknown => ({ next: { provider: input.provider ?? 'workbuddy' } })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ComposerCreditsGate, {
      t,
      ...input.position === undefined ? {} : { position: input.position },
      ...input.scope === undefined ? {} : { settingsScope: input.scope as any },
      useProjection,
    }))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  const trigger = container.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-credits-trigger')
  return {
    text: trigger?.textContent ?? '',
    title: trigger?.getAttribute('title') ?? null,
    drewTrigger: trigger !== null,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
      document.body.innerHTML = ''
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('composerCreditsRegionOf：provider 不属于本插件时', () => {
  it('默认关（兼容面）：别家 provider → 不渲染，行为与从前逐字一致', () => {
    expect(composerCreditsRegionOf({ next: { provider: 'workbuddy' } }, scopeOf({}))).toBeUndefined()
    // 一切都没配置（scope 缺席 / 旧宿主）同样不渲染。
    expect(composerCreditsRegionOf({ next: { provider: 'workbuddy' } }, undefined)).toBeUndefined()
  })

  it('cn 开了对比：别家 provider → cn', () => {
    expect(composerCreditsRegionOf(
      { next: { provider: 'workbuddy' } },
      scopeOf({ regions: { cn: { showCreditsForForeignModels: true } } }),
    )).toBe('cn')
  })

  it('投影还没落地：开了对比也显示——胶囊不再依赖 provider', () => {
    expect(composerCreditsRegionOf(
      undefined,
      scopeOf({ regions: { cn: { showCreditsForForeignModels: true } } }),
    )).toBe('cn')
  })

  it('区域的显示开关仍把关：showCreditsInMainUi=false → 不渲染', () => {
    expect(composerCreditsRegionOf(
      { next: { provider: 'workbuddy' } },
      scopeOf({ regions: { cn: { showCreditsForForeignModels: true, showCreditsInMainUi: false } } }),
    )).toBeUndefined()
  })

  it('区域的启用开关仍把关：enabled=false → 不渲染', () => {
    expect(composerCreditsRegionOf(
      { next: { provider: 'workbuddy' } },
      scopeOf({ regions: { cn: { showCreditsForForeignModels: true, enabled: false } } }),
    )).toBeUndefined()
  })

  it('只有 global 开 → global：显示哪个区域是用户的选择，不是写死的默认区域', () => {
    expect(composerCreditsRegionOf(
      { next: { provider: 'workbuddy' } },
      scopeOf({ regions: { global: { showCreditsForForeignModels: true } } }),
    )).toBe('global')
  })

  it('两个区域都开 → cn（QODER_REGIONS 顺序，可预测）', () => {
    expect(composerCreditsRegionOf(
      { next: { provider: 'workbuddy' } },
      scopeOf({
        regions: {
          cn: { showCreditsForForeignModels: true },
          global: { showCreditsForForeignModels: true },
        },
      }),
    )).toBe('cn')
  })

  it('本插件 provider 照旧：qoder → cn，与对比设置无关（开着也一样）', () => {
    expect(composerCreditsRegionOf(
      { next: { provider: 'qoder' } },
      scopeOf({ regions: { global: { showCreditsForForeignModels: true } } }),
    )).toBe('cn')
    expect(composerCreditsRegionOf(
      { next: { provider: 'qoder-global' } },
      scopeOf({ regions: { cn: { showCreditsForForeignModels: true } } }),
    )).toBe('global')
  })
})

describe('挂起来的 gate（别家 provider 的会话）', () => {
  it('cn 开了对比：胶囊渲染，读 cn 的余额，标签 QD CN', async () => {
    const { text, drewTrigger, unmount } = await mountGate({
      provider: 'workbuddy',
      scope: scopeOf({ regions: { cn: { showCreditsForForeignModels: true } } }),
      doc: signedInDoc({ region: 'cn', credits: 773 }),
    })
    expect(drewTrigger).toBe(true)
    expect(text).toContain('QD CN')
    expect(text).toContain('773')
    await unmount()
  })

  it('global 开了对比：胶囊读 global，标签 QD AI', async () => {
    const { text, unmount } = await mountGate({
      provider: 'workbuddy',
      scope: scopeOf({ regions: { global: { showCreditsForForeignModels: true } } }),
      doc: signedInDoc({ region: 'global', credits: 512 }),
    })
    expect(text).toContain('QD AI')
    expect(text).toContain('512')
    await unmount()
  })

  it('默认关：别家 provider 时什么都不画', async () => {
    const { drewTrigger, unmount } = await mountGate({
      provider: 'workbuddy',
      scope: scopeOf({}),
    })
    expect(drewTrigger).toBe(false)
    await unmount()
  })

  it('对比态悬停说「Qoder 侧」，不说「当前计费」——本会话不经 Qoder 计费', async () => {
    const { title, unmount } = await mountGate({
      provider: 'workbuddy',
      scope: scopeOf({ regions: { cn: { showCreditsForForeignModels: true } } }),
    })
    expect(title).toContain('qoder-side:ddd')
    expect(title).not.toContain('billing-right-now')
    await unmount()
  })

  it('本插件 provider 的悬停仍说「当前计费」（原 #13 行为不动）', async () => {
    const { title, unmount } = await mountGate({
      provider: 'qoder',
      scope: scopeOf({}),
    })
    expect(title).toContain('billing-right-now:ddd')
    await unmount()
  })

  it('席位仍把关：对比模式下 cn 的席位是 stats 时，composer 席位不渲染、stats 席位渲染', async () => {
    const scope = scopeOf({
      regions: { cn: { showCreditsForForeignModels: true, creditPosition: 'stats' } },
    })
    const composerSeat = await mountGate({ provider: 'workbuddy', scope, position: 'composer' })
    expect(composerSeat.drewTrigger).toBe(false)
    await composerSeat.unmount()
    const statsSeat = await mountGate({ provider: 'workbuddy', scope, position: 'stats' })
    expect(statsSeat.drewTrigger).toBe(true)
    await statsSeat.unmount()
  })
})

describe('ComposerCredits 的守卫边界', () => {
  async function mountCredits(props: Record<string, unknown>): Promise<{ drew: boolean, text: string, title: string | null }> {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => signedInDoc({ credits: 773 }),
    } as Response)))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(React.createElement(ComposerCredits, { t, ...props } as any))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const trigger = container.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-credits-trigger')
    const result = {
      drew: trigger !== null,
      text: trigger?.textContent ?? '',
      title: trigger?.getAttribute('title') ?? null,
    }
    await act(async () => { root.unmount() })
    container.remove()
    document.body.innerHTML = ''
    return result
  }

  it('foreign provider 且给了 region：渲染（对比模式从 gate 进来）', async () => {
    const { drew, text } = await mountCredits({ provider: 'workbuddy', region: 'cn' })
    expect(drew).toBe(true)
    expect(text).toContain('773')
  })

  it('foreign provider 且没有 region：不渲染（旧守卫，未变化）', async () => {
    const { drew } = await mountCredits({ provider: 'workbuddy' })
    expect(drew).toBe(false)
  })

  it('本插件 provider 不给 region：照常由 provider 映射区域（原有路径）', async () => {
    const { drew, text } = await mountCredits({ provider: 'qoder' })
    expect(drew).toBe(true)
    expect(text).toContain('QD CN')
  })
})

describe('设置的读写', () => {
  it('nextRegionCreditsForeign 只动目标区域的开关，同区域其他字段与隔壁区域存活', () => {
    const next = nextRegionCreditsForeign(
      {
        regions: {
          cn: { showCreditsInMainUi: false, accountId: 'a1' },
          global: { enabled: false },
        },
      },
      'cn',
      true,
    )
    expect(next).toEqual({
      cn: { showCreditsInMainUi: false, accountId: 'a1', showCreditsForForeignModels: true },
      global: { enabled: false },
    })
  })
})
