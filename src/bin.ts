#!/usr/bin/env node
/**
 * Standalone status/diagnostics CLI for the dsh-connect-qoder bundle.
 *
 * 参考：dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）——三个子命令
 * 的骨架（`doctor` / `status`）、`--json` 输出、`safeMessage` 脱敏与
 * 「凭据来源 + 上游连通性」诊断的结构由该项目设计。
 * 改动：无账号副本可清理，故不提供 `logout`；凭据只读环境变量（CLI 运行于
 * 宿主之外，无法访问设置服务）；`doctor` 增加指纹派生自检（cosy 会话稳定性）。
 *
 * @module dsh-connect-qoder/bin
 */

import { QoderUpstreamClient, QODER_REGIONS, isQoderUpstreamError } from './upstream.ts'
import { QODER_REGION_KEYS } from './status-paths.ts'
import { deriveFingerprint } from './cosy.ts'
import { QODER_PAT_ENV_VARS, patFromEnv } from './credentials.ts'

const JSON_SCHEMA_VERSION = 1

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-connect-qoder <doctor|status> [--json]',
    '',
    '  doctor   PAT source and cosy fingerprint diagnostics (no network)',
    '  status   per-region PAT presence and upstream model-list reachability',
    '  --json   emit one secret-free JSON document',
    '',
    'Credentials come from the environment:',
    `  ${QODER_PAT_ENV_VARS.global}   (global, qoder.sh)`,
    `  ${QODER_PAT_ENV_VARS.cn}       (CN, qoder.com.cn)`,
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

interface DoctorEntry {
  region: string
  gateway: string
  patEnv: string
  patPresent: boolean
  fingerprint: {
    machineId: string
    machineType: string
    machineToken: string
  }
}

function doctor(): void {
  const entries: DoctorEntry[] = QODER_REGION_KEYS.map(region => {
    const env = QODER_PAT_ENV_VARS[region]
    const fingerprint = deriveFingerprint('', `doctor:${region}`)
    return {
      region,
      gateway: QODER_REGIONS[region].gateway,
      patEnv: env,
      patPresent: patFromEnv(region) !== undefined,
      fingerprint: {
        machineId: fingerprint.machineId,
        machineType: fingerprint.machineType,
        machineToken: fingerprint.machineToken,
      },
    }
  })
  if (process.argv.includes('--json')) {
    printJson({ schemaVersion: JSON_SCHEMA_VERSION, entries })
    return
  }
  for (const entry of entries) {
    process.stdout.write(`[${entry.region}] ${entry.gateway}\n`)
    process.stdout.write(`  PAT ${entry.patEnv}: ${entry.patPresent ? 'present' : 'missing'}\n`)
    process.stdout.write(`  fingerprint: machineId=${entry.fingerprint.machineId} type=${entry.fingerprint.machineType}\n`)
  }
  const missing = entries.filter(entry => !entry.patPresent)
  if (missing.length > 0) {
    process.stdout.write(`\nNo PAT in the environment for: ${missing.map(entry => entry.region).join(', ')}\n`)
    process.stdout.write('Set the variable above (or configure the PAT in the plugin card) before using that region.\n')
  }
}

interface StatusEntry {
  region: string
  gateway: string
  patPresent: boolean
  models: number
  error?: string
}

async function status(): Promise<void> {
  const entries: StatusEntry[] = []
  for (const region of QODER_REGION_KEYS) {
    const pat = patFromEnv(region)
    const entry: StatusEntry = {
      region,
      gateway: QODER_REGIONS[region].gateway,
      patPresent: pat !== undefined,
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
    process.stdout.write(`  PAT: ${entry.patPresent ? 'present' : 'missing'}\n`)
    if (entry.error !== undefined) {
      process.stdout.write(`  upstream: FAILED (${entry.error})\n`)
    } else if (entry.patPresent) {
      process.stdout.write(`  upstream: OK, ${entry.models} models\n`)
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(arg => arg !== '--json')
  const command = args[0]
  if (command === 'doctor') {
    doctor()
    return
  }
  if (command === 'status') {
    await status()
    return
  }
  printHelp()
  process.exitCode = command === undefined ? 0 : 2
}

void main()
