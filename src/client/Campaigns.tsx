/**
 * Card section: the provider's campaigns (活动) for one region.
 *
 * Answers the readout the host's `/campaigns` route produces for `/me/campaigns`:
 * the daily 100-Credits check-in row plus every `VIEW_DETAILS` banner the upstream
 * currently sends. Read-only — nothing here writes to the account. Claiming stays
 * where it has always been (the account-pool 签到 column, a deliberate user action).
 *
 * 为什么单独成一个文件而不是塞进 `QoderCard`：这份渲染有自己的状态（每个区域一次
 * 懒加载、错误态、AbortController 清理）和一套独立样式，`QoderCard` 已经很长了。
 *
 * 三个刻意的取舍：
 * 1. **不发明标题**——只有上游 `placements[].content.{zh,en}` 给了标题才显示，
 *    空则退回 `row.campaignUntitled`，绝不拿 campaignId 编一句「限时活动」；
 * 2. **不画绝对到期时间**——`endAt` 是 UTC 时间戳，把它换算成当地墙上时间很容易
 *    写错时区（上游文案自己已经写清「每日 10:00（UTC+8）刷新」），所以这里只呈现
 *    状态词（可领取 / 已领取）与上游给到的描述；
 * 3. **上游没下发就不出现**——`campaigns: []` 时只显示一行静默的「暂无活动」，
 *    不会凭空造一个 banner；读取失败显示原因，而不是把「读不到」伪装成「没有」。
 *
 * @module dsh-connect-qoder/client/Campaigns
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { QODER_CAMPAIGNS_PATH, withQoderRegion } from '../status-paths.ts'
import type { QoderWebRegion } from '../status-paths.ts'
import type { QoderCampaign, QoderCampaignContent, QoderCampaignFeed } from '../upstream.ts'
import { hostLanguage } from './promo-badge.ts'
import type { Translate } from './locales.ts'

/** 每行状态词对应的本地化键。 */
const CLAIM_KEYS = {
  CLAIMABLE: 'row.campaignClaimable',
  CLAIMED: 'row.campaignClaimed',
} as const

/** 上游状态 → 本地化键；未知状态不渲染状态词（只给标题/描述/链接）。 */
function claimKeyOf(status: string | undefined): keyof typeof CLAIM_KEYS | undefined {
  if (status === 'CLAIMABLE' || status === 'CLAIMED') return status
  return undefined
}

/** 该语言是否属于英语（与 `promo-badge.ts` 的同一判据）。 */
function isEnglish(language: string | undefined): boolean {
  return (language ?? '').toLowerCase().startsWith('en')
}

/** 按界面语言取上游的双语活动文案；缺哪边用另一边。 */
function pickContent(content: Record<string, QoderCampaignContent> | undefined, language: string): QoderCampaignContent | undefined {
  if (content === undefined || Object.keys(content).length === 0) return undefined
  const direct = isEnglish(language) ? 'en' : 'zh'
  const fallback = isEnglish(language) ? 'zh' : 'en'
  return content[direct] ?? content[fallback]
}

/**
 * 一行活动最终渲染要用的字段；`detailUrl` 可能仍为空（上游两者都没给）。
 */
interface CampaignRow {
  key: string
  title: string
  description: string | undefined
  amount: number | undefined
  claimStatus: string | undefined
  detailUrl: string | undefined
}

/** 把 feed 里的每条活动投影成可渲染行（`key` 保证列表稳定）。 */
function rowOf(campaign: QoderCampaign, feed: QoderCampaignFeed, language: string, t: Translate): CampaignRow {
  const content = pickContent(campaign.content, language)
  const title = content?.title ?? t('row.campaignUntitled')
  const description = content?.description
  const detailUrl = content?.detailUrl ?? campaign.campaignUrl ?? feed.campaignUrl
  return {
    key: campaign.campaignId ?? campaign.campaignKey ?? title,
    title,
    description,
    amount: campaign.amount,
    claimStatus: campaign.claimStatus,
    detailUrl: detailUrl === '' ? undefined : detailUrl,
  }
}

interface QoderCampaignsProps {
  region: QoderWebRegion
  t: Translate
}

interface CampaignsState {
  feed: QoderCampaignFeed | null
  error: string | undefined
  loading: boolean
}

export function QoderCampaigns(props: QoderCampaignsProps): ReactElement {
  const { region, t } = props
  const language = hostLanguage(t)
  const controller = useRef<AbortController | null>(null)
  const [state, setState] = useState<CampaignsState>({ feed: null, error: undefined, loading: true })

  useEffect(() => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setState(prev => ({ feed: prev.feed, error: undefined, loading: true }))

    fetch(withQoderRegion(QODER_CAMPAIGNS_PATH, region), {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal: current.signal,
    })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const feed = (await response.json()) as QoderCampaignFeed
        if (current.signal.aborted) return
        setState({ feed, error: undefined, loading: false })
      })
      .catch((error: unknown) => {
        if (current.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        setState({ feed: null, error: message, loading: false })
      })

    return () => current.abort()
  }, [region])

  const { feed, error, loading } = state
  const campaigns = feed?.campaigns ?? []

  return (
    <div className="dsm-qoder-campaigns">
      <p className="dsm-qoder-campaigns-title">{t('row.campaignsTitle')}</p>

      {error !== undefined ? (
        <p className="dsm-qoder-campaigns-error" role="alert">
          {t('row.campaignsError', { message: error })}
        </p>
      ) : null}

      {error === undefined && loading && campaigns.length === 0 ? (
        <p className="dsm-qoder-campaigns-empty">{t('row.campaignsLoading')}</p>
      ) : null}

      {error === undefined && !loading && campaigns.length === 0 ? (
        <p className="dsm-qoder-campaigns-empty">{t('row.campaignsEmpty')}</p>
      ) : null}

      {campaigns.map(campaign => {
        const row = rowOf(campaign, feed ?? { campaigns: [] }, language, t)
        const claimKey = campaign.actionType === 'CLAIM_BENEFIT' ? claimKeyOf(campaign.claimStatus) : undefined
        const status = claimKey === undefined ? undefined : t(CLAIM_KEYS[claimKey])
        return (
          <div className="dsm-qoder-campaign-row" key={row.key}>
            <div className="dsm-qoder-campaign-row-head">
              <span className="dsm-qoder-campaign-row-title">{row.title}</span>
              {row.amount !== undefined ? (
                <span className="dsm-qoder-campaign-row-amount">+{row.amount} Credits</span>
              ) : null}
              {status !== undefined ? (
                <span className={`dsm-qoder-campaign-row-status dsm-qoder-campaign-row-status-${row.claimStatus?.toLowerCase() ?? 'unknown'}`}>
                  {status}
                </span>
              ) : null}
            </div>
            {row.description !== undefined && row.description !== '' ? (
              <p className="dsm-qoder-campaign-row-desc">{row.description}</p>
            ) : null}
            {row.detailUrl !== undefined ? (
              <a className="dsm-qoder-campaign-row-link" href={row.detailUrl} target="_blank" rel="noreferrer">
                {t('row.campaignDetails')}
              </a>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
