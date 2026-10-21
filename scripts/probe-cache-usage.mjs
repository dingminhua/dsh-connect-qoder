#!/usr/bin/env node
/**
 * 现场取证：**上游到底给不给缓存命中数**（issue #4）。
 *
 * 为什么需要这个脚本，而不是靠推断：
 *
 *   issue #4 说的是「宿主缓存命中恒显 0%」。它可能有两件**完全不同**的成因，
 *   而处置方式相反：
 *
 *   A. 上游**给了** `prompt_tokens_details.cached_tokens`（或
 *      `prompt_cache_hit_tokens`），但本插件在解析/合成 usage 时把它丢了
 *      —— 那是本仓库的透传缺陷，补上即可。
 *   B. 上游**根本不下发**任何缓存字段 —— 那插件没有可丢的东西，能做的只有
 *      如实显示「上游未提供」，而不是伪装成「命中 0%」。
 *
 *   两者的差别只在原始帧里。所以这个脚本**不做任何字段抽取**，直接把每一帧的
 *   `usage` 块原样打出来（脱敏后）。
 *
 * 只读、不写设置、不落盘凭据。默认用倍率为 0 的免费模型，尽量不花积分。
 *
 * 用法：
 *   node scripts/probe-cache-usage.mjs cn            # 默认 qfmodel（免费）
 *   node scripts/probe-cache-usage.mjs cn qmodel_38max
 *   node scripts/probe-cache-usage.mjs global
 *
 * 让缓存有机会命中：脚本会发**两轮**请求，第二轮带着第一轮的长前缀 ——
 * 隐式缓存若生效，第二轮才可能命中。
 */

import { QoderUpstreamClient } from '../src/upstream.ts'
import { QoderAccountStore } from '../src/accounts.ts'

const region = process.argv[2] === 'global' ? 'global' : 'cn'
const modelKey = process.argv[3] ?? 'qfmodel'

/** Token-like strings must never reach stdout. */
function redact(text) {
  return String(text)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/\bpt-[A-Za-z0-9_-]{6,}\b/giu, '[redacted credential]')
    .replace(/\bjt-[A-Za-z0-9_-]{6,}\b/giu, '[redacted jobToken]')
}

const envVar = region === 'cn' ? 'QODERCN_PERSONAL_ACCESS_TOKEN' : 'QODER_PERSONAL_ACCESS_TOKEN'
// 凭据来源与 CLI 一致：先环境变量，再本机 vault（与 `dsh-connect-qoder status`
// 同一套解析，避免这个探针在「设置里没填 PAT、只有 vault」的机器上跑不起来）。
let pat = process.env[envVar] ?? ''
if (pat === '') {
  const vault = await new QoderAccountStore(region).vaultAccounts()
  pat = vault[0]?.pat ?? ''
}
if (pat === '') {
  process.stderr.write(`missing ${envVar} (and no vault account for ${region})\n`)
  process.exit(2)
}

/**
 * 从一个 SSE 帧里取出 `usage` 块，**原样**返回（不挑字段）。
 *
 * 这就是本脚本的全部价值：不做 `readTokens(usage,'prompt_tokens')` 那种抽取，
 * 因为要看的恰恰是「除了这两个字段，上游还写了什么」。
 */
function usageOfFrame(payload) {
  let wrapper
  try {
    wrapper = JSON.parse(payload)
  } catch {
    return undefined
  }
  // 上游把真正的 JSON 再包一层字符串（`{body: "{…}"}`）。
  const innerRaw = typeof wrapper?.body === 'string' ? wrapper.body : undefined
  if (innerRaw === undefined) return undefined
  let inner
  try {
    inner = JSON.parse(innerRaw)
  } catch {
    return undefined
  }
  const usage = inner?.usage
  if (usage === undefined || usage === null || typeof usage !== 'object') return undefined
  return usage
}

/** 观测到的每个原始 usage 块。 */
const observations = []

/**
 * 包一层 fetch，把响应流复制一份出来解析 usage，其余行为不变。
 *
 * 为什么不在 `onDelta` 里取：`QoderChatDelta` 只有 `inputTokens` /
 * `outputTokens` 两个数字，`cached_tokens` 在那一层已经被丢掉了 —— 拿它当
 * 观测点，等于用同一个可能有缺陷的抽取去验证那个抽取。
 *
 * **必须在构造上游客户端之前装好**：`QoderUpstreamClient` 在构造函数里就把
 * `globalThis.fetch` 捕获成 `this.fetchImpl`（见 upstream.ts 的
 * `this.fetchImpl = options.fetch ?? globalThis.fetch`），构造之后再改全局
 * fetch 对这个实例毫无影响。第一版探针正是踩了这个坑：它报告「上游一个 usage
 * 块都没有」，而真相只是观测钩子根本没接上 —— 一个看起来很有说服力的假阴性。
 */
const realFetch = globalThis.fetch
globalThis.fetch = (async (input, init) => {
  const resp = await realFetch(input, init)
  const url = String(input)
  if (!url.includes('/sse/') || resp.body === null) return resp
  const [watched, passthrough] = resp.body.tee()
  void (async () => {
    const reader = watched.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const usage = usageOfFrame(line.slice(5).trim())
          if (usage !== undefined) observations.push(usage)
        }
      }
    } catch { /* 观测失败不影响主链路 */ }
  })()
  return new Response(passthrough, { status: resp.status, statusText: resp.statusText, headers: resp.headers })
})

const client = new QoderUpstreamClient(region, { logger: m => process.stderr.write(`[upstream] ${redact(m)}\n`) })

/** 一段足够长的提示词：隐式缓存按前缀匹配，太短则本来就不可能命中。 */
const PREFIX = Array.from({ length: 60 }, (_, i) =>
  `第 ${i + 1} 条背景资料：这是一段用于触发隐式缓存的填充文本，内容本身不重要，重要的是它在两轮请求之间完全一致。`).join('\n')

async function oneRound(label, messages) {
  process.stdout.write(`\n== ${label} ==\n`)
  try {
    await client.chatStream(pat, modelKey, messages, {
      isReasoning: false,
      isVl: false,
      onDelta: () => {},
    })
  } catch (error) {
    process.stdout.write(`FAILED: ${redact(error?.message ?? error)} (kind=${error?.kind ?? 'n/a'})\n`)
  }
}

process.stdout.write(`region=${region} model=${modelKey}\n`)

await oneRound('第 1 轮（冷启动：前缀尚未进缓存）', [{ role: 'user', content: `${PREFIX}\n\n请只回复「收到」。` }])
const first = observations.length
for (let i = 0; i < 30 && observations.length === first; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 100))
}

await oneRound('第 2 轮（同一段长前缀，隐式缓存应有机会命中）', [
  { role: 'user', content: `${PREFIX}\n\n请只回复「收到」。` },
  { role: 'assistant', content: '收到。' },
  { role: 'user', content: '再说一次。' },
])
const second = observations.length
for (let i = 0; i < 30 && observations.length === second; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 100))
}

process.stdout.write(`\n== 原始 usage 块（共 ${observations.length} 个，未做任何字段抽取）==\n`)
for (const [i, usage] of observations.entries()) {
  process.stdout.write(`--- #${i + 1} ---\n${JSON.stringify(usage, null, 2)}\n`)
}

/** 结论：上游到底给不给缓存字段。 */
const cacheFields = new Set()
for (const usage of observations) {
  for (const key of Object.keys(usage)) {
    if (/cache/i.test(key)) cacheFields.add(key)
  }
  const details = usage.prompt_tokens_details
  if (details !== null && typeof details === 'object') {
    for (const key of Object.keys(details)) cacheFields.add(`prompt_tokens_details.${key}`)
  }
}

process.stdout.write('\n== 结论 ==\n')
if (observations.length === 0) {
  process.stdout.write('没有观测到任何 usage 块 —— 上游在这条请求上根本不报 token。\n')
} else if (cacheFields.size === 0) {
  process.stdout.write('上游**没有**下发任何缓存字段（成因 B）。\n')
  process.stdout.write('→ 插件没有可丢的东西；能做的只有如实说明「上游未提供」，而不是显示 0%。\n')
} else {
  process.stdout.write(`上游**下发了**缓存字段（成因 A）：${[...cacheFields].join(', ')}\n`)
  process.stdout.write('→ 字段存在，所以「宿主显示 0%」只可能是透传层丢了它（1.7.0 已修：见 CHANGELOG）。\n')
  process.stdout.write('   若这里仍有缓存字段而 GUI 仍显示 0%，问题在透传之后，不在上游。\n')
}

process.exit(0)
