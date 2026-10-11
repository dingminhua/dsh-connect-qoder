/**
 * Node-free constants and types shared by the Host and browser halves.
 *
 * 参考：dsh-connect-workbuddy（MIT）——「同源只读路由 + 与浏览器共享的
 * node-free 类型定义」的 host↔client 桥梁形态沿用其 `status-paths.ts`。
 *
 * @module dsh-connect-qoder/status-paths
 */

/** Plugin id (loader entry); the settings namespace mirrors it on the host. */
export const QODER_SETTINGS_NS = 'dsh-connect-qoder'

/** Plugin-owned status endpoint consumed by its browser half. */
export const QODER_STATUS_PATH = '/plugins/dsh-connect-qoder/status'
/** Plugin-owned live model refresh endpoint. */
export const QODER_MODELS_REFRESH_PATH = '/plugins/dsh-connect-qoder/models/refresh'
/** Plugin-owned banked-credits usage endpoint. */
export const QODER_USAGE_PATH = '/plugins/dsh-connect-qoder/usage'
/** Plugin-owned single-model probe endpoint. */
export const QODER_PROBE_PATH = '/plugins/dsh-connect-qoder/probe'

/** The project's public repository. */
export const QODER_GITHUB_URL = 'https://github.com/dingminhua/dsh-connect-qoder'

/** Region keys, CN and Global mirror the workbuddy dual-provider pattern. */
export const QODER_REGION_KEYS = ['cn', 'global'] as const

/** Browser-facing snapshot of one region. */
export interface QoderStatusRegion {
  enabled: boolean
  /** PAT configured (settings or env)? (boolean only; never the token itself) */
  hasCredential: boolean
  upstreamReachable: boolean
  accountName: string | null
  accountId: string | null
  usageError: string | null
  /** Last-refreshed directory (may be the static fallback). */
  models: QoderStatusModel[]
  modelCount: number
  /** Live usage, if the upstream answered. */
  usage: QoderStatusUsage | null
  usageAtMs: number | null
  checkedInToday: boolean | null
}

export interface QoderStatusModel {
  key: string
  displayName: string
  priceFactor: number
  contextWindow: number
  maxOutputTokens: number
  supportsImages: boolean
  supportsThinking: boolean
  isDefault: boolean
  isFree: boolean
}

export interface QoderStatusUsage {
  userType: string | null
  expiresAt: number | null
  upgradeUrl: string | null
  userQuota: { total: number; used: number; remaining: number; percentage: number } | null
  addOnQuota: { total: number; used: number; remaining: number; percentage: number } | null
  orgResourcePackage: { used: number; cap: number; remaining: number; percentage: number; available: boolean } | null
}

/** Freshness policy: usage cache TTL, probe cache TTL. */
export const QODER_USAGE_CACHE_MS = 60_000
export const QODER_PROBE_CACHE_MS = 10 * 60_000