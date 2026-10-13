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
| 轮询 `GET 200` + `PUT 202` + `exit 0` | 成功 | `+ 包名@X.Y.Z` 那一行出现即铁证 |

**`+ @dmh2002/dsh-connect-qoder@X.Y.Z` 这一行是「真发布」与「暂存待批准」的分水岭**
（`RELEASING.md` 第 6 步）。暂存时只有 `PUT 202` + `info ok`，**没有**这一行。
0.4.3 是**真发布**（有 `+` 行），所以不需要去 npm 网站点 Approve。

> 本机 npm 是 **11.12.1**，没有 `npm stage` 子命令（报 `Unknown command`）——
> 那是 CLI 太旧，不是命令不存在。要批准暂存发布得用 ≥ 11.15.0，或去 npm 网站。

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
cd /tmp && rm -rf verify && mkdir verify && cd verify
npm install @dmh2002/dsh-connect-qoder@0.4.3 --no-save --registry https://registry.npmjs.org/
node -e 'import("@dmh2002/dsh-connect-qoder").then(m=>console.log(m.QODER_CONNECT_VERSION))'
```

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

---

*来源：`dsh-connect-qoder` 0.4.3 发布实录（2026-10-13）+ 同族
`dsh-connect-trae/docs/RELEASE_EXPERIENCE.md`（MIT，Copyright (c) 2026 LaoDing）。新增经验请继续追加，
并保持与根目录 `RELEASING.md` 的权威流程一致。*
