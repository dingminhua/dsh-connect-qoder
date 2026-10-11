import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import {
  cosyEncode,
  cosyDecode,
  CUSTOM_ALPHABET,
  CUSTOM_PAD,
  signLegacy,
  deriveFingerprint,
  newCosySession,
  identityFromJobToken,
  rsaDecrypt,
  buildPayloadB64,
  signRequest,
  composeBearer,
  pathSigFrom,
  currentRfc1123Date,
  parseRfc1123Date,
  COSY_SECRET_B64,
} from '../src/cosy.ts'

describe('cosy custom base64', () => {
  it('roundtrips arbitrary payloads', () => {
    const samples = [
      'hello world',
      '',
      '{"payload":"{\\"personalToken\\":\\"pt-abc\\"}"}',
      'A'.repeat(1000),
      '中文内容 ünïcode 😀',
      Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]).toString('binary'),
    ]
    for (const sample of samples) {
      const bytes = new Uint8Array(Buffer.from(sample, 'utf8'))
      const encoded = cosyEncode(bytes)
      // 字母表约束：只能出现自定义字符
      for (const ch of encoded) {
        expect(CUSTOM_ALPHABET.includes(ch) || ch === CUSTOM_PAD).toBe(true)
      }
      const decoded = cosyDecode(encoded)
      expect(Buffer.from(decoded).toString('utf8')).toBe(sample)
    }
  })

  it('handles binary data exactly', () => {
    const raw = new Uint8Array(257)
    for (let i = 0; i < 257; i += 1) raw[i] = i % 256
    const decoded = cosyDecode(cosyEncode(raw))
    expect([...decoded]).toEqual([...raw])
  })

  it('pad character is `$` and blocks map per spec', () => {
    // 参考实现（qoder2api）：'a' 的标准 base64 "YQ==" 重排后 pad 前置
    expect(cosyEncode(new Uint8Array(Buffer.from('a')))).toBe('$p$#')
    expect(cosyEncode(new Uint8Array(Buffer.from('ab')))).toBe('$SB#')
    expect(cosyEncode(new Uint8Array(Buffer.from('abc')))).toBe('MSK#')
    expect(cosyEncode(new Uint8Array(Buffer.from('hello')))).toBe('q$FruHPH')
  })
})

describe('legacy signature', () => {
  it('is md5("cosy&<secret>&<date>")', () => {
    const date = 'Sun, 11 Oct 2026 05:30:30 GMT'
    const sig = signLegacy(date)
    expect(sig).toMatch(/^[0-9a-f]{32}$/)
    expect(COSY_SECRET_B64).toBe('d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==')
    // 复算校验
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    const expected = createHash('md5').update(`cosy&${COSY_SECRET_B64}&${date}`).digest('hex')
    expect(sig).toBe(expected)
  })

  it('rfc1123 date parses back', () => {
    const date = currentRfc1123Date()
    const parsed = parseRfc1123Date(date)
    expect(Math.abs(parsed.getTime() - Date.now())).toBeLessThan(5_000)
  })
})

describe('fingerprint derivation', () => {
  it('is stable for the same seed and credential', () => {
    const a = deriveFingerprint('uid-1', 'cred', undefined)
    const b = deriveFingerprint('uid-1', 'cred', undefined)
    expect(a).toEqual(b)
  })

  it('changes when uid or salt changes', () => {
    const base = deriveFingerprint('uid-1', 'cred', undefined)
    const otherUid = deriveFingerprint('uid-2', 'cred', undefined)
    const salted = deriveFingerprint('uid-1', 'cred', 'salt-9')
    expect(otherUid.machineId).not.toBe(base.machineId)
    expect(salted.machineId).not.toBe(base.machineId)
  })

  it('uses the credential when uid is empty', () => {
    const a = deriveFingerprint('', 'pt-secret-123', undefined)
    const b = deriveFingerprint('', 'pt-secret-123', undefined)
    expect(a).toEqual(b)
  })

  it('produces spec-length tokens', () => {
    const fp = deriveFingerprint('uid', 'cred', undefined)
    expect(fp.machineId).toMatch(/^[0-9a-f]{32}$/)
    expect(fp.machineType.length).toBe(18)
    expect(fp.machineToken.length).toBe(43)
  })
})

describe('session building', () => {
  it('builds a cosyKey and info from a jobToken response', () => {
    const identity = identityFromJobToken({
      name: 'tester',
      id: 'aid-1',
      userType: 'personal_standard',
      securityOauthToken: 'sot',
      refreshToken: 'drt-1',
    })
    const fp = deriveFingerprint('aid-1', 'cred', undefined)
    const session = newCosySession(identity, fp.machineId, fp.machineToken, fp.machineType)
    expect(session.cosyKey.length).toBeGreaterThan(100) // RSA-1024 → ~172 base64 chars
    expect(session.info.length).toBeGreaterThan(50)
    expect(session.tempKey.length).toBe(16)
    expect(session.identity.uid).toBe('aid-1')
  })

  it('rsa encryption roundtrips with a fresh keypair', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const { publicEncrypt } = require('node:crypto') as typeof import('node:crypto')
    const tempKey = Buffer.from('0123456789abcdef')
    const enc = publicEncrypt({ key: publicPem, padding: 1 }, tempKey)
    const dec = rsaDecrypt(enc, privateKey.export({ type: 'pkcs1', format: 'pem' }).toString())
    expect(Buffer.from(dec).toString('utf8')).toBe('0123456789abcdef')
  })

  it('payload b64 has sorted keys', () => {
    const payload = buildPayloadB64('info-value')
    const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, string>
    expect(Object.keys(parsed)).toEqual(['cosyVersion', 'ideVersion', 'info', 'requestId', 'version'])
  })

  it('signRequest and composeBearer produce the documented shapes', () => {
    const sig = signRequest('payload', 'cosyKey', '1739000000', 'body', '/api/v2/model/list')
    expect(sig).toMatch(/^[0-9a-f]{32}$/)
    expect(composeBearer('payload', sig)).toBe('Bearer COSY.payload.' + sig)
    expect(pathSigFrom('https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1')).toBe('/api/v2/model/list')
    expect(pathSigFrom('https://gateway.qoder.com.cn/algo/api/v3/user/jobToken?Encode=1')).toBe('/api/v3/user/jobToken')
  })
})