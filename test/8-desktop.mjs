// Claude Desktop keeps its own login (config.json + cookie store), so a
// switch has to move that too. Runs entirely in a fake HOME with a stand-in
// app directory — the real app data is never touched.
import fs from 'node:fs'
import path from 'node:path'

const SRC = new URL('../src', import.meta.url).pathname
const FAKE = process.env.FAKE_HOME
process.env.HOME = FAKE
process.env.CCP_CLAUDE_SERVICE = 'ccp-faketest-credentials'

const APP = path.join(FAKE, 'Library/Application Support/Claude')
fs.rmSync(path.join(FAKE, '.ccp/desktop'), { recursive: true, force: true })
fs.mkdirSync(APP, { recursive: true })
fs.mkdirSync(path.join(FAKE, '.claude'), { recursive: true })
fs.writeFileSync(path.join(FAKE, '.claude/settings.json'), JSON.stringify({ model: 'opus[1m]' }, null, 2))

const store = await import(`${SRC}/store.mjs`)
const claude = await import(`${SRC}/claude.mjs`)
const desktop = await import(`${SRC}/desktop.mjs`)
const kc = await import(`${SRC}/keychain.mjs`)

const ACC1 = { emailAddress: 'acc1@x.com', accountUuid: 'uuid-1', organizationName: 'Org1' }
const ACC2 = { emailAddress: 'acc2@y.com', accountUuid: 'uuid-2', organizationName: 'Org2' }

/** Stand in for the app being signed in: token cache + cookie store + noise. */
const appSignedInAs = (acc, v) => {
  fs.writeFileSync(
    path.join(APP, 'config.json'),
    JSON.stringify(
      {
        locale: 'en-US',
        'oauth:tokenCache': `enc-v1-${acc.accountUuid}-${v}`,
        'oauth:tokenCacheV2': `enc-v2-${acc.accountUuid}-${v}`,
        lastKnownAccountUuid: acc.accountUuid,
        userThemeMode: 'system',
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(APP, 'Cookies'), `sqlite-ish sessionKey for ${acc.emailAddress} ${v}`)
  fs.writeFileSync(path.join(APP, 'Cookies-journal'), '')
}
const appLogin = () => JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8'))
const appCookies = () => fs.readFileSync(path.join(APP, 'Cookies'), 'utf8')

const handLogin = (acc) => {
  kc.writeSecret(kc.CLAUDE_SERVICE, JSON.stringify({ claudeAiOauth: { accessToken: acc.accountUuid } }))
  fs.writeFileSync(path.join(FAKE, '.claude.json'), JSON.stringify({ oauthAccount: acc }, null, 2))
}

console.log('########## step 1: add acc1 while the app is signed in as acc1 ##########')
appSignedInAs(ACC1, 'v1')
handLogin(ACC1)
let state = store.load()
store.put(state, 'acc1', claude.captureInto(state, 'acc1'))
state.active.claude = 'acc1'
store.save(state)
console.log('  snapshot saved for acc1:', desktop.hasSnapshot('acc1'))

console.log('\n########## step 2: add acc2, but the app is still on acc1 ##########')
handLogin(ACC2)
store.put(state, 'acc2', claude.captureInto(state, 'acc2'))
store.save(state)
console.log('  snapshot saved for acc2 (must be false — wrong account):', desktop.hasSnapshot('acc2'))
const snap1 = JSON.parse(fs.readFileSync(path.join(FAKE, '.ccp/desktop/acc1/login.json'), 'utf8'))
console.log('  acc1 snapshot still belongs to acc1:', snap1.lastKnownAccountUuid)

console.log('\n########## step 3: sign the app in as acc2, capture it ##########')
appSignedInAs(ACC2, 'v1')
console.log('  owner of the live app login:', desktop.ownerOf(state))
console.log('  captured:', desktop.capture('acc2', state.profiles.acc2))
store.save(state)

console.log('\n########## step 4: restore acc1 into the app ##########')
desktop.restore('acc1', 'ts-a')
const back = appLogin()
console.log('  lastKnownAccountUuid:', back.lastKnownAccountUuid)
console.log('  tokenCacheV2:', back['oauth:tokenCacheV2'])
console.log('  cookies:', appCookies())
console.log('  unrelated keys kept:', back.locale, back.userThemeMode)

console.log('\n########## step 5: restore acc2 again (round trip) ##########')
desktop.restore('acc2', 'ts-b')
console.log('  lastKnownAccountUuid:', appLogin().lastKnownAccountUuid)
console.log('  cookies:', appCookies())

console.log('\n########## step 6: a refresh on the live account IS re-captured ##########')
appSignedInAs(ACC2, 'v2')
console.log('  capture returns changed:', desktop.capture('acc2', state.profiles.acc2, { quiet: true }))
console.log('  capture again returns unchanged:', desktop.capture('acc2', state.profiles.acc2, { quiet: true }))
desktop.restore('acc2', 'ts-c')
console.log('  restored token is the refreshed one:', appLogin()['oauth:tokenCacheV2'])

console.log('\n########## step 7: captureLiveOwner protects the app login on a switch ##########')
appSignedInAs(ACC1, 'v9') // app back on acc1, with a newer token than the snapshot
console.log('  owner found:', desktop.ownerOf(state), '| captured:', desktop.captureLiveOwner(state))
desktop.restore('acc2', 'ts-d')
desktop.restore('acc1', 'ts-e')
console.log('  acc1 login survived the round trip:', appLogin()['oauth:tokenCacheV2'])

console.log('\n########## step 8: forget drops the snapshot ##########')
desktop.forget('acc2')
console.log('  acc2 snapshot gone:', !desktop.hasSnapshot('acc2'), '| acc1 still there:', desktop.hasSnapshot('acc1'))

console.log('\n########## cleanup ##########')
kc.vaultDelete('acc1')
kc.vaultDelete('acc2')
kc.deleteSecret(kc.CLAUDE_SERVICE)
console.log('  done')
