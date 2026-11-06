/**
 * 隐私护栏：仓库里不该出现的真实标识符。
 *
 * 为什么需要一条**测试**而不是只写进 `docs/PRIVACY.md`：1.18.0 把维护者的真实
 * 账号名放进了 README 首屏截图，一整个版本都在 npm 上才被发现。文档靠自觉，
 * 测试靠 CI —— 这类回退只有自动化挡得住。
 *
 * 挡什么、不挡什么：
 *   · 挡：真实邮箱、上游昵称、凭据指纹（`pat-<16 hex>`）、本机绝对路径、
 *     凭据库键名、凭据本体（`pt-…`、`ghp_…`、私钥块）。
 *   · 不挡：`dingminhua` 与 `@dmh2002/` —— 它们是**公开身份**（GitHub 仓库地址、
 *     npm 作用域、MIT 版权人），必须留在仓库里。脱敏规则针对的是账号数据。
 *
 * 它**读不了图片内容**。`docs/assets/` 下的截图只能靠人打开看，本测试只能保证
 * 文件名、清单与文本层没有漏项（见 `docs/PRIVACY.md` §2）。
 *
 * ## 一条已知盲点：财务数值（**故意不自动判**）
 *
 * 「积分余额 + 到期时刻并列」是本项目出过一次事的主体，但它**没有**对应规则，
 * 试过一版又撤掉了：判据只能用「余额…数字…到期」这类并列，而测试夹具里
 * `{ credits: 100, nearestExpiryMs: … }` 到处都是（`tests/account-pool.spec.ts`
 * 一屏就是十几条），规则一开就满屏误报，逼着人加 `allow` 白名单——最后变成
 * 「谁改测试谁顺手放宽」，比没有更糟。
 *
 * 所以这一类**只能靠人**：新增或替换 `docs/assets/` 下的图、以及在文档里引用
 * 截图内容时，必须自己看一眼数字是不是假的。`docs/PRIVACY.md` §2 与
 * `RELEASING.md` 第 0 步都写了这一条。
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/**
 * 被跟踪的 + 未跟踪但没被 ignore 的文件。
 *
 * **必须带上 `--others`**：只用 `git ls-files` 时，刚 `git add` 之前的新文件不在
 * 名单里 —— 而「新写一份文档 / 新加一张图」恰恰是最容易夹带私货的时刻。
 * 这条被漏掉过一次：护栏写完后拿 `docs/PRIVACY.md`（当时还是未跟踪文件）做变异
 * 测试，注入真实邮箱、昵称与指纹三类泄露，测试**照样全绿**。
 */
function scannedFiles(): string[] {
  const out = execFileSync(
    'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8' },
  )
  const tracked = out.split('\0').filter(path => path !== '')
  // `lib/` 是 `.gitignore` 掉的构建产物，但 **`prepack` 会重建它、它随 npm 包发布**。
  // 只看 git 列表等于漏掉「真正发给用户的那一份」：源码注释会原样进 `lib/`，
  // 一条写在注释里的真实数值，在源码里改掉之后仍会留在旧构建里发出去。
  return [...tracked, ...libFiles()]
}

/**
 * `lib/` 下的产物文件。
 *
 * 目录不存在时返回空数组（干净 clone 上还没构建）——那种情况下
 * 「扫到足够多的文件」那条守卫仍由 git 列表单独满足。
 */
function libFiles(): string[] {
  const dir = join(ROOT, 'lib')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.js') || name.endsWith('.d.ts'))
    .map(name => `lib/${name}`)
}

const TEXT_EXT = /\.(md|ts|tsx|jsx|js|mjs|cjs|json|jsonc|yml|yaml|txt|css|html|svg|sh|bat|toml|env)$/

/**
 * 测试与示例里的**占位** token。它们长得像凭据，但显然是造的：
 * 同一两个字符重复、`abcdefgh` / `deadbeef` 这类可读的十六进制、`xxxx` 打头。
 * 真实 PAT 是大小写字母 + 数字的随机串，不会落在这几条上。
 */
const PLACEHOLDER_WORDS = [
  '0123456789abcdef', 'fedcba9876543210',
  'deadbeef', 'cafebabe', 'deadc0de', 'feedface',
  'abcdefgh', 'abcdefghij0123456789',
]

function isPlaceholderToken(token: string): boolean {
  const body = token.replace(/^[a-z]+-/i, '').replace(/^pt-/, '')
  if (body.length === 0) return true
  if (new Set(body).size <= 2) return true // aaaaaaaa / 11111111aaaaaaaa / bbbbbbbb
  if (/^(x{4,}|X{4,}|<)/.test(body)) return true // xxxx / <your-token>
  const lower = body.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (PLACEHOLDER_WORDS.some(word => lower.startsWith(word))) return true
  if (/^[0-9]+$/.test(body)) return true // 纯数字
  return false
}

interface Rule {
  /** 命中即视为泄露（可返回候选串，由 `allow` 二次过滤）。 */
  pattern: RegExp
  why: string
  allow?: (match: string) => boolean
}

/**
 * 黑名单。每一条都带一个**为什么**：没有理由的黑名单条目会在下一次「这条为什么
 * 在这」的质疑里被顺手删掉，然后问题复发。
 */
const RULES: Rule[] = [
  {
    // 字面量在源码里被拆成两段：否则这条规则自己就是一处泄露，而
    // `docs/PRIVACY.md` 里也不允许把它写全（护栏一度把自己的文档判红）。
    pattern: new RegExp(`${'shang'}${'xinyu'}\\d*`, 'i'),
    why: '维护者的真实邮箱前缀（出现在 RELEASE_EXPERIENCE 与 CHANGELOG 里过）',
  },
  {
    // 同样拆开写：这条规则不该自己成为一处泄露样例。
    // 4 位起即可命中：`docs/PRIVACY.md` 自己举的示例形态就是 nick + 4 位，
    // 而旧规则要求 7 位以上 —— 护栏认不出自己文档里写的那个形态。
    pattern: new RegExp(`${'ni'}ck\\d{4,}`),
    why: '上游真实账号昵称（形如 nick + 数字）',
    allow: match => /^nick(0{4,}|1234|12345|123456)$/.test(match),
  },
  {
    // 不限域名：早期只列了 5 个常见域，`@outlook.com` / `@foxmail.com` 一律漏检，
    // 而「换了个邮箱服务商」是最不需要动脑的绕过方式。示例一律用 example.com。
    pattern: /[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)\b)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
    why: '真实邮箱地址；示例一律用 example.com',
    allow: match => /@(example|test|localhost)\b/i.test(match)
      || /^[a-z0-9._%+-]*x{3,}@/i.test(match)   // xxxx@… 这类明显占位
      || /\.(invalid|test|example|localhost)$/i.test(match.split('@')[1] ?? ''),
  },
  {
    // 位数放宽到 12+：真实的指纹取前 16 位，但 32 位全写、截断成别的长度
    // 都出现过；只认恰好 16 位会让这些写法整条漏掉。
    pattern: /\bpat-[0-9a-f]{12,}\b/i,
    why: 'PAT 的 sha256 指纹 —— 能跨仓库确认「这把钥匙属于同一个人」',
    allow: (match) => {
      const body = match.slice(4).toLowerCase()
      if (new Set(body).size <= 2) return true // aaaaaaaaaaaaaaaa / 0000000000000000
      return PLACEHOLDER_WORDS.some(word => body.startsWith(word))
    },
  },
  {
    // 大小写都要认：键名是按指纹派生的，出现时大小写并不固定，
    // 只写 `[0-9A-F]` 会让小写形态（`…_6c2d6327`）整条漏掉。
    pattern: /\bQODER[A-Za-z]*_ACCOUNT_[0-9A-Fa-f]{6,}\b/,
    why: '真实凭据库键名；示例用 QODERCN_ACCOUNT_EXAMPLE',
    allow: match => /ACCOUNT_(EXAMPLE|DEMO|SAMPLE|[X]+)(\b|$)/i.test(match),
  },
  {
    // 结尾斜杠可选：`/Users/someone` 这种不带尾斜杠的写法同样泄露用户名，
    // 旧规则要求必须有 `/` 才能命中，于是它整条漏检。Linux 形态一并覆盖。
    pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+/,
    why: '本机绝对路径泄露操作系统用户名；用 ~ 或 os.homedir()',
    allow: match => /\/(Users|home)\/(<|\$|~|username|user|someone|your|xxx)/i.test(match),
  },
  {
    pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/,
    why: '同上（Windows 形态）',
  },
  {
    pattern: /\bpt-[A-Za-z0-9]{16,}\b/g,
    why: 'PAT 本体',
    allow: isPlaceholderToken,
  },
  {
    pattern: /\b(ghp_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,})\b/,
    why: 'GitHub / npm 令牌本体',
    allow: isPlaceholderToken,
  },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    why: '私钥',
  },
  {
    // 中国大陆手机号：1 开头、第二位 3-9、共 11 位。前后不能再接数字，
    // 否则 1999 年这类长数字串会误报。
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/,
    why: '手机号',
    allow: match => /^1(3{9}|5{9}|0{10})$/.test(match), // 全同数字显然是占位
  },
  {
    // 设备标识：国内版不用，国际版的风控三件套靠它。仓库里只该出现字段名，
    // 不该出现取值。`machineType` 是 16 位十六进制、`machineToken` 是长 base64。
    pattern: /"?(?:machineId|machineToken|machineType)"?\s*[:=]\s*"([A-Za-z0-9+/=_-]{8,})"/i,
    why: '设备标识的取值（字段名可以出现，取值不行）',
    allow: match => /[:=]\s*"<|EXAMPLE|PLACEHOLDER|xxx+/i.test(match),
  },
]

describe('仓库里没有真实账号数据', () => {
  const files = scannedFiles()

  it('扫到了足够多的文件（护栏本身没瞎）', () => {
    // 这条防的是「git 命令失败 → 列表为空 → 所有断言真空通过」。
    expect(files.length).toBeGreaterThan(100)
  })

  for (const rule of RULES) {
    it(`没有${rule.why}`, () => {
      const offenders: string[] = []
      for (const path of files) {
        if (!TEXT_EXT.test(path)) continue
        if (path.includes('node_modules/')) continue
        if (!existsSync(join(ROOT, path))) continue

        const lines = readFileSync(join(ROOT, path), 'utf8').split('\n')
        for (const [index, line] of lines.entries()) {
          // **必须转发原正则的 `i` 标志**：只拼 `g` 会把大小写不敏感的规则
          // 静默收窄成敏感（大写写法的邮箱域、大写十六进制指纹会从此漏检）。
          // 这个 bug 存在过一版，是独立审查用临时脚本测出来的。
          const flags = rule.pattern.flags.includes('i') ? 'gi' : 'g'
          const matches = [...line.matchAll(new RegExp(rule.pattern.source, flags))]
          for (const match of matches) {
            const text = match[0]
            if (rule.allow?.(text) === true) continue
            offenders.push(`${path}:${index + 1}: ${line.trim()}`)
            break
          }
        }
      }
      expect(offenders, `命中 ${rule.why}\n${offenders.join('\n')}`).toEqual([])
    })
  }
})

/**
 * 规则本身也要被 CI 盯住。
 *
 * 这一组防的是「文档被悄悄削弱」：一份写着「不得跳过」的清单，只要有人把某一项删掉，
 * 就再也不会有人执行它——而删文档不会让任何测试变红。所以要断言**关键条款还在**。
 *
 * 只断言「这些词存在」，不校验措辞：文档可以改写，但那几条硬约束不能消失。
 */
describe('规则文档仍然在位且没被削弱', () => {
  const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

  it('AGENTS.md 有隐私硬约束一节，并列全六类禁止内容', () => {
    const text = read('AGENTS.md')
    expect(text).toMatch(/## 一、隐私/)
    // 六类：邮箱/昵称、显示名、财务状态、凭据指纹、本机路径、凭据库键名
    for (const word of ['邮箱', '显示名', '财务状态', '凭据指纹', '绝对路径', '凭据库键名']) {
      expect(text, `AGENTS.md 少了「${word}」这一类`).toContain(word)
    }
    // 截图那条最容易退化成「遮一下就行」
    expect(text).toContain('模糊')
    expect(text).toContain('不算脱敏')
  })

  it('AGENTS.md 指出护栏测不了财务数值（防止把「测过了」当成「查过了」）', () => {
    const text = read('AGENTS.md')
    expect(text).toMatch(/只能靠人/)
  })

  it('RELEASING.md 的第 0 步仍在，且清单含财务数字与独立复核', () => {
    const text = read('RELEASING.md')
    expect(text).toMatch(/### 0\. 隐私审查/)
    expect(text, '清单里少了「截图里的数字」这一项').toMatch(/数字也是假的|余额/)
    expect(text, '清单里少了独立复核这一项').toMatch(/维护者之外/)
    expect(text).toMatch(/tests\/privacy\.spec\.ts/)
  })

  it('docs/PRIVACY.md 仍在，且写明护栏的能力边界', () => {
    const text = read('docs/PRIVACY.md')
    expect(text).toMatch(/绝对禁止/)
    expect(text, '能力边界没写清楚的活，下一个人会误信护栏').toMatch(/能力边界|读不了图片/)
    expect(text).toMatch(/黑名单/)
  })

  it('PRIVACY.md 随 npm 包发布（否则使用者看不到这些规则）', () => {
    const pkg = JSON.parse(read('package.json')) as { files?: string[] }
    expect(pkg.files, 'docs/PRIVACY.md 必须在 files 里').toContain('docs/PRIVACY.md')
  })
})

describe('发布清单不会把内部文件带出去', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    files?: string[]
  }

  it('tests / scripts / docs/audit 不在 files 白名单里', () => {
    const listed = pkg.files ?? []
    for (const bad of ['tests', 'scripts', 'docs/audit']) {
      expect(listed, `${bad} 不该出现在 files 里`).not.toContain(bad)
    }
  })

  it('README 里相对链接到的 docs/*.md 都在白名单里', () => {
    // npm 页面上 README 是正文，相对链接指向包内路径；漏一项就是一个 404。
    const listed = pkg.files ?? []
    for (const name of ['README.md', 'README.en.md']) {
      const text = readFileSync(join(ROOT, name), 'utf8')
      const links = [...text.matchAll(/\]\((docs\/[^)#]+\.md)\)/g)].map(match => match[1]!)
      for (const link of links) {
        expect(listed, `${name} 链接了 ${link}，但它不在 files 白名单里`).toContain(link)
      }
    }
  })
})

describe('截图资产受控', () => {
  /**
   * `docs/assets/` 下的**每一个**文件都必须被 git 跟踪。
   *
   * 两条都不能省：
   *   · 必须用 `ls-files --cached`（**不带** `--others`）判「已跟踪」——原先拿
   *     `scannedFiles()` 当跟踪集合，而它含未跟踪文件，于是「没被跟踪」永远不成立，
   *     这条断言恒真、等于没写。
   *   · 必须用 `readdirSync` 遍历目录，而不是遍历 `screenshots.json`——后者只有
   *     5 条，恰好漏掉 `settings-page.png`（README 首屏那张、也是 1.18.0 泄露的主体）。
   *     这个缺口是独立审查发现的。
   */
  it('docs/assets 下的每个文件都被 git 跟踪', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files?: string[] }
    expect(pkg.files, 'docs/assets 必须随包发布').toContain('docs/assets')

    const tracked = new Set(
      execFileSync('git', ['ls-files', '-z', '--cached', 'docs/assets'], { cwd: ROOT, encoding: 'utf8' })
        .split('\0').filter(path => path !== ''),
    )
    const onDisk = readdirSync(join(ROOT, 'docs/assets')).filter(name => !name.startsWith('.'))
    expect(onDisk.length, 'docs/assets 不该是空的').toBeGreaterThan(0)

    const untracked = onDisk.filter(name => !tracked.has(`docs/assets/${name}`))
    expect(untracked, `这些图没被 git 跟踪，别人 clone 下来 README 会是一张破图：\n${untracked.join('\n')}`)
      .toEqual([])
  })

  it('screenshots.json 里的每张图都存在', () => {
    const shots = JSON.parse(readFileSync(join(ROOT, 'screenshots.json'), 'utf8')) as string[]
    expect(shots.length).toBeGreaterThan(0)
    for (const shot of shots) {
      expect(existsSync(join(ROOT, shot)), `${shot} 不存在`).toBe(true)
    }
  })
})
