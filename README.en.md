<p align="center">
  <img src="icons/dsh-connect-qoder-128.png" width="128" alt="dsh-connect-qoder" />
</p>

<h1 align="center">dsh-connect-qoder</h1>

<p align="center"><b>Connect Qoder (Lingma international / CN) models to DeepSeek Harness, with a read-only credits overview and model management.</b></p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/dingminhua/dsh-connect-qoder/issues">Issues</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-connect-qoder"><img src="https://img.shields.io/npm/v/dsh-connect-qoder?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-connect-qoder"><img src="https://img.shields.io/npm/d18m/dsh-connect-qoder?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/dingminhua/dsh-connect-qoder/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dingminhua/dsh-connect-qoder/ci.yml?branch=main&style=flat-square&label=tests" alt="test status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/dingminhua/dsh-connect-qoder?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/dingminhua/dsh-connect-qoder/stargazers"><img src="https://img.shields.io/github/stars/dingminhua/dsh-connect-qoder?style=flat-square" alt="GitHub stars"></a>
</p>

A standalone [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) bundle plugin. It connects your Qoder account's models to the DSH model picker, with model management and a read-only credits overview. **The CN and international editions are two parallel providers (`qoder` / `qoder-global`) that can be used at the same time**; the plugin's settings card separates them with tabs.

> Qoder does not expose an OpenAI-compatible endpoint (its official SDK is only an agent launcher), so this plugin talks to Qoder's cosy gateway directly, implementing a minimal client for the protocol. No Qoder desktop sign-in is needed — just a PAT (Personal Access Token).

## Features

- **Two parallel providers (CN + international)** — the CN edition registers as the `qoder` provider (`gateway.qoder.com.cn`); the international edition registers as `qoder-global` (`api1.qoder.sh`). **Regions with a PAT configured show their models in the DSH model picker**: with a PAT for both regions you get two groups that can be used simultaneously and independently per session. **A region without a PAT lists no models** (no request could succeed, so listing them would only invite failures); configure a PAT and hit "Refresh models" to make them appear — the provider itself stays registered, because its settings card is the configuration entry point. Model names embed the upstream credit multiplier (e.g. `qwen3.8 · x1.31`), matching Qoder's own model menu.
- **Settings card tabs** — the card top has "CN / Global" tabs, each with its own PAT, model management, and credits overview; catalogs, selections, and state stay fully isolated per tab.
- **Per-region kill switch** — each tab has a checkbox on the right (both checked by default). **Unchecking removes that provider from the DSH model picker entirely** (not just hiding the tab): both its adapter route and its "Settings → Models" directory entry are removed. PAT, credits, and selections are **all kept**; re-checking restores everything. Note: a session that had already selected a model of the disabled provider will get `NO_ADAPTER` on its next call.
- **Model management** — refresh the full model catalog from upstream and toggle each model on or off; each row shows the multiplier (`· xN.NN`), context/output limits, reasoning and image support, and default/free markers. Selections are written to local config and sync to the model picker immediately.
- **Per-model availability probe** — every model row has a "Test" button that goes straight to upstream: rate-limited (429) → "Rate limited", invalid credential → "Invalid credential", content-policy rejection → "Blocked by content policy", quota exhausted → "Quota exhausted", and other upstream transient failures are classified honestly. Probes run in the background, **credentials never reach the page**; results are not written into settings and do not change your saved selections. **Probes are real requests** (they consume a small amount of upstream credit), so they are per-model and manual only — there is no batch "test all checked" button.
- **Read-only credits overview** — per region: base / add-on / org quota with used, total, remaining, percentage, and expiry (from Qoder's `sash/api/v2/me/usage`). Read-only and free.
- **Secure loopback shim** — one random port + in-process random secret per region, so the real Qoder PAT **never reaches pi-ai**: pi-ai only talks to the local shim, which performs upstream requests with cosy sessions.
- **Multi-account pool (PAT)** — a per-region local vault `$DSH_HOME/.qoder-accounts.<region>.json` (0600) merges the settings PAT, environment variable, and vault accounts into one de-duplicated list; the card can add (paste a `pt-…`, validated via a `JobToken` exchange that returns the display name), remove, and rename accounts, and can pin a specific account to serve (`regions.<region>.accountId`, empty = automatic by settings → env → vault).
- **Probe-ranked selection and failover** — "Test" sends a real request to each pool member and persists results to `$DSH_HOME/.qoder-pool.<region>.json`; before the first SSE byte the chat stream switches accounts by `rankPool` (usability → highest credits → soonest expiry → id) and writes failures back as `live-request` probes. Qoder has **no daily check-in**, so the pool never shows a check-in column.
- **Account transfer (import / export)** — export a region's vault accounts to a transfer file, preview it, and import by index; cross-region domains (`qoder.com.cn` / `qoder.sh`) are positively matched and non-matching records are counted as `skipped`.
- **Context budgets** — declared context tiers are parsed from upstream `context_config`; pick a tier per model, and it applies only when the model declares it (otherwise the native value is kept).
- **Composer credits readout** — the session input (`conversation.input.left`) shows `QD CN` / `QD AI` and the current account's balance per region, gated by per-region `showCreditsInMainUi` (default on, opt-out); per-account detail comes from the `account-credits` route.
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

Credentials are PATs (settings card `regions.<region>.pat`, or environment variables — see [Configuration](#configuration)); the settings value wins. Sessions lazily exchange a **jobToken** on demand: the PAT is used once in that exchange, and every subsequent request carries a cosy bearer (custom Base64 payload + MD5 signature) plus "machine fingerprint" session headers. **The PAT never reaches pi-ai and never leaves the process except in that one local exchange; this plugin neither reads nor writes Qoder desktop sign-in files.**

Encoding and signing details (custom alphabet, `n/3` rearrangement, `cosy&<SECRET>&<date>` signature, RSA/AES session wrapping) are documented at the top of `src/cosy.ts`; the error taxonomy (content policy / rate limit / quota exhausted / transient) and how it maps onto DSH retry semantics live in `src/upstream.ts`.

## Installation

### From a published package (recommended)

Search for `dsh-connect-qoder` in DSH's "Plugin market / Bundles" and enable it; or

```bash
npm install -g dsh-connect-qoder   # CLI (doctor/status) only
```

### From source (development)

```bash
git clone https://github.com/dingminhua/dsh-connect-qoder.git
cd dsh-connect-qoder
pnpm install
pnpm run check        # typecheck + test + build must all pass first
```

Install the repository directory as a bundle into the current DSH profile (Harness → Plugin management → install local bundle; target = this repository directory).

### Verify the installation

- "Settings → Plugins" should show the dsh-connect-qoder card with its CN / Global tabs.
- `dsh-connect-qoder doctor` (if installed globally) should print both regions' PAT status and fingerprint derivation.
- After configuring a PAT, "Refresh models" should fetch the region's real catalog; the model picker shows `Qoder` / `Qoder Global` groups.

## Configuration

### PAT (Personal Access Token)

Create a PAT (`pt-…`) in your Qoder account settings. Two ways to provide it — **the settings card wins over the environment variable**:

| Region | Setting | Environment variable |
| --- | --- | --- |
| CN (qoder.com.cn) | Card "CN" tab → PAT | `QODERCN_PERSONAL_ACCESS_TOKEN` |
| Global (qoder.sh) | Card "Global" tab → PAT | `QODER_PERSONAL_ACCESS_TOKEN` |

- The PAT is stored only in the local plugin configuration (`regions.<region>.pat`); it is never uploaded and never enters any network request.
- A region without a PAT lists no models; the `doctor` command points out which region is missing one.

### Region enable/disable

The checkbox on each tab controls whether that region participates in the model picker (opt-out: **only an explicit uncheck disables it**). Disabling only removes the route and the directory entries; configuration is kept.

### Multi-account pool and credential sources

Besides the settings PAT and the environment variable, each region has a local vault (`$DSH_HOME/.qoder-accounts.<region>.json`, mode 0600) that stores multiple PAT accounts. The three sources are merged de-duplicated by **settings → env → vault** (a PAT appearing in two sources is listed once, under the higher-priority source).

- The card can add (paste a `pt-…`, validated via a `JobToken` exchange that returns the display name), remove, and rename vault accounts, and can pin a specific account to serve (`regions.<region>.accountId`, empty = automatic).
- The selected credential is used only for the session's jobToken exchange and subsequent cosy requests — it never reaches pi-ai or the page.
- `logout [--region cn|global]` clears that region's vault accounts and pool measurements (`.qoder-accounts.<region>.json` and `.qoder-pool.<region>.json`).

## CLI diagnostics

```bash
dsh-connect-qoder doctor                # PAT source + cosy fingerprint + pi-ai generation + heartbeat + vault counts (offline)
dsh-connect-qoder status                # per region: credential source + upstream model-list reachability + remaining credits (needs PAT)
dsh-connect-qoder logout --region cn    # clear that region's vault accounts and pool measurements
dsh-connect-qoder doctor --json         # machine-readable output
```

`status` really exchanges a jobToken and fetches the model catalog (then reads usage once, read-only), so it needs that region's environment or vault PAT; `doctor` is fully offline.

## Platform support

| Platform | Status |
| --- | --- |
| macOS | ✅ Verified (development and CI) |
| Windows | ✅ CI tests pass (upstream uses standard fetch; no platform-specific paths) |
| Linux | ✅ CI tests pass |

## Supported host line

| Host | Peer range |
| --- | --- |
| DSH (`@deepseek-ai/*`) | `>=0.1.7-rc.1 <0.3.0-0` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |

> Enforced by `tests/dsh-line.spec.ts`: the upper bound must carry `-0` (DSH only ships prereleases; `<0.3.0` would block nothing).

## Security notes

- The PAT is stored only in the local plugin configuration (or an environment variable) and **never enters any network request**; external calls always use cosy session tokens (jobToken) plus machine-fingerprint headers.
- The local shim is a random-port loopback service with an in-process secret, verifying Host / Content-Type.
- The plugin only reads PATs you explicitly provide; it **never reads or modifies** Qoder desktop sign-in/credential files.
- Diagnostic output (`doctor` / `status` and card probes) is redacted and never prints token-like strings.

## Acknowledgements

This project builds on other people's public work — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md):

- [**Zhengyuuuui/qoder2api**](https://github.com/Zhengyuuuui/qoder2api): reference implementation of the cosy protocol wire behavior (encoding, signing, sessions, fingerprints, jobToken, SSE shapes, error classification). This project **independently re-implements** that behavior in TypeScript and copies no source code; the repository ships no standalone LICENSE and its README points at `wangtufly/QCCG` (GPL-3.0).
- [**dingminhua/dsh-connect-workbuddy**](https://github.com/dingminhua/dsh-connect-workbuddy) (MIT): baseline for the plugin engineering layout, card interaction model, loopback shim pattern, and npm publishing workflow.
- [**dingminhua/dsh-connect-trae**](https://github.com/dingminhua/dsh-connect-trae) (MIT): card look & publishing baseline, referenced via workbuddy.
- [**franksong2702/dsh-codex-connect**](https://github.com/franksong2702/dsh-codex-connect) (Apache-2.0): DSH plugin structure and pi-ai provider registration, referenced via workbuddy.
- Qoder official SDK type definitions: used only to cross-check usage/header shapes; not distributed.

## License

MIT © LaoDing — see [LICENSE](LICENSE).