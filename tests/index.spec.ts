import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
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