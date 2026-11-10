/**
 * 自动签到的落盘记忆。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）的
 *   `src/auto-checkin-store.ts`，以及本仓库 `src/account-pool-store.ts` 的落盘
 *   约定（`$DSH_HOME` 下 `.qoder-pool.<region>.json`，`withFileLock` +
 *   `writeFileAtomic`，`mode: 0o600`）。
 * 改动：
 *   1. 文件名前缀换成本插件的 `.qoder-auto-checkin`；
 *   2. **直接读写 `status-paths.ts` 里那份降级过的状态校验器**（见下），不再为
 *      「磁盘上的一行」维护第二套形状 —— 上一版这种双份形状已经漂移过一次。
 *
 * ## 为什么单独落盘，而不是塞进 settings
 *
 * 卡片对用户偏好用的是「草稿 → 保存 → 丢弃草稿」模式。签到进度是插件自己高频写
 * 的运行状态，不是用户偏好；把它塞进 `regions[region].pool` 会让用户手点一次
 * 「保存」，用几分钟前的草稿把它覆盖回去。这与 `account-pool-store.ts` 当初把
 * 探测结果搬出 settings 是同一个理由。
 *
 * ## 读写从不抛异常
 *
 * 自动签到是增强功能。一个损坏的进度文件绝不能让插件启动失败或让卡片渲染不出来
 * —— 最坏情况是「这一窗当作没签过」，而那次重跑是幂等的（先读状态、已签判
 * already）。
 *
 * @module dsh-connect-qoder/auto-checkin-store
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { AutoCheckinState } from './auto-checkin.ts'
import type { QoderRegion } from './upstream.ts'

/** 落盘格式版本；读侧拒绝别的版本。 */
const STORE_FORMAT_VERSION = 1

/** 一个区域的自动签到记忆的文件名前缀。 */
const AUTO_CHECKIN_PREFIX = '.qoder-auto-checkin'

/** 真正写到磁盘上的文档。 */
interface AutoCheckinDocument {
  version: typeof STORE_FORMAT_VERSION
  /** 区域 → 该区域的状态（`window` 是它的身份）。 */
  regions: Record<string, AutoCheckinState>
}

/**
 * 一个值看起来是不是一份存储的状态。
 *
 * 校验到**字段级**而不是只看 `window` 在不在：这些字段决定要不要发真实领取请求
 * 与退避多久，一份半截的对象（比如 `failures` 是字符串）会让 `nextDelayMs` 算出
 * `NaN` 从而每毫秒醒一次。形状不对就整份丢掉，退回「这一窗没签过」。
 */
function isState(value: unknown): value is AutoCheckinState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['window'] === 'string'
    && candidate['window'] !== ''
    && Array.isArray(candidate['doneAccountIds'])
    && candidate['doneAccountIds'].every(id => typeof id === 'string')
    && typeof candidate['scopeSize'] === 'number'
    && Number.isFinite(candidate['scopeSize'])
    && candidate['scopeSize'] >= 0
    && typeof candidate['failures'] === 'number'
    && Number.isFinite(candidate['failures'])
    && candidate['failures'] >= 0
    && (candidate['lastAttemptAtMs'] === undefined || typeof candidate['lastAttemptAtMs'] === 'number')
    && (candidate['lastError'] === undefined || typeof candidate['lastError'] === 'string')
}

/** 一个区域的自动签到记忆路径。 */
export function autoCheckinStorePath(region: QoderRegion): string {
  return join(resolveDshHome(), `${AUTO_CHECKIN_PREFIX}.${region}.json`)
}

/**
 * 读一个区域的存储状态。
 *
 * 文件不存在、读不动、JSON 坏了、版本对不上、形状不对 —— 五种情况一律返回
 * `undefined`，读作「这一窗什么都没做过」（见模块说明）。**不抛**。
 */
export async function readAutoCheckinState(region: QoderRegion): Promise<AutoCheckinState | undefined> {
  const regions = await readDocument(autoCheckinStorePath(region))
  return regions[region]
}

/**
 * 写一个区域的状态，合并进文件里已经有的内容。
 *
 * 是**合并**而不是覆盖，理由与 `writePoolDocument` 相同：两个区域各跑各的，
 * 一个区域的写不能把另一个区域的记忆抹掉。**不抛**，见模块说明。
 */
export async function writeAutoCheckinState(region: QoderRegion, state: AutoCheckinState): Promise<void> {
  const path = autoCheckinStorePath(region)
  try {
    await withFileLock(path, async () => {
      const existing = await readDocument(path)
      const document: AutoCheckinDocument = {
        version: STORE_FORMAT_VERSION,
        regions: { ...existing, [region]: state },
      }
      await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  } catch {
    // 刻意吞掉：见模块说明。运行器退化成「从旧一点的记忆接着跑」，而不是
    // 「插件启动失败」。
  }
}

/**
 * 读整份文档（供上面的合并与单区域读共用）。
 *
 * 只留下**形状完好**的区域条目：一个区域坏了，不能让它连带把另一个区域的内容
 * 当成垃圾写回去。
 */
async function readDocument(path: string): Promise<Record<string, AutoCheckinState>> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const document = parsed as Partial<AutoCheckinDocument>
  if (document.version !== STORE_FORMAT_VERSION) return {}
  const regions = document.regions
  if (typeof regions !== 'object' || regions === null) return {}
  const clean: Record<string, AutoCheckinState> = {}
  for (const [key, value] of Object.entries(regions as Record<string, unknown>)) {
    if (key === '' || !isState(value)) continue
    clean[key] = {
      window: value.window,
      doneAccountIds: [...value.doneAccountIds],
      scopeSize: value.scopeSize,
      failures: value.failures,
      ...value.lastAttemptAtMs === undefined ? {} : { lastAttemptAtMs: value.lastAttemptAtMs },
      ...value.lastError === undefined ? {} : { lastError: value.lastError },
    }
  }
  return clean
}
