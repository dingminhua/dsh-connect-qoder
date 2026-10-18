# 任务：给 WorkBuddy 账号池加「手动指定优先级」排序

## 你在改什么

本仓库是 DSH 插件 `@dmh2002/dsh-connect-workbuddy`，账号池（account pool）当前**只能按积分策略自动排序**，用户无法干预。请加一个手动排序功能：用户能给池成员排先后，请求优先发给排在前面且可用的账号。

同源项目 `dsh-connect-qoder` 已经做过同一件事，并且**上线通过**。下面的方案就是那份实现，已按 WorkBuddy 的实际代码校准过。照着做，但每一步都要在你自己的仓库里核对行号与签名——不要盲抄路径。

## 先读这几个文件

- `src/account-pool.ts` — `rankPool`（约 409 行）与 `pickAccount`
- `src/web-status.ts` — `buildPoolView`（`rankPool` 调用在约 811 行）
- `src/index.ts` — `WorkBuddyPoolPreferences` 接口（约 357 行）、`poolConfig` schema（约 481 行）、三处 `rankPool` 调用（约 1495 / 1726 / 1751 行）
- `src/status-paths.ts` — `nextRegionPool`（约 357 行）
- `src/client/AccountPool.tsx` — 表格渲染（`pool.accounts.map` 在约 1119 行）、`renderAccountRow`（约 1229 行）、账号名单元格（约 1328 行）
- `src/client/account-selection.ts` — `writePoolPreferences`（约 420 行起）

## 设计决策（这些是**结论**，不要重新讨论，除非你发现硬矛盾）

### 1. 新配置键，不要复用 `memberAccountIds`

加 `orderAccountIds: string[]`。理由：`memberAccountIds` 回答「谁在池里」，`orderAccountIds` 回答「先用谁」。合成一个数组会让「取消勾选再勾回来」意外改变优先级，而配置里现有顺序只是勾选历史、不表达意图。

空数组 = 完全按积分策略（改动前的行为，**默认不变**）。

同时要动三处：

- `WorkBuddyPoolPreferences` 接口加 `orderAccountIds?: readonly string[]`
- `poolConfig` schema 加 `orderAccountIds: z.array(z.string()).default([])`
- `writePoolPreferences` 的参数类型与 slot 写入加上它

### 2. 排序层次：可用性 → 临期积分 → 用户顺序 → 金额 → 分数 → token 新鲜度 → id

`rankPool` 加第四个参数 `orderAccountIds?: readonly string[]`，在里面建位置查表（不在表里 = `Infinity`，即排到最后）：

```ts
const order = new Map<string, number>()
for (const [index, id] of (orderAccountIds ?? []).entries()) {
  if (!order.has(id)) order.set(id, index)
}
```

每行加 `_order: order.get(member.account.id) ?? Number.POSITIVE_INFINITY`。

`sort` 比较器里，把它插在**临期判定之后、到期时刻之前**：

```ts
if (left._usable !== right._usable) return left._usable ? -1 : 1
if (left._atRisk !== right._atRisk) return left._atRisk ? -1 : 1   // 这一行在用户顺序之前
if (left._order !== right._order) return left._order - right._order  // 新增
if (left._atRisk && right._atRisk && left._expiring !== right._expiring) { ... }
```

### 3. 临期积分压过用户顺序 —— 这是**刻意**的，不是 bug

`rankPool` 的注释里写了 issue #70 的来龙去脉（临期积分必须优先花，否则白烧）。用户一次误排若能导致当天要作废的分没花掉，代价远大于排序的便利。所以 `_atRisk` 保持压过 `_order`。

**必须写一个测试钉住它**，测试名建议：

```
expiring credits still outrank the manual order (issue #70 wins)
```

让这个决定对后来的人是可见的，而不是被当成 bug「修掉」。在 `rankPool` 的 doc comment 里也写明这一点。

### 4. 表格行序必须按 `orderIds` 渲染 —— 这是「即时」的前提

`src/client/AccountPool.tsx` 现在直接 `...pool.accounts.map(account => renderAccountRow(...))`，行序就是宿主下发顺序。**这一处不改，点上下移按钮后行不会动，必须等保存 + 宿主重算才生效**——用户会认为功能坏了。

加一个纯函数（放在 `AccountPool.tsx` 底部或同目录一个模块里）：

```ts
/**
 * 按 orderIds 重排账号行。
 *
 * 不在名单里的（非成员、或还没排过的）保持宿主给的相对顺序接在末尾：
 * 稳定排序保证同样输入永远得到同样行序，否则表格会在每次快照回流时无声抖动。
 */
function sortAccountsByOrder(
  accounts: readonly WorkBuddyWebPoolAccount[],
  orderIds: readonly string[],
): readonly WorkBuddyWebPoolAccount[] {
  if (orderIds.length === 0) return accounts
  const rank = new Map<string, number>()
  for (const [index, id] of orderIds.entries()) if (!rank.has(id)) rank.set(id, index)
  const fallback = orderIds.length
  return accounts
    .map((account, index) => ({ account, index, rank: rank.get(account.accountId) ?? fallback }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(entry => entry.account)
}
```

渲染处改成 `...sortAccountsByOrder(pool.accounts, orderIds).map(...)`。

### 5. 客户端算出「当前生效顺序」

在 `saved` 里加 `orderAccountIds: pool?.orderAccountIds ?? []`，在 `active` 之后算：

```ts
const orderIds: string[] = (() => {
  const members = active.memberAccountIds.filter(id => listedIds.has(id))
  const explicit = active.orderAccountIds.filter(id => members.includes(id))
  const rest = members.filter(id => !explicit.includes(id))
  return [...explicit, ...rest]
})()
const orderIsManual = active.orderAccountIds.some(id => active.memberAccountIds.includes(id))
```

未排过序的成员按池表原顺序接在尾部——与 `rankPool` 的「没排过 = 排到最后」是同一条约定，否则卡片上的名次会和实际选中顺序打架。

### 6. 名次徽章：没排过就说「自动排序」，**绝不伪造名次**

在账号名单元格（`renderAccountRow` 里 `h('b', null, name)` 之后）插入：

- `checked === false`（非成员）→ 不渲染徽章，非成员不参与排名
- `orderIsManual` → 实心品牌色徽章 `第 N 位`，`title` 说明「这个顺序是你手动排的」
- 否则 → 虚线灰框徽章 `自动排序`，`title` 说明「还没有手动排序：池会先花临期积分，再按余额多寡选号。用 ↑/↓ 自己指定顺序」

**这一条是不能省的安全条款**：如果对着一个由积分策略决定的顺序显示「第 1 位」「第 2 位」，用户会以为这是自己的选择，而它每次刷新都在变。比不显示更糟。

### 7. ↑/↓ 按钮

放在账号名单元格里、名次徽章旁边。**不要**放进 `.dsm-workbuddy-pool-row-actions`：那一列放的是「测试 / 删除」，语义不同，而且既有测试按索引取那一列的按钮，插进去会破坏它们。

可见条件：`pool.enabled === true && checked && canEdit`。

池关着时不给——没有「先发谁」这回事，给按钮等于给一个不起作用的控件。

首尾各自**禁用**而不是隐藏：隐藏会让按钮在行与行之间跳位，点起来要看两次。

移动函数：

```ts
const moveMember = (accountId: string, delta: -1 | 1) => {
  const members = orderIds.filter(id => active.memberAccountIds.includes(id))
  const from = members.indexOf(accountId)
  const to = from + delta
  if (from < 0 || to < 0 || to >= members.length) return
  const next = members.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  editDraft(prev => ({ ...prev, orderAccountIds: next }))
}
```

**第一次点 ↑/↓ 就把当前可见顺序整个落下来**，从此由用户决定。这正是「用户开始手动排序」的那个点。

### 8. 保存校验必须**逐位**比对

`writePoolPreferences` 现在的成员校验是**按集合**比（源码注释明确写了「the stored order is not meaningful」，这个判断我理解，它对成员资格仍然成立）。但 `orderAccountIds` 是**顺序敏感的**：只比集合会把「拖了但没生效」当成保存成功，而成功会丢弃草稿，用户看到的就是「我排了，但没保存」。

```ts
const storedOrder = pool['orderAccountIds']
if (!Array.isArray(storedOrder) || storedOrder.length !== orderAccountIds.length) return false
return storedOrder.every((id, index) => id === orderAccountIds[index])
```

注意 `orderAccountIds` 缺省时要写 `[]` 而不是 `undefined`，因为要参与逐位比对。

### 9. 宿主下发时清洗残渣

`buildPoolView` 里透传 `orderAccountIds` 前，只保留**当前确实存在的账号 id**：

```ts
...(orderedIds.length === 0 ? {} : { orderAccountIds: orderedIds }),
```

配置里的 `orderAccountIds` 在删除账号后不会自动收缩（与 `memberAccountIds` 同一个残渣问题），原样透传会让卡片把名次算在一个已经不存在的行上。

`QoderPoolDeps` 的对应物——WorkBuddy 是 `web-status.ts` 里 `pool.preferences` 的类型——要加 `orderAccountIds?: readonly string[]`。`WorkBuddyWebPool` 类型定义在 `status-paths.ts`（约 983 行 `memberAccountIds` 附近），也在那里加。

### 10. 传递到所有 `rankPool` 调用点

`src/index.ts` 有三处 `rankPool(...)`（约 1495 / 1726 / 1751 行），`src/web-status.ts` 一处（约 811 行）。**全部**要传 `prefs.orderAccountIds`，否则排序只在一半路径生效——这是最容易漏的地方。

同时检查 `updateMembership` 之类重建 preferences 对象的地方：WorkBuddy 里如果有 `{ ...poolPreferencesOf(...), memberAccountIds }` 这种写法要注意，展开能保住新字段；如果是**手写字段列表**的，必须补上 `orderAccountIds`，否则保存成员会清掉排序。

## 必写的测试

`tests/` 下已有 `account-pool.spec.ts` 与渲染测试，沿用现有的 `member(...)` 等 helper。

**`rankPool` 层**（每条都要有）：

1. 不传 order → 回落积分策略（防回归）
2. 传 order → 压过积分策略（余额最少的号排第一也能赢）
3. 不在 order 里的成员排到所有显式排过的之后
4. 出池账号不能被排到可用账号前面
5. **临期积分仍压过手动顺序**（issue #70 那条）
6. order 里有不存在的 id → 忽略，真实成员不被挤下去
7. order 里重复 id → 首次出现的位置生效，名次不漂移
8. order 里也有分数/余额都相等的两个号 → 结果稳定（不随输入数组顺序变化）

**渲染层**：

1. 没排过 → 只出现 `自动排序` 徽章，一个「第 N 位」都不能有
2. 保存过顺序 → 行序按 orderIds 排（与余额相反才说明生效），徽章显示 `第 1 位` / `第 2 位`
3. 首尾按钮各自禁用、按钮数量恒定为 2
4. 池关闭时不渲染移动按钮
5. 点 ↓ → 行当场对调，徽章从「自动排序」变成名次

## 验收标准

在仓库根目录跑：

```
npx tsc -p tsconfig.json && npx tsc -p tsconfig.client.json && npx vitest run && npx tsdown
```

四项全绿，且**已有测试一个都不能改坏**。如果为了新功能必须改既有测试，在回复里逐条说明为什么那是正当的，不要静默修改断言。

## 交付时告诉我

1. 实际改了哪些文件（列路径）
2. 新增测试的名单
3. `rankPool` 最终的比较器顺序（贴代码）
4. 有没有遇到我上面没预见的硬矛盾，以及你怎么处理的

## 一条提醒

先跑一遍 `npx vitest run` 建立基线，记下改动前有多少个测试通过。WorkBuddy 的渲染测试用 `h()` 而非 JSX，按索引取 DOM 节点的断言不少——插入新元素后若测试失败，优先怀疑是索引位移，而不是功能错了，**但要先确认那个断言测的到底是什么**，不要盲目改数字。
