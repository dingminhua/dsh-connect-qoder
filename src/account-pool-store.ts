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
  /**
   * 账号 id → 签到得到的积分批次（issue #31）。
   *
   * 落盘的理由：这些批次是「这批 100 分什么时候作废」的唯一依据，而它只可能
   * 由**一次成功的签到**产生。放在进程内意味着进程一重启，那天领到的 100 分就
   * 从「30 天后过期」变成「不知道什么时候过期」—— 而它其实还在上游账上。
   */
  credits?: Record<string, QoderStoredCheckinBatch[]>
  /**
   * 账号 id → 当日额度窗口的结束时刻（issue #32 的第三条）。
   *
   * `checkinSnapshots` 是进程内的，注释里也写了「重启后由下一次签到重新写入」。
   * 可是 code 110 的兜底冷却（30 分钟）恰恰只在「窗口时刻不知道」时生效，
   * 而进程一重启窗口时刻就没了 —— 兜底于是从「几乎不生效」变成「经常生效」。
   * 把上游给过的那一个时刻落盘，重启后仍能说「约 N 小时后解禁」。
   *
   * 存**时刻**而不是快照对象：`claimed` 是「今天领没领」，跨进程没有意义
   * （今天可能已经过了），而窗口时刻本身就是上游给的一个绝对时间点。
   */
  windows?: Record<string, number>
}

/** 落盘的一批签到积分（issue #31）。 */
export interface QoderStoredCheckinBatch {
  /** 领取时刻（epoch ms）—— 上游没给，本地在领到的那一刻记下。 */
  atMs: number
  /** 有效天数，来自 `benefit.validity.days`。 */
  validityDays: number
  /** 这一批的数额（`benefit.amount`），缺席 = 上游没说。 */
  amount?: number
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

/**
 * 一条落盘的签到批次，形状不对就丢掉（不猜）。
 *
 * `validityDays` 必须是正的有限数：0 或负数会让「到期时刻」落在领取之前，
 * 于是「最近到期」被算成一个已经过去的时刻 —— 那正是 issue #31 前半要修的症状。
 */
function knownBatch(value: unknown): QoderStoredCheckinBatch | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const atMs = record['atMs']
  const validityDays = record['validityDays']
  const amount = record['amount']
  if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs <= 0) return undefined
  if (typeof validityDays !== 'number' || !Number.isFinite(validityDays) || validityDays <= 0) return undefined
  return {
    atMs,
    validityDays,
    ...typeof amount === 'number' && Number.isFinite(amount) ? { amount } : {},
  }
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
  return (await readPoolDocument(region)).probes
}

/** 落盘文档的完整读法（probes + 签到批次 + 窗口时刻）。 */
export interface QoderPoolDocument {
  probes: Record<string, QoderPoolProbe>
  /** 账号 id → 签到批次（issue #31）；缺席 = 这一版还没落过盘。 */
  credits: Record<string, QoderStoredCheckinBatch[]>
  /** 账号 id → 当日窗口结束时刻（issue #32 第三条）；缺席 = 从没拿到过。 */
  windows: Record<string, number>
}

/**
 * 读出整个文档；任何一项坏了只丢那一项，不连坐。
 *
 * 分成三项而不是一个联合类型：三者来自三个不同的上游事实（探针、签到数额、
 * 签到窗口），缺任何一项都**不影响**另外两项可用。旧文件没有 `credits` /
 * `windows` 两个键，读出来是空表 —— 这正是「这一版还没量过」的自然表达。
 */
export async function readPoolDocument(region: QoderRegion): Promise<QoderPoolDocument> {
  const empty: QoderPoolDocument = { probes: {}, credits: {}, windows: {} }
  let raw: string
  try {
    raw = await readFile(qoderPoolStorePath(region), 'utf8')
  } catch {
    return empty
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  if (typeof parsed !== 'object' || parsed === null) return empty
  const document = parsed as Partial<PoolDocument>
  if (document.version !== STORE_FORMAT_VERSION) return empty
  if (typeof document.probes !== 'object' || document.probes === null) return empty
  const probes: Record<string, QoderPoolProbe> = {}
  for (const [accountId, probe] of Object.entries(document.probes)) {
    if (accountId === '' || !isProbe(probe)) continue
    probes[accountId] = {
      outcome: probe.outcome,
      atMs: probe.atMs,
      ...knownProbeSource(probe.source) === undefined ? {} : { source: knownProbeSource(probe.source)! },
      ...probe.retryAtMs === undefined ? {} : { retryAtMs: probe.retryAtMs },
      ...knownRetrySource(probe.retrySource) === undefined ? {} : { retrySource: knownRetrySource(probe.retrySource)! },
      // 排队信息（issue #26）：形状不对就整个丢掉，不猜。
      ...knownQueue(probe.queue) === undefined ? {} : { queue: knownQueue(probe.queue)! },
      ...probe.message === undefined ? {} : { message: probe.message },
      ...probe.modelId === undefined || probe.modelId === '' ? {} : { modelId: probe.modelId },
    }
  }
  const credits: Record<string, QoderStoredCheckinBatch[]> = {}
  if (typeof document.credits === 'object' && document.credits !== null) {
    for (const [accountId, batches] of Object.entries(document.credits)) {
      if (accountId === '' || !Array.isArray(batches)) continue
      const kept = batches.map(knownBatch).filter((b): b is QoderStoredCheckinBatch => b !== undefined)
      if (kept.length > 0) credits[accountId] = kept
    }
  }
  const windows: Record<string, number> = {}
  if (typeof document.windows === 'object' && document.windows !== null) {
    for (const [accountId, atMs] of Object.entries(document.windows)) {
      if (accountId === '' || typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs <= 0) continue
      windows[accountId] = atMs
    }
  }
  return { probes, credits, windows }
}

/**
 * 落盘的排队信息，只保留形状对的那些字段（issue #26）。
 *
 * 形状不对就返回 undefined（**丢掉**而不是留半个对象）—— 半个对象读起来会像
 * 「上游说队列里有 0 个人」，那不是上游说过的话。
 */
function knownQueue(value: unknown): QoderPoolProbe['queue'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const count = record['queueCount']
  const type = record['queueType']
  const out: NonNullable<QoderPoolProbe['queue']> = {}
  if (typeof count === 'number' && Number.isFinite(count) && count >= 0) out.queueCount = count
  if (typeof type === 'string' && type !== '') out.queueType = type
  return Object.keys(out).length === 0 ? undefined : out
}

/** A stored source string reduced to a source this build understands. */
function knownProbeSource(value: unknown): QoderPoolProbeSource | undefined {
  return value === 'test-batch' || value === 'live-request' ? value : undefined
}

/** 同上，`retryAtMs` 的来源（issue #32）；不认识的丢掉。 */
function knownRetrySource(value: unknown): QoderPoolProbe['retrySource'] | undefined {
  switch (value) {
    case 'retry-after':
    case 'upstream-message':
    case 'quota-refresh':
    case 'upstream-reported':
    case 'unknown-cooldown':
      return value
    default:
      return undefined
  }
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
  await writePoolDocument(region, { probes: updates })
}

/**
 * 合并写整个文档：三个键各自 merge，只写调用方给了的那一项。
 *
 * 为什么不复用 `writePoolProbes` 再读改写：那会把「读」放在锁外，两个不同的
 * 写入者（探针与签到）交错时后写的会吞掉先写的。这里在**同一次** `withFileLock`
 * 里读、合并、写。
 */
export async function writePoolDocument(
  region: QoderRegion,
  updates: {
    probes?: Readonly<Record<string, QoderPoolProbe>>
    credits?: Readonly<Record<string, readonly QoderStoredCheckinBatch[]>>
    windows?: Readonly<Record<string, number>>
  },
): Promise<void> {
  const probes = updates.probes ?? {}
  const credits = updates.credits ?? {}
  const windows = updates.windows ?? {}
  if (Object.keys(probes).length === 0
    && Object.keys(credits).length === 0
    && Object.keys(windows).length === 0) return
  const path = qoderPoolStorePath(region)
  try {
    await withFileLock(path, async () => {
      const existing = await readPoolDocument(region)
      // 只读数组在合并处展开成可变副本（`widen`）：写进文档的形状必须是普通
      // 数组，否则下一次读回来时 `Array.isArray` 之外的类型假设会不成立。
      const mergedCredits: Record<string, QoderStoredCheckinBatch[]> = { ...existing.credits }
      for (const [accountId, batches] of Object.entries(credits)) {
        mergedCredits[accountId] = [...batches]
      }
      const document: PoolDocument = {
        version: STORE_FORMAT_VERSION,
        probes: { ...existing.probes, ...probes },
        credits: mergedCredits,
        windows: { ...existing.windows, ...windows },
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