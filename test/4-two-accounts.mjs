// The real two-account flow, including the hand-login step that used to
// corrupt a vault. Uses a fake keychain service, never the real login.
import fs from 'node:fs'
import path from 'node:path'

const SRC = new URL('../src', import.meta.url).pathname
const FAKE = process.env.FAKE_HOME
process.env.HOME = FAKE
process.env.CCP_CLAUDE_SERVICE = 'ccp-faketest-credentials'

fs.mkdirSync(path.join(FAKE, '.claude'), { recursive: true })
fs.writeFileSync(path.join(FAKE, '.claude/settings.json'), JSON.stringify({ model: 'opus[1m]' }, null, 2))

const store = await import(`${SRC}/store.mjs`)
const claude = await import(`${SRC}/claude.mjs`)
const kc = await import(`${SRC}/keychain.mjs`)

const ACC1 = { emailAddress: 'acc1@x.com', accountUuid: 'uuid-1', organizationName: 'Org1' }
const ACC2 = { emailAddress: 'acc2@y.com', accountUuid: 'uuid-2', organizationName: 'Org2' }
const tok = (who, v) => JSON.stringify({ claudeAiOauth: { accessToken: `${who}-${v}` } })

/** Stand in for `claude` + /login: swaps both the keychain blob and identity. */
const handLogin = (acc, blob) => {
  kc.writeSecret(kc.CLAUDE_SERVICE, blob)
  const j = JSON.parse(fs.readFileSync(path.join(FAKE, '.claude.json'), 'utf8'))
  j.oauthAccount = acc
  fs.writeFileSync(path.join(FAKE, '.claude.json'), JSON.stringify(j, null, 2))
}

fs.writeFileSync(path.join(FAKE, '.claude.json'), JSON.stringify({ oauthAccount: ACC1 }, null, 2))
kc.writeSecret(kc.CLAUDE_SERVICE, tok('acc1', 'v1'))

let state = store.load()

console.log('########## step 1: capture the account currently logged in ##########')
store.put(state, 'acc1', claude.captureInto(state, 'acc1'))
state.active.claude = 'acc1'
store.save(state)
console.log('  acc1 identity:', state.profiles.acc1.identity.emailAddress)

console.log('\n########## step 2: hand /login to the second account, then add it ##########')
handLogin(ACC2, tok('acc2', 'v1'))
store.put(state, 'acc2', claude.captureInto(state, 'acc2'))
store.save(state)
console.log('  acc2 identity:', state.profiles.acc2.identity.emailAddress)
console.log('  acc1 vault still holds acc1 token:', kc.vaultRead('acc1') === tok('acc1', 'v1'))

console.log('\n########## step 3: `ccp use acc2` while ccp still thinks acc1 is active ##########')
console.log('  (the old bug: this captured acc2 token into acc1 vault)')
claude.apply(state, 'acc2', 'ts-a')
store.save(state)
console.log('  acc1 vault intact:', kc.vaultRead('acc1') === tok('acc1', 'v1'))
console.log('  keychain now acc2:', kc.readSecret(kc.CLAUDE_SERVICE) === tok('acc2', 'v1'))

console.log('\n########## step 4: switch back to acc1 ##########')
claude.apply(state, 'acc1', 'ts-b')
store.save(state)
console.log('  keychain now acc1:', kc.readSecret(kc.CLAUDE_SERVICE) === tok('acc1', 'v1'))
console.log('  identity:', JSON.parse(fs.readFileSync(path.join(FAKE, '.claude.json'), 'utf8')).oauthAccount.emailAddress)

console.log('\n########## step 5: normal refresh on acc1 IS still captured ##########')
kc.writeSecret(kc.CLAUDE_SERVICE, tok('acc1', 'v2')) // same account, new token
claude.apply(state, 'acc2', 'ts-c')
store.save(state)
console.log('  acc1 vault updated to the refreshed token:', kc.vaultRead('acc1') === tok('acc1', 'v2'))
console.log('  acc2 vault untouched:', kc.vaultRead('acc2') === tok('acc2', 'v1'))

console.log('\n########## cleanup ##########')
kc.vaultDelete('acc1')
kc.vaultDelete('acc2')
kc.deleteSecret(kc.CLAUDE_SERVICE)
console.log('  done')
