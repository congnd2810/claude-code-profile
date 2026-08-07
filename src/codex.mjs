import path from 'node:path'
import { HOME, CcpError, backup, info, ok, readJson, readText, warn, writeFileAtomic, writeJsonAtomic } from './util.mjs'
import { vaultRead, vaultWrite } from './keychain.mjs'
import { get } from './store.mjs'

const CODEX_DIR = path.join(HOME, '.codex')
const CONFIG = path.join(CODEX_DIR, 'config.toml')
const AUTH = path.join(CODEX_DIR, 'auth.json')

const KEYS_BEGIN = '# >>> ccp:keys (managed - dung sua tay)'
const KEYS_END = '# <<< ccp:keys'
const PROV_BEGIN = '# >>> ccp:provider (managed - dung sua tay)'
const PROV_END = '# <<< ccp:provider'

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

function trimBlank(lines) {
  const out = [...lines]
  while (out.length && out[0].trim() === '') out.shift()
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out
}

export function apply(state, name, stamp) {
  const p = get(state, name)
  if (p.target !== 'codex') throw new CcpError(`"${name}" la profile ${p.target}, khong phai codex`)

  captureActive(state)

  backup(CONFIG, stamp)
  backup(AUTH, stamp)

  // ---- config.toml -------------------------------------------------------
  const raw = readText(CONFIG) ?? ''
  let lines = raw.split('\n')
  lines = stripBlock(lines, KEYS_BEGIN, KEYS_END)
  lines = stripBlock(lines, PROV_BEGIN, PROV_END)

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
  if (p.removeKeys?.length) info(`da bo: ${p.removeKeys.join(', ')}`)

  // ---- auth.json ---------------------------------------------------------
  if (p.kind === 'chatgpt') {
    const blob = vaultRead(name)
    if (!blob) {
      throw new CcpError(
        `profile "${name}" chua co auth trong vault.\n` +
          `    Login Codex bang nick do roi chay \`ccp capture ${name}\`.`,
      )
    }
    writeFileAtomic(AUTH, blob.endsWith('\n') ? blob : `${blob}\n`)
    ok('auth.json: restored login ChatGPT')
  } else {
    const key = vaultRead(name)
    if (!key) throw new CcpError(`profile "${name}" chua co key trong vault — chay \`ccp add\` lai`)
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
    if (!quiet) warn(`khong doc duoc ${AUTH} — bo qua capture cho "${name}"`)
    return false
  }
  if (blob === vaultRead(name)) return false

  vaultWrite(name, blob)
  p.capturedAt = Date.now()
  if (!quiet) ok(`captured auth.json moi cua "${name}"`)
  return true
}

export function captureInto(state, name, { label } = {}) {
  const blob = readText(AUTH)
  if (!blob) throw new CcpError(`khong thay ${AUTH} — login Codex truoc da`)
  const auth = readJson(AUTH, {})
  if (auth.auth_mode !== 'chatgpt') {
    warn(`auth.json dang o mode "${auth.auth_mode}", khong phai "chatgpt" — van luu nhung kiem tra lai`)
  }
  vaultWrite(name, blob)
  return {
    target: 'codex',
    kind: 'chatgpt',
    label: label ?? 'login ChatGPT',
    model: readText(CONFIG)?.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    capturedAt: Date.now(),
  }
}

export function describe(state, name) {
  const p = get(state, name)
  if (p.kind === 'chatgpt') return `login ChatGPT · ${p.model ?? 'model mac dinh'}`
  return `${p.baseUrl} · ${p.wireApi ?? 'responses'} → ${p.model}`
}
