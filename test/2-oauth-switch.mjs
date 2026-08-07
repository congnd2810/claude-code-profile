// Round 2: TOML validity, the oauth restore path (against a fake keychain
// service, never the real login), and the capture-before-switch behaviour.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SRC = new URL('../src', import.meta.url).pathname
const FAKE = process.env.FAKE_HOME
process.env.HOME = FAKE
process.env.CCP_CLAUDE_SERVICE = 'ccp-faketest-credentials'

const cfg = path.join(FAKE, '.codex/config.toml')

console.log('########## 1. does the TOML parse ##########')
const py = spawnSync('python3', ['-c', `import tomllib,sys;d=tomllib.load(open(sys.argv[1],'rb'));print('parse OK');print('model =',d['model']);print('model_provider =',d['model_provider']);print('providers =',list(d.get('model_providers',{}).keys()));print('mcp_servers =',list(d.get('mcp_servers',{}).keys()));print('plugins =',len(d.get('plugins',{})));print('projects =',len(d.get('projects',{})));print('shell_env keys =',len(d['shell_environment_policy']['set']))`, cfg], { encoding: 'utf8' })
console.log(py.stdout || py.stderr)

const store = await import(`${SRC}/store.mjs`)
const claude = await import(`${SRC}/claude.mjs`)
const kc = await import(`${SRC}/keychain.mjs`)

console.log('########## 2. oauth restore path ##########')
const A = 'ccptest-nickA'
const B = 'ccptest-nickB'
const blobA = JSON.stringify({ claudeAiOauth: { accessToken: 'AAA', expiresAt: Date.now() + 7 * 864e5 } })
const blobB = JSON.stringify({ claudeAiOauth: { accessToken: 'BBB', expiresAt: Date.now() + 3 * 864e5 } })

const state = store.load()
store.put(state, A, { target: 'claude', kind: 'oauth', identity: { emailAddress: 'a@x.com', organizationName: 'OrgA' }, userID: 'uid-a', model: 'opus[1m]' })
store.put(state, B, { target: 'claude', kind: 'oauth', identity: { emailAddress: 'b@y.com', organizationName: 'OrgB' }, userID: 'uid-b', model: 'sonnet' })
store.save(state)
kc.vaultWrite(A, blobA)
kc.vaultWrite(B, blobB)

claude.apply(state, A, 'ts1')
store.save(state)
console.log('  keychain == blobA:', kc.readSecret(kc.CLAUDE_SERVICE) === blobA)
let cj = JSON.parse(fs.readFileSync(path.join(FAKE, '.claude.json'), 'utf8'))
console.log('  identity:', cj.oauthAccount.emailAddress, '| userID:', cj.userID, '| numStartups kept:', cj.numStartups)
let s = JSON.parse(fs.readFileSync(path.join(FAKE, '.claude/settings.json'), 'utf8'))
console.log('  all ANTHROPIC_* env cleared:', !s.env, '| model:', s.model, '| permissions:', s.permissions.allow.length)

console.log('\n  --- simulate a token refresh, then switch to nickB ---')
const refreshed = JSON.stringify({ claudeAiOauth: { accessToken: 'AAA-REFRESHED', expiresAt: Date.now() + 30 * 864e5 } })
kc.writeSecret(kc.CLAUDE_SERVICE, refreshed) // Claude Code would do this in the background
claude.apply(state, B, 'ts2')
store.save(state)
console.log('  keychain == blobB:', kc.readSecret(kc.CLAUDE_SERVICE) === blobB)
console.log('  nickA vault picked up the refreshed token:', kc.vaultRead(A) === refreshed)
cj = JSON.parse(fs.readFileSync(path.join(FAKE, '.claude.json'), 'utf8'))
console.log('  identity switched to:', cj.oauthAccount.emailAddress, '| userID:', cj.userID)

console.log('\n  --- switch back to nickA, must use the refreshed token ---')
claude.apply(state, A, 'ts3')
store.save(state)
console.log('  keychain == refreshed (not the stale blobA):', kc.readSecret(kc.CLAUDE_SERVICE) === refreshed)

console.log('\n########## 3. peekExpiry ##########')
console.log('  nickA validity (days):', Math.round((kc.peekExpiry(kc.vaultRead(A)) - Date.now()) / 864e5))
console.log('  garbage blob -> null:', kc.peekExpiry('not json') === null)

console.log('\n########## cleanup ##########')
kc.vaultDelete(A)
kc.vaultDelete(B)
kc.deleteSecret(kc.CLAUDE_SERVICE)
console.log('  vault + fake credential entry deleted')
console.log('  the real login was never touched (real service: "Claude Code-credentials")')
