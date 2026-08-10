// Two ChatGPT accounts for Codex, including the hand-login step.
// Entirely synthetic auth.json files — the real ~/.codex is never read.
import fs from 'node:fs'
import path from 'node:path'

const SRC = new URL('../src', import.meta.url).pathname
const FAKE = process.env.FAKE_HOME
process.env.HOME = FAKE

fs.mkdirSync(path.join(FAKE, '.codex'), { recursive: true })
fs.writeFileSync(path.join(FAKE, '.codex/config.toml'), 'model = "gpt-5.6-sol"\n')

const store = await import(`${SRC}/store.mjs`)
const codex = await import(`${SRC}/codex.mjs`)
const kc = await import(`${SRC}/keychain.mjs`)

const AUTH = path.join(FAKE, '.codex/auth.json')
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
/** Shape a real auth.json: id_token is a JWT whose payload carries the email. */
const authFor = (email, accountId, v) =>
  JSON.stringify(
    {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: `access-${v}`,
        account_id: accountId,
        id_token: `${b64({ alg: 'RS256' })}.${b64({ email, sub: accountId })}.sig`,
        refresh_token: `refresh-${v}`,
      },
    },
    null,
    2,
  )

const A = authFor('acc1@gmail.com', '11111111-1111-1111-1111-111111111111', 'v1')
const B = authFor('acc2@gmail.com', '22222222-2222-2222-2222-222222222222', 'v1')
const A2 = authFor('acc1@gmail.com', '11111111-1111-1111-1111-111111111111', 'v2') // same acc, refreshed

const handLogin = (blob) => fs.writeFileSync(AUTH, blob)

let state = store.load()

console.log('########## step 1: capture the ChatGPT account logged in now ##########')
handLogin(A)
store.put(state, 'gpt1', codex.captureInto(state, 'gpt1'))
state.active.codex = 'gpt1'
store.save(state)
console.log('  gpt1 identity:', state.profiles.gpt1.identity.email)
console.log('  list shows:', codex.describe(state, 'gpt1'))

console.log('\n########## step 2: hand login to the second account, then add it ##########')
handLogin(B)
store.put(state, 'gpt2', codex.captureInto(state, 'gpt2'))
store.save(state)
console.log('  gpt2 identity:', state.profiles.gpt2.identity.email)
console.log('  gpt1 vault still holds account 1:', kc.vaultRead('gpt1') === A)

console.log('\n########## step 3: `ccp use gpt2` while ccp still thinks gpt1 is active ##########')
codex.apply(state, 'gpt2', 'ts-a')
store.save(state)
console.log('  gpt1 vault intact:', kc.vaultRead('gpt1') === A)
console.log('  auth.json now account 2:', fs.readFileSync(AUTH, 'utf8').trim() === B.trim())

console.log('\n########## step 4: switch back to gpt1 ##########')
codex.apply(state, 'gpt1', 'ts-b')
store.save(state)
console.log('  auth.json now account 1:', fs.readFileSync(AUTH, 'utf8').trim() === A.trim())

console.log('\n########## step 5: a real refresh on gpt1 IS still captured ##########')
handLogin(A2) // same account, new tokens
codex.apply(state, 'gpt2', 'ts-c')
store.save(state)
console.log('  gpt1 vault updated to refreshed tokens:', kc.vaultRead('gpt1').trim() === A2.trim())
console.log('  gpt2 vault untouched:', kc.vaultRead('gpt2') === B)

console.log('\n########## step 6: api-key mode must never be captured as a login ##########')
fs.writeFileSync(AUTH, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x', tokens: { account_id: 'x' } }, null, 2))
state.active.codex = 'gpt1'
codex.captureActive(state)
console.log('  gpt1 vault still the real login:', kc.vaultRead('gpt1').trim() === A2.trim())

console.log('\n########## cleanup ##########')
kc.vaultDelete('gpt1')
kc.vaultDelete('gpt2')
console.log('  done')
