# 发布流程（Release Flow）

> 本文档是 `dsh-connect-qoder` 的**唯一权威发布流程**。发布前请通读一遍。

## 前置条件

- npm 已登录：`npm whoami` 应显示 `dmh2002`（若报 `need auth`，先 `npm login`）。
- 账号若开启 2FA（两步验证）：`npm publish` 时需**在浏览器确认一步**（见第 7 步）。
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
grep -c '">=0.1.7-rc.1 <0.3.0-0"' package.json

# 宿主线是否已经前进？有 0.3.x 的 tag 就说明该复核上界了
git -C ../deepseek-harness tag -l 'dsh-v0.3.*'
```

核对清单：

- [ ] `package.json` 里全部 `dsh-*` peer 范围完全一致（`tests/dsh-line.spec.ts` 会强制这一点）
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
> 前两处由 `tests/plugin-id.spec.ts` 钉住（含「旧写法必然失败」的回归断言与构建产物断言）；第三处见第 10 步。

**发布前检查**（可选但推荐）：

```bash
npm pack --dry-run
```

### 7. 2FA 确认（若账号开启两步验证）

> **本项目约定：用浏览器授权，不用 `--otp` 方式。** `npm publish` 若提示 EOTP，按 npm CLI 给出的 URL 在浏览器登录确认即可，终端内的 `npm publish` 会自动继续。**不要**用 `npm publish --otp=<6位验证码>` 绕过。

> ⚠️ **这一步必须在交互式终端里做。** npm 在 stdout 不是 TTY 时（管道 `| tail`、重定向、后台任务、CI、agent 的 shell）会**印出被遮蔽的授权链接**（`…/auth/cli/***`）并**立刻退出**，不会等待浏览器确认。需要 2FA 的发布会话请直接在自己的终端跑 `npm publish`。

若浏览器打开的验证 URL 失效（404），重跑一次 `npm publish` 让 npm 生成新的授权链接，再在浏览器确认。

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
