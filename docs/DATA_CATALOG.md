# DATA_CATALOG — Dữ liệu của Venus Hub (VPIS)

> Danh mục: dữ liệu nằm ở đâu, ai đọc/ghi, cái gì được backup, cái gì rời khỏi máy.
> Mức độ chắc chắn được ghi rõ: **[đã đọc code]** là đã xác minh trong mã nguồn; **[theo CLAUDE.md]** là lấy từ tài liệu kiến trúc, chưa kiểm lại từng khóa.
> Số dòng tính trên bản tải lên ngày 2026-11-27 và có thể lệch.

## 1. Ba vùng dữ liệu

| Vùng | Gồm | Quy tắc |
| :--- | :--- | :--- |
| **A — Local Private** (mặc định) | Notes Vault và tệp đính kèm, `localStorage` của Tracker, API key & PIN hash AI (`venus-ai`), token đăng nhập | Chỉ nằm trên thiết bị, không tự lên cloud |
| **B — Opt-in Sync** | `profile`, `decisions` trong `VenusMemoryDB` | Lưu cục bộ trước, đồng bộ hai chiều khi người dùng bật (xem `SYNC_PROTOCOL.md`) |
| **C — Cloud Operational** | Phiên Supabase Auth, `user_devices`, `sync_changes` | Do Supabase quản lý; không chứa Notes hay dữ liệu Tracker |

## 2. Nơi lưu trữ trên thiết bị

### 2.1 IndexedDB

| Database | Phiên bản | Nội dung | Chủ sở hữu | Vào backup? | Lên cloud? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `FinanceTrackerVaultDB` | v4 [đã đọc: `vault.js:56–57`] | Notes, revisions, liên kết tệp, attachments | `vault.js` | **Có**, qua `NotesVault.getBackupParts()` (`vault.js:7009`, nối ở `index.html:81095`) | Không |
| `VenusMemoryDB` | v1, `SCHEMA 1` [`venus-memory.js:20`] | Stores: `profile`, `decisions`, `outbox`, `syncMeta`, `audit_logs` | `venus-memory.js` | **Một phần:** chỉ `profile` + `decisions` (`exportAll`, `venus-memory.js:335`) | `profile` + `decisions` nếu bật sync |
| `venus-ai` | v1, store `kv` (phiên bản IndexedDB giữ nguyên; schema nằm trong giá trị, xem 2.2) | Khóa `settings`: **nhiều profile AI, gồm `apiKey` của từng profile**; khóa `usage`: bộ đếm lượt gọi theo profile; khóa `lock` *(tùy chọn)*: PBKDF2-SHA256 hash + salt cho PIN khóa cổng AI Settings | `ai.js` | **Không bao giờ** | Không |
| `VenusAuthDB` | v1, store `kv` [`venus-account.js:21`] | Phiên đăng nhập Supabase (khóa `sb-venus-auth`) | `venus-account.js` | **Không bao giờ** | Là phiên của chính Supabase |

### 2.2 `venus-ai`: schema v2 (Zone A, chỉ trên thiết bị) [đã đọc code `ai.js`, 2026-11-28]

`settings` (`schemaVersion: 2`):

| Trường | Ý nghĩa |
| :--- | :--- |
| `activeProfileId` | Profile đang dùng; mọi `VenusAI.chat` không chỉ định profile đều dùng nó |
| `fallbackProfileIds[]` | Thứ tự các profile thử tiếp khi profile đang dùng hết lượt, sai key, mất mạng hoặc lỗi (không chứa profile đang dùng, tối đa 9) |
| `profiles[]` (tối đa 10) | `id`, `name`, `requestFormat` (`openrouter` \| `openai`), `baseUrl` (URL chat completions đầy đủ; nếu chỉ tới `/v1` thì app tự thêm `/chat/completions`), **`apiKey`** *(lưu cục bộ; trên UI hiển thị write-only dạng che `maskKey`, không đưa key thật vào DOM)*, `model`, `fallbackModels` (≤ 3, cùng profile), `thinkingEffort` (`default` \| `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`), `dailyLimit` (0 = không hiện giới hạn), `denyTraining` (chỉ có tác dụng với format `openrouter`), `temperature`, `maxTokens` (0 = không gửi), `replyLang`, `maxChars`, `customPrompt` (rỗng = hướng dẫn mặc định) |

- `temperature` và `max_tokens` chỉ được gửi khi `thinkingEffort` là `default` hoặc `off`.
- `usage`: `{ day (UTC), profiles: { <profileId>: { n, by: { <model>: số lượt } } } }`. Sang ngày UTC mới thì làm lại từ đầu; xóa profile thì xóa luôn bộ đếm của nó. Mọi lượt gọi (kể cả model/profile dự phòng) được đếm vào profile đã nhận request.
- `lock` *(tùy chọn, khi người dùng bật PIN trong mục Security của AI Settings)*: `{ v: 1, iter: 150000, salt (16-byte base64), hash (PBKDF2-SHA256 256-bit base64) }`. Chỉ làm cổng chặn giao diện (UI gate) trước khi mở cửa sổ AI Settings (khóa tạm 30 giây sau 5 lần nhập sai), **không** lưu PIN gốc và **không** mã hóa `apiKey` trong IndexedDB.
- **Migrate tự động** (lần đầu đọc `settings` còn schema cũ, tức không có `schemaVersion: 2`): cấu hình chính → profile `prof_1` (đang dùng); mỗi mục `backups[]` có `model` hoặc `apiKey` → `prof_2`, `prof_3` (kế thừa giới hạn, ngôn ngữ, prompt… của cấu hình chính) và vào `fallbackProfileIds`; `usage` cũ của **ngày UTC hôm nay** → `prof_1`, của ngày cũ thì bỏ. Hướng dẫn riêng khác văn bản mặc định → `customPrompt`; bằng văn bản mặc định → rỗng. Máy mới chưa có gì thì chỉ giữ trong bộ nhớ, chưa ghi IndexedDB cho tới khi bạn bấm Lưu.
- `VenusAI.getSettings()` vẫn trả các trường phẳng của profile đang dùng (`provider` được suy ra từ `baseUrl`, `instructions` = `customPrompt` hoặc mặc định) kèm `profiles`, `activeProfileId`, `fallbackProfileIds`, nên `vault.js` và `venus-review.js` không cần sửa.
- Không có trường nào của `venus-ai` đi vào `localStorage`, backup hoặc đồng bộ.

### 2.3 `localStorage` (dữ liệu Tracker, không phải VPIS)

Khoảng 15+ khóa [theo CLAUDE.md §3]: `studyHours`, `dailyStudyData`, `dailyStudyBreakdown`, `goals`, `courses`, `deadlines`, `calEvents`, `sleepSessions`, `wellnessTrackerData_v1`, `englishDaily_v1`, `brainDumpNotes`, `readingList`, `resourceLibrary`, `investmentAnalyses`, `dealDiary`, `focusSessionLogs`, `sessionLogs`, `gamification`…

- Mọi khóa trên **vào backup**, trừ `FULLBACKUP_EXCLUDE_KEYS = ['lastFullBackupAt','autoBackup','backupHistory']` và khóa có tiền tố `sb-` (`index.html:81060–81061`).
- `sleepSessions` đã được xác nhận có dữ liệu trên máy laptop của bạn (kiểm tra ngày 2026-11-27), còn `studyHours` đang là `{}` và `dailyStudyBreakdown` chưa tồn tại: chưa có log học.
- **Không đưa dữ liệu VPIS mới vào `localStorage`.** Dung lượng: `checkLocalStorageQuota()` (`index.html:42873`) chỉ **ước tính** theo giả định 5 MiB. Hãy dùng `navigator.storage.estimate()` hoặc tool `get_storage_health` để có số thực tế.
- Hai nguồn dữ liệu khác mà tool đọc qua **biến global của trang** (không qua `localStorage`): `skillsData`, `SLEEP_DEBT_CFG`, `Wellness`, hàm `computeSleepDebt`, `getSortedSleepSessions`… (xem mục 3 và rủi ro trong `ARCHITECTURE_AUDIT.md`).

## 3. Tool Registry (`venus-tools.js`)

Mọi truy cập của AI vào dữ liệu app phải đi qua đây. Cấp quyền: `L0_READ` chạy ngay · `L1_DRAFT` đánh dấu `draft:true` · `L2_WRITE_APPROVAL` cần `approvedByUser === true` **và** `expected_revision` · `L3_DESTRUCTIVE` luôn bị từ chối.

| Tool | Cấp | Đọc từ | Ghi |
| :--- | :--- | :--- | :--- |
| `get_study_summary` | L0 | biến global `studyHours`, `dailyStudyBreakdown`, `skillsData`, `gamification` | — |
| `get_sleep_wellness_summary` | L0 | `getSortedSleepSessions`/`computeSleepDebt`/`SLEEP_DEBT_CFG`, `Wellness`, `localStorage['wellnessTrackerData_v1']`, `VenusAIHub.sleepText` | — |
| `get_goals_and_deadlines` | L0 | `goals` (mảng sống) rồi `localStorage` làm dự phòng, `skillsData` | — |
| `search_vault_notes` | L0 | IndexedDB `FinanceTrackerVaultDB` (chỉ đọc) | — |
| `get_storage_health` | L0 | `localStorage` (kích thước theo khóa), `navigator.storage` | — |
| `get_memory_context` | L0 | `VenusMemoryDB` (mục `approved`) | — |
| `save_memory_item` | **L2** | — | `VenusMemoryDB` (profile hoặc decision), có `audit_logs` |

- Giới hạn: `get_study_summary`/`get_sleep_wellness_summary` từ chối khoảng thời gian dài hơn **400 ngày** (`range_too_long`).
- Registry **không ghi** `localStorage`/IndexedDB/Vault và không có kho riêng (`venus-tools.js:7`). Mọi lần thử L2, kể cả bị từ chối, đều được báo vào audit sink.
- Chỉ có **một** công cụ ghi (`save_memory_item`), nên AI không thể sửa Goals, Deadlines, Vault hay Profile ngoài luồng này.

## 4. Bản ghi trong `VenusMemoryDB`

### 4.1 Trường chung (sync-ready)

`id` (UUID), `device_id`, `revision`, `updated_at`, `created_at`, `deleted_at`, `schema_version`.

### 4.2 `profile` — hồ sơ ổn định

`key` (≤ 60 ký tự, duy nhất giữa các mục còn sống), `category` ∈ {`career`, `work_rules`, `learning_style`, `constraints`, `other`}, `content` (≤ 4000), `tags` (≤ 12 thẻ, mỗi thẻ ≤ 40, viết thường), `last_verified_at`.

### 4.3 `decisions` — quyết định, bài học, review

`type` ∈ {`decision`, `lesson`, `milestone`, `procedure`, `review_summary`}, `status` ∈ {`proposed`, `approved`, `superseded`}, `title` (≤ 200), `content` (≤ 4000), `rationale` (≤ 2000), `source` (≤ 100), `confidence`, `tags`.

- Review tháng lưu thành `type: review_summary`, `status: proposed`, `source: 'venus-review <YYYY-MM>'` (thêm `partial` cho bản "đến hôm nay"), tag `['review', '<YYYY-MM>']` (+ `'partial'`).
- Mục `approved` quá 90 ngày chưa xác nhận bị đánh dấu "cũ" (`getStaleMemories(90)`); Memory modal nhắc "Still correct".

### 4.4 Các store phụ (không đồng bộ, không backup)

| Store | Nội dung |
| :--- | :--- |
| `outbox` | Hàng đợi thao tác chờ gửi (`SYNC_PROTOCOL.md` §6) |
| `syncMeta` | Chỉ các khóa trong danh sách: `sync_enabled`, `sync_initialized`, `last_sync_cursor`, `last_sync_at`, `last_sync_error`, cộng `conflicts` và `device_id` do chính module quản lý. Ghi qua `setSyncMeta` chỉ chấp nhận `sync_enabled`, `sync_initialized`, `last_sync_at`, `last_sync_error` (`venus-memory.js:449–450`) |
| `audit_logs` | Nhật ký thao tác L2 và sync; giữ tối đa 2.000 dòng, dọn khi đạt 2.200 (`venus-memory.js:21`) |

## 5. Schema Supabase (`supabase/migrations/`)

| Bảng | Khóa chính | Ghi chú |
| :--- | :--- | :--- |
| `user_profile` | `(user_id, id)` | `payload jsonb` ≤ 64 KiB, `revision ≥ 1`, xóa mềm |
| `decisions` | `(user_id, id)` | Như trên |
| `sync_changes` | `seq` (identity), `unique (user_id, op_id)` | Nhật ký append-only; `entity_type ∈ {profile, decision}` |
| `user_devices` | `(user_id, device_id)` | `label ≤ 80`, `platform ≤ 120` (user-agent), `last_seen_at`, `last_sync_at` |

RLS bật trên mọi bảng (`auth.uid() = user_id`). Client **không** `insert/update` trực tiếp vào `user_profile`, `decisions`, `sync_changes`; chỉ qua RPC `vpis_push`. Edge Function `health` (`index.ts`) kiểm tra token và đọc `user_devices` bằng chính token của người dùng; không dùng secret key.

## 6. Backup và Restore

- `BACKUP_SCHEMA_VERSION = 4` (`index.html:81062`): 3.x = `localStorage` + `notesVault`; **4 thêm `venusMemory` (profile + decisions)**.
- `exportProgress()` (`index.html:81157`) gồm: `localStorage` (trừ khóa loại trừ) + Notes Vault + `venusMemory`. Nếu xuất `venusMemory` quá 5 giây hoặc lỗi, backup **vẫn tạo** nhưng cảnh báo "KHÔNG gồm bộ nhớ Venus" (`index.html:81102–81123, 81175`).
- **Không bao giờ có trong backup:** API key & PIN hash (`venus-ai`), token/phiên (`VenusAuthDB`, khóa `sb-`), `outbox`, `audit_logs`, `device_id`, cursor đồng bộ.
- `importProgress()` (`index.html:81192`): từ chối file có `backupSchemaVersion` mới hơn app hiểu (`index.html:81205`); khôi phục bộ nhớ qua `VenusMemory.importAll(data, { mode })` với `mode` `merge` hoặc `replace` (`venus-memory.js:343`), tối đa 5.000 bản ghi. **Restore cục bộ không ghi đè cloud**; thay đổi sẽ đồng bộ như một lần ghi bình thường nếu sync đang bật.

## 7. Cái gì rời khỏi máy?

| Đích | Dữ liệu | Khi nào | Người dùng kiểm soát bằng |
| :--- | :--- | :--- | :--- |
| **Supabase** (Zone B) | `payload` của profile/decisions (**văn bản thường**, không mã hóa đầu-cuối); `device_id`, nhãn thiết bị, user-agent | Chỉ khi bật đồng bộ | Công tắc đồng bộ (mặc định tắt) |
| **Supabase Auth** | Email, phiên đăng nhập | Khi đăng nhập | — |
| **Nhà cung cấp AI** (OpenRouter/Gemini/Groq/Ollama, tùy profile) | Gói số liệu Review tháng: số liệu đã tính, mục tiêu/deadline (tên, %, ngày còn lại), tối đa 10 mục hồ sơ và 8 quyết định đã duyệt, mỗi mục rút gọn ≤ 160 ký tự; tổng ≤ 8.000 ký tự (`LIM` trong `venus-review.js`) | Chỉ khi bạn bấm "Gửi cho AI" | Bạn **xem nguyên văn gói và nơi nhận** trước khi gửi; có thể bỏ phần bộ nhớ |
| **Không đi đâu** | Notes Vault, API key, PIN hash, log ngủ/học thô, token | — | — |

- Nội dung do AI trả về coi là dữ liệu không đáng tin: hiển thị bằng `textContent`; khi render Markdown thì qua DOMPurify chặn `img`, `svg`, `iframe`. Nội dung gửi cho AI được bọc trong `<context>` như dữ liệu, không phải chỉ thị.
- **Lưu ý riêng tư:** nếu nhà cung cấp AI là dịch vụ ngoài, những gì có trong gói (kể cả đoạn trích hồ sơ) rời máy bạn. Dùng Ollama chạy trên máy nếu cần giữ hoàn toàn cục bộ.
- **Fallback profile:** khi profile đang dùng lỗi, **cùng một prompt** có thể được gửi tới nhà cung cấp của profile dự phòng tiếp theo. Chỉ đưa vào danh sách dự phòng những nhà bạn chấp nhận gửi dữ liệu tới (xem F11 trong `ARCHITECTURE_AUDIT.md`).

## 8. Quy tắc khi thêm dữ liệu mới

1. Quyết định vùng (A/B/C) **trước** khi viết code.
2. Không tạo bản sao thứ hai của Goals/Skills/Deadlines/Vault; đọc qua `venus-tools.js` (nguồn sự thật duy nhất).
3. Không thêm khóa `localStorage` mới cho dữ liệu VPIS; dùng IndexedDB riêng nếu cần lưu.
4. Mọi bản ghi mới đồng bộ được phải có đủ metadata sync-ready (mục 4.1).
5. Nếu dữ liệu mới cần vào backup: nối vào `buildFullBackupObject` và tăng `BACKUP_SCHEMA_VERSION`; kiểm tra không lộ API key/token.
6. Cập nhật tài liệu này và `ARCHITECTURE_AUDIT.md`.
