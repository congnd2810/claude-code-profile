# ccp — profile switcher cho Claude Code và Codex

Đổi qua lại giữa nhiều account Claude gốc (subscription), API key Anthropic, và provider bên thứ 3 — cho cả Claude Code và Codex. Một binary, zero dependency, chỉ cần Node 18+.

```
$ ccp
```

Mở menu chọn bằng mũi tên. Có tham số thì chạy trực tiếp:

| Lệnh | Việc |
|---|---|
| `ccp` | menu chọn profile |
| `ccp list` | liệt kê profile, dấu `●` là đang active |
| `ccp use <name>` | activate |
| `ccp add` | thêm profile (hỏi từng bước) |
| `ccp rm <name>` | xoá profile + key trong vault |
| `ccp capture [name]` | lưu lại token đang dùng vào vault |
| `ccp check <name>` | gọi thật endpoint xem còn sống không |
| `ccp env <name>` | in `export ...` để `eval` trong một shell riêng |
| `ccp doctor` | kiểm tra thiết lập |

## Cài

```bash
cd /Volumes/congo-ssd/code/congnd/ccp
npm link          # hoặc: ln -s "$PWD/src/ccp.mjs" /usr/local/bin/ccp
```

## Các loại profile

**Claude Code**

| kind | Là gì | Cần gì |
|---|---|---|
| `oauth` | Account Claude gốc (Pro/Max/Team) | login sẵn bằng `/login` rồi `ccp capture` |
| `proxy` | Provider bên thứ 3 | base URL + API key |
| `apikey` | API key từ console.anthropic.com | API key |

**Codex**

| kind | Là gì | Cần gì |
|---|---|---|
| `chatgpt` | Login ChatGPT gốc | login sẵn rồi `ccp capture` |
| `provider` | Provider bên thứ 3 | provider id + base URL + wire_api + model + key |

## Nó sửa đúng những chỗ này

- `~/.claude/settings.json` → `env` (chỉ các biến `ANTHROPIC_*` nó tự quản) và `model`
- `~/.claude.json` → `oauthAccount`, `userID` (để Claude Code hiện đúng account)
- Keychain `Claude Code-credentials` → blob OAuth
- `~/.codex/config.toml` → hai block có marker `# >>> ccp:keys` và `# >>> ccp:provider`
- `~/.codex/auth.json` → `auth_mode` + `OPENAI_API_KEY` (giữ nguyên `tokens` cũ)

Mọi thứ ngoài các vùng đó không bị chạm. Trước mỗi lần `use`, file gốc được copy vào `~/.ccp/backups/<timestamp>/`.

Key và token nằm trong macOS Keychain (service `ccp-vault`), không có file plaintext nào. `~/.ccp/profiles.json` chỉ chứa metadata.

## Ba điều phải biết

**1. Token OAuth tự refresh.** Claude Code chạy một lúc là token trong Keychain đổi. `ccp use` tự `capture` profile đang active trước khi switch, nên vault luôn giữ token mới nhất. Nếu bạn sửa Keychain bằng tay hoặc dùng nhiều máy, chạy `ccp capture` cho chắc. `ccp doctor` sẽ báo nếu vault bị cũ.

**2. Lần đầu mỗi nick phải login tay.** Không tự động hoá được:

```bash
claude          # rồi /login bằng nick đó
ccp add         # chọn claude → oauth → đặt tên
```

**3. Switch không ăn vào phiên đang mở.** Phải restart Claude Code / Codex.

## Chạy nhiều profile song song

`ccp use` là global (ghi `settings.json`), áp dụng cả khi mở Claude Code từ VSCode hay desktop app. Muốn một terminal dùng profile khác mà không đổi global:

```bash
eval $(ccp env tuongtacfree)
claude
```

Chỉ dùng được với profile `proxy` và `apikey` — `oauth` nằm trong Keychain nên không có env để export.

## Gỡ ra

```bash
ccp use <profile-gốc>     # về account gốc
```

Hoặc restore tay từ `~/.ccp/backups/<timestamp>/`.

## Test

Chạy trong `HOME` giả (copy config thật vào làm fixture, không chạm bản gốc). Test 2 dùng service Keychain giả nên không đụng login thật:

```bash
FAKE_HOME=/tmp/ccp-test node test/1-apply.mjs        # patch config.toml + settings.json, idempotency
FAKE_HOME=/tmp/ccp-test node test/2-oauth-switch.mjs  # TOML valid, switch nick, token refresh
FAKE_HOME=/tmp/ccp-test TTF_KEY=sk-... node test/3-check-cli.mjs
```

## Lưu ý về provider bên thứ 3

Mọi prompt và code gửi qua provider bên thứ 3 đều đi qua server của họ. Đừng dùng cho code hoặc dữ liệu nhạy cảm.

`ccp check` là cách nhanh nhất để biết một provider có thật sự chạy được không — nó gọi đúng endpoint mà công cụ sẽ dùng (`/v1/messages` cho Claude Code, `/v1/responses` streaming cho Codex), nên bắt được trường hợp provider list model rất hào nhoáng nhưng endpoint thì chết.
