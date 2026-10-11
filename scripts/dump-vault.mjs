#!/usr/bin/env node
/**
 * 现场验证：dump 本插件的本地 vault 与账号池测量文件（**只读，绝不打印 PAT**）。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 该项目 `scripts/probe-accounts.mjs` 的「直接读本地存储、按区域分组
 *   汇报」思路。本脚本按 Qoder 的 vault / pool 文件重写。
 *
 * 用途：账号池「为什么换了/没换账号」这类问题，需要看到两份落盘事实：
 *   - vault：`$DSH_HOME/.qoder-accounts.<region>.json`（有哪些账号）
 *   - pool ：`$DSH_HOME/.qoder-pool.<region>.json`（各账号最近一次测量）
 * 两者都由插件在运行期写入，本脚本只读。
 *
 * 用法：
 *   node scripts/dump-vault.mjs            # 两个区域都看
 *   node scripts/dump-vault.mjs cn         # 只看一个区域
 *
 * 安全：PAT 只显示掩码（前 6 位 + 长度），绝不输出完整 token。
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const regionArg = process.argv[2]
const regions = regionArg === 'cn' || regionArg === 'global' ? [regionArg] : ['cn', 'global']

/** The same $DSH_HOME resolution the plugin uses. */
function dshHome() {
  const home = process.env.DSH_HOME
  if (home && home.trim() !== '') return home
  const osHome = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return resolve(osHome, '.dsh')
}

/** Mask a PAT: never print the secret. */
function mask(pat) {
  if (typeof pat !== 'string' || pat === '') return '(empty)'
  return `${pat.slice(0, 6)}…(${pat.length} chars)`
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    return { __error: error?.code === 'ENOENT' ? 'not present' : String(error?.message ?? error) }
  }
}

const home = dshHome()
process.stdout.write(`DSH_HOME = ${home}\n`)

for (const region of regions) {
  const accountsPath = resolve(home, `.qoder-accounts.${region}.json`)
  const poolPath = resolve(home, `.qoder-pool.${region}.json`)
  process.stdout.write(`\n===== ${region} =====\n`)

  const accounts = await readJson(accountsPath)
  process.stdout.write(`vault  ${accountsPath}\n`)
  if (accounts.__error) {
    process.stdout.write(`  ${accounts.__error}\n`)
  } else {
    const list = Array.isArray(accounts.accounts) ? accounts.accounts : []
    process.stdout.write(`  version ${accounts.version} · ${list.length} account(s)\n`)
    for (const a of list) {
      process.stdout.write(`  - ${a.id}  name=${a.accountName || '(unnamed)'}  pat=${mask(a.pat)}  addedAt=${a.addedAtMs ? new Date(a.addedAtMs).toISOString() : '?'}\n`)
    }
  }

  const pool = await readJson(poolPath)
  process.stdout.write(`pool   ${poolPath}\n`)
  if (pool.__error) {
    process.stdout.write(`  ${pool.__error}\n`)
  } else {
    const probes = pool.probes ?? {}
    const ids = Object.keys(probes)
    process.stdout.write(`  version ${pool.version} · ${ids.length} measurement(s)\n`)
    for (const id of ids) {
      const p = probes[id] ?? {}
      const at = p.atMs ? new Date(p.atMs).toISOString() : '?'
      const retry = p.retryAtMs ? ` retryAt=${new Date(p.retryAtMs).toISOString()}` : ''
      process.stdout.write(`  - ${id}  outcome=${p.outcome} source=${p.source ?? '?'} at=${at}${retry}\n`)
    }
  }
}
