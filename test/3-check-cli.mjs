// Round 3: `ccp check` against the live provider + CLI smoke test.
// Expectation (matches the curl findings): claude/messages OK,
// codex/responses fails with "No available accounts".
import { spawnSync } from 'node:child_process'

const SRC = new URL('../src', import.meta.url).pathname
const FAKE = process.env.FAKE_HOME
const KEY = process.env.TTF_KEY
process.env.HOME = FAKE

const store = await import(`${SRC}/store.mjs`)
const kc = await import(`${SRC}/keychain.mjs`)
const { check } = await import(`${SRC}/check.mjs`)

const P = 'ccptest-ttf-claude'
const C = 'ccptest-ttf-codex'
const state = store.load()
store.put(state, P, { target: 'claude', kind: 'proxy', baseUrl: 'https://api.tuongtacfree.vn', model: 'claude-opus-5' })
store.put(state, C, { target: 'codex', kind: 'provider', providerId: 'ttf', providerName: 'TTF', baseUrl: 'https://api.tuongtacfree.vn/v1', wireApi: 'responses', model: 'gpt-5.6-sol' })
state.active.claude = P
store.save(state)
kc.vaultWrite(P, KEY)
kc.vaultWrite(C, KEY)

console.log('########## ccp check ##########')
await check(state, P)
await check(state, C)

const cli = (...args) => {
  const r = spawnSync('node', [`${SRC}/ccp.mjs`, ...args], { encoding: 'utf8', env: { ...process.env } })
  console.log(`\n$ ccp ${args.join(' ')}`)
  console.log((r.stdout + r.stderr).trimEnd())
}

console.log('\n########## CLI smoke test ##########')
cli('list')
cli('doctor')
cli('env', P)
cli('env', C)
cli('nonsense-command')

kc.vaultDelete(P)
kc.vaultDelete(C)
kc.deleteSecret('ccp-selftest')
console.log('\ncleaned')
