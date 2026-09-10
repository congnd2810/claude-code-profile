import fs from 'node:fs'
import path from 'node:path'
import { CCP_DIR, CcpError, readJson, writeJsonAtomic } from './util.mjs'

const FILE = path.join(CCP_DIR, 'profiles.json')

const EMPTY = {
  version: 2,
  active: { claude: null, codex: null, antigravity: null },
  // Which pool the active profile of each target was picked from, so `ccp
  // rotate` needs no argument. Null when the profile was chosen by hand.
  activePool: { claude: null, codex: null, antigravity: null },
  pools: {},
  // Keys/tables ccp wrote into the host configs, so a switch can clean up
  // exactly what it added and never touch anything the user set by hand.
  managed: { claudeEnvKeys: [], claudeModelSet: false, codexProviderIds: [] },
  profiles: {},
}

export const TARGETS = ['claude', 'codex', 'antigravity']

export const TARGET_LABELS = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' }

export const KINDS = {
  claude: ['oauth', 'proxy', 'apikey'],
  codex: ['chatgpt', 'provider'],
  antigravity: ['google'],
}

export const DEFAULT_THRESHOLD = 90

/**
 * A v1 file has no `pools`/`activePool` and no antigravity slot. Filling the
 * gaps from EMPTY is the whole migration — nothing has to be rewritten, so an
 * older ccp keeps reading a file this one has saved.
 */
export function load() {
  fs.mkdirSync(CCP_DIR, { recursive: true, mode: 0o700 })
  const data = readJson(FILE, null)
  if (!data) return structuredClone(EMPTY)
  return {
    ...structuredClone(EMPTY),
    ...data,
    version: EMPTY.version,
    active: { ...EMPTY.active, ...(data.active ?? {}) },
    activePool: { ...EMPTY.activePool, ...(data.activePool ?? {}) },
    pools: { ...(data.pools ?? {}) },
    managed: { ...EMPTY.managed, ...(data.managed ?? {}) },
  }
}

export function save(state) {
  writeJsonAtomic(FILE, state)
}

export function get(state, name) {
  const p = state.profiles[name]
  if (!p) throw new CcpError(`no profile named "${name}" — run \`ccp list\` to see them`)
  return p
}

export function names(state, target = null) {
  return Object.keys(state.profiles)
    .filter((n) => !target || state.profiles[n].target === target)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * The profile of this target whose captured identity matches — i.e. who
 * already owns the login being looked at. Adding a second profile for one
 * account is never what someone means, so `add` uses this to catch it.
 */
export function ownerOf(state, target, matches) {
  return names(state, target).find((n) => matches(state.profiles[n].identity ?? {})) ?? null
}

export function isActive(state, name) {
  const p = state.profiles[name]
  return !!p && state.active[p.target] === name
}

const validName = (name, what) => {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new CcpError(`${what} name may only contain letters, digits, . _ -`)
}

export function put(state, name, profile) {
  validName(name, 'profile')
  if (state.pools[name]) throw new CcpError(`"${name}" is already a pool — pick another profile name`)
  if (!KINDS[profile.target]?.includes(profile.kind)) {
    throw new CcpError(`kind "${profile.kind}" is not valid for ${profile.target}`)
  }
  state.profiles[name] = profile
}

export function remove(state, name) {
  get(state, name)
  const p = state.profiles[name]
  if (state.active[p.target] === name) state.active[p.target] = null
  delete state.profiles[name]
  // A pool must never point at a profile that is gone; one left with no
  // members has nothing to rotate between, so it goes too.
  for (const [pool, cfg] of Object.entries(state.pools)) {
    if (!cfg.members.includes(name)) continue
    cfg.members = cfg.members.filter((m) => m !== name)
    if (!cfg.members.length) removePool(state, pool)
  }
}

// ---- pools ----------------------------------------------------------------

export function getPool(state, name) {
  const pool = state.pools[name]
  if (!pool) throw new CcpError(`no pool named "${name}" — run \`ccp pool\` to see them`)
  return pool
}

/** Create or overwrite a pool. Members must exist and share one target. */
export function putPool(state, name, members, { threshold = DEFAULT_THRESHOLD } = {}) {
  validName(name, 'pool')
  if (state.profiles[name]) throw new CcpError(`"${name}" is already a profile — pick another pool name`)
  if (members.length < 2) throw new CcpError('a pool needs at least two profiles — there is nothing to rotate between')

  const unique = [...new Set(members)]
  const targets = new Set(unique.map((m) => get(state, m).target))
  if (targets.size > 1) throw new CcpError(`a pool cannot mix tools: ${[...targets].join(' + ')}`)

  state.pools[name] = { target: [...targets][0], members: unique, threshold }
  return state.pools[name]
}

export function removePool(state, name) {
  getPool(state, name)
  for (const target of TARGETS) if (state.activePool[target] === name) state.activePool[target] = null
  delete state.pools[name]
}

export function poolNames(state, target = null) {
  return Object.keys(state.pools)
    .filter((n) => !target || state.pools[n].target === target)
    .sort((a, b) => a.localeCompare(b))
}

/** The pool a target is currently rotating within, or null. */
export function activePoolFor(state, target) {
  const name = state.activePool[target]
  return name && state.pools[name] ? name : null
}

export const FILE_PATH = FILE
