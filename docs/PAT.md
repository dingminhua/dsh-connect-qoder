# 获取并配置 PAT（Personal Access Token）

本插件用 **PAT** 接入 Qoder。这份文档只讲三件事：PAT 是什么、从哪拿、怎么填进插件。

## 一、PAT 是什么

PAT 是 Qoder 官方发给开发者的**个人访问令牌**，形如 `pt-` 开头的一串字符。你可以把它理解成「给外部程序用的一把钥匙」：谁持有它，谁就能以你的身份调用 Qoder 的接口。

它的两个特点决定了本插件的设计：

- **你自己签发、自己吊销**：不需要把账号密码交给任何第三方，随时能在设置页删掉。
- **等价于你的账号权限**：泄露它等于泄露账号，因此不要提交进代码仓库、也不要贴到聊天窗口或 issue 里。

插件拿到 PAT 之后做的事（这也是它**为什么只需要 PAT**的原因）：

```text
PAT  ──(一次性)──>  Qoder 网关 /jobToken 交换  ──>  jobToken
                                                      │
                                                      ↓
                                          之后每次请求带签名会话头
                                          （PAT 此后不再出现）
```

PAT 只在**进程内**参与这次交换：DSH 的模型客户端（pi-ai）连的是本机的回环端口，真正的 PAT 一直在插件进程里，不进网络请求、不写进会话记录。

## 二、从哪里拿 PAT

两个区域各发一份，**互不通用**：

| 区域 | 服务站点 | 发证入口 |
| --- | --- | --- |
| 国内版（通义灵码） | `qoder.com.cn` | 登录 [Qoder CN 控制台](https://www.alibabacloud.com/help/zh/lingma/cloud-agents-cn/api-authentication) → **设置 → API 令牌** → 创建令牌 |
| 国际版 | `qoder.sh` | 登录 Qoder 控制台 → **Settings → Personal Access Tokens** → 创建（见 [Qoder 官方认证文档](https://docs.qoder.com/cloud-agents/api/conventions/authentication)） |

创建时：

1. 给令牌起一个**名字**（只是给你自己看的备注，比如「DSH 笔记本」）。
2. 如果页面要求选**权限范围 / 有效期**，按需选择——本插件只用模型推理能力，选默认即可；有有效期的话注意到期后要重新签发。
3. 点创建。**令牌通常只完整显示一次**，当场复制保存（形如 `pt-xxxxxxxx`）。

> 注意：这里说的是 Qoder **控制台网页版**里的入口，不是桌面客户端的设置页。

## 三、怎么填进插件

插件侧有两条路，二选一（同时配也没问题，会自动去重合并）。

### 方式 A：在设置卡片里粘贴（推荐，可多账号）

```text
DSH → 插件 → dsh-connect-qoder → 设置卡片
     → 选对应的 tab（国内版 / 国际版）
     → 点「添加 PAT」
     → 在输入框贴入 pt-…（可顺便填一个显示名，会自动带出真实账号名）
     → 提交
```

提交时插件会**立刻拿它去 Qoder 网关做一次真实验证**：能换到 jobToken 才算通过，失败会直接拒绝并报错，不会把一个无效令牌存进去。所以「提交后没反应」以外的情况，都说明令牌本身有问题。

卡片里可以放**多个**账号（每区域一个保险库），换号、删号都在卡片内完成。

### 方式 B：环境变量

适合不想让令牌进 DSH 设置文件、或者希望由密钥管理器注入的场景：

```bash
# 国际版
export QODER_PERSONAL_ACCESS_TOKEN=pt-xxxxxxxx

# 国内版
export QODERCN_PERSONAL_ACCESS_TOKEN=pt-xxxxxxxx
```

放进 shell 配置（`~/.zshrc` 等）或系统的密钥管理工具（1Password / Bitwarden 等的 shell 插件），DSH 启动时会自动读取。

### 优先级

```text
设置卡片的 PAT  >  环境变量 PAT  >  保险库（vault）账号
```

三者按账号去重合并，不是互相覆盖。谁在生效可以用命令行看：

```bash
dsh-connect-qoder status      # 各区域当前凭据来源与上游可达性
dsh-connect-qoder doctor      # PAT 是否就位、指纹派生、账号数（不联网）
```

## 四、常见问题

**提交后报「验证失败」**
令牌与区域不匹配（国内版的令牌不能用在国际版 tab），或复制时带上了空格/换行，或已过期。

**「凭据被拒」但令牌明明是新生成的（实测记录）**
2026-10 实测到一个值得记下来的现象：同一个 CN 令牌，

| 请求 | 结果 |
| --- | --- |
| `api.qoder.com.cn/api/v1/cloud/agents` | **200** —— 令牌有效、账号正常 |
| `openapi.qoder.com.cn/sash/api/v2/me/usage` | 401 `TOKEN_EXPIRE / token is not active` |
| `openapi.qoder.sh/sash/api/v2/me/usage` | 401 `TOKEN_EXPIRE` |
| `gateway.qoder.com.cn/algo/api/v2/model/list` | 403 `Signature invalid` |

两个结论：

1. **一张令牌有效与否，不能只看单一端点。** `sash` 系列接口回 `TOKEN_EXPIRE`
   时，令牌本身可能完全正常——它只是不接受 PAT 直连（那条路径预期的是
   浏览器会话 cookie：`qoder.com.cn/sash/...` 对缺 cookie 的请求回
   `UNAUTHORIZED / missing cookie header`，与令牌无关）。
2. **`gateway.*/algo/*` 必须走 COSY 签名**，裸 `Bearer` 一律 `Signature invalid`。
   本插件正是走「PAT → jobToken → 签名会话」这条路，所以**聊天与模型列表不受
   上面那条 401 影响**；受影响的只有用量/积分查询。

因此：卡片上积分显示「—」而对话能正常用，属于「积分端点读不到」，不等于
「令牌坏了」。判断令牌真实状态应看对话能否发送，或按上表用 Cloud Agents 端点核对。

**模型列表是空的，但令牌看着没问题**
未配置 PAT 的区域**不会列出任何模型**——一个请求都发不出去，列出来只会点到就失败。确认「从 Qoder 刷新」执行过。

**不想用 PAT 了**
把令牌在 Qoder 控制台里删掉即可；本插件侧用 `dsh-connect-qoder logout [--region cn|global]` 清除本地 vault 账号。

**能不能像 WorkBuddy 那样直接读本机登录？**
不能。WorkBuddy 桌面端把登录态存在固定路径的明文/可解密文件里，插件可以直接扫描复用；Qoder 桌面端把凭据加密后存进系统钥匙串相关的封装文件，且 CLI 侧的 `.auth/user` 只有登录过 Qoder CLI 才会生成（大多数用户不会）。所以 Qoder 这边只有官方 PAT 这一条稳妥路径——所有第三方 Qoder 接入工具都是这么做的。## Qoder 每日签到（实测协议，2026-10）

**参考实现**：https://github.com/L0NE-6/Qoder-Daily （青龙脚本，CN + Global）
**官方规则**：https://help.aliyun.com/zh/lingma/daily-check-in-100-credits-reward-program-terms

### 协议（CN 实测通过）

拉活动列表（**v1**，且叫 campaigns，不是 checkin）：

    GET {openapi}/sash/api/v1/me/campaigns?forceRefresh=true
    headers:
      authorization:    Bearer {jobToken.securityOauthToken}   ← jt- 令牌，与用量同一套
      cosy-clienttype:  10
      accept:           application/json
      accept-language:  zh-CN
      user-agent:       Qoder

响应：

    {"campaigns":[
      {"campaignId":"01a12102-…","actionType":"CLAIM_BENEFIT","claimStatus":"CLAIMED",
       "benefit":{"kind":"CREDITS","amount":100,
                  "modelScope":{"modelSeries":{"key":"ALL_MODELS"}},
                  "validity":{"mode":"RELATIVE_DAYS","days":30}}},
      {"campaignId":"01a05bbf-…","actionType":"VIEW_DETAILS","claimStatus":"CLAIMED"}
    ]}

领取：

    POST {openapi}/sash/api/v1/me/campaigns/{campaignId}/claim
    （同 headers + content-type: application/json + origin）

已领取的判定：HTTP 409，或 body.result === "ALREADY_CLAIMED"，或 body.replayed === true。

### 关键事实

- 活动名里**没有**「签到」二字，所以照着 checkin / signin / reward 猜路径一律 404
  （我实测猜了 13 个全 404）。真正的词是 **campaigns**（活动/权益）。
- 状态机：`claimStatus` ∈ {CLAIMABLE, CLAIMED}；只有 `actionType === "CLAIM_BENEFIT"`
  且 `CLAIMABLE` 的才可领。
- 官方刷新时间：**每天 10:00 (UTC+8)** 开窗（阿里云文档写 0 点，桌面端截图显示 10:00
  ——以桌面端为准）。
- **国际版**还需要设备风控头 `Cosy-MachineToken` / `Cosy-MachineCode` /
  `Cosy-MachineType`；**CN 不需要**（实测多发这些头在 CN 侧是噪音）。
  三件套由 Qoder 客户端自带的 UMID 组件在本机生成，插件按区域读取：

  | 区域 | 优先组件路径 |
  |---|---|
  | 国内版 | `/Applications/Qoder CN.app/Contents/Resources/umid/runtime-info` |
  | 国际版 | `/Applications/Qoder.app/Contents/Resources/umid/runtime-info` |

  两侧都装了时各自优先自己那个 —— 设备身份与区域绑定，用错一侧会被风控拒绝。
  组件不存在时签到**如实报错**（「未找到 Qoder 设备风控组件」），而不是把
  「取不到设备身份」伪装成「今天没有活动」。也可用 `QODER_UMID_PATH` 显式指定。
  读取结果按 50 分钟在进程内缓存（参考实现同量级），避免每次签到都 fork 进程。
- 企业版账号不支持该活动（仅个人用户）。
