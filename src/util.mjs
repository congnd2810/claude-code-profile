import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOME = os.homedir()
export const CCP_DIR = path.join(HOME, '.ccp')
export const BACKUP_DIR = path.join(CCP_DIR, 'backups')

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s))

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
  inverse: wrap('7'),
}

export const ok = (s) => console.log(`  ${c.green('✓')} ${s}`)
export const warn = (s) => console.log(`  ${c.yellow('⚠')} ${s}`)
export const fail = (s) => console.log(`  ${c.red('✗')} ${s}`)
export const info = (s) => console.log(`  ${c.dim('·')} ${c.dim(s)}`)

export class CcpError extends Error {}

/** Run a command without a shell. Returns {code, out, err}. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.error) throw new CcpError(`${cmd}: ${r.error.message}`)
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

/** Hand the terminal to another program (a login flow) and wait for it. */
export function runInteractive(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.error?.code === 'ENOENT') throw new CcpError(`\`${cmd}\` is not in PATH`)
  if (r.error) throw new CcpError(`${cmd}: ${r.error.message}`)
  return r.status ?? 1
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

export function readJson(file, fallback = null) {
  const raw = readText(file)
  if (raw === null) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    throw new CcpError(`${file} is not valid JSON — fix or delete it, then try again`)
  }
}

/**
 * Write atomically (tmp + rename) so a crash never leaves a half-written
 * config behind. Keeps the existing file mode, defaults to 0600.
 */
export function writeFileAtomic(file, content) {
  let mode = 0o600
  try {
    mode = fs.statSync(file).mode & 0o777
  } catch {
    /* new file — keep 0600 */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.ccp-tmp-${process.pid}`
  fs.writeFileSync(tmp, content, { mode })
  fs.renameSync(tmp, file)
}

export function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`)
}

/** Copy a file into ~/.ccp/backups/<stamp>/ before we touch it. */
export function backup(file, stamp) {
  if (!fs.existsSync(file)) return null
  const dir = path.join(BACKUP_DIR, stamp)
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, path.basename(file).replace(/^\./, 'dot-'))
  fs.copyFileSync(file, dest)
  return dest
}

export function stampNow() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function fmtAge(ms) {
  if (!ms) return 'unknown'
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 90) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 90) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Simple line prompt on stdin. Returns '' when the user just hits enter. */
export async function ask(question, { silent = false } = {}) {
  process.stdout.write(question)
  const fd = process.stdin.fd
  if (silent && process.stdin.isTTY) run('stty', ['-echo'], { stdio: ['inherit', 'inherit', 'inherit'] })
  const chunks = []
  const buf = Buffer.alloc(1)
  const fsMod = await import('node:fs')
  for (;;) {
    let n = 0
    try {
      n = fsMod.readSync(fd, buf, 0, 1, null)
    } catch (e) {
      if (e.code === 'EAGAIN') continue
      throw e
    }
    if (n === 0) break
    const ch = buf.toString('utf8')
    if (ch === '\n' || ch === '\r') break
    chunks.push(ch)
  }
  if (silent && process.stdin.isTTY) {
    run('stty', ['echo'], { stdio: ['inherit', 'inherit', 'inherit'] })
    process.stdout.write('\n')
  }
  return chunks.join('').trim()
}

export async function confirm(question) {
  const a = (await ask(`${question} [y/N] `)).toLowerCase()
  return a === 'y' || a === 'yes'
}
