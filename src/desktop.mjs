import fs from 'node:fs'
import path from 'node:path'
import { CCP_DIR, HOME, backup, ok, readJson, run, warn, writeJsonAtomic } from './util.mjs'

/**
 * Claude Desktop (the Claude.app window, including its Claude Code tab) does
 * not use the "Claude Code-credentials" keychain item at all — it keeps its
 * own login in two places, and hands it down to the CLI it spawns via env.
 * Switching a profile therefore has to move both of them or the app stays
 * signed in as whoever it was.
 */
const APP_DIR = path.join(HOME, 'Library', 'Application Support', 'Claude')
const CONFIG = path.join(APP_DIR, 'config.json')
const SNAP_DIR = path.join(CCP_DIR, 'desktop')
const BUNDLE_ID = 'com.anthropic.claudefordesktop'

// 1. The oauth token, encrypted by Electron safeStorage. Its key ("Claude
// Safe Storage" in the keychain) is per user, not per login, so the
// ciphertext can be moved between profiles without ever decrypting it.
const LOGIN_KEYS = ['oauth:tokenCache', 'oauth:tokenCacheV2', 'lastKnownAccountUuid']

// 2. The claude.ai web session the window itself is signed in with. Moving
// the token without these leaves the UI showing the old account.
const COOKIE_FILES = ['Cookies', 'Cookies-journal', 'Cookies-wal', 'Cookies-shm']

export const PATHS = { APP_DIR, CONFIG, SNAP_DIR }

export function isInstalled() {
  return fs.existsSync(CONFIG)
}

/** Which account the app is signed in as (uuid), or null. */
export function liveAccountUuid() {
  return readJson(CONFIG, {}).lastKnownAccountUuid ?? null
}

export function isRunning() {
  return run('pgrep', ['-f', 'Claude.app/Contents/MacOS/Claude']).code === 0
}

const dirFor = (name) => path.join(SNAP_DIR, name)
const loginFile = (name) => path.join(dirFor(name), 'login.json')

export function hasSnapshot(name) {
  return fs.existsSync(loginFile(name))
}

export function forget(name) {
  fs.rmSync(dirFor(name), { recursive: true, force: true })
}

/** The profile that owns the login the app currently holds, or null. */
export function ownerOf(state, uuid = liveAccountUuid()) {
  if (!uuid) return null
  for (const [name, p] of Object.entries(state.profiles)) {
    if (p.target === 'claude' && p.kind === 'oauth' && p.identity?.accountUuid === uuid) return name
  }
  return null
}

/** How to name the app's current login in a message. */
export function describeLive(state) {
  const uuid = liveAccountUuid()
  if (!uuid) return 'no login'
  const owner = ownerOf(state, uuid)
  return owner ? `"${owner}"` : `an account ccp does not know (${uuid})`
}

/**
 * Snapshot the app's login into <name>.
 *
 * Guarded the same way the keychain capture is: the app account and the CLI
 * account move independently, so a blind copy would file one account's app
 * session under another account's profile.
 */
export function capture(name, profile, { quiet = false } = {}) {
  if (!isInstalled() || profile?.kind !== 'oauth') return false

  // Nothing to say when there is nothing to take: the app being signed out,
  // or signed in as someone else, is the normal case on most switches.
  const live = liveAccountUuid()
  if (!live) return false
  const want = profile.identity?.accountUuid
  if (want && live !== want) return false

  const cfg = readJson(CONFIG, {})
  const login = {}
  for (const k of LOGIN_KEYS) if (cfg[k] !== undefined) login[k] = cfg[k]
  if (!login['oauth:tokenCacheV2'] && !login['oauth:tokenCache']) return false

  const dir = dirFor(name)
  const unchanged = JSON.stringify(readJson(loginFile(name), null)) === JSON.stringify(login)
  if (unchanged) return false

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeJsonAtomic(loginFile(name), login)
  for (const f of COOKIE_FILES) {
    const src = path.join(APP_DIR, f)
    const dest = path.join(dir, f)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest)
      fs.chmodSync(dest, 0o600)
    } else {
      fs.rmSync(dest, { force: true })
    }
  }
  profile.desktopCapturedAt = Date.now()
  if (!quiet) ok(`snapshotted the Claude Desktop login for "${name}"`)
  return true
}

/** Keep the app's current login reachable before we overwrite it. */
export function captureLiveOwner(state, { quiet = false } = {}) {
  const owner = ownerOf(state)
  if (!owner) return false
  return capture(owner, state.profiles[owner], { quiet })
}

/** Put <name>'s snapshot back. The app must not be running. */
export function restore(name, stamp) {
  const login = readJson(loginFile(name), null)
  if (!login) return false

  backup(CONFIG, stamp)
  const cfg = readJson(CONFIG, {})
  for (const k of LOGIN_KEYS) delete cfg[k]
  Object.assign(cfg, login)
  writeJsonAtomic(CONFIG, cfg)

  for (const f of COOKIE_FILES) {
    const src = path.join(dirFor(name), f)
    const dest = path.join(APP_DIR, f)
    backup(dest, stamp)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest)
      fs.chmodSync(dest, 0o600)
    } else {
      fs.rmSync(dest, { force: true })
    }
  }
  return true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Ask the app to quit, then wait for it. Returns false if it is still up. */
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
  if (r.code !== 0) warn(`could not relaunch Claude Desktop${r.err ? `: ${r.err}` : ''}`)
  return r.code === 0
}
