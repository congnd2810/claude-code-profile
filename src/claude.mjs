import path from 'node:path'
import { HOME, CcpError, backup, info, ok, readJson, warn, writeJsonAtomic } from './util.mjs'
import { CLAUDE_SERVICE, readSecret, vaultRead, vaultWrite, writeSecret } from './keychain.mjs'
import { get } from './store.mjs'

const SETTINGS = path.join(HOME, '.claude', 'settings.json')
const CLAUDE_JSON = path.join(HOME, '.claude.json')

// Every env var ccp may set for Claude Code. Anything outside this list in
// settings.json.env belongs to the user and is left alone.
const OWNED_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
]

export const PATHS = { SETTINGS, CLAUDE_JSON }

/** Read the OAuth blob Claude Code is using right now (null if not logged in). */
export function liveBlob() {
  return readSecret(CLAUDE_SERVICE)
}

export function liveIdentity() {
  const j = readJson(CLAUDE_JSON, {})
  return { oauthAccount: j.oauthAccount ?? null, userID: j.userID ?? null }
}

export function liveModel() {
  return readJson(SETTINGS, {}).model ?? null
}

/**
 * Snapshot the currently-active oauth profile back into the vault.
 *
 * This is the fix for the one gotcha that would otherwise bite constantly:
 * Claude Code silently refreshes the OAuth token while you work, so the blob
 * we stored at add-time goes stale. We re-capture on every switch.
 */
export function captureActive(state, { quiet = false } = {}) {
  const name = state.active.claude
  if (!name) return false
  const p = state.profiles[name]
  if (!p || p.kind !== 'oauth') return false

  const blob = liveBlob()
  if (!blob) {
    if (!quiet) warn(`could not read the current token — skipping capture for "${name}"`)
    return false
  }
  if (blob === vaultRead(name)) return false // unchanged, nothing to do

  const id = liveIdentity()
  // The live token does not necessarily belong to the active profile: logging
  // in by hand (which is how a second account gets added) swaps it behind our
  // back. Capturing blindly would overwrite one account's vault with another
  // account's token and lose the first login.
  const was = p.identity?.accountUuid
  const now = id.oauthAccount?.accountUuid
  if (was && now && was !== now) {
    if (!quiet) {
      warn(
        `the live login is ${id.oauthAccount.emailAddress}, not "${name}" (${p.identity.emailAddress}) ` +
          `— skipping capture so its vault is not overwritten`,
      )
    }
    return false
  }

  vaultWrite(name, blob)
  if (id.oauthAccount) p.identity = id.oauthAccount
  if (id.userID) p.userID = id.userID
  const m = liveModel()
  if (m) p.model = m
  p.capturedAt = Date.now()
  if (!quiet) ok(`captured the refreshed token for "${name}"`)
  return true
}

/** Build the env map a profile needs (empty for oauth — it uses the keychain). */
export function envFor(state, name) {
  const p = get(state, name)
  const env = {}
  if (p.kind === 'proxy') {
    const token = vaultRead(name)
    if (!token) throw new CcpError(`profile "${name}" has no key in the vault — run \`ccp add\` again`)
    env.ANTHROPIC_BASE_URL = p.baseUrl
    env.ANTHROPIC_AUTH_TOKEN = token
  } else if (p.kind === 'apikey') {
    const key = vaultRead(name)
    if (!key) throw new CcpError(`profile "${name}" has no key in the vault — run \`ccp add\` again`)
    env.ANTHROPIC_API_KEY = key
  }
  Object.assign(env, p.env ?? {})
  return env
}

export function apply(state, name, stamp) {
  const p = get(state, name)
  if (p.target !== 'claude') throw new CcpError(`"${name}" is a ${p.target} profile, not claude`)

  captureActive(state)

  backup(SETTINGS, stamp)
  backup(CLAUDE_JSON, stamp)

  const settings = readJson(SETTINGS, {})
  const env = { ...(settings.env ?? {}) }

  // Drop everything ccp previously owned, then lay down this profile's env.
  for (const k of new Set([...OWNED_ENV, ...(state.managed.claudeEnvKeys ?? [])])) delete env[k]
  const wanted = envFor(state, name)
  Object.assign(env, wanted)

  if (Object.keys(env).length) settings.env = env
  else delete settings.env

  if (p.model) settings.model = p.model

  if (p.kind === 'oauth') {
    const blob = vaultRead(name)
    if (!blob) {
      throw new CcpError(
        `profile "${name}" has no token in the vault.\n` +
          `    Run \`claude\`, \`/login\` with that account, then \`ccp capture ${name}\`.`,
      )
    }
    writeSecret(CLAUDE_SERVICE, blob)
    ok(`restored the oauth token for "${name}"`)

    if (p.identity || p.userID) {
      const j = readJson(CLAUDE_JSON, {})
      if (p.identity) j.oauthAccount = p.identity
      if (p.userID) j.userID = p.userID
      writeJsonAtomic(CLAUDE_JSON, j)
      ok(`identity set to ${p.identity?.emailAddress ?? '(email unknown)'}`)
    } else {
      warn('profile stores no identity — Claude Code may show the wrong account; run `ccp capture` once inside')
    }
  }

  writeJsonAtomic(SETTINGS, settings)
  state.managed.claudeEnvKeys = Object.keys(wanted)
  state.active.claude = name

  if (Object.keys(wanted).length) {
    ok(`settings.json: set ${Object.keys(wanted).join(', ')}`)
  } else {
    ok('settings.json: cleared all ANTHROPIC_* env (using the native login)')
  }
  if (p.model) info(`model: ${p.model}`)
}

/** Turn the live login into a named oauth profile. */
export function captureInto(state, name, { label } = {}) {
  const blob = liveBlob()
  if (!blob) {
    throw new CcpError(
      'could not read keychain item "Claude Code-credentials".\n' +
        '    That means no subscription login is present. Run `claude`, then `/login` first.',
    )
  }
  const id = liveIdentity()
  vaultWrite(name, blob)
  const profile = {
    target: 'claude',
    kind: 'oauth',
    label: label ?? id.oauthAccount?.organizationName ?? null,
    identity: id.oauthAccount ?? null,
    userID: id.userID ?? null,
    model: liveModel(),
    capturedAt: Date.now(),
  }
  return profile
}

export function describe(state, name) {
  const p = get(state, name)
  if (p.kind === 'oauth') {
    const email = p.identity?.emailAddress ?? '(not captured yet)'
    const org = p.identity?.organizationName
    const tier = p.identity?.userRateLimitTier
    return [email, org, tier].filter(Boolean).join(' · ')
  }
  if (p.kind === 'proxy') return `${p.baseUrl} → ${p.model ?? '(default model)'}`
  return 'ANTHROPIC_API_KEY'
}
