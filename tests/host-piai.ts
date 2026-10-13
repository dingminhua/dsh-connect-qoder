/**
 * 宿主的 pi-ai 失败分类器：**直接执行 app.asar 里提取出来的原文**。
 *
 * 为什么不在这里再手抄一遍正则：手抄的副本与宿主漂移时，测试会一起漂过去，
 * 于是「测试通过」只证明副本自洽 —— 本仓库正是这么漏掉「403 被判 AUTH」整整
 * 一个版本的（对抗审核 §6 也指出：自称「逐字照抄」的副本无法被独立核实）。
 *
 * 现在断言的是**宿主真实代码的行为**：`tests/fixtures/host-piai-classifier.json`
 * 是从 `app.asar` 逐字提取的源码文本（提取脚本见该文件的 `source` 字段），
 * 本模块 `new Function` 执行它。宿主升级后只要那两个函数的文本变了，重新提取
 * 即可；若宿主改了判据顺序（也就是本缺陷的成因），这些用例会立刻变红。
 *
 * 出处：DeepSeek Harness.app/Contents/Resources/app.asar，`classifyPiAiError`
 * 全 asar 仅一处定义（已核对）。宿主落在最后一个分支上的 code 是 `PI_AI_ERROR`。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

interface HostFixture {
  source: { app: string, dshVersion: string, asarSha256: string, extractedAt: string }
  isQuotaExceededError: string
  classifyPiAiError: string
}

const fixturePath = fileURLToPath(new URL('./fixtures/host-piai-classifier.json', import.meta.url))

/** 宿主分类器的返回码。 */
export type HostCode =
  | 'AUTH'
  | 'QUOTA'
  | 'ACCOUNT_QUOTA'
  | 'RATE_LIMIT'
  | 'INVALID_REQUEST'
  | 'SERVER'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'PI_AI_ERROR'

export const hostFixture: HostFixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as HostFixture

/**
 * 复核 golden 是否仍与**这台机器装着的宿主**一致。
 *
 * 对抗审核 §6 的最后一条：这些用例依赖 app.asar 的文本，而 app.asar 不在仓库里，
 * 谁都无法从仓库内部核实「副本 = 宿主」。所以自检直接去读装机的 asar，把两个函数
 * 的原文逐字比一遍。
 *
 * 返回结果而不是断言：宿主**没装**（CI / 非 macOS）与宿主**变了**是两件事，
 * 前者要跳过、后者才是问题。用 `undefined` 表示「无法核实（没装/读不到）」。
 */
export function verifyFixtureAgainstInstalledHost(): { ok: boolean, reason?: string } | undefined {
  let data: Buffer
  try {
    data = readFileSync(hostAsarPath)
  } catch {
    return undefined // 宿主不在这台机器上：无从核实，跳过而不是失败。
  }
  const raw = data.toString('latin1')
  // 两条判据都很朴素，但都是踩过坑的：
  //  1) **用原始签名定位**，不要在归一化后的文本里找 —— 源码里 `{` 后面是换行，
  //     把空白压成空格之后那串前缀在宿主里并不逐字存在。
  //  2) **取与 fixture 等长的窗口比较**，不能用 `includes(snippet)`：宿主里紧跟
  //     着别的代码，`includes` 会因为尾随文本永远比不中（第一版就是这么误报的）。
  // 函数的**正文里也含 `\s`** 这类转义（`\\b` / `\\s_-`），所以比较必须在
  // 「空白归一」之后做，否则换行/缩进差异会盖住真实差异。
  const collapse = (s: string): string => s.replace(/\s+/gu, ' ').trim()
  for (const [name, signature, snippet] of [
    ['isQuotaExceededError', 'function isQuotaExceededError(detail) {', hostFixture.isQuotaExceededError],
    ['classifyPiAiError', 'function classifyPiAiError(message) {', hostFixture.classifyPiAiError],
  ] as const) {
    const at = raw.indexOf(signature)
    if (at < 0) return { ok: false, reason: `装机宿主里找不到 ${name}（已改名或结构变了？）` }
    const want = collapse(snippet)
    const got = collapse(raw.slice(at, at + snippet.length + 200)).slice(0, want.length)
    if (got !== want) {
      let k = 0
      while (k < want.length && want[k] === got[k]) k++
      return {
        ok: false,
        reason: `${name} 第 ${k} 个字符起与装机宿主不一致：期望 ${JSON.stringify(want.slice(k, k + 48))}，实为 ${JSON.stringify(got.slice(k, k + 48))}`,
      }
    }
  }
  return { ok: true }
}

/**
 * 宿主 `classifyPiAiError` 的**可执行**版本。
 *
 * `QUOTA_EXCEEDED_CODE` 在宿主里有两个值（`QUOTA` 与独立的 `ACCOUNT_QUOTA`，
 * 前者是第三方 provider/API key 这一档，也就是本插件所在的档；两者在宿主渲染端
 * 都映射到同一句 `message.failure.quota`）。这里绑成 `QUOTA`。
 */
export const classifyPiAiError: (message: string) => HostCode = (() => {
  const quotaCode = 'QUOTA'
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'QUOTA_EXCEEDED_CODE',
    `${hostFixture.isQuotaExceededError}\n${hostFixture.classifyPiAiError}\nreturn classifyPiAiError`,
  ) as (code: string) => (message: string) => HostCode
  return factory(quotaCode)
})()

/**
 * 宿主渲染层：这几种 code 会被**中立文案覆盖**提供方自己的消息
 * （`message.failure.auth` = 「API 密钥无效」、`message.failure.quota` = 「当前
 * 请求的额度已用尽」），其余 code 原样显示 message。判据取自 app.asar 渲染端
 * `code === "QUOTA" || code === "ACCOUNT_QUOTA"` … `code === "AUTH"` 那一段。
 */
export function hostRendersOwnCopy(code: HostCode): boolean {
  return code === 'AUTH' || code === 'QUOTA' || code === 'ACCOUNT_QUOTA'
}

/**
 * 这台机器上宿主 asar 的所在（用于「golden 是否与装机宿主一致」的自检）。
 *
 * 只读一次、且**允许缺失**：CI 或非 macOS 上没有这个路径，自检退化为跳过，
 * 绝不能让测试因为「宿主没装」而红。
 */
export const hostAsarPath = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
