# 更新日志（Changelog）

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.1.0 (2026-01-01)

首个公开发布版本。

### Features

- **双区域并行接入** —— 国内版注册为 `qoder` provider（`gateway.qoder.com.cn`），国际版注册为 `qoder-global` provider（`api1.qoder.sh`）；有 PAT 的区域其模型出现在 DSH 模型选择器里，两个 provider 可同时使用。
- **PAT 凭据** —— 设置卡片内粘贴（`regions.<region>.pat`）或环境变量（`QODER_PERSONAL_ACCESS_TOKEN` / `QODERCN_PERSONAL_ACCESS_TOKEN`），设置项优先；凭据只写入本地插件配置，从不进入网络请求。
- **模型目录与倍率** —— 从 cosy 网关实时拉取模型清单，价格因子以内嵌 `· xN.NN` 显示；逐项勾选启用（`enabledModelKeys`），保存立即生效；上游不可达时回退内置静态目录。
- **用量概览** —— 每区域只读展示基础额度 / 附加额度 / 组织额度的已用、总量、剩余、占比与到期时间。
- **模型可用性测试** —— 卡片内对单个模型「测一测」，直达上游确认可用性，限流 / 凭据无效 / 内容审核分别报因。
- **区域开关（opt-out）** —— 每个区域右侧勾选框，显式取消勾选即把该 provider 从选择器整体撤下；账号配置全部保留，重新勾选即恢复。
- **安全 loopback shim** —— 每区域一个随机端口 + 进程内随机 secret，真实 PAT 不交给 pi-ai。
- **命令行诊断** —— `dsh-connect-qoder doctor|status [--json]`，无需浏览器即可确认 PAT 来源、指纹派生与上游可达性。

### Docs

- README / README.en.md（双语）、CHANGELOG、THIRD_PARTY_NOTICES、RELEASING（发布流程）。
- 收录草稿：`awesome-dsh-plugin-submission/`（Awesome DSH Plugin 注册表）。

### 说明

- 首次发布按 `RELEASING.md` 流程执行；`npm publish` 若走暂存发布（staged publishing），需 2FA 批准后再核对 registry。
