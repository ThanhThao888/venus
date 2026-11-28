# ARCHITECTURE_AUDIT — Venus Hub (VPIS), trạng thái sau Phase 4

> Ảnh chụp kiến trúc thực tế, cộng danh sách phát hiện cần xử lý. Cập nhật khi trách nhiệm hoặc phụ thuộc giữa các module đổi (`CLAUDE.md` §5.4).
> Ngày audit: 2026-11-27. Số dòng tính trên bản tải lên cùng ngày và có thể lệch sau khi sửa.
> **Cập nhật 2026-11-28:** `ai.js` nâng lên **Multi-Profile AI Settings** (schema `venus-ai` v2, bộ đếm riêng theo profile, thinking effort, request format), bổ sung **PIN lock** (UI gate, PBKDF2-SHA256 trong khóa `lock`) và ô API key **write-only** (`maskKey`, bỏ nút Show, không đưa key thật ra DOM). `venus-memory-ui.js`, `venus-account.js`, `venus-sync.js` và cửa sổ AI Settings (`ai.js`) đã chuyển sang giao diện tiếng Anh; nút mở AI Settings trong Memory modal đổi thành icon ẩn mờ (`.vpis-ghost`). Số dòng của `ai.js` trong tài liệu này đã cũ.
> **Cập nhật 2026-11-29:** F15 đã sửa (nút `Sign out other devices`). **Cập nhật 2026-11-28 (đợt 2):** thêm migration `004_user_devices_delete.sql` và nút `Remove` trong `Your devices` (`venus-account.js`); ghi nhận tìm kiếm lai Notes Vault (BM25 + vector Gemini, `vec:*` trong `venus-ai`); đóng F2 và F6 (đã sửa trong code, trước đó còn ghi "Mở"); thêm F13–F16 và mục 7.4.

## 0. Phạm vi và giới hạn của audit

**Đọc toàn bộ hoặc gần toàn bộ:** `ai.js` (đọc đủ khi nâng cấp 2026-11-28), `venus-sync.js`, `001–003_*.sql`, `index.ts` (Edge Function `health`), `sw.js`, `pwa.js`, `manifest.json`, `venus-review.js`, phần CSS của `venus-memory-ui.js`/`venus-account.js`, `vpis_implementation_plan.md`, `CLAUDE.md`.

**Đọc có chọn lọc (tìm theo từ khóa và đọc các đoạn liên quan):** `venus-memory.js` (API sync, outbox, `applyRemote`, xung đột, export/import), `venus-tools.js` (registry, các tool, nguồn dữ liệu), `venus-account.js` (cấu hình, kiểm tra khóa, thiết bị), `ai-hub.js` (cách nạp `ai.js`), `index.html` (thẻ script, dây nối backup/restore, hàm kiểm tra dung lượng), `tracker.css` và `vault.css` (thanh cuộn, token theme).

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
| `venus-memory-ui.js` | Modal "Venus Memory" (Alt+M, nút 🧠, giao diện tiếng Anh); header có nút `Monthly review`, `Account`, và nút mở AI Settings dạng icon ẩn mờ (`#vpisAiBtn`, `.vpis-ghost`, không label/tooltip) | `VenusMemoryUI` | `VenusMemory`, `VenusReview`, `VenusAccount` (tùy chọn), `ai.js` (nút `#vpisAiBtn` nạp `./ai.js` theo yêu cầu, timeout 10 giây) | CSS chèn từ JS, tiền tố `vpis-` |
| `venus-account.js` | Đăng nhập Email + Mật khẩu, danh sách thiết bị, gỡ **thiết bị khác** (`Remove`) và `Sign out other devices` (đều hai lần bấm), kiểm tra `health` (giao diện tiếng Anh) | `VenusAccount` | `supabase-js@2.119.0` (CDN, nạp lười), `VenusMemory.getDeviceId()` | IndexedDB `VenusAuthDB` |
| `venus-sync.js` | Engine đồng bộ + khối "Memory sync" (giao diện tiếng Anh) | `VenusSync` | `VenusMemory`, `VenusAccount` | `syncMeta` trong `VenusMemoryDB` |
| `venus-review.js` | Review tháng + banner nhắc ngày 1–5 | `VenusReview` | `VenusTools`, `VenusMemory`, `ai.js` (nạp theo yêu cầu) | Không (chỉ ghi khi bạn bấm lưu) |
| `ai.js` | Lõi AI OpenAI-compatible, **nhiều profile** (URL, request format `openrouter`/`openai`, key, model, thinking effort, bộ đếm riêng, prompt riêng), SSE, fallback model + fallback profile, DOMPurify. Cửa sổ AI Settings là `<dialog>` hai cột giao diện tiếng Anh, có **PIN lock** tùy chọn và ô API key **write-only** (`maskKey`, bỏ nút Show) | `VenusAI` | DOMPurify, marked | IndexedDB `venus-ai` (`settings` schema 2 + `usage` theo profile + `lock` PIN hash) |
| `ai-hub.js` | Tầng phân tích deterministic cho Sleep/Skills | `VenusAIHub` | Biến global của Tracker; nạp `ai.js` khi cần | Không |
| `vault.js` / `vault-cm.js` / `vault.css` | Notes Vault; tìm toàn vault bằng **tìm kiếm lai** (BM25 + vector Gemini + RRF), tự về BM25 khi không có key/offline/lỗi | `NotesVault` | IndexedDB `FinanceTrackerVaultDB`; `ai.js` (`VenusAI.vec*`); API Gemini Embedding (khi có key) | `FinanceTrackerVaultDB` (có backup); vector cache `vec:*` trong `venus-ai` (không backup) |
| `pwa.js` / `sw.js` / `manifest.json` | PWA, offline | — | — | Cache Storage |

### 2.1 Thứ tự nạp (`index.html:92598–92604`, cuối `<body>`)

`ai-hub.js` → `venus-tools.js` → `venus-memory.js` → `venus-memory-ui.js` → `venus-account.js` → `venus-sync.js` → `venus-review.js`

- Thứ tự quan trọng: `venus-memory.js` phải sau `venus-tools.js` (đăng ký tool); `venus-sync.js` phải sau `venus-account.js`; `venus-review.js` ở cuối vì Memory UI kiểm tra `window.VenusReview` khi dựng nút.
- **Nạp theo yêu cầu (không có thẻ `<script>` trong `index.html`):** `ai.js` (bởi `ai-hub.js:19`, `vault.js`, `venus-review.js` và nút `#vpisAiBtn` của `venus-memory-ui.js`), `vault.js`/`vault-cm.js`/`vault.css` (bộ nạp ở `index.html:155–156`), `supabase-js` (bởi `venus-account.js:128`).
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
| Quyền ghi server | Chỉ RPC `vpis_push`; `insert/update` trực tiếp vào `user_profile`/`decisions`/`sync_changes` bị thu hồi; `DELETE` chỉ có trên `user_devices` (`004`, policy `user_devices_delete_own`, chỉ dòng của mình). Các bảng khác chỉ xóa mềm |
| RLS | Bật trên mọi bảng, `auth.uid() = user_id` |
| Edge Function `health` | Xác thực token bằng Supabase Auth; không dùng secret/service key; CORS `*` an toàn vì dùng bearer token, không cookie |
| API key AI | IndexedDB `venus-ai` (mọi profile, kể cả `apiKey` của từng profile), không vào `localStorage`/backup/sync. Ô key dùng cơ chế **write-only** (`maskKey` dạng `sk-or-…a1b2`, chỉ đọc, bỏ nút Show, không đưa key thật vào DOM; chỉ giữ `Replace key` và `Clear key`). Cửa sổ AI Settings có thể khóa cổng bằng **PIN** (PBKDF2-SHA256 + salt ngẫu nhiên trong khóa `lock`, chỉ khóa giao diện, không mã hóa IndexedDB). Chuỗi người dùng/server vào form đều qua `esc()` |
| Token | `VenusAuthDB`; backup loại trừ tiền tố `sb-` |
| XSS | `textContent` cho chuỗi từ server/AI/bộ nhớ; DOMPurify (chặn `img`, `svg`, `iframe`…) khi render Markdown |
| Prompt injection | Nội dung gửi AI bọc trong `<context>` như dữ liệu; AI trong Phase 4 **không gọi tool và không ghi**; mọi ghi cần bạn bấm (`approvedByUser`) |
| Quyền công cụ | Một tool ghi duy nhất (`save_memory_item`, L2); L3 luôn khóa |
| Notes rời máy | Tìm kiếm ngữ nghĩa **mặc định TẮT** (`vec:optin`, từng thiết bị). Chỉ khi người dùng bật và có profile Gemini có key, tìm toàn vault mới gửi **nội dung note được index** (trừ `noai`, đã xóa, template) và câu hỏi tới Google Embedding API, kể cả khi chat bằng nhà khác hoặc Ollama (F13, đã sửa). Key gửi qua header `x-goog-api-key`, không nằm trên URL |

## 6. Phát hiện

Mức độ: **Cao** = hỏng chức năng hoặc rủi ro dữ liệu · **Trung** = dễ hỏng âm thầm hoặc lệch quy trình · **Thấp** = dọn dẹp.

| # | Mức | Phát hiện | Trạng thái |
| :--- | :--- | :--- | :--- |
| F1 | Cao | **Review tháng không tự nạp `ai.js`.** `window.VenusAI` chỉ có sau khi một nút AI khác nạp nó (`ai-hub.js`/`vault.js`). Nếu bạn mở Review trước, nút "Gửi cho AI" báo "Chưa tải ai.js". | **Đã sửa** trong `venus-review.js`: `aiInfo()` giờ tự nạp `./ai.js` (như `ai-hub.js:16–21`), timeout 10 giây, báo lỗi rõ nếu thất bại. Có 4 test |
| F2 | Trung | **Tool đọc dữ liệu Tracker qua biến global trần** (`studyHours`, `dailyStudyBreakdown`, `skillsData`, `goals`, `gamification`, `Wellness`, `SLEEP_DEBT_CFG`; `venus-tools.js:162–173, 197, 235, 288`) bọc trong `safe()`. Nếu `index.html` đổi tên hoặc chuyển chúng khỏi phạm vi script, tool **âm thầm trả số 0**, giống hệt "chưa log". | **Đã sửa** (xem 7.2): `probeVar`/`missingSources` trong `venus-tools.js`, trường `missing_sources` ở từng tool, tool `get_data_sources_status`; Review hiện "Không đọc được" thay vì số 0 |
| F3 | Trung | **`CLAUDE.md` yêu cầu bump `CACHE_VERSION` khi thêm tệp, nhưng `sw.js` (chú thích đầu tệp) nói chỉ bump khi muốn xóa sạch cache.** Về kỹ thuật, sửa `sw.js` (thêm vào `CORE`) làm đổi byte nên trình duyệt cài lại SW và tải lại `CORE`; bump không bắt buộc. Tệp cùng origin lại là network-first. | **Đã sửa** trong `CLAUDE.md` §2: chỉ bắt buộc thêm tệp mới vào `CORE` của `sw.js`; chỉ bump `CACHE_VERSION` khi cần xóa sạch cache |
| F4 | Trung | **Lớp "vá hàm lúc chạy" trong `index.html`.** Console in `Patched: calculateGoalDifficulty…`, `All functions patched successfully` (`index.html:74601–74702`). Tool và `ai-hub.js` gọi chính các hàm này; thứ tự vá có thể đổi kết quả. | Mở. Chưa đọc đoạn này. Nên đọc trước khi thêm tool mới dựa vào hàm tính toán |
| F5 | Trung | **Phiên bản `supabase-js` nằm ở hai nơi** (`venus-account.js:19` và `sw.js` `CDN_PRECACHE`), đồng bộ thủ công. Lệch thì không lỗi ngay nhưng mất offline. | Mở. Có thể thêm một dòng nhắc trong cả hai tệp (đã có) hoặc kiểm tra tự động |
| F6 | Thấp | **Cảnh báo console:** `apple-mobile-web-app-capable` đã lỗi thời, Chrome khuyên thêm `mobile-web-app-capable`. Thẻ do `pwa.js:14` chèn. | **Đã sửa:** `pwa.js:15` đã có `mobile-web-app-capable`, thẻ `apple-…` được giữ. Cách làm: thêm `ensure('meta[name="mobile-web-app-capable"]', …)` song song, **giữ** thẻ `apple-…` cho iOS |
| F7 | Thấp | `tracker.css:5151` có `font-size: 16px; =` (dấu `=` thừa). Sau nó chỉ còn dấu `}` nên `font-size: 16px` vẫn áp dụng; **vô hại**. | Mở, dọn khi tiện |
| F8 | Thấp | `vault_1.js` giống hệt `vault.js`. | Mở. Xóa nếu là bản sao thừa trong repo |
| F9 | Thấp | Mỗi module VPIS tự chèn CSS (4 thẻ `<style>` có tiền tố riêng). Quy ước thanh cuộn/animation phải lặp lại ở từng module. | Chấp nhận (đúng quy tắc tiền tố). Cân nhắc một tệp CSS dùng chung khi có module thứ 5 |
| F10 | Thấp | `index.html` rất lớn (92.605 dòng). Quy tắc #1 đã hạn chế thay đổi; mọi thêm mới ở đây nên chỉ là thẻ `<script>`. | Theo dõi |
| F11 | Trung | **Fallback sang profile khác gửi cùng prompt tới nhà cung cấp khác.** Nếu profile dự phòng là dịch vụ ngoài (nhất là gói free của Gemini) thì dữ liệu Review/Notes có thể rời máy tới nhà đó dù profile chính là Ollama hoặc đã bật `denyTraining`. `denyTraining` chỉ áp dụng cho profile có request format `openrouter`. | Mở. Chỉ đưa vào `fallbackProfileIds` những nhà bạn chấp nhận gửi dữ liệu tới; ghi chú nhạy cảm vẫn dùng tag `noai`. Cửa sổ AI Settings hiển thị thứ tự dự phòng |
| F12 | Thấp | **Tham số thinking chưa kiểm với API thật.** `ai.js` gửi `reasoning: {effort}` (OpenRouter) hoặc `reasoning_effort` (OpenAI-compatible); `off` gửi `none`; `xhigh`/`max` gửi nguyên văn. Một số nhà/model từ chối giá trị không hỗ trợ (HTTP 400). Test jsdom chỉ kiểm payload, không gọi mạng. | Mở. Dùng nút "Save & test" cho từng profile; nếu nhà nào từ chối `max`/`xhigh`, đổi mức hoặc báo để sửa ánh xạ |
| F13 | Cao | **Tìm kiếm lai gửi toàn bộ vault cho Google một cách ngầm định.** Chỉ cần có profile Gemini có key, lần tìm toàn vault đầu tiên sẽ lập chỉ mục và gửi tiêu đề, tag, tên mục và nội dung từng đoạn của mọi note không gắn `noai`. Việc này diễn ra kể cả khi chat bằng Ollama và không thu hẹp theo thư mục đang chọn. Không có công tắc riêng và không có xác nhận lần đầu. Ngược với nguyên tắc Zone A "không tự lên cloud". Free Tier của Google có thể dùng dữ liệu gửi đi để cải thiện sản phẩm; `denyTraining` không áp dụng. | **Đã sửa (2026-11-28):** công tắc `vec:optin` mặc định TẮT, bật phải qua màn xác nhận trong AI Settings; chặn hai lớp (`vqSemantic` trong `vault.js` và `embedTexts` trong `ai.js`); test `tests/semantic-optin/`. Người đã dùng bản cũ cần bật lại nếu muốn. Chưa làm: đếm số note trong màn xác nhận |
| F14 | Thấp | **Model embedding đã bị Google đánh dấu deprecated** (`gemini-embedding-001`); các nguồn lệch nhau về ngày tắt sớm nhất (14 hoặc 20/05/2028). Tham số `taskType`/`title`/`outputDimensionality` đặt trực tiếp cũng bị đánh dấu deprecated (nên chuyển sang `embedContentConfig`). Ngưỡng 0.48/0.72 chưa hiệu chỉnh trên dữ liệu thật. | Mở. `vec:meta` có `model`/`dim` nên đổi model sẽ tự dựng lại chỉ mục. Hiệu chỉnh ngưỡng bằng khoảng 15 câu hỏi thật (7.4 (4)) |
| F15 | Trung | **`Remove` chỉ gỡ dòng khỏi danh sách, không thu hồi phiên đăng nhập.** Điện thoại mất hoặc máy cũ vẫn còn đăng nhập sẽ tự ghi lại vào `user_devices` và vẫn đọc được dữ liệu sync. | **Đã sửa (2026-11-29):** nút `Sign out other devices` dùng `signOut({ scope: 'others' })`, hai lần bấm, có test (`tests/account-devices/`). Giới hạn: máy khác đang mở còn dùng được tới khi access token hết hạn (mặc định ~1 giờ); muốn rút ngắn, giảm JWT expiry trong Supabase Auth Settings. Cần Remove thêm nếu muốn dòng biến khỏi danh sách |
| F16 | Thấp | **`vpis_implementation_plan.md` đã cũ so với code:** còn ghi Email OTP/Magic Link (thực tế Email + Mật khẩu), `requestJSON()` trong `ai.js` (thực tế Review dùng `VenusAI.chat` + tự kiểm JSON), "bump cache version" (đã đổi, xem F3). | Mở. Thêm đầu tệp một dòng "tài liệu lịch sử; nguồn đúng là `CLAUDE.md` và `docs/`" hoặc cập nhật các điểm trên |

Phát hiện về đồng bộ (không có khóa duy nhất cho `key` ở server, `sync_changes` không dọn, không có backoff…) nằm ở `SYNC_PROTOCOL.md` §12.

## 7. Đề xuất

### 7.1 Việc nhỏ, rủi ro thấp
1. Xóa `vault_1.js` nếu thừa (F8) và dòng `=` thừa ở `tracker.css:5151` (F7).

### 7.2 Chống "số 0 giả" (F2) — **đã triển khai**
**Đã làm:** `probeVar`/`missingSources` (`venus-tools.js`), `missing_sources` trong kết quả từng tool, tool L0 `get_data_sources_status`, và `venus-review.js` ghi "Không đọc được" thay vì 0. Mô tả đề xuất gốc, giữ để tham khảo:

Thêm một **tự kiểm tra đấu nối** (chỉ đọc) vào `get_storage_health` hoặc một tool L0 mới: với mỗi nguồn mà tool cần (`studyHours`, `skillsData`, `goals`, `Wellness`, `getSortedSleepSessions`…), trả `present: true/false`. Khi nguồn **vắng mặt** (khác với **rỗng**), Review tháng nên hiện "không đọc được nguồn X" thay vì "0 giờ". Việc này phân biệt được "bạn chưa log" với "app đổi tên biến".

### 7.3 Kiểm thử
Các test jsdom cho `venus-review.js` (tháng đến hôm nay, banner, nạp `ai.js`) và kiểm tra cú pháp CSS chỉ chạy trong phiên làm việc, chưa nằm trong repo. `tests/ai.test.js` (migrate schema, payload theo format × thinking, bộ đếm theo profile, fallback giữa profile, UI AI Settings, PIN lock, write-only API key, nút `#vpisAiBtn`; cần `npm i jsdom fake-indexeddb`, chạy `node tests/ai.test.js`) được thêm cùng đợt nâng cấp `ai.js`. Nên lưu tất cả vào `tests/` cùng bộ test SQL 28/28 để chạy lại sau mỗi thay đổi.

Bộ test UI của nút `Remove` và `Sign out other devices` (Playwright, 92 kiểm tra: nút đúng thiết bị, hai lần bấm, khóa khi đang gửi, 5 loại lỗi API, mất mạng, hết phiên, ID máy không xác định, chặn xóa máy hiện tại, desktop + iPhone 13) nằm ở `tests/account-devices/` (`node tests/account-devices/test.js`, cần `playwright`). Test chạy trên Supabase giả lập, chưa phải database thật.

### 7.4 Việc nên làm tiếp (theo thứ tự)
1. ~~Công tắc cho tìm kiếm ngữ nghĩa (F13)~~ **đã làm** (mặc định TẮT, xác nhận khi bật). Có thể bổ sung sau: hiện số note sẽ gửi trong màn xác nhận.
2. ~~`Sign out other devices` (F15)~~ **đã làm** cạnh `Remove` trong `venus-account.js`.
3. **Lưu mọi test vào `tests/`** (jsdom cho `venus-review.js`, SQL 28/28, kiểm tra RAG 48/48, test `Remove`) và một lệnh chạy chung.
4. **Hiệu chỉnh ngưỡng 0.48/0.72 (F14)** bằng ~15 câu hỏi Việt–Anh thật kèm note mong đợi, ghi lại độ gần nghĩa.
5. **Phase 5 theo từng bước nhỏ:** bản tóm tắt "Today" thuần cục bộ (deadline sắp tới, quá hạn, bước kế tiếp) trước; chỉ sau đó mới đồng bộ Goals/Deadlines (cần tổng quát hóa `vpis_push`, xem `SYNC_PROTOCOL.md` §13); push thông báo để sau cùng.

## 8. Danh sách kiểm tra hồi quy (sau mỗi milestone)

Theo `CLAUDE.md` §5.4:

1. **Console 0 lỗi** khi mở app, cả online lẫn offline (cảnh báo F6 là cảnh báo đã biết, không phải lỗi).
2. Các tab cũ, dữ liệu `localStorage`, Notes Vault, chat AI streaming cũ hoạt động như trước.
3. Backup JSON xuất và nhập thành công; **tìm trong file** không có API key, `sb-…` hay token; `__meta.venusMemoryCount` khớp số mục.
4. Offline: tắt mạng, mở app, mở modal Venus Memory và sửa một mục; `VenusMemory.getSyncState().outbox_pending` tăng; bật mạng thì về 0.
5. iPhone (PWA màn hình chính): mở app, đăng nhập còn giữ, đồng bộ chạy khi mở lại app.
6. Review tháng: mở modal, chọn "tháng này đến hôm nay", "Chuẩn bị số liệu" cho số đêm ngủ đúng; "Gửi cho AI" bật khi đã cấu hình AI (kể cả khi chưa từng bấm nút AI khác trong phiên).
7. Tài liệu `docs/` được cập nhật nếu trách nhiệm hoặc phụ thuộc giữa module đổi.
8. AI Settings (sau khi sửa `ai.js`): mở nút cài đặt từ modal Venus Memory, cửa sổ phải hiện **trên** modal (hỏi PIN nếu đã đặt); dữ liệu `venus-ai` cũ được chuyển thành profile #1 (+ #2, #3 từ nhà dự phòng) và bộ đếm hôm nay giữ nguyên; ô API key đã lưu hiển thị dạng che chỉ đọc (không có key thật trong DOM); chat/Review/Notes Vault dùng profile đang chọn; chọn profile ở thanh đầu khung AI không đóng khung; **tìm trong file backup** không có API key (xem mục 3).
9. Account → Your devices (sau khi sửa `venus-account.js`): thiết bị khác có nút `Remove`, máy hiện tại chỉ có nhãn `This device`; bấm lần 1 đổi thành `Confirm?` rồi tự trở lại sau ~4 giây; bấm lần 2 xóa và dòng biến mất ngay; thử khi mất mạng và khi chưa chạy migration `004` phải ra thông báo gọn, không treo.
10. Account → `Sign out other devices`: bấm lần 1 đổi thành `Confirm?` rồi tự trở lại sau ~4 giây; bấm lần 2 hiện thông báo thành công, máy này vẫn đăng nhập; trên máy kia (đang mở) sau tối đa ~1 giờ phải đăng nhập lại; thử khi mất mạng phải ra thông báo gọn.

**Lệnh Console hữu ích:**

```js
VenusMemory.getSyncState().then(console.log)                       // trạng thái đồng bộ, outbox, xung đột
VenusSync.status()                                                  // phase hiện tại
VenusTools.list().map(t => t.name + ' ' + t.level)                  // các tool đã đăng ký
VenusReview.checkReminder().then(console.log)                       // banner nhắc: shown / why
```
