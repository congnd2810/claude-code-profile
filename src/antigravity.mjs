import { CcpError, ok, run, warn } from './util.mjs'
import { readSecret, vaultRead, vaultWrite, writeSecret } from './keychain.mjs'
import { get, ownerOf } from './store.mjs'

/**
 * Antigravity keeps one Google login in a single keychain item, written by
 * go-keyring: service "gemini", account "antigravity". Both the `agy` CLI and
 * Antigravity IDE (its language server) read that same item, so moving it
 * switches both at once — there is no second place to patch, unlike Claude
 * Desktop.
 *
 * The value is `go-keyring-base64:` + base64 of
 *   { token: { access_token, refresh_token, expiry, ... }, id_token, auth_method }
 * and is treated as an opaque string: it is only decoded to read who it
 * belongs to and when its access token expires.
 */
// Overridable so tests can exercise the switch without touching the real login.
export const GEMINI_SERVICE = process.env.CCP_GEMINI_SERVICE || 'gemini'
export const GEMINI_ACCOUNT = process.env.CCP_GEMINI_ACCOUNT || 'antigravity'

const PREFIX = 'go-keyring-base64:'
const BUNDLE_ID = 'com.google.antigravity-ide'

const EMPTY_ID = { sub: null, email: null, authMethod: null, expiresAt: null }

/** The login in use right now (null when Antigravity is signed out). */
export function liveBlob() {
  return readSecret(GEMINI_SERVICE, GEMINI_ACCOUNT)
}

/**
 * Whose login a blob holds. `sub` is the Google account id and the only field
 * that matters; the email is decoded from the id_token payload so `ccp list`
 * can name the account. Never throws — the format is not ours.
 */
export function identityOf(blob) {
  if (!blob) return { ...EMPTY_ID }
  try {
    const json = blob.startsWith(PREFIX) ? Buffer.from(blob.slice(PREFIX.length), 'base64').toString('utf8') : blob
    const j = JSON.parse(json)
    const id = { ...EMPTY_ID, authMethod: j.auth_method ?? null }

    const idToken = j.id_token
    if (typeof idToken === 'string' && idToken.split('.').length === 3) {
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))
      id.sub = payload.sub ?? null
      id.email = payload.email ?? null
    }
    const expiry = j.token?.expiry ? Date.parse(j.token.expiry) : NaN
    if (Number.isFinite(expiry)) id.expiresAt = expiry
    return id
  } catch {
    return { ...EMPTY_ID }
  }
}

export function liveIdentity() {
  return identityOf(liveBlob())
}

/** The profile that already holds the login in use, or null. */
export function ownerOfLive(state) {
  const { sub } = liveIdentity()
  return sub ? ownerOf(state, 'antigravity', (id) => id.sub === sub) : null
}

export function isRunning() {
  return run('pgrep', ['-f', 'Antigravity IDE.app/Contents/MacOS/']).code === 0
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Ask the IDE to quit, then wait for it. Returns false if it is still up. */
export async function quit({ timeoutMs = 15_000 } = {}) {
  if (!isRunning()) return true
  run('osascript', ['-e', `quit app id "${BUNDLE_ID}"`])
  for (let waited = 0; waited < timeoutMs; waited += 300) {
    await sleep(300)
    if (!isRunning()) return true
  }
  return false
}

export function launch() {
  const r = run('open', ['-b', BUNDLE_ID])
  if (r.code !== 0) warn(`could not relaunch Antigravity IDE${r.err ? `: ${r.err}` : ''}`)
  return r.code === 0
}

/**
 * Wait for the keychain item to hold a *different* account than `previousSub`.
 *
 * There is no `agy login`: the browser flow lives inside the IDE, so the only
 * way to add a second account is to let the app do it and watch for the
 * result. A sign-out that empties the item is skipped, not treated as the new
 * login. Returns the new identity, or null on timeout.
 */
export async function waitForNewLogin(previousSub, { timeoutMs = 300_000, pollMs = 2_000, onWait } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(pollMs)
    const id = liveIdentity()
    if (id.sub && id.sub !== previousSub) return id
    onWait?.(deadline - Date.now())
  }
  return null
}

/** Re-snapshot the live login (its access token refreshes as you work). */
export function captureActive(state, { quiet = false } = {}) {
  const name = state.active.antigravity
  if (!name) return false
  const p = state.profiles[name]
  if (!p || p.kind !== 'google') return false

  const blob = liveBlob()
  if (!blob) {
    if (!quiet) warn(`could not read the Antigravity login — skipping capture for "${name}"`)
    return false
  }
  if (blob === vaultRead(name)) return false // unchanged, nothing to do

  // Signing in by hand (which is how a second account gets added) swaps the
  // item behind our back, so capturing blindly would bury the first login.
  const live = identityOf(blob)
  if (p.identity?.sub && live.sub && p.identity.sub !== live.sub) {
    if (!quiet) {
      warn(
        `the live Antigravity login is ${live.email ?? live.sub}, not "${name}" ` +
          `(${p.identity.email ?? p.identity.sub}) — skipping capture so its vault is not overwritten`,
      )
    }
    return false
  }

  vaultWrite(name, blob)
  if (live.sub) p.identity = { sub: live.sub, email: live.email }
  p.capturedAt = Date.now()
  if (!quiet) ok(`captured the refreshed Antigravity login for "${name}"`)
  return true
}

/**
 * The login lives only in the keychain, so there is no config file to back up
 * — `stamp` is accepted to keep the same shape as the other targets. The vault
 * copy of the account being switched away from is the backup.
 */
export function apply(state, name, stamp) {
  const p = get(state, name)
  if (p.target !== 'antigravity') throw new CcpError(`"${name}" is a ${p.target} profile, not antigravity`)

  captureActive(state)

  const blob = vaultRead(name)
  if (!blob) {
    throw new CcpError(
      `profile "${name}" has no login in the vault.\n` +
        `    Sign in to Antigravity as that account, then run \`ccp capture ${name}\`.`,
    )
  }
  writeSecret(GEMINI_SERVICE, blob, GEMINI_ACCOUNT)
  ok(`restored the Antigravity login for "${name}" (${p.identity?.email ?? 'email unknown'})`)
  state.active.antigravity = name
}

/** Turn the live login into a named profile. */
export function captureInto(state, name, { label } = {}) {
  const blob = liveBlob()
  if (!blob) {
    throw new CcpError(
      `could not read keychain item "${GEMINI_SERVICE}" (account "${GEMINI_ACCOUNT}").\n` +
        '    That means Antigravity has no login. Sign in inside Antigravity IDE first.',
    )
  }
  const id = identityOf(blob)
  vaultWrite(name, blob)
  return {
    target: 'antigravity',
    kind: 'google',
    label: label ?? id.authMethod ?? null,
    identity: { sub: id.sub, email: id.email },
    capturedAt: Date.now(),
  }
}

export function describe(state, name) {
  const p = get(state, name)
  const who = p.identity?.email ?? p.identity?.sub ?? '(not captured yet)'
  return [who, p.label].filter(Boolean).join(' · ')
}
