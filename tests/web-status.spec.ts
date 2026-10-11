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
})

describe('usage route', () => {
  it('answers 200 with a signed-in document for the addressed region', async () => {
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

  it('answers an empty batch when no target model can resolve', async () => {
    // 目标的求解读的是 `pool.catalog(region)`（路由层投影 `poolModelOf`），当目标
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

  it('removes one account\'s membership', async () => {
    const removed: string[] = []
    const pool = poolDeps({ updateMembership: (_r, ids) => { removed.push(...ids) } })
    const captured = await mountRoutes(deps({ pool }))
    const handler = findHandler(captured, QODER_POOL_PATH)
    const { res, status, body } = response()
    await handler(request('POST', undefined, `${QODER_POOL_PATH}?region=cn&action=remove&accountId=pat-env`), res)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({ removed: true })
    // 原成员 去掉 pat-env。
    expect(removed).toEqual(['pat-settings'])
  })
})

describe('transfer route', () => {
  it('answers export with the region and no account-selection requirement', async () => {
    const handled: string[] = []
    const transfer = transferDeps({ exportAccounts: async (region) => { handled.push(region); return { accounts: [{ pat: 'pt-x', accountName: 'A', id: 'pat-x' }] } } })
    const captured = await mountRoutes(deps({ transfer }))
    const handler = findHandler(captured, QODER_TRANSFER_PATH)
    const { res, status, body } = response()
    await handler(reqWithBody('POST', `${QODER_TRANSFER_PATH}?region=global&action=export`, {}), res)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({ accounts: [{ pat: 'pt-x', accountName: 'A', id: 'pat-x' }] })
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
  it('carries a signed-in document with models, accounts, and the pool', async () => {
    const d = deps({ pool: poolDeps() })
    const usage = await buildWebUsage(d, 'cn')
    if (usage.status !== 'signed-in') throw new Error('expected signed-in')
    expect(usage.accounts).toHaveLength(2) // settings + env（初始 vault 为空）
    expect(usage.models.length).toBe(1)
    expect(usage.pool?.checkinSupported).toBe(false)
    expect(usage.pool?.targetModelSource).toBe('preferred')
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