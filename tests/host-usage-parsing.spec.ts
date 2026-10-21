/**
 * 宿主**真的**会把我们写出的 `done.usage` 读成非零缓存命中吗？（issue #4）
 *
 * 为什么这条测试必须执行宿主的原文，而不是在插件里再抄一遍解析：
 *
 *   本仓库有过一次教训 —— 「403 被判 AUTH」整整一个版本没被发现，就是因为
 *   测试里跑的是一份手抄的宿主分类器副本，宿主改了判据顺序，副本与测试一起
 *   漂了过去，「测试通过」只证明副本自洽。同一个陷阱在这里更险：issue #4 的
 *   整个症状就是「宿主显示 0%」，而**显示 0% 有两种完全不同的原因**：
 *
 *     (a) 我们没把 `cached_tokens` 写进帧里；
 *     (b) 写对了位置但宿主读的是别的字段。
 *
 *   只断言「我们写了这个字段」挡不住 (b)。所以这里把宿主自己的
 *   `parseChunkUsage` 从 `app.asar` 逐字提取（`tests/fixtures/host-usage-parsing.json`，
 *   提取方式与 `host-piai-classifier.json` 同规）并**执行它**，断言它对我们
 *   写出的帧算出 `cacheRead > 0`。
 *
 * 宿主升级后若这段文本变了，重新提取即可；若它改了字段位置，这条会立刻转红。
 *
 * @module dsh-connect-qoder/tests/host-usage-parsing
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface HostUsageFixture {
  source: { app: string, module: string, extractedAt: string }
  parseChunkUsage: string
  calculateCost: string
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/host-usage-parsing.json', import.meta.url)), 'utf8'),
) as HostUsageFixture

/** 宿主 `parseChunkUsage` 的输出形状（它自己那份 usage 对象）。 */
interface HostUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
}

/**
 * 执行宿主原文。`calculateCost` 在本用例里无关（它只影响 `cost` 字段），
 * 用一个空函数顶上，避免把宿主的模型定价表也搬进来。
 */
function hostParseChunkUsage(rawUsage: Record<string, unknown>): HostUsage {
  const factory = new Function(
    `${fixture.calculateCost}\n${fixture.parseChunkUsage}\nreturn parseChunkUsage;`,
  ) as () => (usage: Record<string, unknown>, model: unknown) => HostUsage
  return factory()(rawUsage, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
}

describe('宿主 parseChunkUsage 读得懂我们写出的 usage 帧', () => {
  it('从 app.asar 提取的原文仍在，且用的是 prompt_tokens_details.cached_tokens', () => {
    // 前置：确认 golden 不是空壳。这几个标识符就是这条链路的关键。
    expect(fixture.parseChunkUsage).toContain('prompt_tokens_details')
    expect(fixture.parseChunkUsage).toContain('cached_tokens')
    expect(fixture.source.module).toContain('openai-completions')
  })

  it('我们透传的样子（prompt_tokens_details.cached_tokens）被读成非零 cacheRead', () => {
    // 这就是 `src/shim.ts` 写出的形状，数字取自 2026-10-22 的真实抓包
    // （cn 区 qfmodel：prompt_tokens 2038 / cached_tokens 2032）。
    const usage = hostParseChunkUsage({
      prompt_tokens: 2038,
      completion_tokens: 38,
      total_tokens: 2076,
      prompt_tokens_details: { cached_tokens: 2032 },
    })
    // **这条断言就是 issue #4 的验收标准**：修好之前这里是 0。
    expect(usage.cacheRead).toBe(2032)
    // 而 input 是「未命中的部分」：宿主自己从 prompt_tokens 里减掉了命中数。
    // 如果我们把 cached 加进了 prompt_tokens，这里会变成 2038（少算一半命中）。
    expect(usage.input).toBe(2038 - 2032)
  })

  it('按 issue #4 建议的「修法」把 cached 加进 prompt_tokens 会被宿主再减一次', () => {
    // 反例守卫：这正是 issue 里警告的「别双重计数」，也是我第一版最容易写出的
    // 形状。`prompt_tokens = 2038 + 2032` 之后，宿主减去 cacheRead，input 变成
    // 2038 —— 看起来「对」，但 totalTokens 与命中率统计都错了。断言它确实错，
    // 让「把两个数相加」这个念头在改动时立刻撞墙。
    const doubled = hostParseChunkUsage({
      prompt_tokens: 2038 + 2032,
      completion_tokens: 38,
      total_tokens: 2038 + 2032 + 38,
      prompt_tokens_details: { cached_tokens: 2032 },
    })
    expect(doubled.input).toBe(2038)
    // 而正确的形状下 input 是 6（2038 - 2032），两者相差整整一个 cacheRead 的
    // 量级 —— 这就是重复计数的代价。
    expect(doubled.input).not.toBe(2038 - 2032)
  })

  it('缺字段时宿主读到 0 —— 那正是修复前我们写出的形状', () => {
    // 修复前 `done.usage` 只有三个字段。宿主读不到缓存命中，只能显示 0%。
    // 保留这条是为了让「回到旧形状」这个改动同样能被测出来。
    const usage = hostParseChunkUsage({
      prompt_tokens: 2038,
      completion_tokens: 38,
      total_tokens: 2076,
    })
    expect(usage.cacheRead).toBe(0)
    expect(usage.input).toBe(2038)
  })

  it('宿主也认 prompt_cache_hit_tokens 与顶层 cached_tokens（所以我们的兜底不会白写）', () => {
    // 插件 `readCachedTokens` 支持的三种拼法，与宿主这张表一致 —— 这就是「同一
    // 个量的三种写法」这件事的跨仓证据。
    expect(hostParseChunkUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 64 }).cacheRead).toBe(64)
    expect(hostParseChunkUsage({ prompt_tokens: 100, cached_tokens: 32 }).cacheRead).toBe(32)
  })
})
