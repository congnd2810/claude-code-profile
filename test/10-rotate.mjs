// Pool bookkeeping and the pick that `ccp rotate` makes. Pure logic over a
// hand-built state — no keychain, no network, no files except the v1 → v2
// migration check at the end.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert'

const SRC = new URL('../src', import.meta.url).pathname
const FAKE = process.env.FAKE_HOME
process.env.HOME = FAKE
fs.mkdirSync(path.join(FAKE, '.ccp'), { recursive: true })

const store = await import(`${SRC}/store.mjs`)
const rotate = await import(`${SRC}/rotate.mjs`)

const NOW = Date.parse('2026-09-09T12:00:00Z')
const IN = (h) => NOW + h * 3600_000
const AGO = (h) => NOW - h * 3600_000

const profile = (extra = {}) => ({ target: 'claude', kind: 'oauth', label: null, capturedAt: AGO(1), ...extra })
const snapshot = (windows, extra = {}) => ({ fetchedAt: AGO(1), windows, note: null, ...extra })

/** A two-account claude pool, members given as profile overrides. */
const poolState = (members, threshold = store.DEFAULT_THRESHOLD) => {
  const state = store.load()
  state.profiles = {}
  state.pools = {}
  for (const [name, extra] of Object.entries(members)) state.profiles[name] = profile(extra)
  state.pools.pool = { target: 'claude', members: Object.keys(members), threshold }
  return state
}

console.log('########## peakUsage ignores windows that have already reset ##########')
console.log('  fresh 5h window at 40%:', rotate.peakUsage(snapshot([{ label: '5 hours', used: 40, resetsAt: IN(2) }]), NOW))
console.log('  same window, reset passed:', rotate.peakUsage(snapshot([{ label: '5 hours', used: 40, resetsAt: AGO(2) }]), NOW))
assert.equal(rotate.peakUsage(snapshot([{ used: 40, resetsAt: IN(2) }]), NOW), 40)
assert.equal(rotate.peakUsage(snapshot([{ used: 40, resetsAt: AGO(2) }]), NOW), null)
console.log('  worst of several windows:', rotate.peakUsage(snapshot([{ used: 10, resetsAt: IN(1) }, { used: 71, resetsAt: IN(90) }]), NOW))
assert.equal(rotate.peakUsage(snapshot([{ used: 10, resetsAt: IN(1) }, { used: 71, resetsAt: IN(90) }]), NOW), 71)

console.log('\n########## exhaustedUntil ##########')
const hot = snapshot([{ used: 96, resetsAt: IN(2) }, { used: 30, resetsAt: IN(90) }])
console.log('  96% of a window resetting in 2h → out until:', new Date(rotate.exhaustedUntil(hot, 90, NOW)).toISOString())
assert.equal(rotate.exhaustedUntil(hot, 90, NOW), IN(2))
console.log('  same figures, threshold 98 → not out:', rotate.exhaustedUntil(hot, 98, NOW))
assert.equal(rotate.exhaustedUntil(hot, 98, NOW), null)
console.log('  a window already reset does not count:', rotate.exhaustedUntil(snapshot([{ used: 99, resetsAt: AGO(1) }]), 90, NOW))
assert.equal(rotate.exhaustedUntil(snapshot([{ used: 99, resetsAt: AGO(1) }]), 90, NOW), null)
const flagged = snapshot([], { limitReached: true, fetchedAt: AGO(1) })
console.log('  codex limit_reached with no reset time → guessed 5h from the reading:', rotate.exhaustedUntil(flagged, 90, NOW) === AGO(1) + rotate.DEFAULT_EXHAUSTED_MS)
assert.equal(rotate.exhaustedUntil(flagged, 90, NOW), AGO(1) + rotate.DEFAULT_EXHAUSTED_MS)
console.log('  ...and expires on its own:', rotate.exhaustedUntil(snapshot([], { limitReached: true, fetchedAt: AGO(9) }), 90, NOW))
assert.equal(rotate.exhaustedUntil(snapshot([], { limitReached: true, fetchedAt: AGO(9) }), 90, NOW), null)

console.log('\n########## pick: least used first ##########')
let state = poolState({
  a: { usage: snapshot([{ used: 80, resetsAt: IN(3) }]) },
  b: { usage: snapshot([{ used: 20, resetsAt: IN(3) }]) },
})
console.log('  picked:', rotate.pick(state, 'pool', NOW).name)
assert.equal(rotate.pick(state, 'pool', NOW).name, 'b')

console.log('\n########## pick: no figures at all → longest unused ##########')
state = poolState({ a: { lastUsedAt: AGO(1) }, b: { lastUsedAt: AGO(30) } })
console.log('  picked:', rotate.pick(state, 'pool', NOW).name)
assert.equal(rotate.pick(state, 'pool', NOW).name, 'b')

console.log('\n########## pick: an exhausted member is skipped even if it looks idle ##########')
state = poolState({
  a: { lastUsedAt: AGO(30), usage: snapshot([{ used: 97, resetsAt: IN(4) }]) },
  b: { lastUsedAt: AGO(1), usage: snapshot([{ used: 55, resetsAt: IN(4) }]) },
})
console.log('  picked:', rotate.pick(state, 'pool', NOW).name)
assert.equal(rotate.pick(state, 'pool', NOW).name, 'b')

console.log('\n########## pick: a hand mark counts, and expires by itself ##########')
state = poolState({ a: { exhaustedUntil: IN(3), lastUsedAt: AGO(30) }, b: { lastUsedAt: AGO(1) } })
console.log('  picked while marked:', rotate.pick(state, 'pool', NOW).name)
assert.equal(rotate.pick(state, 'pool', NOW).name, 'b')
console.log('  marked row says so:', rotate.statuses(state, 'pool', NOW).find((r) => r.name === 'a').marked)
assert.equal(rotate.statuses(state, 'pool', NOW).find((r) => r.name === 'a').marked, true)
state.profiles.a.exhaustedUntil = AGO(1) // the mark has run out
console.log('  picked after it lapsed:', rotate.pick(state, 'pool', NOW).name)
assert.equal(rotate.pick(state, 'pool', NOW).name, 'a')

console.log('\n########## pick: everything out → refuse, and say when ##########')
state = poolState({
  a: { usage: snapshot([{ used: 99, resetsAt: IN(4) }]) },
  b: { usage: snapshot([{ used: 99, resetsAt: IN(2) }]) },
})
const out = rotate.pick(state, 'pool', NOW)
console.log('  none:', out.none, '| soonest:', out.name, '| at:', new Date(out.until).toISOString())
assert.equal(out.none, true)
assert.equal(out.name, 'b')
assert.equal(out.until, IN(2))

console.log('\n########## pool validation ##########')
state = store.load()
state.profiles = {
  cl1: profile(),
  cl2: profile(),
  cx1: profile({ target: 'codex', kind: 'chatgpt' }),
}
state.pools = {}
const mustThrow = (label, fn) => {
  try {
    fn()
    console.log(`  ${label}: NOT REJECTED`)
    assert.fail(`${label} should have been rejected`)
  } catch (e) {
    console.log(`  ${label}: ${e.message}`)
  }
}
mustThrow('one member', () => store.putPool(state, 'p', ['cl1']))
mustThrow('mixed tools', () => store.putPool(state, 'p', ['cl1', 'cx1']))
mustThrow('unknown member', () => store.putPool(state, 'p', ['cl1', 'nope']))
mustThrow('name of a profile', () => store.putPool(state, 'cl1', ['cl1', 'cl2']))
const pool = store.putPool(state, 'p', ['cl1', 'cl2', 'cl1'])
console.log('  created:', JSON.stringify(pool))
assert.deepEqual(pool.members, ['cl1', 'cl2'])
mustThrow('profile named after a pool', () => store.put(state, 'p', profile()))

console.log('\n########## deleting a member keeps the pool honest ##########')
state.activePool.claude = 'p'
store.remove(state, 'cl2')
console.log('  members now:', JSON.stringify(state.pools.p?.members ?? null))
assert.deepEqual(state.pools.p.members, ['cl1'])
store.remove(state, 'cl1')
console.log('  pool dropped once empty:', !state.pools.p, '| activePool cleared:', state.activePool.claude === null)
assert.equal(state.pools.p, undefined)
assert.equal(state.activePool.claude, null)

console.log('\n########## a v1 profiles.json still loads ##########')
const FILE = path.join(FAKE, '.ccp/profiles.json')
const saved = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null
fs.writeFileSync(
  FILE,
  JSON.stringify({ version: 1, active: { claude: 'old', codex: null }, managed: { claudeEnvKeys: ['X'] }, profiles: { old: profile() } }),
)
const migrated = store.load()
console.log('  version:', migrated.version, '| antigravity slot:', migrated.active.antigravity === null, '| pools:', JSON.stringify(migrated.pools))
console.log('  old profile kept:', !!migrated.profiles.old, '| managed kept:', JSON.stringify(migrated.managed.claudeEnvKeys))
assert.equal(migrated.version, 2)
assert.equal(migrated.active.claude, 'old')
assert.equal(migrated.active.antigravity, null)
assert.deepEqual(migrated.pools, {})
assert.deepEqual(migrated.activePool, { claude: null, codex: null, antigravity: null })
assert.deepEqual(migrated.managed.claudeEnvKeys, ['X'])

if (saved === null) fs.rmSync(FILE, { force: true })
else fs.writeFileSync(FILE, saved)
console.log('\n  done')
