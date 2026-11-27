# CLAUDE.md — Venus Hub 2.0 (VPIS Hybrid Architecture B)

Tệp này là nguồn chân lý kiến trúc và bộ quy tắc bắt buộc khi phát triển **Venus Hub** bằng Claude Code. Đọc kỹ toàn bộ tệp này trước khi đề xuất kế hoạch hoặc sửa bất kỳ dòng code nào.

## 1. Định hướng kiến trúc mục tiêu (Architecture B — Hybrid)

Venus Hub tiến hóa thành **Venus Personal Intelligence System (VPIS)** theo kiến trúc **Local-first + Hybrid Cloud** cho 1 người dùng trên **Laptop (Desktop browser/PWA) và iPhone (Safari Home Screen PWA)**:

- **Frontend & PWA (giữ nguyên)**: HTML, CSS, Vanilla JavaScript hiện tại, host trên GitHub Pages, chạy offline qua `pwa.js` + `sw.js`.
- **Cloud Control Plane (Supabase)**: Supabase Auth (Email + Mật khẩu; không dùng Magic Link vì link email mở Safari riêng, không vào được PWA Home Screen), PostgreSQL + RLS, Edge Functions (TypeScript/Deno), Storage (chọn lọc), và Cron (giai đoạn sau).
- **AI Provider Layer (Model-agnostic)**: Giữ `ai.js` cho Local AI (OpenRouter `:free` / Gemini / Groq / Ollama) và bổ sung route Cloud AI qua Edge Function khi cần.
- **Nguyên tắc bất di bất dịch**: **Cloud không bao giờ là điều kiện bắt buộc để Venus Hub hoạt động.** Khi Supabase lỗi hoặc mất mạng, toàn bộ Notes Vault, Tracker, các hàm tính toán deterministic và Local AI vẫn phải chạy bình thường; các thay đổi đồng bộ chỉ xếp hàng trong `outbox` để gửi sau.

## 2. Bản đồ tệp hiện tại & các module VPIS

| Tệp / Thư mục | Vai trò | Lưu ý bắt buộc |
| :--- | :--- | :--- |
| `index.html` | Monolith chính (Tracker, Planner, Deadlines, Focus, Courses, Investment, Sleep, Wellness, English, Roadmap, Flashcards, Notes Vault...). | **Không refactor monolith tùy tiện.** Chỉ thêm `<script>`, entry point hoặc hook tối thiểu có phạm vi, lý do và regression check rõ ràng. |
| `ai.js` | AI core chuẩn OpenAI-compatible, SSE streaming, fallback tối đa 3 model, xử lý lỗi HTTP (`401/402/404/413/429/500`), timeout 90s, `DOMPurify` sanitize output, lưu API key riêng trong IndexedDB `venus-ai`. | Giữ nguyên tương thích ngược cho chat streaming hiện tại. Không lưu API key vào `localStorage` hay gửi vào backup/sync. |
| `ai-hub.js` | Tầng phân tích deterministic (gọi các hàm tính sẵn như `computeSleepDebt`, `analyzeInsomniaPatterns`, `getStudyHoursByLocalDate`, `getSortedSleepSessions`, đọc `skillsData`, `studyHours`, `dailyStudyBreakdown`, `goals`). | Tiếp tục giữ vai trò domain analytics layer; không đẩy việc tính toán số liệu sang LLM. |
| `vault.js` / `vault.css` | Notes Vault dùng IndexedDB `FinanceTrackerVaultDB` (v4: notes, revisions, file links, attachments) và tìm kiếm BM25. | Giữ nguyên IndexedDB cục bộ; không thay bằng Postgres. Kiểm tra chính xác API export trước khi tích hợp. |
| `today.html` / `prompts.html` | Các trang/module phụ trợ của Venus Hub. | Không làm vỡ đường dẫn tương đối hoặc trạng thái dùng chung. |
| `pwa.js` / `sw.js` | PWA loader và Service Worker precache offline. | **Bắt buộc thêm tệp `.js` / `.css` mới vào danh sách `CORE` trong `sw.js`** (sửa `sw.js` đổi nội dung nên trình duyệt tự cài lại Service Worker và tải lại `CORE`; tệp cùng origin được tải network-first). **Chỉ bump `CACHE_VERSION` khi muốn xóa sạch và dựng lại cache**, không cần bump mỗi lần thêm tệp. Phiên bản thư viện CDN ghim phải khớp giữa tệp dùng nó và `CDN_PRECACHE`. |
| `tracker.css` | Stylesheet chính (có nhiều block dark-mode token chồng lấn). | Mọi UI mới của VPIS phải dùng class prefix riêng (`vpis-*`) để tránh xung đột CSS. |
| `venus-tools.js` *(mới)* | Tool Registry, adapter bọc dữ liệu/calculator cũ, kiểm tra phân quyền `L0–L3`. | Ranh giới duy nhất để AI truy cập dữ liệu ứng dụng. |
| `venus-memory.js` *(mới)* | Lõi `VenusMemoryDB` v1 (`profile`, `decisions`, `outbox`, `syncMeta`, `audit_logs`): CRUD có `revision`, outbox, audit, export/import, cộng API cho sync (`onWrite`, `listOutbox`, `ackOutbox`, `touchOutbox`, `applyRemote`, `addConflicts`, `listConflicts`, `keepLocal`, `takeRemote`, `enqueueSnapshot`, `getSyncState`…) — **không có mã mạng**. Không có UI. | Không sao chép Goals, Skills hay Notes Vault vào database này. |
| `venus-memory-ui.js` *(mới)* | Memory Review Modal (`<dialog>`, Alt+M, nút 🧠 trong `.dark-mode-container`). Chỉ gọi API công khai của `window.VenusMemory`; mọi lượt ghi kèm `approvedByUser: true` từ thao tác bấm của người dùng và `expected_revision`. | Nội dung mục chỉ hiển thị bằng `textContent`, không dùng `innerHTML`. CSS chèn từ JS, prefix `vpis-`. |
| `venus-account.js` *(mới)* | Venus Account: đăng nhập Supabase Auth bằng **Email + Mật khẩu** (đăng ký người lạ đã tắt trên Supabase), `supabase-js` ghim phiên bản và nạp lười, phiên lưu trong IndexedDB `VenusAuthDB` (không dùng `localStorage`, không vào backup), ghi thiết bị vào `user_devices`, nút kiểm tra Edge Function `health`, `onChange(cb)` báo khi trạng thái đăng nhập đổi (để sync tự chạy). Mở từ nút "☁ Tài khoản" trong header của Memory Modal. | Chỉ dùng publishable key; module từ chối chạy nếu key là secret/`service_role`. Không log token. Mọi chuỗi từ server hiển thị bằng `textContent`. CSS prefix `vpis-acc-`. Phiên bản supabase-js phải khớp giữa `venus-account.js` và `CDN_PRECACHE` trong `sw.js`. |
| `venus-sync.js` *(mới)* | Sync engine + khối "Đồng bộ bộ nhớ" trong dialog Tài khoản. Mặc định TẮT, bật thủ công có xác nhận (công tắc nằm ở `VenusMemoryDB.syncMeta`). Một lượt = pull (`sync_changes`, `seq > cursor`) → push (RPC `vpis_push`, ≤50 op) → pull ngắn. Kích hoạt khi: đăng nhập, mở app (+3 s), tab hiện lại, có mạng lại, sau khi ghi (debounce 2 s), nút "Đồng bộ ngay". Xung đột không bao giờ tự gộp: giữ mục lại, hiện hai bản, người dùng chọn. | Chỉ đồng bộ `profile` + `decisions` qua API 3A của `VenusMemory`; không đụng `localStorage`, Notes Vault, API key, token. Cloud lỗi/offline chỉ đổi dòng trạng thái, outbox giữ nguyên. Chạy lệch tab được chặn bằng Web Locks. Chuỗi từ server hiển thị bằng `textContent`. CSS prefix `vpis-sync-`. |
| `venus-review.js` *(mới)* | Monthly Personal Review. Mở từ nút "📋 Review tháng" trong Memory modal. Luồng: gói số liệu do JS tính qua `VenusTools` (học, ngủ, mục tiêu/deadline, bộ nhớ đã duyệt; người dùng xem nguyên văn gói và nơi nhận trước khi gửi) → 1 lời gọi `VenusAI.chat` trả JSON (lần 2 chỉ để sửa JSON hỏng) → kiểm tra schema + đối chiếu `evidence` với số thật → Draft Actions. | AI không gọi tool, không ghi. Chỉ ghi khi người dùng bấm: `save_memory_item` (L2) với `approvedByUser: true`, `expected_revision: 0`, status `proposed`. Không ghi Goals/Deadlines/Profile/Vault. Không lưu gì ngoài bộ nhớ trang (không `localStorage`, không IndexedDB mới). Chuỗi từ AI hiển thị bằng `textContent`. CSS prefix `vpis-rev-`. |
| `supabase/` *(mới)* | `migrations/` (`001_core`, `002_sync`, `003_sync_rpc`) và `functions/` (Edge Functions Deno/TS). | Mọi bảng user data bắt buộc có `user_id` và RLS. Client **chỉ ghi qua RPC `vpis_push`** (INSERT/UPDATE trực tiếp vào `user_profile`/`decisions`/`sync_changes` đã bị thu hồi). |

## 3. Phân vùng dữ liệu (3 Zones) & Lưu trữ thực tế

| Vùng dữ liệu | Phạm vi & ví dụ | Nguyên tắc lưu trữ |
| :--- | :--- | :--- |
| **Zone A — Local Private** *(mặc định)* | Notes Vault & attachments (`FinanceTrackerVaultDB`), raw sleep logs, dữ liệu nhạy cảm chưa chọn sync, API keys (`venus-ai`). | Chỉ nằm trên thiết bị. Không tự động đẩy lên cloud. |
| **Zone B — Opt-in Sync** | `profile`, `decisions`, mục tiêu/deadline được chọn, tiến độ học tập, báo cáo review được phép lưu. | Lưu local trước (`VenusMemoryDB` / adapter), đồng bộ 2 chiều qua `outbox` ↔ Supabase. |
| **Zone C — Cloud Operational** | Auth sessions, `user_devices`, `sync_changes` cursor, `agent_runs`, `agent_actions`, `push_subscriptions`. | Do Supabase quản lý, không chứa raw notes hay nội dung nhạy cảm trừ khi người dùng cho phép. |

### Lưu ý kỹ thuật về lưu trữ hiện tại
- **`localStorage` (15+ khóa phân tán)**: `studyHours`, `dailyStudyData`, `dailyStudyBreakdown`, `goals`, `courses`, `deadlines`, `calEvents`, `sleepSessions`, `wellnessTrackerData_v1`, `englishDaily_v1`, `brainDumpNotes`, `readingList`, `resourceLibrary`, `investmentAnalyses`, `dealDiary`, `focusSessionLogs`, `sessionLogs`, `gamification`, v.v.
  - Hàm `checkLocalStorageQuota()` trong `index.html` chỉ là **ước tính theo giả định ngưỡng 5 MiB** (cảnh báo từ 80%), không phải phép đo quota thực của từng trình duyệt. Luôn dùng thêm `navigator.storage.estimate()` để đo thực tế trước khi quyết định migrate bất kỳ module nào.
  - **Không nhét dữ liệu VPIS mới vào `localStorage`.**
- **IndexedDB `venus-ai`**: Lưu provider config và API keys. Độc lập hoàn toàn với backup JSON và hệ thống sync.
- **IndexedDB `FinanceTrackerVaultDB`**: Lưu Notes Vault. Hiện được nối vào `exportProgress()` qua `getBackupParts()` / `getBackupData()`.
- **IndexedDB `VenusMemoryDB` (v1 — sẽ tạo mới)**: Gồm 5 store `profile`, `decisions`, `outbox`, `syncMeta`, `audit_logs`. Mọi bản ghi dữ liệu (`profile`, `decisions`) phải mang sẵn metadata sync-ready: `id` (UUID), `device_id`, `revision`, `updated_at`, `deleted_at`, `schema_version`.

## 4. Mười quy tắc vàng bắt buộc cho Claude Code

1. **Không refactor `index.html` tùy tiện**: Mọi thay đổi trong `index.html` phải có phạm vi nhỏ, lý do rõ ràng, và danh sách kiểm tra hồi quy (regression check) trước/sau khi sửa.
2. **Không phá vỡ schema dữ liệu cũ**: Không đổi tên khóa `localStorage` hay cấu trúc object store hiện có nếu chưa có migration tương thích ngược.
3. **Không tạo nguồn dữ liệu trùng lặp (Single Source of Truth)**: Đọc trực tiếp Goals, Skills, Deadlines và Notes Vault qua `venus-tools.js`; tuyệt đối không sao chép chúng sang `VenusMemoryDB`.
4. **Mọi truy cập của AI phải đi qua `venus-tools.js`**: Dùng interface đã đăng ký kèm schema input/output và kiểm tra quyền (`L0_READ`, `L1_DRAFT`, `L2_WRITE_APPROVAL`, `L3_DESTRUCTIVE`). Phân biệt rõ **Local tools** và **Cloud tools**.
5. **Deterministic first & An toàn hiển thị**:
   - Mọi số liệu thống kê phải do JS tính sẵn, không để LLM tự đếm từ raw JSON.
   - Hiểu đúng 2 lớp bảo vệ riêng biệt: **`DOMPurify`** (chặn `img`, `svg`, `iframe`) bảo vệ khâu render HTML khỏi XSS/exfiltration; còn **cô lập `<context>` như dữ liệu không đáng tin trong system prompt** giúp giảm rủi ro prompt injection. Bắt buộc duy trì cả hai.
6. **Tối ưu cho OpenRouter `:free` models ở Giai đoạn đầu**: Dùng workflow có trạng thái (1–2 lời gọi structured JSON với fallback 3 model), không triển khai vòng lặp autonomous tool-calling nhiều bước khi chưa đủ độ ổn định.
7. **Human-in-the-loop + Optimistic Concurrency**: AI không bao giờ tự ghi vào `profile`, `decisions`, `goals` hay Vault. Mọi thao tác `L2_WRITE_APPROVAL` phải gắn với hành động cụ thể, input cụ thể, `approvedByUser: true`, kiểm tra khớp `revision` hiện tại trước khi ghi, và ghi nhận vào `audit_logs`.
8. **Bảo mật Supabase tuyệt đối**:
   - Chỉ được phép đặt **Supabase publishable key** và **user session JWT** ở frontend.
   - **Cấm tuyệt đối** đưa `service_role` / secret key, server-side provider credentials, hoặc encryption master key vào code frontend.
   - Mọi bảng dữ liệu người dùng trên PostgreSQL phải bật **RLS** kiểm tra `auth.uid() = user_id`. Mọi Edge Function phục vụ người dùng phải xác thực JWT hợp lệ.
9. **Bảo toàn Backup & Restore**: `exportProgress()` / `importProgress()` không tự động quét mọi IndexedDB mới. Khi thêm `VenusMemoryDB`, bắt buộc nối `profile` + `decisions` + metadata cần thiết vào backup với `backupSchemaVersion` rõ ràng; **tuyệt đối không xuất API keys hay auth tokens**; restore local không tự ghi đè dữ liệu cloud.
10. **Tương thích PWA Laptop & iPhone**: Luôn cập nhật `sw.js` khi thêm tệp; không phụ thuộc vào Background Sync hay Periodic Background Sync (hạn chế trên iOS Safari) — lấy đồng bộ khi mở app / foreground / online làm cơ chế chính, kết hợp Web Push (iOS 16.4+ Home Screen PWA) ở giai đoạn sau.

## 5. Quy trình làm việc bắt buộc trên từng task

1. **Đọc trước khi sửa**: Kiểm tra đúng tệp liên quan và trích dẫn vị trí dòng thực tế trước khi viết code. Không đoán tên hàm hay schema chưa xác minh.
2. **Đề xuất kế hoạch ngắn trước khi code**: Nêu rõ tệp sẽ tạo/sửa, tác động lên storage/backup/sync, và cách rollback.
3. **Thay đổi cô lập theo từng milestone**: Không gộp nhiều phase lớn (ví dụ vừa viết `venus-tools.js` vừa dựng Supabase) trong cùng một lần sửa.
4. **Kiểm tra hồi quy (Regression Check) sau mỗi bước**:
   - Console 0 lỗi khi mở app (cả online và offline mode).
   - Các tab cũ, dữ liệu `localStorage`, `FinanceTrackerVaultDB`, và chat streaming cũ trong `ai.js` hoạt động nguyên vẹn.
   - Backup JSON xuất/nhập thành công và không chứa API key hay token.
   - Cập nhật tài liệu kiến trúc (`docs/`) nếu thay đổi trách nhiệm hoặc phụ thuộc giữa các module.
