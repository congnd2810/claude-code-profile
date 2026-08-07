# ccp — profile switcher cho Claude Code và Codex

`ccp` = **C**laude/**C**odex **P**rofiles.

Đổi qua lại giữa nhiều account Claude gốc (subscription), API key Anthropic, và provider bên thứ 3 — cho cả Claude Code và Codex. Node thuần, zero dependency, chỉ cần Node 18+ và macOS.

---

## Cài

```bash
cd /Volumes/congo-ssd/code/congnd/ccp
npm link                                      # hoặc: ln -s "$PWD/src/ccp.mjs" /usr/local/bin/ccp
ccp doctor                                    # kiểm tra Keychain đọc/ghi được
```

## Quickstart

Làm đúng thứ tự này. **Bước 1 quan trọng nhất** — có nó rồi thì mọi thử nghiệm sau đều quay về được.

```bash
# 1. Lưu login Claude gốc đang dùng lại trước đã
ccp add          # claude → oauth → tên: work-max

# 2. Thêm provider bên thứ 3
ccp add          # claude → proxy → https://api.tuongtacfree.vn → claude-opus-5 → paste key

# 3. Kiểm tra provider có sống không TRƯỚC khi tin nó
ccp check tuongtacfree

# 4. Đổi qua dùng
ccp use tuongtacfree
# → restart Claude Code

# 5. Đổi về
ccp use work-max
```

## Lệnh

| Lệnh | Việc |
|---|---|
| `ccp` | mở menu chọn bằng mũi tên |
| `ccp list` | liệt kê profile, dấu `●` là đang active |
| `ccp use <name>` | activate (tự capture token cũ trước khi đổi) |
| `ccp add` | thêm profile, hỏi từng bước |
| `ccp rm <name>` | xoá profile + key trong vault |
| `ccp capture [name]` | lưu lại token đang dùng vào vault |
| `ccp check <name>` | gọi thật endpoint xem còn sống không |
| `ccp env <name>` | in `export ...` để `eval` trong một shell riêng |
| `ccp doctor` | kiểm tra thiết lập |

### Phím trong menu

| Phím | Việc |
|---|---|
| `↑` `↓` hoặc `k` `j` | di chuyển |
| `enter` | activate profile đang chọn |
| `c` | capture token đang dùng vào profile đó |
| `a` | thêm profile mới |
| `d` | xoá profile |
| `t` | test endpoint |
| `q` hoặc `esc` | thoát |

## Các loại profile

**Claude Code**

| kind | Là gì | `ccp add` hỏi gì |
|---|---|---|
| `oauth` | Account Claude gốc (Pro/Max/Team) | chỉ tên — nó tự đọc login hiện tại |
| `proxy` | Provider bên thứ 3 | base URL (không có `/v1`), API key, rồi **chọn** model |
| `apikey` | API key từ console.anthropic.com | API key |

**Codex**

| kind | Là gì | `ccp add` hỏi gì |
|---|---|---|
| `chatgpt` | Login ChatGPT gốc | chỉ tên — nó tự đọc `auth.json` hiện tại |
| `provider` | Provider bên thứ 3 | provider id, base URL (**có** `/v1`), `wire_api`, key, rồi **chọn** model |

Câu nào có lựa chọn hữu hạn thì chọn bằng `↑↓` + `enter`, không phải gõ. Chỉ tên profile, base URL và key là phải nhập.

Riêng model: sau khi có base URL và key, `ccp` gọi `/v1/models` của provider rồi cho bạn chọn từ danh sách thật. Luôn có mục **tự gõ** vì danh sách đó không phải lúc nào cũng đầy đủ — provider có thể serve model mà nó không liệt kê.

Hai chỗ dễ nhầm:

- Claude Code: base URL **không** có `/v1` (SDK tự thêm `/v1/messages`)
- Codex: base URL **có** `/v1` (nó gọi `{base}/responses`)

### Thêm nick Claude thứ hai

Bước login không tự động hoá được, và không nên:

```bash
ccp use work-max      # đảm bảo nick cũ đã được capture an toàn
claude                # rồi /login bằng nick thứ hai
ccp add               # claude → oauth → tên: personal-max
```

Từ đó trở đi `ccp use work-max` / `ccp use personal-max` là đủ.

## Nó sửa đúng những chỗ này

| File | Sửa gì |
|---|---|
| `~/.claude/settings.json` | `env` (chỉ các biến `ANTHROPIC_*` nó tự quản) và `model` |
| `~/.claude.json` | `oauthAccount`, `userID` — để Claude Code hiện đúng account |
| Keychain `Claude Code-credentials` | blob OAuth |
| `~/.codex/config.toml` | hai block có marker `# >>> ccp:keys` và `# >>> ccp:provider` |
| `~/.codex/auth.json` | `auth_mode` + `OPENAI_API_KEY`, giữ nguyên `tokens` cũ |

Mọi thứ ngoài các vùng đó không bị chạm — `permissions`, `mcp_servers`, `plugins`, `projects`, `shell_environment_policy` của bạn giữ nguyên. Trước mỗi lần `use`, file gốc được copy vào `~/.ccp/backups/<timestamp>/`.

Block TOML được viết sao cho top-level key luôn nằm trước table đầu tiên và provider table nằm cuối file, nên file vẫn valid và apply nhiều lần cho ra kết quả y hệt.

### Dữ liệu lưu ở đâu

| Chỗ | Chứa gì |
|---|---|
| macOS Keychain, service `ccp-vault` | key và token — **không có file plaintext nào** |
| `~/.ccp/profiles.json` | metadata (tên, base URL, model, email, org). Không có secret |
| `~/.ccp/backups/<timestamp>/` | bản copy config gốc mỗi lần switch |

## Ba điều phải biết

**1. Token OAuth tự refresh.** Claude Code chạy một lúc là token trong Keychain đổi. `ccp use` tự capture profile đang active trước khi switch, nên vault luôn giữ token mới nhất. Nếu bạn sửa Keychain bằng tay hoặc dùng nhiều máy, chạy `ccp capture` cho chắc — `ccp doctor` sẽ báo nếu vault bị cũ.

**2. Lần đầu mỗi nick phải `/login` bằng tay.**

**3. Switch không ăn vào phiên đang mở.** Phải restart Claude Code / Codex.

## Chạy nhiều profile song song

`ccp use` là global (ghi `settings.json`), áp dụng cả khi mở Claude Code từ VSCode hay desktop app. Muốn một terminal dùng profile khác mà không đổi global:

```bash
eval $(ccp env tuongtacfree)
claude
```

Chỉ dùng được với `proxy` và `apikey` — `oauth` nằm trong Keychain nên không có env để export.

## Troubleshooting

**`No available accounts`**

Provider bên thứ 3 hết account để phục vụ model đó. Không phải lỗi cấu hình của bạn — không sửa gì được ở phía mình, phải liên hệ chỗ bán key. Dùng `ccp check` để xác nhận trước khi mất thời gian debug.

**`wire_api = "chat" is no longer supported`**

Bản Codex mới chỉ nhận `responses`. Nếu provider của bạn chỉ có `/v1/chat/completions` thì Codex không dùng được provider đó, kể cả key còn sống. Chọn provider khác hoặc dùng key đó cho Claude Code.

**Hộp thoại "A keychain cannot be found"**

Bấm **Cancel**, đừng bấm "Reset To Defaults". Nghĩa là `security` không tìm được login keychain — thường do `HOME` đang trỏ chỗ khác. `ccp` đã luôn truyền home thật cho `security`, nên nếu vẫn gặp thì chạy `ccp doctor` để xem chi tiết.

**Claude Code hiện sai account sau khi switch**

Profile đó chưa lưu identity. Vào Claude Code bằng nick đúng rồi `ccp capture <name>`.

**Đổi profile rồi mà không thấy gì thay đổi**

Chưa restart. Hoặc shell hiện tại còn `ANTHROPIC_*` từ `eval $(ccp env ...)` lần trước — env của shell thắng `settings.json`. Mở terminal mới.

**`ccp check` báo token hết hạn**

`claude` → `/login` lại nick đó → `ccp capture <name>`.

## Revert hoàn toàn

```bash
ccp use <profile-gốc>
```

Hoặc restore tay từ backup:

```bash
ls ~/.ccp/backups/                      # chọn timestamp
cp ~/.ccp/backups/<stamp>/settings.json ~/.claude/settings.json
cp ~/.ccp/backups/<stamp>/config.toml   ~/.codex/config.toml
cp ~/.ccp/backups/<stamp>/auth.json     ~/.codex/auth.json
```

Xoá sạch dấu vết của `ccp`:

```bash
rm -rf ~/.ccp
security delete-generic-password -s ccp-vault -a "$USER:<tên-profile>"    # từng profile
npm unlink -g ccp
```

## Test

Chạy trong `HOME` giả (copy config thật vào làm fixture, không chạm bản gốc). Test 2 dùng service Keychain giả nên không đụng login thật:

```bash
FAKE_HOME=/tmp/ccp-test node test/1-apply.mjs         # patch config.toml + settings.json, idempotency
FAKE_HOME=/tmp/ccp-test node test/2-oauth-switch.mjs  # TOML valid, switch nick, token refresh
FAKE_HOME=/tmp/ccp-test TTF_KEY=sk-... node test/3-check-cli.mjs
```

## Lưu ý về provider bên thứ 3

Mọi prompt và code gửi qua provider bên thứ 3 đều đi qua server của họ, và họ đọc được. Đừng dùng cho code hoặc dữ liệu nhạy cảm.

`ccp check` gọi đúng endpoint mà công cụ sẽ thật sự dùng — `/v1/messages` cho Claude Code, `/v1/responses` streaming cho Codex — nên nó bắt được trường hợp provider liệt kê model rất hào nhoáng nhưng endpoint thì chết. Danh sách `/v1/models` của provider **không** đáng tin: nó có thể thiếu model họ vẫn serve, và liệt kê model họ không serve được.
