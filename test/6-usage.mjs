// Live for the active login, cached for the others.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const SRC = new URL('../src', import.meta.url).pathname
const FAKE = process.env.FAKE_HOME
const REAL = os.homedir()
fs.mkdirSync(path.join(FAKE, '.claude'), { recursive: true })
process.env.HOME = FAKE

const store = await import(`${SRC}/store.mjs`)
const kc = await import(`${SRC}/keychain.mjs`)
const { usage, usageAll } = await import(`${SRC}/usage.mjs`)

const claudeBlob = kc.readSecret('Claude Code-credentials')
const codexBlob = fs.readFileSync(path.join(REAL, '.codex/auth.json'), 'utf8')

const state = store.load()
store.put(state, 'work-max', { target: 'claude', kind: 'oauth', identity: { emailAddress: 'a' } })
store.put(state, 'personal-max', { target: 'claude', kind: 'oauth', identity: { emailAddress: 'b' } })
store.put(state, 'gpt1', { target: 'codex', kind: 'chatgpt', identity: {} })
store.put(state, 'ttf', { target: 'claude', kind: 'proxy', baseUrl: 'https://api.tuongtacfree.vn', model: 'claude-opus-5' })
state.active.claude = 'work-max'
state.active.codex = 'gpt1'
// personal-max: no cache yet, and a deliberately dead token
kc.vaultWrite('work-max', claudeBlob)
kc.vaultWrite('gpt1', codexBlob)
kc.vaultWrite('personal-max', JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-dead-token' } }))
store.save(state)

console.log('########## 1. ccp usage (khong tham so) — chi acc active ##########')
await usageAll(state, { activeOnly: true })

console.log('########## 2. ccp usage --all — lan dau, personal-max chua co so ##########')
await usageAll(state)

console.log('########## 3. gia lap personal-max da tung duoc do (cache 2 ngay truoc) ##########')
const s2 = store.load()
s2.profiles['personal-max'].usage = {
  fetchedAt: Date.now() - 2 * 86400000,
  windows: [
    { label: '5 hours', used: 61, resetsAt: Date.now() - 86400000 },
    { label: '7 days', used: 44, resetsAt: Date.now() + 3 * 86400000 },
  ],
  note: null,
}
store.save(s2)
await usageAll(store.load())

console.log('########## 4. usage cho profile co token chet ##########')
await usage(store.load(), 'personal-max')

console.log('\n########## 5. third-party ##########')
await usage(store.load(), 'ttf')

kc.vaultDelete('work-max'); kc.vaultDelete('gpt1'); kc.vaultDelete('personal-max')
console.log('\n(cleaned)')
