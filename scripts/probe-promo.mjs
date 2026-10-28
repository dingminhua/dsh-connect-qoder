// 活动优惠徽标的端到端实探：真凭据 → 真上游 → 插件自己的解析与判定。
//
// 只读（一次 GET `/algo/api/v2/model/list?Encode=1`），不打印任何令牌。
//
// 为什么要绕开 `QoderUpstreamClient.fetchModels`：那条路要先换 jobToken，而本机
// 存的 PAT 在 jobToken 交换上会被上游回「personal token is invalid」（见
// docs/PROMO_BADGE.md §5）。这里用 cosy 签名直接读目录——与客户端同一条路径，
// 拿到的仍是同一份文档，所以后面的解析/判定跑的都是生产代码。
//
//   node --experimental-transform-types scripts/probe-promo.mjs [账号键名] [--shifts]
//
// `--shifts` 把时钟推到 +6/+12/+24/+36 小时再判定一次，用来证明「徽标随窗口
// 出现/消失，而不是被冻结在解析结果里」。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildPayloadB64, composeBearer, deriveFingerprint,
  newCosySession, pathSigFrom, signRequest,
} from '../src/cosy.ts'
import { parseUpstreamModel } from '../src/catalog.ts'
import { promoLiveAt } from '../src/promo.ts'
import { promoBadgeLabel } from '../src/client/promo-badge.ts'
import { QODER_REGIONS } from '../src/upstream.ts'

const DEFAULT_ACCOUNT = 'QODERCN_ACCOUNT_6C2D6327'

/** 从 DSH 凭证库里取一条账号记录（值是一段 JSON 字符串）。 */
function accountRef(name) {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const at = text.indexOf(`${name}: '`)
  if (at < 0) return undefined
  const start = text.indexOf("'", at) + 1
  const end = text.indexOf("'\n", start)
  return JSON.parse(text.slice(start, end))
}

const args = process.argv.slice(2)
const shifts = args.includes('--shifts')
const accountKey = args.find(arg => !arg.startsWith('--')) ?? DEFAULT_ACCOUNT
const account = accountRef(accountKey)
if (account === undefined) {
  console.error(`凭证库里没有 ${accountKey}（可用键名见 ~/.dsh/.credentials.yaml 里的 QODER*_ACCOUNT_*）`)
  process.exit(1)
}

const region = accountKey.startsWith('QODERCN') ? 'cn' : 'global'
const gateway = QODER_REGIONS[region].gateway
const token = String(account['security_oauth_token'] ?? account['access_token'] ?? '')
const uid = String(account['uid'] ?? '')
if (token === '' || uid === '') {
  console.error('账号记录里没有可用的令牌/uid')
  process.exit(1)
}

const fingerprint = deriveFingerprint(uid, token)
const session = newCosySession(
  {
    name: String(account['nickname'] ?? ''),
    aid: uid,
    uid,
    yx_uid: '',
    organization_id: '',
    organization_name: '',
    user_type: 'personal_standard',
    security_oauth_token: token,
    refresh_token: String(account['refresh_token'] ?? ''),
  },
  String(account['machine_id'] ?? fingerprint.machineId),
  fingerprint.machineToken,
  fingerprint.machineType,
)
console.log(`account=${accountKey} region=${region} uid=${uid.slice(0, 6)}…`)

const url = `${gateway}${QODER_REGIONS[region].modelsPath}`
const date = String(Math.floor(Date.now() / 1000))
const payloadB64 = buildPayloadB64(session.info)
const sig = signRequest(payloadB64, session.cosyKey, date, '', pathSigFrom(url))
const response = await fetch(url, {
  headers: {
    'cosy-data-policy': 'agree',
    'content-type': 'application/json',
    // 与 src/upstream.ts 的 COSY_CLIENT_TYPE / COSY_VERSION_HEADER 同步：
    // 旧值 5 / 0.1.43 会让上游只下发旧目录（拿不到 Sonus/Cantus/Fast），
    // 探针就会看到一份比插件真实运行更旧的名单。见 issue #21。
    'cosy-clienttype': '10',
    'login-version': 'v2',
    'user-agent': 'Go-http-client/2.0',
    'cosy-scene': 'assistant',
    'cosy-business-product': 'ide',
    'cosy-business-type': 'agent',
    'cosy-machinetype': session.machineType,
    'cosy-date': date,
    'cosy-user': uid,
    'cosy-key': session.cosyKey,
    accept: 'application/json',
    authorization: composeBearer(payloadB64, sig),
    'cosy-version': '1.1.69',
    'cosy-machineid': session.machineId,
    'cosy-machinetoken': session.machineToken,
  },
})
const text = await response.text()
console.log(`GET ${QODER_REGIONS[region].modelsPath} → HTTP ${response.status} / ${text.length} bytes`)
if (response.status !== 200) {
  console.log(text.slice(0, 300))
  process.exit(0)
}

const document = JSON.parse(text)
const rows = Array.isArray(document['chat']) ? document['chat'] : []
console.log(`chat rows: ${rows.length}`)

// 生产路径：上游行 → 目录条目（解析上游 snake_case，规则随之落成 camelCase）。
// `{ ...row, raw: row }` 就是 `fetchModels` 对每行做的事：字段摊到顶层，原始
// 文档挂在 `raw` 上，`parseUpstreamModel` 从那里读 `promotion`。
const models = rows.map(row => parseUpstreamModel({ ...row, raw: row }))
const withRule = models.filter(model => model.promotion !== undefined)
console.log(`parsed models: ${models.length}   carrying a rule: ${withRule.length}`)
for (const model of withRule) {
  const promo = model.promotion
  const window = promo.window === undefined
    ? '(no window)'
    : `${promo.window.start}–${promo.window.end} ${promo.timeZone ?? ''}`.trim()
  console.log(`- ${model.key.padEnd(26)} active=${String(promo.active).padEnd(5)} ${window}  badge[zh]=${JSON.stringify(promo.badge.zh ?? '')}`)
}

/** 同一份解析结果在不同时钟下的判定结果（证明「判定在渲染时刻」）。 */
function report(now) {
  const live = withRule.filter(model => promoLiveAt(model.promotion, now))
  if (live.length === 0) return '(none)'
  return live.map(model => `${model.key}「${promoBadgeLabel(model.promotion, 'zh-CN') ?? '?'}」`).join(', ')
}

const base = Date.now()
console.log(`\n== badges now (${new Date(base).toISOString()}) ==`)
console.log(report(new Date(base)))
if (shifts) {
  for (const hours of [6, 12, 24, 36]) {
    const now = new Date(base + hours * 3_600_000)
    console.log(`+${hours}h (${now.toISOString()}): ${report(now)}`)
  }
}
