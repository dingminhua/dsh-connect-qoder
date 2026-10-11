/**
 * The account pool's RUNTIME store: measured facts, on disk, outside settings.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT）的 `src/account-pool-store.ts`。
 * 改动：文件名前缀换成本插件的 `.qoder-pool`；其余逐行沿用 —— 同一套
 *   `$DSH_HOME` 落盘约定（`withFileLock` + `writeFileAtomic`、`0o600`）、
 *   「观测数据与用户设置分开落盘」（否则卡片草稿保存会用几分钟前的草稿覆盖掉
 *   探测结果）、以及「读写从不抛异常给调用方」。
 *
 * @module dsh-connect-qoder/account-pool-store
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { QoderPoolProbe, QoderPoolProbeSource } from './account-pool.ts'
import type { QoderRegion } from './upstream.ts'

/** On-disk format version; readers reject anything else. */
const STORE_FORMAT_VERSION = 1

/** Filename prefix for one region's measured pool facts. */
const POOL_STORE_PREFIX = '.qoder-pool'

/** The document actually written to disk. */
interface PoolDocument {
  version: typeof STORE_FORMAT_VERSION
  /** Account id → its most recent measurement of the region's target model. */
  probes: Record<string, QoderPoolProbe>
}

/** Whether a parsed value looks like a stored probe. */
function isProbe(value: unknown): value is QoderPoolProbe {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['outcome'] === 'string'
    && typeof candidate['atMs'] === 'number'
    && (candidate['retryAtMs'] === undefined || typeof candidate['retryAtMs'] === 'number')
    && (candidate['message'] === undefined || typeof candidate['message'] === 'string')
    // A source this build does not recognise is DROPPED, not rejected.
    && (candidate['source'] === undefined || typeof candidate['source'] === 'string')
}

/** One region's path for measured pool facts. */
export function qoderPoolStorePath(region: QoderRegion): string {
  return join(resolveDshHome(), `${POOL_STORE_PREFIX}.${region}.json`)
}

/**
 * Read one region's measured facts.
 *
 * Returns an empty map for a missing, unreadable, malformed, or
 * version-mismatched file: all four mean "nothing measured yet".
 */
export async function readPoolProbes(
  region: QoderRegion,
): Promise<Record<string, QoderPoolProbe>> {
  let raw: string
  try {
    raw = await readFile(qoderPoolStorePath(region), 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const document = parsed as Partial<PoolDocument>
  if (document.version !== STORE_FORMAT_VERSION) return {}
  if (typeof document.probes !== 'object' || document.probes === null) return {}
  const probes: Record<string, QoderPoolProbe> = {}
  for (const [accountId, probe] of Object.entries(document.probes)) {
    if (accountId === '' || !isProbe(probe)) continue
    probes[accountId] = {
      outcome: probe.outcome,
      atMs: probe.atMs,
      ...knownProbeSource(probe.source) === undefined ? {} : { source: knownProbeSource(probe.source)! },
      ...probe.retryAtMs === undefined ? {} : { retryAtMs: probe.retryAtMs },
      ...probe.message === undefined ? {} : { message: probe.message },
    }
  }
  return probes
}

/** A stored source string reduced to a source this build understands. */
function knownProbeSource(value: unknown): QoderPoolProbeSource | undefined {
  return value === 'test-batch' || value === 'live-request' ? value : undefined
}

/**
 * Merge measurements into one region's store and write it atomically.
 *
 * A MERGE rather than a replace, because batches measure one account at a time
 * and a partial failure must not erase what earlier runs learned. Never
 * throws: a failed write loses only the newest measurements.
 */
export async function writePoolProbes(
  region: QoderRegion,
  updates: Readonly<Record<string, QoderPoolProbe>>,
): Promise<void> {
  if (Object.keys(updates).length === 0) return
  const path = qoderPoolStorePath(region)
  try {
    await withFileLock(path, async () => {
      const existing = await readPoolProbes(region)
      const document: PoolDocument = {
        version: STORE_FORMAT_VERSION,
        probes: { ...existing, ...updates },
      }
      await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  } catch {
    // Deliberately swallowed; see the function note.
  }
}