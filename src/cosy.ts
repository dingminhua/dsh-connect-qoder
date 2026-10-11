/**
 * Qoder cosy 协议：加密与签名原语（TypeScript 移植）。
 *
 * 协议来源（社区逆向 + 官方产物核对）：
 * - fengyinxia/qoder2api（MIT）：qoder_auth.py —— PAT→jobToken 交换、cosy
 *   签名、自定义 base64、RSA/AES 会话构建，实测可用（CN 网关）。
 * - x_Zhengyuuuui/qoder2api（Go 版）：internal/cosy/* —— 同一协议的 Go
 *   实现，含设备指纹派生（fingerprint.go），并有 CN / Global 双区域端点。
 * - @qoder-ai/qoder-agent-sdk 官方 .d.ts：模型字段、用量字段的官方命名。
 *
 * 本模块只做「无状态纯函数 + 加密原语」，不触网；网络与流程在 upstream.ts。
 *
 * @module dsh-connect-qoder/cosy
 */

import { createHash, createCipheriv, createDecipheriv, privateDecrypt, publicEncrypt } from 'node:crypto'
import { randomBytes, randomUUID } from 'node:crypto'

/** cosy 自定义 base64 字母表（与 qoder2api 逐字节一致）。 */
export const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export const CUSTOM_PAD = '$'

const s2c = new Map<string, string>()
const c2s = new Map<string, string>()
for (let i = 0; i < 64; i += 1) {
  s2c.set(STD_ALPHABET[i]!, CUSTOM_ALPHABET[i]!)
  c2s.set(CUSTOM_ALPHABET[i]!, STD_ALPHABET[i]!)
}
s2c.set('=', CUSTOM_PAD)
c2s.set(CUSTOM_PAD, '=')

/**
 * Qoder 自定义 base64 编码：先标准 base64，再按 `n/3` 三块重排，
 * 最后把每个字符映射到自定义字母表（含自定义 pad `$`）。
 */
export function cosyEncode(plaintext: Uint8Array): string {
  const std = Buffer.from(plaintext).toString('base64')
  const n = std.length
  const a = Math.floor(n / 3)
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a)
  let out = ''
  for (const ch of rearranged) {
    const mapped = s2c.get(ch)
    if (mapped === undefined) throw new Error(`cosy encode: char out of alphabet: ${ch}`)
    out += mapped
  }
  return out
}

/** 自定义 base64 解码（cosyEncode 的逆）。 */
export function cosyDecode(encoded: string): Uint8Array {
  let mapped = ''
  for (const ch of encoded) {
    const std = c2s.get(ch)
    if (std === undefined) throw new Error(`cosy decode: char out of custom alphabet: ${ch}`)
    mapped += std
  }
  const n = mapped.length
  const a = Math.floor(n / 3)
  const std = mapped.slice(n - a) + mapped.slice(a, n - a) + mapped.slice(0, a)
  return new Uint8Array(Buffer.from(std, 'base64'))
}

/** RFC1123 格式的当前 UTC 时间，用于旧式签名头。 */
export function currentRfc1123Date(): string {
  return new Date().toUTCString()
}

/** RFC1123 解析（供测试与恢复时间换算）。 */
export function parseRfc1123Date(value: string): Date {
  return new Date(value)
}

export function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

export function sha512Base64Url(input: string): string {
  return createHash('sha512').update(input, 'utf8').digest('base64url')
}

/** cosy 签名常量。 */
export const COSY_APPCODE = 'cosy'
export const COSY_SECRET_B64 = 'd2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==' // base64("war, war never changes")

/** 旧式请求签名：md5("cosy&<secret>&<rfc1123date>")。 */
export function signLegacy(date: string): string {
  return md5Hex(`${COSY_APPCODE}&${COSY_SECRET_B64}&${date}`)
}

/**
 * Qoder 网关 RSA 公钥（客户端用它加密会话临时密钥）。
 * 与 qoder2api / Go 克隆一致。
 */
export const SERVER_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

/** cosy 版本号（客户端身份的一部分，与 qoder2api 实测一致）。 */
export const COSY_VERSION = '0.1.43'

/** AES-CBC + PKCS7 填充。 */
function aesCbcEncrypt(plain: Uint8Array, key: Uint8Array): Uint8Array {
  const iv = key
  const blockSize = 16
  const padLen = blockSize - (plain.length % blockSize)
  const padded = new Uint8Array(plain.length + padLen)
  padded.set(plain)
  padded.fill(padLen, plain.length)
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const out = Buffer.concat([cipher.update(padded), cipher.final()])
  return new Uint8Array(out)
}

/** AES-CBC 解密（PKCS7）。 */
export function aesCbcDecrypt(encrypted: Uint8Array, key: Uint8Array): Uint8Array {
  const decipher = createDecipheriv('aes-128-cbc', key, key)
  const out = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return new Uint8Array(out)
}

/** RSA PKCS1v1.5 加密（用网关公钥加密会话临时密钥）。 */
export function rsaEncrypt(plain: Uint8Array): Uint8Array {
  const { publicKey } = requirePublicKey()
  const out = publicEncrypt({ key: publicKey, padding: 1 }, Buffer.from(plain))
  return new Uint8Array(out)
}

/** RSA PKCS1v1.5 解密（测试用；插件运行时不需要私钥）。 */
export function rsaDecrypt(encrypted: Uint8Array, privateKeyPem: string): Uint8Array {
  const out = privateDecrypt({ key: privateKeyPem, padding: 1 }, Buffer.from(encrypted))
  return new Uint8Array(out)
}

let cachedPublicKey: { publicKey: string } | undefined

function requirePublicKey(): { publicKey: string } {
  if (cachedPublicKey === undefined) {
    cachedPublicKey = { publicKey: SERVER_PUBKEY_PEM }
  }
  return cachedPublicKey
}

/**
 * 会话身份（jobToken 交换响应中的用户字段，全部蛇形命名）。
 */
export interface CosyAuthIdentity {
  name: string
  aid: string
  uid: string
  yx_uid: string
  organization_id: string
  organization_name: string
  user_type: string
  security_oauth_token: string
  refresh_token: string
}

/**
 * 一次 cosy 会话上下文：Bearer 请求的全部签名要素。
 */
export interface CosySessionContext {
  /** 16 字节临时密钥（hex 串前 16 字符）。 */
  tempKey: Uint8Array
  /** base64(RSA(tempKey))，放进请求头 cosy-key。 */
  cosyKey: string
  /** base64(AES(tempKey, identityPayload))，每次 Bearer 的 info 段。 */
  info: string
  identity: CosyAuthIdentity
  machineId: string
  machineToken: string
  machineType: string
}

/**
 * 从 jobToken 响应构建会话身份。响应字段：{name, id, expireTime,
 * securityOauthToken, refreshToken, userType, ...}。
 */
export function identityFromJobToken(jt: Record<string, unknown>): CosyAuthIdentity {
  return {
    name: String(jt.name ?? ''),
    aid: String(jt.id ?? ''),
    uid: String(jt.id ?? ''),
    yx_uid: '',
    organization_id: '',
    organization_name: '',
    user_type: String(jt.userType ?? 'personal_standard'),
    security_oauth_token: String(jt.securityOauthToken ?? ''),
    refresh_token: String(jt.refreshToken ?? ''),
  }
}

/**
 * 新会话：生成临时密钥 → RSA 加密得 cosyKey → AES 加密身份载荷得 info。
 * `tempKey` 用 16 字节随机数的 hex 前 16 字符（与 qoder2api 一致）。
 */
export function newCosySession(
  identity: CosyAuthIdentity,
  machineId: string,
  machineToken: string,
  machineType: string,
): CosySessionContext {
  const tempKey = new Uint8Array(Buffer.from(randomBytes(16).toString('hex').slice(0, 16), 'utf8'))
  const cosyKeyBytes = rsaEncrypt(tempKey)
  const cosyKey = Buffer.from(cosyKeyBytes).toString('base64')
  const payload = JSON.stringify(identityPayload(identity))
  const info = Buffer.from(aesCbcEncrypt(new Uint8Array(Buffer.from(payload, 'utf8')), tempKey)).toString('base64')
  return { tempKey, cosyKey, info, identity, machineId, machineToken, machineType }
}

function identityPayload(identity: CosyAuthIdentity): Record<string, string> {
  return {
    name: identity.name,
    aid: identity.aid,
    uid: identity.uid,
    yx_uid: identity.yx_uid,
    organization_id: identity.organization_id,
    organization_name: identity.organization_name,
    user_type: identity.user_type,
    security_oauth_token: identity.security_oauth_token,
    refresh_token: identity.refresh_token,
  }
}

/**
 * Bearer 载荷：{cosyVersion, ideVersion, info, requestId, version} 的
 * 标准 base64（键序按字典序，与 qoder2api 一致）。
 */
export function buildPayloadB64(info: string): string {
  const payload = {
    cosyVersion: COSY_VERSION,
    ideVersion: '',
    info,
    requestId: randomUUID(),
    version: 'v1',
  }
  const sorted = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : 1)))
  return Buffer.from(JSON.stringify(sorted)).toString('base64')
}

/**
 * 请求签名：md5(payloadB64 \n cosyKey \n date \n body \n pathWithoutAlgo)。
 */
export function signRequest(payloadB64: string, cosyKey: string, cosyDate: string, body: string, pathSig: string): string {
  return md5Hex(`${payloadB64}\n${cosyKey}\n${cosyDate}\n${body}\n${pathSig}`)
}

/** 组装 Authorization 头：`Bearer COSY.<payloadB64>.<sig>`。 */
export function composeBearer(payloadB64: string, sig: string): string {
  return `Bearer COSY.${payloadB64}.${sig}`
}

/** 从完整 URL 派生签名路径：去掉 `/algo` 前缀（不含查询串）。 */
export function pathSigFrom(fullUrl: string): string {
  let path: string
  try {
    path = new URL(fullUrl).pathname
  } catch {
    path = fullUrl
  }
  return path.startsWith('/algo') ? path.slice('/algo'.length) : path
}

/**
 * 设备指纹派生（stable machine identity）。
 *
 * 与 Go 克隆 fingerprint.go 同构：以账号 UID（未知时用凭证本身）为种子，
 * 单向哈希派生出长期稳定的 cosy-machineid / cosy-machinetype /
 * cosy-machinetoken。`installSalt` 可选混入，换盐即换设备指纹。
 */
export interface CosyFingerprint {
  machineId: string
  machineType: string
  machineToken: string
}

function saltedSeed(seed: string, installSalt: string | undefined): string {
  return installSalt ? `${seed}|salt:${installSalt}` : seed
}

function deriveId(seed: string, salt: string, installSalt: string | undefined): string {
  return md5Hex(`${salt}:${saltedSeed(seed, installSalt)}`)
}

/**
 * 派生设备指纹。seed 优先取账号 UID；未知时回退 `cred:<credential>`，
 * 保证同一凭证跨次调用派生结果一致。
 */
export function deriveFingerprint(uid: string, credential: string, installSalt?: string): CosyFingerprint {
  const seed = uid !== '' ? uid : `cred:${credential}`
  return {
    machineId: deriveId(seed, 'machine', installSalt),
    machineType: deriveId(seed, 'machinetype', installSalt).slice(0, 18),
    machineToken: sha512Base64Url(`machinetoken:${saltedSeed(seed, installSalt)}`).slice(0, 43),
  }
}
