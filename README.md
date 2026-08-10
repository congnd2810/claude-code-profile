# ccp — profile switcher for Claude Code and Codex

`ccp` = **C**laude/**C**odex **P**rofiles.

Switch between native Claude subscription accounts, Anthropic API keys, and third-party providers — for both Claude Code and Codex. Plain Node, zero dependencies, needs Node 18+ and macOS.

---

## Install

```bash
cd /path/to/ccp
npm link                                      # or: ln -s "$PWD/src/ccp.mjs" /usr/local/bin/ccp
ccp doctor                                    # verify the keychain is readable/writable
```

## Quickstart

Run these in order. **Step 1 matters most** — once it exists, every later experiment is reversible.

```bash
# 1. Save the native Claude login you are using right now
ccp add          # claude → oauth → name: work-max

# 2. Add a third-party provider
ccp add          # claude → proxy → https://api.tuongtacfree.vn → paste key → pick model

# 3. Verify the provider actually works BEFORE trusting it
ccp check tuongtacfree

# 4. Switch to it
ccp use tuongtacfree
# → restart Claude Code

# 5. Switch back
ccp use work-max
```

## Commands

| Command | What it does |
|---|---|
| `ccp` | open the arrow-key menu |
| `ccp list` | list profiles; `●` marks the active one |
| `ccp use <name>` | activate (captures the old token first) |
| `ccp add` | add a profile, step by step |
| `ccp rm <name>` | delete a profile and its vault entry |
| `ccp capture [name]` | save the token in use back into the vault |
| `ccp check <name>` | probe the endpoint to see if it is alive |
| `ccp usage [name]` | quota left on a first-party login |
| `ccp env <name>` | print exports for `eval` in a single shell |
| `ccp doctor` | check the setup |

### Menu keys

| Key | Action |
|---|---|
| `↑` `↓` or `k` `j` | move |
| `enter` | activate the highlighted profile |
| `c` | capture the token in use into that profile |
| `a` | add a profile |
| `d` | delete a profile |
| `t` | probe the endpoint |
| `u` | show quota |
| `q` or `esc` | quit |

### Output symbols

| | Meaning |
|---|---|
| `✓` | check passed |
| `·` | information, not pass/fail |
| `⚠` | warning — works, but there is something to know |
| `✗` | error |

## Profile kinds

**Claude Code**

| kind | What it is | What `ccp add` asks |
|---|---|---|
| `oauth` | Native Claude account (Pro/Max/Team) | just a name — it reads the current login |
| `proxy` | Third-party provider | base URL (no `/v1`), API key, then **pick** a model |
| `apikey` | Key from console.anthropic.com | API key |

**Codex**

| kind | What it is | What `ccp add` asks |
|---|---|---|
| `chatgpt` | Native ChatGPT login | just a name — it reads the current `auth.json` |
| `provider` | Third-party provider | provider id, base URL (**with** `/v1`), `wire_api`, key, then **pick** a model |

Anything with a finite set of answers is chosen with `↑↓` + `enter`, not typed. Only the profile name, base URL and key have to be entered.

The model is picked too: once the base URL and key are known, `ccp` queries the provider's `/v1/models` and lists what it reports. A **type it myself** entry is always available, because that list is not always complete — a provider can serve models it does not advertise.

Two easy mistakes:

- Claude Code wants the base URL **without** `/v1` (the SDK appends `/v1/messages`)
- Codex wants it **with** `/v1` (it calls `{base}/responses`)

### Adding a second Claude account

`ccp add` can drive the login for you — pick **no, sign in now** and it runs `claude auth login` (optionally prefilling an email), waits for you to finish in the browser, then captures the result:

```bash
ccp use work-max      # make sure the current account is safely captured
ccp add               # claude → oauth → "sign in now" → name: personal-max
```

The browser step itself cannot be skipped: signing in is an OAuth flow that has to happen there. If you would rather do it yourself, log in first and pick **capture the current login** instead:

```bash
claude auth login --email you@example.com
ccp add               # claude → oauth → "capture the current login"
```

From then on `ccp use work-max` / `ccp use personal-max` is all it takes. There is no limit on how many accounts you add.

Multiple ChatGPT accounts for Codex work identically — `ccp add` → `codex` → `chatgpt` offers the same choice and shells out to `codex login`.

Logging in by hand means the stored credential no longer belongs to whatever profile `ccp` thinks is active. `ccp` detects that — `oauthAccount.accountUuid` for Claude, `tokens.account_id` for Codex — and skips the capture rather than overwriting the other account's vault, so a hand login can never cost you a stored login. A genuine token refresh on the *same* account is still captured normally.

## What it touches

| File | What changes |
|---|---|
| `~/.claude/settings.json` | `env` (only the `ANTHROPIC_*` vars it owns) and `model` |
| `~/.claude.json` | `oauthAccount`, `userID` — so Claude Code shows the right account |
| Keychain `Claude Code-credentials` | the OAuth blob |
| `~/.codex/config.toml` | two marker-delimited blocks, `# >>> ccp:keys` and `# >>> ccp:provider` |
| `~/.codex/auth.json` | `auth_mode` + `OPENAI_API_KEY`, keeping the existing `tokens` |

Nothing outside those regions is touched — your `permissions`, `mcp_servers`, `plugins`, `projects` and `shell_environment_policy` survive intact. Before every `use`, the original files are copied into `~/.ccp/backups/<timestamp>/`.

The TOML blocks are written so top-level keys always precede the first table and the provider table lands at the end of the file, which keeps it valid and makes repeated applies produce identical output.

### Where data lives

| Location | Contents |
|---|---|
| macOS Keychain, service `ccp-vault` | keys and tokens — **no plaintext file anywhere** |
| `~/.ccp/profiles.json` | metadata (name, base URL, model, email, org). No secrets |
| `~/.ccp/backups/<timestamp>/` | copies of the host configs from each switch |

## Three things to know

**1. OAuth tokens refresh themselves.** Claude Code rotates the keychain token while you work. `ccp use` captures the active profile before switching away, so the vault always holds the newest token. If you edit the keychain by hand or work across machines, run `ccp capture` — `ccp doctor` warns when the vault has gone stale.

**2. The first login for each account is manual.**

**3. Switching does not affect a running session.** Restart Claude Code / Codex.

## Quota

```
$ ccp usage

  work-max (claude/oauth) ● active
     5 hours   ██░░░░░░░░  16% · resets in 2h 20m
     7 days    █░░░░░░░░░   9% · resets in 4d 5h

  gpt1 (codex/chatgpt) ● active
  · you@example.com · plus
     7d        ░░░░░░░░░░   0% · resets in 7d
```

With no argument it reports the two logins currently active; pass a name for one profile.

First-party logins only. Claude comes from `api.anthropic.com/api/oauth/usage`, Codex from `chatgpt.com/backend-api/codex/usage` — the same endpoints the official CLIs call, with the same headers they identify themselves with. Third-party providers report `not available`, because none of them expose quota.

One caveat: it needs a working access token, and those are short-lived. For a profile that is not active the stored token has usually expired, so you get `token rejected (http 401)` — activate it, open the app once, `ccp capture`, then ask again.

## Running two profiles at once

`ccp use` is global (it writes `settings.json`), which also covers Claude Code launched from VSCode or the desktop app. To give one terminal a different profile without changing the global one:

```bash
eval $(ccp env tuongtacfree)
claude
```

Works for `proxy` and `apikey` only — `oauth` lives in the keychain, so there is no env to export.

## Troubleshooting

**`No available accounts`**

The third-party provider has no backend account free for that model. Not a configuration problem on your side and nothing local will fix it — contact whoever sold the key. Use `ccp check` to confirm before spending time debugging.

**`wire_api = "chat" is no longer supported`**

Recent Codex builds only accept `responses`. If your provider only serves `/v1/chat/completions`, Codex cannot use it at all, even with a perfectly good key. Pick another provider, or use that key with Claude Code instead.

**A "keychain cannot be found" dialog**

Click **Cancel**, never "Reset To Defaults". It means `security` could not locate the login keychain, usually because `HOME` points somewhere unusual. `ccp` always passes the real home directory to `security`, so run `ccp doctor` if it still happens.

**Claude Code shows the wrong account after switching**

That profile has no stored identity. Open Claude Code on the correct account, then `ccp capture <name>`.

**Switched profile but nothing changed**

You did not restart. Or the current shell still holds `ANTHROPIC_*` from an earlier `eval $(ccp env ...)` — shell env beats `settings.json`. Open a new terminal.

**`ccp check` says the token expired**

`claude` → `/login` with that account → `ccp capture <name>`.

## Reverting

```bash
ccp use <native-profile>
```

Or restore by hand from a backup:

```bash
ls ~/.ccp/backups/                      # pick a timestamp
cp ~/.ccp/backups/<stamp>/settings.json ~/.claude/settings.json
cp ~/.ccp/backups/<stamp>/config.toml   ~/.codex/config.toml
cp ~/.ccp/backups/<stamp>/auth.json     ~/.codex/auth.json
```

Removing every trace of `ccp`:

```bash
rm -rf ~/.ccp
security delete-generic-password -s ccp-vault -a "$USER:<profile-name>"    # per profile
npm unlink -g ccp
```

## Tests

These run against a fake `HOME` (real configs are copied in as fixtures, never modified). Test 2 uses a fake keychain service, so it cannot disturb the real login:

```bash
FAKE_HOME=/tmp/ccp-test node test/1-apply.mjs         # patches config.toml + settings.json, idempotency
FAKE_HOME=/tmp/ccp-test node test/2-oauth-switch.mjs  # TOML validity, account switch, token refresh
FAKE_HOME=/tmp/ccp-test TTF_KEY=sk-... node test/3-check-cli.mjs
FAKE_HOME=/tmp/ccp-test node test/4-two-accounts.mjs  # two Claude accounts incl. hand login
FAKE_HOME=/tmp/ccp-test node test/5-two-chatgpt.mjs   # two ChatGPT accounts for Codex
```

## A note on third-party providers

Every prompt and every line of code sent through a third-party provider passes through their servers, where they can read it. Do not use one for sensitive code or data.

`ccp check` probes the exact endpoint the tool will really use — `/v1/messages` for Claude Code, streaming `/v1/responses` for Codex — so it catches providers that advertise an impressive model list behind a dead endpoint. A provider's `/v1/models` is **not** trustworthy: it can omit models they do serve, and list models they cannot.
