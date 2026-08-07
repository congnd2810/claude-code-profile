#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { BACKUP_DIR, CcpError, ask, c, confirm, fail, fmtAge, info, ok, readJson, stampNow, warn } from './util.mjs'
import * as store from './store.mjs'
import * as claude from './claude.mjs'
import * as codex from './codex.mjs'
import { ACCOUNT, CLAUDE_SERVICE, deleteSecret, readSecret, vaultDelete, vaultRead, vaultWrite, writeSecret } from './keychain.mjs'
import { check } from './check.mjs'
import { menu, select } from './tui.mjs'

const mod = (target) => (target === 'claude' ? claude : codex)

function cmdList(state) {
  const width = Math.max(12, ...Object.keys(state.profiles).map((n) => n.length))
  for (const target of ['claude', 'codex']) {
    const names = store.names(state, target)
    console.log(`\n  ${c.bold(target === 'claude' ? 'Claude Code' : 'Codex')}`)
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
  console.log('')
}

async function cmdUse(state, name) {
  if (!name) throw new CcpError('missing profile name: `ccp use <name>`')
  const p = store.get(state, name)
  const stamp = stampNow()
  mod(p.target).apply(state, name, stamp)
  store.save(state)
  info(`backup: ${path.join(BACKUP_DIR, stamp)}`)
  warn(`restart ${p.target === 'claude' ? 'Claude Code' : 'Codex'} to pick this up (running sessions keep the old one)`)
}

async function cmdCapture(state, name) {
  const target = name ? store.get(state, name).target : 'claude'
  if (name) {
    const p = store.get(state, name)
    if (p.kind !== 'oauth' && p.kind !== 'chatgpt') throw new CcpError(`"${name}" is not a login profile, nothing to capture`)
    const wasActive = state.active[target]
    state.active[target] = name
    const changed = mod(target).captureActive(state)
    state.active[target] = wasActive
    if (!changed) info('token unchanged — the vault is already current')
  } else {
    let n = 0
    for (const t of ['claude', 'codex']) if (mod(t).captureActive(state)) n++
    if (!n) info('nothing to capture (token unchanged, or the active profile is not a login)')
  }
  store.save(state)
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
  const kind = await select('Kind?', kindItems)
  if (!kind) return

  const name = await ask('  Profile name (e.g. work-max, tuongtacfree): ')
  if (!name) throw new CcpError('a name is required')
  if (state.profiles[name] && !(await confirm(`  Profile "${name}" exists, overwrite?`))) return

  let profile
  if (kind === 'oauth') {
    console.log(`  ${c.dim('Saves the Claude Code login currently in use into the vault.')}`)
    profile = claude.captureInto(state, name)
    ok(`captured: ${profile.identity?.emailAddress ?? '(email not readable)'}`)
  } else if (kind === 'chatgpt') {
    console.log(`  ${c.dim('Saves the ~/.codex/auth.json currently in use into the vault.')}`)
    profile = codex.captureInto(state, name)
    ok('captured auth.json')
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
  vaultDelete(name)
  store.remove(state, name)
  store.save(state)
  ok(`deleted "${name}"`)
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

function usage() {
  console.log(`
  ${c.bold('ccp')} — switch profiles for Claude Code and Codex

  ${c.dim('ccp')}                 open the profile menu
  ${c.dim('ccp list')}            list profiles
  ${c.dim('ccp use <name>')}      activate (captures the old token first)
  ${c.dim('ccp add')}             add a profile
  ${c.dim('ccp rm <name>')}       delete a profile
  ${c.dim('ccp capture [name]')}  save the token in use back into the vault
  ${c.dim('ccp check <name>')}    probe the endpoint to see if it is alive
  ${c.dim('ccp env <name>')}      print exports for \`eval $(ccp env x)\`
  ${c.dim('ccp doctor')}          check the setup
`)
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
    } catch (e) {
      if (e instanceof CcpError) fail(e.message)
      else throw e
    }
    await ask(`\n  ${c.dim('press enter to go back...')}`)
    state = store.load()
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2)
  const state = store.load()

  switch (cmd) {
    case undefined:
      if (!process.stdin.isTTY) return usage()
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
    case 'capture':
      return cmdCapture(state, arg)
    case 'check':
      return check(state, arg ?? state.active.claude)
    case 'env':
      return cmdEnv(state, arg)
    case 'doctor':
      return cmdDoctor(state)
    default:
      return usage()
  }
}

main().catch((e) => {
  if (e instanceof CcpError) {
    fail(e.message)
    process.exit(1)
  }
  throw e
})
