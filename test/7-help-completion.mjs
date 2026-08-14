import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const CLI = path.join(ROOT, 'src/ccp.mjs')
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-completion-'))
const ccpDir = path.join(fakeHome, '.ccp')

fs.mkdirSync(ccpDir, { recursive: true })
fs.writeFileSync(
  path.join(ccpDir, 'profiles.json'),
  JSON.stringify({
    version: 1,
    active: { claude: null, codex: null },
    managed: {},
    profiles: {
      'claude-login': { target: 'claude', kind: 'oauth' },
      'claude-proxy': { target: 'claude', kind: 'proxy' },
      'codex-login': { target: 'codex', kind: 'chatgpt' },
      'codex-provider': { target: 'codex', kind: 'provider' },
    },
  }),
)

function cli(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome, NO_COLOR: '1' },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

const commands = cli('commands')
assert.match(commands, /ccp commands\s+list commands/)
assert.match(commands, /ccp completion zsh\s+print zsh tab-completion setup/)
assert.equal(cli('help'), commands)

const completion = cli('completion', 'zsh')
assert.match(completion, /^#compdef ccp/m)
assert.match(completion, /eval "\$\(ccp completion zsh\)"/)
assert.match(completion, /command ccp __complete profiles/)
assert.equal((completion.match(/'usage:/g) ?? []).length, 1)

assert.deepEqual(cli('__complete', 'profiles', 'use').trim().split('\n'), [
  'claude-login',
  'claude-proxy',
  'codex-login',
  'codex-provider',
])
assert.deepEqual(cli('__complete', 'profiles', 'capture').trim().split('\n'), ['claude-login', 'codex-login'])
assert.deepEqual(cli('__complete', 'profiles', 'usage').trim().split('\n'), ['claude-login', 'codex-login'])
assert.deepEqual(cli('__complete', 'profiles', 'env').trim().split('\n'), ['claude-proxy'])

const zshCheck = spawnSync('zsh', ['-fc', `autoload -Uz compinit; compinit -d ${path.join(fakeHome, 'zcompdump')}; eval "$(${process.execPath} ${CLI} completion zsh)"; whence -w _ccp`], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, HOME: fakeHome, NO_COLOR: '1' },
})
assert.equal(zshCheck.status, 0, zshCheck.stderr)
assert.match(zshCheck.stdout, /_ccp: function/)

fs.rmSync(fakeHome, { recursive: true })
console.log('help and zsh completion: OK')
