/**
 * Qoder 凭据解析：PAT 来源、账号 id 派生、掩码。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   `tests/auth.spec.ts` 的凭据来源优先级与 id 派生思路。Qoder 端口用 PAT 取代
 *   桌面登录，因此没有 refresh token / 过期族字段，id 由 PAT 单向散列派生
 *   （`pat-` + sha256[:16]），不依赖联机验证也不泄 token 材料。
 *
 * 断言重点：patFromSettings / patFromEnv / resolvePat 的三级来源解析、
 * isValidPat 的形状校验、qoderAccountId 的单向确定性、isQoderAccountId、
 * maskPat 永不暴露完整 token。
 */

import { describe, afterEach, expect, it } from 'vitest'
import {
  isQoderAccountId,
  isValidPat,
  maskPat,
  patFromEnv,
  patFromSettings,
  QODER_PAT_ENV_VARS,
  qoderAccountId,
  resolvePat,
} from '../src/credentials.ts'

describe('QODER_PAT_ENV_VARS', () => {
  it('names one env var per region', () => {
    expect(QODER_PAT_ENV_VARS.global).toBe('QODER_PERSONAL_ACCESS_TOKEN')
    expect(QODER_PAT_ENV_VARS.cn).toBe('QODERCN_PERSONAL_ACCESS_TOKEN')
    expect(QODER_PAT_ENV_VARS.cn).not.toBe(QODER_PAT_ENV_VARS.global)
  })
})

describe('patFromSettings', () => {
  it('trims and returns a non-empty value', () => {
    expect(patFromSettings('  pt-abc  ')).toBe('pt-abc')
    expect(patFromSettings(undefined)).toBeUndefined()
  })

  it('returns undefined for a blank string', () => {
    expect(patFromSettings('')).toBeUndefined()
    expect(patFromSettings('   ')).toBeUndefined()
  })
})

describe('patFromEnv', () => {
  const env: NodeJS.ProcessEnv = {}

  afterEach(() => {
    delete env['QODER_PERSONAL_ACCESS_TOKEN']
    delete env['QODERCN_PERSONAL_ACCESS_TOKEN']
  })

  it('reads the region-specific variable from the given env', () => {
    env['QODER_PERSONAL_ACCESS_TOKEN'] = '  pt-global-value  '
    env['QODERCN_PERSONAL_ACCESS_TOKEN'] = 'pt-cn-value'
    expect(patFromEnv('global', env)).toBe('pt-global-value')
    expect(patFromEnv('cn', env)).toBe('pt-cn-value')
  })

  it('reads the global variable for the global region and cn for cn', () => {
    // 两个区域变量互不通用。
    env['QODERCN_PERSONAL_ACCESS_TOKEN'] = 'pt-cn-only'
    expect(patFromEnv('cn', env)).toBe('pt-cn-only')
    expect(patFromEnv('global', env)).toBeUndefined()
  })

  it('returns undefined when the region variable is absent or blank', () => {
    env['QODER_PERSONAL_ACCESS_TOKEN'] = '   '
    expect(patFromEnv('global', env)).toBeUndefined()
    expect(patFromEnv('cn', env)).toBeUndefined()
  })
})

describe('resolvePat', () => {
  const env: NodeJS.ProcessEnv = {}
  afterEach(() => {
    delete env['QODER_PERSONAL_ACCESS_TOKEN']
    delete env['QODERCN_PERSONAL_ACCESS_TOKEN']
  })

  it('prefers the settings PAT over the environment', () => {
    env['QODER_PERSONAL_ACCESS_TOKEN'] = 'pt-from-env'
    expect(resolvePat('global', 'pt-from-settings', env)).toBe('pt-from-settings')
  })

  it('falls back to the environment when settings is blank', () => {
    env['QODER_PERSONAL_ACCESS_TOKEN'] = 'pt-from-env'
    expect(resolvePat('global', '', env)).toBe('pt-from-env')
    expect(resolvePat('global', undefined, env)).toBe('pt-from-env')
  })

  it('returns undefined when neither source yields a token', () => {
    expect(resolvePat('global', undefined, env)).toBeUndefined()
  })
})

describe('isValidPat', () => {
  it('accepts a token of length >= 8', () => {
    expect(isValidPat('pt-12345678')).toBe(true)
    expect(isValidPat('12345678')).toBe(true)
  })

  it('rejects empty and under-8-char values', () => {
    expect(isValidPat('')).toBe(false)
    expect(isValidPat('pt-1234')).toBe(false)
  })
})

describe('qoderAccountId', () => {
  it('derives a stable, deterministic id from a PAT', () => {
    const first = qoderAccountId('pt-some-token-abc')
    expect(first).toMatch(/^pat-[0-9a-f]{16}$/)
    expect(qoderAccountId('pt-some-token-abc')).toBe(first)
  })

  it('yields different ids for different tokens', () => {
    expect(qoderAccountId('pt-token-one')).not.toBe(qoderAccountId('pt-token-two'))
  })

  it('never leaks the raw token into the id', () => {
    const token = 'pt-super-secret-value'
    expect(qoderAccountId(token)).not.toContain(token)
  })
})

describe('isQoderAccountId', () => {
  it('recognises ids produced by qoderAccountId', () => {
    expect(isQoderAccountId(qoderAccountId('pt-anything'))).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isQoderAccountId('pat-deadbeefdeadbeefgg')).toBe(false) // 17 hex，超长
    expect(isQoderAccountId('pat-xyzxyzxyzxyzxyz')).toBe(false)     // 非十六进制
    expect(isQoderAccountId('uid-123')).toBe(false)
    expect(isQoderAccountId('')).toBe(false)
  })
})

describe('maskPat', () => {
  it('keeps only the head and tail of a long token', () => {
    expect(maskPat('pt-abcdefghijklmnop')).toBe('pt-ab…mnop')
  })

  it('never reveals the middle of the token', () => {
    const token = 'pt-secret-middle-zone'
    const masked = maskPat(token)
    expect(token).not.toEqual(masked)
    expect(masked).not.toContain('secret-middle')
  })

  it('collapses very short tokens to an ellipsis', () => {
    expect(maskPat('short')).toBe('…')
  })
})