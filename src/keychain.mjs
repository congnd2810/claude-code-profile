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
const SEC_ENV = { env: { ...process.env, HOME: os.userInfo().homedir } }

export function readSecret(service, account = ACCOUNT) {
  const r = run('security', ['find-generic-password', '-s', service, '-a', account, '-w'], SEC_ENV)
  if (r.code !== 0) return null
  return r.out
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

  const viaStdin = () =>
    run('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-D', 'ccp', '-w'], {
      ...SEC_ENV,
      input: `${secret}\n${secret}\n`,
    })
  const viaArgv = () =>
    run('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-D', 'ccp', '-w', secret], SEC_ENV)

  const attempts = [viaStdin, viaArgv]
  let lastErr = ''
  for (const attempt of attempts) {
    attempt()
    if (readSecret(service, account) === secret) return
  }
  // Existing item may have an ACL that blocks -U. Recreate it.
  deleteSecret(service, account)
  const r = viaArgv()
  lastErr = r.err || r.out
  if (readSecret(service, account) === secret) return

  throw new CcpError(`khong ghi duoc keychain ${label}${lastErr ? `: ${lastErr}` : ''}`)
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
 * Best-effort expiry peek so `ccp list` can flag stale OAuth tokens.
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
