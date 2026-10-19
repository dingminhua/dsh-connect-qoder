/**
 * 首屏文档（`detail=fast`）的行为回归 —— 同族插件 issue #77 的 Qoder 版。
 *
 * 症状：打开设置页后账号列表要等几十秒才出现。根因是整份 usage 文档的**尾巴**
 * 串着逐账号的上游读：`freshUsageEntryOf` 现场重读一次 serving 账号的积分，
 * `buildPoolView` 里 `memberCredits` 再为**每个成员**打一次真实 usage。任何一次
 * 慢/被限流都会把整份文档扣住，而卡片在拿到文档之前什么都不画。
 *
 * 这些用例盯的是「首屏一次上游都不打」这件事——不是「快」，是**不可能被上游
 * 扣住**：只要 fast 分支里出现了上游调用，这些用例就红。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { buildWebUsage, registerQoderWebRoutes } from '../src/web-status.ts'
import type { QoderAccountDeps, QoderPoolDeps, QoderSettingsDeps, QoderWebRouteDeps } from '../src/web-status.ts'
import {
  QODER_DETAIL_FAST,
  QODER_USAGE_PATH,
  fastDetailOf,
  withQoderRegion,
  withQoderRegionFastDetail,
} from '../src/status-paths.ts'
import type { QoderModelInfo } from '../src/catalog.ts'
import type { QoderPoolCredits } from '../src/account-pool.ts'
import type { QoderPoolProbe } from '../src/account-pool.ts'
import type { QoderRegion } from '../src/upstream.ts'

/** One free model so the pool can resolve a target. */
const FREE_MODEL: QoderModelInfo = {
  key: 'dfmodel',
  displayName: 'DeepSeek-V4-Flash',
  priceFactor: 1,
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,
  supportsImages: false,
  supportsThinking: true,
  canDisableThinking: true,
  isDefault: true,
  isFree: true,
  isNew: false,
}

/** Two stored credentials, both usable. */
function store(): QoderAccountDeps {
  const entry = (accountId: string): { id: string, pat: string, accountName: string, source: 'vault' } | undefined =>
    accountId === 'a1' ? { id: 'a1', pat: 'pat-a1', accountName: 'Alpha', source: 'vault' }
      : accountId === 'a2' ? { id: 'a2', pat: 'pat-a2', accountName: 'Beta', source: 'vault' }
        : undefined
  return {
    accounts: async () => [
      { id: 'a1', accountName: 'Alpha', source: 'vault' },
      { id: 'a2', accountName: 'Beta', source: 'vault' },
    ],
    credentialFor: async accountId => entry(accountId),
    resolve: async () => entry('a1'),
    add: async () => ({ id: 'a1', pat: 'pat-a1', accountName: '', addedAtMs: 0 }),
    vaultAccounts: async () => [],
    remove: async () => false,
    rename: async () => {},
  }
}

/** The upstream-touching deps, each a spy so "did you call it?" is the assertion. */
function spies() {
  return {
    memberCredits: vi.fn(async (_region: QoderRegion, accountIds: readonly string[]) =>
      new Map<string, QoderPoolCredits>(accountIds.map(id => [id, { total: 1200, expiringSoon: 0 }]))),
    credentialRecovery: vi.fn(async () => ({ reloginRequired: false })),
    refreshUsage: vi.fn(async () => {}),
    cachedMemberCredits: vi.fn((_region: QoderRegion, accountIds: readonly string[]) =>
      new Map<string, QoderPoolCredits>(accountIds.slice(0, 1).map(id => [id, { total: 42, expiringSoon: 0 }]))),
  }
}

function deps(overrides: Partial<QoderWebRouteDeps> = {}): QoderWebRouteDeps {
  return {
    regionEnabled: () => true,
    regionCreditsShown: () => true,
    store: () => store(),
    credentialSources: () => ({ settingsPat: undefined, envPat: undefined }),
    selectedAccountId: () => undefined,
    catalogs: { cn: { current: () => [FREE_MODEL] }, global: { current: () => [FREE_MODEL] } },
    contextBudgets: () => ({}),
    thinkingEfforts: () => ({}),
    offModelKeys: () => [],
    enabledModelKeys: () => ['dfmodel'],
    imageModelKeys: () => ['dfmodel'],
    settings: { describe: () => [], set: async () => {} } as QoderSettingsDeps,
    logger: () => {},
    usage: () => ({ usage: { credits: { total: 100, packages: [], expiringSoon: 0 }, atMs: Date.now() } }),
    ...overrides,
  }
}

function poolDeps(overrides: Partial<QoderPoolDeps> = {}): QoderPoolDeps {
  return {
    checkinSupported: () => true,
    preferences: () => ({ enabled: true, targetModelId: 'dfmodel', probeInputTokens: 0, memberAccountIds: ['a1', 'a2'] }),
    catalog: () => [FREE_MODEL],
    poolProbes: () => ({} as Record<string, QoderPoolProbe>),
    credentialFor: async () => ({ pat: 'pat-a1', accountName: 'Alpha' }),
    probeOne: async () => ({ modelId: 'dfmodel', outcome: 'ok', status: 200 }),
    test: async () => [],
    applyProbes: async () => {},
    updateMembership: () => {},
    ...overrides,
  }
}

interface CapturedEntry {
  path: string
  handler: (req: unknown, res: unknown) => Promise<void> | void
}

async function mountRoutes(depsFor: QoderWebRouteDeps): Promise<CapturedEntry[]> {
  const captured: CapturedEntry[] = []
  const FakeWebServer = {
    name: 'webServer',
    inject: [] as const,
    apply(ctx: Context) {
      ctx.provide('webServer', {
        register: (entry: CapturedEntry) => {
          captured.push(entry)
          return () => {}
        },
      })
    },
  }
  const ctx = new Context()
  await ctx.plugin(FakeWebServer)
  registerQoderWebRoutes(ctx, depsFor)
  await ctx.fiber.dispose()
  return captured
}

function response(): { res: { writeHead: (status: number) => void, end: (payload?: string) => void }, status: () => number, body: () => unknown } {
  let statusCode = 0
  let payload = ''
  return {
    res: { writeHead: (s: number) => { statusCode = s }, end: (b?: string) => { payload = b ?? '' } },
    status: () => statusCode,
    body: () => JSON.parse(payload),
  }
}

function usageRequest(url: string): { method: string, url: string, headers: Record<string, string> } {
  return { method: 'GET', url, headers: {} }
}

describe('the detail query parameter', () => {
  it('addresses the fast document without disturbing the region parameter', () => {
    const url = withQoderRegionFastDetail(QODER_USAGE_PATH, 'global')
    expect(url).toBe(`${QODER_USAGE_PATH}?region=global&detail=fast`)
    // The region must stay readable through the normal helper — the route parses
    // it independently of the detail parameter.
    const parsed = new URLSearchParams(new URL(url, 'http://localhost').search.slice(1))
    expect(parsed.get('region')).toBe('global')
    expect(parsed.get('detail')).toBe(QODER_DETAIL_FAST)
    // And the plain helper still yields the FULL document URL.
    expect(withQoderRegion(QODER_USAGE_PATH, 'global')).toBe(`${QODER_USAGE_PATH}?region=global`)
  })

  it('recognizes ONLY the exact value `fast`', () => {
    expect(fastDetailOf(`${QODER_USAGE_PATH}?region=cn&detail=fast`)).toBe(true)
    // Everything else is the full document. A typo must cost a slow paint,
    // never a thinner panel that reads like data loss.
    for (const value of ['FAST', 'fastest', 'fast ', '', 'slow']) {
      expect(fastDetailOf(`${QODER_USAGE_PATH}?region=cn&detail=${value}`)).toBe(false)
    }
    expect(fastDetailOf(`${QODER_USAGE_PATH}?region=cn&detail`)).toBe(false)
    expect(fastDetailOf(`${QODER_USAGE_PATH}?region=cn`)).toBe(false)
  })
})

describe('buildWebUsage({ detail: fast })', () => {
  it('answers with the pool rows while performing NO upstream read at all', async () => {
    const s = spies()
    const d = deps({ pool: poolDeps({ memberCredits: s.memberCredits, cachedMemberCredits: s.cachedMemberCredits }) })

    const usage = await buildWebUsage(d, 'cn', { detail: 'fast' })
    if (usage.status !== 'signed-in') throw new Error('expected signed-in')

    // The rows are there — that is the whole point of the first paint.
    const rows = usage.pool?.accounts ?? []
    expect(rows.map(row => row.accountId)).toEqual(['a1', 'a2'])

    // ...and nothing upstream was touched to produce them.
    expect(s.memberCredits).not.toHaveBeenCalled()
    expect(s.cachedMemberCredits).toHaveBeenCalledTimes(1)
  })

  it('does not await the live credit re-read that the full document performs', async () => {
    const s = spies()
    const d = deps({ refreshUsage: s.refreshUsage, pool: poolDeps({ memberCredits: s.memberCredits }) })

    await buildWebUsage(d, 'cn', { detail: 'fast' })
    expect(s.refreshUsage).not.toHaveBeenCalled()

    // Control: the default (full) document still performs it, unchanged.
    await buildWebUsage(d, 'cn')
    expect(s.refreshUsage).toHaveBeenCalledTimes(1)
    expect(s.memberCredits).toHaveBeenCalledTimes(1)
  })

  it('renders the balances the Host already measured, and omits the rest instead of guessing', async () => {
    const s = spies()
    const d = deps({ pool: poolDeps({ memberCredits: s.memberCredits, cachedMemberCredits: s.cachedMemberCredits }) })
    const usage = await buildWebUsage(d, 'cn', { detail: 'fast' })
    if (usage.status !== 'signed-in') throw new Error('expected signed-in')
    const rows = usage.pool?.accounts ?? []
    // The first-paint source knows about a1 only; a2 must stay unmeasured (`—`),
    // never a fabricated zero.
    expect(rows.find(row => row.accountId === 'a1')?.credits).toBe(42)
    expect(rows.find(row => row.accountId === 'a2')?.credits).toBeUndefined()
  })

  it('omits the pool block when the Host has no first-paint source, rather than paying for the live read', async () => {
    // A Host without `cachedMemberCredits` cannot answer from local state. The
    // honest answer is "no pool block yet" — the follow-up full document fills
    // it in. Silently falling back to `memberCredits` here would reintroduce the
    // exact stall this change exists to remove.
    const s = spies()
    const d = deps({ pool: poolDeps({ memberCredits: s.memberCredits }) })
    const usage = await buildWebUsage(d, 'cn', { detail: 'fast' })
    if (usage.status !== 'signed-in') throw new Error('expected signed-in')
    expect(usage.pool).toBeUndefined()
    expect(s.memberCredits).not.toHaveBeenCalled()
  })

  it('does not probe other accounts to build a recovery suggestion', async () => {
    // `credentialRecovery` reads every other account from upstream. The first
    // paint keeps the old conservative guess instead of paying that.
    const s = spies()
    const d = deps({
      usage: () => ({ atMs: Date.now(), error: 'credential-rejected' }),
      credentialRecovery: s.credentialRecovery,
    })
    const usage = await buildWebUsage(d, 'cn', { detail: 'fast' })
    if (usage.status !== 'signed-in') throw new Error('expected signed-in')
    expect(usage.credentialRejected).toBe(true)
    expect(usage.recovery).toBeDefined()
    expect(s.credentialRecovery).not.toHaveBeenCalled()
  })

  it('still builds the pool for a signed-out region, so the add-PAT entry point exists', async () => {
    const s = spies()
    const storeSignedOut: QoderAccountDeps = { ...store(), accounts: async () => [], resolve: async () => undefined }
    const d = deps({
      store: () => storeSignedOut,
      pool: poolDeps({ memberCredits: s.memberCredits, cachedMemberCredits: s.cachedMemberCredits }),
    })
    const usage = await buildWebUsage(d, 'cn', { detail: 'fast' })
    if (usage.status !== 'signed-out') throw new Error('expected signed-out')
    expect(usage.pool).toBeDefined()
    expect(usage.pool?.accounts).toHaveLength(0)
    expect(s.memberCredits).not.toHaveBeenCalled()
  })
})

describe('the usage route', () => {
  it('serves the fast document for `&detail=fast` and the full one otherwise', async () => {
    const s = spies()
    const captured = await mountRoutes(deps({ refreshUsage: s.refreshUsage, pool: poolDeps({ memberCredits: s.memberCredits }) }))
    const handler = captured.find(entry => entry.path === QODER_USAGE_PATH)?.handler
    if (handler === undefined) throw new Error('usage route not registered')

    const fast = response()
    await handler(usageRequest(`${QODER_USAGE_PATH}?region=cn&detail=fast`), fast.res)
    expect(fast.status()).toBe(200)
    expect(s.refreshUsage).not.toHaveBeenCalled()
    expect(s.memberCredits).not.toHaveBeenCalled()
    const fastBody = fast.body() as { status: string, pool?: { accounts: readonly unknown[] } }
    expect(fastBody.status).toBe('signed-in')
    // Only the first-paint document carries rows (the fixture pool has no
    // cachedMemberCredits dep wired here, so the block is omitted — see the
    // dedicated test above; the point here is that nothing upstream ran).

    // Absent detail = the full document, exactly as before this parameter existed.
    const full = response()
    await handler(usageRequest(`${QODER_USAGE_PATH}?region=cn`), full.res)
    expect(full.status()).toBe(200)
    expect(s.refreshUsage).toHaveBeenCalledTimes(1)
    expect(s.memberCredits).toHaveBeenCalledTimes(1)
  })

  it('degrades an unknown detail value to the full document', async () => {
    const s = spies()
    const captured = await mountRoutes(deps({ refreshUsage: s.refreshUsage, pool: poolDeps({ memberCredits: s.memberCredits }) }))
    const handler = captured.find(entry => entry.path === QODER_USAGE_PATH)?.handler
    if (handler === undefined) throw new Error('usage route not registered')

    const answer = response()
    await handler(usageRequest(`${QODER_USAGE_PATH}?region=cn&detail=fastest`), answer.res)
    expect(answer.status()).toBe(200)
    // A typo must never produce a thinner panel: this went down the full path.
    expect(s.refreshUsage).toHaveBeenCalledTimes(1)
    expect(s.memberCredits).toHaveBeenCalledTimes(1)
  })

  it('keeps the region guard intact for fast documents', async () => {
    const captured = await mountRoutes(deps())
    const handler = captured.find(entry => entry.path === QODER_USAGE_PATH)?.handler
    if (handler === undefined) throw new Error('usage route not registered')
    const answer = response()
    await handler(usageRequest(`${QODER_USAGE_PATH}?region=eu&detail=fast`), answer.res)
    expect(answer.status()).toBe(400)
  })
})
