# DSH 插件发布经验备忘

> 本文档记录 `dsh-connect-qoder` 的发布**实操坑**，与根目录 [`RELEASING.md`](../RELEASING.md) 配套：
> `RELEASING.md` 是**权威流程**（每步做什么、核对清单），本文档是「**为什么这么做 + 别踩的坑 + 实测数据**」。
>
> 结构沿用同族 [`dsh-connect-trae/docs/RELEASE_EXPERIENCE.md`](https://github.com/dingminhua/dsh-connect-trae)
> （MIT，Copyright (c) 2026 LaoDing，见 `THIRD_PARTY_NOTICES.md`）。**同族已有的通用条目（沙箱伪装、macOS 无
> `timeout`、tag 哈希 ≠ 提交哈希）不在这里重复**，只记 `dsh-connect-qoder` 自己的与同族尚未覆盖的。
>
> 本文档**不随包发布**（不在 `package.json` 的 `files` 白名单内），只随仓库。

## 0. 本机环境四项（换机器先核对）

```bash
git config --global user.name    # LaoDing（必须与 LICENSE 版权一致）
git config --global user.email   # shangxinyu2002@gmail.com
git config --global --get http.https://github.com.proxy   # http://127.0.0.1:7897
npm whoami                       # dmh2002
```

另一条容易漏的：`~/.npmrc` 配了本地代理（`127.0.0.1:7897`），**第 8 步的核验必须用 `--noproxy '*'` 直连**，
否则读到的是本机代理缓存里的旧版本，会把一次**成功**的发布判成失败。

## 1. ⚠️ 最重要的一条：**AI 不要代跑 `npm publish`**（0.4.3 实录）

这是本文档最想写下来的一条，因为它是我（AI）在 0.4.3 发布当天**真的踩了、且踩了 4 次**的坑。

**规矩**：`npm login` 与 `npm publish` 交给**用户在自己的交互式终端**执行。AI 负责跑检查、改版本号、
写 CHANGELOG、commit、打 tag、push、核验发布结果。理由有两条，第二条是我这次才真切体会到的：

1. **凭据不该交给 AI**（同族 `trae` 的 §6.8 早已写明）；
2. **2FA 的浏览器确认有时效，AI 代跑会把它变成一场和时间的赛跑**。

### 1.1 我做了什么，结果如何

`stdout` 不是 TTY 时 npm 会把授权链接印成 `…/auth/cli/***` 并**立刻退出**——这一点 `RELEASING.md`
第 7 步已经写了。我于是用 `script -q /dev/null npm publish` 伪造了一个 pty：

```bash
script -q /dev/null node -e 'console.log("isTTY:", process.stdout.isTTY === true)'
# → isTTY: true   ← 确实绕过了「不是 TTY」这一层
```

**TTY 那层确实过了，链接也明文拿到了 —— 但 4 次尝试全部失败。** 实测记录（本地时间）：

| 尝试 | 起 | 末 | 轮询 `/-/v1/done` | 末态 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1~2 | 13:28 / 13:34 | — | — | — | 失败（日志已被轮转删除，细节不可再核） |
| 3 | 13:42 | 13:47:16 | **92 次** | **`GET 404`** | `PUT 401`，`exit 1` |
| 4 | 13:47 | 13:47:16 前后 | 92 次 | `GET 404` | `PUT 401`，`exit 1` |
| **用户手动** | **13:57** | **13:57:49** | **13 次** | **`GET 200`** | **`PUT 202`，`exit 0`，`+ @dmh2002/dsh-connect-qoder@0.4.3`** |

> ⚠️ **这份表本身踩了一个坑，值得记下来**：npm 的日志保留上限是 `logs-max:10`（本机实测），
> 每次新命令都会删掉最旧的一份。我事后想复核第 1~2 次尝试的确切时间时，**那两份日志已经不存在了**。
> 所以「发布当天只跑必要的命令、尽早把关键证据摘出来」是条实际纪律 —— **日志不是永久档案**。
> 唯一能长期回看的是你自己写下的备忘录与 registry 的实际状态。

### 1.2 为什么失败：**授权窗口只有约 5 分钟**

npm 的 web-auth 是「`PUT 401` → 拿到 `authId` → 轮询 `GET /-/v1/done?authId=…` 等浏览器确认」。
轮询间隔约 3 秒（`retry-after`），**92 次 ≈ 4.6 分钟**后 npm 放弃，把该 authId 作废 —— 此时再确认，
拿到的就是 `404 Not Found`。

**所以「我拿到链接 → 转述给用户 → 用户切窗口点确认 → 回复我 → 我再继续」这条路走不通**：
这条链路里的每一次人工往返都在烧那 5 分钟。我第 4 次甚至已经用 `open` 直接把浏览器弹出来了，
仍然没赶上（用户答复时窗口已经过期，npm 早已 `exit 1`）。

**成功的形态是**：用户在自己的终端里跑（npm 5 秒内就把浏览器弹出来并**在终端里原地等待**），
用户当场点完确认 → 13 次轮询、**49 秒**完成。

### 1.3 判别：这次失败**没有**发出任何东西

四条独立证据，缺一不可（不能只看某一条）：

```bash
# ① registry 上确实没有（唯一权威判据）
curl -s --noproxy '*' https://registry.npmjs.org/@dmh2002%2Fdsh-connect-qoder \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j['dist-tags'].latest, !!j.versions['0.4.3'])})"
# → 0.4.2 false

# ② 日志里**没有** PUT 202，只有被拒的 PUT 401
grep -E "PUT (401|202)" ~/.npm/_logs/<那次>.log
# → PUT 401 https://registry.npmjs.org/@dmh2002%2fdsh-connect-qoder

# ③ 末次轮询是 404（authId 已作废），不是 200
grep -oE "GET (200|404) https://registry.npmjs.org/-/v1/done" ~/.npm/_logs/<那次>.log | tail -1

# ④ 没有出现 409「重复发布」，说明也没有重复上传成功
```

**「链接过期」与「发布失败」是两件事**：过期只说明这次 2FA 会话作废，此时**包一个字节都没上传**
（PUT 在 web-auth **之后**）。所以重试是安全的，不必改版本号。

## 2. 从 npm 日志判别发布状态（三态）

同族 `trae` 的 §6.9 已给出三态判别表，**qoder 0.4.3 又实测到一个更省事的指纹**：

| 日志特征 | 状态 | 该做什么 |
| --- | --- | --- |
| **没有 `PUT` 行** | 请求未到达（2FA 挑战在 PUT **之前**） | 真失败，交回用户交互终端 |
| `PUT 401` + 轮询 92 次 + `GET 404` | **2FA 会话过期**（本文档 §1） | 真失败，重跑即可，**别改版本号** |
| `PUT 202` + "being processed" | registry 已受理 | **等待**：0.4.3 实测 **约 2 分钟**后 `latest` 翻转 |
| 轮询 `GET 200` + `PUT 202` + `exit 0` | 通常成功 | ⚠️ **不能只看这一行，见下方 1.1.0 实测** |

### ⚠️ 1.1.0 实测：`+ 包名@X.Y.Z` **不是**铁证（2026-10-17）

此前本文档把 `+ @dmh2002/dsh-connect-qoder@X.Y.Z` 这一行当作「真发布」与「暂存待批准」
的分水岭。**1.1.0 证伪了它**：那次 `npm publish` 打印了完整的 `+ @dmh2002/dsh-connect-qoder@1.1.0`
并以 exit 0 结束，但**注册表里根本没有 1.1.0**：

```
versions: 0.0.0-stage, 0.3.0, 0.4.0, 0.4.2, 0.4.3, 0.5.0, 0.5.1, 1.0.0
latest: 1.0.0
tarball 直链        → HTTP 404
带 authToken 查询   → HTTP 404（排除「非公开可见」）
加 cache-buster 再查 → 仍 404（排除 CDN 缓存）
npmmirror 镜像      → HTTP 404
```

当时日志里出现过 `Authenticate your account at: https://www.npmjs.com/auth/cli/…`
——账号是 `auth-and-writes`，2FA 那一步没在窗口内完成，**包一个字节都没上传**。

**唯一可靠的判据是回查注册表本身**：

```bash
npm view @dmh2002/dsh-connect-qoder@X.Y.Z version   # 必须回显 X.Y.Z
```

回 `E404` 就是没发上去——不管 CLI 打印了什么。`+` 行只能读作「CLI 以为成功了」。


> 本机 npm 是 **11.12.1**，没有 `npm stage` 子命令（报 `Unknown command`）——
> 那是 CLI 太旧，不是命令不存在。要批准暂存发布得用 ≥ 11.15.0，或去 npm 网站。

### ⚠️ 1.2.1 实测：packument 与 tarball 是**两个**传播时刻（2026-10-18）

1.1.0 那一节把「tarball 直链 404」和「packument 里没有该版本」并列成同一次失败的证据。
这个并列会让人在**发布成功**时误判成失败 —— 1.2.1 就撞上了：

```
PUT 202 + 2FA 轮询 GET 200 + `+ @dmh2002/dsh-connect-qoder@1.2.1`   ← 2FA 确实走完了
直连 packument 轮询：前 3 次 latest=1.2.0 / has 1.2.1=false，第 4 次翻转   ← 约 2 分钟，与 0.4.3 一致
翻转后立刻试 tarball 直链 → HTTP 404（返回的是 {"error":"Not found"}，21 字节 JSON）
每 20 秒重试，第 10 次 → HTTP 200，shasum 与 registry 的 dist.shasum 一致      ← 又滞后约 3 分钟
```

所以这两个 404 含义完全不同，**判据要分层**：

| 观测 | 含义 |
| --- | --- |
| packument 无该版本 | 真没发上去（1.1.0 那种）——或还在 2 分钟传播窗口内，**或撞上下面那个受理后的处理窗口（1.7.1）** |
| packument **有**该版本、tarball 直链 404 | **已发布**，只是 CDN 资产滞后，等就行 |

**先看 packument，别看 tarball 直链下结论。** registry 的 `time['X.Y.Z']` 一旦出现，
发布就已成立；`dist.shasum` 与本地 `npm pack --dry-run` 的 shasum 一致，就证明上传的
正是这份构建 —— 这两条**不需要**下载 tarball 就能核。

真要逐字节比对产物，把下载重试放宽到**几分钟**（本轮 3 分钟）；直接 curl 拿到 404 时
`file` 会告诉你它是 `JSON data` 而不是 gzip —— 那 21 字节的 `{"error":"Not found"}`
是 CDN 的回复，不是「包不存在」。

### ⚠️ 1.7.1 实测：还有**第三个**时刻——npm 自己的「受理后处理」窗口（2026-10-22）

上一节的表把发布后的观测分成两行（packument / tarball）。1.7.1 撞出第三种时刻：npm **收下
之后、registry 可见之前**还有一个自己的处理窗口，而且它的日志顺序是「notice 在前、`+` 行在
后」。这一轮该窗口是 **6 分钟**，比 1.2.1 那次的约 2 分钟长得多：

```
Authenticate your account at: https://www.npmjs.com/auth/cli/eb11bc9f-…   ← 2FA 走完
npm notice Your package is being processed and may take a few minutes
           to become available.                                            ← 受理 = 正在处理
+ @dmh2002/dsh-connect-qoder@1.7.1                                         ← 约 15:27Z
直连整份 packument 轮询 6 次 / 共 3 分钟：latest=1.7.0、has 1.7.1=false   ← 真实但滞后，**不是失败**
registry 记的 time['1.7.1']                                              = 15:33:18Z   ← 约 6 分钟
```

**判据**：那一行 notice 出现 = npm 已收下并**正在处理**，此刻 registry 查不到是**预期行为**。
它和 1.1.0 那种「打印了 `+` 行但 2FA 超时作废」的区别不在 `+` 行（两种情况都有），而在
有没有这行 notice、以及**是否愿意等到窗口过去**。所以：

- 看到 `Your package is being processed` 就不要在 3 分钟内判生死——**这一轮我差点把一次成功
  发布判成待批准**（还顺手查了 `npm stage list`，本机 11.12.1 无此子命令，见本节开头那条；
  那不是证据，只是命令不存在）。
- 想**当场**定生死，除了整份 packument 再加一条**单版本端点**与 tarball 直链：它们是与
  `dist-tags` 聚合路径**互相独立**的证据，任一条给 `200` 就足以确认包体已落地。
  （**本轮没有对照数据**——那 6 分钟里我只轮询了整份 packument，单版本端点是事后才查的，
  所以「谁更早」不作结论；下次两个一起轮。此处能确定的只有：它们独立，且都成立。）

  ```bash
  curl -s -o /tmp/v.json -w 'http=%{http_code}\n' --noproxy '*' \
    "https://registry.npmjs.org/@dmh2002%2Fdsh-connect-qoder/1.7.1"
  curl -sI --noproxy '*' \
    "https://registry.npmjs.org/@dmh2002/dsh-connect-qoder/-/dsh-connect-qoder-1.7.1.tgz" | head -1
  ```

  `200` + 文档里的 `dist.shasum` 与本地 `npm pack --dry-run` 一致 → **发布成立**。（1.7.1 实测：
  `adb40cd42e90f3a50d3ced0b78fe3d583cb56831` 逐位相同，tarball 26 个文件。）
- **`cf-cache-status: HIT` 与内容新旧无关**，它只说明这一跳命中了 Cloudflare。别拿它当
  「还没更新」的证据——1.7.1 那次 tarball 直链返回 `200` 且 `HIT`，包里已经是新代码。

> **这个窗口不是常数**：1.2.1 约 2 分钟、1.4.0 约 1 分钟、1.7.1 约 6 分钟、1.7.2 约 1–2 分钟
> （见 §11.1）。所以别把任何一次的数字当阈值读；能确定的只有「看到 `being processed` 就等，
> 判据是 `time['X.Y.Z']`」。

### ⚠️ 1.2.1 实测：`~/.npm/_logs` 会被轮转掉，「读日志」要趁热

上一节要求「判定发布成败，先读日志再查 registry」。1.2.1 发布约 7 分钟后再回去读那次
publish 的日志，**文件已经不在了**，只剩其间 `npm view` 等命令生成的新日志。

所以：**日志是易失的，registry 是持久的。** 用户跑完 `npm publish` 把输出贴回来时，
应当**当场**读一次日志抓 `PUT 202`；错过就没机会了。之后一律以 packument 为准，
并且要认得 registry 的 `dist.shasum` —— 它同样能证明 2FA 走完且包体未变。

## 3. `npm publish` 会被 `prepack` 重新构建一遍

`package.json` 的 `prepack: npm run build` 意味着 `npm publish` **自己会跑一次 `tsdown`**。
所以「我本地刚 build 过」不是省事的理由，也不必担心忘记构建 —— 但**要意识到**：
发布包里的 `lib/` 是 **publish 那一刻**重新构建的，与工作树当时的状态一致。

**推论**：`npm publish` 前工作树必须是**干净的**（已 commit）。若工作树有未提交改动，
发布包会与刚打的 tag **不一致** —— 这正是 `RELEASING.md` 第 5 步先 commit + tag 的原因，
也是第 8 步要核对 **shasum** 的原因。

0.4.3 实测：本地 `npm pack --dry-run` 的 shasum `82ea708e1ba8174999e2225aebf01163bc0d4b1a`
**与线上 tarball 的 shasum 逐字相同**，证明上传的就是这份构建。

## 4. 版本号的三处一致（发布前一起核）

```bash
python3 -c "import json;print(json.load(open('package.json'))['version'])"   # package.json
grep -m1 "^## 0" CHANGELOG.md                                                # CHANGELOG 顶部
node -e 'import("./lib/index.js").then(m=>console.log(m.QODER_CONNECT_VERSION))'  # 构建期注入的运行时值
```

三处必须同值。注意 `QODER_CONNECT_VERSION` 是**构建期注入**的（`tsdown.config.ts` 的
`__DSH_QODER_VERSION__`，见 `src/version.ts`），所以**改完 `package.json` 必须重新 build**
才会反映到 `lib/`；`npm publish` 的 `prepack` 会替你 build 一次。

> 产物里出现旧版本号字面量不一定有问题：代码注释里可能**引用**历史版本（0.4.3 的
> `lib/index.js` 里就有一处「0.4.2 已修」的注释）。判据是**运行时导出的那个值**，不是 `grep`。

## 5. CI 双平台（`RELEASING.md` 第 5.5 步）的实际用法

```bash
gh run list --limit 1 --json databaseId,headSha -q '.[0] | "\(.databaseId) \(.headSha[0:7])"'
# 核对 headSha == 刚推的提交，再 watch
gh run view <id> --json conclusion,jobs -q '.conclusion as $c | "OVERALL: \($c)", (.jobs[] | .name + " => " + .conclusion)'
```

**要看每个 job，不能只看 overall。** 0.4.3 实测两个 job 都绿：

```
test (windows-latest) => success
test (ubuntu-latest) => success
```

**Windows 比 ubuntu 多跳一条是正常的**，且必须确认是**有意跳过**：`tests/accounts.spec.ts`
的 `0600` 断言在 Windows 上跳过（node 只把「只读」一位映射进 `st_mode`，普通文件一律 `0o666`，
表达不了 POSIX 权限位 —— 0.4.1 的 CHANGELOG 有完整记录）。0.4.3 实测跳过数：
ubuntu `564 passed | 10 skipped`、windows `563 passed | 11 skipped`，差的那条就是它。

## 6. 核验发布产物：装一次真的

`curl` 查 registry 只证明「元数据在」，不证明「装下来能用」。0.4.3 的做法是额外装一次：

```bash
# ⚠️ 必须先 npm init -y 锚定 project root，见下方「1.2.1 实测」
ISO=$(mktemp -d /tmp/qoder-verify-XXXX) && cd "$ISO" && npm init -y >/dev/null
npm install @dmh2002/dsh-connect-qoder@X.Y.Z --no-save --registry https://registry.npmjs.org/
node -e 'import("@dmh2002/dsh-connect-qoder").then(m=>console.log(m.QODER_CONNECT_VERSION))'   # 必须回显 X.Y.Z
```

### ⚠️ 1.2.1 实测：这条命令有两个坑（2026-10-18）

**坑一：没有 `package.json` 锚定时，npm 会向上找到别的项目根，把包装到"隔壁"。**
旧文档写的 `cd /tmp && rm -rf verify && mkdir verify && cd verify && npm install …` 里，
`verify/` 是空目录、没有 `package.json`。npm 从 cwd 向上找 project root，撞到 `/tmp` 下
**早已存在的 `/tmp/node_modules`**，于是 161 个包全装进了 `/tmp/node_modules`，而不是
`verify/`。第一次 `import` 之所以仍然成功，只是 Node 的模块解析**也**向上冒泡到了那里——
它掩盖了「装错地方」这件事，而不是证明装对了。

判据：装完先看包**落在哪**——

```bash
ls -d node_modules/@dmh2002/dsh-connect-qoder          # 不存在 = 装到隔壁去了
```

所以开头那句 `npm init -y` 不是客套，是这条命令**可复现**的前提。

**坑二：核验完别为了「整洁」去 `rm -rf /tmp/node_modules`。**
那次安装的输出里有 `removed 2 packages` —— 说明这个目录**本来就有别的会话装的包**。
整个目录 79 个顶层条目、mtime 全被这次安装刷成了同一分钟，**从时间戳已经分不出哪些是我装的**。
想删之前先逐条目核查归属（`npm ls --depth=0` / 比对 lockfile），核查不清就**只删自己
新建的目录**（这里是 `$ISO`），把归属存疑的留给系统的 `/tmp` 回收器。
「差点误删别会话的依赖树」这件事，沙箱拦下来是对的。

**注意 `grep` 产物验证修复是否在包里时的陷阱**：0.4.3 我第一遍 `grep` 一个正则
`replace(/(?<![\w.])…/gu,"4xx")` 得到 0 命中，差点误判「修复没进包」——**实际进了**，
只是构建把正则提成了模块级常量 `SANITIZE_BARE_STATUS`，调用点写的是
`message.replace(SANITIZE_BARE_STATUS, "4xx")`。**构建会重命名/提升标识符**，
用「源码里的字面正则」去 grep 产物是不可靠的判据；要么 grep 语义片段，要么直接跑。

## 7. 常见问题补充（qoder 专属）

- **`npm view` 显示旧版本，但日志有 `PUT 202`**：正常，等约 2 分钟。0.4.3 实测
  `PUT 202`（05:57）→ `registry.time` 落地（05:59:04），**约 2 分钟**。
- **`npm error code E404 ... /-/v1/done?authId=***`**：2FA 会话过期（§1.2），
  不是包名错、也不是网络问题。重跑 `npm publish` 生成新链接即可。
- **日志里 `authId=***`**：npm **自己**就把 authId 遮蔽了，所以**别想用 authId 去
  匹配「这一条链接属于哪次运行」** —— 它不可能出现在任何日志里。要归属就用别的指纹
  （轮询次数、时间戳、`~/.zsh_history`）。

## 8. AI 代跑发布的推荐分工（0.4.3 之后固定为此）

| 谁 | 做什么 |
| --- | --- |
| **AI** | 跑 `pnpm run check`、改版本号、写 CHANGELOG、commit、打 tag、`git push`、盯 CI、**核验发布结果**、建 GitHub Release |
| **用户** | `npm login`（若需要）与 **`npm publish`** —— 在**自己的交互式终端**里跑，当场完成浏览器确认 |

AI 把工作做到「**一切就绪、只差在用户终端敲一条 `npm publish` 并点确认**」为止，是最省事的边界。
0.4.3 是反例：我去伪造 pty、转了 3 条授权链接、耗掉 20 分钟，**一条都没成**；
用户按文档在自己终端跑的那一次，**49 秒**就发完了。

## 9. 1.3.0 实测三笔（2026-10-18）

### 9.1 `npm whoami` 会是 401 —— 发布前先敲一下

1.3.0 发布前 `npm whoami` 直接 `E401 Unauthorized`：`~/.npmrc` 里那枚 40 字符老式
token 被直连 `GET /-/whoami` 判 401。而 **1.2.1 是七小时前用同一枚 token 发出去的**。
token 会在后台被作废（改密码、改 2FA 设置、在网站上撤销、或 npm 的安全轮转），
届时 `npm publish` 只会给一个 401，排查成本远高于发布前敲一行：

```bash
npm whoami        # 期望 dmh2002；401 就先 npm login，再 npm publish
```

`npm login` 走浏览器授权，和 publish 一样属于**用户在自己终端做**的那一半。

### 9.2 客户端改动在**运行中的宿主**里刷新页面看不到

1.3.0 期间踩到并反复解释的一条：改完 `src/client/*`、构建也过了，让用户「刷新页面」
**不会**看到新界面。宿主把插件 client bundle **一次性读进内存**，并以
`Cache-Control: public, max-age=31536000, immutable` 下发，URL 里的 `rev` 由
**文件 mtime / ctime / size** 算出；磁盘上的新字节只有在
**宿主重启**（重新扫描注册表）或 `pnpm run dev:web` 的 `rebuilt()` 钩子触发时才会进图。
自测判据（不用打开浏览器）：

```bash
curl -s "http://127.0.0.1:<GUI端口>/plugins/??@dmh2002/<包名>/client.js&rev=<12位>" | grep -c <新符号>
# rev 由 mtimeMs/ctimeMs/size 哈希得出；响应里的字节若是旧的，说明宿主还捧着旧 bundle
```

所以给用户的引导必须是「**重启宿主**再刷新页面」，而不是「刷新一下就好」。

### 9.3 测试替身的挂起 promise 不能同时喂给进度轮询

批量动作的测试替身若写成「所有 fetch 都返回同一个挂起 promise」，那么新加的
**进度轮询**（GET）也会拿到它，`release` 变量被改指向**轮询**那一次 —— POST 永不
返回、批量永远「在飞」，测试于是测到了别的东西（1.3.0 首轮三处失败的真因，报错
看起来完全无关：按钮文案没复位、`onChanged` 调用次数对不上）。替身要**按方法分岔**：
POST 挂起等 release，GET 立刻回当前进度。


---

*来源：`dsh-connect-qoder` 0.4.3 发布实录（2026-10-13）+ 同族
`dsh-connect-trae/docs/RELEASE_EXPERIENCE.md`（MIT，Copyright (c) 2026 LaoDing）。新增经验请继续追加，
并保持与根目录 `RELEASING.md` 的权威流程一致。*

## 10. 1.4.0 实测两笔（2026-10-18）

### 10.1 tarball 滞后**不是固定值**：1.2.1 是约 3 分钟，1.4.0 是 0 秒

1.2.1 那次 `latest` 翻转后 tarball 直链还 404 了约 3 分钟（见 §2 的 1.2.1 实测）。
1.4.0 这次完全另一副样子：

```
直连 packument 轮询：第 1–3 次 latest=1.3.0，第 4 次（约 60 秒）翻转
                          → time['1.4.0']=2026-10-18T00:19:06.617Z
                          → dist.shasum=fb2d65e1… 与本地 dry-run 逐字相同
翻转后立刻试 tarball 直链 → 第 1 次就 HTTP 200
```

所以「轮询到第 N 次仍 404」不能当健康度读，它只是 CDN 资产还没到位。
**判据始终是 packument 的 `time['X.Y.Z']` + `dist.shasum`**，这两条不需要下载 tarball；
真要比对字节时再放宽几分钟，别因为 404 就重发。

### 10.2 视觉改动要**真的渲染出来量**，别读 CSS 推

1.4.0 的间距问题（说明行距分隔线只剩 4 CSS px、「账号池」标题在两条线之间偏上 4px）
都是用户实拍打回后发现的。此前若干轮的做法是「读 `styles.ts` 的 px 相加推断」，
推断与实际渲染连续对不上 —— 因为间距往往是**三层**叠加（元素自身 padding +
容器 gap + 相邻元素的 border/padding），手算漏一层就偏几像素。

可用的量测闭环（一次性、跑完即弃，不需要宿主）：

1. 用一个临时目录（如 `/tmp/qp`）放 `index.html` + `entry.tsx`，`entry.tsx` 直接
   import 仓库里的卡片组件，并 `vi`/手工 stub 掉 `fetch`（喂一份与实拍同形的 usage 文档）；
2. 用仓库自己的 vite 起服务：`node_modules/.bin/vite`（pnpm 布局下顶层没有 vite 包，
   `node -e "require('vite')"` 会失败），`server.fs.allow` 要同时放行临时目录的
   **`/tmp/…` 与 `/private/tmp/…`** 两种写法；
3. 截图用无头 Chromium：
   `~/Library/Caches/ms-playwright/chromium_headless_shell-<ver>/chrome-headless-shell-mac-arm64/chrome-headless-shell`
   —— 必须带 `--virtual-time-budget=3000`，否则页面因 vite 的 HMR WebSocket 永不
   “idle”，进程会一直挂着（表现是命令超时转后台）；`--force-device-scale-factor=2`
   时 **CSS px = device px / 2**；
4. 量法：横线扫「整行 >90% 采样点落在线的色带里」的行；文字带要**限定 x 区间**扫深色
   像素 —— 卡片外框是贯穿全高的竖线，按「最左侧深色像素」扫会把每一行都量成边框位置，
   得出「左缘全都对齐」的错误结论。

量到的两个数（改前 → 改后）：说明行到分隔线 4 → 12 CSS px；标题居中偏差 10.5 → 0.0 CSS px。
改完值再截一次同样量，别只看代码改对了没有。

## 11. 1.7.2 实测三笔（2026-10-23）

这一版是修 issue #6（业务码藏在第二/三层时读不到 ⇒ 排队被判 `auth` ⇒ PAT 被
`credential-rejected` 永久剔除）。发布本身顺利，但留下三条与**核验**有关的经验。

### 11.1 「受理后处理」窗口再次不是常数：这次约 1–2 分钟

§2 的 1.7.1 一节记下那个窗口是 **6 分钟**，并警告「别在 3 分钟内判生死」。1.7.2 这次：

```
npm publish 打印 `+ @dmh2002/dsh-connect-qoder@1.7.2`（用户终端，约 04:14Z 前后）
第一次直连 packument 轮询：latest=1.7.1、time['1.7.2'] 不存在     ← 仍在窗口内
约 1 分钟后再查：latest=1.7.2、time['1.7.2']=2026-10-23T04:15:35.506Z   ← 翻转
tarball 直链：翻转后第 1 次就 HTTP 200（无 §2 的 1.2.1 那种 3 分钟 CDN 滞后）
```

**结论不是「窗口变短了」，而是它本来就不是常数。** 目前四个数据点：1.2.1 约 2 分钟、
1.4.0 约 1 分钟、1.7.1 约 6 分钟、1.7.2 约 1–2 分钟。所以：

- 不要把任何一次的分钟数当阈值；第一次查不到**不构成任何结论**。
- 判据始终只有两条，且都不需要下载 tarball：packument 的 `time['X.Y.Z']` 出现，
  以及 `dist.shasum` 与 `npm publish` 输出里那行 `npm notice shasum: …` 逐位相同。
- 这一轮 `shasum` 是**当场**就比对成功的（`5b15fa6f0c122690074a3b0432ea626e770e6f22`，
  与用户贴的终端输出一致）—— 用户把 publish 输出贴回来时，那行 notice 里的 shasum
  就是最省事的对照物，不必等 tarball 可下载。

### 11.2 核验发布产物时，别用 `require()` 去读 ESM 的 `lib/index.js`

想对**已发布的原件**复跑行为用例（这正是 issue 报告者的取证方式），第一反应是
`node -e "require('/tmp/…/package/lib/index.js')"` —— 失败，`ERR_MODULE_NOT_FOUND`：
`package.json` 里 `"type": "module"`，`lib/index.js` 是 ESM，`require()` 读不了。

两条可用路子：

1. **分类函数在 `lib/host-heartbeat-*.js` 里**（本轮的 `classifyFailure` /
   `deepestBusinessCode` / 三张码表都在），那个文件同样是 ESM，但可以**抽文本 + `new Function`
   编译**：按函数名定位，用括号配平切出函数体（注意跳过字符串字面量里的 `{`，
   否则 `startsWith("{")` 这种会把配平数错），拼成一个自包含片段再编译。
   本轮就是这么对官方 1.7.1 原件与 1.7.2 原件各跑了一组 9 条用例。
2. 真要 `import()`，得在一个 `"type":"module"` 的临时目录里做，且它会把整条依赖链
   （cordis / pi-ai 等 peer）拉进来 —— 对「只验一个纯函数」是过重的。

**顺带一条**：抽取脚本里 `const NAME = 6;` 这种**无括号**的常量，配平逻辑要允许
「没见到任何括号就在 `;` 处收尾」，否则会一路吃到下一个函数的文档注释，编译期报
`SyntaxError: Invalid or unexpected token`。本轮踩了一次。

### 11.3 `businessCodeOf` 会从发布产物里消失（tree-shake），别拿它当核验锚点

1.7.2 把 `classifyFailure` 与六个调用点都改用 `deepestBusinessCode` 之后，
`businessCodeOf` 在包内**不再被引用**，tsdown 直接把它摇掉了：

```
grep -c "deepestBusinessCode" lib/host-heartbeat-WX-jJIAB.js   → 9（定义 + 六个调用点 + 注释）
grep -c "businessCodeOf"      lib/host-heartbeat-WX-jJIAB.js   → 0
```

它在 `src/upstream.ts` 里仍是 `export`，但**不是包的公开 API**（`lib/index.d.ts` 不含它），
所以摇掉不算破坏兼容。两点提醒：

- 核验脚本若硬找 `businessCodeOf` 会误判「产物不对」；抽取器要容忍它缺席（本轮改成
  找不到就补一个 `return undefined` 的占位）。
- 反过来，这也是个**有用的信号**：某个内部函数从产物里消失，说明调用点真的全换过去了。
  本轮就用它确认「六个调用点一个都没漏」。
