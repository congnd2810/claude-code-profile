# Thiết kế: pool account + auto-rotate khi hết quota, và target Antigravity

Trạng thái: **đã chốt, đang implement**. Ngày: 2026-09-09.

Chốt sau khi review: **rotate thủ công bằng tay** — bỏ `ccp run`, bỏ hook, bỏ daemon. `threshold` mặc định 90%. Pool dùng chung namespace với profile. Không refresh token của member không active (kể cả Antigravity).

Mục tiêu do người dùng đặt ra:

1. Vẫn dùng **một account tại một thời điểm**, nhưng khi account đang dùng cạn quota thì `ccp` tự chuyển sang account kế tiếp trong một **pool**.
2. Phạm vi: **Claude Code CLI**, **Codex CLI**, và **Antigravity** (target mới, chưa có trong `ccp`).

Không nằm trong phạm vi: chạy song song nhiều account cùng lúc (xem [Phụ lục A](#phụ-lục-a--cơ-chế-cô-lập-credential-để-dành-cho-sau)), gán profile theo project, Claude Desktop rotation (app chỉ có một login, giữ nguyên cơ chế `desktop.mjs` hiện tại).

---

## 1. Phát hiện kỹ thuật (nền cho thiết kế)

Đã kiểm chứng trên máy này (macOS 25.6, `claude` 2.1.266, `codex` 0.153.4, Antigravity IDE 1.x + `agy`).

### 1.1 Antigravity giữ login ở đâu

| Thứ | Vị trí | Ghi chú |
|---|---|---|
| Credential | Keychain: service `gemini`, account `antigravity` | **Một ô duy nhất, global** — hệt `Claude Code-credentials` |
| Định dạng | `go-keyring-base64:` + base64 của JSON | `{ token: { access_token, token_type, refresh_token, expiry }, auth_method: "consumer", id_token }` |
| Identity | `id_token` (JWT) → `sub` (Google account id) + `email` | Dùng để guard capture, giống `oauthAccount.accountUuid` / `tokens.account_id` |
| Hết hạn | `token.expiry` (ISO 8601, có timezone) | Access token sống ~1h |
| State khác | `~/.gemini/antigravity*`, `~/.gemini/config/`, `~/Library/Application Support/Antigravity` | **Không** buộc theo account (installation_id, conversations, settings) → `ccp` không cần chạm |

Cả CLI (`~/.local/bin/agy`) và IDE (`Antigravity IDE.app/.../extensions/antigravity/bin/language_server_macos_arm`) đều đọc **cùng ô keychain đó** qua `security find-generic-password` (cả hai binary đều chứa chuỗi `go-keyring-base64:`). Nghĩa là: đổi ô keychain = đổi account cho **cả CLI và IDE** — không có chuyện phải xử lý hai chỗ như Claude Desktop.

Kéo theo hai hệ quả:

- `agy` **không có** subcommand `login`/`auth` (đã chạy `agy --help`): login lần đầu của mỗi account **phải làm trong IDE**. Đúng với nguyên tắc "first login is manual" đang có.
- IDE/language server đang chạy có thể refresh token và ghi đè ô keychain → phải capture trước khi swap, và hỏi quit IDE (bundle id `com.google.antigravity-ide`), tái sử dụng pattern của `desktop.mjs`.

### 1.2 Quota của Antigravity — chưa mở khoá được

Backend là `cloudcode-pa.googleapis.com`, các method dạng `POST /v1internal:<method>` với `authorization: Bearer <access_token>`. Trong binary `agy` có sẵn các proto `RetrieveUserQuotaSummaryRequest/Response`, `QuotaSummaryBucket`, `QuotaSummaryGroup`, `StatusLineQuotaBucket`, field `remaining_fraction`, `reset_time`, `bucket_name`.

Đã probe thật với access token hiện tại:

| Request | Kết quả |
|---|---|
| `POST /v1internal:retrieveUserQuotaSummary` body `{}` | `403 PERMISSION_DENIED` — "You do not have a valid license of this product… (#3501)" |
| `POST /v1internal:retrieveUserQuota` body `{}` | `403` như trên |
| body `{"metadata":{...}}` | `400 INVALID_ARGUMENT` — "Unknown name \"metadata\"" |
| `POST /v1internal:fetchQuotaStatus` | `404` (không phải REST method) |

Kết luận: endpoint đúng, nhưng **request shape chưa đúng** (thiếu field client metadata mà server dùng để nhận diện license tier free của Antigravity). Proto descriptor bị gzip trong binary nên không đọc được field name bằng `strings`.

→ Quota Antigravity là **một phase R&D riêng**, không chặn phần còn lại (xem [§6](#6-phase--verify)).

### 1.3 Quota của Claude và Codex — đã có sẵn

`src/usage.mjs` đã gọi `api.anthropic.com/api/oauth/usage` và `chatgpt.com/backend-api/codex/usage`, và đã cache snapshot vào `profile.usage`. Rotation **dùng lại nguyên phần này**, chỉ cần thêm một hàm đọc snapshot → "đã cạn hay chưa".

Giới hạn đã biết và giữ nguyên (README đã giải thích, không đổi quyết định): chỉ query **live** cho profile đang active; profile không active dùng snapshot cache, vì refresh token của account khác là rủi ro mất login.

---

## 2. Mô hình dữ liệu

`~/.ccp/profiles.json` lên `version: 2` (migrate im lặng khi `load()`, thiếu field thì điền default):

```jsonc
{
  "version": 2,
  "active":     { "claude": "work-max", "codex": null, "antigravity": null },
  "activePool": { "claude": "max-pool", "codex": null, "antigravity": null },
  "pools": {
    "max-pool": { "target": "claude", "members": ["work-max", "personal-max"], "threshold": 90 }
  },
  "profiles": {
    "work-max": {
      "target": "claude", "kind": "oauth",
      "usage": { "fetchedAt": 0, "windows": [] },   // đã có
      "exhaustedUntil": 1788943544000,              // mới
      "lastUsedAt": 1788940000000                   // mới
    }
  }
}
```

Quyết định:

- **Pool dùng chung namespace với profile** → `ccp use <name>` nhận cả hai, không thêm cú pháp mới. `put()`/`putPool()` phải từ chối tên trùng.
- `active[target]` vẫn luôn là **tên profile thật** (mọi code hiện tại không đổi ý nghĩa). `activePool[target]` chỉ ghi "profile này được chọn từ pool nào", để `ccp rotate` không cần nhắc lại tên pool.
- `exhaustedUntil` là **suy luận có thể sai và tự hết hạn** — không phải sự thật tuyệt đối. Quá thời điểm đó thì member coi như dùng được lại.
- `threshold` mặc định 90 (%). `limit_reached` của Codex → cạn ngay bất kể %.

---

## 3. Chọn member: một hàm thuần

`src/rotate.mjs`:

```js
pick(state, poolName, now) -> { name, reason } | { none: true, until, reason }
```

Thứ tự:

1. Loại member `exhaustedUntil > now`.
2. Còn lại: sắp theo `usage` cache thấp nhất → tie-break `lastUsedAt` cũ nhất (round-robin cho account chưa có số liệu).
3. Nếu **hết member**: trả `{ none: true, until: min(exhaustedUntil) }` → in "cả pool đang cạn, sớm nhất là `<name>` sau 1h 20m", **không switch**.

Nguồn `exhaustedUntil`:

| Nguồn | Khi nào | Cách tính |
|---|---|---|
| Live quota (`usage.mjs`) | Profile đang active, mỗi lần `ccp rotate` / `ccp usage` | `max(resetsAt)` của các window có `used >= threshold`; hoặc `limitReached` |
| Snapshot cache | Member không active | Như trên, nhưng nếu `resetsAt` đã qua → xoá cờ, coi là dùng được |
| Reactive | Người dùng/hook báo | `ccp mark <name> --exhausted [--until <iso>]`; mặc định +5h nếu không biết reset time |

Hàm này thuần (không I/O) để test trực tiếp.

---

## 4. Lệnh và UX

| Lệnh | Việc |
|---|---|
| `ccp pool` | liệt kê pool + member + tình trạng quota đã biết |
| `ccp pool <pool> <profile...>` | tạo/ghi đè pool (member phải cùng `target`) |
| `ccp pool rm <pool>` | xoá pool (không xoá profile) |
| `ccp use <pool>` | resolve pool → member tốt nhất → `apply` như hiện tại |
| `ccp rotate [pool] [--if-exhausted]` | refresh quota của active, chọn member khác, apply |
| `ccp mark <name> [5h\|ok]` | đánh dấu tay khi tool báo hết limit (`ok` = xoá cờ) |

Exit code của `rotate` (để cron/hook dùng được): `0` đã đổi · `3` không cần đổi · `4` cả pool đang cạn.

TUI (`src/tui.mjs`): pool hiện thành một dòng nhóm phía trên các member của nó; thêm key `r` = rotate pool đang active.

**Điểm phải nói thẳng trong tài liệu và trong output**: switch **không** cứu được session đang chạy — Claude Code/Codex/agy đọc credential lúc khởi động. `ccp rotate` chỉ chuẩn bị cho lần mở kế tiếp; vẫn phải restart tool. Đã chốt là chỉ làm bản thủ công: không `ccp run`, không hook, không daemon poll quota.

---

## 5. Target Antigravity

`src/antigravity.mjs`, cùng giao diện với `claude.mjs` / `codex.mjs` (`apply`, `captureActive`, `captureInto`, `liveBlob`, `liveIdentity`, `describe`) để `mod(target)` trong `ccp.mjs` chỉ cần thêm một nhánh.

- `target: 'antigravity'`, `kind: 'google'` (một kind duy nhất; Antigravity không có đường proxy/API key).
- Credential đọc/ghi qua `keychain.mjs` với service `gemini`, account `antigravity`. Thêm override `CCP_GEMINI_SERVICE` / `CCP_GEMINI_ACCOUNT` cho test, đúng như `CCP_CLAUDE_SERVICE` đang làm.
- Blob được coi là **string opaque** (giữ cả tiền tố `go-keyring-base64:`), chỉ decode để đọc identity/expiry — cùng triết lý với blob của Claude.
- `identity = { sub, email }`. `captureActive` bỏ qua nếu `sub` live khác `sub` của profile → không bao giờ ghi đè vault của account khác (bug này đã được xử lý ở hai target kia, làm y hệt).
- `apply` chỉ ghi keychain. Không có file config nào của Antigravity bị chạm → `~/.gemini/**` giữ nguyên tuyệt đối.
- IDE đang chạy: cảnh báo + hỏi quit (`osascript quit app id "com.google.antigravity-ide"`), rồi hỏi mở lại — dùng lại y nguyên logic `quit()`/`launch()` của `desktop.mjs`, chỉ khác bundle id và tên process.
- `ccp add` → `antigravity` có hai nhánh như hai target kia: "capture the current login", hoặc "I will switch accounts in the IDE now" → `ccp` mở IDE và poll keychain tới khi `sub` đổi (`waitForNewLogin`, tối đa 5 phút). Vì `agy` không có lệnh login, đây là thứ gần nhất với `claude auth login`.
- Cả ba target đều chặn add trùng account: `ownerOfLive(state)` tìm profile đã giữ login đang có, `ccp add` cảnh báo và hỏi lại thay vì tạo hai profile chung một quota.
- `ccp usage` với kind `google`: tạm báo `not available` cho tới khi phase R&D xong.

---

## 6. Phase + verify

Mỗi phase phải xanh trước khi qua phase sau. Test chạy trên `FAKE_HOME` như các test hiện có.

**Phase 1 — Antigravity thành target thứ ba**
`store.mjs` (thêm `antigravity` vào `KINDS`, `active`), `antigravity.mjs`, `ccp.mjs` (`mod`, `cmdList`, `cmdAdd`, `doctor`, completion), `tui.mjs`.
→ verify: `test/9-antigravity.mjs` — capture → apply → apply lại (idempotent) → capture khi live là account khác (phải **skip**, vault không đổi) → `rm` xoá đúng vault entry. Cộng `ccp list` / `ccp doctor` không vỡ khi chưa có profile antigravity nào.

**Phase 2 — Pool + rotate**
`store.mjs` v2 + migrate, `rotate.mjs`, `usage.mjs` (tách `exhaustionOf(snapshot, threshold)`), `ccp.mjs` (`cmdPool`, `cmdRotate`, `cmdMark`, `cmdUse` resolve pool), `tui.mjs` key `r`.
→ verify: `test/10-rotate.mjs` — `pick()` với: một member cạn, tất cả cạn, snapshot stale đã qua reset, hai member chưa có số liệu (phải round-robin theo `lastUsedAt`), member sai target bị từ chối. Cộng migrate v1→v2 giữ nguyên profile cũ.

**Phase 3 (R&D, độc lập) — quota Antigravity**
Cách tiếp cận, theo thứ tự rẻ → đắt:
1. Giải nén proto descriptor (`quota_summary_proto_rawDescGZIP`) khỏi binary `agy` để lấy đúng field name của `RetrieveUserQuotaSummaryRequest`.
2. Nếu không xong: bắt request thật của language server (nó có `ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN` → chạy được sau proxy) và copy nguyên header + body.
→ verify: gọi được endpoint trả `200` cho account free, parse ra `windows` giống format `usage.mjs` đang render. Xong thì rotation của antigravity mới là proactive; trước đó là reactive (`ccp mark`).

---

## 7. Rủi ro và quyết định cần chốt

1. ~~**Rotate không tác động tới session đang chạy.**~~ Đã chốt: chỉ `ccp rotate` thủ công, người dùng tự restart tool.
2. **Quota của member không active chỉ là cache.** Rotation có thể chọn một account thực ra cũng đã cạn → lần chạy sau nó tự sửa (live query thấy cạn → mark → rotate tiếp). Chấp nhận, nhưng nghĩa là rotate có thể phải gọi 2 lần trong trường hợp xấu.
3. **Google refresh token có thể refresh an toàn hơn Anthropic/OpenAI** (Google thường không rotate refresh token của desktop client) → nếu đúng, Antigravity là target **duy nhất** có thể query quota live cho cả member không active. Đã chốt là **không** làm; ghi lại nếu sau này cần.
4. **`threshold = 90%`** là con số tôi chọn, không phải con số có cơ sở. Đã chốt tạm 90, đổi được từng pool qua `pools.<name>.threshold`.
5. **Ghi secret qua argv.** `keychain.mjs` đã ghi secret qua `-w <value>`, tức là hiện ra trong `ps` trong khoảnh khắc ngắn. Blob Antigravity (~1.9 KB) đi cùng đường đó. Không phải vấn đề mới, nhưng đây là chỗ thứ ba dùng nó — nếu muốn siết thì siết một lần cho cả ba.
6. **Nhiều account là account của chính bạn.** `ccp` chỉ chuyển giữa các login bạn đã có; nó không nới limit của một account nào.

---

## Phụ lục A — cơ chế cô lập credential (để dành cho sau)

Không dùng cho thiết kế này, nhưng đã kiểm chứng và đáng ghi lại, vì nó là đường duy nhất để **chạy song song** nhiều account sau này:

- `claude` build tên keychain service là `Claude Code-credentials` **+ `-<sha256(dir)[0..8]>`** khi có `CLAUDE_CONFIG_DIR`; hậu tố này điều khiển riêng được bằng `CLAUDE_SECURESTORAGE_CONFIG_DIR` (set = path → hash path đó; set rỗng → dùng ô global). Trên máy này đã tồn tại 6 ô `Claude Code-credentials-<hash>` bên cạnh ô global.
- `codex` có `CODEX_HOME`.
- `agy` có `ANTIGRAVITY_EXECUTABLE_DATA_DIR` (chưa xác minh nó có tách credential hay không — credential nằm ở keychain, mà tên service của go-keyring trong `agy` chưa thấy chỗ nào cấu hình được).

Nghĩa là Claude Code và Codex **có thể** chạy song song nhiều account bằng env, còn Antigravity thì hiện chưa.
