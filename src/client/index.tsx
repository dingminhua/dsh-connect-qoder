/**
 * Browser half: Qoder model management inside Plugin configuration.
 *
 * 注册形态沿用 dsh-connect-workbuddy 的 `client/index.tsx`：`slots` /
 * `locale` 两项注入、`LocaleNamespaceMap` 模块增强、`plugins.bundle.config`
 * 与 `plugins.row.config` 槽位 + `key` / `priority` 写法；apply 体包
 * try/catch 以便槽位 API 变更时降级为 console.error 而不触发红色横幅。
 *
 * @module dsh-connect-qoder/client
 */

import { QODER_SETTINGS_NS } from '../status-paths.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { QoderCard } from './QoderCard.tsx'
import type { QoderCardInjected } from './QoderCard.tsx'
import { ComposerCreditsGate } from './ComposerCreditsGate.tsx'
import { qoderLocales } from './locales.ts'
import type { QoderSettingsKey } from './locales.ts'
import { QODER_CARD_SLOT_KEYS } from './slot-keys.ts'

export type QoderClientContext = Context & {
  slots: Context['slots']
  locale: Context['locale']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Qoder plugin card copy. */
    'settings.qoder': QoderSettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-connect-qoder-client'

/** Client services required by the Plugin configuration contribution. */
export const inject = ['slots', 'locale']

/** Register card copy and the Qoder card under Plugin configuration. */
export function apply(ctx: QoderClientContext): void {
  try {
    const namespace = 'settings.qoder'
    ctx.effect(() => ctx.locale.register(namespace, qoderLocales), 'dsh-connect-qoder: settings copy')
    const t = ctx.locale.bind(namespace) as QoderCardInjected['t']

    const softGet = (name: string): unknown => (ctx as unknown as { get(name: string): unknown }).get(name)

    let settingsScope: QoderCardInjected['settingsScope'] | undefined
    const forms = softGet('configForms') as
      | {
          describe(): { getSnapshot(): { view?: { namespaces?: { ns: string }[] } } }
          get(ns: string): QoderCardInjected['settingsScope']
        }
      | undefined
    if (forms !== undefined) {
      // The namespace is the Host's Loader entry id; ask the mirror rather
      // than assume a name (exact match on the Host side).
      let ns: string = QODER_SETTINGS_NS
      try {
        const namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
        const served = namespaces.find(entry => entry.ns === QODER_SETTINGS_NS || /qoder/i.test(entry.ns))
        if (served !== undefined) ns = served.ns
      } catch { /* mirror not ready: the declared id is still correct */ }
      settingsScope = forms.get(ns)
    }

    const registerCard = (slotName: string, key: string): void => {
      try {
        ctx.slots.inject(slotName as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; key: string; priority: number; inject: () => QoderCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: slotName,
          key,
          priority: 30,
          inject: () => settingsScope === undefined
            ? { t }
            : { t, settingsScope },
        }, QoderCard))
      } catch (error: unknown) {
        console.error(`[dsh-connect-qoder] card slot "${slotName}" failed to register (host provider unaffected):`, error)
      }
    }

    // Slot keys are keyed by PACKAGE identity, not by our settings namespace:
    // `plugins.bundle.config` wants the bare package name and
    // `plugins.row.config` wants `<package name>#<row id>`. Both are built from
    // the build-injected package name — see `slot-keys.ts` for why hardcoding
    // them made the card render nothing after the scoped rename.
    registerCard('plugins.bundle.config', QODER_CARD_SLOT_KEYS.bundle)
    registerCard('plugins.row.config', QODER_CARD_SLOT_KEYS.row)

    /**
     * Credit readout in the composer tool row (`conversation.input.left`, a
     * session-scope list slot).
     *
     * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
     *   — 该项目的 `registerComposerCredits`：无条件注册插槽、由 gate 读
     *     `modelSelection` 投影自行决定是否渲染。Qoder 沿用同一形态；不同在于
     *     读数标注与 provider 路由不同（`qoder` / `qoder-global`）。
     *
     * Provider-scoped on purpose: it renders only while the session's selected
     * model belongs to this plugin, which keeps two connector plugins from
     * competing for one shared row. Registration is unconditional; the gate
     * reads the Host's `modelSelection` projection and returns null for every
     * other provider.
     */
    const registerComposerCredits = (): void => {
      try {
        ctx.slots.inject('conversation.input.left' as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; id: string; order: number; locale: string; inject: () => QoderCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: 'conversation.input.left',
          id: 'dsh-connect-qoder-composer-credits',
          order: 4,
          locale: namespace,
          // `settingsScope` rides along so the gate can honor the card's
          // per-region switch without a second writer.
          inject: () => settingsScope === undefined
            ? { t }
            : { t, settingsScope },
        }, ComposerCreditsGate))
      } catch (error: unknown) {
        console.error('[dsh-connect-qoder] composer credits slot failed to register (host provider unaffected):', error)
      }
    }

    registerComposerCredits()
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    console.error('[dsh-connect-qoder] client apply failed:', error)
  }
}