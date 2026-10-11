/**
 * Qoder 凭据解析：PAT（Personal Access Token）来源与账号 id 派生。
 *
 * PAT 优先级（每个区域独立）：
 * 1. 设置卡片里用户显式填写的 PAT（`config.regions.<region>.pat`）；
 * 2. 环境变量（`QODER_PERSONAL_ACCESS_TOKEN` / `QODERCN_PERSONAL_ACCESS_TOKEN`）；
 * 3. 插件自有保险库（`src/accounts.ts`）里登记的其余 PAT。
 *
 * 说明：Qoder CLI 的交互式登录凭据（`~/.qoder/qoder-cli-credentials.json`
 * 等）是 AES-256-GCM 加密存储的，密钥派生在 qodercli 二进制内，插件不做
 * 二进制逆向；本插件通过 PAT 接入。
 *
 * @module dsh-connect-qoder/credentials
 */

import { createHash } from 'node:crypto'
import type { QoderRegion } from './upstream.ts'

/** 各区域对应的 PAT 环境变量名。 */
export const QODER_PAT_ENV_VARS: Readonly<Record<QoderRegion, string>> = {
  global: 'QODER_PERSONAL_ACCESS_TOKEN',
  cn: 'QODERCN_PERSONAL_ACCESS_TOKEN',
}

/** 从设置里取该区域的 PAT（config 值，可能为空串）。 */
export function patFromSettings(settingsPat: string | undefined): string | undefined {
  const value = settingsPat?.trim()
  return value ? value : undefined
}

/** 从环境变量取该区域的 PAT。 */
export function patFromEnv(region: QoderRegion, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[QODER_PAT_ENV_VARS[region]]?.trim()
  return value ? value : undefined
}

/** 综合解析：设置优先，其次环境变量。 */
export function resolvePat(region: QoderRegion, settingsPat: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return patFromSettings(settingsPat) ?? patFromEnv(region, env)
}

/** PAT 形状校验（宽松：`pt-` 前缀或任意非空令牌）。 */
export function isValidPat(value: string): boolean {
  if (!value || value.length < 8) return false
  return true
}

/**
 * 一个 PAT 的稳定账号 id：`pat-` + sha256 前 16 位十六进制。
 *
 * 为什么不用上游的 uid：jobToken 交换能给出 uid，但那要求添加/导入时
 * 必须联机，而且 vault 里还没验证过的记录会没有 id 可用。从 PAT 本身派生
 * 的 id 离线可得、永不变化，且单向散列不把 token 材料泄进设置文件、
 * 日志或浏览器快照（id 会出现在卡片的 DOM 与 URL 参数里）。
 */
export function qoderAccountId(pat: string): string {
  return `pat-${createHash('sha256').update(pat, 'utf8').digest('hex').slice(0, 16)}`
}

/** 判断一个 id 是否由本插件的 PAT 派生规则产生。 */
export function isQoderAccountId(id: string): boolean {
  return /^pat-[0-9a-f]{16}$/.test(id)
}

/** 展示用的 PAT 掩码：只留头尾，绝不出现完整 token。 */
export function maskPat(pat: string): string {
  if (pat.length <= 10) return '…'
  return `${pat.slice(0, 5)}…${pat.slice(-4)}`
}
