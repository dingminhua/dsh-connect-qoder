#!/usr/bin/env node
/**
 * 现场验证：用一个 PAT 走一遍 cosy 网关的关键链路——**只读**。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 该项目 `scripts/probe-*.mjs` 的「不依赖宿主、直接对上游验证」思路。
 *   本脚本按 Qoder 的 cosy 协议重写，复用插件自身的实现（不重复造协议）。
 *
 * 用途：网关/协议/额度接口改动后，不必启动 DSH 就能确认四件事：
 *   1. JobToken 交换（PAT → jobToken + 会话封装）
 *   2. 模型目录 model/list
 *   3. 用量 sash/api/v2/me/usage（只读，不消耗积分）
 *   4. （可选）对一个模型发一次极小的真实聊天请求
 *
 * 用法：
 *   QODERCN_PERSONAL_ACCESS_TOKEN=pt-... node scripts/probe-cosy.mjs cn
 *   QODER_PERSONAL_ACCESS_TOKEN=pt-...     node scripts/probe-cosy.mjs global [--chat <modelKey>]
 *
 * 凭据只从环境变量读取，绝不落盘；--chat 会**真实消耗**少量额度，默认不跑。
 */

import { QoderUpstreamClient } from '../src/upstream.ts'
import { probeUserMessage } from '../src/probe.ts'

const region = process.argv[2] === 'global' ? 'global' : 'cn'
const chatIndex = process.argv.indexOf('--chat')
const chatModel = chatIndex === -1 ? undefined : process.argv[chatIndex + 1]

const envVar = region === 'cn' ? 'QODERCN_PERSONAL_ACCESS_TOKEN' : 'QODER_PERSONAL_ACCESS_TOKEN'
const pat = process.env[envVar]

if (!pat) {
  process.stderr.write(`missing ${envVar}\n`)
  process.exit(2)
}

/** Token-like strings must never reach stdout. */
function redact(text) {
  return String(text)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/\bpt-[A-Za-z0-9_-]{6,}\b/giu, '[redacted credential]')
}

const client = new QoderUpstreamClient(region, { logger: (m) => process.stderr.write(`[upstream] ${redact(m)}\n`) })

async function step(label, fn) {
  process.stdout.write(`\n== ${label} ==\n`)
  try {
    const out = await fn()
    process.stdout.write(`${typeof out === 'string' ? out : JSON.stringify(out, null, 2)}\n`)
    return true
  } catch (error) {
    process.stdout.write(`FAILED: ${redact(error?.message ?? error)} (kind=${error?.kind ?? 'n/a'} status=${error?.status ?? 'n/a'})\n`)
    return false
  }
}

let ok = true

ok = await step('1. JobToken exchange', async () => {
  const job = await client.exchangeJobToken(pat)
  // 只报结构性字段，绝不回显任何 token。
  return { name: job.name, userType: job.userType, expireTime: job.expireTime, hasOauthToken: Boolean(job.securityOauthToken) }
}) && ok

ok = await step('2. model/list', async () => {
  const models = await client.fetchModels(pat)
  return models.map(m => ({ key: m.key, name: m.display_name, vl: m.is_vl, reasoning: m.is_reasoning, free: m.is_free, priceFactor: m.price_factor }))
}) && ok

await step('3. usage (read-only)', async () => {
  const usage = await client.fetchUsage(pat)
  return usage ?? null
})

if (chatModel !== undefined) {
  await step(`4. chat probe (${chatModel}) — costs a little credit`, async () => {
    let first = false
    let chars = 0
    await client.chatStream(pat, chatModel, [{ role: 'user', content: probeUserMessage(1000) }], {
      isReasoning: false,
      isVl: false,
      onDelta: (d) => {
        if (!first) { first = true; process.stdout.write('  (first delta received)\n') }
        chars += d.content.length + d.reasoningContent.length
      },
    })
    return { answered: first, approxChars: chars }
  })
}

process.exit(ok ? 0 : 1)
