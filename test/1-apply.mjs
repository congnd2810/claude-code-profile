// Integration test in a throwaway HOME. Real configs are only ever read.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SRC = '/Volumes/congo-ssd/code/congnd/ccp/src'
const FAKE = process.env.FAKE_HOME
const REAL = os.homedir()

fs.rmSync(FAKE, { recursive: true, force: true })
fs.mkdirSync(path.join(FAKE, '.codex'), { recursive: true })
fs.mkdirSync(path.join(FAKE, '.claude'), { recursive: true })
// Copy the real configs in as fixtures — this is the shape that must survive.
fs.copyFileSync(path.join(REAL, '.codex/config.toml'), path.join(FAKE, '.codex/config.toml'))
fs.copyFileSync(path.join(REAL, '.claude/settings.json'), path.join(FAKE, '.claude/settings.json'))
fs.writeFileSync(path.join(FAKE, '.codex/auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { fake: 'x' } }, null, 2))
fs.writeFileSync(path.join(FAKE, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'real@x.com' }, numStartups: 8 }, null, 2))

process.env.HOME = FAKE

const store = await import(`${SRC}/store.mjs`)
const codex = await import(`${SRC}/codex.mjs`)
const claude = await import(`${SRC}/claude.mjs`)
const kc = await import(`${SRC}/keychain.mjs`)

const T_PROXY = 'ccptest-proxy'
const T_CODEX = 'ccptest-codex'

const state = store.load()
store.put(state, T_PROXY, {
  target: 'claude', kind: 'proxy',
  baseUrl: 'https://api.tuongtacfree.vn', model: 'claude-opus-5',
})
store.put(state, T_CODEX, {
  target: 'codex', kind: 'provider',
  providerId: 'tuongtacfree', providerName: 'TuongTacFree',
  baseUrl: 'https://api.tuongtacfree.vn/v1', wireApi: 'responses',
  model: 'gpt-5.6-sol', removeKeys: ['service_tier', 'model_reasoning_effort'],
})
store.save(state)

kc.vaultWrite(T_PROXY, 'sk-test-proxy-secret')
kc.vaultWrite(T_CODEX, 'sk-test-codex-secret')

console.log('\n########## codex.apply ##########')
codex.apply(state, T_CODEX, 'teststamp')
store.save(state)

console.log('\n########## claude.apply ##########')
claude.apply(state, T_PROXY, 'teststamp')
store.save(state)

const toml = fs.readFileSync(path.join(FAKE, '.codex/config.toml'), 'utf8')
console.log('\n########## config.toml: first 20 lines ##########')
console.log(toml.split('\n').slice(0, 20).join('\n'))
console.log('\n########## config.toml: tail ##########')
console.log(toml.split('\n').slice(-12).join('\n'))

console.log('\n########## invariants ##########')
const real = fs.readFileSync(path.join(REAL, '.codex/config.toml'), 'utf8')
const tables = (s) => (s.match(/^\[[^\]]+\]/gm) ?? [])
const realTables = tables(real).filter((t) => !t.startsWith('[model_providers.'))
const newTables = tables(toml).filter((t) => !t.startsWith('[model_providers.'))
const lost = realTables.filter((t) => !newTables.includes(t))
console.log('tables giu duoc:', newTables.length, '/', realTables.length, lost.length ? `MAT: ${lost}` : '(khong mat gi)')
console.log('so lan [model_providers.tuongtacfree]:', (toml.match(/\[model_providers\.tuongtacfree\]/g) ?? []).length)
console.log('service_tier con khong:', /^service_tier/m.test(toml))
console.log('model_reasoning_effort con khong:', /^model_reasoning_effort/m.test(toml))
console.log('personality con khong:', /^personality/m.test(toml))
console.log('top-level model truoc table dau:', toml.slice(0, toml.search(/^\[/m)).match(/^model.*$/gm))
const provIdx = toml.indexOf('[model_providers.tuongtacfree]')
const topKeysAfterProv = toml.slice(provIdx).split('\n').slice(1).filter((l) => /^[a-z_]+ =/.test(l))
console.log('keys sau provider table:', topKeysAfterProv)

const s = JSON.parse(fs.readFileSync(path.join(FAKE, '.claude/settings.json'), 'utf8'))
console.log('\nsettings.json env:', s.env)
console.log('settings.json model:', s.model)
console.log('permissions con nguyen:', Array.isArray(s.permissions?.allow) ? s.permissions.allow.length + ' entries' : 'MAT')
const auth = JSON.parse(fs.readFileSync(path.join(FAKE, '.codex/auth.json'), 'utf8'))
console.log('codex auth_mode:', auth.auth_mode, '| tokens con:', !!auth.tokens, '| key:', auth.OPENAI_API_KEY)

console.log('\n########## re-apply idempotency ##########')
codex.apply(state, T_CODEX, 'teststamp2')
const toml2 = fs.readFileSync(path.join(FAKE, '.codex/config.toml'), 'utf8')
console.log('config.toml giong lan truoc:', toml2 === toml)
console.log('so lan provider table sau 2 lan apply:', (toml2.match(/\[model_providers\.tuongtacfree\]/g) ?? []).length)

kc.vaultDelete(T_PROXY)
kc.vaultDelete(T_CODEX)
console.log('\ncleaned vault test entries')
