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
2. **有窗口就看窗口，没有窗口才看 `active`。** 有 `window_start/end` 时，画不画只由
   「此刻在不在窗口内」决定（渲染时刻现算）；没声明窗口时才退回上游的 `active`。
   为什么不是「两者都成立」（理由见 §3.1）。
3. **没有窗口声明时只信 `active`。** 上游哪天给了个不带时段的常驻活动，这条路径直接可用。
4. **时段按上游声明的时区算**（`timezone`），不是浏览器时区：`22:00–08:00` 说的是那条
   记录的时区里的 22:00。起点含、终点不含；跨零点命中 `[22:00, 24:00) ∪ [0, 08:00)`；
   终点允许写 `24:00`（= 当天结束）；`start === end` 视为全天；**声明了窗口但读不懂**
   （越界、只给一端、`HH:MM` 以外的写法）一律不画——不当作全天，也不退回去信 `active`。
5. **一个模型只画一枚徽标**，落在模型名**旁边**而不是名字里面——名字是省略号截断的，
   放进去会被一起裁掉。与倍率、free 标记、测试结论并列，顺序是「倍率 → 徽标」。
6. **文案、悬停都只说上游的话。** 胶囊文字取 `badge.zh`（中文界面）/ `badge.en`；
   悬停取 `description`，再补上「时段 + 时区」与 `link_url` 原文。插件不翻译、不改写、
   不从 `discount_factor` 反推「4 折」这类数字（那三个数字字段因此在解析时就被丢掉，
   不随目录落盘）。

### 3.1 为什么「有窗口时窗口说了算」

`active` 是上游**在取目录那一刻**算出来的，而目录是 DSH 进程启动时取的一份内存快照，
之后只有点「刷新模型」才会换。把它当成必过的门，会有一个方向永远错：

- **窗口开了而进程没重启**：早上启动的进程拿着 07:00 的 `active: true`，到 22:00 窗口
  重新开启时它仍是同一份快照——徽标该出现却不会出现，对一个整天开着 DSH 的用户，这个
  功能等于不存在。
- **窗口关了而 `active` 还是 true**（昨夜取的快照）：这方向窗口能纠正。

窗口不是插件的猜测，它是**上游自己声明的时段**（`window_start/end` + `timezone`），
按那一刻的时钟重算，不会因为快照旧而说错话。所以：有窗口时它是唯一依据，`active`
只在没有窗口可算时兜底。

代价写在 §7：上游若**提前结束**一个活动，插件在窗口内仍会画到下次刷新为止。这比反过来
（活动开着却整天不显示）轻，而且用户可以点「刷新模型」立刻纠正。

### 3.2 为什么判定必须在渲染时刻

`promotion` 会随 `lastCatalog` 一起落盘。**若在解析时就挑定「画 / 不画」，夜里读到的
目录会把它冻结到第二天早上**：23:00 拉到的快照判定为「在窗口内」，到早上 9:00 还挂着
这枚过期的「错峰 4 折」。

所以解析层只保留**规则**（`QoderPromotion`，不带任何「已判定」的痕迹），卡片每次渲染
拿 `new Date()` 现算（`promoLiveAt`）。这与 workbuddy（`selectPromoBadge`）、Trae
（`selectTraePromoBadge`）三处是同一个取舍。

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

== badges now (2026-10-21T09:23:24.783Z) ==
(none)
+6h  (15:23Z = 23:23 Asia/Shanghai): qmodel_38max「错峰 4 折」, qmodel「错峰4折」
+12h (21:23Z = 05:23 次日):          qmodel_38max「错峰 4 折」, qmodel「错峰4折」
+24h (09:23Z = 17:23 次日):          (none)
+36h (21:23Z = 05:23 第三天):         qmodel_38max「错峰 4 折」, qmodel「错峰4折」
```

两条规则都被正确读出（时段、时区、中文文案）。此刻 17:23（窗口外）**一枚都不画**，
把时钟推进窗口（+6h = 23:23）两枚都出现，推回白天（+24h）又消失——**同一份解析结果**，
结论只随「现在几点」变，这正是 §3.2 要的。注意 `active` 一直是 `false`：它停在取目录
那一刻，插件不拿它去否决窗口（§3.1），窗口逻辑由 `tests/promo.spec.ts` 用固定时刻锁住。

顺带确认：`quest-ultimate` / `experts-ultimate` 只出现在 `quest` / `experts` 分组里，
而插件目录只读 `chat`，所以国际区实际能画的是 `chat` 分组里的三条：`ultimate`、
`qmodel_38max`、`qmodel`（同上命令换成 `QODER_ACCOUNT_B2109944` 即可复核）。

## 6. 落地位置

| 位置 | 作用 |
| --- | --- |
| `src/promo.ts` `parseQoderPromotion` | 上游 snake_case → `QoderPromotion` |
| `src/promo.ts` `readPromotion` | 落盘形状 → `QoderPromotion`（读回不另写一套解析） |
| `src/promo.ts` `clockMinute` / `parsePromoWindow` | `HH:MM` → 分钟数（终点接受 `24:00`） |
| `src/promo.ts` `promoWithinWindow` | 按上游时区判时段（跨零点、起点含终点不含） |
| `src/promo.ts` `promoLiveAt` | 渲染时刻的「此刻画不画」 |
| `src/catalog.ts` `QoderModelInfo.promotion` | 目录条目带规则（`parseUpstreamModel` 里解析） |
| `src/index.ts` `modelConfig.promotion` | `lastCatalog` 持久化 schema（`z.any<QoderPromotion>()`） |
| `src/status-paths.ts` `QoderWebModel` / `QoderPersistedModel` | 投影给卡片的模型行类型 |
| `src/web-status.ts` `webModelOf` | 投影时原样带出（对象展开，运行期无需改） |
| `src/client/promo-badge.ts` `hostLanguage` / `promoBadgeLabel` / `promoBadgeTooltip` | 选中文/英文文案、拼悬停 |
| `src/client/QoderCard.tsx` `renderModels` | 模型行渲染（名旁一枚胶囊） |
| `src/client/styles.ts` `.dsm-qoder-model-promo` | 胶囊样式 |
| `scripts/probe-promo.mjs` | 真机只读探针（解析 + 判定 + 时钟平移） |

## 7. 已知限制

- **`link_url` 不可点**：胶囊只是提示。卡片里放一个可点外链，会把「用户以为自己要
  去开通什么」变成一次误点，这一版不做。
- **没有颜色**：上游只给文案，所以配色是插件自选的品牌蓝（与倍率标签同一色系）。
- **上游提前结束活动时，徽标会多挂一会儿**：见 §3.1。有窗口时窗口说了算，所以活动被
  临时取消 / 提前收尾时，插件要等到下次刷新目录（点「刷新模型」或重启）才知道。反向
  的错（活动开着却整天不显示）更糟，所以选这一边。
- **不判断账号资格**：`active` 里可能混着「你的账号不符合资格」这一层意思，但走窗口
  分支后插件看不到它。若上游将来只给「符合资格才 active」的常驻活动（没有窗口），那条
  路径仍然读 `active`，是对的。
- **分组里看不到的活动**：`quest` / `experts` 分组的模型不进入插件目录，它们的徽标
  自然也不会出现。这是目录范围的既有事实，不是本功能的选择。
- **到点变化最多慢一拍**：卡片靠 60 秒轮询（`POLL_INTERVAL_MS`）触发重渲染，判定也在
  那次渲染里重算，所以 22:00 开启、08:00 结束最迟各差一分钟。不另加定时器：为一个
  提示性胶囊多挂一个每秒的计时器不值得。
- **不 bump 版本、不改 `CHANGELOG.md`**：按 `RELEASING.md` §4，那是发版时维护者的动作。
