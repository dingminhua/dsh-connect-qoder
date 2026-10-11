# dsh-connect-qoder

把 **Qoder**（通义灵码国际 / 国内）的模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)。

功能对齐同级的 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)（本仓库 README 大量参考其结构）：

- **双区域**：`qoder`（国内，gateway.qoder.com.cn）与 `qoder-global`（国际，api1.qoder.sh），每个区域一个独立 provider。
- **PAT 凭据**：在设置卡片粘贴 PAT（`pt-…`），或设置环境变量 `QODER_PERSONAL_ACCESS_TOKEN`（国际）/ `QODERCN_PERSONAL_ACCESS_TOKEN`（国内）；设置项优先。
- **模型目录**：从 Qoder cosy 网关拉取实时模型列表，含倍率（价格因子 `price_factor`，`· xN.NN` 显示）、上下文窗口、输出上限、是否支持推理 / 图像、默认 / 免费标记；上游不可达时回退到内置静态目录。
- **模型开关**：卡片内按区域勾选要启用的模型（`enabledModelKeys`），保存后立即生效。
- **用量卡片**：每区域展示基础额度 / 附加额度 / 组织额度的已用、总量、剩余、占比与到期时间。
- **探针**：卡片内对单个模型“测一测”，直达上游确认可用性（限流 / 凭据 / 内容审核分别报因）。
- **区域开关**：显式 `enabled: false` 才停用（opt-out）；停用后该区域模型从选择器整体撤下。

## 架构

插件直连 Qoder 的 cosy 网关（不是 OpenAI 兼容端点；官方 SDK 只是 agent 启动器），因此实现了 cosy 协议的最小客户端：

```
Qoder cosy 网关 ── PAT/jobToken 会话 ──> src/upstream.ts（SSE 增量解析）
                                          │
src/shim.ts   loopback HTTP 服务（127.0.0.1 随机端口 + 进程内 secret）
   ▲  pi-ai 经 OpenAIChatAdapter 只与 shim 对话，真实令牌永不出进程
   │
src/adapter.ts  dsh-llm adapter（qoder / qoder-global 两个 provider）
```

- `src/cosy.ts`：cosy 自定义 Base64 编码、MD5 签名、RSA/AES 会话、指纹派生、jobToken 交换。
- `src/upstream.ts`：区域配置、会话/目录/用量/聊天流、错误分类（内容审核、限流、额度耗尽等）。
- `src/catalog.ts`：模型目录解析、默认启用集合、内置回退目录。
- `src/probe.ts`：模型可用性探针。
- `src/shim.ts`：本地 OpenAI 兼容 shim（只支持流式）。
- `src/web-status.ts`：卡片背后的状态/刷新/用量/探针路由。
- `src/index.ts`：Cordis 插件入口（apply、注册、区域同步）。
- `src/client/`：设置卡片（区域页签、PAT、模型勾选、用量、探针；zh/en）。

## 开发

```sh
pnpm install
pnpm run typecheck   # tsc 双工程（node + client）
pnpm run test        # vitest（cosy/消息/上游/目录/shim/装配集成）
pnpm run build       # tsdown（node ESM → lib/index.js，client CJS → lib/client.js）
```

## 安装

1. 在 Harness 设置中启用插件（或把本仓库 clone 后 `pnpm install && pnpm run build`）。
2. 打开 Qoder 设置卡片，粘贴你的 PAT，选择区域并勾选要用的模型。
3. 在模型选择器中选用 `qoder` / `qoder-global` 下的模型。

## 安全说明

- PAT 只写入本地插件配置（或环境变量），从不进入任何网络请求；对外请求一律使用 cosy 会话令牌（jobToken）。
- 本地 shim 用随机端口的 loopback 服务 + 进程内 secret 鉴权，并校验 Host/Content-Type。
- 本项目只读你显式提供的 PAT；不会读取/改写 Qoder 桌面端本地文件。

## License

MIT © LaoDing
