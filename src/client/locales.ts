/**
 * Plugin-card copy registered under the settings.qoder locale namespace.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — `row.*` / `composer.*` 的文案键约定与中英 1:1 键对齐（`zh: Record<Key,
 *     string>` 强制双语同步）、`Translate` 类型，均来自该项目；其又承
 *     dingminhua/dsh-connect-trae（MIT）。
 * 改动（按 Qoder 现实）：
 *   1. 账号是 PAT（Personal Access Token），不是桌面端登录——没有
 *      searched-paths、没有 OAuth、没有「桌面端重新登录」文案；账号来源是
 *      settings PAT / 环境变量 / 插件保险库（vault）；
 *   2. 每日签到走 Qoder 的 campaigns 端点，CN 与国际版都已接通；卡片按区域的
 *      `checkinSupported` 决定是否渲染签到列与按钮（为 false 时整列不出现）；
 *   3. 国内版 = 通义灵码 / Qoder CN（qoder.com.cn，QD CN），国际版 = Qoder
 *      （qoder.sh，QD AI）；composer 读数是 region 标注的「QD CN」/「QD AI」。
 *
 * @module dsh-connect-qoder/client/locales
 */

import { QODER_PACKAGE_NAME } from '../version.ts'

export const en = {
  // 包名用构建期注入的真实值，而不是手抄 —— 改名过一次，手抄的那份就过期了。
  'row.title': `Qoder (Lingma) credits & models (${QODER_PACKAGE_NAME})`,
  'row.desc': 'Use Qoder (Lingma CN / global) models in DSH and see your remaining credits; the CN and international sides are two independent providers (qoder / qoder-global), each with its own PAT and accounts — use both at the same time.',
  'row.expand': 'Expand',
  'row.collapse': 'Collapse',
  'row.tabCn': 'CN',
  'row.tabGlobal': 'Global',
  'row.tabHint': 'Each tab is a separate provider (qoder / qoder-global) with its own PAT, accounts, credits, and models. Both sides are live at once: different sessions can pick from either side, and changes on one tab never touch the other.',
  'row.tabSwitchHint': 'Uncheck to switch this provider off. Its models disappear from the DSH model picker; your PAT, accounts, credits, and model settings are kept and return when you check it again.',
  'row.tabSwitchAria': 'Offer the {region} provider to DSH',
  'row.tabOffNotice': 'This provider is switched off: none of its models are offered to DSH. Your PAT, accounts, credits, and model settings are kept — check the box above the tab to bring it back.',

  // ---- Card sections (accounts / models / diagnostics) ----
  // The card carries two unrelated jobs — running an account (who serves, how much
  // is left, which pool member) and editing the catalog (which models, what context
  // budget, which reasoning tier). They do not even commit the same way (an account
  // change lands on the click, a catalog change is a draft until saved), so one
  // column put the save button screens away from what it saves.
  'row.panelAccounts': 'Accounts',
  'row.panelModels': 'Models',
  'row.panelDiag': 'Diagnostics',
  'row.panelAria': 'Card sections',
  'row.diagHint': 'What this card actually read, so a report can quote it. Nothing here changes a setting.',
  'row.diagRegion': 'Region',
  'row.diagDomain': 'Upstream domain',
  'row.diagAccount': 'Serving account',
  'row.diagSource': 'Credential source',
  'row.diagCreditsAt': 'Credits read at',
  'row.diagCatalog': 'Models in the catalog',
  'row.diagEnabled': 'Enabled models',
  'row.diagPool': 'Account pool',
  'row.diagPoolOn': '{count} account(s)',
  'row.diagPoolOff': 'off',
  'row.diagFailures': 'Last failure',
  'row.diagNoFailures': 'Nothing reported.',

  // ---- PAT / account list ----
  'row.patLabel': 'PAT (Personal Access Token)',
  'row.patPlaceholder': 'pt-… paste here; empty reads the environment variable',
  'row.patHint': 'Stored locally in the plugin configuration only. Takes precedence over the environment variable.',
  'row.patEnvHint': 'You may also set the environment variable {var}',
  'row.accountsHint': 'The serving account for this region, chosen from the settings PAT, the environment PAT, and the plugin vault.',
  'row.accountSelectLabel': 'Account in effect',
  'row.accountSelectAuto': 'Auto — settings, then env, then vault',
  'row.accountSelectAria': 'Choose which account serves this region',
  'row.accountsScanning': 'Re-reading…',
  // 首次加载的一瞬。此前这段时间渲染的是「未登录 / 请填写 PAT」的引导，
  // 而实际上账号正在飞回来的路上——用户看到的第一屏是错的（issue #77 同族）。
  'row.accountsLoading': 'Loading your accounts…',
  'row.accountSourceSettings': 'settings PAT',
  'row.accountSourceEnv': 'environment PAT',
  'row.accountSourceVault': 'vault',
  'row.accountUnnamed': 'Unnamed account',
  'row.accountRemoving': 'Removing the account…',
  'row.accountsWriteFailed': 'The account change was not saved: {message}',
  'row.selectionLostHint': 'The saved account no longer exists among the available PATs.',
  'row.selectionLostMessage': 'The account saved for this region is no longer among the available PAT sources (settings / env / vault). Pick a current one from the list above; adding a PAT will not fix a lost selection on its own.',

  // ---- Credential rejected ----
  'row.credentialRejectedTitle': 'Qoder refused this account\'s PAT',
  'row.credentialRejectedIntro': 'The PAT for "{accountName}" is no longer accepted by Qoder, so credits and testing are unavailable here. Re-adding the same PAT will not help — what actually applies:',
  'row.credentialRejectedSwitch': 'Another account in this region answered the upstream: "{accountName}". Switching to it fixes this — add its PAT if you do not already have it.',
  'row.credentialRejectedSwitchAction': 'Switch to "{accountName}"',
  'row.credentialRejectedRelogin': 'No other account exists to switch to. Add a valid PAT for this region.',
  'row.credentialRejectedChoose': 'Other accounts exist but none of them answered the upstream just now. Try switching to one above; if none works, add a fresh PAT.',

  // ---- Transfer ----
  'row.transferTitle': 'Export / import accounts',
  'row.transferHint': 'Move PAT accounts between machines as a JSON file. The file carries the credentials — keep it private.',
  'row.transferExport': 'Export accounts',
  'row.transferExporting': 'Exporting…',
  'row.transferExportPick': 'Choose the accounts to export ({total} available):',
  'row.transferExportConfirm': 'Export {count} account(s)',
  'row.transferExported': 'Exported {count} account(s) to {fileName}.',
  'row.transferImport': 'Import accounts',
  'row.transferImporting': 'Importing…',
  'row.transferPreviewing': 'Reading the file…',
  'row.transferPreviewTotal': '{total} account(s) in the file — untick what should stay out. Accounts already stored here are overwritten by the import.',
  'row.transferImportConfirm': 'Import {count} account(s)',
  'row.transferImported': 'Imported {imported} account(s); {skipped} skipped (no token, or belongs to the other region).',
  'row.transferEntryUnknown': 'unknown account',
  'row.transferNoToken': 'no token in this record',
  'row.transferCancel': 'Cancel',
  'row.transferError': 'Transfer failed: {message}',

  // ---- Add PAT ----
  'row.addAccountTitle': 'Add a PAT',
  'row.addAccountStart': 'Add PAT',
  'row.addAccountPlaceholder': 'Paste a Qoder PAT (pt-…) here',
  'row.addAccountNameHint': 'Optional display name (a validated token yields one automatically)',
  /**
   * 「PAT 从哪来」的就地说明。放在「添加 PAT」这一行上，而不是只靠对话框里
   * 那个文档链接 —— 用户看到这个入口的瞬间，最想知道的正是「去哪弄一个令牌」。
   * 域名逐区域不同（国内 qoder.com.cn / 国际 qoder.com），所以写成参数。
   */
  'row.addAccountPatHint': 'Sign in at {domain} → Service integrations → New token (the other region uses a different domain)',
  'row.addAccountValidating': 'Validating…',
  'row.addAccountDone': 'Added “{accountName}”. It now serves this region.',
  'row.addAccountError': 'Could not add this PAT: {message}',
  'row.addAccountInvalid': 'This does not look like a PAT (expected pt-…).',
  'row.addAccountTouchedOnce': 'Validate the token against the region gateway; the account appears above when it is accepted.',
  'row.addAccountDialogClose': 'Close',

  // ---- Shared busy veil ----
  'row.veilHintList': 'The list refreshes as soon as this finishes.',
  'row.addAccountSyncing': 'Adding the account…',

  // ---- Credits ----
  'row.creditsError': 'Credit query unavailable: {message}',
  'row.usageTitle': 'Credits',
  'row.usageUnavailable': 'Credits unavailable (no PAT, or the upstream is not answering).',
  'row.usageBucketBase': 'Base quota',
  'row.usageBucketAddon': 'Add-on quota',
  'row.usageBucketOrg': 'Org quota',
  'row.usageUsed': 'used',
  'row.usageTotal': 'total',
  'row.usageExpiresAt': 'expires {at}',
  'row.usageExpired': 'expired',
  'row.refreshUsage': 'Refresh credits',
  'row.refreshingUsage': 'Refreshing credits…',

  // ---- Models ----
  'row.modelsTitle': 'Models',
  'row.modelsSummary': '{count} enabled',
  'row.modelsDirty': 'unsaved changes',
  'row.modelsRefresh': 'Refresh from Qoder',
  'row.modelsRefreshing': 'Refreshing models…',
  'row.discard': 'Discard changes',
  'row.save': 'Save',
  'row.saving': 'Saving…',
  'row.saveError': 'Save failed: {message}',
  'row.saveContentionHint': ' (The file was locked, so the write was refused — on Windows this is usually an antivirus scanner, a sync client such as OneDrive, or an editor with that file open. Close whatever holds it and save again; your edits are still here.)',
  'row.modelContext': 'Maximum context {context}',
  'row.contextBudget': 'Context',
  'row.modelOutput': 'Output {output}',
  'row.modelReasoningLabel': 'Reasoning',
  'row.modelReasoningFollowUpstream': 'Upstream default',
  'row.modelReasoningFollowUpstreamNamed': '{effort} (upstream default)',

  'row.modelMultimodal': 'Multimodal',
  'row.modelFree': 'Free',
  // 「免费」徽标的悬停：上游对这个徽标只给一个 `is_free` 布尔量，没有 description /
  // 时段 / 链接可引用，所以这句是插件自己写的解释。判据仍是上游的（倍率 0），
  // 没有替上游承诺任何它没说过的事。
  'row.modelFreeHint': 'Zero multiplier — calls with this model consume no credits',
  // 「错峰」徽标在窗口外灰显时的悬停前缀：{start} 是上游声明的起点（如 22:00），
  // 用来说清「还没到点」，与实心状态下的「正在打折」区分开。
  'row.promoPending': 'Not active yet — starts at {start}',
  'row.modelImage': 'Image',
  'row.modelImageText': 'This model is documented as text-only — it does not accept image input',
  'row.modelImageUnverified': 'Native multimodal support is not verified for this model; leave it off unless you know it accepts images',
  'row.modelOff': 'Can disable thinking',
  'row.modelOffHint': 'Offer the "off" thinking level for this model',
  'row.modelFallback': 'Built-in catalog (upstream unreachable)',
  'row.modelNoProbe': 'Test',
  'row.modelUnknown': 'Unknown',
  'row.modelCapabilityPending': 'Only capabilities advertised by Qoder are shown.',
  'row.probe': 'Test',
  'row.probing': 'Testing…',
  'row.probeHint': 'Send one real chat request to this model and report whether it answers right now. This costs a little credit and runs one model at a time.',
  'row.probeOk': '✓ Usable',
  'row.probeOkMs': '✓ Usable ({ms})',
  'row.probeRateLimitedUnknown': '✗ Rate limited · the upstream gave no time for when it frees up',
  'row.probeRateLimitedAt': '✗ Rate limited · usable again after {at}',
  // "Usage limit reached" rather than "Not enough credits": this bucket carries
  // the whole quota family (official codes 110 daily limit / 113 quota exhausted
  // / 115-119 credits / 122 billing group). The account measured for 110 still
  // had **500 credits** and `isQuotaExceeded: false` — "not enough credits"
  // would be a second self-contradicting sentence.
  'row.probeOutOfCreditUnknown': '✗ Usage limit reached · the upstream gave no time for when it frees up',
  'row.probeOutOfCreditAt': '✗ Usage limit reached · recovers {at}',
  'row.probeCredentialRejected': '✗ Qoder refused this account\'s PAT — add a new one or pick another account',
  'row.probePolicyRejected': '✗ Qoder\'s server refused this request under its content policy — re-adding the PAT will not help',
  'row.probeNotFound': '✗ The upstream does not know this model',
  'row.probeUnavailable': '✗ The upstream could not be reached — no usable answer came back',
  'row.probeFailed': '✗ Test failed',
  'row.probeFailedStatus': '✗ Test failed (HTTP {status})',
  'row.probeError': 'Could not run the test: {message}',
  'row.cheer': 'Star on GitHub',
  'row.docsHint': 'How to create a PAT?',

  // ---- Account pool ----
  'row.poolTitle': 'Account pool',
  'row.poolNoCandidate': 'No account in this pool can be used right now.',
  // "Usage limit reached" rather than "out of credits", matching the
  // poolExcludedOutOfCredit chip: this bucket covers the whole quota family
  // (incl. official code 110, the daily limit), and the account measured for it
  // still had 500 credits — two different words in one sentence would collide.
  'row.poolNoCandidateHint': 'Members are rate-limited, at their usage limit, rejected, or unreachable. Rate limits, usage limits and transient failures return to the pool on their own — at the time the upstream states, or after a 30-minute fallback. Only a rejected credential needs a new PAT.',
  'row.poolEmptyHint': 'This region has no accounts yet. Use “Add PAT” above to paste one, or “Export / import accounts” to bring them over from another machine — the pool, the model tests and the daily check-in all need at least one account.',
  // 「勾选的」而不是「所有」：两个按钮只走勾选进池的成员，表格里未勾选的行
  // 就摆在旁边——「所有账号」会被读成「我登录过的每一个账号」，与禁用条件
  // （一个都没勾就置灰）和成员区那句「只有勾选的账号参与轮换」都对不上。
  'row.poolTestAll': 'Test selected',
  'row.poolCheckinAll': 'Check in selected',
  'row.poolCheckingIn': 'Claiming…',
  'row.poolLogCheckinStart': 'Claiming daily credits for {count} account(s)',
  'row.poolLogCheckinClaimed': '{accountName}: claimed',
  'row.poolLogCheckinClaimedAmount': '{accountName}: claimed {credit} credits',
  'row.poolLogCheckinAlready': '{accountName}: already claimed today',
  'row.poolLogCheckinFailed': '{accountName}: failed — {message}',
  'row.poolLogCheckinDone': 'Check-in finished',
  'row.poolTesting': 'Testing…',
  'row.poolBusyHint': 'Running one account at a time…',
  'row.poolTargetAuto': 'Auto',
  'row.poolTargetFree': 'Auto-picked free model: {model}',
  'row.poolTargetPreferred': 'Your chosen model: {model}',
  'row.poolTargetCurrentPreferred': 'Current: {model} (your choice).',
  'row.poolTargetCurrentFree': 'Current: {model} (auto-picked free model).',
  'row.poolTargetNone': 'This region has no zero-multiplier model yet.',
  'row.poolRank': 'Priority #{rank}',
  'row.poolRankAuto': 'Auto-ranked',
  'row.poolRankHint': 'You set this order. Requests go to the highest available account first.',
  'row.poolRankExcluded': 'Position #{rank} · not in use',
  'row.poolRankExcludedHint': 'You set this position, but the account is excluded right now, so it sinks below every usable one until it recovers.',
  'row.poolRankAutoHint': 'No manual order yet — the pool picks by expiring credits first, then balance. Use ↑/↓ to set your own order.',
  'row.poolMoveUp': 'Higher priority',
  'row.poolMoveDown': 'Lower priority',
  'row.poolMoveAria': 'Priority order for {accountName}',
  'row.poolTargetNoneHint': 'The region\'s catalog only reveals its multipliers after a model refresh. Rather than quietly spending credits on a paid model, testing stays off until a free one appears — refresh the models from the Models section, or pick a target model yourself.',
  'row.poolTargetStale': 'The target model you saved is no longer offered: {model}',
  'row.poolTargetStaleHint': 'The region\'s catalog changed and no longer lists this model, so testing is off rather than running against a model the upstream may not accept. Pick another target, or switch back to automatic.',
  'row.poolTargetStaleClear': 'Switch back to automatic',
  'row.poolTargetStaleShort': 'target model unavailable',
  'row.poolTargetNoneShort': 'no free model',
  'row.poolColumnAccount': 'Account',
  'row.poolColumnCredits': 'Credits',
  'row.poolColumnProbe': 'Status',
  'row.poolColumnCheckin': 'Check-in',
  'row.poolCheckedIn': 'Checked in',
  'row.poolNotCheckedIn': 'Not checked in',
  'row.poolCheckinUnknown': '—',
  // The countdown is the UPSTREAM's next-window opening time (campaign `endAt`),
  // not a local guess: the daily window runs 10:00 → next day 09:59 (UTC+8), which
  // is what the Qoder web page shows.
  //
  // **The copy has to name what the number refers to** (user screenshot: "Checked
  // in · refreshes in 00:39:22"). "Refreshes in" describes when this ROW reloads,
  // while the number is when you can CLAIM again — side by side they contradict
  // each other: done for today, yet refreshing in 39 minutes.
  'row.poolCheckinNext': 'Claimable again in {countdown}',
  'row.poolCheckinNextHint': 'This daily window has been claimed. The number is when the NEXT window opens (claim again then) — the same countdown the Qoder web page shows, not how often this row refreshes.',
  // Once the window opens, do not repeat "Checked in": that was the PREVIOUS
  // window, and "Checked in · claimable now" contradicts itself.
  'row.poolCheckinDue': 'Claimable now',
  'row.poolCheckinDueHint': 'The next window has opened, so this account can claim again now. "Checked in" referred to the previous window, so it is not repeated here.',
  'row.poolNeverTested': 'Untested',
  'row.poolTestedAt': 'Tested {at}',
  'row.poolCreditSoon': '{count} expiring within 3 days',
  'row.poolCreditNearest': 'Nearest package expires {at}',
  'row.poolExcludedRateLimited': 'Rate limited',
  // Same reason as `probeOutOfCredit*`: this bucket covers the whole quota
  // family, and the account measured for code 110 still had 500 credits —
  // "Out of credits" would contradict the credits number on the very same row.
  'row.poolExcludedOutOfCredit': 'Usage limit reached',
  'row.poolExcludedRejected': 'Rejected',
  'row.poolExcludedUnusable': 'Unusable',
  'row.poolRetryAt': 'Back after {at}',
  'row.poolRetryUnknown': 'The upstream gave no time for when this frees up',
  // 原因行尾的解禁提示：「Rate limited · unblocks in about 12 min」。
  // 用相对时长而不是绝对时刻 —— 读者要的是「还要等多久」。
  'row.unlockSuffix': 'unblocks {when}',
  'row.remainingImminent': 'any moment now',
  'row.remainingMinutes': 'in about {count} min',
  'row.remainingHours': 'in about {count} h',
  'row.remainingDays': 'in about {count} d',
  'row.poolProbeJustNow': 'just now',
  'row.poolProbeMinutesAgo': '{count} min ago',
  'row.poolProbeHoursAgo': '{count} h ago',
  'row.poolProbeDaysAgo': '{count} d ago',
  'row.poolProbeSourceTest': 'tested',
  'row.poolProbeSourceLive': 'hit by a live request',
  'row.poolProbeSourceUnknown': 'source unknown',
  'row.poolProbeOtherModel': 'measured on {model}',
  'row.poolProbeOtherModelHint': 'This result is about a different model — it says nothing about the currently selected one. Qoder rate-limits per model, so the same account can be fine on one and throttled on another.',
  'row.poolSettingsTitle': 'More settings',
  'row.poolSettingsHint': 'These are preferences: they take effect when you save (same as the model list). Test results are written automatically and are not affected by this button.',
  'row.poolEnabled': 'Enable the account pool',
  'row.poolEnabledHint': 'On: the pool picks the account for every request and moves to the next one when it fails. Off: the account you select serves every request, and a failure is reported as it is.',
  'row.poolModeAuto': 'picking automatically',
  'row.poolModeManual': 'you pick',
  'row.poolManualAccountLabel': 'Which account to use',
  'row.poolManualAccountNone': 'No account in effect',
  'row.poolTargetLabel': 'Test model (whole pool)',
  'row.poolTargetHint': 'One model for every account here — the test measures each row with it. Auto picks a zero-multiplier model from this region catalog, preferring the largest context window; a manual choice wins.',
  'row.poolTargetAutoOption': 'Auto — pick a free model',
  'row.poolTargetStaleOption': 'Saved target no longer offered: {model}',
  'row.poolProbeSizeLabel': 'Test request size',
  'row.poolProbeSizeHint': 'How much text a test sends. A larger test is more truthful but costs more credit each.',
  'row.poolProbeSizeDefault': 'Default (25K)',
  'row.poolProbeSizeOption': '{tokens}K tokens',
  'row.poolSaved': 'Save',
  'row.poolSaving': 'Saving…',
  'row.poolSaveFailed': 'Could not save: {message}',
  'row.poolSavedStaleRefresh': 'Saved, but the panel could not re-read it. The value is stored; the next refresh will show it.',
  'row.poolDiscard': 'Discard changes',
  'row.poolDirty': '● Unsaved changes',
  'row.poolLogTitle': 'Activity',
  'row.poolLogClear': 'Clear',
  'row.poolLogEmpty': 'Nothing yet. Tests and account switches are recorded here.',
  'row.poolLogTestStart': 'Testing {count} account(s) against {model}',
  'row.poolLogTestRow': '{accountName}: {outcome}',
  'row.poolLogTestDone': 'Test finished; the pool was re-ranked',
  'row.poolLogTestRowMalformed': '{accountName}: the host returned no result for this account',
  'row.poolLogBatchFailed': 'Batch failed — nothing ran: {message}',
  'row.poolMembersTitle': 'Accounts in this pool',
  'row.poolMembersHint': 'Only checked accounts rotate, get checked in, and get tested.',
  'row.poolSelectAll': 'Select all',
  'row.poolSelectNone': 'Clear all',
  'row.poolSelectedCount': '{count} of {total} selected',
  'row.poolNoneSelectedHint': 'Check at least one account to enable check-in and test.',
  'row.poolSelectAria': 'Include {accountName} in this region\'s account pool',
  'row.poolCurrentBadge': 'In use',
  'row.poolCurrentHeader': 'In use: {account}',
  'row.poolCurrentHeaderFailover': 'In use: {account} (taking over for the benched selection)',
  'row.poolCurrentBadgeFailover': 'Takeover',
  'row.poolCurrentHintFailover': 'The pool is on and the selected account is currently benched: every request still goes to the selection first, and only when it is rejected before the first byte does this account take over and get billed. That is why this row says "in use" while the selection reads "usage limit reached" — both are true.',
  'row.poolCurrentHintSelected': 'This account is the region\'s explicit selection, so requests go straight to it.',
  'row.poolCurrentHeaderUnavailable': 'No account usable right now',
  'row.poolCurrentHintUnavailable': 'Every member of this pool is benched (rate-limited, out of quota, rejected, or the model is busy) — including the saved selection. No row says "in use", because nothing is serving: the next request will fail rather than bill anyone. This clears on its own once an account\'s cooldown expires.',
  'row.poolNotMember': 'Not in pool',
  'row.poolServingOutside': '“{account}” is serving right now but is not in this pool: rotation will not pick it, and batch check-in and test will not touch it.',
  'row.poolUnsavedMembers': 'Selection changed — save to apply',
  'row.poolRowTest': 'Test',
  'row.poolRowDelete': 'Delete',
  'row.poolRowDeleteHint': 'Delete this account for good: its stored PAT is erased, and it drops out of the pool and the region selection. To only take it out of the rotation, untick it and save instead.',
  'row.poolRowDeleteAria': 'Delete the account {accountName}',
  'row.poolDeleteConfirm': 'Delete {accountName} for good? Its stored PAT is erased and cannot be recovered.',
  'row.poolDeleteConfirmAria': 'Confirm deleting {accountName}',
  'row.poolDeleteConfirmYes': 'Delete for good',
  'row.poolDeleteCancel': 'Keep it',
  'row.poolRowDeleting': 'Deleting the account…',
  'row.poolRowRemoved': '{accountName}: deleted, along with its stored PAT.',
  'row.poolErrNotDeletable': 'This account\'s PAT does not come from this plugin — it comes from the app\'s settings or the environment, where it is managed outside here. Remove it there instead.',
  'row.poolErrUnavailable': 'The account pool is not available in this build (or its batch route is missing). Restart the app; if it persists, the plugin needs reinstalling.',
  'row.poolErrFailed': 'The batch failed on the host side: {message}',
  'row.poolErrHttp': 'The batch was refused (HTTP {status}). Check the plugin is up to date and try again.',
  'row.poolErrNoMembers': 'No account is checked into this pool — the batch had nothing to run. Check at least one account and save.',
  'row.poolErrNoLiveMembers': 'No checked account currently has a usable PAT, so the batch had nothing to run.',
  'row.poolErrNoFreeModel': 'This region has no zero-multiplier model to test with. Refresh the model catalog, or pick a target model yourself.',
  'row.poolErrNoCheckin': 'This region has no daily check-in — the action is not offered here.',
  'row.poolErrStaleModel': 'The target model is no longer offered by this region. Pick another, or switch back to automatic.',
  // A 405 whose body was empty or unparseable did NOT come from this plugin: it
  // is the Host's HTTP layer answering for a route that was never registered —
  // i.e. a Host process still running older code. The fix is to restart DSH,
  // NOT to reinstall/upgrade this plugin. (Mirrors workbuddy fix for issue #86,
  // which otherwise told the user "confirm the plugin is up to date" while the
  // plugin was already current.)
  'row.poolErrRouteMissing': 'The batch route answered 405 with no response body. This is the host process answering for a route it never registered — restart the app; do not reinstall or upgrade this plugin.',
  'row.requestFailed': 'Request failed',
  'row.requestFailedHint': 'Refresh failed — showing the last loaded data: {message}',

  // ---- Composer credits ----
  'row.showCreditsCn': 'Show QD CN credits in the composer',
  'row.showCreditsGlobal': 'Show QD AI credits in the composer',
  'row.showCreditsCnHint': 'Show the CN (QD CN) credit balance in the composer toolbar, but only while this session uses a CN model. Click it for per-account balances and a manual refresh (refreshes by itself every 5 minutes).',
  'row.showCreditsGlobalHint': 'Show the international (QD AI) credit balance in the composer toolbar, but only while this session uses a global model. Click it for per-account balances and a manual refresh (refreshes by itself every 5 minutes).',
  'row.showCreditsCnDesc': 'A clickable readout in the composer toolbar (shown only while this session uses a CN model): "QD CN · balance". Where it sits is the next line.',
  'row.showCreditsGlobalDesc': 'A clickable readout in the composer toolbar (shown only while this session uses a global model): "QD AI · plan". Where it sits is the next line.',
  'row.creditPositionLabel': 'Position',
  'row.creditPositionAria': 'Credit readout position for {region}',
  'row.creditPositionComposer': 'In the composer toolbar',
  'row.creditPositionStats': 'Below the composer',
  'row.creditPositionHint': 'Where the credit readout sits. "In the composer toolbar" is the closer spot, but that row is a shared list slot — if another plugin parks something there and the readout disappears, choose "Below the composer" (the ambient row next to the session token counts).',
  'row.creditsForeignLabel': 'Also show for other connectors\' models',
  'row.creditsForeignHint': 'Cross-connector compare (issue #14): keep this region\'s readout on screen even while the session\'s selected model belongs to another connector, so both balances sit side by side. Off by default — the capsule normally follows the selected provider.',
  'composer.pointsCn': 'QD CN',
  'composer.pointsGlobal': 'QD AI',
  'composer.panelTitleCn': 'QD CN credits',
  'composer.panelTitleGlobal': 'QD AI credits',
  'composer.account': 'Account',
  'composer.credits': 'Credits',
  'composer.switchTo': 'Switch to {account}',
  'composer.noAccounts': 'No account in this region',
  'composer.signedOut': 'Not signed in',
  'composer.testAll': 'Test all',
  'composer.testing': 'Testing…',
  'composer.testAllHint': 'Probe every pool member once; the dots and reasons become what this run measured',
  'composer.testFailed': 'Could not run the test',
  'composer.refreshFailed': 'Could not refresh credits',
  'composer.lastRefresh': 'Last refreshed',
  'composer.dataStale': 'not updated',
  // 第二行的「当前选用」提示：能用的号本来就是绿点，哪一个是它靠这行字说。
  'composer.currentPick': 'In use',
  // 胶囊悬停：这个数字是**哪个号**的。池接管时胶囊与「选中」不是同一个号，
  // 不说清就会读成「我还有 773」而面板说在用 100 的那个（issue 截图的同款困惑）。
  'composer.billingAccount': 'Balance of the account billing right now: {name}',
  // 对比态的悬停（issue #14）：会话用的是别家连接器，「billing right now」会
  // 误导读者以为这个号在给本会话付钱 —— 换成明确「Qoder 侧」的归属说法。
  'composer.compareBillingAccount': 'Balance of Qoder-side billing account {name}',
  'composer.panelTitle': 'Qoder credits',
  // 机器读的一条：卡片用它问「宿主现在按哪种语言渲染」，好去上游的中英文案里挑
  // 对的那一条（见 `promo-badge.ts` 的 `hostLanguage`）。人不会看到它。
  'promo.locale': 'en',
} as const

export type QoderSettingsKey = keyof typeof en

export const zh: Record<QoderSettingsKey, string> = {
  'row.title': `接入使用 Qoder（通义灵码）积分与模型（${QODER_PACKAGE_NAME}）`,
  'row.desc': '在 DSH 中使用 Qoder（通义灵码 国内/国际）模型并随时查看剩余积分；国内版与国际版是两个独立供应商（qoder / qoder-global），各有自己的 PAT 与账号，可同时使用。',
  'row.expand': '展开',
  'row.collapse': '收起',
  'row.tabCn': '国内版',
  'row.tabGlobal': '国际版',
  'row.tabHint': '每个 tab 是一个独立供应商（qoder / qoder-global），各有自己的 PAT、账号、积分与模型。两边同时生效：不同会话可各选一边，一侧的改动不影响另一侧。',
  'row.tabSwitchHint': '取消勾选即关闭该供应商：它的模型不再出现在 DSH 模型选择器里；PAT、账号、积分与模型设置都会保留，重新勾选即恢复。',
  'row.tabSwitchAria': '是否向 DSH 提供{region}供应商',
  'row.tabOffNotice': '该供应商已关闭：它的模型不会提供给 DSH。PAT、账号、积分与模型设置均已保留——勾选上方复选框即可恢复。',

  // ---- 卡片分栏（账号 / 模型 / 诊断） ----
  // 卡片上并着两件互不相干的事：运维账号（谁在服务、剩多少、池里哪几个）与编辑
  // 目录（勾哪些模型、上下文预算、思考档位）。它们连提交语义都不同——账号改动
  // 点一下即生效，目录改动是草稿、要点保存——所以排成一列时，保存按钮离它保存
  // 的东西隔着好几屏。
  'row.panelAccounts': '账号',
  'row.panelModels': '模型',
  'row.panelDiag': '诊断',
  'row.panelAria': '卡片分区',
  'row.diagHint': '这张卡片实际读到了什么，方便整段贴进问题反馈。这里没有任何会改动设置的控件。',
  'row.diagRegion': '区域',
  'row.diagDomain': '上游域名',
  'row.diagAccount': '当前服务账号',
  'row.diagSource': '凭据来源',
  'row.diagCreditsAt': '积分读取于',
  'row.diagCatalog': '目录中的模型',
  'row.diagEnabled': '已启用的模型',
  'row.diagPool': '账号池',
  'row.diagPoolOn': '{count} 个账号',
  'row.diagPoolOff': '关闭',
  'row.diagFailures': '最近一次失败',
  'row.diagNoFailures': '没有报错。',

  // ---- PAT / 账号列表 ----
  'row.patLabel': 'PAT（Personal Access Token）',
  'row.patPlaceholder': 'pt-… 粘贴到这里；留空则读环境变量',
  'row.patHint': '只在本地保存到插件配置。优先于环境变量。',
  'row.patEnvHint': '也可设置环境变量 {var}',
  'row.accountsHint': '本区域生效的账号，从设置中的 PAT、环境变量 PAT 与插件保险库中选择。',
  'row.accountSelectLabel': '生效账号',
  'row.accountSelectAuto': '自动 —— 设置 → 环境变量 → 保险库',
  'row.accountSelectAria': '选择哪个账号服务本区域',
  'row.accountsScanning': '正在读取…',
  'row.accountsLoading': '正在加载账号…',
  'row.accountSourceSettings': '设置 PAT',
  'row.accountSourceEnv': '环境变量 PAT',
  'row.accountSourceVault': '保险库',
  'row.accountUnnamed': '未命名账号',
  'row.accountRemoving': '正在删除账号…',
  'row.accountsWriteFailed': '账号改动未保存：{message}',
  'row.selectionLostHint': '已保存的账号已不在可用的 PAT 之中。',
  'row.selectionLostMessage': '该区域保存的账号已不在可用的 PAT 来源（设置 / 环境变量 / 保险库）中。请在上方重新选择一个当前账号；仅添加新 PAT 并不会单独修复这个丢失的选择。',

  // ---- 凭据被拒 ----
  'row.credentialRejectedTitle': 'Qoder 拒绝了这个账号的 PAT',
  'row.credentialRejectedIntro': '「{accountName}」的 PAT 已不被 Qoder 接受，因此这里的积分与测试都不可用。重新添加同一个 PAT 没有意义——当前实际适用的是：',
  'row.credentialRejectedSwitch': '本区域另一个账号「{accountName}」刚刚实测可用，切换到它即可恢复；若你还没有它的 PAT，请先添加。',
  'row.credentialRejectedSwitchAction': '切换到「{accountName}」',
  'row.credentialRejectedRelogin': '本区域没有其他可切换的账号。请为本区域添加一个有效的 PAT。',
  'row.credentialRejectedChoose': '本区域还有其他账号，但刚才都没能通过上游校验。可以在上方切换一个试试；如果都不行，请添加一个全新的 PAT。',

  // ---- 导出 / 导入 ----
  'row.transferTitle': '导出 / 导入账号',
  'row.transferHint': '用 JSON 文件在电脑之间迁移 PAT 账号。文件里是账号凭据——请妥善保管。',
  'row.transferExport': '导出账号',
  'row.transferExporting': '正在导出…',
  'row.transferExportPick': '选择要导出的账号（共 {total} 个）：',
  'row.transferExportConfirm': '导出 {count} 个账号',
  'row.transferExported': '已导出 {count} 个账号到 {fileName}。',
  'row.transferImport': '导入账号',
  'row.transferImporting': '正在导入…',
  'row.transferPreviewing': '正在读取文件…',
  'row.transferPreviewTotal': '文件中共 {total} 个账号——不需要的请取消勾选。导入会覆盖这里已存储的同名账号。',
  'row.transferImportConfirm': '导入 {count} 个账号',
  'row.transferImported': '已导入 {imported} 个账号；跳过 {skipped} 个（缺 token，或属于另一个区域）。',
  'row.transferEntryUnknown': '未知账号',
  'row.transferNoToken': '此记录没有 token',
  'row.transferCancel': '取消',
  'row.transferError': '传输失败：{message}',

  // ---- 添加 PAT ----
  'row.addAccountTitle': '添加一个 PAT',
  'row.addAccountStart': '添加 PAT',
  'row.addAccountPlaceholder': '在此粘贴一个 Qoder PAT（pt-…）',
  'row.addAccountNameHint': '可选显示名（验证通过的 token 会自动取一个）',
  'row.addAccountPatHint': '登录网页 {domain} → 服务集成 → 新建令牌（另一个区域域名不同）',
  'row.addAccountValidating': '正在验证…',
  'row.addAccountDone': '已添加「{accountName}」，它现在为这个区域服务。',
  'row.addAccountError': '无法添加此 PAT：{message}',
  'row.addAccountInvalid': '这不是 PAT 的格式（期望 pt-…）。',
  'row.addAccountTouchedOnce': '会用区域网关验证该 token，通过后账号会出现在上方。',
  'row.addAccountDialogClose': '关闭',

  // ---- 共用缓冲遮罩 ----
  'row.veilHintList': '完成后列表会立即刷新。',
  'row.addAccountSyncing': '正在添加账号…',

  // ---- 积分 ----
  'row.creditsError': '积分查询失败：{message}',
  'row.usageTitle': '额度',
  'row.usageUnavailable': '额度暂不可用（未配置 PAT，或上游未响应）。',
  'row.usageBucketBase': '基础额度',
  'row.usageBucketAddon': '附加额度',
  'row.usageBucketOrg': '组织额度',
  'row.usageUsed': '已用',
  'row.usageTotal': '总量',
  'row.usageExpiresAt': '{at} 到期',
  'row.usageExpired': '已到期',
  'row.refreshUsage': '刷新额度',
  'row.refreshingUsage': '正在刷新额度…',

  // ---- 模型 ----
  'row.modelsTitle': '模型',
  'row.modelsSummary': '已启用 {count} 个',
  'row.modelsDirty': '有未保存的修改',
  'row.modelsRefresh': '从 Qoder 刷新',
  'row.modelsRefreshing': '正在刷新模型…',
  'row.discard': '放弃修改',
  'row.save': '保存',
  'row.saving': '保存中…',
  'row.saveError': '保存失败：{message}',
  'row.saveContentionHint': '（该文件被占用，写入被拒——Windows 上通常是杀毒软件、OneDrive 这类同步盘，或正打开该文件的编辑器。请先关闭占用者再保存一次；你的改动仍然还在。）',
  'row.modelContext': '最大上下文 {context}',
  'row.contextBudget': '上下文',
  'row.modelOutput': '最大输出 {output}',
  'row.modelReasoningLabel': '思考强度',
  'row.modelReasoningFollowUpstream': '跟随上游默认',
  'row.modelReasoningFollowUpstreamNamed': '{effort}（上游默认）',

  'row.modelMultimodal': '多模态',
  'row.modelFree': '免费',
  // 见 en 侧同名注释：上游只给 `is_free` 布尔量，这句解释由插件自己写。
  'row.modelFreeHint': '倍率为 0，不消耗积分',
  // 窗口外灰显时的悬停前缀，见 en 侧同名注释。
  'row.promoPending': '当前未生效，{start} 起生效',
  'row.modelImage': '图片',
  'row.modelImageText': '厂商文档标注该模型为纯文本，不接收图片输入',
  'row.modelImageUnverified': '该模型的原生多模态能力未经核实；除非你确定它能读图，否则请保持关闭',
  'row.modelOff': '可关闭思考',
  'row.modelOffHint': '为这个模型提供「关闭思考」档位',
  'row.modelFallback': '内置目录（上游暂不可达）',
  'row.modelNoProbe': '测试',
  'row.modelUnknown': '未知',
  'row.modelCapabilityPending': '仅展示 Qoder 接口明确公布的模型能力。',
  'row.probe': '测试',
  'row.probing': '测试中…',
  'row.probeHint': '对该模型发一条真实聊天请求，报告它现在能不能用。会消耗少量额度，且一次只测一个模型。',
  'row.probeOk': '✓ 可用',
  'row.probeOkMs': '✓ 可用（{ms}）',
  'row.probeRateLimitedUnknown': '✗ 被限流 · 上游未给出何时恢复',
  'row.probeRateLimitedAt': '✗ 被限流 · {at} 之后可再用',
  // 「用量已达上限」而不是「积分不足」：这一档收的是整个配额族（官方码表 110
  // 当日次数用尽 / 113 配额耗尽 / 115-119 Credits 耗尽 / 122 Billing Group 上限）。
  // 实测 110 那个账号**还有 500 积分**、`isQuotaExceeded: false` —— 说「积分不足」
  // 是第二句自相矛盾的话（本轮刚为第一句发过 0.4.1）。恢复时刻也可能来自上游
  // 的重置句子而非积分包到期，所以 {at} 不带「积分包」这个限定。
  'row.probeOutOfCreditUnknown': '✗ 用量已达上限 · 上游未给出何时恢复',
  'row.probeOutOfCreditAt': '✗ 用量已达上限 · {at} 恢复',
  'row.probeCredentialRejected': '✗ Qoder 拒绝了这个账号的 PAT——请添加新 PAT 或换一个账号',
  'row.probePolicyRejected': '✗ Qoder 服务端按内容策略拒绝了这次请求——重新添加 PAT 无效',
  'row.probeNotFound': '✗ 上游不认识这个模型',
  'row.probeUnavailable': '✗ 连不上上游——上游没有给出可用答复',
  'row.probeFailed': '✗ 测试失败',
  'row.probeFailedStatus': '✗ 测试失败（HTTP {status}）',
  'row.probeError': '无法执行测试：{message}',
  'row.cheer': '鼓励一下',
  'row.docsHint': '如何创建 PAT？',

  // ---- 账号池 ----
  'row.poolTitle': '账号池',
  'row.poolNoCandidate': '账号池里目前没有可用的账号。',
  // 用「用量已达上限」而不是「积分耗尽」，与 `poolExcludedOutOfCredit` 芯片同一
  // 口径：这档收的是整个配额族（含官方 110 当日次数用尽），而实测那个账号
  // **还有 500 积分** —— 一句话里两个说法会当面对撞。
  'row.poolNoCandidateHint': '成员要么在限流冷却中、要么用量已达上限、要么凭据被拒、要么上游无响应。限流、用量上限与瞬时故障都会自动回池——按上游给出的恢复时间，没给时间就按 30 分钟兜底，不需要你操作；只有「凭据被拒」需要换一个新 PAT。',
  'row.poolEmptyHint': '这个区域还没有账号。用上面的「添加 PAT」粘贴一个，或用「导出 / 导入账号」把别的机器上的账号搬过来 —— 账号池、模型测试与每日签到都需要至少一个账号。',
  'row.poolTestAll': '测试勾选的账号',
  'row.poolCheckinAll': '签到勾选的账号',
  'row.poolCheckingIn': '签到中…',
  'row.poolLogCheckinStart': '开始为 {count} 个账号签到',
  'row.poolLogCheckinClaimed': '{accountName}：已领取',
  'row.poolLogCheckinClaimedAmount': '{accountName}：已领取 {credit} Credits',
  'row.poolLogCheckinAlready': '{accountName}：今天已领过',
  'row.poolLogCheckinFailed': '{accountName}：签到失败 — {message}',
  'row.poolLogCheckinDone': '签到完成',
  'row.poolTesting': '测试中…',
  'row.poolBusyHint': '正在逐个账号执行…',
  'row.poolTargetAuto': '自动',
  'row.poolTargetFree': '自动选中的免费模型：{model}',
  'row.poolTargetPreferred': '你指定的模型：{model}',
  'row.poolTargetCurrentPreferred': '当前：{model}（你指定）。',
  'row.poolTargetCurrentFree': '当前：{model}（自动挑选的免费模型）。',
  'row.poolTargetNone': '本区域暂时没有倍率为 0 的免费模型。',
  'row.poolRank': '第 {rank} 位',
  'row.poolRankAuto': '自动排序',
  'row.poolRankHint': '这个顺序是你手动排的。请求会优先发给排在前面且可用的账号。',
  'row.poolRankExcluded': '第 {rank} 位 · 暂不参与',
  'row.poolRankExcludedHint': '你把它排在了这个位置，但它此刻被排除，所以排在所有可用账号之后，直到恢复。',
  'row.poolRankAutoHint': '还没有手动排序：池会先花临期积分，再按余额多寡选号。用 ↑/↓ 自己指定顺序。',
  'row.poolMoveUp': '提高优先级',
  'row.poolMoveDown': '降低优先级',
  'row.poolMoveAria': '{accountName} 的优先级顺序',
  'row.poolTargetNoneHint': '本区域的倍率要等模型目录刷新后才会出现。为了不让你在不知情的情况下花掉积分，在免费模型出现之前测试会保持关闭——请先在「模型」区刷新模型目录，或自己指定一个目标模型。',
  'row.poolTargetStale': '你保存的目标模型已不在目录中：{model}',
  'row.poolTargetStaleHint': '本区域的模型目录已变化，不再包含这个模型，因此测试被停用。请改选一个目标模型，或切回自动。',
  'row.poolTargetStaleClear': '切回自动',
  'row.poolTargetStaleShort': '目标模型已失效',
  'row.poolTargetNoneShort': '无免费模型',
  'row.poolColumnAccount': '账号',
  'row.poolColumnCredits': '积分',
  'row.poolColumnProbe': '状态',
  'row.poolColumnCheckin': '签到',
  'row.poolCheckedIn': '已签到',
  'row.poolNotCheckedIn': '未签到',
  'row.poolCheckinUnknown': '—',
  // 倒计时是**上游给的**下一窗开窗时刻（活动行的 `endAt`），不是本地猜的：每日活动
  // 窗是 10:00 → 次日 09:59（UTC+8），也就是 Qoder 网页上显示的那个数。
  //
  // **措辞必须点明这个数字是什么**（用户实拍：「已签到 · 00:39:22 后刷新」）。
  // 「后刷新」字面说的是这一行数据什么时候更新，而数字其实是**什么时候可以再签** ——
  // 两者混在一格，读起来就成了「已经签完了，却又 39 分钟后刷新」，自相矛盾。
  'row.poolCheckinNext': '{countdown} 后可再签到',
  'row.poolCheckinNextHint': '这一窗已经签到过了。这个数字是下一窗什么时候开（到点就能再签），与 Qoder 网页上的倒计时是同一个数 —— 不是「这一行多久刷新」。',
  // 到点之后**不再重复「已签到」**：那是上一窗的状态，而此刻下一窗已经开了。
  // 两者并排（「已签到 · 现在可以签到」）就是一句自相矛盾的话。
  'row.poolCheckinDue': '现在可以签到',
  'row.poolCheckinDueHint': '下一窗已经开了，这个账号现在可以再签。「已签到」说的是上一窗，所以这里不再重复它。',
  'row.poolNeverTested': '未测试',
  'row.poolTestedAt': '测试于 {at}',
  'row.poolCreditSoon': '{count} 积分 3 天内过期',
  'row.poolCreditNearest': '最近积分包 {at} 过期',
  'row.poolExcludedRateLimited': '被限流',
  // 与 `probeOutOfCredit*` 同一理由：这一档收的是整个配额族，实测 110 的账号
  // 还有 500 积分 —— 芯片说「积分耗尽」会与同一行的积分数字当面对撞。
  'row.poolExcludedOutOfCredit': '用量已达上限',
  'row.poolExcludedRejected': '被拒绝',
  'row.poolExcludedUnusable': '不可用',
  'row.poolRetryAt': '{at} 之后可再用',
  'row.poolRetryUnknown': '上游未给出何时恢复',
  // 原因行尾的解禁提示：「被限流 · 约 12 分钟后解禁」。
  // 用相对时长而不是绝对时刻 —— 读者要的是「还要等多久」。
  'row.unlockSuffix': '{when}解禁',
  'row.remainingImminent': '即将恢复',
  'row.remainingMinutes': '约 {count} 分钟后',
  'row.remainingHours': '约 {count} 小时后',
  'row.remainingDays': '约 {count} 天后',
  'row.poolProbeJustNow': '刚刚',
  'row.poolProbeMinutesAgo': '{count} 分钟前',
  'row.poolProbeHoursAgo': '{count} 小时前',
  'row.poolProbeDaysAgo': '{count} 天前',
  'row.poolProbeSourceTest': '测得',
  'row.poolProbeSourceLive': '聊天撞上',
  'row.poolProbeSourceUnknown': '来源未知',
  'row.poolProbeOtherModel': '针对 {model} 测得',
  'row.poolProbeOtherModelHint': '这条结论是针对另一个模型的，对当前选中的模型不作数。Qoder 按模型限流，同一个账号可能在一个模型上正常、在另一个上被限。',
  'row.poolSettingsTitle': '更多设置',
  'row.poolSettingsHint': '下面是偏好设置：点保存才生效（与「模型管理」一致）。测试结果由插件自动写入，不受这个保存按钮影响。',
  'row.poolEnabled': '启用账号池',
  'row.poolEnabledHint': '开启：由账号池为每次请求挑号，失败就换下一个。关闭：你选的账号服务每一次请求，失败如实报错。',
  'row.poolModeAuto': '自动挑号',
  'row.poolModeManual': '手动选号',
  'row.poolManualAccountLabel': '使用哪个账号',
  'row.poolManualAccountNone': '当前没有生效的账号',
  'row.poolTargetLabel': '测试用模型（全池统一）',
  'row.poolTargetHint': '全池共用这一个模型，测试就是拿它逐个去测。「自动」会从本区域目录里挑一个倍率为 0 的免费模型，多个候选取上下文窗口最大的；手动指定优先于自动。',
  'row.poolTargetAutoOption': '自动 —— 挑一个免费模型',
  'row.poolTargetStaleOption': '已保存的目标已下架：{model}',
  'row.poolProbeSizeLabel': '测试请求体积',
  'row.poolProbeSizeHint': '测试时发送多少文本。体积越大测得越准，但每次测试消耗的额度也越多。',
  'row.poolProbeSizeDefault': '默认（2.5 万）',
  'row.poolProbeSizeOption': '{tokens} 万 token',
  'row.poolSaved': '保存',
  'row.poolSaving': '保存中…',
  'row.poolSaveFailed': '保存失败：{message}',
  'row.poolSavedStaleRefresh': '已保存，但面板未能重新读取。设置已写入；下次刷新后会显示。',
  'row.poolDiscard': '放弃修改',
  'row.poolDirty': '● 有未保存的修改',
  'row.poolLogTitle': '活动记录',
  'row.poolLogClear': '清空',
  'row.poolLogEmpty': '尚无活动。测试与账号切换都会记录在这里。',
  'row.poolLogTestStart': '开始测试 {count} 个账号 × {model}',
  'row.poolLogTestRow': '{accountName}：{outcome}',
  'row.poolLogTestDone': '测试完成，已重新计算候选账号',
  'row.poolLogTestRowMalformed': '{accountName}：Host 未返回该账号的结果',
  'row.poolLogBatchFailed': '批量操作失败 —— 没有执行：{message}',
  'row.poolMembersTitle': '本池包含的账号',
  'row.poolMembersHint': '只有勾选的账号参与轮换、签到与测试。',
  'row.poolSelectAll': '全选',
  'row.poolSelectNone': '全不选',
  'row.poolSelectedCount': '已选 {count} / {total}',
  'row.poolNoneSelectedHint': '勾选至少一个账号，才能签到与测试。',
  'row.poolSelectAria': '把 {accountName} 加入本区域的账号池',
  'row.poolCurrentBadge': '当前使用',
  'row.poolCurrentHeader': '当前使用：{account}',
  // 接管态的标题芯片（池开着、选中号被排除时，current 落在接管者身上）。
  // 用户实拍曾见「当前使用」与「用量已达上限」并存 —— 方向要说清楚：每个
  // 请求仍先打给选中号，首字节前被拒才由这个号接管并计费。两个事实必须一起
  // 出现，否则「当前使用」读起来像撒谎。
  'row.poolCurrentHeaderFailover': '当前使用：{account}（为被排除的选中号接管）',
  'row.poolCurrentBadgeFailover': '接管中',
  'row.poolCurrentHintFailover': '池已开启，且你选中的账号此刻被排除：每个请求仍先发给选中号，它在首字节前被拒绝时才由这个账号接管并计费。所以这一行标「当前使用」、选中号那行写「用量已达上限」——两句话都对。',
  'row.poolCurrentHintSelected': '区域手动选中的就是这个账号，请求直接发给它。',
  'row.poolCurrentHeaderUnavailable': '当前没有可用的账号',
  'row.poolCurrentHintUnavailable': '这个池里的成员全都被挡在门外（限流、积分耗尽、凭据被拒，或者模型正忙）——包括你保存的那个选择。所以没有一行标「当前使用」：此刻没有任何账号在服务，下一个请求会直接失败而不是记在谁头上。冷却时间一到会自动恢复。',
  'row.poolNotMember': '未入池',
  'row.poolServingOutside': '「{account}」正在使用，但不在这个池里：轮换不会挑它，批量签到与测试也不会动它。',
  'row.poolUnsavedMembers': '勾选已改动 —— 保存后生效',
  'row.poolRowTest': '测试',
  'row.poolRowDelete': '删除',
  'row.poolRowDeleteHint': '彻底删除这个账号：它的 PAT 会被抹掉，并自动退出账号池与该区域的选择。如果只想让它不参与轮换，取消勾选并保存即可。',
  'row.poolRowDeleteAria': '删除账号 {accountName}',
  'row.poolDeleteConfirm': '彻底删除 {accountName}？它保存的 PAT 会被抹掉，找不回来。',
  'row.poolDeleteConfirmAria': '确认删除 {accountName}',
  'row.poolDeleteConfirmYes': '彻底删除',
  'row.poolDeleteCancel': '保留',
  'row.poolRowDeleting': '正在删除账号…',
  'row.poolRowRemoved': '{accountName}：已删除，保存的 PAT 一并抹掉。',
  'row.poolErrNotDeletable': '这个账号的 PAT 不是本插件存的（来自应用设置或环境变量），由插件之外管理。请到那里删除。',
  'row.poolErrUnavailable': '本版本没有可用的账号池（或其批量接口缺失）。请重启应用；若仍不行，插件可能需要重新安装。',
  'row.poolErrFailed': '批量操作在宿主侧失败：{message}',
  'row.poolErrHttp': '批量操作被拒绝（HTTP {status}）。请确认插件是最新版本后重试。',
  'row.poolErrNoMembers': '本池没有勾选任何账号，批量操作没有可执行对象。请至少勾选一个账号并保存。',
  'row.poolErrNoLiveMembers': '本池勾选的账号当前都没有可用的 PAT，批量操作没有可执行对象。',
  'row.poolErrNoFreeModel': '本区域没有可用的免费（倍率为 0）模型。请先刷新模型目录，或自己指定一个目标模型。',
  'row.poolErrNoCheckin': '本区域没有每日签到 —— 这里不提供该操作。',
  'row.poolErrStaleModel': '目标模型已不在本区域目录中。请改选一个，或切回自动。',
  // 405 且响应体为空或不可解析时，说明不是本插件拒绝该方法，而是宿主 HTTP 层
  // 在为一个从未注册的路由作答——即宿主进程仍在跑更旧的构建。修复方式是重启应用，
  // 而不是重装或升级本插件。（对应 workbuddy 对 #86 的修复，否则会误导用户
  // "请确认插件是最新版本"，而插件其实已经是最新的。）
  'row.poolErrRouteMissing': '批量接口返回 405 且响应体为空。这是宿主进程在为一个从未注册的路由作答——请重启应用；不要重装或升级本插件。',
  'row.requestFailed': '请求失败',
  'row.requestFailedHint': '刷新失败——下方为上次加载的数据：{message}',

  // ---- 对话框积分 ----
  'row.showCreditsCn': '在对话框显示 QD CN 积分',
  'row.showCreditsGlobal': '在对话框显示 QD AI 积分',
  'row.showCreditsCnHint': '在对话输入框工具栏显示国内版（QD CN）剩余额度，仅当本会话使用 CN 模型时出现。点击可看各账号余额并手动刷新（每 5 分钟也会自动刷新）。',
  'row.showCreditsGlobalHint': '在对话输入框工具栏显示国际版（QD AI）剩余额度，仅当本会话使用国际版模型时出现。点击可看各账号余额并手动刷新（每 5 分钟也会自动刷新）。',
  'row.showCreditsCnDesc': '在输入框工具栏显示可点击读数（选中国内版模型时出现）：「QD CN · 余额」。读数位置在下一行。',
  'row.showCreditsGlobalDesc': '在输入框工具栏显示可点击读数（选中全球版模型时出现）：「QD AI · 套餐」。读数位置在下一行。',
  'row.creditPositionLabel': '显示位置',
  'row.creditPositionAria': '{region} 积分读数的位置',
  'row.creditPositionComposer': '输入框工具栏',
  'row.creditPositionStats': '输入框下方',
  'row.creditPositionHint': '积分读数放在哪里。「输入框工具栏」位置更近，但那一行是共享的 list 插槽——若另一个插件也把东西停在那里、读数消失，就选「输入框下方」（会话 token 统计旁边那行常驻栏）。',
  'row.creditsForeignLabel': '其他连接器的模型选中时也显示',
  'row.creditsForeignHint': '跨连接器对比（issue #14）：会话当前模型属于别的连接器时，本区域的积分读数仍显示在原位，与对方读数并排，方便对比两边余额再决定切哪家。默认关闭——胶囊本来跟着选中的 provider 走。',
  'composer.pointsCn': 'QD CN',
  'composer.pointsGlobal': 'QD AI',
  'composer.panelTitleCn': 'QD CN 积分',
  'composer.panelTitleGlobal': 'QD AI 积分',
  'composer.account': '账号',
  'composer.credits': '积分',
  'composer.switchTo': '切换到 {account}',
  'composer.noAccounts': '该区域暂无账号',
  'composer.signedOut': '未登录',
  'composer.testAll': '一键测试',
  'composer.testing': '正在测试…',
  'composer.testAllHint': '对每个池成员各发一次试问，测完圆点与原因就是这一轮的结论',
  'composer.testFailed': '一键测试失败',
  'composer.refreshFailed': '积分刷新失败',
  'composer.lastRefresh': '最近刷新',
  'composer.dataStale': '未更新',
  // 第二行的「当前选用」提示：能用的号本来就是绿点，哪一个是它靠这行字说。
  'composer.currentPick': '当前选用',
  // 胶囊悬停：这个数字是**哪个号**的，见 en 侧同名注释。
  'composer.billingAccount': '当前计费的账号：{name}',
  // 对比态的悬停（issue #14），见 en 侧同名注释。
  'composer.compareBillingAccount': 'Qoder 侧计费账号 {name} 的余额',
  'composer.panelTitle': 'Qoder 积分',
  // 机器读的一条，见 en 侧同名的注释。
  'promo.locale': 'zh-CN',
}

/** Localized copy lookup, with optional interpolation. */
export type Translate = (key: QoderSettingsKey, params?: Record<string, unknown>) => string

export interface QoderLocale {
  zh: Record<QoderSettingsKey, string>
  en: Record<QoderSettingsKey, string>
}
export const qoderLocales: QoderLocale = { zh, en }

/** 模板字符串渲染（{var} → value）。 */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`)
}