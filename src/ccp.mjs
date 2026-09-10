#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { BACKUP_DIR, CcpError, ask, c, confirm, fail, fmtAge, fmtDuration, info, ok, readJson, runInteractive, stampNow, warn } from './util.mjs'
import * as store from './store.mjs'
import * as claude from './claude.mjs'
import * as codex from './codex.mjs'
import * as antigravity from './antigravity.mjs'
import * as desktop from './desktop.mjs'
import * as rotate from './rotate.mjs'
import { ACCOUNT, CLAUDE_SERVICE, deleteSecret, readSecret, vaultDelete, vaultRead, vaultWrite, writeSecret } from './keychain.mjs'
import { check } from './check.mjs'
import { reportsUsage, usage, usageAll } from './usage.mjs'
import { menu, select } from './tui.mjs'

const MODULES = { claude, codex, antigravity }
const mod = (target) => MODULES[target]

// Kinds that are a first-party login, i.e. something `capture` can save.
const LOGIN_KINDS = ['oauth', 'chatgpt', 'google']

const nameWidth = (state) => Math.max(12, ...Object.keys(state.profiles).map((n) => n.length))

function cmdList(state) {
  const width = nameWidth(state)
  for (const target of store.TARGETS) {
    const names = store.names(state, target)
    console.log(`\n  ${c.bold(store.TARGET_LABELS[target])}`)
    if (!names.length) {
      console.log(`     ${c.dim('(no profiles)')}`)
      continue
    }
    for (const name of names) {
      const p = state.profiles[name]
      const active = state.active[target] === name
      const age = p.capturedAt ? c.dim(` · ${fmtAge(p.capturedAt)}`) : ''
      console.log(
        `   ${active ? c.green('●') : ' '} ${c.bold(name.padEnd(width))} ${c.dim(p.kind.padEnd(8))} ` +
          `${mod(target).describe(state, name)}${age}`,
      )
    }
  }
  if (store.poolNames(state).length) printPools(state)
  console.log('')
}

async function cmdUse(state, name, { pool = null } = {}) {
  if (!name) throw new CcpError('missing profile name: `ccp use <name>`')
  // Pools share the namespace with profiles, so `ccp use` takes either.
  if (!pool && state.pools[name]) return cmdUsePool(state, name)

  const p = store.get(state, name)
  const stamp = stampNow()

  // The IDE and the `agy` CLI share one keychain item, and a running IDE can
  // write the login it still holds back over the one we just put there.
  const relaunch = p.target === 'antigravity' ? await quitAntigravity(name) : false

  mod(p.target).apply(state, name, stamp)
  p.lastUsedAt = Date.now()
  state.activePool[p.target] = pool
  store.save(state)

  if (p.target === 'claude' && p.kind === 'oauth') await useDesktop(state, name, stamp)
  if (relaunch && (await confirm('  Relaunch Antigravity IDE?'))) antigravity.launch()

  // Antigravity has no config file to copy — its login lives only in the
  // keychain, and the vault holds the copy of whatever we switched away from.
  if (p.target !== 'antigravity') info(`backup: ${path.join(BACKUP_DIR, stamp)}`)
  warn(`restart ${store.TARGET_LABELS[p.target]} to pick this up (running sessions keep the old one)`)
}

/** Get the IDE out of the way. Returns whether to offer a relaunch after. */
async function quitAntigravity(name) {
  if (!antigravity.isRunning()) return false
  warn('Antigravity IDE is running — it can write the login it still holds back over the new one')
  if (!(await confirm('  Quit Antigravity IDE first?'))) {
    warn(`left it running — if the account flips back, quit it and run \`ccp use ${name}\` again`)
    return false
  }
  if (!(await antigravity.quit())) {
    warn(`Antigravity IDE did not quit — close it by hand, then run \`ccp use ${name}\` again`)
    return false
  }
  return true
}

/**
 * Move the Claude Desktop login too. The app ignores the keychain item the
 * CLI uses, so without this step the window (and the Claude Code tab inside
 * it) stays on the previous account no matter how often it is restarted.
 */
async function useDesktop(state, name, stamp) {
  if (!desktop.isInstalled()) return

  const want = state.profiles[name].identity?.accountUuid
  if (want && desktop.liveAccountUuid() === want) {
    if (desktop.capture(name, state.profiles[name], { quiet: true })) store.save(state)
    info('Claude Desktop is already signed in as this account')
    return
  }

  // Save what the app holds now, or switching away from it loses that login.
  if (desktop.captureLiveOwner(state)) store.save(state)

  if (!desktop.hasSnapshot(name)) {
    warn(
      `Claude Desktop still holds ${desktop.describeLive(state)} and has no saved login for "${name}".\n` +
        `    Sign the app in as that account once, then run \`ccp capture ${name}\`.`,
    )
    return
  }

  if (desktop.isRunning()) {
    if (!(await confirm('  Quit Claude Desktop so its login can be swapped?'))) {
      warn('left Claude Desktop alone — it keeps the previous account')
      return
    }
    if (!(await desktop.quit())) {
      warn('Claude Desktop did not quit — close it by hand, then run `ccp use ' + name + '` again')
      return
    }
  }

  desktop.restore(name, stamp)
  ok('Claude Desktop switched to this account')
  if (await confirm('  Relaunch Claude Desktop?')) desktop.launch()
}

async function cmdCapture(state, name) {
  const target = name ? store.get(state, name).target : 'claude'
  if (name) {
    const p = store.get(state, name)
    if (!LOGIN_KINDS.includes(p.kind)) throw new CcpError(`"${name}" is not a login profile, nothing to capture`)
    const wasActive = state.active[target]
    state.active[target] = name
    const changed = mod(target).captureActive(state)
    state.active[target] = wasActive
    if (!changed) info('token unchanged — the vault is already current')
  } else {
    let n = 0
    for (const t of store.TARGETS) if (mod(t).captureActive(state)) n++
    if (!n) info('nothing to capture (token unchanged, or the active profile is not a login)')
  }
  store.save(state)
}

// ---- pools ----------------------------------------------------------------

/** One line per member: is it usable right now, and on what evidence. */
function memberLine(row, current, width) {
  const mark = row.name === current ? c.green('●') : ' '
  const when = row.until
    ? c.yellow(`out for ${fmtDuration(row.until - Date.now())}${row.marked ? ' (marked by hand)' : ''}`)
    : c.green('available')
  const seen =
    row.peak === null
      ? c.dim('no quota figures yet')
      : c.dim(`${row.peak}% used${row.usage?.fetchedAt ? ` · ${fmtAge(row.usage.fetchedAt)}` : ''}`)
  // Indented one step further than a pool line: these hang under one.
  return `      ${mark} ${row.name.padEnd(width)} ${when} ${c.dim('·')} ${seen}`
}

function printPools(state, { detail = false } = {}) {
  const width = nameWidth(state)
  console.log(`\n  ${c.bold('Pools')}`)
  for (const name of store.poolNames(state)) {
    const pool = state.pools[name]
    const active = store.activePoolFor(state, pool.target) === name
    console.log(
      `   ${active ? c.green('●') : ' '} ${c.bold(name.padEnd(width))} ${c.dim(pool.target.padEnd(8))} ` +
        `${pool.members.join(', ')} ${c.dim(`· at ${pool.threshold ?? store.DEFAULT_THRESHOLD}%`)}`,
    )
    if (!detail) continue
    const current = state.active[pool.target]
    for (const row of rotate.statuses(state, name)) console.log(memberLine(row, current, width))
  }
}

function cmdPool(state, args) {
  const [first, ...rest] = args

  if (!first) {
    if (!store.poolNames(state).length) {
      info('no pools yet — `ccp pool <name> <profile> <profile>` groups accounts to rotate between')
      return
    }
    printPools(state, { detail: true })
    console.log('')
    return
  }

  if (first === 'rm' || first === 'remove') {
    if (!rest[0]) throw new CcpError('missing name: `ccp pool rm <name>`')
    store.removePool(state, rest[0])
    store.save(state)
    return ok(`deleted pool "${rest[0]}" (the profiles themselves are untouched)`)
  }

  if (!rest.length) throw new CcpError(`missing members: \`ccp pool ${first} <profile> <profile>...\``)
  const pool = store.putPool(state, first, rest)
  store.save(state)
  ok(`pool "${first}" (${pool.target}): ${pool.members.join(', ')}`)
  info(`\`ccp use ${first}\` picks the least-used member · \`ccp rotate ${first}\` moves on when it runs out`)
}

/** How the pick was justified, for the line that announces it. */
function pickNote(rows, name) {
  const row = rows.find((r) => r.name === name)
  if (!row || row.peak === null) return c.dim(' · no quota figures yet')
  return c.dim(` · ${row.peak}% used${row.usage?.fetchedAt ? ` as of ${fmtAge(row.usage.fetchedAt)}` : ''}`)
}

async function cmdUsePool(state, name) {
  store.getPool(state, name)
  const r = rotate.pick(state, name)
  if (r.none) {
    warn(`every account in "${name}" is out of quota — soonest is "${r.name}" in ${fmtDuration(r.until - Date.now())}`)
    process.exitCode = 4
    return
  }
  info(`pool "${name}" → ${r.name}${pickNote(r.rows, r.name)}`)
  await cmdUse(state, r.name, { pool: name })
}

/**
 * Move a pool onto its best account. Exit codes so a shell can act on it:
 * 0 switched · 3 nothing to do · 4 every account is out.
 */
async function cmdRotate(state, arg) {
  const pools = arg ? [arg] : store.TARGETS.map((t) => store.activePoolFor(state, t)).filter(Boolean)
  if (!pools.length) {
    throw new CcpError('no pool is active — run `ccp use <pool>` first, or name one: `ccp rotate <pool>`')
  }

  let changed = 0
  let blocked = 0
  for (const name of pools) {
    const pool = store.getPool(state, name)
    const current = state.active[pool.target]
    console.log(`\n  ${c.bold(name)} ${c.dim(`(${pool.target})`)}`)

    // Only the account in use can be asked; the rest go on cached figures.
    const live = await rotate.refreshActive(state, name)
    if (live && !live.snapshot) info(`could not refresh quota for "${live.name}" — going on the last known figures`)
    store.save(state)

    const r = rotate.pick(state, name)
    const width = nameWidth(state)
    for (const row of r.rows) console.log(memberLine(row, current, width))

    if (r.none) {
      warn(`all out — soonest is "${r.name}" in ${fmtDuration(r.until - Date.now())}`)
      blocked++
      continue
    }
    if (r.name === current) {
      ok(`"${current}" is still the best account here — nothing to do`)
      continue
    }
    console.log('')
    await cmdUse(state, r.name, { pool: name })
    changed++
  }
  console.log('')
  process.exitCode = changed ? 0 : blocked ? 4 : 3
}

const parseDuration = (s) => {
  const m = /^(\d+(?:\.\d+)?)(h|m)$/.exec(s)
  return m ? Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 60_000) : null
}

/**
 * Record "this account is out" by hand — the only signal available for
 * Antigravity, and the quickest one when a tool has just told you so itself.
 */
function cmdMark(state, name, spec) {
  if (!name) throw new CcpError('missing name: `ccp mark <name> [5h|ok]`')
  const p = store.get(state, name)

  if (spec === 'ok' || spec === 'free') {
    delete p.exhaustedUntil
    store.save(state)
    return ok(`"${name}" is available again`)
  }

  const ms = spec ? parseDuration(spec) : rotate.DEFAULT_EXHAUSTED_MS
  if (!ms) throw new CcpError(`could not read "${spec}" as a duration — use e.g. 5h, 90m, or "ok" to clear`)
  p.exhaustedUntil = Date.now() + ms
  store.save(state)
  ok(`"${name}" marked out of quota for ${fmtDuration(ms)}`)
  const pool = store.poolNames(state, p.target).find((n) => state.pools[n].members.includes(name))
  if (pool) info(`run \`ccp rotate ${pool}\` to move on`)
}

/**
 * Two profiles for one account is never what someone means: a pool would then
 * "rotate" between two names sharing one quota. Catch it at add time, where
 * the fix (switch account first) is still obvious.
 */
async function notADuplicate(state, target, name) {
  const owner = mod(target).ownerOfLive(state)
  if (!owner || owner === name) return true
  warn(`the login in use is already saved as "${owner}" — this would be the same account twice`)
  return confirm(`  Save it again as "${name}" anyway?`)
}

/** Ask the provider what it serves so the model can be picked, not typed. */
async function pickModel(baseUrl, key, fallback) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 15_000)
  let ids = []
  try {
    const res = await fetch(`${baseUrl.replace(/\/v1$/, '')}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: ctl.signal,
    })
    if (res.ok) ids = (JSON.parse(await res.text()).data ?? []).map((m) => m.id).filter(Boolean)
  } catch {
    /* provider offline or no /v1/models — fall back to typing */
  } finally {
    clearTimeout(t)
  }
  if (!ids.length) {
    info('could not fetch the model list from this provider — type it instead')
    return (await ask(`  Model${fallback ? ` (${fallback})` : ''}: `)) || fallback
  }
  const picked = await select('Model:', [
    ...ids.map((id) => ({ label: id, value: id, default: id === fallback })),
    { label: 'type it myself...', value: null, hint: 'model not in this list' },
  ])
  if (picked) return picked
  warn('a provider\'s /v1/models is not always complete — any model name is allowed')
  return (await ask(`  Model${fallback ? ` (${fallback})` : ''}: `)) || fallback
}

async function cmdAdd(state) {
  console.log(`\n  ${c.bold('Add a profile')}\n`)
  const target = await select('Which tool?', [
    { label: 'claude', value: 'claude', hint: 'Claude Code', default: true },
    { label: 'codex', value: 'codex', hint: 'Codex' },
    { label: 'antigravity', value: 'antigravity', hint: 'Antigravity IDE + the agy CLI' },
  ])
  if (!target) return

  const kindItems =
    target === 'claude'
      ? [
          { label: 'oauth', value: 'oauth', hint: 'native Claude account (Pro/Max/Team)', default: true },
          { label: 'proxy', value: 'proxy', hint: 'third-party provider' },
          { label: 'apikey', value: 'apikey', hint: 'key from console.anthropic.com' },
        ]
      : [
          { label: 'chatgpt', value: 'chatgpt', hint: 'native ChatGPT login', default: true },
          { label: 'provider', value: 'provider', hint: 'third-party provider' },
        ]
  // Antigravity has one kind of login, so there is nothing to ask.
  const kind = target === 'antigravity' ? 'google' : await select('Kind?', kindItems)
  if (!kind) return

  const name = await ask('  Profile name (e.g. work-max, tuongtacfree): ')
  if (!name) throw new CcpError('a name is required')
  if (state.profiles[name] && !(await confirm(`  Profile "${name}" exists, overwrite?`))) return

  let profile
  if (kind === 'oauth') {
    const source = await select('Is this account already logged in?', [
      { label: 'yes, capture the current login', value: 'current', default: true },
      { label: 'no, sign in now', value: 'login', hint: 'runs `claude auth login`, opens a browser' },
    ])
    if (!source) return

    if (source === 'login') {
      const before = claude.liveIdentity().oauthAccount?.accountUuid ?? null
      const email = await ask('  Email to prefill (enter to skip): ')
      console.log(`  ${c.dim('Handing over to `claude auth login` — finish in the browser, then come back.')}\n`)
      const code = runInteractive('claude', ['auth', 'login', ...(email ? ['--email', email] : [])])
      if (code !== 0) throw new CcpError('`claude auth login` did not finish — nothing was saved')

      const after = claude.liveIdentity().oauthAccount?.accountUuid ?? null
      if (before && after && before === after) {
        warn('still the same account as before — check that the browser login used the intended one')
      }
    }

    if (!(await notADuplicate(state, 'claude', name))) return
    profile = claude.captureInto(state, name)
    ok(`captured: ${profile.identity?.emailAddress ?? '(email not readable)'}`)
  } else if (kind === 'chatgpt') {
    const source = await select('Is this account already logged in?', [
      { label: 'yes, capture the current login', value: 'current', default: true },
      { label: 'no, sign in now', value: 'login', hint: 'runs `codex login`, opens a browser' },
    ])
    if (!source) return

    if (source === 'login') {
      const before = codex.liveIdentity().accountId
      console.log(`  ${c.dim('Handing over to `codex login` — finish in the browser, then come back.')}\n`)
      const code = runInteractive('codex', ['login'])
      if (code !== 0) throw new CcpError('`codex login` did not finish — nothing was saved')

      const after = codex.liveIdentity().accountId
      if (before && after && before === after) {
        warn('still the same account as before — check that the browser login used the intended one')
      }
    }

    if (!(await notADuplicate(state, 'codex', name))) return
    profile = codex.captureInto(state, name)
    ok(`captured: ${profile.identity?.email ?? profile.identity?.accountId ?? 'auth.json'}`)
  } else if (kind === 'google') {
    const before = antigravity.liveIdentity()
    const owner = antigravity.ownerOfLive(state)
    if (owner && owner !== name) {
      info(`Antigravity is signed in as ${before.email ?? before.sub}, already saved as "${owner}"`)
    }

    const source = await select('Is this account already signed in to Antigravity?', [
      { label: 'yes, capture the current login', value: 'current', default: !owner },
      {
        label: 'no, I will switch accounts in the IDE now',
        value: 'wait',
        hint: 'opens the IDE and waits for the new sign-in',
        default: !!owner,
      },
    ])
    if (!source) return

    if (source === 'wait') {
      // `agy` has no login command: the browser flow only exists inside the
      // IDE, so the only thing ccp can do is hand over and watch.
      if (!antigravity.isRunning()) antigravity.launch()
      console.log(
        `  ${c.dim('In Antigravity IDE: sign out, then sign in as the other account.')}\n` +
          `  ${c.dim('Waiting for the login to change — ctrl-C to give up.')}\n`,
      )
      const id = await antigravity.waitForNewLogin(before.sub, {
        onWait: (left) => process.stdout.write(`\r  ${c.dim(`still ${before.email ?? 'the same account'} · ${fmtDuration(left)} left`)}   `),
      })
      process.stdout.write('\n')
      if (!id) throw new CcpError('the Antigravity login never changed — nothing was saved')
      ok(`Antigravity is now signed in as ${id.email ?? id.sub}`)
    }

    if (!(await notADuplicate(state, 'antigravity', name))) return
    profile = antigravity.captureInto(state, name)
    ok(`captured: ${profile.identity?.email ?? '(email not readable)'}`)
  } else if (kind === 'apikey') {
    const key = await ask('  ANTHROPIC_API_KEY: ', { silent: true })
    if (!key) throw new CcpError('a key is required')
    vaultWrite(name, key)
    profile = { target, kind, label: null, model: null, capturedAt: Date.now() }
  } else if (kind === 'proxy') {
    const baseUrl = (await ask('  Base URL (no /v1, e.g. https://api.tuongtacfree.vn): ')).replace(/\/+$/, '')
    if (!baseUrl) throw new CcpError('a base URL is required')
    const key = await ask('  API key: ', { silent: true })
    if (!key) throw new CcpError('a key is required')
    const model = await pickModel(baseUrl, key, 'claude-opus-5')
    if (!model) throw new CcpError('a model is required')
    vaultWrite(name, key)
    profile = { target, kind, label: null, baseUrl, model, capturedAt: Date.now() }
  } else {
    const providerId = (await ask('  Provider id (e.g. tuongtacfree): ')).trim()
    if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) throw new CcpError('provider id may only contain letters, digits, _ -')
    const providerName = (await ask(`  Display name (${providerId}): `)) || providerId
    const baseUrl = (await ask('  Base URL (with /v1, e.g. https://api.tuongtacfree.vn/v1): ')).replace(/\/+$/, '')
    if (!baseUrl) throw new CcpError('a base URL is required')
    const wireApi = await select('wire_api?', [
      { label: 'responses', value: 'responses', hint: 'the only one recent Codex supports', default: true },
      { label: 'chat', value: 'chat', hint: 'older Codex builds' },
    ])
    if (!wireApi) return
    const key = await ask('  API key: ', { silent: true })
    if (!key) throw new CcpError('a key is required')
    const model = await pickModel(baseUrl, key, null)
    if (!model) throw new CcpError('a model is required')
    const dropTier = await select('Drop service_tier + model_reasoning_effort?', [
      { label: 'yes', value: true, hint: 'third-party providers usually reject them', default: true },
      { label: 'no', value: false, hint: 'leave them in config.toml' },
    ])
    vaultWrite(name, key)
    profile = {
      target,
      kind,
      label: providerName,
      providerId,
      providerName,
      baseUrl,
      wireApi,
      model,
      removeKeys: dropTier ? ['service_tier', 'model_reasoning_effort'] : [],
      capturedAt: Date.now(),
    }
  }

  store.put(state, name, profile)
  store.save(state)
  ok(`added "${name}"`)
  if (await confirm('  Activate it now?')) await cmdUse(state, name)
}

async function cmdRemove(state, name) {
  if (!name) throw new CcpError('missing name: `ccp rm <name>`')
  store.get(state, name)
  if (!(await confirm(`  Delete profile "${name}" (including its vault entry)?`))) return
  const inPools = store.poolNames(state).filter((n) => state.pools[n].members.includes(name))
  vaultDelete(name)
  desktop.forget(name)
  store.remove(state, name)
  store.save(state)
  ok(`deleted "${name}"`)
  for (const pool of inPools) {
    info(state.pools[pool] ? `removed it from pool "${pool}"` : `pool "${pool}" is gone too — it had no other member`)
  }
}

function cmdEnv(state, name) {
  if (!name) throw new CcpError('missing name: `ccp env <name>`')
  const p = store.get(state, name)
  if (p.target !== 'claude') throw new CcpError('env only applies to claude profiles')
  if (p.kind === 'oauth') {
    console.error('# oauth profiles live in the keychain and have no env — use `ccp use` instead of `eval`')
    process.exitCode = 1
    return
  }
  const env = claude.envFor(state, name)
  for (const [k, v] of Object.entries(env)) console.log(`export ${k}='${String(v).replace(/'/g, `'\\''`)}'`)
  if (p.model) console.log(`export ANTHROPIC_MODEL='${p.model}'`)
}

function cmdDoctor(state) {
  console.log(`\n  ${c.bold('doctor')}\n`)

  const settings = readJson(claude.PATHS.SETTINGS, null)
  if (settings) ok(`settings.json readable · model=${settings.model ?? '(not set)'}`)
  else warn(`${claude.PATHS.SETTINGS} not found`)
  const envKeys = Object.keys(settings?.env ?? {})
  info(envKeys.length ? `env currently set: ${envKeys.join(', ')}` : 'settings.json has no env')

  const selfService = 'ccp-selftest'
  try {
    writeSecret(selfService, `probe-${process.pid}`)
    const back = readSecret(selfService)
    if (back === `probe-${process.pid}`) ok('keychain readable and writable')
    else fail('keychain accepted the write but read back the wrong value')
  } catch (e) {
    fail(`keychain error: ${e.message}`)
  } finally {
    deleteSecret(selfService)
  }

  const activeClaude = state.active.claude
  if (activeClaude && state.profiles[activeClaude]?.kind === 'oauth') {
    const live = readSecret(CLAUDE_SERVICE)
    const saved = vaultRead(activeClaude)
    if (!live) warn('could not read the token in use (not logged in?)')
    else if (live === saved) ok(`vault for "${activeClaude}" matches the token in use`)
    else warn('the token in use has been refreshed — run `ccp capture` so the vault does not go stale')
  }

  const ag = antigravity.liveIdentity()
  if (ag.sub || ag.email) {
    const left = ag.expiresAt ? ` · access token ${ag.expiresAt > Date.now() ? `valid ${fmtDuration(ag.expiresAt - Date.now())}` : 'expired'}` : ''
    info(`Antigravity login in use: ${ag.email ?? ag.sub}${left}${antigravity.isRunning() ? ' (IDE running)' : ''}`)
    const owner = store.names(state, 'antigravity').find((n) => state.profiles[n].identity?.sub === ag.sub)
    info(owner ? `it belongs to profile "${owner}"` : 'no profile has captured it yet — `ccp add` → antigravity')
    const activeAg = state.active.antigravity
    if (activeAg && vaultRead(activeAg) && antigravity.liveBlob() !== vaultRead(activeAg)) {
      warn(`the Antigravity login has refreshed — run \`ccp capture ${activeAg}\` so the vault does not go stale`)
    }
  } else {
    info('Antigravity: no login found (keychain item "gemini" / account "antigravity")')
  }

  const pools = store.poolNames(state)
  info(pools.length ? `pools: ${pools.join(', ')}` : 'no pools defined')

  if (desktop.isInstalled()) {
    info(`Claude Desktop login: ${desktop.describeLive(state)}${desktop.isRunning() ? ' (running)' : ''}`)
    const snaps = store.names(state, 'claude').filter((n) => desktop.hasSnapshot(n))
    info(
      snaps.length
        ? `Claude Desktop logins saved: ${snaps.join(', ')}`
        : 'no Claude Desktop login saved yet — run `ccp capture <name>` while the app is signed in as it',
    )
  }

  const ids = state.managed.codexProviderIds ?? []
  info(ids.length ? `codex providers ccp manages: ${ids.join(', ')}` : 'not managing any codex provider yet')
  info(`keychain account: ${ACCOUNT}`)
  info(`profiles: ${store.FILE_PATH}`)

  try {
    const stamps = fs.readdirSync(BACKUP_DIR).sort()
    info(stamps.length ? `latest backup: ${path.join(BACKUP_DIR, stamps[stamps.length - 1])}` : 'no backups yet')
  } catch {
    info('no backups yet')
  }
  console.log('')
}

const COMMANDS = [
  ['list', 'list saved profiles and pools'],
  ['use <name>', 'activate a profile or pool (captures the old token first)'],
  ['add', 'add a profile'],
  ['rm <name>', 'delete a profile'],
  ['pool', 'list pools and what each account has left'],
  ['pool <name> <profile...>', 'group accounts to rotate between'],
  ['pool rm <name>', 'delete a pool'],
  ['rotate [pool]', 'move a pool onto its best account'],
  ['mark <name> [5h|ok]', 'record that an account is out of quota'],
  ['capture [name]', 'save the login in use back into the vault'],
  ['check <name>', 'check a profile or provider'],
  ['usage [name]', 'show quota for a first-party login'],
  ['usage --all', 'show every login (live if active, cached otherwise)'],
  ['env <name>', 'print exports for a Claude proxy or API key'],
  ['doctor', 'check the setup'],
  ['completion zsh', 'print zsh tab-completion setup'],
  ['commands', 'list commands'],
  ['help', 'show help'],
]

function printHelp() {
  const width = Math.max(...COMMANDS.map(([usage]) => usage.length))
  const lines = COMMANDS.map(([usage, description]) => `  ${c.dim(`ccp ${usage}`.padEnd(width + 6))}${description}`)
  console.log(`
  ${c.bold('ccp')} — switch profiles for Claude Code, Codex and Antigravity

  ${c.dim('ccp'.padEnd(width + 6))}open the profile menu
${lines.join('\n')}
`)
}

function printZshCompletion() {
  const seen = new Set()
  const commands = COMMANDS.filter(([usage]) => {
    const name = usage.split(' ')[0]
    if (seen.has(name)) return false
    seen.add(name)
    return true
  }).map(([usage, description]) => {
    const name = usage.split(' ')[0]
    return `    '${name}:${description}'`
  })
  console.log(`#compdef ccp
# Add to ~/.zshrc: eval "$(ccp completion zsh)"

_ccp() {
  local -a commands profiles
  commands=(
${commands.join('\n')}
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  case \"\${words[2]}\" in
    use|rm|remove|capture|check|usage|env|mark|rotate|pool)
      profiles=(\"\${(@f)$(command ccp __complete profiles \"\${words[2]}\" 2>/dev/null)}\")
      (( \${#profiles} )) && compadd -- \"\${profiles[@]}\"
      [[ \"\${words[2]}\" == usage ]] && compadd -- --all -a
      [[ \"\${words[2]}\" == pool ]] && compadd -- rm
      ;;
    completion)
      compadd -- zsh
      ;;
  esac
}

compdef _ccp ccp`)
}

function printCompletion(state, type, command) {
  if (type !== 'profiles') return

  // `rotate` only ever takes a pool; `use` takes either.
  if (command !== 'rotate') {
    for (const name of store.names(state)) {
      const p = state.profiles[name]
      if (command === 'capture' && !LOGIN_KINDS.includes(p.kind)) continue
      if (command === 'usage' && !reportsUsage(p.kind)) continue
      if (command === 'env' && (p.target !== 'claude' || p.kind === 'oauth')) continue
      console.log(name)
    }
  }
  if (command === 'use' || command === 'rotate' || command === 'pool') {
    for (const name of store.poolNames(state)) console.log(name)
  }
}

async function runTui(state) {
  for (;;) {
    const { action, name } = await menu(state)
    if (action === 'quit') return
    try {
      if (action === 'use') await cmdUse(state, name)
      else if (action === 'capture') await cmdCapture(state, name)
      else if (action === 'add') await cmdAdd(state)
      else if (action === 'delete') await cmdRemove(state, name)
      else if (action === 'check') await check(state, name)
      else if (action === 'usage') await usage(state, name)
      else if (action === 'rotate') await cmdRotate(state, name)
    } catch (e) {
      if (e instanceof CcpError) fail(e.message)
      else throw e
    }
    await ask(`\n  ${c.dim('press enter to go back...')}`)
    state = store.load()
  }
}

async function main() {
  const args = process.argv.slice(2)
  const [cmd, arg, third] = args
  const state = store.load()

  switch (cmd) {
    case undefined:
      if (!process.stdin.isTTY) return printHelp()
      return runTui(state)
    case 'list':
    case 'ls':
      return cmdList(state)
    case 'use':
      return cmdUse(state, arg)
    case 'add':
      return cmdAdd(state)
    case 'rm':
    case 'remove':
      return cmdRemove(state, arg)
    case 'pool':
      return cmdPool(state, args.slice(1))
    case 'rotate':
      return cmdRotate(state, arg)
    case 'mark':
      return cmdMark(state, arg, third)
    case 'capture':
      return cmdCapture(state, arg)
    case 'check':
      return check(state, arg ?? state.active.claude)
    case 'usage':
      if (arg === '--all' || arg === '-a') return usageAll(state)
      if (arg) return usage(state, arg).then(() => console.log(''))
      // No name given: the logins in play right now.
      return usageAll(state, { activeOnly: true })
    case 'env':
      return cmdEnv(state, arg)
    case 'doctor':
      return cmdDoctor(state)
    case 'commands':
    case 'help':
    case '--help':
    case '-h':
      return printHelp()
    case 'completion':
      if (arg !== 'zsh') throw new CcpError('supported shell: `ccp completion zsh`')
      return printZshCompletion()
    case '__complete':
      return printCompletion(state, arg, third)
    default:
      return printHelp()
  }
}

main().catch((e) => {
  if (e instanceof CcpError) {
    fail(e.message)
    process.exit(1)
  }
  throw e
})
