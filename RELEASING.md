# 发布流程（Release Flow）

> 本文档是 `dsh-connect-qoder` 的**唯一权威发布流程**。发布前请通读一遍。
>
> 🤖 **由 AI 助手代跑发布时，请先读 [`docs/RELEASE_EXPERIENCE.md`](docs/RELEASE_EXPERIENCE.md)**：
> 其中 §1 记着一条硬规矩 —— **`npm login` 与 `npm publish` 交给用户在自己的交互式终端执行，
> AI 不要代跑**。0.4.3 发布当天 AI 试了 4 次全部失败（含用 `script` 伪造 pty），原因是 npm 的
> 2FA 授权窗口**只有约 5 分钟**，人工往返转述链接赶不上；用户在自己终端跑的那一次 **49 秒**完成。
> 该文档还记着发布状态的三态判别、`prepack` 会重新构建、以及核验产物的实操坑。

## 前置条件

- npm 已登录：`npm whoami` 应显示 `dmh2002`（若报 `need auth`，先 `npm login`）。**发布前务必重新敲一次**：token 会在后台被作废，1.3.0 发布前它就已是 401，而 1.2.1 七小时前还用同一枚发成功（见 [`docs/RELEASE_EXPERIENCE.md`](docs/RELEASE_EXPERIENCE.md) §9.1）。
- 账号若开启 2FA（两步验证）：`npm publish` 时需**在浏览器确认一步**（见第 7 步）。**这一步请在
  自己的交互式终端里做**，理由见 [`docs/RELEASE_EXPERIENCE.md`](docs/RELEASE_EXPERIENCE.md) §1。
- GitHub 仓库：`https://github.com/dingminhua/dsh-connect-qoder`（默认分支 `main`）。
- `gh` 已登录且带 `repo` 权限：`gh auth status` 应显示 `Logged in to github.com account dingminhua`、scope 含 `repo`（第 9 步要用）。

## 每次发布的完整步骤

### 1. 确认代码、测试与版权

```bash
cd /Users/dmh2002/DshProject/dsh-connect-qoder
pnpm run check        # typecheck + test + build，应全部通过
grep -F "Copyright (c) 2026 LaoDing" LICENSE
```

> 本项目以 MIT 许可证发布，版权归属必须保持为 **LaoDing**；发布前不得把 LICENSE 中的版权主体改成 npm 账号、GitHub 账号或其他名称。

> ⚠️ **`pnpm run check` 只覆盖本机平台。** 第 5.5 步要求 CI 的 ubuntu **与 windows** 两个 job 都转绿才算过关 —— 0.4.0 就是本地全绿发出去的，而 windows job 那时已经连红 6 次。

### 2. 核对溯源与致谢（**不得跳过**）

本项目建立在他人已公开的工作之上。每次发布前必须确认：

```bash
# 第三方声明随包分发
grep -F "THIRD_PARTY_NOTICES.md" package.json   # 应在 files 白名单内

# 双语 README 的致谢章节仍在
grep -F "Zhengyuuuui/qoder2api" README.md README.en.md
grep -F "dingminhua/dsh-connect-workbuddy" README.md README.en.md
grep -F "dsh-codex-connect" README.md README.en.md   # 唯一的 Apache-2.0 参考项
```

核对清单：

- [ ] `THIRD_PARTY_NOTICES.md` 在 `package.json` 的 `files` 白名单中，随包分发
- [ ] README 与 README.en.md 的致谢章节列出全部参考项目及许可证
- [ ] `dsh-codex-connect`（Apache-2.0）的声明义务在 `THIRD_PARTY_NOTICES.md` 中单独履行
- [ ] 本轮新增/修改的源文件，头部注释标注了参考来源（现有文件都标了）
- [ ] 若引入了新的 Qoder 相关依赖或复用了他人代码，`THIRD_PARTY_NOTICES.md` 已同步更新
- [ ] **GPL 红线**：任何情况下都不得把 `wangtufly/QCCG`（GPL-3.0）或 `Zhengyuuuui/qoder2api` 的源码直接复制进本项目；只能参照协议行为独立实现

### 2.5 宿主范围核对（peer 上界，**不得跳过**）

每次发布前确认声明的宿主范围与当前 DSH 线一致。**上界写错不会让任何构建或测试失败**——它只在下一个 DSH 版本落地那一刻生效，且用户侧表现为插件**静默消失**（组合包被 `loadProfileDirectory` 跳过，只打到 stderr）。

```bash
# 所有 dsh-* peer 必须是同一条范围，且上界带 -0（DSH 至今只发预发布）
grep -c '">=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0"' package.json

# 宿主线是否已经前进？有 0.3.x 的 tag 就说明该复核上界了
git -C ../deepseek-harness tag -l 'dsh-v0.3.*'
```

核对清单：

- [ ] `package.json` 里全部 `dsh-*` peer 范围完全一致（`tests/dsh-line.spec.ts` 会强制这一点）
- [ ] **下界之后的每一条宿主线都要有自己的预发布分支**：node-semver 只有当范围里*某个*比较符与该版本的 `major.minor.patch` 元组完全一致、且自身带预发布标签时，才放行预发布版本。只写 `>=0.1.7-rc.1 <0.3.0-0` 会静默排除整条 `0.2.0-rc.*`——而那正是 `@deepseek-ai/dsh` 当前的 `latest`，用户侧报 `ERESOLVE`。宿主开新线时**同时补一条分支**（`tests/dsh-line.spec.ts` 会挡）
- [ ] 上界仍是 `<0.3.0-0`；若 DSH 已进入 0.3.x 线，先在真机或 tag 上复核再决定是否放宽，**不要只改数字**
- [ ] 上界带 `-0` 后缀（写成 `<0.3.0` 等于不挡：DSH 至今全部 tag 都是预发布，围栏会静默失效）
- [ ] 两条 README 的「受支持的宿主范围」表与 `package.json` 三者一致
- [ ] 若本次放宽了上界，已在 `CHANGELOG.md` 说明**依据**（哪些包、如何复核），而不是只写「支持新版本」

### 3. 更新版本号

手动改 `package.json` 的 `version` 字段。

> 后续步骤以目标版本号 `X.Y.Z` 指代。

### 4. 更新 CHANGELOG.md

在 `CHANGELOG.md` 顶部新增一节 `## X.Y.Z (YYYY-MM-DD)`，按 `Features` / `Fixes` / `Docs` 分组记录本次变更。

### 5. 提交并打 git tag

```bash
git add package.json CHANGELOG.md README.md README.en.md THIRD_PARTY_NOTICES.md
git commit -m "chore: 版本升级至 X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z: <一句话说明>"
git push origin main
git push origin vX.Y.Z
```

> ⚠️ **tag 必须指向包含本次代码的提交**。若目标 tag 已存在且指向旧提交，需先删除并强制移动，修正后用 `git rev-list -n1 vX.Y.Z` 确认指向当前 HEAD。

### 5.5 CI 双平台必须转绿（**不得跳过**）

第 1 步的 `pnpm run check` 只在**本机平台**跑过。CI 是 `ubuntu-latest` + `windows-latest` 两个 job，**本地绿不等于 Windows 绿**。

```bash
gh run list --limit 1 --json databaseId,headSha,conclusion -q '.[0] | "\(.databaseId) \(.headSha[0:7]) \(.conclusion)"'
gh run watch <run-id> --exit-status --interval 15
gh run view <run-id> --json conclusion,jobs -q '.conclusion as $c | "OVERALL: \($c)", (.jobs[] | .name + " => " + .conclusion)'
```

核对清单：

- [ ] 最新一次 run 的 `headSha` **就是**第 5 步推上去的那个提交（不是更早的）
- [ ] **两个 job 都 success**，不是只看 overall
- [ ] 有 `skipped` 时，确认是**有意**跳过（live 测试要凭据、平台不支持的断言），而不是被静默漏掉

> **为什么这一条要写进清单**：0.4.0 发布时 CI 已经连红 6 次 —— `tests/accounts.spec.ts` 断言保险库文件 `mode === 0o600`，而 node 在 Windows 上只把「只读」一位映射进 `st_mode`，普通文件一律报 `0o666`，**这条断言从被引入那天起就没在 Windows 上绿过**。它伤不到用户（写入路径确实请求了 0600），但红着的 CI 让「这次发布有没有弄坏什么」这个问题失去答案：真回归会混在既有红灯里看不见。修法见 CHANGELOG 的 0.4.1。

### 6. 发布到 npm

```bash
npm publish
```

> ⚠️ **`npm publish` 成功退出（exit 0）不等于版本已上线。** 本账号/包可能走 npm 的**暂存发布（staged publishing）**：此时 registry 返回 **`202 Accepted`**，npm 把它当成功（打印 `info ok`、退出码 0），但版本只是进了**暂存区**，**公开的 packument 里看不到**，用户也装不到。
>
> **判据**：`npm publish` 只报 `PUT 202` / `info ok`（**没有** `+ @dmh2002/dsh-connect-qoder@X.Y.Z` 那一行），且第 8 步直连核验里 `latest` 仍是旧版本 —— 那就是**待批准**，不是失败。
>
> **必须再由维护者用 2FA 批准**：到 npmjs.com 的 **Staged Packages** 标签页点 **Approve**；或在 npm CLI **≥ 11.15.0** 下用 `npm stage approve <stage-id>`。

**作用域包**：`package.json` 的 `name` 是 `@dmh2002/dsh-connect-qoder`，且带 `publishConfig.access: "public"`——**没有这一项，`npm publish` 会按 restricted 报价并可能失败**。发布名与插件在 DSH 内的标识是两件事：`cordis.patch.yml` 的 entry `id`、设置命名空间、`/plugins/dsh-connect-qoder/…` 路由与 CLI 程序名**故意保持不带作用域**（改名会孤儿化老配置）。

**打包内容**：`package.json` 的 `files` 字段限定只发布 `lib/`、`icons/`、`docs/assets/`、`docs/PAT.md`、`docs/DESIGN.md`、`screenshots.json`、`cordis.patch.yml`、README 双语、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`、`LICENSE`。`tests/`、`scripts/`、`docs/audit/` 与 `node_modules/` 不会进入发布包——`npm pack --dry-run` 的输出里若出现它们（或任何 `pt-` 样式的字符串），先修再发。

> **改包名时必须同时核对的三处身份**（0.3.0 在这上面栽过两次，都是**静默**的）：
> 1. `tsdown.config.ts` 的 `PLUGIN_ID` —— 客户端 bundle 在 `window.__ModuleLoader__` 声明的模块 id **必须等于包名**，否则花名册配不上行、永不 invalidate，第二次执行抛 `duplicate factory registration`（插件「启用失败」）。
> 2. `src/client/slot-keys.ts` —— 配置卡片槽位按**包名**建键（`plugins.bundle.config` 用裸包名、`plugins.row.config` 用 `<包名>#<entry id>`），硬编码旧名会让卡片正文**整片空白且不报错**。
> 3. profile 侧的依赖键与 `dsh.profile.bundles` —— 本地 `link:` 安装的键名也要跟着改成 scoped，否则 patch 里的 `name` 解析不到（`ERR_MODULE_NOT_FOUND`）。
>
> 前两处由 `tests/plugin-id.spec.ts` 钉住（含「旧写法必然失败」的回归断言与构建产物断言）。第三处是**本地 `link:` 安装**时才走到的路径，静态测试覆盖不到，真出错表现为加载 patch 时 `ERR_MODULE_NOT_FOUND`——改包名后要在本地 link 安装一次确认 profile 侧键名与 `dsh.profile.bundles` 都已跟着改成 scoped。（旧文此处写「见第 10 步」，但本文件从未有过第 10 步，该引用自加入起即悬空，已就地说明。）

**发布前检查**（可选但推荐）：

```bash
npm pack --dry-run
```

### 7. 2FA 确认（若账号开启两步验证）

> **本项目约定：用浏览器授权，不用 `--otp` 方式。** `npm publish` 若提示 EOTP，按 npm CLI 给出的 URL 在浏览器登录确认即可，终端内的 `npm publish` 会自动继续。**不要**用 `npm publish --otp=<6位验证码>` 绕过。

> ⚠️ **这一步必须在交互式终端里做。** npm 在 stdout 不是 TTY 时（管道 `| tail`、重定向、后台任务、CI、agent 的 shell）会**印出被遮蔽的授权链接**（`…/auth/cli/***`）并**立刻退出**，不会等待浏览器确认。需要 2FA 的发布会话请直接在自己的终端跑 `npm publish`。

> ⚠️ **授权窗口只有约 5 分钟，别把链接转给别人等回复。** npm 拿到 `authId` 后每隔约 3 秒轮询
> `GET /-/v1/done?authId=…`；**约 92 次（≈4.6 分钟）后放弃并把该 authId 作废**，之后即使确认也只会
> 拿到 `E404`。所以「AI 跑命令 → 把链接转述给用户 → 用户切窗口确认 → 回复 AI」这条链路**必然赶不上**：
> 0.4.3 发布当天这样试了 4 次（含用 `script` 伪造 pty 绕过 TTY 那层）**全部失败**，而用户在自己的终端
> 里跑的那一次，**49 秒**就完成了（轮询 13 次即 `GET 200`）。实测数据见
> [`docs/RELEASE_EXPERIENCE.md`](docs/RELEASE_EXPERIENCE.md) §1。

若浏览器打开的验证 URL 失效（404），重跑一次 `npm publish` 让 npm 生成新的授权链接，再在浏览器确认。
（链接 404 = 那次 2FA 会话已过期，此时**包一个字节都没上传**，重试安全、**不需要改版本号**。）

> ⚠️ **1.1.0 实测（2026-10-17）：看 `+ 包名@X.Y.Z` 那一行不足以判断成功。** 那次 2FA 没在窗口内
> 完成，`npm publish` 却**照样打印了 `+ @dmh2002/dsh-connect-qoder@1.1.0` 并以 exit 0 结束**，
> 而注册表里查无此版本（tarball 直链 404、带 token 查 404、镜像 404）。**只有第 8 步那条直连回查
> 才作数**——`+` 行只能读作「CLI 以为成功了」。详见
> [`docs/RELEASE_EXPERIENCE.md`](docs/RELEASE_EXPERIENCE.md) §2。

### 8. 验证发布成功

```bash
npm view @dmh2002/dsh-connect-qoder --prefer-online version            # 应显示 X.Y.Z
npm view @dmh2002/dsh-connect-qoder --prefer-online dist-tags.latest   # 应为 X.Y.Z
```

**权威验证（必须用这条，绕开本机代理缓存）**——作用域在 registry 路径里要写成 `%2f`：

```bash
curl -s --noproxy '*' -H "Cache-Control: no-cache" https://registry.npmjs.org/@dmh2002%2Fdsh-connect-qoder \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('latest:',j['dist-tags'].latest);console.log('has X.Y.Z:',!!j.versions['X.Y.Z']);console.log('published:',j.time['X.Y.Z'])})"
```

应打印 `latest: X.Y.Z` 与本次发布时间。**再核对 tarball 的 shasum 与本地 `npm pack --dry-run` 输出一致**，确认上传的就是本次构建的代码。

> ⚠️ **先看 packument，别用 tarball 直链下结论（1.2.1 实测）。** packument 与 tarball 是**两个**传播时刻：`time['X.Y.Z']` 出现（约 2 分钟）后，tarball 直链仍可能 **404 约 3 分钟**——返回的是 21 字节的 `{"error":"Not found"}`（`file` 会告诉你那是 JSON 不是 gzip）。**registry 的 `dist.shasum` 与本地 dry-run 一致即已足够**，不需要下载就能核；真要逐字节比对产物，把下载重试放宽到几分钟。把「packument 有版本 + tarball 404」读成失败，会把一次**成功**的发布误判掉。这个滞后**不是固定值**：1.4.0 那次 `latest` 翻转后 tarball 立刻就是 HTTP 200（见 [`docs/RELEASE_EXPERIENCE.md`](docs/RELEASE_EXPERIENCE.md) §10.1），所以「轮询第 N 次仍 404」不能当健康度读——判据始终是 packument 的 `time` 与 `dist.shasum`。

> ⚠️ **本机 `~/.npmrc` 可能配置了本地代理**，`npm view` 与普通 `curl` 会走代理并可能读到**缓存的旧版本**，从而把一次**成功**的发布误判成失败。验证发布**只认上面那条 `--noproxy '*'` 的直连命令**，不要用裸 `npm view` 下结论。

### 9. 创建 GitHub Release（**最容易漏的一步**）

**npm 发布成功不等于发布完成。** 每个版本都在 GitHub 上有一份 Release——它是用户从 GitHub 进入时的第一屏。做完第 8 步请立刻做这一步。

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z — <一句话说明>" \
  --notes-file /tmp/release-X.Y.Z.md \
  --verify-tag
```

- **`--verify-tag`（务必带上）**：tag 必须已存在（第 5 步推过）。漏了它，命令会在 tag 不存在时**悄悄新建一个指向当前 HEAD 的 tag**。
- **`--title` 的形态是 `vX.Y.Z — <一句话>`**（破折号 `—`，不是 tag message 里的冒号 `:`）。
- **`--notes-file` 指向临时文件**。不要用 `--notes-from-tag`（正文会空得离谱），也不要用 `--generate-notes`。
- 不加 `--draft`、不加 `--prerelease`；**不附任何构建产物**（本插件经 npm 分发）。

**正文的形态**（注意：它与 `CHANGELOG.md` 里那一节**不是同一份文本**）：

```markdown
# <一个主题 emoji> vX.Y.Z — <比 --title 再完整一档的一句>

<本版主线，一到两段>

---

## 一、<主题>
## 二、<主题>
```

- H1 带一个主题 emoji，副标题比 `--title` 更长一档。
- 正文按 **`## 一、` `## 二、` 主题**分节，而不是照抄 CHANGELOG 的 Features / Fixes / Docs 分组：CHANGELOG 是逐条变更记录，Release 是**可独立阅读的发布公告**。

核对清单（**做完逐条勾掉**）：

- [ ] `gh release list` 里能看到本次版本，标题以 `vX.Y.Z — ` 开头（破折号）
- [ ] Release 指向的 tag 与第 5 步推的是同一个：`gh release view vX.Y.Z --json tagName`
- [ ] 不是 draft、不是 prerelease
- [ ] `assets` 为空
- [ ] 正文不是 CHANGELOG 的复制粘贴，单独读也讲得通

```bash
# 一次确认以上五点
gh release view vX.Y.Z --json name,tagName,isDraft,isPrerelease,assets
```

> **为什么这一步必须写进文件**：它对 CI、对 npm、对测试**都没有任何影响**，所以漏掉时不会有任何东西报错。它只能靠「发布清单里写着」来保证。

## 常见问题

- **`npm publish` 报 EOTP**：账号开启了 2FA，**按第 7 步在浏览器授权**（npm CLI 给出的 URL），不要用 `--otp=<码>` 命令行方式。链接 404 就重跑 `npm publish` 生成新链接。
- **`npm publish` 报 EOTP，但拿不到授权链接、而且它一闪就退出了**：这一步**必须在交互式终端里跑**。npm 只在 stdout 是 TTY 时才**自动打开浏览器**、并**留在原地等待**授权；一旦进了管道、重定向或后台任务，授权链接会被 npm 自己印成 `***` 且进程立即退出。
- **`npm publish` 报 409，但两种报文的含义完全相反，别混为一谈**：
  - `Cannot publish over previously staged version "X.Y.Z"` —— 该版本在 registry 上处于**暂存（staged）未提交**状态。它**不是**「已发布」。常见来源是需要 2FA 而中途没走完的那次发布请求。**先别急着改版本号**——稍等重试，或在 npm 网站上批准/丢弃这次暂存。
  - `You cannot publish over the previously published versions: X.Y.Z` —— 这才是**已经发布成功**。此时第 8 步的直连核验会显示 `latest: X.Y.Z`。
- **`npm error code E404 ... GET https://registry.npmjs.org/-/v1/done?authId=***`**：**2FA 会话过期**，不是包名错、也不是网络问题（npm 轮询约 92 次 ≈4.6 分钟后作废该 authId）。重跑 `npm publish` 生成新链接即可，**不需要改版本号**——此时包一个字节都没上传。
- **想用 `authId` 判断「这条链接属于哪次运行」——做不到，别试**：npm **自己**就把 authId 遮蔽成 `***` 写进日志，所以它不可能在任何日志里出现。0.4.3 发布时我用「authId 在日志里搜不到」推出过『这条链接不是我的运行』——那是**无效推理**（必然搜不到）。要归属请换指纹：轮询次数（92 次 = 超时；十几次就 200 = 当场确认成功）、时间戳、`~/.zsh_history`。
- **判定发布成败，先读日志再查 registry**：日志里**没有任何 `PUT` 行** = 请求未到达；`PUT 401` + 轮询 92 次 + `GET 404` = 2FA 超时（真失败）；`PUT 202` + "being processed" = 已受理、等约 2 分钟；`exit 0` 且输出里有 `+ @dmh2002/dsh-connect-qoder@X.Y.Z` = 真发布（暂存时**没有**这一行）。完整三态表见 [`docs/RELEASE_EXPERIENCE.md`](docs/RELEASE_EXPERIENCE.md) §2。
