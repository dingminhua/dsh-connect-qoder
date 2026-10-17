import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import * as Qoder from '../src/index.ts'
import { qoderAccountId } from '../src/credentials.ts'

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

  /**
   * 「思考强度有时候有、有时候没有」（用户实拍）。
   *
   * 机制：`fullCatalog`（唯一带思考档位的目录）是**纯内存**的，目录只在启动时拉
   * 一次；而保存的 `lastCatalog` 在本机是 14 个模型**全部 `thinkingEfforts: []`**
   * —— 那是旧 schema 剥掉档位字段时留下的。所以：
   *   - 点一次「从 Qoder 刷新」→ 实时目录装上 → 档位出现；
   *   - 重启 / 重读 → 实时目录空 → 退回那份全空的快照 → 档位消失。
   * 「有没有点过刷新、进程活了多久」就是「有时候有、有时候没有」的全部来源。
   *
   * 现在：卡片读到「本进程还没成功拉过实时目录 + 手上的目录一个档位都没声明」
   * 时，在**这条读路径上**触发一次后台拉取（不阻塞这次读），并且**继续服务手上的
   * 目录**（模型不能消失）；拉回来之后下一次读就有档位了。
   *
   * 这条测试走**真实的卡片路由**（/usage → displayModels）。早期版本只断言
   * `ctx.llm.listModels` —— 那读的是适配器路径（运行时目录），恰好绕开
   * displayModels，测试全绿而修复在生产路径上是死代码（catalog 永不为空 →
   * live 恒非空 → 修复分支不可达）。路由捕获的挂法见「签到」那条测试。
   */
  it('重启后读到「全空档位」的旧快照时会触发一次拉取，而不是把空档位说成上游没声明', async () => {
    const realFetch = globalThis.fetch
    // 模型列表端点：第一次（启动那次刷新）失败 —— 模拟「重启后启动拉取恰好失败」；
    // 之后的重试成功，并带真实形状的 thinking_config（efforts 的键即档位名）。
    let modelsCalls = 0
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/algo/api/v2/model/list')) {
        modelsCalls += 1
        if (modelsCalls <= 1) return new Response('upstream boom', { status: 500 })
        return new Response(JSON.stringify({
          chat: [{
            key: 'qfmodel', display_name: 'Qwen3.8-Flash',
            price_factor: 0, is_vl: true, is_reasoning: true, is_free: true,
            thinking_config: { enabled: { efforts: { low: {}, medium: {}, xhigh: {} } } },
            context_config: { c200k: { token_count: 200_000 } },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // jobToken 交换：fetchModels / refreshUsage 的前置。
      if (url.includes('/jobToken')) {
        return new Response(JSON.stringify({
          id: 'u1', name: 'Tester', expireTime: Date.now() + 86_400_000,
          securityOauthToken: 'jt-test', refreshToken: 'rt-test',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // 用量读（sash）：mountQoder 的 refreshUsage 会打过来。
      if (url.includes('/sash/api/v2/me/usage')) {
        return new Response(JSON.stringify({ data: { creditConsume: { total: 10, origin: 10, packages: [] } } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return realFetch(input as Parameters<typeof fetch>[0])
    }) as typeof fetch

    const routes: CapturedRoute[] = []
    try {
      const ctx = new Context()
      context = ctx
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(MemorySettings)
      // 挂一个假的 webServer，把插件注册的路由抓下来，好真的去调 /usage。
      ctx.provide('webServer', {
        register: (entry: CapturedRoute) => { routes.push(entry); return () => {} },
      } as never)
      // 一份**形状与本机实测一致**的旧快照：每个模型都有 thinkingEfforts 字段，
      // 但值都是空数组（旧 schema 的产物；modelFromStored 会把空数组剥成缺席）。
      const staleEntry = {
        key: 'qfmodel', displayName: 'Qwen3.8-Flash', priceFactor: 0,
        contextWindow: 400_000, maxOutputTokens: 32_768,
        supportsImages: true, supportsThinking: true, canDisableThinking: false,
        isDefault: false, isFree: true, isNew: false,
        thinkingEfforts: [] as string[],
        contextTiers: [] as number[],
      }
      await mountQoder(ctx, {
        regions: {
          cn: { pat: 'pt-rethink', enabledModelKeys: ['qfmodel'], lastCatalog: [staleEntry] },
          // 国际版**完全没有凭据**：这一侧必须安安静静（无凭据时 refreshModels
          // 直接 skip，不打网络），不能去拉。
          global: { pat: '' },
        },
      })
      await waitFor(() => routes.some(r => r.path.includes('/usage')))
      const usage = routes.find(r => r.path.includes('/usage'))!
      // 等启动那次（失败的）模型拉取落定，再记下基数 —— 否则它与卡片触发的重拉
      // 混在一起，「读卡触发了重拉」的计数断言会假通过。
      await waitFor(() => modelsCalls >= 1)
      const startupCalls = modelsCalls

      // 读卡片：/usage → displayModels，手上是启动时装配的全空档位旧快照。
      const first = await readCardModels(usage)
      // **模型不能消失**：旧快照里的模型照常服务，只是没有档位。
      expect(first.map(m => m.key)).toContain('qfmodel')
      expect(first.find(m => m.key === 'qfmodel')?.thinkingEfforts).toBeUndefined()
      // 关键动作：这次读**触发了重拉**（fire-and-forget，不阻塞这次读）。
      // 变异检查：删掉 displayModels 里的触发，这里等到超时。
      await waitFor(() => modelsCalls > startupCalls, 5_000)

      // 重拉落地之后：下一次读，档位来自实时目录 —— 用户实拍「点一次刷新就有」
      // 的自动版，不用用户点，读一次卡片就自愈。
      let models = first
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        models = await readCardModels(usage)
        if ((models.find(m => m.key === 'qfmodel')?.thinkingEfforts?.length ?? 0) > 0) break
      }
      expect(models.find(m => m.key === 'qfmodel')?.thinkingEfforts).toEqual(['low', 'medium', 'xhigh'])
      // 拉成功一次就停：落地之后的读不再打模型列表端点（上游已给出诚实答案）。
      expect(modelsCalls).toBe(startupCalls + 1)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  /**
   * 判据只对「快照侧」生效的另一半：**上游真的没声明档位**时，读卡片不能变成
   * 打网络的循环。`displayModels` 只在本进程还没拉到实时目录时才判「空档位 →
   * 重拉」；实时目录落地后哪怕一个档位都没有，也不再拉 —— 那是上游的诚实
   * 答案，重拉多少次都一样。变异检查：把 `full.length === 0` 的守卫改成恒真，
   * 落地后的三次读会把计数推上去，这条断言就红。
   */
  it('上游确实没声明档位时，读卡片不会变成打网络的循环（判据只对快照侧生效）', async () => {
    const realFetch = globalThis.fetch
    // 模型列表端点：从一开始就成功，但模型**没有** thinking_config —— 上游
    // 诚实地声明「这个模型没有思考档位」。
    let modelsCalls = 0
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/algo/api/v2/model/list')) {
        modelsCalls += 1
        return new Response(JSON.stringify({
          chat: [{
            key: 'qmodel', display_name: 'Dmodel',
            price_factor: 1, is_reasoning: false,
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/jobToken')) {
        return new Response(JSON.stringify({
          id: 'u1', name: 'Tester', expireTime: Date.now() + 86_400_000,
          securityOauthToken: 'jt-test', refreshToken: 'rt-test',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/sash/api/v2/me/usage')) {
        return new Response(JSON.stringify({ data: { creditConsume: { total: 10, origin: 10, packages: [] } } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return realFetch(input as Parameters<typeof fetch>[0])
    }) as typeof fetch

    const routes: CapturedRoute[] = []
    try {
      const ctx = new Context()
      context = ctx
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(MemorySettings)
      ctx.provide('webServer', {
        register: (entry: CapturedRoute) => { routes.push(entry); return () => {} },
      } as never)
      await mountQoder(ctx, {
        regions: {
          cn: { pat: 'pt-noefforts', enabledModelKeys: ['qfmodel'], lastCatalog: [{
            key: 'qfmodel', displayName: 'Qwen3.8-Flash', priceFactor: 0,
            contextWindow: 400_000, maxOutputTokens: 32_768,
            supportsImages: true, supportsThinking: true, canDisableThinking: false,
            isDefault: false, isFree: true, isNew: false,
            thinkingEfforts: [] as string[],
            contextTiers: [] as number[],
          }] },
          global: { pat: '' },
        },
      })
      await waitFor(() => routes.some(r => r.path.includes('/usage')))
      const usage = routes.find(r => r.path.includes('/usage'))!
      await waitFor(() => modelsCalls >= 1)

      // 等 fullCatalog 落地：卡片读到**实时目录**的 qmodel（而不是快照的
      // qfmodel）—— 用 key 的更替当作「落地」的可观测信号。
      let models: Array<{ key: string }> = []
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        models = await readCardModels(usage)
        if (models.some(m => m.key === 'qmodel')) break
      }
      expect(models.map(m => m.key)).toContain('qmodel')
      const settled = modelsCalls

      // 落地之后再读三次：不再打模型列表端点 —— 否则「上游没声明档位」的
      // 每一次卡片轮询都会拖一次网络（60s 一发，永不停）。
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        await readCardModels(usage)
      }
      expect(modelsCalls).toBe(settled)
    } finally {
      globalThis.fetch = realFetch
    }
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

  it('全空档位的快照会被当成「需要重拉」，而不是「上游没声明」（思考强度稳定性）', () => {
    // 用户实拍「思考强度有时候有、有时候没有」。机制：`fullCatalog`（唯一带档位的
    // 目录）是**纯内存**的，只在启动时拉一次；而保存的 `lastCatalog` 在本机实测
    // 是 14 个模型**全部 `thinkingEfforts: []`** —— 旧 schema 剥字段时留下的。
    // 于是「点一次刷新就有、重启后就没」。
    //
    // 这里钉住那条判据本身。两种「没有档位」必须分开：
    // - 字段**缺席** = 上游真的没声明 → 用这份快照是对的，不该重拉；
    // - `[]` 空数组 = 这份快照来自一次没拉到档位的时刻 → 必须重拉。
    const withEps = [{ thinkingEfforts: ['low', 'medium', 'xhigh'] }, { thinkingEfforts: [] }]
    expect(Qoder.catalogSnapshotDeclaresEfforts(withEps)).toBe(true)

    // 本机那 14 个模型的真实形状：字段在，值全空 → 判为「没声明过」→ 需要重拉。
    const allEmpty = [{ thinkingEfforts: [] }, { thinkingEfforts: [] }]
    expect(Qoder.catalogSnapshotDeclaresEfforts(allEmpty)).toBe(false)

    // 字段缺席 = 上游确实没声明 → 同样判为「没声明过」，但 UI 说「未知」
    // 而不是「上游没档位」，且**不会**白白重拉（判据相同、后果由调用处区分）。
    const absent: Array<{ thinkingEfforts?: readonly string[] }> = [{}, {}]
    expect(Qoder.catalogSnapshotDeclaresEfforts(absent)).toBe(false)

    // 只有一个模型声明了档位就足够（不是要求全部都有）。
    expect(Qoder.catalogSnapshotDeclaresEfforts([{ thinkingEfforts: [] }, { thinkingEfforts: ['high'] }])).toBe(true)
    expect(Qoder.catalogSnapshotDeclaresEfforts([])).toBe(false)

    // **动作真的会执行**（不只是判据返回 false）。这是把判据与动作打包在一起
    // 的理由：分开接线时，把调用处变异掉单测照样全绿（第一版就骗过了自己）。
    let pulled = 0
    const pull = (): void => { pulled += 1 }
    const good = Qoder.serveSavedCatalog([{ thinkingEfforts: ['low'] } as never], pull)
    expect(good.models).toHaveLength(1)
    expect(good.stale).toBe(false)
    expect(pulled).toBe(0)

    const stale = Qoder.serveSavedCatalog([{ thinkingEfforts: [] } as never], pull)
    // 模型**继续服务**（模型不能从卡片上消失，缺的只是档位），并且**真的拉了一次**。
    // 早期版本想让这里返回 `models: []` 让调用处退兜底 —— 但 `[]` 是 truthy，
    // 调用处的 `if (!serve.models)` 永远不走，而且那样会让用户勾选的模型从卡片上
    // 消失。宁可诚实：服务手上的模型，档位等拉回来补上。
    expect(stale.models).toHaveLength(1)
    expect(stale.stale).toBe(true)
    expect(pulled).toBe(1)
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
describe('签到之后：积分重读 + 下一窗刷新时刻进入行与快照', () => {
  /** One sash usage payload; `total` is the figure the card shows. */
  const usageBody = (total: number): string => JSON.stringify({
    data: { creditConsume: { total, origin: total, packages: [] } },
  })

  it('checkin 之后会再读一次 usage，并给出行与快照的「下一窗刷新时刻」', async () => {
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
      // 签到活动列表。字段用**实测原文**的形状（`campaignId` / `actionType` /
      // `claimStatus` / `benefit` / `startAt` / `endAt`，后者是 epoch 秒）：
      // 解析器只认这些键，早先用 `{ id, credit }` 会解析出零条活动，签到批次空转。
      if (url.includes('/sash/api/v1/me/campaigns') && !url.includes('/claim')) {
        return new Response(JSON.stringify({
          campaigns: [{
            campaignId: '01a12102-9c4c-7460-a08b-61180061ac65',
            campaignKey: 'act-20261009-057',
            actionType: 'CLAIM_BENEFIT',
            claimStatus: 'CLAIMABLE',
            startAt: 1791770400,
            endAt: 1791856740,
            benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // 领取。
      if (url.includes('/claim')) {
        return new Response(JSON.stringify({ status: 'CLAIMED' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return realFetch(input as Parameters<typeof fetch>[0])
    }) as typeof fetch

    const routes: CapturedRoute[] = []
    const QODER_ACCOUNT_ID = qoderAccountId('pt-test-checkin')
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
            // 账号 id 是 PAT 派生的散列（`qoderAccountId`），不是 PAT 本身 ——
            // 写错成 PAT 字符串会让 `credentialFor` 解析不到，批次直接跳过成员，
            // `rows` 就是空的（第一版正是这样，断言看着像「快照没带时间」）。
            pool: { enabled: true, targetModelId: '', memberAccountIds: [QODER_ACCOUNT_ID] },
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
      // 签到行的结果必须带上「下一窗何时刷新」—— 这是「已领取」这句话的另一半。
      const claimed = (JSON.parse(String(res.body())) as { rows?: Array<{ status: string, refreshAtMs?: number }> }).rows ?? []
      expect(claimed).toHaveLength(1)
      expect(claimed[0]!.status).toBe('claimed')
      expect(claimed[0]!.refreshAtMs).toBe(1791856740 * 1000)

      // 快照（成员表读的那份）也必须带上它 —— 它是 UI 倒计时的唯一来源。
      const usageRoute = routes.find(r => r.path.includes('/usage'))!
      const usageRes = fakeResponse()
      await usageRoute.handler(
        { method: 'GET', url: `${usageRoute.path}?region=cn`, headers: {} },
        usageRes.node,
      )
      const usageDoc = JSON.parse(String(usageRes.body())) as {
        pool?: { accounts?: Array<{ accountId: string, checkedInToday?: boolean, checkinRefreshAtMs?: number }> }
      }
      const row = usageDoc.pool?.accounts?.find(a => a.accountId === QODER_ACCOUNT_ID)
      expect(row?.checkedInToday).toBe(true)
      expect(row?.checkinRefreshAtMs).toBe(1791856740 * 1000)

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
function fakeResponse(): { node: Record<string, unknown>, status: () => number, body: () => unknown } {
  let code = 0
  let payload = ''
  const node: Record<string, unknown> = {
    statusCode: 0,
    setHeader: () => {},
    end(chunk?: unknown) { if (chunk !== undefined) payload = String(chunk); node.writableEnded = true },
    writeHead(code_: number) { code = code_; (node as { statusCode: number }).statusCode = code_ },
    // `json()` 第一行就 `if (res.writableEnded || res.destroyed) return` —— 少这两个
    // 字段它会**静默不写**，于是 body 是空的（第一版就这样，看着像 rows 没返回）。
    writableEnded: false,
    destroyed: false,
    get headersSent() { return false },
  }
  return { node, status: () => code, body: () => payload }
}

/**
 * 调用捕获到的 /usage 路由，读出**卡片视角**的模型行 —— 这才是 displayModels
 * 的真实调用路径（选择器走的 ctx.llm.listModels 读的是运行时目录，绕开它）。
 */
async function readCardModels(
  usage: CapturedRoute,
): Promise<Array<{ key: string, thinkingEfforts?: string[] }>> {
  const res = fakeResponse()
  await usage.handler(
    { method: 'GET', url: `${usage.path}?region=cn`, headers: {} },
    res.node,
  )
  if (res.status() !== 200) throw new Error(`/usage 状态码 ${String(res.status())}`)
  const doc = JSON.parse(String(res.body())) as { models: Array<{ key: string, thinkingEfforts?: string[] }> }
  return doc.models
}

// ==========================================================================
// 真实请求失败写进账号池的那条测量（liveRequestProbe）
//
// 抽成纯函数才有办法钉住：这段逻辑此前是 onServingFailure 里的内联字面量，
// 而它有一个**已经真实发生**的缺陷 —— 上游原文被丢掉（参数写成 `_message`），
// 池里只剩一句结论。用户实拍的那条记录是
//   {"outcome":"credential-rejected","atMs":…,"source":"live-request"}
// 连 message 字段都没有，卡片于是只能空口指控「Qoder 拒绝了这个账号的 PAT」，
// 而真相（`code 110` = 当日用量用尽）就在被丢掉的那串字符里。
// ==========================================================================
describe('liveRequestProbe：一次真实失败要落盘的那条测量', () => {
  // 现场抓到的原文，逐字照抄（scripts/probe-cosy.mjs global --chat，2026-10-13）。
  const CAPTURED = '上游信封错误: HTTP 403 {"code":"110","message":"Billing daily count exceeded"}'

  it('配额耗尽映射成 out-of-credit，且**带上游原文**（这是本轮的修复点）', () => {
    const probe = Qoder.liveRequestProbe('quota-exhausted', CAPTURED)
    expect(probe?.outcome).toBe('out-of-credit')
    expect(probe?.source).toBe('live-request')
    // 业务码必须在：它是这条测量唯一的可溯源依据，去掉它卡片就只剩结论。
    expect(probe?.message).toContain('110')
    expect(probe?.message).toContain('Billing daily count exceeded')
  })

  it('auth 仍映射成 credential-rejected（真被拒的那一侧不能被改坏）', () => {
    expect(Qoder.liveRequestProbe('auth', '401 TOKEN_EXPIRE')?.outcome).toBe('credential-rejected')
  })

  it('内容策略拒绝**不写池**：那是这一次输入的事实，不是账号的事实', () => {
    // 写了就会把一个只被审核挡过一次的账号判成不可用。
    expect(Qoder.liveRequestProbe('content-policy', 'DataInspectionFailed')).toBeUndefined()
    expect(Qoder.liveRequestProbe('invalid-request', 'bad input')).toBeUndefined()
    expect(Qoder.liveRequestProbe('unknown', 'huh')).toBeUndefined()
  })

  it('空原因不写成空串：卡片据此说「上游未给出」，而不是显示一个空消息', () => {
    const probe = Qoder.liveRequestProbe('rate-limited', '')
    expect(probe?.outcome).toBe('rate-limited')
    expect('message' in probe!).toBe(false)
  })

  it('落盘前脱敏：PAT 绝不能进探针文件', () => {
    // redactUpstreamText 只抹 `code=`/`token=` 这类**带等号**的形态；裸 pt- 凭据
    // 有独立规则。这条钉住「带原文」这个新行为没有把密钥一起带进去。
    const probe = Qoder.liveRequestProbe('auth', 'rejected credential pt-ABCDEFGHIJ0123456789 for this account')
    expect(probe?.message).not.toContain('pt-ABCDEFGHIJ0123456789')
    expect(probe?.message).toContain('[redacted credential]')
  })

  it('时间戳是本次测量的时刻，不沿用上次', () => {
    const before = Date.now()
    const probe = Qoder.liveRequestProbe('network', 'boom')
    expect(probe!.atMs).toBeGreaterThanOrEqual(before)
    expect(probe!.atMs).toBeLessThanOrEqual(Date.now())
  })
})

// ==========================================================================
// /usage 每次请求现场刷积分（对齐 workbuddy）：保旧值 + 并发合流
// ==========================================================================

/**
 * 截图里的 800 vs 738：触发器读宿主 usageCache（只在四个时机被写，聊天扣费后
 * 永远不变），面板表格每账号现场读上游。修法是让 /usage 路由每次请求先刷再读。
 *
 * 但「每次请求都刷」会放大一个既有缺陷：`fetchUsage` 把超时/5xx 吞成 undefined
 * （只有 401/403 抛出），而旧写法把 undefined 直接写进缓存 —— 一次网络抖动能把
 * 「数字旧」变成「没数字」。所以刷新必须保旧值，并把失败记成覆盖层。
 *
 * 这两条都在**真实挂载**上钉：路由级测试给的是假 dep，证明不了宿主侧的缓存写入。
 */
describe('/usage 每次请求现场刷积分', () => {
  /**
   * 积分读的上游形状：`parseUsage` 认的是 `userQuota` / `addOnQuota` /
   * `orgResourcePackage` 三个桶，`creditsOf` 把桶里的 `total - used` 相加。
   * （第一版这里抄了签到测试的 `{data:{creditConsume}}`，解析不出任何桶，
   * creditsOf 恒为 0 —— 三条用例全因此红，与实现无关。）
   */
  const usageBody = (remaining: number): string => JSON.stringify({
    userQuota: { total: remaining + 62, used: 62, remaining },
  })

  /**
   * 上游积分读的替身。
   *
   * 两个设计点都是被上一版的假失败教出来的：
   *   - **每次成功读给一个递减的新数字**（而不是固定脚本）：挂载期会先烧掉几次
   *     读（applySelection），脚本会被推到末位并 clamp，于是「两次请求读到同一
   *     个数」——看着像修复没生效，其实是 fixture 的取值方式。递减函数让断言与
   *     「挂载烧掉几次」彻底无关。
   *   - **latencyMs**：合流只在刷新真的重叠时才有意义。瞬时返回的替身会让四个
   *     请求各自排队刷一次，测出来永远是「没合流」。
   */
  function stubUpstream(latencyMs = 0): {
    calls: () => number
    failNextRead: () => void
  } {
    const realFetch = globalThis.fetch
    let n = 0
    let failOnce = false
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken')) {
        return new Response(JSON.stringify({
          id: 'u1', name: 'Tester', expireTime: Date.now() + 86_400_000,
          securityOauthToken: 'jt-test', refreshToken: 'rt-test',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/sash/api/v2/me/usage')) {
        n += 1
        const seq = n
        if (latencyMs > 0) await new Promise(resolve => setTimeout(resolve, latencyMs))
        if (failOnce) {
          failOnce = false
          return new Response('upstream boom', { status: 500 })
        }
        return new Response(usageBody(800 - seq * 10), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return realFetch(input as Parameters<typeof fetch>[0])
    }) as typeof fetch
    return { calls: () => n, failNextRead: () => { failOnce = true } }
  }

  /** 等上游读计数静置（连续 QUIESCENT_MS 不再变化），替代固定睡眠。 */
async function waitForQuiescent(
  upstream: { calls: () => number },
  quietMs = 250,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now()
  let last = upstream.calls()
  let changedAt = Date.now()
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 25))
    const now = upstream.calls()
    if (now !== last) {
      last = now
      changedAt = Date.now()
    }
    if (Date.now() - changedAt >= quietMs) return
    if (Date.now() - started > timeoutMs) throw new Error('上游读计数迟迟不静置')
  }
}

/** 真实挂载一次，返回 /usage 路由与读它的助手（等挂载期那几读落定）。 */
  async function mountUsageRoute(upstream: { calls: () => number }): Promise<{
    read: () => Promise<{
      credits?: { total: number }
      creditsAtMs?: number
      creditsError?: string
      refreshError?: string
    }>
  }> {
    const routes: CapturedRoute[] = []
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    ctx.provide('webServer', {
      register: (entry: CapturedRoute) => { routes.push(entry); return () => {} },
    } as never)
    await mountQoder(ctx, { regions: { cn: { pat: 'pt-refresh-per-request' } } })
    const usageRoute = routes.find(r => r.path.includes('/usage'))!
    // 挂载会触发若干次 usage 读（applySelection 等），必须等它们**全部落定**再开始
    // —— 否则一次迟到的挂载读会混进「请求引起的那次」，并发合流那条就会多数。
    //
    // 这里等的是「计数不再变化」而不是固定 900ms：固定睡眠在全量并行跑、机器负载
    // 高时并不安全（实测出现过一次偶发红）。静置窗口 250ms 足够覆盖替身的 0/40ms
    // 延迟，且比盲等更快。
    await waitFor(() => upstream.calls() >= 1)
    await waitForQuiescent(upstream)
    return {
      read: async () => {
        const res = fakeResponse()
        await usageRoute.handler(
          { method: 'GET', url: `${usageRoute.path}?region=cn`, headers: {} },
          res.node,
        )
        return JSON.parse(String(res.body())) as {
          credits?: { total: number }
          creditsAtMs?: number
          creditsError?: string
          refreshError?: string
        }
      },
    }
  }

  it('每次 /usage 请求都会真的再读一次上游，并把新数带进文档', async () => {
    const upstream = stubUpstream()
    try {
      const { read } = await mountUsageRoute(upstream)
      const first = await read()
      const second = await read()
      // 关键：两次请求读到**不同**的数字。旧实现两次都是同一个缓存值 —— 也就是
      // 截图里那个永远不动的 800。
      expect(first.credits?.total).toBeGreaterThan(0)
      expect(second.credits?.total).toBeLessThan(first.credits?.total!)
      // 数据时刻必须随刷新前进，否则页脚无法判断数字新旧。
      expect(second.creditsAtMs ?? 0).toBeGreaterThanOrEqual(first.creditsAtMs ?? 0)
    } finally {
      await context?.fiber.dispose()
      context = undefined
    }
  })

  it('上游瞬时失败时保留上一次的好数字，只加 refreshError 覆盖层', async () => {
    const upstream = stubUpstream()
    try {
      const { read } = await mountUsageRoute(upstream)
      const good = await read()
      const held = good.credits?.total
      expect(held).toBeGreaterThan(0)

      upstream.failNextRead()
      const afterBlip = await read()
      // 这一次上游 500。旧写法会把缓存写成 undefined → 面板从「数字旧」变成
      // 「没数字」；改成每请求一刷之后这条路径会被放大成常态，所以必须保旧值。
      expect(afterBlip.credits?.total).toBe(held)
      // 失败如实说出来，但不冒充「凭据被拒」：那是另一回事，需要相反的劝告。
      expect(afterBlip.refreshError).toBeDefined()
      expect(afterBlip.creditsError).toBeUndefined()

      // 覆盖层必须自己消失：下一次成功读之后不能再挂着「刷新失败」。
      const recovered = await read()
      expect(recovered.refreshError).toBeUndefined()
      expect(recovered.credits?.total).toBeLessThan(held!)
    } finally {
      await context?.fiber.dispose()
      context = undefined
    }
  })

  it('并发打同一区域的请求合流成一次上游读', async () => {
    // 40ms 延迟让四个请求真的重叠（瞬时返回时它们会排队，测不出合流）。
    const upstream = stubUpstream(40)
    try {
      const { read } = await mountUsageRoute(upstream)
      const before = upstream.calls()
      const docs = await Promise.all([read(), read(), read(), read()])
      const reads = upstream.calls() - before
      // 卡片 60s 轮询 + composer 300s + 面板打开会几乎同时打到同一区域；没有合流
      // 就是 4 次上游读。
      expect(reads).toBe(1)
      // 合流不能改变结果：四个文档都得是同一份新数据。
      const totals = new Set(docs.map(d => d.credits?.total))
      expect(totals.size).toBe(1)
      expect([...totals][0]).toBeGreaterThan(0)
    } finally {
      await context?.fiber.dispose()
      context = undefined
    }
  })
})

// ==========================================================================
// withHardTimeout：积分读的整体硬超时（超时=没读到，auth 失败仍要抛出）
// ==========================================================================

/**
 * `/usage` 现在每次请求都刷积分，而 `fetchUsage` 的 signal 只管得住 sash 那半段：
 * 会话过期时前半段（jobToken 交换）挂住，signal 还没生效。所以外层再套一个整体
 * race。这里钉住它的三种结局 —— 第三种最要紧：**超时**降级成 undefined（保旧值），
 * 但**凭据被拒必须照旧抛出**，被一起吞掉就会把「PAT 坏了」显示成「这次没读到」。
 */
describe('withHardTimeout', () => {
  it('promise 先结算时原样给值', async () => {
    expect(await Qoder.withHardTimeout(Promise.resolve('v'), 50)).toBe('v')
  })

  it('挂住的 promise 超时后结算为 undefined（走保旧值路径）', async () => {
    const hung = new Promise<string>(() => { /* 永不结算 */ })
    const started = Date.now()
    expect(await Qoder.withHardTimeout(hung, 25)).toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
  })

  it('超时前失败仍然抛出：auth 不能被降级成「没读到」', async () => {
    await expect(Qoder.withHardTimeout(Promise.reject(new Error('401 TOKEN_EXPIRE')), 50))
      .rejects.toThrow('TOKEN_EXPIRE')
  })

  it('超时之后才到的 rejection 不会变成 unhandled rejection', async () => {
    const realError = new Error('late failure')
    let rejectOuter: ((e: Error) => void) | undefined
    const slow = new Promise<string>((_, reject) => { rejectOuter = reject })
    const raced = Qoder.withHardTimeout(slow, 20)
    // 先让超时结算，再让原 promise 失败 —— 若没有处理器，进程会报 unhandled。
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(await raced).toBeUndefined()
    rejectOuter!(realError)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await raced).toBeUndefined()
  })
})

// ==========================================================================
// 池开关：换号的唯一授权 / 失败记录的守卫
// ==========================================================================

/**
 * 「关掉账号池」此前**对换号完全无效**：`nextFailoverCredential` 只读成员
 * 名单、从不读 `enabled`。默认 `enabled: false`，于是每一条全新安装都在这条
 * 路径上：用户以为关掉了自动行为，插件仍会在失败后悄悄换到另一个 PAT 计费。
 *
 * 把这两个判据做成导出的纯函数再钉住 —— 与 `liveRequestProbe` 同一个理由
 * （「判据与动作打包，于是动作有没有真的发生也能被断言」）。
 */
describe('poolAllowsFailover —— 池开关是换号的唯一授权', () => {
  it('关闭时**绝不**换号', () => {
    expect(Qoder.poolAllowsFailover({ enabled: false, memberAccountIds: ['a', 'b'] })).toBe(false)
  })

  it('关闭时即使成员名单非空也不换号（这正是旧实现出错的地方）', () => {
    // 旧实现只看 memberAccountIds，所以这条在旧代码下会是 true。
    expect(Qoder.poolAllowsFailover({ enabled: false, memberAccountIds: ['a'] })).toBe(false)
  })

  it('开启时才授权', () => {
    expect(Qoder.poolAllowsFailover({ enabled: true, memberAccountIds: ['a'] })).toBe(true)
  })

  it('开启但没有任何成员：授权成立，但排序自然挑不到人（由 rankPool 收口）', () => {
    expect(Qoder.poolAllowsFailover({ enabled: true, memberAccountIds: [] })).toBe(true)
  })
})

describe('shouldRecordPoolFailure —— 不该记的失败一条都不记', () => {
  it('池关闭时什么都不记', () => {
    expect(Qoder.shouldRecordPoolFailure({ enabled: false, memberAccountIds: ['a'] }, 'a')).toBe(false)
  })

  it('账号未勾选为成员时不记（没授权就不改它的状态）', () => {
    expect(Qoder.shouldRecordPoolFailure({ enabled: true, memberAccountIds: ['a'] }, 'outsider')).toBe(false)
  })

  it('已勾选成员且池开启时才记', () => {
    expect(Qoder.shouldRecordPoolFailure({ enabled: true, memberAccountIds: ['a', 'b'] }, 'b')).toBe(true)
  })

  it('空 accountId 不记（那是「不知道是谁」，不是某个号的事实）', () => {
    expect(Qoder.shouldRecordPoolFailure({ enabled: true, memberAccountIds: [''] }, '')).toBe(false)
  })
})
