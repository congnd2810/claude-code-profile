import { c, fail, fmtAge, info, warn } from './util.mjs'
import { vaultRead } from './keychain.mjs'
import { get, names, save } from './store.mjs'
import { liveBlob as claudeLive } from './claude.mjs'
import { liveBlob as codexLive } from './codex.mjs'

const TIMEOUT_MS = 25_000

/**
 * Quota for first-party logins only.
 *
 * Both endpoints are the ones the official CLIs call, reached with the same
 * headers they identify themselves with — no browser impersonation. Third-party
 * providers expose nothing comparable, so they report not available.
 *
 * Access tokens are short-lived, so only the *active* login can be queried
 * live. Every successful call is cached on the profile, which is what lets
 * `--all` show every account without touching a single token.
 */
const CLAUDE_USAGE = 'https://api.anthropic.com/api/oauth/usage'
const CODEX_USAGE = 'https://chatgpt.com/backend-api/codex/usage'

async function getJson(url, headers) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: ctl.signal })
    const text = await res.text()
    if (!res.ok) return { status: res.status, body: null, text }
    try {
      return { status: res.status, body: JSON.parse(text), text }
    } catch {
      return { status: res.status, body: null, text }
    }
  } catch (e) {
    return { status: 0, body: null, text: e.name === 'AbortError' ? 'timeout' : e.message }
  } finally {
    clearTimeout(timer)
  }
}

const bar = (n) => {
  const v = Math.round(Number(n) || 0)
  const filled = Math.max(0, Math.min(10, Math.round(v / 10)))
  const paint = v >= 90 ? c.red : v >= 70 ? c.yellow : c.green
  return `${paint('█'.repeat(filled) + '░'.repeat(10 - filled))} ${String(v).padStart(3)}%`
}

function untilText(target) {
  if (!target) return ''
  const ms = target - Date.now()
  if (ms <= 0) return c.dim(' · resets now')
  // Round to minutes first, then split — rounding each unit separately is what
  // produces nonsense like "167h 60m".
  const mins = Math.round(ms / 60000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const parts = d ? [`${d}d`, h && `${h}h`] : h ? [`${h}h`, m && `${m}m`] : [`${m}m`]
  return c.dim(` · resets in ${parts.filter(Boolean).join(' ')}`)
}

/** Explain a failed call in terms of what to do about it. */
function explain(r, name) {
  if (r.status === 401 || r.status === 403) {
    warn(`token rejected (http ${r.status}) — it is probably expired`)
    info(`fix: \`ccp use ${name}\`, open the app once, then \`ccp capture ${name}\``)
    return
  }
  if (r.status === 0) return fail(`could not reach the endpoint: ${r.text}`)
  fail(`http ${r.status} · ${r.text.slice(0, 120).replace(/\s+/g, ' ')}`)
}

/**
 * For the active profile the credential in use is the current one; the vault
 * holds whatever was captured last, which goes stale as tokens refresh. Reading
 * the vault for an active profile is what made every call 401.
 */
function blobFor(name, active, live) {
  const blob = (active && live()) || vaultRead(name)
  if (!blob) return { error: active ? 'no credential in use, and nothing in the vault' : 'nothing stored in the vault' }
  return { blob }
}

function tokenFrom(blob, pick) {
  try {
    const value = pick(JSON.parse(blob))
    return value ? { value } : { error: 'no access token in the stored login' }
  } catch {
    return { error: 'stored login is not readable JSON' }
  }
}

async function fetchClaude(name, active) {
  const b = blobFor(name, active, claudeLive)
  if (b.error) return { error: b.error }
  const t = tokenFrom(b.blob, (j) => j?.claudeAiOauth?.accessToken)
  if (t.error) return { error: t.error }

  const r = await getJson(CLAUDE_USAGE, {
    authorization: `Bearer ${t.value}`,
    'anthropic-beta': 'oauth-2025-04-20',
  })
  if (!r.body) return { failed: r }

  const at = (w) => (w?.resets_at ? Date.parse(w.resets_at) : null)
  const windows = []
  for (const [key, label] of [
    ['five_hour', '5 hours'],
    ['seven_day', '7 days'],
    ['seven_day_opus', '7d opus'],
    ['seven_day_sonnet', '7d sonnet'],
  ]) {
    const w = r.body[key]
    if (w) windows.push({ label, used: w.utilization, resetsAt: at(w) })
  }
  const extra = r.body.extra_usage
  return {
    snapshot: {
      fetchedAt: Date.now(),
      windows,
      note: extra?.is_enabled ? `extra usage on · limit ${extra.monthly_limit ?? '?'}` : null,
    },
  }
}

async function fetchCodex(name, active) {
  const b = blobFor(name, active, codexLive)
  if (b.error) return { error: b.error }
  const t = tokenFrom(b.blob, (j) => j?.tokens?.access_token)
  if (t.error) return { error: t.error }
  let accountId = ''
  try {
    accountId = JSON.parse(b.blob)?.tokens?.account_id ?? ''
  } catch {
    /* optional header */
  }

  const r = await getJson(CODEX_USAGE, {
    authorization: `Bearer ${t.value}`,
    'chatgpt-account-id': accountId,
    originator: 'codex_cli_rs',
    'user-agent': 'codex_cli_rs',
  })
  if (!r.body) return { failed: r }

  const windows = []
  const push = (w) => {
    if (!w) return
    const resetsAt = w.reset_at ? w.reset_at * 1000 : Date.now() + (w.reset_after_seconds ?? 0) * 1000
    const secs = w.limit_window_seconds ?? 0
    const label = secs >= 86400 ? `${Math.round(secs / 86400)}d` : `${Math.round(secs / 3600)}h`
    windows.push({ label, used: w.used_percent, resetsAt })
  }
  push(r.body.rate_limit?.primary_window)
  push(r.body.rate_limit?.secondary_window)

  const bits = [r.body.email, r.body.plan_type].filter(Boolean)
  const credits = r.body.credits
  if (credits?.has_credits || Number(credits?.balance) > 0) bits.push(`credits ${credits.balance}`)
  return {
    snapshot: {
      fetchedAt: Date.now(),
      windows,
      note: bits.length ? bits.join(' · ') : null,
      limitReached: !!r.body.rate_limit?.limit_reached,
    },
  }
}

function render(snapshot, { live }) {
  if (snapshot.note) info(snapshot.note)
  if (!snapshot.windows.length) return info('no rate limit reported')
  const age = live ? c.dim(' · live') : c.dim(` · as of ${fmtAge(snapshot.fetchedAt)}`)
  for (const w of snapshot.windows) {
    // A cached window whose reset already passed says nothing useful, so drop
    // the countdown rather than print a stale one.
    const when = live ? untilText(w.resetsAt) : w.resetsAt && w.resetsAt < Date.now() ? c.dim(' · window has reset since') : ''
    console.log(`     ${w.label.padEnd(9)} ${bar(w.used)}${when}${age}`)
  }
  if (snapshot.limitReached) warn('limit reached')
}

const FETCHERS = { oauth: fetchClaude, chatgpt: fetchCodex }

function heading(state, name) {
  const p = get(state, name)
  const active = state.active[p.target] === name
  console.log(`\n  ${c.bold(name)} ${c.dim(`(${p.target}/${p.kind})`)}${active ? c.green(' ● active') : ''}`)
  return { p, active }
}

/** Live query for one profile, falling back to the cached snapshot. */
export async function usage(state, name) {
  const { p, active } = heading(state, name)
  const fetcher = FETCHERS[p.kind]
  if (!fetcher) return info('not available — third-party providers do not report quota')

  const r = await fetcher(name, active)
  if (r.snapshot) {
    p.usage = r.snapshot
    save(state)
    return render(r.snapshot, { live: true })
  }

  if (r.error) fail(r.error)
  else explain(r.failed, name)
  if (p.usage) {
    info('showing the last known figures instead:')
    render(p.usage, { live: false })
  }
}

/**
 * Every first-party profile at once: live for the active ones, cached for the
 * rest. Non-active tokens are almost always expired, so querying them would
 * just be a slow row of 401s.
 */
export async function usageAll(state, { activeOnly = false } = {}) {
  // Grouped by tool, same order as `ccp list`, rather than one mixed A-Z list.
  const candidates = activeOnly
    ? [state.active.claude, state.active.codex].filter(Boolean)
    : [...names(state, 'claude'), ...names(state, 'codex')]
  const logins = candidates.filter((n) => state.profiles[n] && FETCHERS[state.profiles[n].kind])
  if (!logins.length) return info(activeOnly ? 'no first-party login is active' : 'no first-party login profiles yet')

  for (const name of logins) {
    const { p, active } = heading(state, name)
    if (active) {
      const r = await FETCHERS[p.kind](name, true)
      if (r.snapshot) {
        p.usage = r.snapshot
        render(r.snapshot, { live: true })
        continue
      }
      if (r.error) fail(r.error)
      else explain(r.failed, name)
      if (p.usage) render(p.usage, { live: false })
      continue
    }
    if (p.usage) render(p.usage, { live: false })
    else info(`no figures yet — run \`ccp use ${name}\`, then \`ccp usage\``)
  }
  save(state)
  console.log('')
}
