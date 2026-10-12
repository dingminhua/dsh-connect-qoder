import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import * as Qoder from '../src/index.ts'

/**
 * The 0.1.7-shaped settings service the suite mounts so the plugin's
 * `inject: ['llm', 'settings']` gate can resolve. The plugin reads config by
 * closure, and settings writes are announced via `loader/volatile-update`.
 */
class MemorySettings extends Service {
  readonly writable = true
  constructor(ctx: Context) {
    super(ctx, 'settings')
  }
  describe() {
    return []
  }
}

let context: Context | undefined
let liveConfig: Record<string, unknown> = {}

/** Mount the plugin with a DIRECT `apply()` call (config under test control). */
async function mountQoder(ctx: Context, config: Record<string, unknown>): Promise<void> {
  liveConfig = config
  Qoder.apply(ctx, config as unknown as Qoder.Config)
  // 等 shim 就绪与注册落地（apply 内部 await 链）。
  await waitFor(() => ctx.llm.listProviders().some(p => p.id === 'qoder'))
}

/** 模拟 Loader 的 volatile 写入：原地改 config 并广播。 */
function volatileWrite(patch: (config: Record<string, unknown>) => void): void {
  patch(liveConfig)
  ;(context as unknown as { emit(name: string): void }).emit('loader/volatile-update')
}

function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      try {
        if (cond()) {
          resolve()
          return
        }
      } catch { /* 继续等 */ }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('waitFor timeout'))
        return
      }
      setTimeout(tick, 25)
    }
    tick()
  })
}

beforeEach(() => {
  delete process.env.QODER_PERSONAL_ACCESS_TOKEN
  delete process.env.QODERCN_PERSONAL_ACCESS_TOKEN
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('保存的模型目录会保留思考强度与上下文档位', () => {
  // 用户实拍「拉取的思考模式又不见了」。根因：客户端**确实**把 thinkingEfforts /
  // defaultThinkingEffort / contextTiers 写进了 payload，但宿主的 `modelConfig`
  // 没有声明这三个字段，schemastery 解析时把它们**静默剥掉** —— 于是重启后模型
  // 行不再显示档位选择器（`thinkingEfforts === undefined` → 卡片不渲染该项）。
  // 声明齐全后，下面用真实的 region schema 验证「保存 → 读回」不再丢字段。
  const regionShape = z.object({
    lastCatalog: z.array(z.object({
      key: z.string(),
      displayName: z.string(),
      priceFactor: z.number(),
      contextWindow: z.number(),
      maxOutputTokens: z.number(),
      supportsImages: z.boolean(),
      supportsThinking: z.boolean(),
      canDisableThinking: z.boolean(),
      isDefault: z.boolean(),
      isFree: z.boolean(),
      isNew: z.boolean(),
      thinkingEfforts: z.array(z.string()).required(false),
      defaultThinkingEffort: z.string().required(false),
      contextTiers: z.array(z.number()).required(false),
    })).default([]),
  })

  it('round-trips the three fields the card needs', () => {
    const parsed = regionShape({
      lastCatalog: [{
        key: 'qfmodel', displayName: 'Qwen3.8-Flash', priceFactor: 0,
        contextWindow: 200_000, maxOutputTokens: 32_768,
        supportsImages: false, supportsThinking: true, canDisableThinking: false,
        isDefault: false, isFree: true, isNew: false,
        thinkingEfforts: ['low', 'medium', 'xhigh'],
        defaultThinkingEffort: 'medium',
        contextTiers: [200_000, 400_000, 1_000_000],
      }],
    } as never) as { lastCatalog: Array<Record<string, unknown>> }
    const model = parsed.lastCatalog[0]!
    expect(model.thinkingEfforts).toEqual(['low', 'medium', 'xhigh'])
    expect(model.defaultThinkingEffort).toBe('medium')
    expect(model.contextTiers).toEqual([200_000, 400_000, 1_000_000])
  })
})

describe('Qoder provider registration', () => {
  it('registers both regional providers, settings, and fallback models after shim startup', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountQoder(ctx, { regions: {} })

    await expect.poll(() => ctx.llm.listProviders().map(p => p.id)).toContain('qoder')
    await expect.poll(() => ctx.llm.listProviders().map(p => p.id)).toContain('qoder-global')

    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'qoder', displayName: 'Qoder', settingsNs: 'dsh-connect-qoder', settingsPath: [], declared: false,
    })
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'qoder-global', displayName: 'Qoder Global', settingsNs: 'dsh-connect-qoder', settingsPath: [], declared: false,
    })

    // 每区域服务自己的 fallback 目录。
    const cnModels = await ctx.llm.listModels('qoder')
    expect(cnModels.map(m => m.id)).toContain('qmodel_latest')
    expect(cnModels.map(m => m.id)).toContain('dmodel')
    const globalModels = await ctx.llm.listModels('qoder-global')
    expect(globalModels.length).toBeGreaterThan(0)
    expect(globalModels.map(m => m.id)).toEqual(cnModels.map(m => m.id))
  })

  it('卡片读实时目录而不是保存快照（否则思考档位永远出不来）', async () => {
    // 用户实拍「还是没有思考强度」——即使刚点过「从 Qoder 刷新」。
    // 原因：卡片读的 displayModels() 优先返回**保存的 lastCatalog**，那是上一次
    // 保存时的快照；上游新声明的档位（thinking_config）只存在于实时目录里。
    // 更糟的是旧 schema 曾把档位字段从 lastCatalog 里剥掉，快照里永远没有。
    // 现在实时目录优先。
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    // 配置里放一份**故意陈旧**的快照（显示名 STALE、没有档位）。
    await mountQoder(ctx, {
      regions: {
        cn: {
          enabledModelKeys: ['qfmodel'],
          lastCatalog: [{
            key: 'qfmodel', displayName: 'STALE', priceFactor: 0,
            contextWindow: 200_000, maxOutputTokens: 32_768,
            supportsImages: true, supportsThinking: true, canDisableThinking: true,
            isDefault: false, isFree: true, isNew: false,
          }],
        },
      },
    })
    // 兜底目录生效（还没有实时目录时）：名字不应是陈旧快照里那个。
    const models = await ctx.llm.listModels('qoder')
    expect(models.map(m => m.id)).toContain('qfmodel')
    // 兜底列表里不会带 STALE 这个名字（那只会来自 lastCatalog）
    expect(models.map(m => m.name)).not.toContain('STALE')
  })

  it('DSH 选择器里的模型名带倍率（用户实拍「没有倍数显示」）', async () => {
    // 卡片自己的选择器一直会画倍率，但 **DSH 内置的模型选择器**读的是适配器
    // 交给它的 `name`。那里此前传的是裸名字（`info.displayName`），于是同一个
    // 模型在两处显示得不一样。workbuddy 传的是 workBuddyDisplayName（带倍率）。
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountQoder(ctx, { regions: {} })

    const models = await ctx.llm.listModels('qoder')
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) {
      expect(model.name).toMatch(/ · x\d+\.\d{2}$/)
    }
  })

  it('withdraws a disabled region and restores it on re-enable', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountQoder(ctx, { regions: {} })
    await expect.poll(() => ctx.llm.listProviders().map(p => p.id)).toContain('qoder-global')

    // 禁用 global：adapter 路由被 replace([]) 撤下，provider 从列表消失、
    // 目录条目撤回——模型选择器里的分组整体消失。
    volatileWrite(config => {
      config.regions = { 'global': { enabled: false } }
    })
    await waitFor(() => !ctx.llm.listProviders().some(p => p.id === 'qoder-global'))
    expect(ctx.llm.listConfigurableProviders().some(p => p.provider === 'qoder-global')).toBe(false)
    await expect(ctx.llm.listModels('qoder-global')).rejects.toThrow(/no adapter/i)

    // 重新启用后目录回归、模型重新可见。
    volatileWrite(config => {
      config.regions = { 'global': { enabled: true } }
    })
    await waitFor(() => ctx.llm.listConfigurableProviders().some(p => p.provider === 'qoder-global'))
    await expect.poll(async () => (await ctx.llm.listModels('qoder-global')).length).toBeGreaterThan(0)
  })

  it('只把勾选的模型交给 DSH 选择器，卡片仍看得到完整目录', async () => {
    // 这是「保存的模型还是那么多」的真正修法（workbuddy 同规）：
    //   - 运行时目录（适配器 getModels 读它 → DSH 选择器）**按勾选过滤**；
    //   - 卡片另走 displayModels()，拿到**完整**目录。
    // 两者混为一谈时只有两种坏结果：要么选择器里一直是一整份目录（用户报的
    // 症状），要么未勾选的模型从卡片里消失、用户再也勾不上。
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await mountQoder(ctx, { regions: {} })

    // 兜底目录先可见（还没拿到实时目录时）。
    const before = (await ctx.llm.listModels('qoder')).map(m => m.id)
    expect(before.length).toBeGreaterThan(1)

    // 只勾一个模型。
    const only = before[0]!
    volatileWrite(config => {
      config.regions = { cn: { enabledModelKeys: [only] } }
    })

    // 选择器（运行时目录）收敛到只勾的那个。
    await waitFor(() => {
      const ids = ctx.llm.listProviders().length > 0
      return ids
    })
    await expect.poll(async () => (await ctx.llm.listModels('qoder')).map(m => m.id)).toEqual([only])
  })

  it('region defaults are opt-out: absent enabled means on', () => {
    expect(Qoder.regionEnabled({ regions: {} }, 'cn')).toBe(true)
    expect(Qoder.regionEnabled({ regions: { cn: { enabled: undefined } } }, 'cn')).toBe(true)
    expect(Qoder.regionEnabled({ regions: { cn: { enabled: false } } }, 'cn')).toBe(false)
  })
})

describe('Qoder status route deps', () => {
  it('hasCredential honors settings PAT and env vars per region', () => {
    expect(Qoder.regionHasCredential({ regions: { cn: { pat: 'pt-x' } } }, 'cn')).toBe(true)
    expect(Qoder.regionHasCredential({ regions: {} }, 'global')).toBe(false)
    process.env.QODER_PERSONAL_ACCESS_TOKEN = 'pt-env'
    expect(Qoder.regionHasCredential({ regions: {} }, 'global')).toBe(true)
    expect(Qoder.regionHasCredential({ regions: {} }, 'cn')).toBe(false)
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = 'pt-cn-env'
    expect(Qoder.regionHasCredential({ regions: {} }, 'cn')).toBe(true)
  })
})
/**
 * 签到领了积分，卡片上的积分却不刷新（用户实拍：「我领了积分，但是积分没刷新」）。
 *
 * 根因在 `runCheckinBatch` 的收尾：它只 `delete usageCache[region]` —— **作废**了
 * 缓存，却没有任何人去重新填充它。于是积分停在签到前的数字，直到某个与签到无关
 * 的动作（改配置 / 点「从 Qoder 刷新」）顺带触发 `refreshUsage`。
 *
 * 这里锁住的是「签到之后 usage 缓存里必须是**签到后**的数字」，而不是「缓存被
 * 清空了」—— 后者恰好是旧的（错的）行为。
 */

/** A captured web route: path + handler, as the fake webServer records them. */
interface CapturedRoute {
  path: string
  handler: (req: unknown, res: unknown) => Promise<void> | void
}

/**
 * 签到领了积分，卡片上的积分却不刷新（用户实拍：「我领了积分，但是积分没刷新」）。
 *
 * 根因在 `runCheckinBatch` 的收尾：它只 `delete usageCache[region]` —— **作废**了
 * 缓存，却没有任何人去重新填充它。于是积分停在签到前的数字，直到某个与签到无关
 * 的动作（改配置 / 点「从 Qoder 刷新」）顺带触发 `refreshUsage`。
 *
 * 断言锁的是「签到之后 usage 被**再读了一次**」（也就是新余额能落地），而不是
 * 「缓存被清空了」—— 后者恰好就是旧的（错的）行为本身。
 */
describe('签到之后积分会被重新拉取', () => {
  /** One sash usage payload; `total` is the figure the card shows. */
  const usageBody = (total: number): string => JSON.stringify({
    data: { creditConsume: { total, origin: total, packages: [] } },
  })

  it('checkin 之后会再读一次 usage（而不是只作废缓存）', async () => {
    const realFetch = globalThis.fetch
    let usageCalls = 0
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      // 用量读（sash）：第一次旧余额，签到之后必须读到新余额。
      if (url.includes('/sash/api/v2/me/usage')) {
        usageCalls += 1

        return new Response(usageBody(usageCalls === 1 ? 10 : 60), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      // jobToken 交换：sash 的前置，缺了它 usage 根本发不出去。
      if (url.includes('/jobToken')) {
        return new Response(JSON.stringify({
          id: 'u1', name: 'Tester', expireTime: Date.now() + 86_400_000,
          securityOauthToken: 'jt-test', refreshToken: 'rt-test',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // 签到活动的活动列表 / 领取：回报成功并带数额。
      if (url.includes('/sash/api/v1/me/campaigns')) {
        return new Response(JSON.stringify({
          success: true, code: 0,
          data: { campaigns: [{ id: 'c1', name: 'daily', credit: 50 }] },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return realFetch(input as Parameters<typeof fetch>[0])
    }) as typeof fetch

    const routes: CapturedRoute[] = []
    try {
      const ctx = new Context()
      context = ctx
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(MemorySettings)
      // 挂一个假的 webServer，把插件注册的路由抓下来，好真的去调那条 pool 路由。
      ctx.provide('webServer', {
        register: (entry: CapturedRoute) => { routes.push(entry); return () => {} },
      } as never)
      await mountQoder(ctx, {
        regions: {
          cn: {
            pat: 'pt-test-checkin',
            pool: { enabled: true, targetModelId: '', memberAccountIds: ['pat-test-checkin'] },
          },
        },
      })

      await waitFor(() => routes.some(r => r.path.includes('/pool')))
      const pool = routes.find(r => r.path.includes('/pool'))!

      // 挂载会触发若干次 usage 读（applySelection 等），**全部落定之后**再取基线 ——
      // 否则一次迟到的挂载期读取会混进「签到引起的那次」，断言就假通过了。
      await waitFor(() => usageCalls >= 1)
      await new Promise(resolve => setTimeout(resolve, 800))
      const before = usageCalls

      // 真的走一次 checkin 路由（池里没有成员也照样会走完收尾逻辑）。
      const res = fakeResponse()
      await pool.handler(
        { method: 'POST', url: `${pool.path}?region=cn&action=checkin`, headers: { origin: 'http://127.0.0.1:19387' } },
        res.node,
      )
      expect(res.status()).toBe(200)

      // 关键断言：签到之后 usage **又被读了**。旧实现只 `delete usageCache`，
      // 这里永远是 `before`，于是卡片继续显示领之前的数字。
      // 硬边界：签到处理完再等 1s，让任何「迟到」的补读也有机会发生，然后断言。
      // 不能用 waitFor —— 它会一直等，而旧实现里那次补读根本不存在（永远等不到
      // 就会超时；更糟的是别的 usage 读顺手把计数推上去，于是断言假通过）。
      await new Promise(resolve => setTimeout(resolve, 1000))
      expect(usageCalls).toBeGreaterThan(before)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

/** A minimal ServerResponse stand-in: records status + body. */
function fakeResponse(): { node: Record<string, unknown>, status: () => number } {
  let code = 0
  const node: Record<string, unknown> = {
    statusCode: 0,
    setHeader: () => {},
    end: () => {},
    writeHead(code_: number) { code = code_; (node as { statusCode: number }).statusCode = code_ },
    get headersSent() { return false },
  }
  return { node, status: () => code }
}
