/**
 * The part of an upstream failure message worth showing INLINE.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *
 * Both the pool table and the model table used to append the recorded body
 * verbatim. For a rate limit that body is a JSON envelope whose remaining
 * fields mean nothing to the reader. The rule is stated once here:
 *
 *   - an outcome whose own label plus stated recovery time already say
 *     everything gets NO inline reason (its body only repeats them);
 *   - every other outcome gets a SHORT reason — the human sentence lifted out of
 *     a JSON envelope, or the transport error with its redundant prefix removed;
 *   - the full text stays on the element as a `title`, so shortening never means
 *     losing it.
 *
 * @module dsh-connect-qoder/client/probe-reason
 */

import type { QoderWebProbeOutcome } from '../status-paths.ts'

/**
 * Outcomes whose label + stated recovery time ARE the whole story.
 *
 * Both carry a reset instant, which the row prints right beside them; their
 * bodies restate that instant and add a `code`/`requestId` pair nobody reads.
 *
 * `credential-rejected` and `not-found` are deliberately NOT here: their labels
 * state a conclusion, and the upstream's own words are what make that conclusion
 * checkable rather than asserted.
 */
const SELF_EXPLANATORY: ReadonlySet<QoderWebProbeOutcome> = new Set([
  'rate-limited',
  'out-of-credit',
])

/** Longest inline reason kept. */
const REASON_LIMIT = 72

/** The inline reason for one measurement, or `undefined` when it adds nothing. */
export function inlineProbeReason(
  outcome: QoderWebProbeOutcome,
  message: string | undefined,
): string | undefined {
  if (message === undefined || message === '') return undefined
  if (SELF_EXPLANATORY.has(outcome)) return undefined
  const text = (humanSentenceOf(message) ?? stripTransportPrefix(message)).trim()
  return text === '' ? undefined : truncate(text)
}

function truncate(text: string): string {
  return text.length <= REASON_LIMIT ? text : `${text.slice(0, REASON_LIMIT - 1)}…`
}

/** `{"code":6004,"msg":"…","requestId":"…"}` → the `msg` sentence, if it has one. */
function humanSentenceOf(message: string): string | undefined {
  if (!message.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    // A truncated or non-JSON body is not worth reporting as an error: the
    // caller falls back to the raw text, which still beats showing nothing.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const msg = (parsed as Record<string, unknown>)['msg']
  return typeof msg === 'string' && msg !== '' ? msg : undefined
}

/** `transport error: TimeoutError: …` → `TimeoutError: …`. */
function stripTransportPrefix(message: string): string {
  return message.replace(/^transport error:\s*/u, '')
}