import { c, fmtAge } from './util.mjs'
import * as store from './store.mjs'
import * as claude from './claude.mjs'
import * as codex from './codex.mjs'

const ESC = String.fromCharCode(27)
const CTRL_C = String.fromCharCode(3)
const HINT = c.dim('↑↓ chon · enter activate · [c]apture · [a]dd · [d]elete · [t]est · [q]uit')

/**
 * Inline arrow-key picker. Draws in place (no screen clear) so the answers
 * already given stay visible above it. Resolves to the chosen value, or null
 * if the user escapes out.
 */
export function select(title, items) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    if (!stdin.isTTY) return resolve((items.find((it) => it.default) ?? items[0])?.value ?? null)

    let cur = Math.max(0, items.findIndex((it) => it.default))
    process.stdout.write(`  ${title}\n`)

    const draw = (first) => {
      if (!first) process.stdout.write(`${ESC}[${items.length}A`)
      for (const [i, it] of items.entries()) {
        const mark = i === cur ? c.cyan('❯') : ' '
        const label = i === cur ? c.bold(it.label) : it.label
        const hint = it.hint ? c.dim(`  ${it.hint}`) : ''
        process.stdout.write(`${ESC}[2K   ${mark} ${label}${hint}\n`)
      }
    }

    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    const done = (value, label) => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(wasRaw ?? false)
      stdin.pause()
      // Collapse the list into a single answered line.
      process.stdout.write(`${ESC}[${items.length + 1}A${ESC}[0J`)
      process.stdout.write(`  ${title} ${label ? c.green(label) : c.dim('(bo qua)')}\n`)
      resolve(value)
    }

    const onData = (key) => {
      if (key === CTRL_C || key === ESC || key === 'q') return done(null, null)
      if (key === `${ESC}[A` || key === 'k') cur = (cur - 1 + items.length) % items.length
      else if (key === `${ESC}[B` || key === 'j') cur = (cur + 1) % items.length
      else if (key === '\r' || key === '\n') return done(items[cur].value, items[cur].label)
      else return
      draw(false)
    }

    draw(true)
    stdin.on('data', onData)
  })
}

function rows(state) {
  const out = []
  for (const target of ['claude', 'codex']) {
    const names = store.names(state, target)
    out.push({ header: target === 'claude' ? 'Claude Code' : 'Codex' })
    if (!names.length) out.push({ empty: true, target })
    for (const name of names) out.push({ name, target })
  }
  return out
}

function render(state, list, cursor) {
  const width = Math.max(12, ...Object.keys(state.profiles).map((n) => n.length))
  const lines = ['', `  ${c.bold('ccp')} ${c.dim('— profile switcher')}`, '']
  list.forEach((row, i) => {
    if (row.header) {
      lines.push(`  ${c.dim(`── ${row.header} ${'─'.repeat(Math.max(0, 46 - row.header.length))}`)}`)
      return
    }
    if (row.empty) {
      lines.push(`     ${c.dim('(chua co profile — bam [a] de them)')}`)
      return
    }
    const p = state.profiles[row.name]
    const active = state.active[row.target] === row.name
    const desc = row.target === 'claude' ? claude.describe(state, row.name) : codex.describe(state, row.name)
    const age = p.capturedAt ? c.dim(` · ${fmtAge(p.capturedAt)}`) : ''
    const mark = active ? c.green('●') : ' '
    const label = `${mark} ${row.name.padEnd(width)} ${c.dim(p.kind.padEnd(8))} ${desc}${age}`
    lines.push(i === cursor ? `  ${c.inverse(` ${label} `)}` : `   ${label}`)
  })
  lines.push('', `  ${HINT}`, '')
  process.stdout.write(`${ESC}[2J${ESC}[H${lines.join('\n')}`)
}

/**
 * Arrow-key menu. Resolves to {action, name} and hands control back so the
 * caller can run prompts outside raw mode, then re-enter.
 */
export function menu(state) {
  const list = rows(state)
  const selectable = list.map((r, i) => (r.name ? i : -1)).filter((i) => i >= 0)
  if (!selectable.length) return Promise.resolve({ action: 'add' })

  let cursor = selectable[0]
  const activeIdx = selectable.find((i) => state.active[list[i].target] === list[i].name)
  if (activeIdx !== undefined) cursor = activeIdx

  return new Promise((resolve) => {
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    const done = (result) => {
      stdin.removeListener('data', onData)
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false)
      stdin.pause()
      process.stdout.write('\n')
      resolve(result)
    }

    const move = (dir) => {
      const pos = selectable.indexOf(cursor)
      cursor = selectable[(pos + dir + selectable.length) % selectable.length]
      render(state, list, cursor)
    }

    const onData = (key) => {
      const name = list[cursor]?.name
      if (key === CTRL_C || key === 'q' || key === ESC) return done({ action: 'quit' })
      if (key === `${ESC}[A` || key === 'k') return move(-1)
      if (key === `${ESC}[B` || key === 'j') return move(1)
      if (key === '\r' || key === '\n') return done({ action: 'use', name })
      if (key === 'c') return done({ action: 'capture', name })
      if (key === 'a') return done({ action: 'add' })
      if (key === 'd') return done({ action: 'delete', name })
      if (key === 't') return done({ action: 'check', name })
    }

    render(state, list, cursor)
    stdin.on('data', onData)
  })
}
