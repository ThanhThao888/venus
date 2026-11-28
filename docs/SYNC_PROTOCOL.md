# SYNC_PROTOCOL — Đồng bộ bộ nhớ VPIS (Phase 3A + 3B)

> Tài liệu này mô tả cách `profile` và `decisions` đi giữa `VenusMemoryDB` (IndexedDB trên mỗi thiết bị) và Supabase.
> Mọi mô tả dựa trên code thực tế: `supabase/migrations/001_core.sql`, `002_sync.sql`, `003_sync_rpc.sql`, `004_user_devices_delete.sql`, `venus-memory.js`, `venus-sync.js`, `venus-account.js`.
> Số dòng tính trên bản tải lên ngày 2026-11-27 và có thể lệch sau khi sửa. Khi code và tài liệu mâu thuẫn, **code đúng**, hãy sửa tài liệu.

## 1. Phạm vi

| Có đồng bộ | Không bao giờ đồng bộ |
| :--- | :--- |
| `profile` và `decisions` của `VenusMemoryDB` (kể cả mục `review_summary`) | Notes Vault, `localStorage` (Tracker, Goals, Sleep…), API key (`venus-ai`), token (`VenusAuthDB`), `audit_logs`, `outbox` |

- **Mặc định TẮT.** Bật thủ công trong hộp thoại Tài khoản, có xác nhận. Công tắc là `syncMeta.sync_enabled` (không phải `localStorage`).
- **Cloud không bao giờ là điều kiện** để app chạy. Khi lỗi hoặc offline: chỉ đổi dòng trạng thái, `outbox` giữ nguyên, không ném lỗi ra console (`venus-sync.js:12`).
- Hiện chỉ có 2 loại thực thể: `profile` và `decision` (xem mục 12 nếu muốn thêm loại mới).

## 2. Thành phần

```
Thiết bị A / B (mỗi nơi một VenusMemoryDB)         Supabase (Postgres + RLS)
┌──────────────────────────────────────────┐      ┌─────────────────────────────────────┐
│ venus-memory.js  (KHÔNG có mã mạng)      │      │ user_profile   (đọc-only với client)│
│  profile · decisions · outbox · syncMeta │      │ decisions      (đọc-only với client)│
│  audit_logs · API: onWrite, listOutbox,  │      │ sync_changes   (append-only, đọc-only)
│  ackOutbox, touchOutbox, applyRemote,    │      │ user_devices   (upsert + delete)    │
│  addConflicts, keepLocal, takeRemote,    │◄────►│ RPC vpis_push(ops)  ← ĐƯỜNG GHI DUY NHẤT
│  enqueueSnapshot, getSyncState …         │      └─────────────────────────────────────┘
│ venus-sync.js    (engine, UI khối Sync)  │
│ venus-account.js (client Supabase, phiên)│
└──────────────────────────────────────────┘
```

- `venus-memory.js` chỉ làm việc với IndexedDB. `venus-sync.js` là nơi duy nhất gọi mạng cho sync, qua `VenusAccount.getClient()` (khóa publishable + phiên của chính người dùng).
- Thứ tự nạp trong `index.html:92598–92604`: `ai-hub` → `venus-tools` → `venus-memory` → `venus-memory-ui` → `venus-account` → `venus-sync` → `venus-review`.

## 3. Mô hình dữ liệu

Mỗi bản ghi `profile`/`decision` mang metadata sync-ready: `id` (UUID), `device_id`, `revision` (số nguyên ≥ 1), `updated_at`, `deleted_at`, `schema_version`.

- **Xóa mềm (tombstone):** xóa = đặt `deleted_at` và tăng `revision`. Không có `DELETE` nào trên `user_profile`, `decisions`, `sync_changes` (không có policy và không có grant, `001_core.sql`). **Ngoại lệ duy nhất là `user_devices`** (xem 4.1): đó là danh sách thiết bị, không phải dữ liệu đồng bộ.
- **`revision`** tăng 1 mỗi lần ghi (`bump`, `venus-memory.js:109`). Đây là cơ sở của khóa lạc quan.
- **Giới hạn:** `payload` ≤ 64 KiB và phải là object; một lần gọi `vpis_push` tối đa 50 thao tác.
- **`profile.key` phải duy nhất giữa các mục còn sống** (ví dụ `personal_constraints`). Ràng buộc này chỉ được kiểm ở **client** (xem `key_clash`, mục 8). Server không có ràng buộc duy nhất cho `key`.

## 4. Server

### 4.1 Bảng và quyền (`001_core.sql`, `002_sync.sql`, `003_sync_rpc.sql`, `004_user_devices_delete.sql`)

| Bảng | Khóa | Client được làm gì |
| :--- | :--- | :--- |
| `user_profile`, `decisions` | `(user_id, id)` | **Chỉ `select`.** `insert`/`update` bị thu hồi ở cuối `003` (`revoke insert, update … from authenticated`) |
| `sync_changes` | `seq` (identity) | Chỉ `select`. Nhật ký thay đổi **append-only**, `unique (user_id, op_id)` |
| `user_devices` | `(user_id, device_id)` | `select`/`insert`/`update` (`001_core.sql`) và **`delete`** (`004_user_devices_delete.sql`: policy `user_devices_delete_own` `for delete to authenticated using ((select auth.uid()) = user_id)`; `grant delete` cho `authenticated`, `revoke delete` từ `anon`). Chỉ dòng của chính mình |

- Mọi bảng có `user_id` và RLS `(select auth.uid()) = user_id`. Trigger `vpis_guard_revision` chặn đổi `id`/`user_id` và chặn `revision` không tăng (phòng thủ thêm, ngoài RPC).
- Lý do một đường ghi: ghi trực tiếp sẽ bỏ qua `sync_changes`, các thiết bị khác không bao giờ thấy thay đổi đó. `user_devices` không đi qua `sync_changes` nên được ghi/xóa trực tiếp.
- **Gỡ thiết bị (`venus-account.js`, nút `Remove` trong `Your devices`):** `delete().eq('user_id', …).eq('device_id', …)` bằng phiên của chính người dùng. Chỉ xóa đúng một dòng `user_devices`; không đụng `user_profile`, `decisions`, `sync_changes` (`user_devices` chỉ có khóa ngoại tới `auth.users`, không bảng nào tham chiếu tới nó) và **không** đăng xuất thiết bị bị gỡ: máy còn đăng nhập sẽ tự ghi lại dòng của nó (`registerDevice`, upsert) lần sau mở app. Policy không biết máy nào đang gửi lệnh, nên việc chặn gỡ **máy hiện tại** do app đảm nhận: ẩn nút ở dòng đó, kiểm lại `VenusMemory.getDeviceId()` ngay trước khi xóa, và không hiện nút nào nếu chưa xác định được ID máy này.

### 4.2 RPC `vpis_push(ops jsonb)` (`003_sync_rpc.sql`)

- `SECURITY DEFINER`, nhưng **mọi câu lệnh đều bị giới hạn bởi `auth.uid()`**. `user_id` do client gửi không bao giờ được đọc.
- Một khóa advisory theo người dùng (`pg_advisory_xact_lock`) làm cho thứ tự `seq` bằng thứ tự commit, nên con trỏ `seq > N` không bao giờ bỏ sót dòng.
- Mỗi thao tác chạy trong sub-transaction riêng: một thao tác hỏng không làm hỏng các thao tác khác.
- **Idempotent:** `op_id` đã ghi cho người dùng này thì trả `duplicate`, không ghi lại.
- **Khóa lạc quan:** thực thể đã tồn tại chỉ nhận `revision = revision_server + 1`. Thực thể mới nhận mọi `revision ≥ 1` (ảnh chụp của mục đã có sẵn trên thiết bị).
- Sau thao tác đầu tiên của một thực thể mà không được áp dụng (conflict/invalid/error), các thao tác sau của **cùng thực thể** trong lần gọi đó nhận `blocked`, để không nhảy qua một thay đổi bị mất.

| `status` | Ý nghĩa | Client làm gì (`venus-sync.js:121–133`) |
| :--- | :--- | :--- |
| `ok` | Đã ghi, kèm `seq` | `ackOutbox` (xóa khỏi outbox) |
| `duplicate` | `op_id` đã được ghi trước đó | `ackOutbox` |
| `conflict` | `stale_revision` hoặc `revision_gap`, kèm bản `server` | `addConflicts`, **giữ thực thể lại**, không gửi nữa |
| `blocked` | Thao tác trước của cùng thực thể không được áp dụng | Giữ nguyên trong outbox |
| `invalid` | Sai định dạng (`bad_op_id`, `bad_payload`, `payload_id_mismatch`…) | `touchOutbox(…, 'invalid:<lý do>')` → trở thành **stuck** |
| `error` | Lỗi server (`server_error`, kèm `sqlstate`) | `touchOutbox(…, 'error:…')`, thử lại ở lượt sau |

Kết quả khớp thứ tự với `ops`. Nếu độ dài hoặc `op_id` không khớp, client coi là lỗi (`bad_result` hoặc `error:mismatch`).

## 5. Một lượt đồng bộ (`doSync`, `venus-sync.js:145–163`)

```
0. Điều kiện: sync_enabled · đã đăng nhập · navigator.onLine · không chạy song song (cờ + Web Locks 'venus-sync')
1. PULL   sync_changes WHERE seq > cursor, theo seq tăng dần, 200 dòng/trang, tối đa 25 trang
          → applyRemote(rows) (một transaction IndexedDB, cursor cập nhật cùng transaction)
2. (lần đầu) enqueueSnapshot(known): xếp hàng mọi bản ghi cục bộ mà cloud chưa có hoặc có revision thấp hơn
3. PUSH   outbox → vpis_push, 50 thao tác/lần, tối đa 20 vòng; bỏ qua thực thể đang có conflict và thao tác stuck
4. PULL ngắn (nếu đã push hoặc còn trang) để con trỏ đi qua chính các thay đổi của mình
5. Ghi last_sync_at, xóa last_sync_error, cập nhật user_devices.last_sync_at (best effort)
```

**Lần đầu trên một thiết bị** (`sync_initialized = false`): kéo từ `seq = 0`, ghi nhớ revision cao nhất của từng thực thể (`known`), rồi `enqueueSnapshot(known)` rồi push. Cờ `sync_initialized` được đặt trong cùng transaction với `enqueueSnapshot`.

**Thông số (`CFG`, `venus-sync.js:18`):** `page 200`, `pushBatch 50`, `maxPullPages 25`, `maxPushRounds 20`, `netTimeout 20 s`, `debounce 2 s`, `startDelay 3 s`, `visibleGap 15 s`, `retryDelay 5 s`.

### 5.1 Khi nào chạy

Đăng nhập · mở app (+3 s) · tab hiện lại (cách lượt trước > 15 s) · có mạng lại · sau mỗi lần ghi bộ nhớ (debounce 2 s, qua `onWrite`) · nút "Đồng bộ ngay" · tự chạy lại một lần nếu có yêu cầu trong lúc đang chạy · thử lại sau 5 s nếu tab khác đang giữ khóa.

**Không dùng Background Sync / Periodic Background Sync** (không có trên iOS Safari). Cơ chế chính là foreground/online/mở app.

### 5.2 Chạy song song

- Trong một tab: cờ `running`; yêu cầu thêm chỉ đặt `again = true`.
- Giữa các tab: `navigator.locks.request('venus-sync', { ifAvailable: true })`; tab không lấy được khóa trả `other_tab` và hẹn thử lại.
- Nếu hai lượt vẫn chạy cùng lúc (trình duyệt không có Web Locks), server idempotent nên **chạy trùng không gây hại**.

## 6. Outbox

- Mỗi lần ghi cục bộ sinh một thao tác `{op_id, entity_type, entity_id, op, revision, device_id, payload, created_at, attempts, last_error}`.
- `listOutbox` trả theo thứ tự cũ → mới; các thao tác của **cùng một thực thể luôn theo thứ tự `revision`**, kể cả khi đồng hồ bị lùi giữa hai lần ghi (`venus-memory.js:496`).
- `ackOutbox` xóa thao tác đã được server nhận. `touchOutbox` tăng `attempts` và lưu `last_error` (≤ 120 ký tự).
- **Stuck:** thao tác có `last_error` bắt đầu bằng `invalid:` bị server từ chối vĩnh viễn, không được gửi lại tự động. Người dùng có thể "Bỏ các thay đổi bị từ chối" (bấm hai lần để xác nhận). Dữ liệu trên máy không bị xóa.
- Lỗi mạng chỉ `touchOutbox(…, 'network')` rồi ném lỗi để phân loại.

## 7. Pull: `applyRemote` (`venus-memory.js:550–590`)

Xử lý trong **một transaction**, theo `seq` tăng dần, cho từng dòng:

| Tình huống | Hành động |
| :--- | :--- |
| `seq` không hợp lệ | Đếm `invalid` |
| `seq ≤ cursor` | Bỏ qua |
| `schema_version` của dòng **lớn hơn** schema của app | **Dừng ngay trước dòng đó** (`halted: 'too_new'`), cursor giữ nguyên, không mất dữ liệu. UI báo "cần cập nhật app" |
| Dữ liệu hỏng (id/revision không khớp) | Đếm `invalid`, cursor đi tiếp (dòng hỏng không bao giờ hợp lệ) |
| Máy này đã có revision ≥ revision của dòng | Bỏ qua (gồm cả bản dội lại của chính mình) |
| Thực thể còn thao tác chưa gửi trong outbox | **Conflict** `remote_changed_while_pending`; bản cục bộ giữ nguyên |
| Profile trùng `key` với một mục còn sống khác `id` | **Conflict** `key_clash` (`clash_with` = id mục đang giữ `key`) |
| Còn lại | Ghi đè bằng bản server, **không** xếp lại vào outbox |

`applyRemote` và các hàm bookkeeping khác **không kích hoạt `onWrite`**, nên đồng bộ không thể tự đánh thức lại engine thành vòng lặp (`venus-memory.js:448`).

## 8. Xung đột

Xung đột **không bao giờ tự gộp**. Thực thể bị giữ lại, UI hiện cả hai bản cạnh nhau, người dùng chọn.

| Lý do | Phát hiện ở | Ý nghĩa |
| :--- | :--- | :--- |
| `remote_changed_while_pending` | Client, lúc pull | Cloud đổi mục này trong khi máy còn thao tác chưa gửi |
| `stale_revision` / `revision_gap` | Server, lúc push | Revision gửi lên không bằng revision server + 1 |
| `key_clash` | Client, lúc pull | Hai mục profile khác `id` cùng `key` |

Cách giải quyết (cần `approvedByUser: true`, ghi `audit_logs`):

- **`keepLocal(key)` — "Giữ bản máy này":** tạo một thao tác mới ở `revision = revision_server + 1` mang nội dung cục bộ, bỏ các thao tác cũ chưa gửi của mục đó. Với `key_clash`, thay vào đó xóa mềm bản trùng trên cloud (tombstone ở `server + 1`).
- **`takeRemote(key)` — "Lấy bản cloud":** nhận bản server, bỏ các thao tác chưa gửi của mục. Với `key_clash`, xóa mềm (có đồng bộ) mục cục bộ trùng `key`.
- Sau khi giải quyết, engine chạy lại một lượt để gửi kết quả lên.

## 9. Lỗi và trạng thái

`classify(e)` quy mọi lỗi về 3 nhóm an toàn; chuỗi lỗi từ server **không bao giờ hiển thị** (`venus-sync.js:44`).

| `phase` | Nguyên nhân | Hành vi |
| :--- | :--- | :--- |
| `idle` | Bình thường | — |
| `syncing` | Đang chạy | — |
| `offline` | `navigator.onLine === false`, timeout, lỗi mạng | Giữ outbox, tự thử lại khi có mạng |
| `auth` | 401/403, JWT hết hạn | Cần đăng nhập lại |
| `error` | Lỗi khác | Lưu `last_sync_error` dạng `kind:code` |
| `needs_update` | `halted: 'too_new'` | Dừng pull; cần cập nhật app |
| `signed_out` | Chưa/không còn phiên | Không đồng bộ |

## 10. Bảo mật

- Frontend chỉ có **khóa publishable** và JWT của chính người dùng. `venus-account.js` từ chối chạy nếu khóa là `sb_secret_…` hoặc JWT có `role: service_role`.
- Phiên lưu trong IndexedDB `VenusAuthDB`, không dùng `localStorage`. Nếu có khóa kiểu `sb-…` trong `localStorage`, backup loại trừ (`index.html:81061`).
- Dữ liệu `payload` nằm **dạng văn bản thường** trong Postgres, bảo vệ bằng RLS và mã hóa lưu trữ của Supabase, **không** mã hóa đầu-cuối. Đừng đưa vào Hồ sơ/Quyết định những thông tin bạn không muốn lưu trên đám mây.
- Mọi chuỗi từ server hoặc từ mục bộ nhớ hiển thị bằng `textContent`.

## 11. Bất biến cần giữ khi sửa

1. Không thêm đường ghi trực tiếp vào `user_profile`/`decisions`/`sync_changes` từ client. Chỉ `vpis_push`.
2. `venus-memory.js` không có mã mạng. Mã mạng chỉ nằm trong `venus-sync.js`/`venus-account.js`.
3. Bookkeeping của sync (`applyRemote`, `ackOutbox`, `touchOutbox`, `addConflicts`, `setSyncMeta`) **không** được gọi `onWrite`.
4. Cursor chỉ tiến cùng transaction với việc áp dụng các dòng tương ứng.
5. Xung đột không tự gộp; mọi giải quyết cần `approvedByUser: true` và ghi audit.
6. Thao tác của cùng một thực thể phải đi theo thứ tự `revision`, và một thao tác không được áp dụng thì chặn các thao tác sau của thực thể đó.
7. Backup/restore cục bộ không tự ghi đè cloud (`importProgress` → `VenusMemory.importAll`).
8. Cloud lỗi không được làm hỏng bất cứ chức năng nào khác.
9. `DELETE` chỉ tồn tại trên `user_devices` và chỉ cho dòng của chính người dùng. App không bao giờ gỡ dòng của thiết bị đang dùng.

## 12. Giới hạn và rủi ro đã biết

Những điều dưới đây là **quan sát từ code**, không phải lỗi đã xảy ra.

1. **`key` của profile không duy nhất ở server.** Chỉ client phát hiện `key_clash`. Nếu hai thiết bị cùng tạo một `key` khi cả hai offline, chỉ thiết bị pull sau mới thấy xung đột.
2. **`sync_changes` chỉ tăng, chưa có cơ chế dọn.** Với bộ nhớ cá nhân (vài trăm mục) việc này không đáng lo, nhưng lần đồng bộ đầu tiên đọc tối đa 5.000 dòng (25 trang × 200). Nếu nhiều hơn, `known` chưa đủ khi gọi `enqueueSnapshot`, có thể xếp hàng một số mục mà cloud đã có, và server sẽ trả `conflict` cho chúng (an toàn nhưng gây xung đột thừa).
3. **Không có backoff hoặc giới hạn số lần thử** cho lỗi mạng/`error`. Mỗi lần kích hoạt đều thử lại (debounce 2 s, tab hiện lại cách 15 s). `attempts` chỉ để hiển thị.
4. **`too_new` dừng đồng bộ cho đến khi app được cập nhật.** Trên iPhone PWA, nếu bản cũ còn trong cache, hãy tải lại hoặc xóa cache của PWA.
5. **Cursor nằm cục bộ.** Xóa dữ liệu IndexedDB làm `sync_initialized` về `false` và kéo lại từ đầu. Điều này an toàn, chỉ tốn băng thông.
6. **Chưa có xóa cứng và chưa có dọn tombstone** trên cloud; `user_devices` không tự dọn: thiết bị cũ chỉ biến mất khi người dùng bấm `Remove` (thủ công, từng thiết bị).
7. **`updated_at` trong `payload` do đồng hồ máy khách đặt.** Server dùng `now()` cho cột `updated_at` riêng. Thứ tự tin cậy duy nhất là `revision` và `seq`, đừng dùng `updated_at` để so sánh "bản nào mới hơn".
8. **Không mã hóa đầu-cuối** (mục 10).

## 13. Mở rộng sang loại dữ liệu mới (Phase 5: Goals/Deadlines)

Việc này **không chỉ là thêm một adapter**. Cần một migration mới vì loại thực thể đang được ghi cứng ở nhiều nơi:

- `sync_changes.entity_type` có `check (entity_type in ('profile', 'decision'))` (`002_sync.sql`).
- `vpis_push` kiểm `v_type in ('profile', 'decision')` ở nhiều chỗ và chọn bảng bằng `if v_type = 'profile' … else …` (`003_sync_rpc.sql`). Thêm loại thứ ba cần viết lại nhánh này, không chỉ thêm giá trị.
- Phía client: `storeOf`, `normOf`, `enqueueSnapshot`, `applyRemote` trong `venus-memory.js` đều giả định hai store.
- Goals/Deadlines hiện nằm trong `localStorage` dạng mảng. Cần quyết định nơi lưu có `id`/`revision` (không nhét dữ liệu VPIS mới vào `localStorage`, theo `CLAUDE.md`). Mỗi module `localStorage` cần adapter riêng; không có "sync cả `localStorage`".

## 14. Cách kiểm tra khi sửa sync

- RPC: bộ test SQL 28/28 của Phase 3A (theo bạn báo). Nên lưu vào repo (ví dụ `supabase/tests/`) để chạy lại sau mỗi migration.
- Hai thiết bị: tạo một mục ở A (offline), sửa cùng mục ở B, bật mạng cả hai và xác nhận xuất hiện đúng một xung đột với cả hai bản.
- Offline: tắt mạng, sửa một mục, kiểm tra `VenusMemory.getSyncState().outbox_pending` tăng và console không có lỗi; bật mạng và kiểm tra về 0.
- Hồi quy: Console 0 lỗi; backup JSON xuất/nhập thành công và **không** chứa khóa `sb-…`, API key hay token.
