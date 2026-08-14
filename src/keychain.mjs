import os from 'node:os'
import { run, CcpError } from './util.mjs'

/**
 * macOS keychain access via /usr/bin/security.
 *
 * Two services matter:
 *   - "Claude Code-credentials"  → owned by Claude Code, holds the live OAuth blob
 *   - "ccp-vault"                → ours, one item per saved profile
 *
 * Secrets are treated as opaque strings. We never parse the Claude Code blob
 * beyond an optional, failure-tolerant peek at the expiry (see peekExpiry).
 */

// Overridable so tests can exercise the restore path without touching the
// real login. Never set this in normal use.
export const CLAUDE_SERVICE = process.env.CCP_CLAUDE_SERVICE || 'Claude Code-credentials'
export const VAULT_SERVICE = 'ccp-vault'
export const ACCOUNT = os.userInfo().username

/**
 * `security` locates the login keychain via $HOME. Always hand it the real
 * home directory — otherwise a shell with HOME pointed elsewhere makes macOS
 * pop a "keychain cannot be found" dialog instead of reading the vault.
 */
// stdin is closed and a timeout is set on purpose: `security` reads a missing
// -w value straight from /dev/tty, which would hang the CLI waiting on a
// "password data for new item:" prompt nobody asked for.
const SEC_ENV = {
  env: { ...process.env, HOME: os.userInfo().homedir },
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 15_000,
}

/**
 * `security -w` prints a hex dump instead of the raw value when the secret
 * contains a newline — which every multi-line auth.json does. Decode that back,
 * but only when the bytes really are printable text, so a secret that happens
 * to be pure hex is left alone.
 */
function decodeIfHexDump(out) {
  if (!/^[0-9a-f]+$/i.test(out) || out.length % 2 !== 0) return out
  const text = Buffer.from(out, 'hex').toString('utf8')
  const hasControlChar = [...text].some((ch) => {
    const code = ch.charCodeAt(0)
    return code < 32 && code !== 9 && code !== 10 && code !== 13
  })
  // The hex form only shows up for multi-line values, so require a newline
  // before treating the digits as encoded text rather than as the secret.
  if (!text.includes('\n') || hasControlChar) return out
  return text
}

export function readSecret(service, account = ACCOUNT) {
  const r = run('security', ['find-generic-password', '-s', service, '-a', account, '-w'], SEC_ENV)
  if (r.code !== 0) return null
  return decodeIfHexDump(r.out)
}

export function deleteSecret(service, account = ACCOUNT) {
  return run('security', ['delete-generic-password', '-s', service, '-a', account], SEC_ENV).code === 0
}

/**
 * Upsert a secret, then read it back to prove it landed. Tries stdin first so
 * the secret stays out of argv (visible in `ps`); falls back to -w <value> and
 * finally to delete+add when an existing item's ACL refuses an update.
 */
export function writeSecret(service, secret, account = ACCOUNT) {
  const label = `${service} (${account})`

  // The secret goes through argv, so it is briefly visible to `ps` on this
  // machine. The alternative (-w with no value) makes security prompt on the
  // tty instead of reading stdin, so there is no stdin path to use.
  const write = () =>
    run('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-D', 'ccp', '-w', secret], SEC_ENV)

  let r = write()
  if (readSecret(service, account) === secret) return

  // An item created by another app may have an ACL that blocks -U. Recreate it.
  deleteSecret(service, account)
  r = write()
  if (readSecret(service, account) === secret) return

  const why = r.err || r.out
  throw new CcpError(`could not write keychain item ${label}${why ? `: ${why}` : ''}`)
}

export function vaultRead(profileName) {
  return readSecret(VAULT_SERVICE, `${ACCOUNT}:${profileName}`)
}

export function vaultWrite(profileName, secret) {
  writeSecret(VAULT_SERVICE, secret, `${ACCOUNT}:${profileName}`)
}

export function vaultDelete(profileName) {
  return deleteSecret(VAULT_SERVICE, `${ACCOUNT}:${profileName}`)
}

/**
 * Best-effort access-token expiry peek so `ccp check` can flag stale tokens.
 * An expired access token does not mean the stored login is invalid: the
 * official app can normally replace it using the refresh credential.
 * Returns epoch ms or null — never throws, the blob format is not ours.
 */
export function peekExpiry(blob) {
  if (!blob) return null
  try {
    const j = JSON.parse(blob)
    const found = []
    const walk = (v) => {
      if (!v || typeof v !== 'object') return
      for (const [k, val] of Object.entries(v)) {
        if (/expires?_?at/i.test(k) && typeof val === 'number') found.push(val)
        else walk(val)
      }
    }
    walk(j)
    if (!found.length) return null
    const n = Math.max(...found)
    return n < 1e12 ? n * 1000 : n
  } catch {
    return null
  }
}
