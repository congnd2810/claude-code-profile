// Real usage call for both first-party logins + a third-party profile,
// in a fake HOME so nothing real is modified.
const SRC = new URL('../src', import.meta.url).pathname
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const FAKE = process.env.FAKE_HOME
const REAL = os.homedir()
fs.mkdirSync(path.join(FAKE, '.claude'), { recursive: true })
process.env.HOME = FAKE

const store = await import(`${SRC}/store.mjs`)
const kc = await import(`${SRC}/keychain.mjs`)
const { usage } = await import(`${SRC}/usage.mjs`)

// Seed the vault from the live credentials, read straight from the real machine.
const claudeBlob = kc.readSecret('Claude Code-credentials')
const codexBlob = fs.readFileSync(path.join(REAL, '.codex/auth.json'), 'utf8')

const state = store.load()
store.put(state, 'live-claude', { target: 'claude', kind: 'oauth', identity: { emailAddress: 'x' } })
store.put(state, 'live-codex', { target: 'codex', kind: 'chatgpt', identity: {} })
store.put(state, 'ttf', { target: 'claude', kind: 'proxy', baseUrl: 'https://api.tuongtacfree.vn', model: 'claude-opus-5' })
state.active.claude = 'live-claude'
state.active.codex = 'live-codex'
store.save(state)
kc.vaultWrite('live-claude', claudeBlob)
kc.vaultWrite('live-codex', codexBlob)

await usage(state, 'live-claude')
await usage(state, 'live-codex')
await usage(state, 'ttf')

kc.vaultDelete('live-claude'); kc.vaultDelete('live-codex')
console.log('\n(vault test entries cleaned)')
