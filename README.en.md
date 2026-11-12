<p align="center">
  <img src="docs/assets/dsh-connect-qoder-usage-card.png" width="640" alt="dsh-connect-qoder settings page: CN / Global tabs with the account pool, credits, daily check-in and automatic failover" />
</p>

<h1 align="center">dsh-connect-qoder</h1>

<p align="center"><b>Connect Qoder (Lingma CN / international) models to DeepSeek Harness, with an account pool, daily check-in, credit readouts and model management.</b></p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#account-pool">Account pool</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/dingminhua/dsh-connect-qoder/issues">Issues</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/%40dmh2002%2Fdsh-connect-qoder"><img src="https://img.shields.io/npm/v/%40dmh2002%2Fdsh-connect-qoder?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/%40dmh2002%2Fdsh-connect-qoder"><img src="https://img.shields.io/npm/d18m/%40dmh2002%2Fdsh-connect-qoder?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/dingminhua/dsh-connect-qoder/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dingminhua/dsh-connect-qoder/ci.yml?branch=main&style=flat-square&label=tests" alt="test status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/dingminhua/dsh-connect-qoder?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/dingminhua/dsh-connect-qoder/stargazers"><img src="https://img.shields.io/github/stars/dingminhua/dsh-connect-qoder?style=flat-square" alt="GitHub stars"></a>
</p>

A standalone [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) bundle plugin. It connects your Qoder account's models to the DSH model picker, with an account pool, daily check-in, credit readouts and model management. **The CN and international editions are two parallel providers (`qoder` / `qoder-global`) that can be used at the same time**; the plugin's settings page separates them with tabs.

> Qoder does not expose an OpenAI-compatible endpoint (its official SDK is only an agent launcher), so this plugin talks to Qoder's cosy gateway directly, implementing a minimal client for the protocol. No Qoder desktop sign-in is needed — just a PAT (Personal Access Token).

## Features

- **Two parallel providers (CN + international)** — the CN edition registers as the `qoder` provider (`gateway.qoder.com.cn`); the international edition registers as `qoder-global` (`api1.qoder.sh`). **Regions with a PAT configured show their models in the DSH model picker**: with a PAT for both regions you get two groups that can be used simultaneously and independently per session. **A region without a PAT lists no models** (no request could succeed, so listing them would only invite failures); configure a PAT and hit "Refresh models" to make them appear — the provider itself stays registered; the configuration entry point is **Settings → Qoder**. Model names embed the upstream credit multiplier (e.g. `Qwen3.8-Flash · x0.00`), matching Qoder's own model menu.

  <img src="docs/assets/dsh-connect-qoder-model-picker.png" width="360" alt="The DSH model picker with the Qoder and Qoder Global groups; each model name carries its credit multiplier" />
- **Settings card tabs** — the card top has "CN / Global" tabs, each with its own PAT, account pool, model management and credits; catalogs, selections and state stay fully isolated per tab.
- **Accounts / Models / Diagnostics sections** — under each region tab the body is split into three sections. *Accounts* holds the pool, the credit-readout switches and every notice about the credential (each lands on the click); *Models* holds the checkboxes, context tiers, reasoning strengths and per-model tests (a draft until you press Save) — the two commit differently, so splitting them puts the save button next to what it saves. **Switching sections never refetches and never drops an unsaved draft** (inactive sections stay mounted). *Diagnostics* is a read-only fact table: region, **upstream domain** (the same single fact the real requests use), serving account, credential source, when credits were read, catalog size, enabled count, pool switch, and upstream's own last error **verbatim** — it exists to be quoted into a bug report, so it deliberately holds no control that could change a setting.
- **Per-region kill switch** — each tab has a checkbox on the right (both checked by default). **Unchecking removes that provider from the DSH model picker entirely** (not just hiding the tab): both its adapter route and its "Settings → Models" directory entry are removed. PAT, credits, and selections are **all kept**; re-checking restores everything. Note: a session that had already selected a model of the disabled provider will get `NO_ADAPTER` on its next call.
- **Model management** — refresh the full model catalog from upstream and toggle each model on or off; each row shows the multiplier (`(0.50x)`), context/output limits, thinking-effort tiers and a free marker, plus "Image" and "Off-able thinking" switches, a context-tier selector and a "Test" button on the right. Selections are written to local config and sync to the model picker immediately. **The list is as tall as the catalog — it caps no height and grows no inner scrollbar**: its whole job is "let me see every model and tick it", so showing seven rows of twenty and hiding the rest behind a second scrollbar (the panel already scrolls) would turn "does this model exist?" into something you must first discover, then drag. **Upstream's `auto` is not listed**: it is the region's default *router*, resolved by the gateway into some model at request time, so its price and context window are decided by someone else — it is not a model, and does not deserve a row you can tick. Also absent: `Fast` / `Ultimate` / `Efficient` — a bare adjective, so you cannot tell which vendor's model sits behind it. `Sonus` (`smodel`, x8) and `Cantus` (`cmodel`, x4) *are* listed: they are product names, upstream marks them `is_new`, and they are the two most expensive rows in the catalog (issue #37). One rule points the other way: the two global-only rows (`Sonus` / `Cantus`) are never offered on the CN side — upstream there does not serve them at all, so picking one can only fail.

  <img src="docs/assets/dsh-connect-qoder-model-management.png" width="640" alt="The model management area: per-model multiplier, max context/output, thinking-effort tiers, and the image / off-able-thinking / context-tier controls with a test button" />
- **Promotion badge** — upstream ships the promotion rule inside the model catalog itself (`promotion`: label, window, time zone), so each row paints a small capsule next to the model name, e.g. `Off-Peak 60% off`. **The label is upstream's own text** (Chinese UI reads `badge.zh`, English UI `badge.en`); the plugin neither translates nor rewrites it. Hover shows upstream's description, the window and time zone, and the campaign link as plain text. Whether it paints is decided **at render time**: when upstream declares a wall-clock window (midnight-crossing supported, evaluated in upstream's own time zone) that window alone decides, and only a rule without a window falls back to upstream's `active` flag — so a catalog fetched at night cannot freeze the badge until the next morning, and a process started in the morning still shows it that night; models without a promotion field paint nothing. The same badge also appears in the host's **model picker** — that is where the choice actually gets made — sharing one evaluation and one copy with the card. The picker path travels as **catalog data**: the adapter attaches `LlmModelInfo.badge` (host 0.2.2+, shaped `{ text, tone }`) to each model in `listModels()`, and the host paints it next to the name itself. That path is independent of which plugin wins the model-label slot, which is why sibling connectors' chips coexist; the copy is capped at **16 graphemes** (what the reader counts, not `length`), and a longer label is **dropped entirely** rather than truncated — half of upstream's sentence reads as a complete claim. With no promotion the field is `undefined`, never `null` (a `null` badge makes the whole provider vanish from the catalog). **Another provider's rows** likewise reproduce that model's own `badge`: ahead of the name on the trigger (the current selection), after it on menu rows, matching the host fallback's order. Evidence and rules: [docs/PROMO_BADGE.md](docs/PROMO_BADGE.md) and the sibling `docs/MODEL-LABEL-SPEC.md`.

  <img src="docs/assets/dsh-connect-qoder-promo-badge.png" width="640" alt="The model management area: the Qwen3.8-Max and Qwen3.7-Plus rows each carry a blue capsule after the multiplier and outside the model name, labelled with upstream's own text — 错峰 4 折 and 错峰4折" />
- **Configurable auto-refresh interval (Capabilities tab)** — the settings page and the composer credit readout both re-read usage from upstream on a timer. That rhythm is one **global** setting (`pollMinutes`, a dropdown in the Capabilities tab): five choices — **1 / 5 / 10 / 30 / 60 minutes**, default **5** — shared by both regions and both surfaces (they ask the same route, and near-simultaneous reads are coalesced into one upstream call). It takes effect immediately: no Save, no page reload. Pick 1 minute for fresher numbers, 30 / 60 to call upstream less often.
- **Per-model availability probe** — every model row has a "Test" button that goes straight to upstream: rate-limited (429) → "Rate limited", invalid credential → "Invalid credential", content-policy rejection → "Blocked by content policy", quota exhausted → "Quota exhausted", and other upstream transient failures are classified honestly. Probes run in the background, **credentials never reach the page**; results are not written into settings and do not change your saved selections. **Probes are real requests** (they consume a small amount of upstream credit), so they are per-model and manual only — there is no batch "test all checked" button.
- **Daily check-in** — Qoder runs an official daily check-in campaign (individual users claim 100 credits a day, valid for 30 days). The account pool has a "Check in all accounts" action: it claims per account, treats an already-claimed day as idempotent success (no double claim, not a failure), and refreshes credits afterwards. Both regions are wired up (the international edition needs the device-risk identity that the local Qoder client ships; when it cannot be obtained the plugin reports that honestly instead of pretending "no campaign today").
- **Automatic daily check-in (opt-in, off by default)** — the mode bar carries a "Check in automatically each day" switch (`regions.<region>.pool.autoCheckin`). Ticked, the plugin presses that button for you in the background: once a day, only for the accounts checked into the pool. The rule is character-for-character the one the button uses — **it reads the campaign status first, and an account already claimed today is reported without a claim request** — so a restart, a retry or a duplicated timer cannot claim twice. It rolls over on the window moment the upstream itself states (the campaign row's `endAt`), which is the official 10:00 (UTC+8) boundary rather than local midnight; a failure backs off 30s → 1 → 2 → 5 → 15 minutes and then retries every 30 minutes until that window closes. The line beside the switch reports today's progress ("Today: {done} of {total} checked in", "{count} still to retry", "Last attempt failed: …"), so a background action is never invisible. **Off by default**: claiming collects a real reward, and that decision belongs to the user.
- **Campaigns (read-only, switchable)** — the card shows a grid of **campaign tiles** inside the region scope, below the credit readout, with every campaign the upstream currently serves: the daily 100-Credits check-in row (with its amount and a Claimable / Claimed state) plus the `VIEW_DETAILS` banners such as "1024 | Creativity Rally" or "double first-month subscription credits". **Titles and descriptions come verbatim from the upstream** (the interface language picks `zh` / `en`, falling back to the other side); "View details" is a real link (the upstream `detailUrl`, falling back to the campaign landing page). Tiles flow into two columns by themselves (`auto-fill` with a 260px floor), the description is clamped to two lines (the full text is in the tooltip), and the state and "View details" sit on a shared baseline — so a handful of campaigns sit side by side instead of each taking a row (~180px for three in the 612px content column). **Each region can switch the block off** ("Show campaigns" on the settings page, on by default, `regions.<region>.showCampaigns`; with it off the page starts straight at the tabs and the `/campaigns` request is not made). It is **read-only** — no check-in, no account writes. When the upstream sends nothing it shows "no active campaigns", and when the read fails it states the reason instead of pretending there are none. Earlier versions only read the small slice of campaigns used for check-in and skipped the banner rows entirely (user report 2026-10-25); the whole feed is now read.
- **Credits (read-only)** — the pool table shows each account's remaining credits, **when those credits lapse** and **when the plan ends** (from Qoder's `sash/api/v2/me/usage`, queried with the `jt-` jobToken); credits expiring within three days are highlighted. The query is **read-only** and costs no credits; when it fails (credential rejected / upstream silent) the card says why and offers a way out instead of showing a blank.
  - **Two expiries, two different things** (issue #31): `qoderUsage.expiresAt` is the **account-level plan / 14-day trial** expiry (measured: it equals a `userId` prefix + 14 days), not the expiry of any credit package. It is now exposed as its own field `planExpiresAtMs` and shown separately as "Plan ends {at}"; it takes no part in the "expiring credits" highlight, and takes no part in pool ranking.
  - **Credit expiry comes from check-in batches**: the upstream only ever states `validity.days` (30 days) on the check-in campaign, so the plugin records `claimAtMs` and the amount the moment it claims, persists them (`credits` key of `$DSH_HOME/.qoder-pool.<region>.json`), books them FIFO and **displays the pessimistic bound** (the earliest batch that has not lapsed). The upstream never tells us which batch was spent, and reporting late is the same as not warning at all — so it errs early by a few days. When `claimAtMs` is absent (old records / only ever saw "already claimed") it is **not displayed** — never wrong beats always shown. The wording says "earliest claimed batch expires around {at}", never pretending to be an upstream fact.
- **Secure loopback shim** — one random port + in-process random secret per region, so the real Qoder PAT **never reaches pi-ai**: pi-ai only talks to the local shim, which performs upstream requests with cosy sessions (jobTokens).
- **Multi-account pool (PAT)** — a per-region local vault `$DSH_HOME/.qoder-accounts.<region>.json` (0600) merges the settings PAT, environment variable, and vault accounts into one de-duplicated list; the card can add (paste a `pt-…`, validated via a `JobToken` exchange that returns the display name; you may also set your own label), rename accounts, and can pin a specific account to serve (`regions.<region>.accountId`, empty = automatic by settings → env → vault). **Taking an account out of rotation and deleting it are different actions**: untick it in the pool table and save (the PAT stays put, and you can tick it back at any time), or press the row's **Delete** button — a second confirmation erases the stored PAT for good and drops the account from the pool and the region selection. A PAT coming from the app's settings or the environment is not the plugin's to delete, so those rows get no delete button.
- **Probe-ranked selection and automatic failover** — "Test all accounts" sends a real request per pool member (the target model defaults to an automatically picked multiplier-0 free model in that region) and persists results to `$DSH_HOME/.qoder-pool.<region>.json`; with the pool enabled, the chat stream picks the top-ranked usable account before the first byte (`rankPool`: usability → expiring credits first → soonest credit expiry → highest credits → id) and retries the next usable accounts on failure, writing failures back as `live-request` probes. With the switch off, the plugin neither picks nor swaps for you — it just reports the error. **An upstream-asserted quota exhaustion is always surfaced**: the moment a business code in the quota family (110 daily count / 113 quota / 118 credits spent, …) comes back on the chat path, the region's card shows an "upstream reported quota exhausted" notice (last-seen time + business code; the hover carries the redacted upstream text) — independent of the pool switch, because per-account `out-of-credit` detail only lives in the pool view, and with the pool off this notice is the **only** place that failure ever shows (the gap left when the 0.7.x "daily quota suspected exhausted" pill was removed). Rate limiting (a short-window HTTP 429) is **never** marked as exhaustion — that is a cooldown, not an empty tank.
- **Account transfer (import / export)** — export a region's vault accounts to a transfer file, preview it, and import by index; cross-region domains (`qoder.com.cn` / `qoder.sh`) are positively matched and non-matching records are counted as `skipped`.
- **Thinking effort and context budgets** — upstream declares `thinking_config.efforts` per model, and the card lists **only the tiers that really exist** (Qwen-family `low/medium/xhigh`, DeepSeek/GLM-family `low/high/max`); your choice is saved and sent with every request using the same fields the Qoder client uses (dual-written at the top level and in `parameters`). Context tiers likewise come only from the model's declared `context_config`; nothing is invented when a model declares none. **Upstream's declared default is the default**: the DSH model picker lands on that tier directly (Qwen3.8-Max's `medium`) instead of showing "Default" — which is exactly the answer the card's own "medium (upstream default)" label names. A tier you pick for a model in the card becomes that model's default.
- **Honest model capabilities** — upstream's `is_vl` is a **platform**-level image claim, not a per-model capability, and it reads `true` for almost every model, so the plugin **never uses it as the answer**. Image input is pre-checked only from a table keyed by exact model id; anything unverified (including brand-new models) stays unchecked, and the switch tooltip explains why. The table is backed by **vendor docs plus on-device measurement**: on 2026-10-29 every one of the 14 models across both regions' catalogs was sent an image of the digit `7` and asked which digit it was — **all of them read it**, so the current catalog contains no text-only model (the earlier by-name assumption that "code" models must be text-only was falsified). "Off-able thinking" is offered only where upstream explicitly declares it and the model is not in the known-rejection set. Fewer options beats an option that fails when pressed.
- **Cache hits reported truthfully** — upstream's `usage` carries `prompt_tokens_details.cached_tokens`, and the plugin passes it all the way through to the host, so the GUI's per-round "cache hit" figure is a real ratio. (Before the fix it read 0% forever: the field was dropped on the normalization path, and that 0% was an untrustworthy reading rather than evidence that caching did nothing.) **The hit count is a subset of `prompt_tokens`, not an addition** — so it is never folded into the totals (that would count the cached prefix twice). When upstream does not report the field it is omitted, never replaced with 0.
- **Composer credits readout (position is a choice)** — the session input shows `QD CN` / `QD AI` with the serving account's balance (e.g. `QD CN · 92`); clicking it opens a per-account balance table where a row click switches accounts (when the global side has exclusive credit packages, the table grows a SOTA column **left of** Credits: those are a separate pool, spent first only when you pick the model they are tied to, so they are **not** added to the credits figure; accounts without a package show “—”, and the whole column — header included — disappears when no package exists) and the header's Settings button opens this plugin's settings page (through the settings shell's own state handle, so the panel lands on this plugin's section in one call; a host without that seat falls back to clicking the sidebar trigger and then the nav row, and only then to the plugin-market page). Gated by the per-region "show credits in the composer" switch (default on, opt-out). **The readout can sit in either of two places** (a per-region dropdown in the card, default unchanged): **the composer toolbar** (`conversation.input.right`, immediately left of the model picker) or **below the composer** (`conversation.composer.dock`, the ambient row where the shell renders its own round / tok-per-sec / token / cache-hit stats). The reason it is a choice: the composer toolbar is a **shared list slot**, so another plugin parking something there can crowd the readout out of sight — switch to "below the composer" if that happens (mirrors workbuddy issue #62). 

  <img src="docs/assets/dsh-connect-qoder-composer-credits.png" width="360" alt="The composer credit panel: per-account QD CN balances, a Settings button and the last refresh time" />
- **CLI diagnostics** — `dsh-connect-qoder doctor|status|logout [--json] [--region cn|global]`: `doctor` reports PAT source, cosy fingerprint derivation, pi-ai generation, host heartbeat liveness, and vault account counts; `status` reports credential source, upstream reachability, and remaining credits; `logout` clears a region's vault accounts and pool measurements. No browser needed.

## How it works

```text
DSH PiAiAdapter (one set per provider)
  -> secure loopback shim (random port + in-process secret per region)
  -> QoderUpstreamClient (minimal cosy-protocol client)
  -> CN      https://gateway.qoder.com.cn/algo/api/v2/...
  -> Global  https://api1.qoder.sh/algo/api/v2/...
  -> Qoder SSE (OpenAI-shaped deltas)
  -> DSH executes local tools and returns results
```

The CN and international editions each own a full runtime stack — upstream client, model catalog, loopback shim, adapter — isolated by region configuration (gateway / openapi / catalog paths), so **models from both regions can be available at the same time and used by different sessions**.

Credentials are PATs (settings page `regions.<region>.pat`, or environment variables — see [Configuration](#configuration)); the settings value wins. Sessions lazily exchange a **jobToken** on demand: the PAT is used once in that exchange, and every subsequent request carries a cosy bearer (custom Base64 payload + MD5 signature) plus "machine fingerprint" session headers. **The PAT never reaches pi-ai and never leaves the process except in that one local exchange; this plugin neither reads nor writes Qoder desktop sign-in files.**

Encoding and signing details (custom alphabet, `n/3` rearrangement, `cosy&<SECRET>&<date>` signature, RSA/AES session wrapping) are documented at the top of `src/cosy.ts`; the error taxonomy (content policy / rate limit / quota exhausted / transient) and how it maps onto DSH retry semantics live in `src/upstream.ts`.

## Installation

### From a published package (recommended)

```bash
dsh plugin --profile desktop add @dmh2002/dsh-connect-qoder   # Desktop
dsh plugin --profile web add @dmh2002/dsh-connect-qoder       # Web
```

Then **restart that profile's DSH process** (the host half of a bundle loads at startup). You can also search for `dsh-connect-qoder` in DSH's "Plugin market / Bundles" and install it in one click.

> **Does `dsh` fail with `Cannot find module .../DSH NEXT.app/...`?** That is a stale shim left over from the host's app rename: the app directory moved from `DSH NEXT.app` to `DeepSeek Harness.app`, and `~/.local/bin/dsh` still points at the removed path. Repoint the shim at the CLI entry the new host ships:
>
> ```bash
> exec "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" "$@"
> ```
>
> That entry runs `dsh/lib/bin.js` inside `app.asar` via `ELECTRON_RUN_AS_NODE`; the profile is still chosen with `--profile`.

> The npm package name carries the `@dmh2002/` scope. The plugin's **configuration identity inside DSH does not** — the settings namespace, the `/plugins/dsh-connect-qoder/…` routes and the CLI program name all stay `dsh-connect-qoder`, so anyone upgrading from 0.2.0 keeps their saved configuration with no need to re-enter PATs. The settings page's addressing no longer depends on the package name either: it is a `settings.section` keyed by the **unscoped** entry id. But the **browser bundle's module id**, the model-picker label and the package name the Settings button falls back to when jumping into the plugin market are still keyed by the scoped package name; these are injected from `package.json` at build time, so a rename cannot leave them behind.

### From source (development)

```bash
git clone https://github.com/dingminhua/dsh-connect-qoder.git
cd dsh-connect-qoder
pnpm install
pnpm run check        # typecheck + test + build must all pass first
```

Install the repository directory with `link:` so edits take effect after a DSH restart (without reinstalling the dependency tree):

```bash
dsh plugin --profile desktop add ~/DshProject/dsh-connect-qoder
```

### Verify the installation

- Open Settings (the gear in the sidebar, or `Cmd/Ctrl + ,`) → the **Qoder** row at the bottom of the left nav → the configuration page appears with its CN / Global tabs.
- `pnpm exec dsh-connect-qoder doctor`, run inside that profile directory, should print both regions' PAT status and fingerprint derivation.
- After configuring a PAT, "Refresh from Qoder" should fetch the region's real catalog; the model picker shows `Qoder` / `Qoder Global` groups.

## Configuration

### PAT (Personal Access Token)

Create a PAT (`pt-…`) in your Qoder account settings. Two ways to provide it — **the settings page wins over the environment variable**:

| Region | Where to issue it | Setting | Environment variable |
| --- | --- | --- | --- |
| CN (qoder.com.cn) | Console → Settings → API Tokens | Card "CN" tab → Add PAT | `QODERCN_PERSONAL_ACCESS_TOKEN` |
| Global (qoder.sh) | Console → Settings → Personal Access Tokens | Card "Global" tab → Add PAT | `QODER_PERSONAL_ACCESS_TOKEN` |

- The PAT is stored only in the local plugin configuration (`regions.<region>.pat`); it is never uploaded and never enters any network request.
- A region without a PAT lists no models; the `doctor` command points out which region is missing one.
- **Step-by-step walkthrough in [`docs/PAT.md`](docs/PAT.md)** (issuing, verification, precedence, troubleshooting).

### Region enable/disable

The checkbox on each tab controls whether that region participates in the model picker (opt-out: **only an explicit uncheck disables it**). Disabling only removes the route and the directory entries; configuration is kept.

### Sidebar panel (optional, off by default)

The card's Accounts section carries a row, "Show Qoder in the sidebar": tick it and DSH's sidebar gains a Qoder icon row that opens **this same card as a full page** (the same account pool, model catalog and diagnostics, filling the centre column), with a "Back to conversation" button in its header.

- **Off by default, and an explicit opt-in.** That row claims `sidebar.panellist` — the **global sidebar seat every installed plugin shares** — and opening it takes over the centre panel, so turning it on is a decision about your whole sidebar rather than a preference about this page. Settings → Qoder already reaches the same content, so anyone who never ticked it sees **no change at all after upgrading**.
- **It takes effect on the click — no save needed.** Switching it off while the page is open returns the centre column to the conversation by itself (the host drops a `main` selection whose key no longer exists).
- Stored as the top-level `sidebarPanel` setting (**no region axis**: one row, one page, unrelated to CN / global). It therefore still opens when a region is signed out — or when both are switched off — since the panel is one of the places you go to add a first PAT.
- The test is `=== true`: absent, `false`, and a hand-edited string `"true"` all read as off.

### Multi-account pool and credential sources

Besides the settings PAT and the environment variable, each region has a local vault (`$DSH_HOME/.qoder-accounts.<region>.json`, mode 0600) that stores multiple PAT accounts. The three sources are merged de-duplicated by **settings → env → vault** (a PAT appearing in two sources is listed once, under the higher-priority source).

- The card can add (paste a `pt-…`, validated via a `JobToken` exchange that returns the display name; you may also set your own label) and rename vault accounts, and can pin a specific account to serve (`regions.<region>.accountId`, empty = automatic). Deleting a vault account is the pool table's per-row **Delete** button (which asks once before it acts); unticking and saving only takes it out of rotation.
- The selected credential is used only for the session's jobToken exchange and subsequent cosy requests — it never reaches pi-ai or the page.
- `logout [--region cn|global]` clears that region's vault accounts and pool measurements (`.qoder-accounts.<region>.json` and `.qoder-pool.<region>.json`).
- Membership, the batch actions, and the failover rules are covered in the [Account pool](#account-pool) section.

## Account pool

One machine often holds several Qoder accounts (several PATs). The **account pool** collapses that into single clicks: check accounts into the pool, then "Check in all accounts" or "Test all accounts"; switch on **Enable account pool** and the plugin automatically fails over to another account when a request fails upstream.

**Each region (CN / international) has its own pool**: members, target model, credits and check-in state never cross over — the accounts belong to different providers anyway. **Both regions have daily check-in**: the international campaign is only served to requests carrying device-risk headers, which the plugin obtains from the device-identity component shipped by the local Qoder client; if it cannot be read, the plugin reports that honestly instead of silently degrading to "no campaign today".

### Automatic failover (enabled together with the pool)

- **Ranking decides who serves**: with the pool on, **every request** goes to the top-ranked usable account, so "currently serving" may not be the account you pinned.
- **Failures walk down the list**: when a request fails upstream, the plugin retries the next usable accounts **in order**, until one takes over or all are exhausted — only then is the error surfaced.
- **What triggers a switch**: 429 rate limits, exhausted quota, rejected credentials (401/403), 5xx gateway/network failures — those are per-account states.
- **What does not**: an invalid request (HTTP 400) — the same body fails identically for everyone, so retrying only makes you wait; and a stream that has already started is never replayed (bytes are on the wire).
- **Known-bad accounts are skipped**: members inside a rate-limit cooldown or with a credential the upstream rejected do not participate. **Never-tested accounts count as usable by default** — a freshly added account should not be excluded because nobody pressed "Test" yet.
- **Your manual choice is never rewritten**: the pool overrides routing at runtime and never writes back your saved selection; turning the switch off restores your pinned account immediately.
- **Failures are remembered**: a failed request is stored as that account's measurement (including the reset time the upstream states), so the next request starts from a usable account instead of hitting the same wall again.
- **A switch is announced**: the swap is a decision the plugin made on your behalf, so it says so — the answer opens with a blockquote notice such as `> [dsh-connect-qoder] "450702134816" was rate-limited; another pool account answered instead.`. The notice names the **account that failed** (your selection), never the one that took over; consecutive swaps produce a single notice naming the failure immediately before the last hop. When nothing was swapped, nothing is written.

### What the switch actually controls

**It controls "should the plugin decide", not "are you allowed to act".**

| | Pool **on** | Pool **off** |
| --- | --- | --- |
| Who serves | chosen **automatically** by ranking (usable → expiring credits → soonest credit expiry → most credits → id) | the account **you** pick under "Which account to use" in the settings area |
| Request fails | retries the next usable account **automatically** | no switch; the error is reported as-is |
| Check in all / Test all | available | **still available** |
| Target test model | editable | **still editable** |

The last two rows are deliberate: checking in and testing are **manual actions** on the members you selected — a different question from whether the plugin routes automatically.

**The one hard rule**: with zero members checked, batch actions refuse outright. An empty pool never degrades into "then run it on all accounts" — that would be the one reading that spends credits you did not authorize.

### The retry budget is configurable (`regions.<region>.retry`)

The host has an in-place retry loop: when a request fails but is worth one more attempt, it waits and sends it again. The wait ladder is declared by the plugin and executed by the host; by default it follows the host, so leaving it unset keeps your behaviour exactly as it is today.

Qoder occasionally answers with `RESOURCE_LIMIT` (business code `10605`) and **states how long to wait**. The plugin now writes that value into the failure text it hands the host (of the form `[upstream retry-after 5s]`), so you can see that upstream only asked for five seconds instead of just "upstream returned a 4xx".

To change the budget, set these numbers (per region):

```yaml
regions:
  cn:
    retry:
      maxRetries: 4        # attempts (0 = follow the host default)
      initialDelayMs: 5000 # first backoff in ms (0 = follow the host default)
      maxDelayMs: 30000    # backoff ceiling in ms (0 = follow the host default)
      queueWaitMs: 60000   # ceiling for waiting out an upstream queue (0 = off, default 60000)
```

`5000 -> 30000` covers both common upstream shapes: a transient throttle (5 s) and a `queueType:p2` queue (about 30 s). **The first three zeros mean "follow the host default"**, so leaving them out is equivalent to not configuring this at all; the fourth one, `queueWaitMs: 0`, turns that feature **off** (see below).

> Previously this was whatever the host picked; changing it meant editing the build artifact inside `node_modules` — and that silently reverts on upgrade.

#### Waiting out a queue yourself (`queueWaitMs`, issue #29)

**The retry budget cannot cover "upstream explicitly asked us to wait 30 seconds".** The host's ladder is increasing (5 s -> 10 s -> 20 s -> 30 s, with jitter), so its first two attempts are **always** shorter than the 30 seconds upstream asked for. Measured in the wild: one turn took 28 retries and 296 seconds of pure waiting, and 11 of those attempts fired within 5 seconds of upstream saying "wait 30 seconds".

The plugin cannot make the host wait precisely: the `pi-ai` route has no `providerRetryAfterMs` channel (re-checked in issue #24 — `retry-after` appears in neither that module nor the vendor underneath it). So waiting in the forwarding layer is the only way to make "wait 30 seconds" actually mean 30 seconds without spending the host's retry budget:

- upstream answers `isQueued: true` **and** states a positive wait, and that value is **<= `queueWaitMs`** ⇒ the plugin waits exactly that long and resends once; that failure is **not** handed to the host;
- the stated value exceeds the ceiling, or the resend is still queued ⇒ it is passed to the host unchanged, so the host still has its remaining budget;
- each request waits **once**, and the wait is interruptible (press stop and it stops at once);
- set `queueWaitMs: 0` to turn it off and go back to "the host's ladder decides".

#### Two kinds of "queued" must not be conflated (issue #29)

The same `isQueued: true` has two shapes, and the plugin words them and accounts for them differently:

| Upstream field | Meaning | What the plugin does |
| --- | --- | --- |
| `isQueued:true` + `serviceAvailable:true` | the service is fine, you are in the queue (`queueCount` is usually > 0) | recorded as **queued**, cooled down for the stated duration; switching accounts is meaningful |
| `isQueued:true` + `serviceAvailable:false` | upstream is **refusing service overall** (measured `queueCount: 0` — nobody is in the queue) | recorded as **upstream unavailable**; the switch notice says outright that this is not the account's fault |

The difference matters: for the first, "wait a bit" or "use another account" works; for the second, switching accounts — and switching PAT — does **not**. Measured: 14 models unavailable at once. Both shapes used to be reported as "queued", so users went off to re-provision their credentials for no reason.

### Ranking rules (who serves when the pool is on)

1. **Usable first** — accounts measured unusable (rate-limit cooldown, rejected credential) go to the back and do not participate;
2. **Accounts with credits about to lapse go first** — credits expiring within 3 days get spent before they lapse (this rule outranks your manual order below, see the notes on `rankPool`);
3. **Your manual order** (`orderAccountIds`) — a dragged order has to take effect, otherwise dragging does nothing;
4. **Soonest credit expiry → largest amount at risk → most credits** — but only with a **fresh reading** (from card polling, a batch test, or a save; valid for 10 minutes). The request path never calls upstream just to rank, otherwise one page of chat becomes N extra requests;
5. Finally account id, so the order is a total, reproducible sequence.

⚠️ **Plan expiry takes no part in ranking** (issue #31): that date answers "how long can this account keep working", which is not the same question as "will credits sitting on it lapse". Treating it as urgency would pin an account whose trial just ended to the front forever — while none of its credits will ever expire.

### The two batch actions

- **Check in all accounts** — claims the daily campaign per account. **Status is read before claiming**, so an already-claimed day is marked "checked in" without a write request (idempotent, no double claim); a failure on one account marks that row and **never aborts the batch**. Claiming changes balances, so the region's usage cache is invalidated when the batch ends.
- **Test all accounts** — one real request per member, answering "can this account use this model right now". The target model defaults to "automatic": a multiplier-0 free model in that region (largest context wins ties). You may pin one — but **testing stays disabled until a free model appears**, so credits are never spent without you knowing. Tests share the per-model probe, so they **have a real cost**.
  
  **The test target is independent of your enabled models** (issue #33): ticking a model decides what the DSH model picker lists, not what may be tested. Whatever the card says is the target is what a test actually probes — even if that model is not ticked under enabled models, and even when the only free model in the region is unticked. These two catalogs used to be separate (the card read the full one, the test route read a runtime one trimmed to the enabled set), and the symptom was a button that did nothing: the card said "test target qfmodel" while a click returned an empty result. There is exactly one catalog now.
  
  When the target genuinely cannot be resolved (no free model in the catalog at all, or the pinned model is gone), the route answers `409` with a reason (`no-free-model` / `target-model-stale`) and the card says "no testable target model" — instead of replying with something that reads like a broken account.

### What the plugin does when the upstream states no recovery time (issue #32)

Two states look alike and are completely different:

| | Meaning | Decided by |
| --- | --- | --- |
| `retryAtMs` present | "the upstream says this account works again after that moment" | an upstream field, a reset sentence in the failure body, or **derived** from the daily check-in window (`retrySource` tells you which) |
| `retrySource: 'unknown-cooldown'` | "the upstream said nothing, the snapshot has nothing; we are retrying **every 30 minutes** on our own" | the plugin |

These two used to be indistinguishable in the data: with `retryAtMs` absent the card went silent, which reads exactly like "the upstream said nothing and nothing will be retried" — while in fact the pool was about to hit the upstream with **one real chat request** every 30 minutes. The fallback branch now writes `retrySource: 'unknown-cooldown'`, and the card says "the upstream gave no time for when this frees up · Retrying automatically about every 30 min". It writes **only the source, never `retryAtMs`** — that field keeps carrying upstream/derived moments only; putting our own cadence there would make the next reader believe the upstream promised a time.

**The 30-minute number is deliberately unchanged**: the official wording is only "continue the next day after the daily quota is used up", with no specific moment, so inventing 6 hours is exactly as arbitrary as inventing 30 minutes. What actually lowers the cost is the next point.

#### The check-in window moment is persisted, so a restart no longer forces the fallback

The recovery point for `110` (daily usage limit) comes from the `endAt` of the check-in campaign row. That snapshot used to live only inside the process — and the fallback cooldown is precisely what applies when "the window moment is unknown", so **every restart made the fallback apply**, and an account that has to wait for tomorrow's window got probed every 30 minutes.

The window moment of a successful check-in is now written to the `windows` key of `$DSH_HOME/.qoder-pool.<region>.json` and read back after a restart (the in-process snapshot wins, disk is the fallback; **a moment already in the past is not used** — using an old date as "when it recovers" would keep the account out of the pool long after the upstream recovered). This is what turns the fallback from "usually applies" into "almost never applies" — far more useful than tuning that 30-minute number.

#### Why the automatic check-in counts WINDOWS, not calendar days (issue #36)

This is the one place where copying the reference implementation verbatim is wrong.

Qoder's daily window is a **fixed absolute moment**: 10:00 today → 09:59 tomorrow (UTC+8). "Check in once a day" really asks "has this WINDOW been claimed", so the unit of accounting has to be the window, not the user's local calendar day:

- For anyone outside UTC+8 a calendar day does not line up at all: local midnight falls inside the window, so the day boundary splits one window into two halves;
- Even in UTC+8 local midnight sits in the middle of the window. Copying the calendar day means 00:05 is judged to be "a new day" and gets a claim attempt (idempotent, reports `already`, recorded as done), while at 10:00 — when the window actually opens — the state still says "this day is finished". **The new window's reward then waits until 00:05 the next day**, fourteen hours late, and the card's countdown keeps saying "claimable now" with nobody claiming.

So a window's identity is "(now − 2 hours) in UTC" (it flips at 10:00 UTC+8), and the moment the **upstream** stated (the campaign row's `endAt`) is preferred when available — if it is still in the future, the window has not rolled over. The two sources use different key prefixes (`upstream:` / `boundary:`), so switching between them always resets the state: that reset costs one extra idempotent pass and buys "the moment the window rolls over, it is looked at again".

Progress belongs to **the current window** only: a finished window can still be in memory until the next tick, and reporting it as today's would make the card announce "today: all N checked in" in the first minutes of a new window while every row underneath reads "not checked in". `summaryForWindow` is what prevents exactly that.

The progress lives in its **own file** (`$DSH_HOME/.qoder-auto-checkin.<region>.json`, `0600`) rather than in settings: the card edits preferences with a draft-then-save cycle, and putting runner state into `regions.<region>.pool` would let one click of Save overwrite it with a draft from minutes ago. The file holds account ids, counters and one failure sentence — no tokens and no account display names.

Neither batch action **locks the interface**: the button itself turns into "Checking in… / Testing…", and as each account finishes its row is updated and its line lands in the activity log **individually**, stamped with that account's own completion time rather than the second the batch ended. Everything else stays usable. Only **saving the config** and **deleting an account** put a veil up — the former is writing to disk, the latter is irreversible.

How the settings page is laid out: two **independent provider cards** sit at the top (CN / international), each with its own border, background and switch on the right, and the selected one carries the brand-coloured outline — **one card is one unit**: click the name to switch tabs, click the switch to enable that provider. Below them come the two credit rows ("show credits in the composer" and "position"; the whole row is clickable and the description sits under the title), then the account pool, then model management. A third row is the optional **"Show Qoder in the sidebar"**. All three take effect **immediately, with no save needed**: the first two decide whether the credit readout appears and where it sits, the third decides whether the sidebar row (and the full page it opens) exists. Above all of that, the page itself is headed by a title, a one-line summary and the three things the plugin does — accounts, catalog, readout.

There is **no automatic** check-in by default: claiming collects a real reward, so it only happens when you press the button.

> Since 1.24.0 that is an **opt-in** switch (issue #36): with "Check in automatically each day" ticked on the mode bar, the plugin presses that button for you in the background. The reasoning is asymmetric cost — a missed window is a reward thrown away (100 credits a day for individual users, valid 30 days) and it breaks the streak, while the check-in itself costs no credits and is idempotent upstream (it reads the status first; a `CLAIMED` account gets no claim request). So the honest question is not "should the plugin ever do this" but "the user may decide, once, that it should" — and the switch is where they decide. It still defaults to off.

## CLI diagnostics

Run **inside the profile directory that has the plugin installed** (recommended, no global install):

```bash
cd ~/.dsh/profiles/desktop
pnpm exec dsh-connect-qoder doctor    # PAT source + cosy fingerprint + pi-ai generation + heartbeat + vault counts (offline)
pnpm exec dsh-connect-qoder status    # per region: credential source + upstream model-list reachability + remaining credits (needs PAT)
pnpm exec dsh-connect-qoder logout --region cn   # clear that region's vault accounts and pool measurements
pnpm exec dsh-connect-qoder doctor --json        # machine-readable output
```

`status` really exchanges a jobToken and fetches the model catalog (then reads usage once, read-only), so it needs that region's environment or vault PAT; `doctor` is fully offline.

> **Two things measured on a real machine**:
> 1. **Do not use a bare path like `node node_modules/dsh-connect-qoder/lib/bin.js`** — as of 0.3.0 the package name is scoped, so the symlink lives at `node_modules/@dmh2002/dsh-connect-qoder`; the old path just gives `MODULE_NOT_FOUND` (a missing **entry file**, not a missing peer).
> 2. The CLI depends on the host-provided peers (`@deepseek-ai/dsh-atomic-write` / `dsh-home-paths`). Locally, pnpm installs them into the profile's dependency tree, and both `pnpm exec` and an npm-installed tarball work. But that **depends on your pnpm version and `auto-install-peers` setting** — if you see `Cannot find package '@deepseek-ai/dsh-atomic-write'`, that layer did not get installed. Provider registration, the settings page and chat are **unaffected** (they run inside the host, which resolves those names). The sibling workbuddy's issue #47 is the same shape; its fix (host-first, fall back to a built-in copy on demand) applies here too and has not been ported yet.

## Platform support

| Platform | Status |
| --- | --- |
| macOS | ✅ Verified (development and CI) |
| Windows | ✅ CI tests pass (upstream uses standard fetch; no platform-specific paths) |
| Linux | ✅ CI tests pass |

## Supported host line

| Host | Peer range |
| --- | --- |
| DSH (`@deepseek-ai/*`) | `>=0.1.7-rc.1 <0.2.0-0 \|\| >=0.2.0-rc.1 <0.3.0-0 \|\| >=0.2.1-rc.1 <0.3.0-0 \|\| >=0.2.2-rc.1 <0.3.0-0` |
| `@earendil-works/pi-ai` | `>=0.85.0 <0.88.0 \|\| >=1.0.0 <2.0.0` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |

> Enforced by `tests/dsh-line.spec.ts`. DSH only ships prereleases, and node-semver admits a prerelease **only** when some comparator in the range names that exact `major.minor.patch` tuple *and* carries a prerelease tag — so every new line needs its own branch. Writing `>=0.1.7-rc.1 <0.3.0-0` silently excludes the whole `0.2.0-rc.*` line; likewise `>=0.2.0-rc.1` does **not** cover `0.2.1-rc.1` (which Desktop 0.2.1-rc.1 ships). The upper bound must keep `-0` (`<0.3.0` blocks nothing).
>
> **Two semver readings coexist** (corrected by measurement in 1.1.2): **npm / pnpm installation** uses node-semver's **standard** reading, so a new patch line's rc (`0.2.2-rc.1` got its branch on 2026-11-05; `0.2.3-rc.1` is next) really does still need a hand-added branch — that is what `UNGATED_PRERELEASES` tracks. But the **host's plugin-compatibility gate does not use the standard reading**: `dsh-app-boot` calls `semver.satisfies(v, range, { includePrerelease: true })`, under which `>=0.2.1-rc.1 <0.3.0-0` alone covers the **whole `0.2.x` line** (`0.2.2-rc.1`, `0.2.9` all pass) while `0.3.0-rc.1` is still blocked by the ceiling. 1.1.0/1.1.1 claimed "no static range can cover any `0.2.x` prerelease" — true for npm, false for the host gate, now corrected.
>
> **pi-ai gets its own row** because it changed major: Desktop 0.2.1-rc.1 moved pi-ai from 0.85 to 1.x, and the two generations consume different context shapes (1.x normalizes in its Models layer). The declaration and the runtime detection must agree — otherwise you get the silent tool-loss bug fixed in 1.1.0. See [`docs/DSH-0.2.1-RC1-FOLLOWUP.md`](docs/DSH-0.2.1-RC1-FOLLOWUP.md).

### Current host baseline: 0.2.2-rc.1 (measured 2026-11-05)

The host moved to `0.2.2-rc.1` (every `@deepseek-ai/dsh-*` inside `app.asar` is `0.2.2-rc.1`, with bundled pi-ai **`1.3.0`**, cordis `4.1.0`, schemastery `3.19.0`). This round **did need adaptation**, unlike the zero-change 0.2.1 line:

| Check | Result |
| --- | --- |
| `ResolvedPiAiProviderProfile` | Gained required `maxRequestImages` / `imageOffloadCountQuantum` (a per-request image-count bound; host defaults 50 / 10). The plugin assembles this profile by hand, so the host's defaulting never runs → both are now set explicitly |
| pi-ai 1.3.0 api input | Now a branded `TranscriptContext` (only `normalizeContext()` produces one). This only affects the legacy (0.85) re-fill branch; the assertion is confined there and documents that a 1.3.0 host cannot reach it |
| `ctx.locale.register` | Signature widened to `Record<BuiltInLocaleId, …> & Record<LocaleId, …>`, which requires a string index signature on the argument → `QoderLocale` now carries one (bilingual stays legal; missing languages fall back to English) |
| Peer range | Added `\|\| >=0.2.2-rc.1 <0.3.0-0`; before that npm's standard reading rejected `0.2.2-rc.1` while the host gate always admitted it |
| modern pass-through | **No regression**: prompt and tools both survive on the real 1.3.0 stack (all four pass-through cases are green once the modern fixture moves to 1.3.0) |
| Mid-conversation system messages | Since 0.2.2 they default to a user-role `<system-reminder>` unless the model declares `supportsMidConvoSystemMessages`; Qoder routes currently take the default |
| Slots / events the plugin uses | `conversation.input.*`, `conversation.composer.dock`, `settings.section` and `plugins.*.config` are unchanged; `webserver/index-inject`'s new `peer` argument and `WebResourceRoute` are additive and unused here |
| Regression | `pnpm run typecheck` (host and client projects) plus `pnpm test` are green |

> The 0.2.1-rc.4 / rc.5 round stays documented in [`docs/DSH-0.2.1-RC1-FOLLOWUP.md`](docs/DSH-0.2.1-RC1-FOLLOWUP.md); this round's measurements, reproduction script and open decisions are in [`docs/DSH-0.2.2-RC1-FOLLOWUP.md`](docs/DSH-0.2.2-RC1-FOLLOWUP.md).

## Security notes

- The PAT is stored only in the local plugin configuration (or an environment variable) and **never enters any network request**; external calls always use cosy session tokens (jobToken) plus machine-fingerprint headers.
- The local shim is a random-port loopback service with an in-process secret, verifying Host / Origin / Content-Type, with a 64 MB request-body cap.
- The plugin only reads PATs you explicitly provide; it **never reads or modifies** Qoder desktop sign-in/credential files.
- Diagnostic output (`doctor` / `status` and card probes) is redacted and never prints token-like strings.

## Market listing and presentation

The plugin declares an installable `dsh.bundle` manifest (`dsh.bundle.patch: ./cordis.patch.yml`), so `dsh plugin add` works. Community markets usually sync entries from the [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry; the submission draft lives in [`awesome-dsh-plugin-submission/dingminhua__dsh-connect-qoder.yml`](awesome-dsh-plugin-submission/dingminhua__dsh-connect-qoder.yml).

**Registry rules** (per [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)):

- One YAML per plugin: `data/plugins/<owner>__<repo>.yml`, with `url` (exactly the repository URL), `name` (`owner/repo`), `category` (a valid value; `model` here), `description.en` (required, ends with a period) / `description.zh` (optional); quote any description containing `: `.
- The repository must declare the `dsh.bundle` manifest, carry the `dsh-plugin` topic, be at least a day old and actively maintained; descriptions must be factual and free of marketing language — they are checked against the code.
- The registry's two READMEs are generated, never hand-edited; after changing a YAML, run `npm ci` + `node scripts/generate-readme.mjs` in that repository.
- A PR carries at most 3 entries; only touch your own.

Market screenshots and GitHub README badges are two different mechanisms:

- **Market screenshots** are declared, under the current convention, by **`screenshots.json` in this plugin's own repository root** (see [screenshots.json](screenshots.json)); the registry's `data/screenshots.json` is a legacy fallback and takes no new keys.
- **GitHub badges** come from the Shields image links at the top of this README. **Market icons / placeholders** follow each storefront's own display rules — they are neither an npm field nor a README badge.

## Known limitations

- This depends on Qoder's cosy gateway and `sash` endpoints (**not an official public API**); upstream changes may require plugin changes. The protocol behavior is referenced from [Zhengyuuuui/qoder2api](https://github.com/Zhengyuuuui/qoder2api) and independently implemented here — no source is copied.
- **Daily check-in** is Qoder's operational campaign for **individual** accounts (organization accounts do not participate); the rules and amounts are the vendor's to change. The international campaign requires the device identity that the local Qoder client provides, so **on a machine without the Qoder desktop client, international check-in is unavailable** (the plugin says so explicitly rather than degrading silently).
- Image input and "off-able thinking" are offered per a **verified** list: models outside it are never pre-checked, so one that actually works may need a manual check from you. **The image switch is a whitelist** — once you have saved a selection, un-checked models stay off; un-checking everything and saving keeps them off instead of letting the defaults switch them back on.
- Per-model and batch tests **send real requests** and consume a little upstream credit. There is no "test all checked" button, and batch actions only touch accounts you explicitly checked into the pool.
- **The standalone CLI depends on host-provided peers** (`@deepseek-ai/dsh-atomic-write` / `dsh-home-paths`). Locally pnpm installs them alongside the package and `pnpm exec dsh-connect-qoder …` works; if your pnpm configuration does not, the CLI reports `Cannot find package …`. Provider registration, the settings page and chat are unaffected — they run inside the host, which resolves those names. The workbuddy fix (host-first, fall back to a built-in copy) applies here and has not been ported yet.

## Privacy & screenshots

**No real account data ever appears in the repository or the npm tarball.** This is a hard rule; the details live in [docs/PRIVACY.md](docs/PRIVACY.md):

- Every screenshot in the README and `docs/` is **captured with fake data**: the account name is `acct-demo`, addresses are `account-a@example.com`, balances are round numbers. **Redaction means an opaque block or a replaced value — blur, mosaic and translucent overlays do not count**, because they preserve character widths and the light/dark distribution.
- Code comments and CHANGELOG entries that record "what the user saw" keep the observation and drop the identity.
- `tests/privacy.spec.ts` scans the repo for real email addresses, upstream nicknames, credential fingerprints, absolute local paths and credential bodies, and CI runs it as its own step. **It cannot read image content**, so a new or replaced image under `docs/assets/` still has to be opened and looked at by a human.

> This rule was written after a lesson: earlier releases used real data in the screenshots, which has since been replaced with fake values. "What to do after a leak" is in [docs/PRIVACY.md](docs/PRIVACY.md).

## Disclaimer

- This project is **for personal learning and research only**; it drives only your own Qoder account on your own machine. Do not use it commercially or beyond reasonable personal use.
- Users must comply with the Qoder / Lingma terms of service; any consequence of using this project (including account restrictions, quota wipe or service interruption) is borne by the user.
- The author accepts no liability for any direct or indirect loss caused by using or misusing this project.
- This project is unaffiliated with Alibaba, Lingma, Qoder, or DeepSeek and is not endorsed or authorized by them; names appear only to describe compatibility, and their trademarks belong to their respective owners.

## Acknowledgements

This project builds on other people's public work — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md):

- [**Zhengyuuuui/qoder2api**](https://github.com/Zhengyuuuui/qoder2api): reference implementation of the cosy protocol wire behavior (encoding, signing, sessions, fingerprints, jobToken, SSE shapes, error classification). This project **independently re-implements** that behavior in TypeScript and copies no source code; the repository ships no standalone LICENSE and its README points at `wangtufly/QCCG` (GPL-3.0).
- [**L0NE-6/Qoder-Daily**](https://github.com/L0NE-6/Qoder-Daily) (MIT): reference for the daily check-in protocol (the `campaigns` / `claim` shapes, idempotency, and the international device-risk idea). This project independently implements it from that documentation plus local measurement, copying no source.
- [**dingminhua/dsh-connect-workbuddy**](https://github.com/dingminhua/dsh-connect-workbuddy) (MIT): baseline for the plugin engineering layout, card interaction model, loopback shim pattern, and npm publishing workflow.
- [**dingminhua/dsh-connect-trae**](https://github.com/dingminhua/dsh-connect-trae) (MIT): card look & publishing baseline, referenced via workbuddy.
- [**franksong2702/dsh-codex-connect**](https://github.com/franksong2702/dsh-codex-connect) (Apache-2.0): DSH plugin structure and pi-ai provider registration, referenced via workbuddy.
- Qoder official SDK type definitions: used only to cross-check usage/header shapes; not distributed.

## License

MIT © LaoDing — see [LICENSE](LICENSE).