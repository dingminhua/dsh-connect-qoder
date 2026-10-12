/**
 * Qoder Host 端浏览器路由：usage / account-credits / accounts 增删 / pool test+remove /
 * transfer / probe / __save，外加 buildWebUsage 的快照语义。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   `tests/web-status.spec.ts` —— 用假 `ctx.webServer`（capture 注册的 handler）
 *   驱动每条路由、`ctx` 上装最小 Cordis Context、`response()` 记录 writeHead/end
 *   的形态沿用。差异：Qoder 没有 OAuth / 签到路由，多出 accounts add|remove；
 *   路由按区域用 `regionOfStatusUrl`。
 *
 * 断言重点：路由是否全部注册、GET/POST/来源校验与 400/405/403、accounts 增删、
 * pool test/remove、transfer 三动作、__save 回退、以及 buildWebUsage 的
 * signed-in/signed-out + selectionLost。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { registerQoderWebRoutes, buildWebUsage } from '../src/web-status.ts'
import type { QoderWebRouteDeps, QoderAccountDeps, QoderPoolDeps, QoderTransferDeps, QoderAccountValidationDeps, QoderSettingsDeps } from '../src/web-status.ts'
import {
  QODER_ACCOUNT_CREDITS_PATH,
  QODER_ACCOUNTS_PATH,
  QODER_ACCOUNTS_REFRESH_PATH,
  QODER_MODELS_REFRESH_PATH,
  QODER_POOL_PATH,
  QODER_PROBE_PATH,
  QODER_SAVE_PATH,
  QODER_TRANSFER_PATH,
  QODER_USAGE_PATH,
} from '../src/status-paths.ts'
import type { QoderModelInfo } from '../src/catalog.ts'
import type { QoderRegion } from '../src/upstream.ts'
import type { QoderPoolProbe } from '../src/account-pool.ts'
import type { QoderWebProbeResult, QoderWebPoolTestRow, QoderWebAccountCredit } from '../src/status-paths.ts'
import { qoderAccountId } from '../src/credentials.ts'

/** One CN model info — free so pool can resolve a target. */
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

/** The vault-facing store mock the region dispatch hands out. */
function baseStore(): QoderAccountDeps {
  const vault: { id: string, pat: string, accountName: string }[] = []
  return {
    accounts: async () => [
      { id: 'pat-settings', accountName: '', source: 'settings' },
      { id: 'pat-env', accountName: '', source: 'env' },
      ...vault.map(a => ({ id: a.id, accountName: a.accountName, source: 'vault' as const })),
    ],
    credentialFor: async (accountId) =>
      accountId === 'pat-settings' ? { pat: 'pt-settings', accountName: '', source: 'settings' }
        : accountId === 'pat-env' ? { pat: 'pt-env', accountName: '', source: 'env' }
          : vault.find(a => a.id === accountId) ? { pat: (vault.find(a => a.id === accountId) as { pat: string }).pat, accountName: (vault.find(a => a.id === accountId) as { accountName: string }).accountName, source: 'vault' }
            : undefined,
    resolve: async (_sources, selectedId) =>
      selectedId !== undefined && selectedId !== ''
        ? vault.find(a => a.id === selectedId) ? { ...(vault.find(a => a.id === selectedId) as { id: string, pat: string, accountName: string }), source: 'vault' as const } : { id: 'pat-settings', pat: 'pt-settings', accountName: '', source: 'settings' as const }
        : { id: 'pat-settings', pat: 'pt-settings', accountName: '', source: 'settings' as const },
    add: async (pat, name) => {
      const id = qoderAccountId(pat)
      const existing = vault.findIndex(a => a.id === id)
      const entry = { id, pat, accountName: name }
      if (existing === -1) vault.push(entry); else vault[existing] = entry
      return { id, pat, accountName: name, addedAtMs: Date.now() }
    },
    // 删除路由据此区分「本插件存的凭据」与 settings/env 的 PAT：只有 vault 里
    // 有的 id 才可删。mock 与 accounts() 共用同一个 vault 数组，不会说谎。
    vaultAccounts: async () => vault.map(a => ({ ...a, addedAtMs: 0 })),
    remove: async (accountId) => {
      const before = vault.length
      const remaining = vault.filter(a => a.id !== accountId)
      if (remaining.length === vault.length) return false
      vault.length = 0; vault.push(...remaining)
      return before !== remaining.length
    },
    rename: async (accountId, name) => {
      const a = vault.find(x => x.id === accountId)
      if (a) a.accountName = name
    },
  }
}

/** Build a full set of route deps with sensible fake defaults. */
function deps(overrides: Partial<QoderWebRouteDeps> = {}): QoderWebRouteDeps {
  const logger = (m: string) => { void m }
  const store = baseStore()
  return {
    regionEnabled: () => true,
    regionCreditsShown: () => true,
    store: () => store,
    credentialSources: () => ({ settingsPat: 'pt-settings', envPat: undefined }),
    selectedAccountId: () => undefined,
    catalogs: { cn: { current: () => [FREE_MODEL] }, global: { current: () => [FREE_MODEL] } },
    contextBudgets: () => ({}),
    thinkingEfforts: () => ({}),
    offModelKeys: () => [],
    enabledModelKeys: () => ['dfmodel'],
    imageModelKeys: () => ['dfmodel'],
    settings: { describe: () => [], set: async () => {} } as QoderSettingsDeps,
    logger,
    usage: () => ({ usage: { credits: { total: 100, packages: [], expiringSoon: 0 }, atMs: Date.now() } }),
    ...overrides,
  }
}

/** The pool deps a `test` and `remove` route need. */
function poolDeps(overrides: Partial<QoderPoolDeps> = {}): QoderPoolDeps {
  return {
    checkinSupported: () => true,
    preferences: () => ({ enabled: true, targetModelId: 'dfmodel', probeInputTokens: 0, memberAccountIds: ['pat-settings', 'pat-env'] }),
    catalog: () => [FREE_MODEL],
    poolProbes: () => ({} as Record<string, QoderPoolProbe>),
    credentialFor: async () => ({ pat: 'pt-settings', accountName: '' }),
    probeOne: async () => ({ modelId: 'dfmodel', outcome: 'ok', status: 200 }),
    test: async () => [{ accountId: 'pat-settings', accountName: '', result: { modelId: 'dfmodel', outcome: 'ok', status: 200 } }],
    applyProbes: async () => {},
    updateMembership: () => {},
    ...overrides,
  }
}

function transferDeps(overrides: Partial<QoderTransferDeps> = {}): QoderTransferDeps {
  return {
    exportAccounts: async () => ({ accounts: [] }),
    previewImport: async () => ({ accounts: [], total: 0 }),
    importAccounts: async () => ({ imported: 0, skipped: 0 }),
    ...overrides,
  }
}

interface CapturedEntry {
  path: string
  handler: (req: unknown, res: unknown) => Promise<void> | void
}

/** Mount against a fake webServer and return the captured handlers. */
async function mountRoutes(depsFor: QoderWebRouteDeps = deps()): Promise<CapturedEntry[]> {
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

/** Find one handler by path. */
function findHandler(captured: CapturedEntry[], path: string): CapturedEntry['handler'] {
  const found = captured.find(entry => entry.path === path)
  if (found === undefined) throw new Error(`route ${path} was not registered`)
  return found.handler
}

/** Minimal request; an absent Origin header reads as loopback. */
function request(method = 'POST', origin?: string, url?: string): { method: string, url: string, headers: { origin?: string }, on: (ev: string, cb: (c: Buffer | null) => void) => void } {
  return {
    method,
    url: url ?? '/',
    headers: origin === undefined ? {} : { origin },
    on: (ev: string, cb: (c: Buffer | null) => void) => {
      // 需要读 body 的路由（accounts/transfer/__save）依赖 'end' 事件；给一个
      // 空 body 的 'end'，让 readBody 立即解包成 ''。
      if (ev === 'end') (cb as unknown as { (): void }).call(undefined)
    },
  }
}

/** A request double carrying a JSON body. Origin carries a loopback port. */
function reqWithBody(method: string, url: string, payload: unknown, origin = 'http://127.0.0.1:1') {
  const chunks = [Buffer.from(JSON.stringify(payload))]
  return {
    method,
    url,
    headers: { origin },
    on: (ev: string, cb: (c: Buffer) => void) => {
      if (ev === 'data') for (const c of chunks) cb(c)
      if (ev === 'end') (cb as unknown as { (): void }).call(undefined)
    },
  }
}

/** Response recorder: json() only needs writeHead + end. */
function response(): {
  res: { writeHead: (status: number, headers?: Record<string, string>) => void, end: (payload?: string) => void }
  status: () => number
  body: () => unknown
} {
  let statusCode = 0
  let payload = ''
  return {
    res: {
      writeHead: (status: number) => { statusCode = status },
      end: (body?: string) => { payload = body ?? '' },
    },
    status: () => statusCode,
    body: () => JSON.parse(payload),
  }
}

describe('registerQoderWebRoutes registration', () => {
  it('mounts the usage, account-credits, model-refresh, accounts-refresh, accounts, probe, pool, transfer, and save routes', async () => {
    const captured = await mountRoutes()
    expect(captured.map(entry => entry.path)).toEqual([
      QODER_USAGE_PATH,
      QODER_ACCOUNT_CREDITS_PATH,
      QODER_MODELS_REFRESH_PATH,
      QODER_ACCOUNTS_REFRESH_PATH,
      QODER_ACCOUNTS_PATH,
      QODER_PROBE_PATH,
      QODER_POOL_PATH,
      QODER_TRANSFER_PATH,
      QODER_SAVE_PATH,
    ])
  })

  it('__save 按槽位合并：保存一个区域不会抹掉另一个区域', async () => {
    // 用户实拍「保存模型保存不了」的真凶。客户端只发它要写的那**一个**区域
    // （它读不到另一侧的当前状态），路由此前直接把这份 body 整个写进 settings
    // ——于是保存 cn 模型的这一次操作会静默删掉**整个 global 槽位**。
    // 后果已经发生：磁盘上只剩 cn，global 的全部配置被抹平。
    let written: unknown
    const described = [{
      ns: 'dsh-connect-qoder',
      value: {
        regions: {
          cn: { enabled: true, enabledModelKeys: ['qfmodel'], pat: 'pt-cn' },
          global: { enabled: true, enabledModelKeys: ['gmodel'], pat: 'pt-global' },
        },
      },
    }]
    const captured = await mountRoutes(deps({
      settings: {
        describe: () => described,
        set: async (_field: string, value: unknown) => { written = value },
      } as never,
    }))
    const handler = findHandler(captured, QODER_SAVE_PATH)
    const { res, status } = response()
    await handler(reqWithBody('POST', QODER_SAVE_PATH, {
      field: 'regions',
      // 客户端实际发送的形状：只有 cn 这一个区域
      value: { cn: { enabledModelKeys: ['auto'] } },
    }), res)
    expect(status()).toBe(200)

    const regions = (written as { regions: Record<string, Record<string, unknown>> }).regions
    const cn = regions.cn!
    // 写入的区域取新值
    expect(cn.enabledModelKeys).toEqual(['auto'])
    // 同槽位里请求没提到的字段保留（客户端已做过槽位内合并）
    expect(cn.pat).toBe('pt-cn')
    // 兄弟区域必须原样保留 —— 这是这条测试的核心
    expect(regions.global).toEqual({ enabled: true, enabledModelKeys: ['gmodel'], pat: 'pt-global' })
  })

  it('模型刷新路由优先调用会落状态的 refreshModels，而非只读的 discoverModels', async () => {
    // 回归：路由此前只调 discoverModels——把新模型答给卡片，却从不写入运行时
    // 目录；卡片随后重取 usage 文档看到的仍是旧目录，「刷新」按钮刷了个寂寞，
    // 积分也因 refreshUsage 从未被触发而永远不来。
    let refreshed = 0
    let discovered = 0
    const fresh = [{ ...FREE_MODEL, key: 'qfmodel', displayName: 'Qwen3.8-Flash', priceFactor: 0, isFree: true }]
    const captured = await mountRoutes(deps({
      discoverModels: async () => { discovered++; return [] },
      refreshModels: async () => { refreshed++; return fresh },
    }))
    const handler = findHandler(captured, QODER_MODELS_REFRESH_PATH)
    const { res, status, body } = response()
    await handler(request('POST', undefined, `${QODER_MODELS_REFRESH_PATH}?region=cn`), res)
    expect(status()).toBe(200)
    expect(refreshed).toBe(1)
    expect(discovered).toBe(0)
    const answer = body() as { models: readonly { key: string, creditMultiplier?: number }[] }
    expect(answer.models[0]!.key).toBe('qfmodel')
    expect(answer.models[0]!.creditMultiplier).toBe(0)
  })
})

describe('usage route', () => {  it('answers 200 with a signed-in document for the addressed region', async () => {
    const captured = await mountRoutes()
    const usage = findHandler(captured, QODER_USAGE_PATH)
    const { res, status, body } = response()
    await usage(request('GET', undefined, `${QODER_USAGE_PATH}?region=global`), res)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({ status: 'signed-in', region: 'global' })
  })

  it('answers 405 for a non-GET', async () => {
    const captured = await mountRoutes()
    const usage = findHandler(captured, QODER_USAGE_PATH)
    const { res, status } = response()
    await usage(request('POST', undefined, `${QODER_USAGE_PATH}?region=cn`), res)
    expect(status()).toBe(405)
  })

  it('answers 400 for an unknown region', async () => {
    const captured = await mountRoutes()
    const usage = findHandler(captured, QODER_USAGE_PATH)
    const { res, status } = response()
    await usage(request('GET', undefined, `${QODER_USAGE_PATH}?region=xx`), res)
    expect(status()).toBe(400)
  })
})

describe('account-credits route', () => {
  it('answers the per-account balances', async () => {
    const creds: QoderWebAccountCredit[] = [{ id: 'pat-settings', accountName: '', selected: true, credits: 50 }]
    const captured = await mountRoutes(deps({ accountCredits: async () => creds }))
    const handler = findHandler(captured, QODER_ACCOUNT_CREDITS_PATH)
    const { res, status, body } = response()
    await handler(request('GET', undefined, `${QODER_ACCOUNT_CREDITS_PATH}?region=cn`), res)
    expect(status()).toBe(200)
    expect(body()).toEqual(creds)
  })

  it('answers 503 when accountCredits is not provided', async () => {
    const captured = await mountRoutes(deps())
    const handler = findHandler(captured, QODER_ACCOUNT_CREDITS_PATH)
    const { res, status } = response()
    await handler(request('GET', undefined, `${QODER_ACCOUNT_CREDITS_PATH}?region=cn`), res)
    expect(status()).toBe(503)
  })

  it('answers 502 when the read throws', async () => {
    const captured = await mountRoutes(deps({ accountCredits: async () => { throw new Error('upstream down') } }))
    const handler = findHandler(captured, QODER_ACCOUNT_CREDITS_PATH)
    const { res, status, body } = response()
    await handler(request('GET', undefined, `${QODER_ACCOUNT_CREDITS_PATH}?region=cn`), res)
    expect(status()).toBe(502)
    expect(body()).toMatchObject({ error: 'upstream down' })
  })
})

describe('accounts route (add|remove)', () => {
  it('adds a PAT through the vault after validation', async () => {
    let validated = 0
    const validation: QoderAccountValidationDeps = {
      validateForRegion: async (region, pat) => { validated += 1; expect(region).toBe('cn'); expect(pat).toBe('pt-new-value'); return { name: 'New User' } },
    }
    const store = baseStore()
    const captured = await mountRoutes(deps({ store: () => store, accountValidation: validation }))
    const handler = findHandler(captured, QODER_ACCOUNTS_PATH)
    const { res, status, body } = response()
    await handler(reqWithBody('POST', `${QODER_ACCOUNTS_PATH}?region=cn&action=add`, { pat: 'pt-new-value' }), res)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({ accountId: qoderAccountId('pt-new-value') })
    expect(validated).toBe(1)
    // 没填名字时才用上游解析出的那个。
    const stored = (await store.accounts({})).find(a => a.id === qoderAccountId('pt-new-value'))
    expect(stored?.accountName).toBe('New User')
  })

  it('uses the name the user typed, not the upstream one', async () => {
    // 回归：客户端一直会发 `name`，路由却完全忽略它——用户给 PAT 起的名字
    // （「公司号」）填了等于没填，列表里显示的永远是上游解析出的标识。
    const validation: QoderAccountValidationDeps = {
      validateForRegion: async () => ({ name: 'upstream-uid-1234' }),
    }
    const store = baseStore()
    const captured = await mountRoutes(deps({ store: () => store, accountValidation: validation }))
    const handler = findHandler(captured, QODER_ACCOUNTS_PATH)
    const { res, status, body } = response()
    await handler(reqWithBody('POST', `${QODER_ACCOUNTS_PATH}?region=cn&action=add`, { pat: 'pt-mine', name: '  公司号  ' }), res)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({ accountName: '公司号' })
    const stored = (await store.accounts({})).find(a => a.id === qoderAccountId('pt-mine'))
    expect(stored?.accountName).toBe('公司号')
  })

  it('keeps a blank name blank so the card can say "unnamed"', async () => {
    const validation: QoderAccountValidationDeps = { validateForRegion: async () => ({ name: '' }) }
    const store = baseStore()
    const captured = await mountRoutes(deps({ store: () => store, accountValidation: validation }))
    const handler = findHandler(captured, QODER_ACCOUNTS_PATH)
    const { res, status } = response()
    await handler(reqWithBody('POST', `${QODER_ACCOUNTS_PATH}?region=cn&action=add`, { pat: 'pt-anon', name: '   ' }), res)
    expect(status()).toBe(200)
    const stored = (await store.accounts({})).find(a => a.id === qoderAccountId('pt-anon'))
    expect(stored?.accountName).toBe('')
  })

  it('removes a vault account', async () => {
    const store = baseStore()
    const stored = await store.add('pt-remove-me-value', 'ToRemove')
    const captured = await mountRoutes(deps({ store: () => store }))
    const handler = findHandler(captured, QODER_ACCOUNTS_PATH)
    const { res, status, body } = response()
    await handler(reqWithBody('POST', `${QODER_ACCOUNTS_PATH}?region=cn&action=remove`, { accountId: stored.id }), res)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({ removed: true })
  })

  it('answers 400 when an invalid action is supplied', async () => {
    const captured = await mountRoutes()
    const handler = findHandler(captured, QODER_ACCOUNTS_PATH)
    const { res, status, body } = response()
    await handler(reqWithBody('POST', `${QODER_ACCOUNTS_PATH}?region=cn&action=rename`, {}), res)
    expect(status()).toBe(400)
    expect(body()).toMatchObject({ error: 'action is required (add|remove)' })
  })

  it('refuses a non-loopback origin with 403', async () => {
    const captured = await mountRoutes()
    const handler = findHandler(captured, QODER_ACCOUNTS_PATH)
    const { res, status } = response()
    await handler(request('POST', 'https://evil.example.com', `${QODER_ACCOUNTS_PATH}?region=cn&action=remove`), res)
    expect(status()).toBe(403)
  })
})

describe('pool route (test|remove)', () => {
  it('pool 目录带上真实倍率与显示名（选项标签要用它们定价）', async () => {
    // 双缺陷回归：路由层曾只对免费模型写 `creditMultiplier: 0`，付费模型一个
    // 数字都没有——下拉选项读起来像免费；而选项文本更早还直接渲染模型 **id**
    // （`dfmodel`），用户既不认识、也无从判断花不花积分。
    const pools = [
      { ...FREE_MODEL, key: 'gm51model', displayName: 'GLM-5.2', isFree: false, priceFactor: 0.79 },
      { ...FREE_MODEL, key: 'dfmodel', displayName: 'DeepSeek-V4-Flash', isFree: true, priceFactor: 0 },
    ]
    const d = deps({
      catalogs: { cn: { current: () => pools }, global: { current: () => pools } },
      pool: poolDeps({ catalog: () => pools }),
    })
    const usage = await buildWebUsage(d, 'cn')
    if (usage.status !== 'signed-in') throw new Error('expected signed-in')
    const byId = Object.fromEntries((usage.pool?.catalog ?? []).map(m => [m.id, m]))
    expect(byId['gm51model']?.name).toBe('GLM-5.2')
    expect(byId['gm51model']?.creditMultiplier).toBe(0.79)
    expect(byId['dfmodel']?.creditMultiplier).toBe(0)
  })

  it('answers a test batch with the resolved model and rows', async () => {
    const pool = poolDeps()
    const captured = await mountRoutes(deps({ pool }))
    const handler = findHandler(captured, QODER_POOL_PATH)
    const { res, status, body } = response()
    await handler(request('POST', undefined, `${QODER_POOL_PATH}?region=cn&action=test`), res)
    expect(status()).toBe(200)
    const answer = body() as { action: string, modelId?: string, rows: readonly QoderWebPoolTestRow[] }
    expect(answer.action).toBe('test')
    expect(answer.modelId).toBe('dfmodel')
    expect(answer.rows).toHaveLength(1)
  })

  it('answers an empty batch when no target model can resolve', async () => {    // 目标的求解读的是 `pool.catalog(region)`（路由层投影 `poolModelOf`），当目标
    // 目录里没有任何免费模型时 `targetModelId` 无从解析，行必须为空、绝不调用 test。
    let tested = false
    const pool = poolDeps({
      preferences: () => ({ enabled: true, targetModelId: '', probeInputTokens: 0, memberAccountIds: [] }),
      catalog: () => [{ ...FREE_MODEL, isFree: false, priceFactor: 2 }],
      test: async () => { tested = true; return [] },
    })
    const captured = await mountRoutes(deps({ pool }))
    const handler = findHandler(captured, QODER_POOL_PATH)
    const { res, status, body } = response()
    await handler(request('POST', undefined, `${QODER_POOL_PATH}?region=cn&action=test`), res)
    expect(status()).toBe(200)
    const answer = body() as { action: string, rows: readonly unknown[] }
    expect(answer.rows).toEqual([])
    expect(tested).toBe(false)
  })

  it('answers 503 when no pool deps are provided', async () => {
    const captured = await mountRoutes(deps())
    const handler = findHandler(captured, QODER_POOL_PATH)
    const { res, status } = response()
    await handler(request('POST', undefined, `${QODER_POOL_PATH}?region=cn&action=test`), res)
    expect(status()).toBe(503)
  })

  // ==========================================================================
  // remove = 彻底删除（凭据 + 池成员 + 区域选择）。
  // 此前这一支只做了「从 memberAccountIds 剔掉」，也就是**移出池**，却长得像删除：
  // 用户点它期望账号消失，PAT 却留在 vault 里，「全选」一下又回来了
  // （用户实拍：「删除唯一的号，但是号并没有删除干净」）。移出池现在只由勾选框表达。
  // ==========================================================================

  it('deletes the vault entry, not just the pool membership', async () => {
    const store = baseStore()
    await store.add('pt-del-me', 'del-me')
    const target = qoderAccountId('pt-del-me')
    const pool = poolDeps({ preferences: () => ({ enabled: true, targetModelId: '', probeInputTokens: 0, memberAccountIds: [target] }) })
    const captured = await mountRoutes(deps({ pool, store: () => store }))
    const handler = findHandler(captured, QODER_POOL_PATH)
    const { res, status, body } = response()
    await handler(request('POST', undefined, `${QODER_POOL_PATH}?region=cn&action=remove&accountId=${target}`), res)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({ removed: true })
    // **凭据真的没了** —— 这是整条路由存在的理由。旧实现只动 memberAccountIds，
    // 这里断言的是 vault 里那条记录本身，所以它能接住那次回归。
    expect(await store.vaultAccounts()).toEqual([])
    expect((await store.accounts({ settingsPat: 'pt-settings' })).map(a => a.id)).not.toContain(target)
  })

  it('clears the config residue: the pool membership AND a selection pointing at it', async () => {
    const store = baseStore()
    await store.add('pt-del-me', 'del-me')
    const target = qoderAccountId('pt-del-me')
    const kept: string[][] = []
    const cleared: QoderRegion[] = []
    const pool = poolDeps({
      preferences: () => ({ enabled: true, targetModelId: '', probeInputTokens: 0, memberAccountIds: ['pat-settings', target] }),
      updateMembership: (_r, ids) => { kept.push([...ids]) },
    })
    const captured = await mountRoutes(deps({
      pool,
      store: () => store,
      selectedAccountId: () => target,
      clearSelection: region => { cleared.push(region) },
    }))
    const handler = findHandler(captured, QODER_POOL_PATH)
    const { res, status } = response()
    await handler(request('POST', undefined, `${QODER_POOL_PATH}?region=cn&action=remove&accountId=${target}`), res)
    expect(status()).toBe(200)
    // 两处残骸都要收：memberAccountIds 否则会留下一条勾不上的幽灵 id，
    // accountId 否则会让卡片一直说「所选账号已不存在」。
    expect(kept.at(-1)).toEqual(['pat-settings'])
    expect(cleared).toEqual(['cn'])
  })

  it('leaves the selection alone when it points at some other account', async () => {
    const store = baseStore()
    await store.add('pt-del-me', 'del-me')
    const target = qoderAccountId('pt-del-me')
    let cleared = false
    const pool = poolDeps({ preferences: () => ({ enabled: true, targetModelId: '', probeInputTokens: 0, memberAccountIds: [target] }) })
    const captured = await mountRoutes(deps({
      pool,
      store: () => store,
      selectedAccountId: () => 'pat-settings',
      clearSelection: () => { cleared = true },
    }))
    const handler = findHandler(captured, QODER_POOL_PATH)
    const { res, status } = response()
    await handler(request('POST', undefined, `${QODER_POOL_PATH}?region=cn&action=remove&accountId=${target}`), res)
    expect(status()).toBe(200)
    // 删 A 不该动用户为 B 做的选择 —— 否则一次删除会顺手改掉另一件事。
    expect(cleared).toBe(false)
  })

  it('refuses a settings/env PAT instead of reporting a removal that changed nothing', async () => {
    const pool = poolDeps()
    const captured = await mountRoutes(deps({ pool, store: () => baseStore() }))
    const handler = findHandler(captured, QODER_POOL_PATH)
    const { res, status, body } = response()
    await handler(request('POST', undefined, `${QODER_POOL_PATH}?region=cn&action=remove&accountId=${qoderAccountId('pt-settings')}`), res)
    // 409 而不是 200：那个 PAT 不在本插件的保险库里，删 vault 条目对它无效。
    // 回 200 会让用户以为删掉了，其实它下一次读取时还在（凭据来自插件之外）。
    expect(status()).toBe(409)
    expect(body()).toMatchObject({ reason: 'account-not-deletable' })
  })

  it('answers 400 for a malformed account id before touching the store', async () => {
    const pool = poolDeps()
    const captured = await mountRoutes(deps({ pool }))
    const handler = findHandler(captured, QODER_POOL_PATH)
    const { res, status } = response()
    await handler(request('POST', undefined, `${QODER_POOL_PATH}?region=cn&action=remove&accountId=..%2Fetc%2Fpasswd`), res)
    expect(status()).toBe(400)
  })

  it('answers 400 when remove names no account', async () => {
    const pool = poolDeps()
    const captured = await mountRoutes(deps({ pool }))
    const handler = findHandler(captured, QODER_POOL_PATH)
    const { res, status } = response()
    await handler(request('POST', undefined, `${QODER_POOL_PATH}?region=cn&action=remove`), res)
    expect(status()).toBe(400)
  })
})

describe('transfer route', () => {
  it('answers export with the region and no account-selection requirement', async () => {
    const handled: string[] = []
    // The export answer must carry the TRANSFER-FILE shape (access_token / uid /
    // nickname / domain). It used to echo the vault's internal fields
    // (pat / accountName / id), which is what made every exported file
    // unimportable — see the round-trip regression in transfer.spec.ts.
    const transfer = transferDeps({ exportAccounts: async (region) => {
      handled.push(region)
      return { accounts: [{ access_token: 'pt-x', uid: 'pat-x', nickname: 'A', domain: 'qoder.sh' }] }
    } })
    const captured = await mountRoutes(deps({ transfer }))
    const handler = findHandler(captured, QODER_TRANSFER_PATH)
    const { res, status, body } = response()
    await handler(reqWithBody('POST', `${QODER_TRANSFER_PATH}?region=global&action=export`, {}), res)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({ accounts: [{ access_token: 'pt-x', uid: 'pat-x', nickname: 'A', domain: 'qoder.sh' }] })
    expect(handled).toEqual(['global'])
  })

  it('answers preview with the desensitized listing and import with the counters', async () => {
    const seenIndexes: number[][] = []
    const transfer = transferDeps({
      previewImport: async () => ({ accounts: [{ index: 0, uid: 'u-1', nickname: 'n', email: '', hasToken: true }], total: 1 }),
      importAccounts: async (_r, _t, indexes) => { seenIndexes.push([...indexes]); return { imported: 1, skipped: 2 } },
    })
    const captured = await mountRoutes(deps({ transfer }))
    const handler = findHandler(captured, QODER_TRANSFER_PATH)
    const preview = response()
    await handler(reqWithBody('POST', `${QODER_TRANSFER_PATH}?region=cn&action=preview`, { text: '[{"access_token":"t"}]' }), preview.res)
    expect(preview.status()).toBe(200)
    expect(preview.body()).toMatchObject({ total: 1 })
    const imported = response()
    await handler(reqWithBody('POST', `${QODER_TRANSFER_PATH}?region=cn&action=import`, { text: '[{"access_token":"t"}]', indexes: [0, 3] }), imported.res)
    expect(imported.status()).toBe(200)
    expect(imported.body()).toMatchObject({ imported: 1, skipped: 2 })
    expect(seenIndexes).toEqual([[0, 3]])
  })

  it('answers 400 when the body is not valid JSON', async () => {
    const transfer = transferDeps()
    const captured = await mountRoutes(deps({ transfer }))
    const handler = findHandler(captured, QODER_TRANSFER_PATH)
    const { res, status, body } = response()
    const bad = {
      method: 'POST', url: `${QODER_TRANSFER_PATH}?region=cn&action=preview`, headers: { origin: 'http://127.0.0.1:1' },
      on: (ev: string, cb: (c: Buffer) => void) => {
        if (ev === 'data') cb(Buffer.from('{ not json'))
        if (ev === 'end') (cb as unknown as { (): void }).call(undefined)
      },
    }
    await handler(bad, res)
    expect(status()).toBe(400)
    expect(body()).toMatchObject({ error: 'invalid JSON body' })
  })
})

describe('probe route', () => {
  it('answers the probe result for the addressed model', async () => {
    const seen: { region: string, model: string }[] = []
    const captured = await mountRoutes(deps({
      probeModel: async (region, model) => { seen.push({ region, model }); return { modelId: model, outcome: 'ok', status: 200 } },
    }))
    const handler = findHandler(captured, QODER_PROBE_PATH)
    const { res, status, body } = response()
    await handler(request('GET', undefined, `${QODER_PROBE_PATH}?region=global&model=qmodel`), res)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({ outcome: 'ok', modelId: 'qmodel' })
    expect(seen).toEqual([{ region: 'global', model: 'qmodel' }])
  })

  it('answers 400 when no model is named', async () => {
    const captured = await mountRoutes()
    const handler = findHandler(captured, QODER_PROBE_PATH)
    const { res, status } = response()
    await handler(request('GET', undefined, `${QODER_PROBE_PATH}?region=cn`), res)
    expect(status()).toBe(400)
  })
})

describe('__save route', () => {
  it('writes field/value through the deps and answers ok', async () => {
    const set: { field: string, value: unknown }[] = []
    const settings: QoderSettingsDeps = { describe: () => [], set: async (f, v) => { set.push({ field: f, value: v }) } }
    const captured = await mountRoutes(deps({ settings }))
    const handler = findHandler(captured, QODER_SAVE_PATH)
    const { res, status, body } = response()
    await handler(reqWithBody('POST', QODER_SAVE_PATH, { field: 'regions.cn.enabled', value: false }), res)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({ ok: true })
    expect(set).toEqual([{ field: 'regions.cn.enabled', value: false }])
  })

  it('answers 400 when the field is blank', async () => {
    const captured = await mountRoutes()
    const handler = findHandler(captured, QODER_SAVE_PATH)
    const { res, status } = response()
    await handler(request('POST', undefined, QODER_SAVE_PATH), res)
    expect(status()).toBe(400)
  })
})

describe('buildWebUsage', () => {
  it('a rejected credential is REPORTED, never silently blank', async () => {
    // 回归：过期 PAT 曾表现为「积分一片空白，且没有任何提示」——上游 401 被
    // fetchUsage 静默吞成 undefined，宿主于是走成功分支写入 `{usage: undefined}`，
    // 既无 credits 也无 creditsError，卡片只能显示空白。现在拒绝必须说出来。
    const d = deps({
      usage: () => ({ atMs: Date.now(), error: 'credential-rejected' }),
    })
    const usage = await buildWebUsage(d, 'cn')
    if (usage.status !== 'signed-in') throw new Error('expected signed-in')
    expect(usage.credentialRejected).toBe(true)
    // fixture 有 settings + env 两个账号，所以不要求「重新添加 PAT」——正确
    // 的说法是「试试切到另一个」（reloginRequired 只在账号数 ≤ 1 时置位）。
    expect(usage.recovery?.reloginRequired).toBe(false)
    expect(usage.recovery?.usableAccount).toBeUndefined()
  })

  it('a rejected credential with a single account asks for a new PAT', async () => {
    // 只剩一个账号时「切换到另一个」无从谈起，唯一的出路是添加新 PAT。
    const store: QoderAccountDeps = {
      ...baseStore(),
      accounts: async () => [{ id: 'pat-settings', accountName: 'Only', source: 'settings' }],
    }
    const d = deps({
      store: () => store,
      credentialSources: () => ({ settingsPat: 'pt-only', envPat: undefined }),
      usage: () => ({ atMs: Date.now(), error: 'credential-rejected' }),
    })
    const usage = await buildWebUsage(d, 'cn')
    if (usage.status !== 'signed-in') throw new Error('expected signed-in')
    expect(usage.accounts).toHaveLength(1)
    expect(usage.credentialRejected).toBe(true)
    expect(usage.recovery?.reloginRequired).toBe(true)
  })

  it('the credits column reports the upstream message instead of vanishing', async () => {
    const d = deps({
      usage: () => ({ atMs: Date.now(), error: 'token is not active' }),
    })
    const usage = await buildWebUsage(d, 'cn')
    if (usage.status !== 'signed-in') throw new Error('expected signed-in')
    expect(usage.credits).toBeUndefined()
    expect(usage.creditsError).toContain('token is not active')
  })

  it('carries a signed-in document with models, accounts, and the pool', async () => {
    const d = deps({ pool: poolDeps() })
    const usage = await buildWebUsage(d, 'cn')
    if (usage.status !== 'signed-in') throw new Error('expected signed-in')
    expect(usage.accounts).toHaveLength(2) // settings + env（初始 vault 为空）
    expect(usage.models.length).toBe(1)
    // 签到：CN 支持（route 的 poolDeps 里 checkinSupported 返回 true），
    // 文档如实回报。此前这里断言的是「恒为 false」——那正是被误判的功能。
    expect(usage.pool?.checkinSupported).toBe(true)
    expect(usage.pool?.targetModelSource).toBe('preferred')
    // 倍率为 1 也必须透传（卡片渲染 `(1.00x)`）：webModelOf 曾把 1 当「无」
    // 丢掉，卡片上只剩没倍率的裸名字。
    expect(usage.models[0]!.creditMultiplier).toBe(1)
  })

  it('marks as `current` the account actually serving, not the first row or the target model', async () => {
    // 回归：`current` 曾由「测试目标模型 id」与「列表第 0 行」推导，于是在没有显式
    // 选择时会宣称第一个账号正在计费——而真实在计费的是 resolve() 给出的那个。
    // 这里让 resolve 指向第二行（env），断言 current 落在它身上、第一行为 false。
    const store: QoderAccountDeps = {
      ...baseStore(),
      accounts: async () => [
        { id: 'pat-settings', accountName: '', source: 'settings' },
        { id: 'pat-env', accountName: 'Env', source: 'env' },
      ],
      resolve: async () => ({ id: 'pat-env', pat: 'pt-env', accountName: 'Env', source: 'env' }),
    }
    const d = deps({
      store: () => store,
      credentialSources: () => ({ settingsPat: 'pt-settings', envPat: 'pt-env' }),
      pool: poolDeps({ preferences: () => ({ enabled: false, targetModelId: '', memberAccountIds: ['pat-env'] }) }),
    })
    const usage = await buildWebUsage(d, 'cn')
    if (usage.status !== 'signed-in') throw new Error('expected signed-in')
    expect((usage.pool?.accounts ?? []).map(r => [r.accountId, r.current])).toEqual([
      ['pat-settings', false],
      ['pat-env', true],
    ])
  })

  it('pool rows carry member credits (total/expiringSoon/nearestExpiry), non-members stay unknown', async () => {
    // 成员表积分列的数据通路：memberCredits 按成员 id 读，读到的成员行得到
    // total/expiringSoon/nearestExpiryMs 三件套；没读到（凭据失效/上游拒绝）
    // 的成员行保持「—」（字段缺席）而不是一个编出来的 0。
    const memberCredits = new Map([
      ['pat-settings', { total: 1200, expiringSoon: 300, nearestExpiryMs: 1_800_000_000_000 }],
    ])
    const d = deps({
      pool: poolDeps({ memberCredits: async (_region, ids) => new Map([...memberCredits].filter(([id]) => ids.includes(id))) }),
    })
    const usage = await buildWebUsage(d, 'cn')
    if (usage.status !== 'signed-in') throw new Error('expected signed-in')
    const rows = usage.pool?.accounts ?? []
    const settingsRow = rows.find(r => r.accountId === 'pat-settings')
    expect(settingsRow?.credits).toBe(1200)
    expect(settingsRow?.expiringSoon).toBe(300)
    expect(settingsRow?.nearestExpiryMs).toBe(1_800_000_000_000)
    const envRow = rows.find(r => r.accountId === 'pat-env')
    expect(envRow?.credits).toBeUndefined()
    expect(envRow?.expiringSoon).toBeUndefined()
  })

  it('still serves the pool view when nothing resolves, so accounts can be added', async () => {
    // 这一支**必须**带 pool：账号池是「添加 PAT / 导入账号」的唯一入口，而
    // 「一个账号都没有」恰恰是最需要它的状态。此前刻意不带 pool（「不出现 pool 段
    // 就等于没有账号正在使用」），结果最需要添加账号的页面反而没有添加入口。
    // 「没有正在计费的账号」现在由每行的 `current` 表达（无账号时自然全为 false）。
    const store: QoderAccountDeps = { ...baseStore(), accounts: async () => [], resolve: async () => undefined }
    const d = deps({
      store: () => store,
      pool: poolDeps({ preferences: () => ({ enabled: false, targetModelId: '', memberAccountIds: [] }) }),
    })
    const usage = await buildWebUsage(d, 'cn')
    expect(usage.status).toBe('signed-out')
    if (usage.status !== 'signed-out') throw new Error('expected signed-out')
    expect(usage.accounts).toHaveLength(0)
    expect(usage.pool).toBeDefined()
    expect(usage.pool?.accounts).toHaveLength(0)
    // 没有任何账号 → 没有任何一行可以被称为「当前使用」。
    expect(usage.pool?.accounts.some(row => row.current)).toBe(false)
  })

  it('omits the pool view entirely when the host serves no pool deps', async () => {
    // 反向保证：没有 pool dep（旧宿主）时不凭空造一个池。
    const store: QoderAccountDeps = { ...baseStore(), accounts: async () => [], resolve: async () => undefined }
    const d = deps({ store: () => store })
    const usage = await buildWebUsage(d, 'cn')
    if (usage.status !== 'signed-out') throw new Error('expected signed-out')
    expect(usage.pool).toBeUndefined()
  })

  it('reports signed-out with selectionLost when the saved id matches no credential but accounts exist', async () => {
    const store: QoderAccountDeps = {
      ...baseStore(),
      accounts: async () => [{ id: 'pat-stored', accountName: 'Stored', source: 'vault' }],
      resolve: async () => undefined,
    }
    const d = deps({ store: () => store, selectedAccountId: () => 'pat-ghost' })
    const usage = await buildWebUsage(d, 'cn')
    if (usage.status !== 'signed-out') throw new Error('expected signed-out')
    expect(usage.selectionLost).toBe(true)
    expect(usage.accounts).toHaveLength(1)
    expect(usage.message).toContain('所选账号已不存在')
  })

  it('does not flag selectionLost when there is genuinely nothing stored', async () => {
    const store: QoderAccountDeps = {
      ...baseStore(),
      accounts: async () => [],
      resolve: async () => undefined,
    }
    const d = deps({ store: () => store, selectedAccountId: () => '' })
    const usage = await buildWebUsage(d, 'cn')
    if (usage.status !== 'signed-out') throw new Error('expected signed-out')
    expect(usage.selectionLost).toBe(false)
    expect(usage.message).toContain('请填写 Qoder PAT')
  })

  it('reports the selectionExplicit flag for an explicit saved choice', async () => {
    const d = deps({ selectedAccountId: () => 'pat-settings' })
    const usage = await buildWebUsage(d, 'cn')
    if (usage.status !== 'signed-in') throw new Error('expected signed-in')
    expect(usage.selectionExplicit).toBe(true)
  })
})