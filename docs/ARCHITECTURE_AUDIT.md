# ARCHITECTURE_AUDIT — Venus Hub (VPIS), trạng thái sau Phase 4

> Ảnh chụp kiến trúc thực tế, cộng danh sách phát hiện cần xử lý. Cập nhật khi trách nhiệm hoặc phụ thuộc giữa các module đổi (`CLAUDE.md` §5.4).
> Ngày audit: 2026-11-27. Số dòng tính trên bản tải lên cùng ngày và có thể lệch sau khi sửa.

## 0. Phạm vi và giới hạn của audit

**Đọc toàn bộ hoặc gần toàn bộ:** `venus-sync.js`, `001–003_*.sql`, `index.ts` (Edge Function `health`), `sw.js`, `pwa.js`, `manifest.json`, `venus-review.js`, phần CSS của `venus-memory-ui.js`/`venus-account.js`, `vpis_implementation_plan.md`, `CLAUDE.md`.

**Đọc có chọn lọc (tìm theo từ khóa và đọc các đoạn liên quan):** `venus-memory.js` (API sync, outbox, `applyRemote`, xung đột, export/import), `venus-tools.js` (registry, các tool, nguồn dữ liệu), `venus-account.js` (cấu hình, kiểm tra khóa, thiết bị), `ai.js` (phần đầu, kho `venus-ai`, DOMPurify), `ai-hub.js` (cách nạp `ai.js`), `index.html` (thẻ script, dây nối backup/restore, hàm kiểm tra dung lượng), `tracker.css` và `vault.css` (thanh cuộn, token theme).

**Chưa đọc hoặc chỉ xác minh điểm tích hợp:** `vault.js` (18.000+ dòng; chỉ kiểm `DB_NAME`, `getBackupParts`, `window.NotesVault`), `vault-cm.js` (chưa đọc), toàn bộ logic Tracker trong `index.html`.

**Chưa audit (không có trong bản tải lên):** `launcher.html`, `today.html`, `prompts.html`, `insights.html`, thư mục `icons/`.

`vault_1.js` giống hệt `vault.js` (đã so sánh bằng `cmp`), có thể là bản sao thừa.

## 1. Kiến trúc tổng thể

```
┌───────────────────────── Trình duyệt (Laptop / iPhone PWA) ─────────────────────────┐
│ index.html (monolith) ── Tracker, Planner, Deadlines, Courses, Sleep, Wellness …    │
│    │  biến/hàm global: studyHours, goals, skillsData, computeSleepDebt, Wellness …  │
│    ▼ (chỉ đọc, qua safe())                                                          │
│ venus-tools.js  ── Tool Registry L0–L3 ◄── ai-hub.js (phân tích deterministic)      │
│    ▲                                                                                │
│ venus-memory.js ── VenusMemoryDB (profile, decisions, outbox, syncMeta, audit)      │
│    ▲        ▲                    ▲                                                  │
│ venus-memory-ui.js   venus-review.js          venus-sync.js ◄─ venus-account.js     │
│ (modal Bộ nhớ)       (Review tháng + banner)  (engine sync)     (Supabase Auth)     │
│                          │ gọi                                                      │
│                          ▼                                                          │
│ ai.js (VenusAI, nạp theo yêu cầu) ──► nhà cung cấp AI (OpenRouter/Gemini/Groq/Ollama)│
│ vault.js (Notes Vault, IndexedDB riêng, BM25) · pwa.js + sw.js (offline)            │
└────────────────────────────────────────┬────────────────────────────────────────────┘
                                         │ chỉ khi bật sync / đăng nhập
                                         ▼
                      Supabase: Auth · Postgres + RLS · RPC vpis_push · Edge Function health
```

**Nguyên tắc bất di bất dịch:** Cloud không bao giờ là điều kiện để app chạy. Offline hoặc Supabase lỗi thì Notes Vault, Tracker, tính toán deterministic và Local AI vẫn chạy; thay đổi đồng bộ xếp hàng trong `outbox`.

## 2. Bản đồ module

| Tệp | Vai trò | Xuất ra `window` | Phụ thuộc lúc chạy | Lưu trữ |
| :--- | :--- | :--- | :--- | :--- |
| `venus-tools.js` | Registry công cụ + kiểm tra quyền L0–L3 | `VenusTools` | Biến/hàm global của `index.html` (đọc qua `safe()`), `ai-hub.js` (`sleepText`), IndexedDB Vault (chỉ đọc) | Không |
| `venus-memory.js` | `VenusMemoryDB` + API sync, **không có mã mạng** | `VenusMemory` | `VenusTools` (đăng ký `get_memory_context`, `save_memory_item`) | IndexedDB `VenusMemoryDB` |
| `venus-memory-ui.js` | Modal "Bộ nhớ Venus" (Alt+M, nút 🧠) | `VenusMemoryUI` | `VenusMemory`, `VenusReview`, `VenusAccount` (tùy chọn) | CSS chèn từ JS, tiền tố `vpis-` |
| `venus-account.js` | Đăng nhập Email + Mật khẩu, thiết bị, kiểm tra `health` | `VenusAccount` | `supabase-js@2.119.0` (CDN, nạp lười), `VenusMemory.getDeviceId()` | IndexedDB `VenusAuthDB` |
| `venus-sync.js` | Engine đồng bộ + khối "Đồng bộ bộ nhớ" | `VenusSync` | `VenusMemory`, `VenusAccount` | `syncMeta` trong `VenusMemoryDB` |
| `venus-review.js` | Review tháng + banner nhắc ngày 1–5 | `VenusReview` | `VenusTools`, `VenusMemory`, `ai.js` (nạp theo yêu cầu) | Không (chỉ ghi khi bạn bấm lưu) |
| `ai.js` | Lõi AI OpenAI-compatible, SSE, fallback model, DOMPurify | `VenusAI` | DOMPurify, marked | IndexedDB `venus-ai` |
| `ai-hub.js` | Tầng phân tích deterministic cho Sleep/Skills | `VenusAIHub` | Biến global của Tracker; nạp `ai.js` khi cần | Không |
| `vault.js` / `vault-cm.js` / `vault.css` | Notes Vault | `NotesVault` | IndexedDB `FinanceTrackerVaultDB` | Có |
| `pwa.js` / `sw.js` / `manifest.json` | PWA, offline | — | — | Cache Storage |

### 2.1 Thứ tự nạp (`index.html:92598–92604`, cuối `<body>`)

`ai-hub.js` → `venus-tools.js` → `venus-memory.js` → `venus-memory-ui.js` → `venus-account.js` → `venus-sync.js` → `venus-review.js`

- Thứ tự quan trọng: `venus-memory.js` phải sau `venus-tools.js` (đăng ký tool); `venus-sync.js` phải sau `venus-account.js`; `venus-review.js` ở cuối vì Memory UI kiểm tra `window.VenusReview` khi dựng nút.
- **Nạp theo yêu cầu (không có thẻ `<script>` trong `index.html`):** `ai.js` (bởi `ai-hub.js:19` hoặc `vault.js`), `vault.js`/`vault-cm.js`/`vault.css` (bộ nạp ở `index.html:155–156`), `supabase-js` (bởi `venus-account.js:128`).
- Tệp `pwa.js` **không** được nạp bằng thẻ `<script>` trong `index.html` (tìm không thấy); nó nằm trong `CORE` của `sw.js`. Chưa xác minh trang nào nạp nó (khả năng cao là `launcher.html`, chưa audit).

## 3. Service Worker (`sw.js`)

- `CACHE_VERSION = 'v3'` (`sw.js:8`). `CORE` (`sw.js:12`) gồm tất cả tệp VPIS: `venus-tools`, `venus-memory`, `venus-memory-ui`, `venus-account`, `venus-sync`, `venus-review`, `ai.js`, `ai-hub.js`.
- Tệp cùng origin: **network-first**, quá 6 giây hoặc mất mạng thì dùng bản đã cache; điều hướng offline rơi về `launcher.html`.
- CDN (FontAwesome, marked, DOMPurify, pdf.js, SheetJS, Mermaid, supabase-js…): cache lần đầu, phiên bản ghim thì không tải lại.
- `supabase-js@2.119.0` phải khớp giữa `venus-account.js:19` và `CDN_PRECACHE` trong `sw.js`. **Hiện đang khớp.** Đây là điểm đồng bộ thủ công (xem F5).
- Không dùng Background Sync/Periodic Sync (iOS). Đồng bộ dựa trên mở app, foreground, online.

## 4. Backup và Restore

Xem chi tiết ở `DATA_CATALOG.md` §6. Điểm nối: `buildFullBackupObject` → `NotesVault.getBackupParts()` (`index.html:81095`) và `VenusMemory.exportAll()` có timeout 5 giây (`index.html:81105`); khôi phục qua `VenusMemory.importAll()` (`index.html:81330`). `BACKUP_SCHEMA_VERSION = 4` (`index.html:81062`).

## 5. Tư thế bảo mật

| Hạng mục | Hiện trạng |
| :--- | :--- |
| Khóa Supabase ở frontend | Chỉ **publishable** (`venus-account.js:18`). Module từ chối chạy nếu là `sb_secret_…` hoặc JWT `role: service_role` (`:28–41`) |
| Quyền ghi server | Chỉ RPC `vpis_push`; `insert/update` trực tiếp bị thu hồi; không có `DELETE` |
| RLS | Bật trên mọi bảng, `auth.uid() = user_id` |
| Edge Function `health` | Xác thực token bằng Supabase Auth; không dùng secret/service key; CORS `*` an toàn vì dùng bearer token, không cookie |
| API key AI | IndexedDB `venus-ai`, không vào `localStorage`/backup/sync |
| Token | `VenusAuthDB`; backup loại trừ tiền tố `sb-` |
| XSS | `textContent` cho chuỗi từ server/AI/bộ nhớ; DOMPurify (chặn `img`, `svg`, `iframe`…) khi render Markdown |
| Prompt injection | Nội dung gửi AI bọc trong `<context>` như dữ liệu; AI trong Phase 4 **không gọi tool và không ghi**; mọi ghi cần bạn bấm (`approvedByUser`) |
| Quyền công cụ | Một tool ghi duy nhất (`save_memory_item`, L2); L3 luôn khóa |

## 6. Phát hiện

Mức độ: **Cao** = hỏng chức năng hoặc rủi ro dữ liệu · **Trung** = dễ hỏng âm thầm hoặc lệch quy trình · **Thấp** = dọn dẹp.

| # | Mức | Phát hiện | Trạng thái |
| :--- | :--- | :--- | :--- |
| F1 | Cao | **Review tháng không tự nạp `ai.js`.** `window.VenusAI` chỉ có sau khi một nút AI khác nạp nó (`ai-hub.js`/`vault.js`). Nếu bạn mở Review trước, nút "Gửi cho AI" báo "Chưa tải ai.js". | **Đã sửa** trong `venus-review.js`: `aiInfo()` giờ tự nạp `./ai.js` (như `ai-hub.js:16–21`), timeout 10 giây, báo lỗi rõ nếu thất bại. Có 4 test |
| F2 | Trung | **Tool đọc dữ liệu Tracker qua biến global trần** (`studyHours`, `dailyStudyBreakdown`, `skillsData`, `goals`, `gamification`, `Wellness`, `SLEEP_DEBT_CFG`; `venus-tools.js:162–173, 197, 235, 288`) bọc trong `safe()`. Nếu `index.html` đổi tên hoặc chuyển chúng khỏi phạm vi script, tool **âm thầm trả số 0**, giống hệt "chưa log". | **Đã sửa (2026-11-28)** theo mục 7.2: mỗi tool trả `missing_sources`, Review hiện "Không đọc được" thay vì "0", có tool `get_data_sources_status` và `tests/check-index-globals.js`. Đã xác minh bằng AST: cả 16 tên hiện đều khai báo ở cấp script trong `index.html`, nên bản hiện tại không có lỗi đấu nối |
| F3 | Trung | **`CLAUDE.md` yêu cầu bump `CACHE_VERSION` khi thêm tệp, nhưng `sw.js` (chú thích đầu tệp) nói chỉ bump khi muốn xóa sạch cache.** Về kỹ thuật, sửa `sw.js` (thêm vào `CORE`) làm đổi byte nên trình duyệt cài lại SW và tải lại `CORE`; bump không bắt buộc. Tệp cùng origin lại là network-first. | **Đã sửa (2026-11-28):** `CLAUDE.md` (bảng tệp, dòng `pwa.js`/`sw.js`) nay nói: thêm tệp vào `CORE`, chỉ bump `CACHE_VERSION` khi muốn xóa sạch cache |
| F4 | Trung | **Lớp "vá hàm lúc chạy" trong `index.html`.** Console in `Patched: calculateGoalDifficulty…`, `All functions patched successfully` (`index.html:74601–74702`). Tool và `ai-hub.js` gọi chính các hàm này; thứ tự vá có thể đổi kết quả. | Mở. Chưa đọc đoạn này. Nên đọc trước khi thêm tool mới dựa vào hàm tính toán |
| F5 | Trung | **Phiên bản `supabase-js` nằm ở hai nơi** (`venus-account.js:19` và `sw.js` `CDN_PRECACHE`), đồng bộ thủ công. Lệch thì không lỗi ngay nhưng mất offline. | Mở. Có thể thêm một dòng nhắc trong cả hai tệp (đã có) hoặc kiểm tra tự động |
| F6 | Thấp | **Cảnh báo console:** `apple-mobile-web-app-capable` đã lỗi thời, Chrome khuyên thêm `mobile-web-app-capable`. Thẻ do `pwa.js:14` chèn. | **Đã sửa (2026-11-28):** `pwa.js` thêm `mobile-web-app-capable`, vẫn **giữ** thẻ `apple-…` cho iOS. Sau khi sửa, Console không còn cảnh báo này |
| F7 | Thấp | `tracker.css:5151` có `font-size: 16px; =` (dấu `=` thừa). Sau nó chỉ còn dấu `}` nên `font-size: 16px` vẫn áp dụng; **vô hại**. | Mở, dọn khi tiện |
| F8 | Thấp | `vault_1.js` giống hệt `vault.js`. | **Đóng:** không có trong repo GitHub, chỉ là bản tải trùng lên chat |
| F9 | Thấp | Mỗi module VPIS tự chèn CSS (4 thẻ `<style>` có tiền tố riêng). Quy ước thanh cuộn/animation phải lặp lại ở từng module. | Chấp nhận (đúng quy tắc tiền tố). Cân nhắc một tệp CSS dùng chung khi có module thứ 5 |
| F10 | Thấp | `index.html` rất lớn (92.605 dòng). Quy tắc #1 đã hạn chế thay đổi; mọi thêm mới ở đây nên chỉ là thẻ `<script>`. | Theo dõi |

Phát hiện về đồng bộ (không có khóa duy nhất cho `key` ở server, `sync_changes` không dọn, không có backoff…) nằm ở `SYNC_PROTOCOL.md` §12.

## 7. Đề xuất

### 7.1 Việc nhỏ, rủi ro thấp
1. `pwa.js`: thêm thẻ `mobile-web-app-capable` (F6).
2. `CLAUDE.md`: sửa quy tắc về `CACHE_VERSION` cho khớp với `sw.js` (F3).
3. Xóa `vault_1.js` nếu thừa (F8) và dòng `=` thừa ở `tracker.css:5151` (F7).

### 7.2 Chống "số 0 giả" (F2) — **đã làm**
- `venus-tools.js`: `probeVar()` phân biệt biến **vắng mặt** (đọc ra `ReferenceError`) với biến **rỗng**. `get_study_summary`, `get_sleep_wellness_summary`, `get_goals_and_deadlines` trả thêm `missing_sources[]` (`[]` = đọc được hết). Tool mới `get_data_sources_status` (L0) báo theo nhóm `study` / `sleep` / `goals`. Danh sách nguồn mỗi nhóm nằm ở `SOURCE_NEEDS`.
- `venus-review.js`: mỗi nguồn thiếu thành một mục `unavailable` dạng `study:missing_<tên>` (có trong gói gửi AI và dòng "Không đọc được" của bản tóm tắt). Gói trống mà thiếu nguồn học/ngủ thì hiện cảnh báo lỗi đấu nối, không gọi AI và không hiện banner nhắc (`checkReminder` trả `sources_unavailable`). Quy tắc (8) trong system prompt cấm AI coi nguồn không đọc được là 0.
- Chỉ nguồn **học và ngủ** (gồm Wellness) làm gói bị coi là "degraded"; thiếu `goals`/`skillsData` chỉ ghi vào `unavailable` vì không làm số liệu học/ngủ sai.
- Khi đổi tên hoặc chuyển một biến/hàm trong `index.html`: sửa `VAR_PROBES`/`SOURCE_NEEDS` trong `venus-tools.js`, và chạy `tests/check-index-globals.js`.
- Console: `VenusTools.run('get_data_sources_status', {}, {}).then(r => console.log(r.data))`

### 7.3 Kiểm thử
Đã lưu vào `tests/`:

| Tệp | Kiểm gì | Cách chạy |
| :--- | :--- | :--- |
| `tests/f2-sources.test.js` | 25 ca (jsdom, dùng `venus-tools.js` và `venus-review.js` thật): đổi tên biến thì bị báo, gói trống do lỗi đấu nối khác gói trống thật, thông báo trong giao diện, banner nhắc, hồi quy chế độ "đến hôm nay" | `npm i jsdom && node tests/f2-sources.test.js` |
| `tests/check-index-globals.js` | `index.html` thật còn khai báo đủ 16 tên ở cấp script (phân tích AST bằng `acorn`) | `npm i acorn && node tests/check-index-globals.js index.html` |

Còn thiếu: test CSS, test của banner trên trình duyệt thật, và bộ test SQL 28/28 của Phase 3A (nên lưu vào `supabase/tests/`).

## 8. Danh sách kiểm tra hồi quy (sau mỗi milestone)

Theo `CLAUDE.md` §5.4:

1. **Console 0 lỗi** khi mở app, cả online lẫn offline (cảnh báo F6 là cảnh báo đã biết, không phải lỗi).
2. Các tab cũ, dữ liệu `localStorage`, Notes Vault, chat AI streaming cũ hoạt động như trước.
3. Backup JSON xuất và nhập thành công; **tìm trong file** không có API key, `sb-…` hay token; `__meta.venusMemoryCount` khớp số mục.
4. Offline: tắt mạng, mở app, mở modal Bộ nhớ và sửa một mục; `VenusMemory.getSyncState().outbox_pending` tăng; bật mạng thì về 0.
5. iPhone (PWA màn hình chính): mở app, đăng nhập còn giữ, đồng bộ chạy khi mở lại app.
6. Review tháng: mở modal, chọn "tháng này đến hôm nay", "Chuẩn bị số liệu" cho số đêm ngủ đúng; "Gửi cho AI" bật khi đã cấu hình AI (kể cả khi chưa từng bấm nút AI khác trong phiên).
7. Tài liệu `docs/` được cập nhật nếu trách nhiệm hoặc phụ thuộc giữa module đổi.

**Lệnh Console hữu ích:**

```js
VenusMemory.getSyncState().then(console.log)                       // trạng thái đồng bộ, outbox, xung đột
VenusSync.status()                                                  // phase hiện tại
VenusTools.list().map(t => t.name + ' ' + t.level)                  // các tool đã đăng ký
VenusReview.checkReminder().then(console.log)                       // banner nhắc: shown / why
```
