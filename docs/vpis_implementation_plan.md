# Kế hoạch triển khai chi tiết: Venus Hub 2.0 — VPIS Hybrid Architecture B (Laptop + iPhone)

Tài liệu này khóa chặt kiến trúc **Hướng B (Local-first + Cloud Control Plane qua Supabase)** ngay từ ngày đầu để mọi schema, ID, cơ chế backup, phân quyền và đồng bộ khớp nhau xuyên suốt, tránh phải đập đi sửa lại khi mở rộng từ Laptop sang iPhone và sang Agent tự chủ.

## 1. Kiến trúc tổng thể & Quyết định đã chốt

**Nguyên lý cốt lõi**: Giữ nguyên Venus Hub là ứng dụng local-first (PWA) chạy mượt ngay cả khi mất mạng hoặc Supabase ngừng hoạt động. Bổ sung **Supabase** làm lớp điều phối nhẹ cho danh tính (Auth), đồng bộ hai thiết bị (Laptop ↔ iPhone), lưu trạng thái workflow, và tự động hóa nền ở giai đoạn sau.

### Stack công nghệ

| Thành phần | Công nghệ | Vai trò |
| :--- | :--- | :--- |
| **Frontend & PWA** | HTML, CSS, Vanilla JS hiện tại + `pwa.js` / `sw.js` | Giữ nguyên ứng dụng, hoạt động offline trên Laptop & iPhone Home Screen PWA. |
| **Local Storage & DB** | `localStorage` (cũ) + `FinanceTrackerVaultDB` (Vault) + `venus-ai` (Keys) + **`VenusMemoryDB`** *(mới)* | Chủ sở hữu dữ liệu cá nhân tại thiết bị. |
| **Cloud Backend** | **Supabase** (Auth, PostgreSQL + RLS, Edge Functions TS/Deno, Storage, Cron) | Quản lý 1 stack duy nhất cho solo developer; bắt đầu ở Free tier ($0). |
| **AI Gateway** | `ai.js` (Local AI) + `ai-proxy` Edge Function (Cloud AI sau này) | Độc lập với model (OpenRouter `:free`, Gemini, Groq, Ollama). |

### Bản đồ 3 vùng dữ liệu (Data Zones)

| Vùng dữ liệu | Thành phần cụ thể | Quy tắc vận hành |
| :--- | :--- | :--- |
| **Zone A — Local Private** *(mặc định)* | Notes Vault & attachments (`FinanceTrackerVaultDB`), raw sleep logs, dữ liệu chưa chọn sync, API keys (`venus-ai`). | Chỉ nằm trên thiết bị; tuyệt đối không tự đẩy lên cloud hay nhét vào sync payload. |
| **Zone B — Opt-in Sync** | `profile`, `decisions` (ưu tiên đồng bộ trước); sau này mở rộng sang Goals, Deadlines, Learning progress, báo cáo review được chọn. | Ghi local trước + đẩy change record vào `outbox` trong cùng IndexedDB transaction → đồng bộ 2 chiều qua Supabase. |
| **Zone C — Cloud Operational** | Auth sessions, `user_devices`, `sync_changes`, `agent_runs`, `agent_actions`, `push_subscriptions`. | Backend quản lý vận hành; không lưu raw notes nhạy cảm chỉ để debug. |

### Cấu trúc repository đích (tạo dần theo từng Phase, không tạo một lượt)

```text
venus-hub/
├── index.html, today.html, prompts.html
├── tracker.css, vault.css
├── vault.js, pwa.js, sw.js, manifest.json
├── ai.js, ai-hub.js
├── venus-tools.js          # Phase 1: Tool Registry + Permission L0-L3 + Storage Diagnostics
├── venus-memory.js         # Phase 1: VenusMemoryDB v1 (Sync-Ready) + Memory Review UI
├── venus-sync.js           # Phase 3: Outbox Sync Engine + Conflict Handler + Sync Center UI
├── venus-review.js         # Phase 4: Monthly Personal Review + Revision-checked Approval
├── supabase/               # Phase 2+: migrations/ (001_core.sql, 002_sync.sql...) & functions/
├── docs/                   # Phase 0+: ARCHITECTURE_AUDIT.md, DATA_CATALOG.md, SYNC_PROTOCOL.md
└── CLAUDE.md               # Phase 0: Bộ quy tắc & bản đồ cho Claude Code
```

## 2. Thiết kế kỹ thuật lõi (Khóa chuẩn trước khi code)

### 2.1. Local IndexedDB `VenusMemoryDB` v1 (Sync-Ready từ ngày đầu)

Tách biệt hoàn toàn với `venus-ai` (chứa API key) và không sao chép Goals, Skills hay Notes Vault.

| Object Store | `keyPath` | Mục đích |
| :--- | :--- | :--- |
| `profile` | `id` | Thông tin nền ổn định (định hướng nghề nghiệp, quy tắc làm việc, sở thích học tập, ràng buộc cá nhân). |
| `decisions` | `id` | Lịch sử quyết định, bài học, cột mốc, quy trình (`procedure`), bản tóm tắt `review_summary`. |
| `outbox` | `op_id` | Hàng đợi thay đổi cục bộ chờ đẩy lên Supabase (ghi cùng transaction với `profile`/`decisions`). |
| `syncMeta` | `key` | Lưu `device_id`, `last_sync_cursor`, `last_sync_at`, trạng thái thiết bị. |
| `audit_logs` | `id` | Lịch sử thực thi mọi thao tác ghi (`L2+`), lưu `timestamp`, `tool_name`, `target_id`, `revision_checked`, `approved_by_user`, `status`. |

#### Metadata đồng bộ bắt buộc trên mọi bản ghi `profile` và `decisions`

```json
{
  "id": "uuid-v4-on-dinh",
  "device_id": "device-uuid",
  "revision": 1,
  "updated_at": "2026-11-27T04:00:00.000Z",
  "deleted_at": null,
  "schema_version": 1
}
```

#### Cấu trúc bản ghi `decisions` (giữ lịch sử phiên bản, không xóa đè)

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "decision",
  "title": "Ưu tiên lộ trình ALM / Treasury trong 36 tháng",
  "content": "Tập trung liquidity risk, IRRBB, FTP và chuẩn hóa ghi chú trong Vault.",
  "rationale": "Phù hợp định hướng dài hạn lên ALCO.",
  "source": "monthly_review_2026_11",
  "confidence": 0.9,
  "status": "proposed",
  "supersedes_id": null,
  "tags": ["career", "alm"],
  "created_at": "2026-11-27T04:00:00.000Z",
  "last_verified_at": null,
  "device_id": "device-uuid",
  "revision": 1,
  "updated_at": "2026-11-27T04:00:00.000Z",
  "deleted_at": null,
  "schema_version": 1
}
```

- Vòng đời trạng thái: `proposed` (AI đề xuất) → `approved` (đang có hiệu lực) → `superseded` (bản mới thay thế, trỏ `supersedes_id` về bản cũ).
- Phát hiện thông tin cũ: `getStaleMemories(90)` lọc các mục `approved` có `last_verified_at` quá 90 ngày để nhắc xác nhận lại.

### 2.2. Cloud PostgreSQL (Supabase) & Bảo mật

| Bảng Postgres | Giai đoạn tạo | Chức năng chính |
| :--- | :--- | :--- |
| `user_profile` | Phase 2 | Lưu bản sao đồng bộ của `profile` (`user_id`, `id`, `revision`, `updated_at`, `deleted_at`, `payload`). |
| `decisions` | Phase 2 | Lưu bản sao đồng bộ của `decisions` (append-only theo `id` + `revision`). |
| `user_devices` | Phase 2 | Quản lý danh sách thiết bị đã đăng nhập (Laptop, iPhone) và thời điểm sync cuối. |
| `sync_changes` | Phase 2 | Nhật ký thay đổi theo thứ tự tăng dần (`seq BIGSERIAL`) để các thiết bị pull bằng `cursor`. |
| `agent_runs` & `agent_actions` | Phase 4–5 | Lưu trạng thái workflow (`queued / running / awaiting_approval / completed / failed`) và các bản nháp chờ duyệt. |

**Quy tắc bảo mật cứng**:
- Mọi bảng đều có `user_id uuid NOT NULL REFERENCES auth.users(id)` và bật **Row Level Security (RLS)** chỉ cho phép `auth.uid() = user_id`.
- Frontend chỉ dùng **Supabase publishable key** + **User JWT**. Tuyệt đối không đưa `service_role` key hay provider API key vào frontend.

### 2.3. Cơ chế đồng bộ Local-first (`venus-sync.js`)

- **Không bao giờ** upload/download đè toàn bộ `localStorage`.
- **Chu trình Push / Pull**:
  1. Khi sửa `profile` hoặc `decisions` ở local → ghi bản ghi mới và đẩy 1 `change_record` vào `outbox` trong **cùng một IndexedDB transaction**.
  2. Trigger đồng bộ: sau khi đăng nhập, khi mở app, khi quay lại foreground (`visibilitychange`), khi có mạng lại (`online`), sau thao tác ghi quan trọng, hoặc khi bấm nút **Sync Now**.
  3. **Push**: gửi các mục trong `outbox` lên Supabase kèm `expected_revision` (idempotent theo `op_id` để không chạy trùng 2 lần).
  4. **Pull**: hỏi các bản ghi có `seq > last_sync_cursor` → áp vào `VenusMemoryDB` và cập nhật `syncMeta`.
- **Xử lý xung đột theo từng loại dữ liệu**:
  - `decisions`: append-only + deduplicate bằng UUID (gần như không xung đột).
  - `profile`: kiểm tra `revision` — nếu hai thiết bị cùng sửa từ 1 revision khi offline, **không tự ghi đè âm thầm**; lưu conflict record và hiện 2 phiên bản trong Sync Center để người dùng chọn/gộp.
- **Lưu ý đặc thù iPhone (iOS Safari PWA)**: Không phụ thuộc Background Sync hay Periodic Background Sync. Lấy đồng bộ khi mở app/foreground làm cơ chế chính; dùng Web Push (hỗ trợ từ iOS 16.4+ khi đã thêm vào Home Screen) cho thông báo ở Phase 5.

### 2.4. Tool Registry & Phân quyền (`venus-tools.js`)

| Cấp độ | Hằng số | Phạm vi | Điều kiện chạy |
| :--- | :--- | :--- | :--- |
| **L0** | `L0_READ` | Đọc & tính tổng hợp dữ liệu (Study, Sleep/Wellness, Goals/Deadlines, Vault BM25, Memory, Storage Health). | Tự động chạy. |
| **L1** | `L1_DRAFT` | Sinh bản nháp đề xuất (Memory proposal, Review note draft, Goal adjustment). | Không ghi thật; trả về object draft kèm `target_revision`. |
| **L2** | `L2_WRITE_APPROVAL` | Ghi vào `VenusMemoryDB` hoặc tạo note mới trong Vault. | Bắt buộc `approvedByUser: true` + **khớp `expected_revision`** + ghi `audit_logs`. |
| **L3** | `L3_DESTRUCTIVE` | Xóa hàng loạt, reset dữ liệu. | Khóa hoàn toàn ở các giai đoạn đầu. |

- **Phân biệt rõ môi trường**: **Local tools** đọc trực tiếp `localStorage`, `FinanceTrackerVaultDB`, `VenusMemoryDB` trên máy; **Cloud tools** (sau này) chỉ đọc dữ liệu đã được đồng bộ lên Zone B.

### 2.5. Nâng cấp Backup & Restore

- Nâng cấp `exportProgress()` / `importProgress()` trong `index.html` có trường `backupSchemaVersion` rõ ràng (ví dụ `backupSchemaVersion: 4`).
- Bổ sung nhánh `venusMemory` (`profile` + `decisions` + metadata cần thiết).
- **Cấm xuất** `venus-ai` (API keys) và Supabase auth tokens.
- Khi **Import** bản backup local: kiểm tra `backupSchemaVersion`, hỏi rõ chế độ *Merge* hay *Replace local*, và **không tự động ghi đè dữ liệu cloud** khi chưa được xác nhận.

## 3. Lộ trình triển khai 6 Phase độc lập

| Phase | Mục tiêu chính | Đầu ra cụ thể | Tiêu chí nghiệm thu (Acceptance Criteria) |
| :--- | :--- | :--- | :--- |
| **Phase 0: Architecture Audit & Safety Net** | Hiểu 100% codebase hiện tại trước khi sửa. | `CLAUDE.md`, `docs/ARCHITECTURE_AUDIT.md`, `docs/DATA_CATALOG.md`, nhánh git mới, bản backup JSON gốc. | Claude Code lập bản đồ đúng toàn bộ module, global deps, `localStorage` keys, `exportProgress()`, `vault.js`, `sw.js` có trích dẫn số dòng; 0 file code bị sửa. |
| **Phase 1: Local API & Sync-Ready Memory** | Tạo tầng công cụ đọc chuẩn & bộ nhớ dài hạn sẵn sàng đồng bộ. | `venus-tools.js` (`L0_READ` + `get_storage_health` dùng cả `navigator.storage.estimate()`), `venus-memory.js` (`VenusMemoryDB` v1 + Memory Review Modal + nối Backup/Restore), cập nhật `sw.js`. | Chạy được các tool `L0_READ` trên Console ra số liệu khớp UI; tạo/duyệt/verify `profile` & `decisions` sống qua reload; export/import backup có `venusMemory` và 0 API key. |
| **Phase 2: Cloud Foundation (Supabase)** | Thiết lập danh tính chung & bảng cloud cho Laptop + iPhone. | Project Supabase Free ($0), `supabase/migrations/001_core.sql` & `002_sync.sql` kèm RLS, Edge Function `health`, UI đăng nhập Email OTP / Magic Link gọn trong Settings. | Đăng nhập cùng 1 tài khoản trên Laptop và iPhone Home Screen PWA; `user_devices` ghi nhận đúng 2 thiết bị; RLS chặn truy cập chéo; tắt mạng app local vẫn chạy 100%. |
| **Phase 3: Two-Way Sync (`profile` & `decisions`)** | Đồng bộ tin cậy 2 chiều giữa Laptop và iPhone. | `venus-sync.js` (Outbox, Push/Pull theo cursor, idempotency, conflict detector) + **Sync Center** nhỏ trong Settings (trạng thái 2 thiết bị, pending count, conflict count, nút Sync Now). | Tạo/sửa `profile` và `decisions` trên Laptop → mở iPhone thấy cập nhật; sửa cả 2 máy lúc offline → khi online hiện thông báo conflict rõ ràng, không mất dữ liệu; không ghi trùng khi mạng chập chờn. |
| **Phase 4: First Intelligent Workflow — Monthly Personal Review** | Khai thác toàn bộ hệ thống trên bài toán thực tế đầu tiên. | Mở rộng nhẹ `ai.js` với `requestJSON()` (tự bóc/sửa JSON + fallback 3 model `:free`), tạo `venus-review.js` (banner nhắc ngày 1–5 đầu tháng, deterministic packet, báo cáo sanitized bằng `DOMPurify`, thẻ Draft Actions duyệt có kiểm tra `revision`). | Chạy Monthly Review bằng OpenRouter `:free` ra báo cáo bám sát số liệu thật; bấm *Bỏ qua* không ghi gì; bấm *Duyệt & Lưu* ghi vào `VenusMemoryDB`/Vault, lưu `audit_logs` và tự đồng bộ sang iPhone. |
| **Phase 5–6: Mở rộng Sync, Proactive & Agent Autonomy** *(chỉ làm khi Phase 0–4 chạy ổn định)* | Mở rộng sang Goals/Deadlines, lịch chạy nền và agent tự chủ có kiểm soát. | Adapter đồng bộ từng module `localStorage` (ưu tiên Goals/Deadlines), Supabase Cron + Web Push (iOS 16.4+), nâng Supabase Pro ($25/tháng) nếu cần chạy 24/7 không pause; sau cùng mới thêm tool-calling đa bước và bộ eval 8–10 ca thực tế. | Đồng bộ Goals/Deadlines không xung đột; nhận push khi có review định kỳ; chỉ nâng cấp chi phí khi có workflow thực sự cần chạy nền. |

## 4. Bộ 6 Prompt thực chiến cho Claude Code

Dán **lần lượt từng prompt**. Chỉ sang prompt kế tiếp khi đã kiểm tra đạt tiêu chí nghiệm thu và commit lên GitHub.

### Prompt 0 — Architecture Audit (Chỉ đọc, tuyệt đối chưa sửa file)

> Hãy đóng vai senior software architect thực hiện một cuộc **READ-ONLY Architecture & Data-Integrity Audit** cho toàn bộ repo Venus Hub này. **Tuyệt đối không chỉnh sửa, tạo mới, xóa hay đổi tên bất kỳ tệp mã nguồn nào** trong bước này (trừ việc đề xuất nội dung báo cáo trong câu trả lời để tôi duyệt).
>
> Đọc kỹ `CLAUDE.md`, `index.html`, `ai.js`, `ai-hub.js`, `vault.js`, `today.html`, `prompts.html`, `pwa.js`, `sw.js`, `tracker.css`, `vault.css` và báo cáo theo 6 mục:
> 1. **Repository Architecture Map**: Các module chính, thứ tự load script, biến global và phụ thuộc giữa các module, điểm tích hợp AI hiện tại, cấu trúc PWA/Service Worker (tên cache và danh sách precache).
> 2. **Data Inventory Table**: Toàn bộ khóa `localStorage`, các IndexedDB database & object stores, hàm đọc/ghi chính, chi tiết hàm `exportProgress()` / `importProgress()` (tên hàm, số dòng, định dạng JSON, dữ liệu nào đang nằm ngoài backup).
> 3. **AI Architecture Audit**: Phân tích chính xác cơ chế provider abstraction, lưu API key, streaming, context truncation, lỗi/retry, `DOMPurify`, cô lập `<context>` trong system prompt — phân biệt rõ cái gì **đã có** và cái gì **chưa có**.
> 4. **Hybrid Migration Risks (Laptop + iPhone qua Supabase)**: Các rủi ro cụ thể khi thêm `VenusMemoryDB` và Supabase (backup, offline, iOS Safari PWA, xung đột dữ liệu, bảo mật key).
> 5. **Reusable Functions**: Liệt kê chính xác tên hàm + vị trí dòng của các calculator trong `index.html`/`ai-hub.js` và các hàm BM25/CRUD của `vault.js` có thể bọc trực tiếp vào `venus-tools.js`.
> 6. **Prioritized Technical Debt**: Xếp hạng nợ kỹ thuật theo mức độ ảnh hưởng đến Phase 1–4.
>
> Yêu cầu: Trích dẫn tên tệp và số dòng thực tế; gắn nhãn rõ **Confirmed** (xác nhận từ code), **Inference** (suy luận hợp lý), và **Unknown** (cần test lúc chạy). Dừng lại chờ tôi duyệt trước khi đề xuất sửa code.

### Prompt 1 — Xây `venus-tools.js` (Phase 1A: Read-Only Tools & Storage Diagnostics)

> Dựa trên `CLAUDE.md` và báo cáo Audit vừa duyệt, hãy tạo tệp mới `venus-tools.js` triển khai `window.VenusTools`:
> 1. Phân quyền 4 cấp: `L0_READ`, `L1_DRAFT`, `L2_WRITE_APPROVAL` (bắt buộc `approvedByUser: true` và kiểm tra `expected_revision`), `L3_DESTRUCTIVE` (tạm khóa).
> 2. Cài đặt 5 tool `L0_READ` bằng adapter bọc lại các hàm tính toán sẵn có (không di chuyển hay refactor calculator trong `index.html`):
>    - `get_study_summary({ from, to })`
>    - `get_sleep_wellness_summary({ from, to })`
>    - `get_goals_and_deadlines()`
>    - `search_vault_notes({ query, limit })` (gọi BM25 của `vault.js`)
>    - `get_storage_health()` (thống kê dung lượng từng key `localStorage` + gọi `navigator.storage.estimate()` để đo tổng quota thực tế của trình duyệt).
> 3. Chỉ thêm thẻ `<script src="venus-tools.js"></script>` vào `index.html` và cập nhật precache + bump cache version trong `sw.js`.
> 4. Báo rõ các dòng đã chạm vào `index.html`/`sw.js` và cho tôi 3 lệnh test nhanh trên DevTools Console.

### Prompt 2 — Xây `venus-memory.js` (Phase 1B: Sync-Ready `VenusMemoryDB` v1 + Memory Review + Backup)

> Hãy tạo tệp mới `venus-memory.js` quản lý IndexedDB **`VenusMemoryDB` v1** (độc lập hoàn toàn với `venus-ai`) gồm 5 object stores: `profile`, `decisions`, `outbox`, `syncMeta`, `audit_logs`.
> Yêu cầu chi tiết:
> 1. Mọi bản ghi `profile` và `decisions` đều có sync-ready metadata: `id` (UUID), `device_id` (tự sinh và lưu trong `syncMeta`), `revision` (tăng dần), `updated_at`, `deleted_at`, `schema_version: 1`.
> 2. Mọi thao tác ghi `profile` hoặc `decisions` phải đồng thời ghi 1 change record vào `outbox` trong **cùng một IndexedDB transaction**.
> 3. Hỗ trợ vòng đời `proposed → approved → superseded` (kèm `supersedes_id`), hàm `getStaleMemories(90)`, và `exportAll()` / `importAll(data, { mode })`.
> 4. Đăng ký vào `VenusTools`: `get_memory_context` (`L0_READ`), `save_memory_item` và `update_profile_item` (`L2_WRITE_APPROVAL`, kiểm tra `approvedByUser: true` + `expected_revision` + ghi `audit_logs`).
> 5. Nối `VenusMemoryDB` vào `exportProgress()` / `importProgress()` trong `index.html` kèm `backupSchemaVersion` rõ ràng (tuyệt đối không xuất `venus-ai`/API keys).
> 6. Thêm 1 **Memory Review Modal** gọn dùng prefix CSS `vpis-*` (xem, thêm tay, duyệt `proposed`, sửa, đánh dấu `verify` còn đúng, xem `audit_logs`). Cập nhật `index.html` và `sw.js`.

### Prompt 3 — Dựng Supabase Foundation (Phase 2: Auth + Postgres + RLS + Health Check)

> Hãy tạo thư mục `supabase/` để khởi tạo tầng Cloud Control Plane cho Architecture B (giữ nguyên 100% khả năng chạy offline khi chưa đăng nhập hoặc mất mạng):
> 1. `supabase/migrations/001_core.sql`: tạo bảng `user_profile`, `decisions`, `user_devices` với `user_id`, metadata sync (`id`, `device_id`, `revision`, `updated_at`, `deleted_at`, `schema_version`), và **chính sách RLS đầy đủ** (`auth.uid() = user_id`).
> 2. `supabase/migrations/002_sync.sql`: tạo bảng `sync_changes` (`seq BIGSERIAL`, `op_id UNIQUE` để idempotent, `entity_type`, `entity_id`, `revision`, `payload`, `user_id`) kèm RLS và index theo `(user_id, seq)`.
> 3. `supabase/functions/health/index.ts`: Edge Function kiểm tra kết nối, CORS và xác thực JWT hợp lệ.
> 4. Thêm phần cấu hình **Venus Account (Supabase Auth — Email OTP / Magic Link)** gọn trong Settings bằng publishable key (tuyệt đối không có `service_role` key ở frontend), tự đăng ký thiết bị hiện tại vào `user_devices` khi đăng nhập.
> 5. Viết hướng dẫn từng bước để tôi chạy migration, deploy function và test đăng nhập trên cả Laptop lẫn iPhone Home Screen PWA.

### Prompt 4 — Xây `venus-sync.js` (Phase 3: Two-Way Sync cho `profile` & `decisions` + Sync Center)

> Hãy tạo tệp mới `venus-sync.js` triển khai cơ chế **Local-first Sync with Change Tracking** cho 2 bảng `profile` và `decisions` giữa `VenusMemoryDB` và Supabase:
> 1. **Push**: đọc các mục pending trong `outbox`, gửi theo lô kèm `op_id` (idempotent) và `expected_revision`. Nếu server báo lệch revision cho `profile`, lưu vào danh sách conflict cục bộ thay vì ghi đè âm thầm.
> 2. **Pull**: lấy các bản ghi từ `sync_changes` có `seq > last_sync_cursor`, áp dụng vào `VenusMemoryDB` (không đẩy ngược lại `outbox`) và cập nhật `last_sync_cursor`.
> 3. **Triggers**: tự động chạy sync an toàn (có khóa chống chạy song song) khi đăng nhập, mở app, `visibilitychange` (quay lại foreground), `online`, sau thao tác ghi `VenusMemoryDB`, và nút **Sync Now**.
> 4. **Sync Center UI** (class `vpis-*`, thân thiện màn hình iPhone): hiển thị trạng thái kết nối, danh sách thiết bị từ `user_devices`, lần sync cuối, số pending changes, số conflict (kèm nút chọn phiên bản khi có conflict).
> 5. Cập nhật `index.html` và `sw.js`, kèm kịch bản test offline + conflict giữa Laptop và iPhone.

### Prompt 5 — Nâng cấp `ai.js` (`requestJSON`) + Xây Monthly Personal Review (`venus-review.js`, Phase 4)

> Hãy triển khai workflow thông minh đầu tiên — **Monthly Personal Review** — chạy ổn định với OpenRouter `:free` models và tự đồng bộ kết quả qua `VenusMemoryDB`:
> 1. Mở rộng nhẹ `ai.js` thêm `requestJSON(messages, options)`: dùng lại provider config, fallback 3 model và xử lý lỗi HTTP hiện có; không ảnh hưởng chat streaming cũ; tự bóc JSON từ code fence/chuỗi trả về; hỗ trợ `validate(parsed)` và tự retry 1 lần hoặc chuyển sang fallback model nếu JSON hỏng.
> 2. Tạo `venus-review.js`:
>    - Hàm `collectMonthlyPacket(year, month)` gọi các `L0_READ` tool (`get_study_summary`, `get_sleep_wellness_summary`, `get_goals_and_deadlines`, `get_memory_context`, `search_vault_notes`) để tạo gói ngữ cảnh gọn, deterministic.
>    - UI Modal (`vpis-*`, responsive cho cả iPhone) chọn tháng, xem trước bảng số liệu thật, thêm ghi chú ngữ cảnh ngắn tùy chọn, rồi gọi `requestJSON()`.
>    - Render `summary_markdown` qua `DOMPurify` (chặn `img`, `svg`, `iframe`).
>    - Hiển thị từng thẻ Draft Action riêng biệt (lưu note vào Vault, thêm `decisions`, cập nhật `profile`) kèm `expected_revision` và 3 nút **Duyệt & Lưu / Sửa / Bỏ qua** gọi qua `L2_WRITE_APPROVAL` (sau khi lưu sẽ tự xếp hàng vào `outbox` để sync sang thiết bị còn lại).
>    - Thêm kiểm tra nhẹ khi mở app vào ngày 1–5 đầu tháng: nếu chưa có `review_summary` của tháng trước trong `VenusMemoryDB`, hiện 1 banner nhỏ có thể tắt.
> 3. Cập nhật `index.html` và `sw.js`, kèm checklist kiểm thử trên cả Laptop và iPhone.

## 5. Bộ 6 tiêu chí đánh giá & Regression Checklist trước mỗi lần commit

Trước khi merge bất kỳ thay đổi nào vào nhánh chính, kiểm tra nhanh theo 6 chiều chất lượng:

| Tiêu chí | Câu hỏi kiểm chứng thực tế |
| :--- | :--- |
| **Reliability** | Tắt mạng / ngắt Supabase thì Tracker, Notes Vault, calculators và Local AI có còn chạy 0 lỗi không? |
| **Data Integrity** | Reload trang, xuất/nhập backup JSON, và sync 2 chiều Laptop ↔ iPhone có giữ nguyên dữ liệu và không mất bản ghi offline không? |
| **Intelligence** | Báo cáo Monthly Review có bám sát 100% số liệu deterministic (không bịa số giờ học/nợ ngủ) và đề xuất quyết định có ích không? |
| **Portability** | Đổi từ OpenRouter `:free` sang Gemini/Groq/Ollama trong Settings có chạy tiếp mà không phải sửa code workflow không? |
| **Privacy** | Backup JSON và payload gửi lên Supabase có **0 API keys**, **0 auth tokens**, và **0 raw notes** chưa được phép sync không? |
| **Maintainability** | Diff trong `index.html` có nhỏ gọn, rõ phạm vi và đã cập nhật `sw.js` + tài liệu `docs/` chưa? |