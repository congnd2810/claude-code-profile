import { c, fail, info, warn } from './util.mjs'
import { vaultRead } from './keychain.mjs'
import { get } from './store.mjs'

const TIMEOUT_MS = 25_000

/**
 * Quota for first-party logins only.
 *
 * Both endpoints are the ones the official CLIs call, reached with the same
 * headers they identify themselves with — no browser impersonation. Third-party
 * providers expose nothing comparable, so they report not available.
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

const pct = (n) => {
  const v = Math.round(Number(n) || 0)
  const filled = Math.round(v / 10)
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)
  const paint = v >= 90 ? c.red : v >= 70 ? c.yellow : c.green
  return `${paint(bar)} ${String(v).padStart(3)}%`
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

function line(label, used, resetsAt) {
  console.log(`     ${label.padEnd(9)} ${pct(used)}${untilText(resetsAt)}`)
}

/** Explain a failed call in terms of what to do about it. */
function explain(r, name) {
  if (r.status === 401 || r.status === 403) {
    warn(`token rejected (http ${r.status}) — it is probably expired`)
    return info(`fix: \`ccp use ${name}\`, open the app once, then \`ccp capture ${name}\``)
  }
  if (r.status === 0) return fail(`could not reach the endpoint: ${r.text}`)
  return fail(`http ${r.status} · ${r.text.slice(0, 120).replace(/\s+/g, ' ')}`)
}

async function claudeUsage(state, name) {
  const blob = vaultRead(name)
  if (!blob) return fail('no token in the vault')
  let token = null
  try {
    token = JSON.parse(blob)?.claudeAiOauth?.accessToken ?? null
  } catch {
    /* opaque blob — handled below */
  }
  if (!token) return fail('could not read an access token from the stored login')

  const r = await getJson(CLAUDE_USAGE, {
    authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
  })
  if (!r.body) return explain(r, name)

  const at = (w) => (w?.resets_at ? Date.parse(w.resets_at) : null)
  if (r.body.five_hour) line('5 hours', r.body.five_hour.utilization, at(r.body.five_hour))
  if (r.body.seven_day) line('7 days', r.body.seven_day.utilization, at(r.body.seven_day))
  for (const [key, label] of [
    ['seven_day_opus', '7d opus'],
    ['seven_day_sonnet', '7d sonnet'],
  ]) {
    if (r.body[key]) line(label, r.body[key].utilization, at(r.body[key]))
  }
  const extra = r.body.extra_usage
  if (extra?.is_enabled) {
    info(`extra usage on · used ${extra.used_credits ?? '?'} of ${extra.monthly_limit ?? '?'}`)
  }
}

async function codexUsage(state, name) {
  const blob = vaultRead(name)
  if (!blob) return fail('no auth in the vault')
  let tokens = null
  try {
    tokens = JSON.parse(blob)?.tokens ?? null
  } catch {
    /* handled below */
  }
  if (!tokens?.access_token) return fail('could not read an access token from the stored login')

  const r = await getJson(CODEX_USAGE, {
    authorization: `Bearer ${tokens.access_token}`,
    'chatgpt-account-id': tokens.account_id ?? '',
    originator: 'codex_cli_rs',
    'user-agent': 'codex_cli_rs',
  })
  if (!r.body) return explain(r, name)

  const plan = r.body.plan_type ? `${r.body.plan_type}` : 'unknown plan'
  info(`${r.body.email ?? '(no email)'} · ${plan}`)

  const rl = r.body.rate_limit
  const window = (w, label) => {
    if (!w) return
    const resetAt = w.reset_at ? w.reset_at * 1000 : Date.now() + (w.reset_after_seconds ?? 0) * 1000
    const days = Math.round((w.limit_window_seconds ?? 0) / 86400)
    const hours = Math.round((w.limit_window_seconds ?? 0) / 3600)
    const span = days >= 1 ? `${days}d` : `${hours}h`
    line(label ?? span, w.used_percent, resetAt)
  }
  if (!rl) info('no rate limit reported')
  else {
    window(rl.primary_window)
    window(rl.secondary_window)
    if (rl.limit_reached) warn('limit reached')
  }

  const cr = r.body.credits
  if (cr?.has_credits || Number(cr?.balance) > 0) info(`credits: ${cr.balance}${cr.unlimited ? ' (unlimited)' : ''}`)
  if (r.body.spend_control?.reached) warn('spend control reached')
}

export async function usage(state, name) {
  const p = get(state, name)
  const active = state.active[p.target] === name
  console.log(`\n  ${c.bold(name)} ${c.dim(`(${p.target}/${p.kind})`)}${active ? c.green(' ● active') : ''}`)

  if (p.kind === 'oauth') return claudeUsage(state, name)
  if (p.kind === 'chatgpt') return codexUsage(state, name)
  return info('not available — third-party providers do not report quota')
}

/** All profiles, or just the active pair when none is named. */
export async function usageAll(state, names) {
  if (!names.length) return info('no profiles yet')
  for (const name of names) await usage(state, name)
  console.log('')
}
