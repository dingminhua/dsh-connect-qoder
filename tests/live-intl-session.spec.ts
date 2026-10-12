import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { QODER_REGIONS, QoderUpstreamClient } from '../src/upstream.ts'

/**
 * 这个文件会**打真实上游**，所以默认不参与 `pnpm test`。
 *
 * 其余 500 条测试都跑在隔离的 `DSH_HOME` 里且不发一个网络请求；这里不一样，
 * 它验证的是「国际版的 sash 面到底通不通」—— 那个事实只能问上游。
 *
 * 跑法：
 *   QODER_LIVE_TESTS=1 pnpm vitest run tests/live-intl-session.spec.ts
 *
 * 没有环境变量时整个文件被跳过（`describe.skipIf`），所以 CI 与 `pnpm test`
 * 不会因为网络不通而变红。
 */
const LIVE = process.env['QODER_LIVE_TESTS'] === '1'
const REAL_HOME = '/Users/dmh2002/.dsh'

/**
 * 国际版的 sash 面（积分 / 签到 / 额度）需要**另一族令牌**。
 *
 * 实测（本机两个真实 PAT，只读；唯一变动的是「怎么换令牌」）：
 *
 *   chat / cosy 面（模型对话）只认 `/algo/api/v3/user/jobToken` 的
 *   `securityOauthToken`：
 *     国际版 + 旧令牌 → ✅ got-delta
 *     国际版 + 新令牌 → ❌ HTTP 403 code 105「登录态失效」
 *
 *   sash / 额度面只认 `/api/v1/jobToken/exchange` 的 `token`：
 *     国际版 + 旧令牌 → ❌ 401 TOKEN_EXPIRE
 *     国际版 + 新令牌 → ✅ 200
 *
 * 国内版两族等价，所以这个差异**只在国际版显形** —— 这就是它一直查不出来的原因。
 *
 * 因此本插件必须同时持有两枚令牌：旧的给 chat，新的给 sash。本文件先钉住
 * 这个事实（它现在**必然失败**，因为插件只有旧令牌）。
 *
 * @see https://github.com/Liki4/qodercli2api
 * @see https://github.com/shuishuipingan/qoder2api-hub
 * @see https://github.com/eghrhegpe/dsh-connect-qoder
 */

/** The real vault for a region, or undefined when this machine has none. */
function vaultPat(region: 'cn' | 'global'): string | undefined {
  try {
    const path = `${REAL_HOME}/.qoder-accounts.${region}.json`
    if (!existsSync(path)) return undefined
    const doc = JSON.parse(readFileSync(path, 'utf8')) as {
      accounts?: Array<{ pat?: string }>
    }
    const pat = doc.accounts?.[0]?.pat
    return typeof pat === 'string' && pat !== '' ? pat : undefined
  } catch {
    return undefined
  }
}

const REGIONS = ['cn', 'global'] as const

describe.skipIf(!LIVE)('两族令牌：chat 用旧的，sash 用新的（需要真实凭据与网络）', () => {
  it.each(REGIONS)('%s —— 积分读得到（sash 面）', async region => {
    const pat = vaultPat(region)
    if (pat === undefined) {
      // This machine has no credential for the region; nothing to assert. Skipping
      // is honest here — inventing a PAT would make the test lie.
      expect(pat).toBeUndefined()
      return
    }
    const usage = await new QoderUpstreamClient(region).fetchUsage(pat)
    // 国际版此前恒为 undefined / 抛 401。`userQuota` 是 creditsOf 读的那一份。
    expect(usage).toBeDefined()
    expect(usage?.userQuota).toBeDefined()
  }, 60_000)

  it.each(REGIONS)('%s —— 签到活动读得到（sash 面）', async region => {
    const pat = vaultPat(region)
    if (pat === undefined) {
      expect(pat).toBeUndefined()
      return
    }
    const campaigns = await new QoderUpstreamClient(region).fetchCampaigns(pat)
    // 国际版此前恒为 401。每日活动是 CLAIM_BENEFIT 那一条（VIEW_DETAILS 是纯展示）。
    expect(campaigns.some(c => c.actionType === 'CLAIM_BENEFIT')).toBe(true)
  }, 60_000)

  it.each(REGIONS)('%s —— 对话仍然可用（chat/cosy 面没被换令牌打断）', async region => {
    const pat = vaultPat(region)
    if (pat === undefined) {
      expect(pat).toBeUndefined()
      return
    }
    let gotDelta = false
    await new QoderUpstreamClient(region).chatStream(
      pat,
      'qfmodel',
      [{ role: 'system', content: 'say ok' }, { role: 'user', content: 'hi' }],
      {
        isReasoning: false,
        isVl: false,
        signal: AbortSignal.timeout(45_000),
        onDelta: () => { gotDelta = true },
      },
    )
    expect(gotDelta).toBe(true)
  }, 60_000)

  it('两个区域各自用自己的网关与 openapi（不共用）', () => {
    // 纯断言，防止将来把某区域的 baseUrl 写成另一个区域的。
    expect(QODER_REGIONS.cn.gateway).not.toBe(QODER_REGIONS.global.gateway)
    expect(QODER_REGIONS.cn.openapi).not.toBe(QODER_REGIONS.global.openapi)
  })
})
