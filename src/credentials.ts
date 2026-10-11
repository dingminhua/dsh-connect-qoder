/**
 * Qoder 凭据解析：PAT（Personal Access Token）来源。
 *
 * 优先级（每个区域独立）：
 * 1. 设置卡片里用户显式填写的 PAT（`config.regions.<region>.pat`）；
 * 2. 环境变量（`QODER_PERSONAL_ACCESS_TOKEN` / `QODERCN_PERSONAL_ACCESS_TOKEN`）。
 *
 * 说明：Qoder CLI 的交互式登录凭据（`~/.qoder/qoder-cli-credentials.json`
 * 等）是 AES-256-GCM 加密存储的，密钥派生在 qodercli 二进制内，插件不做
 * 二进制逆向；本版通过 PAT 接入。将来可加「读取本机登录」的能力。
 *
 * @module dsh-connect-qoder/credentials
 */

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
