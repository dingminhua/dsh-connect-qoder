#!/usr/bin/env node
/**
 * 只读探测：拉一次 /sash/api/v1/me/campaigns，把**原始 JSON** 打出来，
 * 看上游对 VIEW_DETAILS 活动（1024 集结 / 首月翻倍这类 banner）到底下发哪些字段。
 *
 * 安全：只 GET（绝不领取）；PAT 绝不打印（只报来源与掩码）。
 * 用法：node scripts/probe-campaigns.mjs [cn|global]
 */

// 分块名随构建变（tsdown 的 hash）；改完 build 若报错就对照 lib/ 下的新名。
import { y as QoderUpstreamClient } from '../lib/host-heartbeat-BBvAw9Jj.js'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const regionArg = process.argv[2]
const regions = regionArg === 'cn' || regionArg === 'global' ? [regionArg] : ['cn', 'global']

const ENV_BY_REGION = { cn: 'QODERCN_PERSONAL_ACCESS_TOKEN', global: 'QODER_PERSONAL_ACCESS_TOKEN' }

function dshHome() {
  const home = process.env.DSH_HOME
  if (home && home.trim() !== '') return home
  const osHome = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return resolve(osHome, '.dsh')
}

function mask(pat) {
  if (typeof pat !== 'string' || pat === '') return '(empty)'
  return pat.length <= 12 ? '\*(short)' : pat.slice(0, 6) + '…(' + pat.length + ' chars)'
}

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch (error) {
    return { __error: error?.code === 'ENOENT' ? 'not present' : String(error?.message ?? error) }
  }
}

/** Resolve a PAT for a region without printing it. */
async function resolvePat(region) {
  const fromEnv = process.env[ENV_BY_REGION[region]]?.trim()
  if (fromEnv) return { pat: fromEnv, source: 'env' }
  const vault = await readJson(resolve(dshHome(), '.qoder-accounts.' + region + '.json'))
  const list = Array.isArray(vault.accounts) ? vault.accounts : []
  const first = list[0]?.pat
  if (first) return { pat: first, source: 'vault (' + mask(first) + ')' }
  return { pat: undefined, source: vault.__error || 'no env PAT and vault ' + (list.length === 0 ? 'empty' : 'no entry') }
}

for (const region of regions) {
  process.stdout.write('\n===== ' + region + ' =====\n')
  const { pat, source } = await resolvePat(region)
  process.stdout.write('pat source: ' + source + '\n')
  if (!pat) {
    process.stdout.write('  SKIP (no credential)\n')
    continue
  }

  const rawByUrl = new Map()
  const client = new QoderUpstreamClient(region, {
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      const resp = await globalThis.fetch(input, init)
      const text = await resp.clone().text()
      if (url.includes('/me/campaigns')) {
        rawByUrl.set(url.split('?')[0] + (url.includes('claim') ? '/claim' : ''), {
          status: resp.status,
          body: text,
        })
      }
      return resp
    },
  })

  try {
    const feed = await client.fetchCampaignFeed(pat)
    process.stdout.write('feed top-level: ' + JSON.stringify({ campaignUrl: feed.campaignUrl, showCampaign: feed.showCampaign, claimable: feed.claimable }) + '\n')
    process.stdout.write('feed rows: ' + feed.campaigns.length + '\n')
    for (const row of feed.campaigns) {
      process.stdout.write('  - ' + JSON.stringify(row) + '\n')
    }
  } catch (error) {
    process.stdout.write('  fetchCampaignFeed error: ' + String(error?.message ?? error) + '\n')
  }

  for (const [url, entry] of rawByUrl) {
    process.stdout.write('\nRAW ' + url + ' [HTTP ' + entry.status + ']:\n')
    let text = entry.body
    if (text.length > 3000) text = text.slice(0, 3000) + '\n…(truncated ' + entry.body.length + ' chars)'
    process.stdout.write(text + '\n')
  }
  if (rawByUrl.size === 0) process.stdout.write('(no campaign response captured)\n')
}
