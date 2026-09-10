// Antigravity keeps one Google login in a single keychain item shared by the
// IDE and the `agy` CLI, so switching accounts means moving that item — with
// the same "never overwrite another account's vault" guard as the other two
// targets. Runs against a fake keychain service; the real login is untouched.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert'

const SRC = new URL('../src', import.meta.url).pathname
const FAKE = process.env.FAKE_HOME
process.env.HOME = FAKE
process.env.CCP_GEMINI_SERVICE = 'ccp-faketest-gemini'
process.env.CCP_GEMINI_ACCOUNT = 'antigravity'

fs.mkdirSync(FAKE, { recursive: true })
fs.rmSync(path.join(FAKE, '.ccp/profiles.json'), { force: true })

const store = await import(`${SRC}/store.mjs`)
const antigravity = await import(`${SRC}/antigravity.mjs`)
const kc = await import(`${SRC}/keychain.mjs`)

const ACC1 = { sub: '111', email: 'acc1@gmail.com' }
const ACC2 = { sub: '222', email: 'acc2@gmail.com' }

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

/**
 * A stand-in for what go-keyring stores: base64 of the token bundle. Memoised
 * so the same (account, version) is byte-identical every time it is asked for
 * — the round-trip checks below compare the stored value literally.
 */
const blobs = new Map()
const blobFor = (acc, version, hoursLeft = 1) => {
  const key = `${acc.sub}-${version}`
  if (blobs.has(key)) return blobs.get(key)
  const bundle = {
    token: {
      access_token: `ya29.${acc.sub}-${version}`,
      token_type: 'Bearer',
      refresh_token: `refresh-${acc.sub}`,
      expiry: new Date(Date.now() + hoursLeft * 3600_000).toISOString(),
    },
    auth_method: 'consumer',
    id_token: `${b64url({ alg: 'RS256' })}.${b64url({ sub: acc.sub, email: acc.email })}.sig`,
  }
  const blob = `go-keyring-base64:${Buffer.from(JSON.stringify(bundle)).toString('base64')}`
  blobs.set(key, blob)
  return blob
}

/** Stand in for signing in inside Antigravity IDE. */
const signIn = (acc, version) => kc.writeSecret(antigravity.GEMINI_SERVICE, blobFor(acc, version), antigravity.GEMINI_ACCOUNT)

const liveItem = () => kc.readSecret(antigravity.GEMINI_SERVICE, antigravity.GEMINI_ACCOUNT)

let state = store.load()

console.log('########## step 1: read the login the IDE is signed in with ##########')
signIn(ACC1, 'v1')
const id = antigravity.liveIdentity()
console.log('  live identity:', id.email, '| sub:', id.sub, '| expiry readable:', !!id.expiresAt)
assert.equal(id.email, ACC1.email)
assert.equal(id.sub, ACC1.sub)

store.put(state, 'agy1', antigravity.captureInto(state, 'agy1'))
state.active.antigravity = 'agy1'
store.save(state)
console.log('  captured into agy1:', state.profiles.agy1.identity.email)
assert.equal(kc.vaultRead('agy1'), blobFor(ACC1, 'v1'))

console.log('\n########## step 2: sign in as the second account, add it too ##########')
signIn(ACC2, 'v1')
store.put(state, 'agy2', antigravity.captureInto(state, 'agy2'))
store.save(state)
console.log('  agy2 identity:', state.profiles.agy2.identity.email)
console.log('  agy1 vault still holds acc1:', kc.vaultRead('agy1') === blobFor(ACC1, 'v1'))
assert.equal(kc.vaultRead('agy1'), blobFor(ACC1, 'v1'))

console.log('\n########## step 3: capture must NOT bury acc1 under the live acc2 login ##########')
// ccp still thinks agy1 is active, but the item now holds acc2.
console.log('  captureActive returns:', antigravity.captureActive(state, { quiet: true }))
assert.equal(antigravity.captureActive(state, { quiet: true }), false)
assert.equal(kc.vaultRead('agy1'), blobFor(ACC1, 'v1'))

console.log('\n########## step 4: `ccp use agy1` puts acc1 back ##########')
antigravity.apply(state, 'agy1', 'ts-a')
store.save(state)
console.log('  keychain now acc1:', liveItem() === blobFor(ACC1, 'v1'))
console.log('  active:', state.active.antigravity)
assert.equal(liveItem(), blobFor(ACC1, 'v1'))
assert.equal(state.active.antigravity, 'agy1')

console.log('\n########## step 5: a refresh on the SAME account is captured ##########')
signIn(ACC1, 'v2') // the language server refreshed the access token
antigravity.apply(state, 'agy2', 'ts-b')
store.save(state)
console.log('  agy1 vault updated to the refreshed login:', kc.vaultRead('agy1') === blobFor(ACC1, 'v2'))
console.log('  agy2 vault untouched:', kc.vaultRead('agy2') === blobFor(ACC2, 'v1'))
console.log('  keychain now acc2:', liveItem() === blobFor(ACC2, 'v1'))
assert.equal(kc.vaultRead('agy1'), blobFor(ACC1, 'v2'))
assert.equal(kc.vaultRead('agy2'), blobFor(ACC2, 'v1'))
assert.equal(liveItem(), blobFor(ACC2, 'v1'))

console.log('\n########## step 6: applying twice is a no-op, not a re-capture ##########')
antigravity.apply(state, 'agy2', 'ts-c')
console.log('  vault unchanged:', kc.vaultRead('agy2') === blobFor(ACC2, 'v1'))
assert.equal(kc.vaultRead('agy2'), blobFor(ACC2, 'v1'))

console.log('\n########## step 7: a profile with nothing in the vault refuses to apply ##########')
// The realistic case: a profile added on another machine, or a vault entry
// deleted by hand. It must not leave the keychain half-switched.
store.put(state, 'agy3', { target: 'antigravity', kind: 'google', label: null, identity: { sub: '333', email: 'acc3@gmail.com' }, capturedAt: Date.now() })
let threw = null
try {
  antigravity.apply(state, 'agy3', 'ts-d')
} catch (e) {
  threw = e.message.split('\n')[0]
}
console.log('  refused:', threw)
assert.match(threw ?? '', /no login in the vault/)
console.log('  keychain left alone:', liveItem() === blobFor(ACC2, 'v1'))
assert.equal(liveItem(), blobFor(ACC2, 'v1'))

console.log('\n########## step 8: a garbage value never throws, it just has no identity ##########')
kc.writeSecret(antigravity.GEMINI_SERVICE, 'not-base64-at-all', antigravity.GEMINI_ACCOUNT)
console.log('  identity:', JSON.stringify(antigravity.liveIdentity()))
assert.equal(antigravity.liveIdentity().sub, null)

console.log('\n########## step 9: the live login is recognised as an account already saved ##########')
// The bug this guards: `ccp add` used to capture whatever was signed in, so a
// second profile could silently end up being the same account twice.
signIn(ACC1, 'v2')
console.log('  owner of the live login:', antigravity.ownerOfLive(state))
assert.equal(antigravity.ownerOfLive(state), 'agy1')
signIn(ACC2, 'v1')
console.log('  after switching accounts:', antigravity.ownerOfLive(state))
assert.equal(antigravity.ownerOfLive(state), 'agy2')
kc.writeSecret(antigravity.GEMINI_SERVICE, 'garbage', antigravity.GEMINI_ACCOUNT)
console.log('  with an unreadable item:', antigravity.ownerOfLive(state))
assert.equal(antigravity.ownerOfLive(state), null)

console.log('\n########## step 10: waiting for a sign-in inside the IDE ##########')
signIn(ACC1, 'v1')
// Sign-out empties the item, then the other account appears: only the second
// of those two events is the login we are waiting for.
setTimeout(() => kc.deleteSecret(antigravity.GEMINI_SERVICE, antigravity.GEMINI_ACCOUNT), 120)
setTimeout(() => signIn(ACC2, 'v2'), 360)
const arrived = await antigravity.waitForNewLogin(ACC1.sub, { timeoutMs: 5_000, pollMs: 60 })
console.log('  waited and got:', arrived?.email)
assert.equal(arrived?.sub, ACC2.sub)

const noChange = await antigravity.waitForNewLogin(ACC2.sub, { timeoutMs: 200, pollMs: 60 })
console.log('  same account throughout → gives up:', noChange)
assert.equal(noChange, null)

console.log('\n########## cleanup ##########')
kc.vaultDelete('agy1')
kc.vaultDelete('agy2')
kc.deleteSecret(antigravity.GEMINI_SERVICE, antigravity.GEMINI_ACCOUNT)
console.log('  done')
