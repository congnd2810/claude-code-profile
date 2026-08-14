import { c, fail, fmtAge, info, ok, warn } from './util.mjs'
import { peekExpiry, vaultRead } from './keychain.mjs'
import { get } from './store.mjs'

const TIMEOUT_MS = 45_000

async function post(url, headers, body) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    return { status: res.status, text: await res.text() }
  } catch (e) {
    return { status: 0, text: e.name === 'AbortError' ? 'timeout' : e.message }
  } finally {
    clearTimeout(t)
  }
}

function firstError(text) {
  const m = text.match(/"message"\s*:\s*"([^"]+)"/)
  return m ? m[1] : text.slice(0, 160).replace(/\s+/g, ' ')
}

/**
 * Live probe against the endpoint a profile will actually use — the check that
 * would have caught tuongtacfree's dead /v1/responses in one command.
 */
export async function check(state, name) {
  const p = get(state, name)
  console.log(`\n  ${c.bold(name)} ${c.dim(`(${p.target}/${p.kind})`)}`)

  if (p.kind === 'oauth' || p.kind === 'chatgpt') {
    const blob = vaultRead(name)
    if (!blob) return fail('no token in the vault')
    const exp = peekExpiry(blob)
    if (exp) {
      const left = exp - Date.now()
      if (left <= 0) {
        const app = p.target === 'claude' ? 'Claude Code' : 'Codex'
        warn(`access token expired ${fmtAge(exp)} → run \`ccp use ${name}\`, then restart ${app} to refresh it`)
        info('sign in again only if the automatic refresh fails')
      } else {
        ok(`access token still valid (${Math.round(left / 3600000)}h left)`)
      }
    } else {
      info('login present in the vault (access-token expiry not readable)')
    }
    return info('stored login includes its refresh credential; activate it and open the app to refresh')
  }

  const secret = vaultRead(name)
  if (!secret) return fail('no key in the vault')

  if (p.target === 'claude') {
    const base = (p.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')
    const model = p.model ?? 'claude-opus-5'
    const r = await post(
      `${base}/v1/messages`,
      { 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: 16, messages: [{ role: 'user', content: 'say pong' }] },
    )
    if (r.status === 200 && /"type"\s*:\s*"text"/.test(r.text)) return ok(`${base}/v1/messages · ${model} → replied`)
    return fail(`${base}/v1/messages · ${model} → http=${r.status || 'network error'} · ${firstError(r.text)}`)
  }

  // codex provider — mirror what Codex actually sends (streaming responses API)
  const base = p.baseUrl.replace(/\/+$/, '')
  const r = await post(
    `${base}/responses`,
    { authorization: `Bearer ${secret}` },
    {
      model: p.model,
      instructions: 'You are Codex.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say pong' }] }],
      stream: true,
      store: false,
    },
  )
  if (r.status === 200 && r.text.includes('response.completed')) return ok(`${base}/responses · ${p.model} → OK`)
  if (r.text.includes('response.failed') || r.status !== 200) {
    return fail(`${base}/responses · ${p.model} → ${firstError(r.text)}`)
  }
  return warn(`${base}/responses · ${p.model} → unexpected response: ${r.text.slice(0, 120)}`)
}
