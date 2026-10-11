#!/usr/bin/env node
/**
 * Standalone status/diagnostics CLI for the dsh-connect-qoder bundle.
 *
 * 参考：dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）——三个子命令
 * 的骨架（`doctor` / `status` / `logout`）、`--json` 输出、`safeMessage` 脱敏与
 * 「凭据来源 + 上游连通性」诊断的结构由该项目设计。
 * 改动（按 Qoder 上游的现实）：
 *   - 凭据只读环境变量 + 本地 vault（CLI 运行于宿主之外，无法访问设置服务）；
 *   - `doctor` 增加 cosy 指纹派生自检、pi-ai 代际、宿主心跳存活、vault 账号计数；
 *   - `status` 汇报每区域凭据来源 + 上游可达性 + 当前剩余积分（总额）；
 *   - `logout` 清除本区域的 vault 凭据与账号池测量副本（可 `--region` 指定，
 *     否则两区域都清）。
 *
 * @module dsh-connect-qoder/bin
 */

import { QoderUpstreamClient, isQoderUpstreamError, QODER_REGIONS } from './upstream.ts'
import type { QoderRegion, QoderUsage } from './upstream.ts'
import { deriveFingerprint } from './cosy.ts'
import { QODER_PAT_ENV_VARS, patFromEnv } from './credentials.ts'
import { qoderAccountsPath, QoderAccountStore } from './accounts.ts'
import { qoderPoolStorePath } from './account-pool-store.ts'
import { piAiRuntimeInfo } from './pi-ai-runtime.ts'
import { readHostHeartbeat, isHeartbeatProcessAlive, qoderHostHeartbeatPath } from './host-heartbeat.ts'
import { rm } from 'node:fs/promises'

const JSON_SCHEMA_VERSION = 2
const REGION_KEYS: readonly QoderRegion[] = ['cn', 'global']

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

/** One region's total remaining credits from a usage read (secret-free). */
function creditsTotal(usage: QoderUsage | undefined): number | undefined {
  if (usage === undefined) return undefined
  let total = 0
  let seen = false
  const userQuota = usage.userQuota
  if (userQuota !== undefined && typeof userQuota.total === 'number') {
    total += Math.max(userQuota.total - (userQuota.used ?? 0), 0); seen = true
  }
  const addOnQuota = usage.addOnQuota
  if (addOnQuota !== undefined && typeof addOnQuota.total === 'number') {
    total += Math.max(addOnQuota.total - (addOnQuota.used ?? 0), 0); seen = true
  }
  const org = usage.orgResourcePackage
  if (org !== undefined && typeof org.cap === 'number') {
    total += Math.max(org.cap - (org.used ?? 0), 0); seen = true
  }
  return seen ? total : undefined
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-connect-qoder <doctor|status|logout> [--json] [--region cn|global]',
    '',
    '  doctor   PAT source, cosy fingerprint, pi-ai generation, heartbeat, vault (no network)',
    '  status   per-region PAT presence, upstream model-list reachability, credits',
    '  logout   clear the local vault accounts + pool measurements for a region',
    '  --json   emit one secret-free JSON document',
    '',
    'Credentials come from the environment:',
    `  ${QODER_PAT_ENV_VARS.global}   (global, qoder.sh)`,
    `  ${QODER_PAT_ENV_VARS.cn}       (CN, qoder.com.cn)`,
    'or from the local vault ($DSH_HOME/.qoder-accounts.<region>.json).',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function regionArg(): readonly QoderRegion[] {
  const index = process.argv.indexOf('--region')
  if (index !== -1) {
    const value = process.argv[index + 1]
    if (value === 'cn' || value === 'global') return [value]
  }
  return REGION_KEYS
}

interface DoctorEntry {
  region: string
  gateway: string
  patEnv: string
  patPresent: boolean
  vaultAccounts: number
  fingerprint: {
    machineId: string
    machineType: string
    machineToken: string
  }
}

interface DoctorReport {
  schemaVersion: number
  piAi: { generation: string, version: string }
  heartbeat: { present: boolean, alive: boolean, pid?: number }
  entries: DoctorEntry[]
}

async function doctor(): Promise<DoctorReport> {
  const piAi = piAiRuntimeInfo()
  const heartbeat = await readHostHeartbeat()
  const entries: DoctorEntry[] = []
  for (const region of REGION_KEYS) {
    const fingerprint = deriveFingerprint('', `doctor:${region}`)
    const vault = await new QoderAccountStore(region).vaultAccounts()
    entries.push({
      region,
      gateway: QODER_REGIONS[region].gateway,
      patEnv: QODER_PAT_ENV_VARS[region],
      patPresent: patFromEnv(region) !== undefined,
      vaultAccounts: vault.length,
      fingerprint: {
        machineId: fingerprint.machineId,
        machineType: fingerprint.machineType,
        machineToken: fingerprint.machineToken,
      },
    })
  }
  const report: DoctorReport = {
    schemaVersion: JSON_SCHEMA_VERSION,
    piAi: { generation: piAi?.generation ?? 'unknown', version: piAi?.version ?? 'unknown' },
    heartbeat: {
      present: heartbeat !== undefined,
      alive: heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat),
      ...(heartbeat?.pid === undefined ? {} : { pid: heartbeat.pid }),
    },
    entries,
  }
  if (process.argv.includes('--json')) {
    printJson(report)
    return report
  }
  process.stdout.write(`pi-ai: ${report.piAi.generation} (${report.piAi.version})\n`)
  process.stdout.write(`heartbeat: ${report.heartbeat.present ? (report.heartbeat.alive ? `alive (pid ${report.heartbeat.pid ?? '?'})` : 'stale') : 'absent'} — ${qoderHostHeartbeatPath()}\n`)
  for (const entry of entries) {
    process.stdout.write(`[${entry.region}] ${entry.gateway}\n`)
    process.stdout.write(`  PAT ${entry.patEnv}: ${entry.patPresent ? 'present' : 'missing'}\n`)
    process.stdout.write(`  vault: ${entry.vaultAccounts} account(s) — ${qoderAccountsPath(entry.region as QoderRegion)}\n`)
    process.stdout.write(`  fingerprint: machineId=${entry.fingerprint.machineId} type=${entry.fingerprint.machineType}\n`)
  }
  const missing = entries.filter(entry => !entry.patPresent && entry.vaultAccounts === 0)
  if (missing.length > 0) {
    process.stdout.write(`\nNo PAT in the environment or vault for: ${missing.map(entry => entry.region).join(', ')}\n`)
    process.stdout.write('Set the variable above (or add an account in the plugin card) before using that region.\n')
  }
  return report
}

interface StatusEntry {
  region: string
  gateway: string
  patSource?: 'env' | 'vault' | 'none'
  models: number
  creditsTotal?: number
  error?: string
}

async function status(): Promise<void> {
  const entries: StatusEntry[] = []
  for (const region of REGION_KEYS) {
    const envPat = patFromEnv(region)
    const store = new QoderAccountStore(region)
    const vault = await store.vaultAccounts()
    const pat = envPat ?? vault[0]?.pat
    const patSource: StatusEntry['patSource'] = envPat !== undefined ? 'env' : (vault.length > 0 ? 'vault' : 'none')
    const entry: StatusEntry = {
      region,
      gateway: QODER_REGIONS[region].gateway,
      ...(patSource === undefined ? {} : { patSource }),
      models: 0,
    }
    if (pat === undefined) {
      entries.push(entry)
      continue
    }
    try {
      const client = new QoderUpstreamClient(region)
      const models = await client.fetchModels(pat)
      entry.models = models.length
      try {
        const usage = await client.fetchUsage(pat)
        const credits = creditsTotal(usage)
        if (credits !== undefined) entry.creditsTotal = credits
      } catch {
        // 用量读取失败不掩盖模型可达性。
      }
    } catch (error) {
      if (isQoderUpstreamError(error)) {
        entry.error = `${error.kind} (HTTP ${error.status}): ${safeMessage(error.message)}`
      } else {
        entry.error = safeMessage(error)
      }
    }
    entries.push(entry)
  }
  if (process.argv.includes('--json')) {
    printJson({ schemaVersion: JSON_SCHEMA_VERSION, entries })
    return
  }
  for (const entry of entries) {
    process.stdout.write(`[${entry.region}] ${entry.gateway}\n`)
    process.stdout.write(`  PAT: ${entry.patSource ?? 'none'}\n`)
    if (entry.error !== undefined) {
      process.stdout.write(`  upstream: FAILED (${entry.error})\n`)
    } else if (entry.patSource !== 'none') {
      const credits = entry.creditsTotal === undefined ? '' : `, credits ${entry.creditsTotal}`
      process.stdout.write(`  upstream: OK, ${entry.models} models${credits}\n`)
    }
  }
}

async function logout(): Promise<void> {
  const regions = regionArg()
  const cleared: string[] = []
  for (const region of regions) {
    for (const path of [qoderAccountsPath(region), qoderPoolStorePath(region)]) {
      try {
        await rm(path, { force: true })
        cleared.push(path)
      } catch {
        // 已删除或不可达：继续。
      }
    }
  }
  if (process.argv.includes('--json')) {
    printJson({ schemaVersion: JSON_SCHEMA_VERSION, cleared })
    return
  }
  process.stdout.write(cleared.length === 0
    ? 'Nothing to clear (no vault files present).\n'
    : `Cleared:\n${cleared.map(path => `  ${path}\n`).join('')}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(arg => arg !== '--json' && arg !== '--region' && REGION_KEYS.includes(arg as QoderRegion))
  const command = args[0]
  if (command === 'doctor') {
    await doctor()
    return
  }
  if (command === 'status') {
    await status()
    return
  }
  if (command === 'logout') {
    await logout()
    return
  }
  printHelp()
  process.exitCode = command === undefined ? 0 : 2
}

void main()
