import fs from 'node:fs'
import path from 'node:path'
import { CCP_DIR, CcpError, readJson, writeJsonAtomic } from './util.mjs'

const FILE = path.join(CCP_DIR, 'profiles.json')

const EMPTY = {
  version: 1,
  active: { claude: null, codex: null },
  // Keys/tables ccp wrote into the host configs, so a switch can clean up
  // exactly what it added and never touch anything the user set by hand.
  managed: { claudeEnvKeys: [], claudeModelSet: false, codexProviderIds: [] },
  profiles: {},
}

export const KINDS = {
  claude: ['oauth', 'proxy', 'apikey'],
  codex: ['chatgpt', 'provider'],
}

export function load() {
  fs.mkdirSync(CCP_DIR, { recursive: true, mode: 0o700 })
  const data = readJson(FILE, null)
  if (!data) return structuredClone(EMPTY)
  return { ...structuredClone(EMPTY), ...data, managed: { ...EMPTY.managed, ...(data.managed ?? {}) } }
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

export function isActive(state, name) {
  const p = state.profiles[name]
  return !!p && state.active[p.target] === name
}

export function put(state, name, profile) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new CcpError('profile name may only contain letters, digits, . _ -')
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
}

export const FILE_PATH = FILE
