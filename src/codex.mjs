import path from 'node:path'
import { HOME, CcpError, backup, info, ok, readJson, readText, warn, writeFileAtomic, writeJsonAtomic } from './util.mjs'
import { vaultRead, vaultWrite } from './keychain.mjs'
import { get } from './store.mjs'

const CODEX_DIR = path.join(HOME, '.codex')
const CONFIG = path.join(CODEX_DIR, 'config.toml')
const AUTH = path.join(CODEX_DIR, 'auth.json')

const KEYS_BEGIN = '# >>> ccp:keys (managed - do not edit)'
const KEYS_END = '# <<< ccp:keys'
const PROV_BEGIN = '# >>> ccp:provider (managed - do not edit)'
const PROV_END = '# <<< ccp:provider'

// Begin markers written by earlier versions. Stripped too, so changing the
// marker wording never leaves a duplicated block behind.
const LEGACY_BEGINS = ['# >>> ccp:keys (managed - dung sua tay)', '# >>> ccp:provider (managed - dung sua tay)']

export const PATHS = { CONFIG, AUTH }

const tomlStr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

function tomlValue(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  return tomlStr(v)
}

/** Remove a previously written marker block, keeping everything else. */
function stripBlock(lines, begin, end) {
  const out = []
  let inside = false
  for (const line of lines) {
    if (line.trim() === begin) {
      inside = true
      continue
    }
    if (inside) {
      if (line.trim() === end) inside = false
      continue
    }
    out.push(line)
  }
  return out
}

/** Delete top-level `key = ...` assignments (the region before the first table). */
function stripTopKeys(lines, keys) {
  if (!keys.length) return lines
  const out = []
  let inTables = false
  for (const line of lines) {
    if (/^\s*\[/.test(line)) inTables = true
    if (!inTables) {
      const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)
      if (m && keys.includes(m[1])) continue
    }
    out.push(line)
  }
  return out
}

/** Delete a whole [model_providers.<id>] table, up to the next table header. */
function stripProviderTable(lines, id) {
  const out = []
  let skipping = false
  const head = new RegExp(`^\\s*\\[model_providers\\.(?:${id}|"${id}")\\]`)
  for (const line of lines) {
    if (skipping) {
      if (/^\s*\[/.test(line)) skipping = false
      else continue
    }
    if (head.test(line)) {
      skipping = true
      continue
    }
    out.push(line)
  }
  return out
}

/**
 * Identify whose login an auth.json holds. account_id is what matters — the
 * email is only decoded from the id_token payload so `ccp list` can show which
 * account a profile is. No token value is ever logged or stored.
 */
function identityOf(auth) {
  const accountId = auth?.tokens?.account_id ?? null
  let email = null
  const idToken = auth?.tokens?.id_token
  if (typeof idToken === 'string' && idToken.split('.').length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))
      email = payload.email ?? payload.preferred_username ?? null
    } catch {
      /* not a readable JWT — account_id alone is enough */
    }
  }
  return { accountId, email }
}

function trimBlank(lines) {
  const out = [...lines]
  while (out.length && out[0].trim() === '') out.shift()
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out
}

export function apply(state, name, stamp) {
  const p = get(state, name)
  if (p.target !== 'codex') throw new CcpError(`"${name}" is a ${p.target} profile, not codex`)

  captureActive(state)

  backup(CONFIG, stamp)
  backup(AUTH, stamp)

  // ---- config.toml -------------------------------------------------------
  const raw = readText(CONFIG) ?? ''
  let lines = raw.split('\n')
  lines = stripBlock(lines, KEYS_BEGIN, KEYS_END)
  lines = stripBlock(lines, PROV_BEGIN, PROV_END)
  lines = stripBlock(lines, LEGACY_BEGINS[0], KEYS_END)
  lines = stripBlock(lines, LEGACY_BEGINS[1], PROV_END)

  const keys = { ...(p.keys ?? {}) }
  if (p.kind === 'provider') {
    keys.model = p.model
    keys.model_provider = p.providerId
  } else if (p.model) {
    keys.model = p.model
  }

  const doomedKeys = [...Object.keys(keys), ...(p.removeKeys ?? []), 'model_provider']
  lines = stripTopKeys(lines, doomedKeys)

  const oldIds = new Set([...(state.managed.codexProviderIds ?? []), ...(p.providerId ? [p.providerId] : [])])
  for (const id of oldIds) lines = stripProviderTable(lines, id)

  const keyBlock = [KEYS_BEGIN, ...Object.entries(keys).map(([k, v]) => `${k} = ${tomlValue(v)}`), KEYS_END, '']

  const provBlock =
    p.kind === 'provider'
      ? [
          '',
          PROV_BEGIN,
          `[model_providers.${p.providerId}]`,
          `name = ${tomlStr(p.providerName ?? p.providerId)}`,
          `base_url = ${tomlStr(p.baseUrl)}`,
          `wire_api = ${tomlStr(p.wireApi ?? 'responses')}`,
          ...(p.requiresOpenaiAuth === false ? [] : ['requires_openai_auth = true']),
          PROV_END,
        ]
      : []

  const body = trimBlank(lines)
  writeFileAtomic(CONFIG, `${[...keyBlock, ...body, ...provBlock].join('\n').replace(/\n{3,}/g, '\n\n')}\n`)
  ok(`config.toml: ${Object.entries(keys).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  if (p.removeKeys?.length) info(`removed: ${p.removeKeys.join(', ')}`)

  // ---- auth.json ---------------------------------------------------------
  if (p.kind === 'chatgpt') {
    const blob = vaultRead(name)
    if (!blob) {
      throw new CcpError(
        `profile "${name}" has no auth in the vault.\n` +
          `    Log in to Codex with that account, then run \`ccp capture ${name}\`.`,
      )
    }
    // Byte-for-byte, no cosmetic trailing newline: restore must round-trip
    // exactly, or the next switch sees a "changed" file and re-captures it.
    writeFileAtomic(AUTH, blob)
    ok('auth.json: restored the ChatGPT login')
  } else {
    const key = vaultRead(name)
    if (!key) throw new CcpError(`profile "${name}" has no key in the vault — run \`ccp add\` again`)
    const auth = readJson(AUTH, {})
    auth.auth_mode = 'apikey'
    auth.OPENAI_API_KEY = key
    writeJsonAtomic(AUTH, auth) // keeps any existing `tokens` so revert is easy
    ok('auth.json: auth_mode=apikey + OPENAI_API_KEY')
  }

  state.managed.codexProviderIds = [...oldIds]
  state.active.codex = name
}

/** Re-snapshot the live ChatGPT auth.json (its tokens refresh, same as Claude's). */
export function captureActive(state, { quiet = false } = {}) {
  const name = state.active.codex
  if (!name) return false
  const p = state.profiles[name]
  if (!p || p.kind !== 'chatgpt') return false

  const blob = readText(AUTH)
  if (!blob) {
    if (!quiet) warn(`could not read ${AUTH} — skipping capture for "${name}"`)
    return false
  }
  if (blob === vaultRead(name)) return false

  // Same hazard as the Claude side: if auth.json was switched to an api key by
  // hand, it is not this profile's ChatGPT login and must not land in its vault.
  const auth = readJson(AUTH, {})
  if (auth.auth_mode !== 'chatgpt') {
    if (!quiet) warn(`auth.json is no longer a ChatGPT login — skipping capture for "${name}"`)
    return false
  }

  // Nor is it necessarily *this* account: logging in by hand swaps auth.json
  // behind our back, and capturing blindly would bury another account's login.
  const live = identityOf(auth)
  if (p.identity?.accountId && live.accountId && p.identity.accountId !== live.accountId) {
    if (!quiet) {
      warn(
        `auth.json now belongs to ${live.email ?? live.accountId}, not "${name}" ` +
          `(${p.identity.email ?? p.identity.accountId}) — skipping capture so its vault is not overwritten`,
      )
    }
    return false
  }

  vaultWrite(name, blob)
  if (live.accountId) p.identity = live
  p.capturedAt = Date.now()
  if (!quiet) ok(`captured the refreshed auth.json for "${name}"`)
  return true
}

/** Who auth.json belongs to right now — used to confirm a login actually switched. */
export function liveIdentity() {
  return identityOf(readJson(AUTH, {}))
}

/** The auth.json in use, which is newer than the vault copy whenever tokens refreshed. */
export function liveBlob() {
  return readText(AUTH)
}

export function captureInto(state, name, { label } = {}) {
  const blob = readText(AUTH)
  if (!blob) throw new CcpError(`${AUTH} not found — log in to Codex first`)
  const auth = readJson(AUTH, {})
  if (auth.auth_mode !== 'chatgpt') {
    warn(`auth.json is in "${auth.auth_mode}" mode, not "chatgpt" — capturing anyway, but double-check it`)
  }
  vaultWrite(name, blob)
  const identity = identityOf(auth)
  return {
    target: 'codex',
    kind: 'chatgpt',
    label: label ?? 'ChatGPT login',
    identity,
    model: readText(CONFIG)?.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    capturedAt: Date.now(),
  }
}

export function describe(state, name) {
  const p = get(state, name)
  if (p.kind === 'chatgpt') {
    const who = p.identity?.email ?? p.identity?.accountId ?? 'ChatGPT login'
    return `${who} · ${p.model ?? 'default model'}`
  }
  return `${p.baseUrl} · ${p.wireApi ?? 'responses'} → ${p.model}`
}
