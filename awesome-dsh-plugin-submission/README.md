# 市场收录目录（Awesome DSH Plugin Submission）

本目录存放本项目提交到 [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 注册表的**草稿**。正式提交以 PR 形式存在于该仓库，本目录是本地镜像与操作说明。

## 当前状态

- **正式提交**：尚未提交（待插件发布后提交 PR `data/plugins/dingminhua__dsh-connect-qoder.yml`）
- **前置要求**（依据 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)）：
  - [x] 仓库 `package.json` 声明 `dsh.bundle` manifest（`dsh.bundle.patch: ./cordis.patch.yml`）
  - [ ] 仓库打 `dsh-plugin` topic（在 GitHub 仓库 Settings → Topics 添加）
  - [ ] 仓库满 1 天、提交数 ≥ 10（CI 自动检查）
  - [ ] 插件已发布到 npm（注册表以 npm 包为准）
- **截图**：声明在**本项目自己仓库**的 `screenshots.json`（目前未建——发布安装后截图补齐）

## 收录目录规范

- 每个插件一个 YAML：`data/plugins/<owner>__<repo>.yml`
- 字段：
  - `url`：与仓库地址**完全一致**
  - `name`：`owner/repo`
  - `category`：有效值之一（本项目为 `model`）
  - `description.en`：必填，一行，以句号结尾；含 `: ` 必须加引号
  - `description.zh`：可选，维护者会补
- README（`README.md` / `README.zh.md`）由脚本生成，**不要手工编辑**；改 YAML 后执行：
  ```sh
  npm ci
  node scripts/generate-readme.mjs
  ```
- 一个 PR 最多收录 3 条；只改自己的条目。

## 更新步骤（改条目内容时）

1. 修改本目录的 `dingminhua__dsh-connect-qoder.yml` 草稿
2. 在 fork 分支上同步修改 `data/plugins/dingminhua__dsh-connect-qoder.yml`
3. 重新生成 README（见上）
4. 推送，PR 自动重跑 CI