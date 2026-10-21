# 活动优惠徽标：取证与判定

模型行上那枚「错峰 4 折」小胶囊。一句话：**上游在模型目录里就给了这枚徽标的文案、
时段和规则，插件只负责「此刻该不该画」和「画在哪」。**

## 1. 数据在哪：同一次目录请求，不新增任何请求

`/algo/api/v2/model/list?Encode=1` 的每个模型行自带一个 `promotion` 对象。插件本来就
为了取目录读这份文档，所以这次改动**没有新增一次上游请求**，只是多了一个解析器
（`src/promo.ts`）和一个渲染时刻的判定。

2026-10-21 16:2x 本机实测（真凭据、只读 GET、不消耗积分）：

| 区域 | 主机 | 去重后模型数 | 带 `promotion` 的行 |
| --- | --- | --- | --- |
| 国内 | `https://gateway.qoder.com.cn` | 11 | 2（`qmodel_38max`、`qmodel`） |
| 国际（全部分组） | `https://api1.qoder.sh` | 22 | 5（`ultimate`、`quest-ultimate`、`experts-ultimate`、`qmodel_38max`、`qmodel`） |
| 国际（插件读的 `chat` 分组） | 同上 | 13 | 3（`ultimate`、`qmodel_38max`、`qmodel`） |

两个区域是**同一套 schema**，只有时区和文案不同：国内 `Asia/Shanghai`，「错峰 4 折」；
国际 `Asia/Singapore`，「错峰2折」/`Off-Peak 80% off`。注意上游自己写的也不统一——国内
`qmodel_38max` 是「错峰 4 折」（有空格），`qmodel` 是「错峰4折」（没空格）。插件原样
显示，不做「统一格式」。

## 2. 逐字抓包（国内 `qmodel_38max`）

```json
"promotion": {
  "active": false,
  "badge": { "en": "Off-Peak 60% off", "zh": "错峰 4 折" },
  "description": {
    "en": "Off-Peak 60% off (10 PM-8 AM UTC+8)",
    "zh": "错峰时段4折优惠（10 PM-8 AM UTC+8）"
  },
  "timezone": "Asia/Shanghai",
  "rule_id": "idle_time_model_credit_discount",
  "discount_factor": 0.4,
  "before_promotion_price_factor": 0.5,
  "link_url": {
    "zh": "https://docs.qoder.cn/product-overview/qwen-3-7-series-model-staggering-discount"
  },
  "window_start": "22:00",
  "window_end": "08:00"
}
```

国际区同一条规则换成了 `discount_factor: 0.2` / `before_promotion_price_factor: 2`，
`timezone: "Asia/Singapore"`，`link_url` 指向 `https://docs.qoder.com/events/offpeakrate`。

字段三组：**给人看的**（`badge`、`description`）、**规则**（`active`、`rule_id`、
`discount_factor`、`window_start/end`、`timezone`）、**跳转**（`link_url`）。

## 3. 判定规则（`src/promo.ts`）

1. **只认有文案的规则。** `badge.zh` 与 `badge.en` 都没有 → 一律丢弃。没有可显示的话，
   插件没有可画的东西，也不自己编。
2. **画不画 = 上游 `active` 且（有窗口时）此刻落在窗口内。** 两道门是**与**关系，不是
   或：窗口校验只做减法，绝不把上游的 `false` 变成 `true`（理由见 §3.1）。
3. **没有窗口声明时只信 `active`。** 上游哪天给了个不带时段的常驻活动，这条路径直接可用。
4. **时段按上游声明的时区算**（`timezone`），不是浏览器时区：`22:00–08:00` 说的是那条
   记录的时区里的 22:00。起点含、终点不含；跨零点命中 `[22:00, 24:00) ∪ [0, 08:00)`；
   `start === end` 视为全天。
5. **一个模型只画一枚徽标**，落在模型名**旁边**而不是名字里面——名字是省略号截断的，
   放进去会被一起裁掉。与倍率、free 标记、测试结论并列，顺序是「倍率 → 徽标」。
6. **文案、悬停都只说上游的话。** 胶囊文字取 `badge.zh`（中文界面）/ `badge.en`；
   悬停取 `description`，再补上「时段 + 时区」与 `link_url` 原文。插件不翻译、不改写、
   不从 `discount_factor` 反推「4 折」这类数字。

### 3.1 为什么判定必须放在渲染时刻

`promotion` 会随 `lastCatalog` 一起落盘。**若在解析时就挑定「画 / 不画」，夜里读到的
目录会把它冻结到第二天早上**：16:00 拉到的快照写着 `active: false`，到 23:00 仍然
`false`，徽标永远不出现；反过来 23:00 拉到的快照写着 `true`，早上 9:00 还在自我宣传。

所以解析层只保留**规则**（`QoderPromotion`，不带任何「已判定」的痕迹），卡片每次渲染
拿 `new Date()` 现算（`promoLiveAt`）。这与 workbuddy（`selectPromoBadge`）、Trae
（`selectTraePromoBadge`）三处是同一个取舍。

### 3.2 为什么 `active` 与窗口是「与」而不是「或」

`active` 是**上游在那一刻算的**（实测 16:2x 在窗口外，两个区域全部 `false`），插件手里
的目录是几秒到几分钟前的快照。两个方向反着错：

- 窗口说「该画」但 `active` 说「不」：可能是**账号不符合资格**（会员/企业限定），
  也可能只是快照旧了。画出去的代价是**对用户说了一句不成立的优惠**。
- `active` 说「该画」但窗口已过：快照是昨晚的，画出去等于**过期广告挂着**。

取「与」：宁可少画（下次刷新就补上），不可多画（说错话没法撤回）。代价是一份放很久
的目录可能漏掉一个真实活动的开头，所以「刷新模型」/ 打开卡片时重新取目录这件事仍然
有意义（插件本来就这么做）。

## 4. 与另两个插件的能力对照

| 能力 | workbuddy PR #91 | Trae PR #44 | Qoder（本 PR） |
| --- | --- | --- | --- |
| 文案来源 | 上游 `badge.label` | 无文案，插件自造「闲时」 | 上游 `badge.zh/en`，原样 |
| 颜色 | 上游 `badge.color` | 插件自选三色 | 插件自选（上游没给） |
| 绝对生命周期 | `validFrom/validUntil` | 无 | 无（只有每日时段） |
| 每日时段 | `schedule.daily`（具名时区） | `off_peak.time_windows`（周几+分钟） | `window_start/end` + `timezone` |
| 多枚候选 / 优先级 | 有（`priority`、`activeOnly`） | 无（一对一） | 无（一对一） |
| 服务端「此刻生效」标志 | 无 | `current.discount_type` | `active` |
| 额外请求 / 换客户端身份 | 需要（`/v3/config` 按通道下发） | 不需要 | **不需要** |

Qoder 是三者里唯一「文案自带 + 不需要换身份 + 不需要额外请求」的：最省事，也最贴近
「徽标只说上游的话」。

## 5. 实机复核

`scripts/probe-promo.mjs` 用真凭据、cosy 签名（与客户端同一条路径）读一次目录，然后跑
**插件的解析与判定**（`parseUpstreamModel` → `parseQoderPromotion` → `promoLiveAt`）：

```
$ node --experimental-transform-types scripts/probe-promo.mjs --shifts
account=QODERCN_ACCOUNT_6C2D6327 region=cn uid=019ec9…
GET /algo/api/v2/model/list?Encode=1 → HTTP 200 / 55477 bytes
chat rows: 11
parsed models: 11   carrying a rule: 2
- qmodel_38max  active=false  22:00–08:00 Asia/Shanghai  badge[zh]="错峰 4 折"
- qmodel        active=false  22:00–08:00 Asia/Shanghai  badge[zh]="错峰4折"

== badges now (2026-10-21T08:46:22.617Z) ==
(none)
+6h (14:46Z): (none)
+12h (20:46Z): (none)
```

两条规则都被正确读出（时段、时区、中文文案），此刻 16:46（窗口外）**一枚都不画**——
与上游的 `active: false` 一致。把时钟推到 +6h（22:46，窗口内）也仍然不画：这正是 §3.2
那条取舍的可见结果——`active` 是快照里的过去时，插件不替上游把它翻转成 `true`。
窗口逻辑本身由单测锁住（`tests/promo.spec.ts` 用 `active: true` 的同一份规则在不同
时刻判定，见「判定在渲染时刻」那条）。

顺带确认：`quest-ultimate` / `experts-ultimate` 只出现在 `quest` / `experts` 分组里，
而插件目录只读 `chat`，所以国际区实际能画的是 `chat` 分组里的三条：`ultimate`、
`qmodel_38max`、`qmodel`（同上命令换成 `QODER_ACCOUNT_B2109944` 即可复核）。

## 6. 落地位置

| 位置 | 作用 |
| --- | --- |
| `src/promo.ts:148` `parseQoderPromotion` | 上游 snake_case → `QoderPromotion` |
| `src/promo.ts:181` `readPromotion` | 落盘形状 → `QoderPromotion`（读回不另写一套解析） |
| `src/promo.ts:277` `promoWithinWindow` | 按上游时区判时段（跨零点、起点含终点不含） |
| `src/promo.ts:296` `promoLiveAt` | 渲染时刻的「此刻画不画」 |
| `src/catalog.ts:85` `QoderModelInfo.promotion` | 目录条目带规则；`:198` 处解析 |
| `src/index.ts:188` | `lastCatalog` 持久化 schema（`z.any<QoderPromotion>()`） |
| `src/status-paths.ts:556`、`:585` | 投影给卡片的模型行类型 |
| `src/web-status.ts:379` | 投影时原样带出（对象展开，运行期无需改） |
| `src/client/promo-badge.ts:42`、`:59` | 选中文/英文文案、拼悬停 |
| `src/client/QoderCard.tsx:758` | 模型行渲染（名旁一枚胶囊） |
| `src/client/styles.ts:186` | `.dsm-qoder-model-promo` 胶囊样式 |
| `scripts/probe-promo.mjs` | 真机只读探针（解析 + 判定 + 时钟平移） |

## 7. 已知限制

- **`link_url` 不可点**：胶囊只是提示。卡片里放一个可点外链，会把「用户以为自己要
  去开通什么」变成一次误点，这一版不做。
- **没有颜色**：上游只给文案，所以配色是插件自选的品牌蓝（与倍率标签同一色系）。
- **`active` 是快照**：见 §3.2。目录放太久时可能漏掉窗口开头的那一段。
- **分组里看不到的活动**：`quest` / `experts` 分组的模型不进入插件目录，它们的徽标
  自然也不会出现。这是目录范围的既有事实，不是本功能的选择。
- **不 bump 版本、不改 `CHANGELOG.md`**：按 `RELEASING.md` §4，那是发版时维护者的动作。
