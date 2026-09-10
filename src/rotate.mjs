import { DEFAULT_THRESHOLD, getPool } from './store.mjs'
import { fetchUsage } from './usage.mjs'

/**
 * Picking which account to run next, out of a pool.
 *
 * Everything here works off the quota figures `usage.mjs` already caches. Only
 * the account in use can be queried live (a token that is not in use is
 * almost always expired, and refreshing it risks the login — see the README),
 * so a pick is a best guess that corrects itself: the next `ccp rotate` sees
 * live numbers for whatever is active and moves on again if it was wrong.
 */
const HOUR_MS = 3_600_000

/** How long `ccp mark` assumes a limit lasts when nothing says otherwise. */
export const DEFAULT_EXHAUSTED_MS = 5 * HOUR_MS

/**
 * Highest utilisation a snapshot still describes. A window whose reset has
 * already passed says nothing about the window running now, so it is skipped
 * — that is what keeps a two-day-old snapshot useful instead of misleading.
 */
export function peakUsage(snapshot, now = Date.now()) {
  let peak = null
  for (const w of snapshot?.windows ?? []) {
    if (w.resetsAt && w.resetsAt <= now) continue
    const used = Number(w.used)
    if (Number.isFinite(used)) peak = Math.max(peak ?? 0, used)
  }
  return peak
}

/** When a snapshot means "out of quota", and until when. Null if it does not. */
export function exhaustedUntil(snapshot, threshold = DEFAULT_THRESHOLD, now = Date.now()) {
  if (!snapshot) return null

  let until = null
  for (const w of snapshot.windows ?? []) {
    if (Number(w.used) < threshold) continue
    if (!w.resetsAt || w.resetsAt <= now) continue
    until = Math.max(until ?? 0, w.resetsAt)
  }
  if (until) return until

  // Codex says it outright. With no reset time attached, all we can do is wait
  // out a typical window from when we were told.
  if (snapshot.limitReached) {
    const guess = (snapshot.fetchedAt ?? now) + DEFAULT_EXHAUSTED_MS
    return guess > now ? guess : null
  }
  return null
}

/** What ccp believes about one member: free or busy, and how used it looked. */
export function statusOf(state, name, threshold = DEFAULT_THRESHOLD, now = Date.now()) {
  const p = state.profiles[name]
  const marked = p?.exhaustedUntil > now ? p.exhaustedUntil : null
  const derived = exhaustedUntil(p?.usage, threshold, now)
  return {
    name,
    until: Math.max(marked ?? 0, derived ?? 0) || null,
    marked: !!marked,
    peak: peakUsage(p?.usage, now),
    usage: p?.usage ?? null,
    lastUsedAt: p?.lastUsedAt ?? 0,
  }
}

export function statuses(state, poolName, now = Date.now()) {
  const pool = getPool(state, poolName)
  const threshold = pool.threshold ?? DEFAULT_THRESHOLD
  return pool.members.map((m) => statusOf(state, m, threshold, now))
}

/**
 * The member to run next: least used first, longest unused as the tie-break —
 * which is what makes two accounts with no figures at all take turns.
 * Returns `{ none: true }` when every member is out, rather than picking one
 * that cannot serve a request.
 */
export function pick(state, poolName, now = Date.now()) {
  const rows = statuses(state, poolName, now)
  const free = rows.filter((r) => !r.until)
  if (!free.length) {
    const soonest = rows.reduce((a, b) => (a.until <= b.until ? a : b))
    return { none: true, name: soonest.name, until: soonest.until, rows }
  }
  free.sort((a, b) => (a.peak ?? 0) - (b.peak ?? 0) || a.lastUsedAt - b.lastUsedAt)
  return { name: free[0].name, rows }
}

/**
 * Refresh what we know about the member in use before picking, so a rotate is
 * not made on stale figures. Members that are not active are left untouched.
 */
export async function refreshActive(state, poolName) {
  const pool = getPool(state, poolName)
  const name = state.active[pool.target]
  if (!name || !pool.members.includes(name)) return null

  const r = await fetchUsage(state, name)
  if (!r.snapshot) return { name, ...r }

  const p = state.profiles[name]
  const until = exhaustedUntil(p.usage, pool.threshold ?? DEFAULT_THRESHOLD)
  // Live figures are the authority on the account in use: they can clear a
  // guess made earlier just as well as set one.
  if (until) p.exhaustedUntil = until
  else delete p.exhaustedUntil
  return { name, ...r }
}
