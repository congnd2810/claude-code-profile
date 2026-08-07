#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { BACKUP_DIR, CcpError, ask, c, confirm, fail, fmtAge, info, ok, readJson, stampNow, warn } from './util.mjs'
import * as store from './store.mjs'
import * as claude from './claude.mjs'
import * as codex from './codex.mjs'
import { ACCOUNT, CLAUDE_SERVICE, readSecret, vaultDelete, vaultRead, vaultWrite, writeSecret } from './keychain.mjs'
import { check } from './check.mjs'
import { menu } from './tui.mjs'

const mod = (target) => (target === 'claude' ? claude : codex)

function cmdList(state) {
  const width = Math.max(12, ...Object.keys(state.profiles).map((n) => n.length))
  for (const target of ['claude', 'codex']) {
    const names = store.names(state, target)
    console.log(`\n  ${c.bold(target === 'claude' ? 'Claude Code' : 'Codex')}`)
    if (!names.length) {
      console.log(`     ${c.dim('(chua co profile)')}`)
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
  if (!name) throw new CcpError('thieu ten profile: `ccp use <name>`')
  const p = store.get(state, name)
  const stamp = stampNow()
  mod(p.target).apply(state, name, stamp)
  store.save(state)
  info(`backup: ${path.join(BACKUP_DIR, stamp)}`)
  warn(`restart ${p.target === 'claude' ? 'Claude Code' : 'Codex'} de ap dung (phien dang mo khong doi)`)
}

async function cmdCapture(state, name) {
  const target = name ? store.get(state, name).target : 'claude'
  if (name) {
    const p = store.get(state, name)
    if (p.kind !== 'oauth' && p.kind !== 'chatgpt') throw new CcpError(`"${name}" khong phai profile login, khong capture`)
    const wasActive = state.active[target]
    state.active[target] = name
    const changed = mod(target).captureActive(state)
    state.active[target] = wasActive
    if (!changed) info('token khong doi — vault da moi nhat')
  } else {
    let n = 0
    for (const t of ['claude', 'codex']) if (mod(t).captureActive(state)) n++
    if (!n) info('khong co gi de capture (token khong doi hoac profile active khong phai login)')
  }
  store.save(state)
}

async function cmdAdd(state) {
  console.log(`\n  ${c.bold('Them profile')}\n`)
  const target = (await ask('  Cho cong cu nao? [claude/codex] (claude): ')) || 'claude'
  if (!['claude', 'codex'].includes(target)) throw new CcpError('chi nhan claude hoac codex')

  const kinds = store.KINDS[target]
  const kindHint = target === 'claude' ? 'oauth = login goc, proxy = ben thu 3, apikey = key Anthropic' : 'chatgpt = login goc, provider = ben thu 3'
  console.log(`  ${c.dim(kindHint)}`)
  const kind = (await ask(`  Loai? [${kinds.join('/')}] (${kinds[0]}): `)) || kinds[0]
  if (!kinds.includes(kind)) throw new CcpError(`loai khong hop le cho ${target}`)

  const name = await ask('  Ten profile (vd work-max, tuongtacfree): ')
  if (!name) throw new CcpError('phai co ten')
  if (state.profiles[name] && !(await confirm(`  Profile "${name}" da co, ghi de?`))) return

  let profile
  if (kind === 'oauth') {
    console.log(`  ${c.dim('Se luu login Claude Code dang dung hien tai vao vault.')}`)
    profile = claude.captureInto(state, name)
    ok(`captured: ${profile.identity?.emailAddress ?? '(khong doc duoc email)'}`)
  } else if (kind === 'chatgpt') {
    console.log(`  ${c.dim('Se luu ~/.codex/auth.json dang dung hien tai vao vault.')}`)
    profile = codex.captureInto(state, name)
    ok('captured auth.json')
  } else if (kind === 'apikey') {
    const key = await ask('  ANTHROPIC_API_KEY: ', { silent: true })
    if (!key) throw new CcpError('phai co key')
    vaultWrite(name, key)
    profile = { target, kind, label: null, model: null, capturedAt: Date.now() }
  } else if (kind === 'proxy') {
    const baseUrl = (await ask('  Base URL (khong co /v1, vd https://api.tuongtacfree.vn): ')).replace(/\/+$/, '')
    if (!baseUrl) throw new CcpError('phai co base URL')
    const model = (await ask('  Model (claude-opus-5): ')) || 'claude-opus-5'
    const key = await ask('  API key: ', { silent: true })
    if (!key) throw new CcpError('phai co key')
    vaultWrite(name, key)
    profile = { target, kind, label: null, baseUrl, model, capturedAt: Date.now() }
  } else {
    const providerId = (await ask('  Provider id (vd tuongtacfree): ')).trim()
    if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) throw new CcpError('provider id chi dung chu, so, _ -')
    const providerName = (await ask(`  Ten hien thi (${providerId}): `)) || providerId
    const baseUrl = (await ask('  Base URL (co /v1, vd https://api.tuongtacfree.vn/v1): ')).replace(/\/+$/, '')
    if (!baseUrl) throw new CcpError('phai co base URL')
    const wireApi = (await ask('  wire_api [responses/chat] (responses): ')) || 'responses'
    const model = await ask('  Model (vd gpt-5.6-sol): ')
    if (!model) throw new CcpError('phai co model')
    const key = await ask('  API key: ', { silent: true })
    if (!key) throw new CcpError('phai co key')
    const dropTier = await confirm('  Bo service_tier + model_reasoning_effort? (proxy thuong khong ho tro)')
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
  ok(`da them "${name}"`)
  if (await confirm(`  Activate luon?`)) await cmdUse(state, name)
}

async function cmdRemove(state, name) {
  if (!name) throw new CcpError('thieu ten: `ccp rm <name>`')
  store.get(state, name)
  if (!(await confirm(`  Xoa profile "${name}" (ke ca key trong vault)?`))) return
  vaultDelete(name)
  store.remove(state, name)
  store.save(state)
  ok(`da xoa "${name}"`)
}

function cmdEnv(state, name) {
  if (!name) throw new CcpError('thieu ten: `ccp env <name>`')
  const p = store.get(state, name)
  if (p.target !== 'claude') throw new CcpError('env chi dung cho profile claude')
  if (p.kind === 'oauth') {
    console.error('# profile oauth dung keychain, khong co env — chay `ccp use` thay vi `eval`')
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
  if (settings) ok(`settings.json doc duoc · model=${settings.model ?? '(khong set)'}`)
  else warn(`khong thay ${claude.PATHS.SETTINGS}`)
  const envKeys = Object.keys(settings?.env ?? {})
  info(envKeys.length ? `env dang set: ${envKeys.join(', ')}` : 'settings.json khong co env')

  const selfService = 'ccp-selftest'
  try {
    writeSecret(selfService, `probe-${process.pid}`)
    const back = readSecret(selfService)
    if (back === `probe-${process.pid}`) ok('keychain doc/ghi duoc')
    else fail('keychain ghi duoc nhung doc lai sai')
  } catch (e) {
    fail(`keychain loi: ${e.message}`)
  }

  const activeClaude = state.active.claude
  if (activeClaude && state.profiles[activeClaude]?.kind === 'oauth') {
    const live = readSecret(CLAUDE_SERVICE)
    const saved = vaultRead(activeClaude)
    if (!live) warn('khong doc duoc token dang dung (chua login?)')
    else if (live === saved) ok(`vault cua "${activeClaude}" khop token dang dung`)
    else warn(`token dang dung da refresh — chay \`ccp capture\` de vault khong bi cu`)
  }

  const ids = state.managed.codexProviderIds ?? []
  info(ids.length ? `codex provider ccp dang quan: ${ids.join(', ')}` : 'chua quan codex provider nao')
  info(`keychain account: ${ACCOUNT}`)
  info(`profiles: ${store.FILE_PATH}`)

  try {
    const stamps = fs.readdirSync(BACKUP_DIR).sort()
    info(stamps.length ? `backup gan nhat: ${path.join(BACKUP_DIR, stamps[stamps.length - 1])}` : 'chua co backup')
  } catch {
    info('chua co backup')
  }
  console.log('')
}

function usage() {
  console.log(`
  ${c.bold('ccp')} — doi profile cho Claude Code va Codex

  ${c.dim('ccp')}                 mo menu chon profile
  ${c.dim('ccp list')}            liet ke profile
  ${c.dim('ccp use <name>')}      activate (tu capture token cu truoc khi doi)
  ${c.dim('ccp add')}             them profile moi
  ${c.dim('ccp rm <name>')}       xoa profile
  ${c.dim('ccp capture [name]')}  luu lai token dang dung vao vault
  ${c.dim('ccp check <name>')}    goi thu endpoint xem song khong
  ${c.dim('ccp env <name>')}      in export env de \`eval $(ccp env x)\`
  ${c.dim('ccp doctor')}          kiem tra thiet lap
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
    await ask(`\n  ${c.dim('enter de ve menu...')}`)
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
