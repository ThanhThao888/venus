(function () {
    'use strict';

    /* ═════════════════════════════════════════════════════════════
       Notes Vault — step 1
       Full-screen workspace: sidebar · library / document · inspector.
       Storage: FinanceTrackerVaultDB v2. The "notes" store is unchanged, so
       older notes open as-is; v2 adds a "revisions" store for version history.
       Deleting a note moves it to Trash (a deletedAt stamp on the same record).
    ═════════════════════════════════════════════════════════════ */
    const DB_NAME = 'FinanceTrackerVaultDB';
    const DB_VERSION = 4;
    const STORE = 'notes';
    const DB_REV = 'revisions';
    const DB_LINKS = 'fileLinks';
    const DB_ATTACH = 'attachments';       // id → { id, hash, blob, mime, size, width, height, createdAt }
    const DB_ATTACH_REFS = 'attachmentRefs'; // attachment id → { id, notes: [noteId, …] } — refcount without scanning markdown
    const TRASH_MS = 30 * 864e5;          // Trash keeps a note for 30 days
    const REV_EVERY = 10 * 60 * 1000;     // at most one automatic version per 10 minutes of writing
    const REV_KEEP = 60;                  // versions kept per note (oldest are dropped first)
    const REV_KEEP_BIG = 20;              // … for very long notes, to protect storage
    const BIG_NOTE = 200000;              // characters
    const RECENT_MS = 7 * 864e5;   // "Recent" = edited in the last 7 days
    const PAGE = 200;              // rows rendered per "page" in the library
    const SAVE_DELAY = 700;
    // A backup is only "full" if it carries every IndexedDB store the vault actually uses —
    // notes alone silently drops version history and file links. Bumped if that shape changes.
    const BACKUP_SCHEMA = 2;   // v2 adds `attachments` (base64 image blobs) — see getBackupData
    // FileSystemFileHandle can't survive JSON (structured-clone only), so a restored file link
    // can't reopen the real file — this remembers just enough (name + when) to show a
    // "needs relinking" hint, keyed by noteId. Lives in localStorage, not IndexedDB: it is a
    // small, purely advisory hint, not vault data, so it doesn't need a DB schema bump.
    const RELINK_KEY = 'nvPendingRelinks';

    const S = {
        open: false,
        notes: [],
        scope: { kind: 'all', value: '' },   // all | recent | pinned | folder | tag
        sort: 'updated',                     // updated | created | title | words — always applied except while searching (search keeps relevance order)
        density: 'comfortable',              // comfortable | compact — list row density, see loadDensity/applyDensity
        theme: 'sakura',                     // sakura | comfort — vault-only skin, see applyTheme(); independent of the site's own dark-mode toggle
        loadError: false,                    // true if the last IndexedDB read failed — see loadVaultData()/emptyHtml()
        filters: {                           // advanced filter panel — additive (AND) on top of the current scope/search
            type: '', folder: '', tags: [],    // tags: lowercased, all must match
            createdDays: '', updatedDays: '',  // '' | '7' | '30' | '90' | '365'
            checklist: false, code: false, link: false, pinnedOnly: false
        },
        query: '',
        limit: PAGE,
        note: null,          // note open in the document view
        tabs: [], activeTab: null,   // ids of notes held open as tabs, and which tab is showing
        persisted: false,    // has S.note been written to IndexedDB yet?
        dirty: false,
        mode: 'read',        // read | edit
        inspOpen: false,
        inspTab: 'info',
        mentionsClosed: new Set(),   // note ids whose "Linked mentions" block the user collapsed this session
        sideOpen: false,
        tagsAll: false,
        outline: [],
        fmap: new Map(), tmap: new Map(),
        focus: false, fs: 5, wd: 1,
        trash: [],                     // notes in Trash (S.notes only ever holds live notes)
        fileLinks: new Map(),          // noteId → { handle, name, linkedAt } — see "File links" below
        pendingRelinks: new Map(),     // noteId → { name, linkedAt } — a link restored from backup with no usable handle
        base: null, edited: false, editStart: 0,      // what the open note looked like when opened
        renamePrompted: false,                        // guards against a second "Rename note?" dialog stacking on the first
        viewRev: null, revPrev: 'read', revs: [],     // version being previewed / previous mode / loaded versions
        toastTimer: null, toastAct: null,
        saveState: 'idle', savedAt: 0,
        saveTimer: null, derivedTimer: null, flashTimer: null,
        lastFocus: null, prevOverflow: null,
        dup: {                          // Find-duplicates panel
            open: false, scanned: false, merging: false, results: [],
            dismissed: new Set(),         // pair keys the person chose "Keep both" on (this session only)
            swapped: new Set(),           // pair keys where the person flipped which note is "kept"
            compareKey: null,             // pair key currently shown in the Compare view, or null for the list
            prevFocus: null
        },
        fr: {                           // Find & Replace panel
            open: false, find: '', repl: '', scope: '', caseI: true, word: false, accents: false, md: false,
            rows: [], total: 0, skip: new Set(), confirm: null, undo: null, cur: null, busy: false,
            snapped: new Set(), timer: 0, pendingIn: false, prevFocus: null
        },
        stor: { open: false, prevFocus: null, tab: 'overview', imgSort: 'size', imgFilter: 'all', fileSort: 'size', fileFilter: 'all', objectUrls: [], selMode: false, sel: new Set(), fSelMode: false, fSel: new Map() },   // Manage storage panel
        linkPicker: { open: false, type: '', id: '', title: '', career: '', query: '', prevFocus: null },
        storageStats: null,                       // last getVaultStorageStats() result, cached for the compact indicator + panel
        noteAttachRefCache: new Map(),            // noteId → Set(attachment id) last synced to attachmentRefs — lets flushSave diff cheaply
        attachmentCache: new Map(),               // attachment id → last-known-good record for the current session
        attachObjectUrls: []                      // blob: URLs handed to <img> in the current Read view, revoked on the next render
    };
    let el = null;

    const $ = (id) => document.getElementById(id);
    const mq = (q) => window.matchMedia(q).matches;

    /* ───────── IndexedDB ───────── */
    let dbPromise = null;
    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'id' });
                    store.createIndex('updatedAt', 'updatedAt');
                    store.createIndex('type', 'type');
                    store.createIndex('pinned', 'pinned');
                }
                if (!db.objectStoreNames.contains(DB_REV)) {
                    const rs = db.createObjectStore(DB_REV, { keyPath: 'id' });
                    rs.createIndex('noteAt', ['noteId', 'savedAt']);
                }
                if (!db.objectStoreNames.contains(DB_LINKS)) {
                    db.createObjectStore(DB_LINKS, { keyPath: 'id' });   // note id → { handle, name, linkedAt }
                }
                if (!db.objectStoreNames.contains(DB_ATTACH)) {
                    const as = db.createObjectStore(DB_ATTACH, { keyPath: 'id' });
                    as.createIndex('hash', 'hash');   // dedupe: same compressed bytes → same record, no matter how many notes paste it
                }
                if (!db.objectStoreNames.contains(DB_ATTACH_REFS)) {
                    db.createObjectStore(DB_ATTACH_REFS, { keyPath: 'id' });   // id = attachment id
                }
            };
            req.onsuccess = () => {
                const db = req.result;
                // if another tab needs to upgrade the database later, step aside instead of blocking it
                db.onversionchange = () => { db.close(); dbPromise = null; };
                resolve(db);
            };
            req.onblocked = () => {
                console.warn('Notes Vault: database upgrade is waiting for other tabs of this app to close.');
                if (el && el.storage) el.storage.textContent = 'Close other tabs of this app to finish updating';
            };
            req.onerror = () => { dbPromise = null; reject(req.error); };
        });
        return dbPromise;
    }
    async function dbPut(note) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(note);
            tx.oncomplete = () => resolve(note);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }
    async function dbGetAll() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(STORE).objectStore(STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }
    async function dbDelete(id) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    /* ───────── File links: "keep linked to this file" ─────────
       A note can remember a FileSystemFileHandle it was saved to (Save .md to disk…), so a
       later "Save changes to file" writes straight back to that same file, no dialog. Chromium
       can structured-clone a handle into IndexedDB, so the link survives a reload; Firefox/Safari
       don't support the File System Access API at all, so linking is simply unavailable there. */
    const FS_SUPPORTED = typeof window.showSaveFilePicker === 'function';
    async function dbPutLink(rec) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DB_LINKS, 'readwrite');
            tx.objectStore(DB_LINKS).put(rec);
            tx.oncomplete = () => resolve(rec);
            tx.onerror = () => reject(tx.error);
        });
    }
    async function dbDeleteLink(id) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DB_LINKS, 'readwrite');
            tx.objectStore(DB_LINKS).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    async function dbGetAllLinks() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(DB_LINKS).objectStore(DB_LINKS).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    /* ───────── Attachments: blob store + reference counts ─────────
       Two stores: `attachments` holds the actual Blob records (content-addressed by SHA-256,
       so pasting the same image twice — even into different notes — reuses one row), and
       `attachmentRefs` holds which live note ids AND which stored version-history (revision)
       ids currently reference each attachment id, kept up to date by syncAttachmentRefs() on
       every save and by snapshot()/revDeleteKeys() for revisions. Garbage collection
       (pruneOrphanAttachments) only deletes an attachment once BOTH lists are empty — a note
       can delete an image from its current text while an older revision still needs it, and
       that revision must be able to render until it's itself pruned or the note is purged. */
    async function dbPutAttachment(rec) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DB_ATTACH, 'readwrite');
            tx.objectStore(DB_ATTACH).put(rec);
            tx.oncomplete = () => resolve(rec);
            tx.onerror = () => reject(tx.error);
        });
    }
    async function dbGetAttachment(id) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(DB_ATTACH).objectStore(DB_ATTACH).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }
    async function dbDeleteAttachment(id) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DB_ATTACH, 'readwrite');
            tx.objectStore(DB_ATTACH).delete(id);
            tx.oncomplete = () => { S.attachmentCache.delete(id); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
    }
    async function dbGetAllAttachments() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(DB_ATTACH).objectStore(DB_ATTACH).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }
    async function dbFindAttachmentByHash(hash) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(DB_ATTACH).objectStore(DB_ATTACH).index('hash').get(hash);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }
    async function dbGetAttachmentRefs(id) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(DB_ATTACH_REFS).objectStore(DB_ATTACH_REFS).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }
    async function dbPutAttachmentRefs(rec) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DB_ATTACH_REFS, 'readwrite');
            tx.objectStore(DB_ATTACH_REFS).put(rec);
            tx.oncomplete = () => resolve(rec);
            tx.onerror = () => reject(tx.error);
        });
    }
    async function dbDeleteAttachmentRefs(id) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DB_ATTACH_REFS, 'readwrite');
            tx.objectStore(DB_ATTACH_REFS).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    async function dbGetAllAttachmentRefs() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(DB_ATTACH_REFS).objectStore(DB_ATTACH_REFS).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }
    async function dbGetRevision(id) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(DB_REV).objectStore(DB_REV).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function loadAllLinks() {
        if (!FS_SUPPORTED) { S.fileLinks = new Map(); return; }
        try { S.fileLinks = new Map((await dbGetAllLinks()).map((r) => [r.id, r])); }
        catch (e) { console.warn('Notes Vault: could not load file links', e); S.fileLinks = new Map(); }
    }
    async function verifyWritePermission(handle) {
        const opts = { mode: 'readwrite' };
        try {
            if ((await handle.queryPermission(opts)) === 'granted') return true;
            if ((await handle.requestPermission(opts)) === 'granted') return true;
        } catch (e) { /* handle may be stale — treat as not granted */ }
        return false;
    }
    async function writeToHandle(handle, content) {
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
    }
    // Create the link (from a fresh Save As) or refresh it after a successful write.
    async function setLinkedFile(noteId, handle) {
        const rec = { id: noteId, handle, name: handle.name, linkedAt: Date.now() };
        S.fileLinks.set(noteId, rec);
        try { await dbPutLink(rec); } catch (e) { console.warn('Notes Vault: could not remember file link', e); }
        clearPendingRelink(noteId);   // a real handle now exists — the "needs relinking" hint is stale
        return rec;
    }
    async function clearLinkedFile(noteId) {
        S.fileLinks.delete(noteId);
        try { await dbDeleteLink(noteId); } catch (e) { /* ignore */ }
    }

    /* ───────── Pending relinks: file links restored from a backup ─────────
       A backup can only carry a file link's name and timestamp (see getBackupData below) —
       never a working handle. After restore, the note remembers "this used to be linked to
       X" here until the person re-links it via Save .md, at which point setLinkedFile clears
       the hint again. */
    function loadPendingRelinks() {
        try {
            const raw = JSON.parse(localStorage.getItem(RELINK_KEY) || '{}');
            S.pendingRelinks = new Map(Object.entries(raw).map(([id, v]) => [id, v]));
        } catch (e) { S.pendingRelinks = new Map(); }
    }
    function savePendingRelinks() {
        try { localStorage.setItem(RELINK_KEY, JSON.stringify(Object.fromEntries(S.pendingRelinks))); }
        catch (e) { /* best-effort — a full localStorage shouldn't block anything else */ }
    }
    function setPendingRelink(noteId, name, linkedAt) {
        if (S.fileLinks.has(noteId)) return;   // a real, working link already exists — don't shadow it
        S.pendingRelinks.set(noteId, { name: name || '', linkedAt: linkedAt || 0 });
        savePendingRelinks();
    }
    function clearPendingRelink(noteId) {
        if (!S.pendingRelinks.has(noteId)) return;
        S.pendingRelinks.delete(noteId);
        savePendingRelinks();
    }

    /* ───────── Small helpers ───────── */
    const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
    const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'nv-' + Date.now() + '-' + Math.random().toString(16).slice(2);

    const normType = (t) => ((t || '').trim() || 'General');
    const typeKey = (t) => normType(t).toLowerCase();
    // Looser "same folder?" test used only when a folder name is being CHOSEN (new folder, move,
    // folder box): ignores case, accents (Tài chính = Tai chinh), repeated spaces and - _ separators.
    // Existing notes/folder styles keep their exact typeKey, so nothing already saved is regrouped.
    const looseFolderKey = (t) => normType(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u0111/gi, 'd')
        .replace(/[\s_\-\u2013\u2014]+/g, ' ').trim().toLowerCase();
    // The established folder (most notes) that a typed name would duplicate, or null.
    function findExistingFolder(name) {
        const k = looseFolderKey(name);
        let best = null;
        for (const f of S.fmap.values()) if (looseFolderKey(f.label) === k && (!best || f.count > best.count)) best = f;
        return best ? best.label : null;
    }
    const normTag = (t) => String(t || '').trim().replace(/^#+/, '').trim();

    function normalizeNote(n) {
        n.title = typeof n.title === 'string' ? n.title : '';
        n.markdown = typeof n.markdown === 'string' ? n.markdown : '';
        n.type = normType(n.type);
        n.tags = Array.isArray(n.tags) ? n.tags.map(normTag).filter(Boolean) : [];
        n.pinned = !!n.pinned;
        n.deletedAt = +n.deletedAt || 0;      // 0 = live note, otherwise the moment it went to Trash
        n.createdAt = +n.createdAt || Date.now();
        n.updatedAt = +n.updatedAt || n.createdAt;
        // Tracker link (Note ↔ Skill): linkedCareer is a key in the global skillsData map,
        // linkedSkill must match a skill's exact `name` string within that career. course/
        // deadline are free-form and don't need to resolve against anything.
        n.linkedCareer = typeof n.linkedCareer === 'string' ? n.linkedCareer : '';
        n.linkedSkill = typeof n.linkedSkill === 'string' ? n.linkedSkill : '';
        n.course = typeof n.course === 'string' ? n.course : '';
        n.deadline = typeof n.deadline === 'string' ? n.deadline : '';
        // Reminder (local time, 'YYYY-MM-DDTHH:MM'); remindState 'fired' = it went off and is still waiting for you.
        n.remindAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(n.remindAt) ? String(n.remindAt).slice(0, 16) : '';
        n.remindState = n.remindAt && n.remindState === 'fired' ? 'fired' : '';
        // Course link (Note ↔ Courses tracker): the `course` text above stays free-form (so
        // typing an ad-hoc course name still works), but when it exactly matches a real entry
        // in the Courses tracker, linkedCourseId holds that course's id — see resolveCourseLink
        // and the CoursesAPI bridge (window.CoursesAPI, exposed by the Tracker script).
        n.linkedCourseId = typeof n.linkedCourseId === 'string' ? n.linkedCourseId : '';
        // Resource link (Note ↔ Resource Library): same pattern as course — `resource` is a
        // free-form text label (kept for graceful degradation if the resource is later
        // deleted), and linkedResourceId holds the real id when it matches an entry in the
        // global `resourceLibrary` array. See resolveResourceLink / nvLinkedResourceLive.
        n.resource = typeof n.resource === 'string' ? n.resource : '';
        n.linkedResourceId = typeof n.linkedResourceId === 'string' ? n.linkedResourceId : '';
        // Investment Analysis link (Note ↔ Investment Analysis): same pattern again —
        // `analysis` is a free-form text label (kept for graceful degradation if the
        // analysis is later deleted), and linkedAnalysisId holds the real id when it
        // matches an entry in the global `investmentAnalyses` array. See
        // resolveAnalysisLink / nvLinkedAnalysisLive.
        n.analysis = typeof n.analysis === 'string' ? n.analysis : '';
        n.linkedAnalysisId = typeof n.linkedAnalysisId === 'string' ? n.linkedAnalysisId : '';
        // Deal Diary link (Note ↔ Deal Diary): same pattern again — `deal` is a
        // free-form text label (kept for graceful degradation if the deal is later
        // deleted), and linkedDealId holds the real id when it matches an entry in
        // the global `dealDiary` array. See resolveDealLink / nvLinkedDealLive.
        n.deal = typeof n.deal === 'string' ? n.deal : '';
        n.linkedDealId = typeof n.linkedDealId === 'string' ? n.linkedDealId : '';
        // Map relations — set by hand (Info tab → Map relations, or the Map's "Set a relation"), drawn by the Map.
        // mapParent: id of the note this one is a sub-note of · mapOrder: place among its siblings ·
        // mapLinks: [{ id, label }] free connections to other notes. (Not the same thing as links[] below.)
        n.mapParent = typeof n.mapParent === 'string' ? n.mapParent : '';
        n.mapOrder = +n.mapOrder >= 0 ? +n.mapOrder : 0;
        n.mapLinks = Array.isArray(n.mapLinks)
            ? n.mapLinks.filter((l) => l && typeof l.id === 'string' && l.id).map((l) => ({ id: l.id, label: typeof l.label === 'string' ? l.label : '' }))
            : [];
        // Unified links[] view — always rebuilt from the legacy fields above, so the two can
        // never drift out of sync. See EntityLinks below: it's the single place that knows how
        // to read/write an "entity link" (skill/course/resource/analysis/deal, and any type
        // added later), while the legacy per-type fields keep working underneath as the
        // on-disk shape — nothing that reads them directly (YAML export, backups, the Tracker/
        // Courses/Resource/Analysis/Deal bridges) has to change.
        rebuildLinksFromLegacy(n);
        return n;
    }
    // Rebuilds n.links from the legacy per-type fields — the legacy fields are the source of
    // truth on disk; links[] is a derived, always-fresh view over them. Called from
    // normalizeNote (on every load) and from EntityLinks.link/unlink (so links[] updates
    // immediately in-session, without waiting for a reload).
    function rebuildLinksFromLegacy(n) {
        const links = [];
        if (n.linkedSkill) links.push({ type: 'skill', id: n.linkedSkill, career: n.linkedCareer || '' });
        if (n.linkedCourseId) links.push({ type: 'course', id: n.linkedCourseId });
        if (n.linkedResourceId) links.push({ type: 'resource', id: n.linkedResourceId });
        if (n.linkedAnalysisId) links.push({ type: 'analysis', id: n.linkedAnalysisId });
        if (n.linkedDealId) links.push({ type: 'deal', id: n.linkedDealId });
        n.links = links;
        return n;
    }
    // Writes an entity link's legacy fields — the one place per type that knows which
    // flat field(s) that type maps to. `skill` is composite (career + skill name); a skill
    // unlink deliberately leaves linkedCareer alone (picking a career without a skill yet is
    // valid mid-edit state — see the linkedCareer change handler below).
    function syncLegacyLink(note, type, id, meta) {
        if (type === 'skill') {
            note.linkedSkill = id || '';
            if (id && meta && meta.career) note.linkedCareer = meta.career;
            return;
        }
        const field = { course: 'linkedCourseId', resource: 'linkedResourceId', analysis: 'linkedAnalysisId', deal: 'linkedDealId' }[type];
        if (field) note[field] = id || '';
    }
    /* ───────── EntityLinks: the one API for note ↔ other-entity links ─────────
       Replaces the old pattern of bolting on a new `linkedXId` field (plus its own resolver,
       pill renderer, dropdown wiring, and count function) every time a new linkable entity
       type shows up. A link is `{ type, id, ...meta }` living in note.links; today's five
       types (skill/course/resource/analysis/deal) are single-value (one link per type per
       note), so `link()` replaces any existing entry of that type — getLinked() still returns
       an array so a future multi-valued type (e.g. multiple linked Projects) needs no API
       change, just a registry entry (see RESOLVERS below) and its own pill renderer.
       Legacy per-type fields (linkedCourseId, etc.) are kept in lockstep by syncLegacyLink, so
       nothing else in the app — YAML export, backups, the Tracker/Courses/Resource/Analysis/
       Deal "badge" bridges — needs to change to keep working. */
    const EntityLinks = {
        TYPES: ['skill', 'course', 'resource', 'analysis', 'deal'],
        // Sets (or, with a falsy id, clears) the single link of `type` on `note`. `meta` carries
        // type-specific extra context — currently just { career } for `skill`.
        link(note, type, id, meta = {}) {
            if (!note) return note;
            syncLegacyLink(note, type, id, meta);
            rebuildLinksFromLegacy(note);
            return note;
        },
        unlink(note, type) { return this.link(note, type, ''); },
        getLinked(note, type) {
            return (note && Array.isArray(note.links) ? note.links : []).filter((l) => l.type === type);
        },
        getEntry(note, type) { return this.getLinked(note, type)[0] || null; },
        getId(note, type) { const e = this.getEntry(note, type); return e ? e.id : ''; },
        has(note, type, id) { return this.getLinked(note, type).some((l) => l.id === id); },
        count(note) { return (note && Array.isArray(note.links)) ? note.links.length : 0; },
        // Same lookup as getId, but for a raw IndexedDB record that may predate normalizeNote
        // (used by the getXLinkCounts family, which reads straight from the DB so the other
        // trackers can ask "how many notes link to me?" before the Notes Vault overlay has
        // ever been opened in this session). Read-only — never mutates the raw record.
        idFromRaw(raw, type) {
            if (Array.isArray(raw.links)) {
                const hit = raw.links.find((l) => l.type === type);
                if (hit) return hit.id;
            }
            const field = { skill: 'linkedSkill', course: 'linkedCourseId', resource: 'linkedResourceId', analysis: 'linkedAnalysisId', deal: 'linkedDealId' }[type];
            return (field && raw[field]) || '';
        },
        // Resolves a link to its live entity in the relevant global array/map, or null if the
        // linked entity was since deleted/renamed. Registry so adding a new type later means
        // adding one entry here, not a new bespoke resolver function.
        resolve(note, type) {
            const entry = this.getEntry(note, type);
            if (!entry) return null;
            const r = EntityLinks.RESOLVERS[type];
            return r ? r(entry, note) : null;
        },
        RESOLVERS: {
            skill: (entry) => {
                if (typeof skillsData === 'undefined') return null;
                const career = skillsData[entry.career];
                if (!career) return null;
                const found = Object.values(career.categories || {}).some((cat) =>
                    (cat.skills || []).some((sk) => sk.name === entry.id));
                return found ? { id: entry.id, career: entry.career, name: entry.id } : null;
            },
            course: (entry) => (typeof courses !== 'undefined') ? (courses.find((c) => c.id === entry.id) || null) : null,
            resource: (entry) => (typeof resourceLibrary !== 'undefined') ? (resourceLibrary.find((r) => r.id == entry.id) || null) : null,
            analysis: (entry) => (typeof investmentAnalyses !== 'undefined') ? (investmentAnalyses.find((a) => a.id == entry.id) || null) : null,
            deal: (entry) => (typeof dealDiary !== 'undefined') ? (dealDiary.find((d) => d.id == entry.id) || null) : null
        }
    };

    /* ───────── Content detection (drives the Type filter, the Contains-X checkboxes,
       and Sort-by-word-count) — cheap regex checks, no markdown parsing needed. ───────── */
    const wordCount = (md) => (md.match(/\S+/g) || []).length;
    const hasChecklistSyntax = (md) => /^[ \t]*[-*+]\s\[[ xX]\]/m.test(md || '');
    const hasCodeSyntax = (md) => (md || '').includes('```');
    const hasLinkSyntax = (md) => /\[[^\]]+\]\(\S+?\)/.test(md || '') || /https?:\/\/\S+/i.test(md || '');
    // A note's overall "Type" for the filter dropdown — priority order below, first match wins.
    function contentKind(n) {
        const md = n.markdown || '';
        if (hasCodeSyntax(md)) return 'code';
        if (hasChecklistSyntax(md)) return 'checklist';
        if (hasLinkSyntax(md)) return 'link';
        return 'text';
    }

    function filtersActive() {
        const f = S.filters;
        return !!(f.type || f.folder || f.tags.length || f.createdDays || f.updatedDays || f.checklist || f.code || f.link || f.pinnedOnly);
    }
    function passesFilters(n) {
        const f = S.filters;
        if (f.pinnedOnly && !n.pinned) return false;
        if (f.folder && typeKey(n.type) !== f.folder) return false;
        if (f.tags.length) {
            const have = n.tags.map((t) => t.toLowerCase());
            for (const t of f.tags) if (!have.includes(t)) return false;
        }
        if (f.type && contentKind(n) !== f.type) return false;
        if (f.checklist && !hasChecklistSyntax(n.markdown)) return false;
        if (f.code && !hasCodeSyntax(n.markdown)) return false;
        if (f.link && !hasLinkSyntax(n.markdown)) return false;
        if (f.createdDays && n.createdAt < Date.now() - Number(f.createdDays) * 864e5) return false;
        if (f.updatedDays && n.updatedAt < Date.now() - Number(f.updatedDays) * 864e5) return false;
        return true;
    }
    // Pinned notes always float to the top; S.sort only decides the order within/below that.
    function sortList(list) {
        const cmp = {
            updated: (a, b) => b.updatedAt - a.updatedAt,
            created: (a, b) => b.createdAt - a.createdAt,
            title: (a, b) => (a.title.trim() || 'Untitled note').localeCompare(b.title.trim() || 'Untitled note', undefined, { sensitivity: 'base', numeric: true }),
            words: (a, b) => wordCount(b.markdown) - wordCount(a.markdown)
        }[S.sort] || ((a, b) => b.updatedAt - a.updatedAt);
        list.sort((a, b) => (b.pinned - a.pinned) || cmp(a, b));
        return list;
    }

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad2 = (x) => String(x).padStart(2, '0');
    const clock = (ts) => { const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
    function fmtRel(ts) {
        if (!ts) return '';
        const d = new Date(ts), now = new Date();
        const mins = Math.floor((now - d) / 60000);
        if (mins < 1) return 'Just now';
        if (mins < 60) return mins + ' min ago';
        if (d.toDateString() === now.toDateString()) return 'Today ' + clock(ts);
        const y = new Date(now); y.setDate(now.getDate() - 1);
        if (d.toDateString() === y.toDateString()) return 'Yesterday';
        const base = d.getDate() + ' ' + MONTHS[d.getMonth()];
        return d.getFullYear() === now.getFullYear() ? base : base + ' ' + d.getFullYear();
    }
    const fmtFull = (ts) => { const d = new Date(ts); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + clock(ts); };
    // Deadline is stored as a plain "YYYY-MM-DD" (no time-of-day, no timezone conversion —
    // parsing it as local midnight the way fmtFull/clock would could roll it back a day).
    const nvFmtDate = (dateStr) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
        if (!m) return dateStr || '';
        return String(+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1];
    };
    function fmtBytes(b) {
        if (b < 1048576) return Math.max(1, Math.round(b / 1024)) + ' KB';
        if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
        return (b / 1073741824).toFixed(1) + ' GB';
    }
    /* ═════════════ Storage accounting ═════════════
       navigator.storage.estimate() only ever gives the whole origin's usage/quota — it can't
       break that down by IndexedDB store, and there is no browser API that can (no
       indexedDB.getStoreSize()-style call exists anywhere). So notesBytes/revisionsBytes below
       are an ESTIMATE — the serialized size of every record — not a measurement, and the UI
       must say "estimated" rather than imply precision it doesn't have. Attachments (once that
       store exists) are the one part of this that CAN be exact, since every stored Blob already
       carries a real blob.size. */
    function roughSize(obj) {
        try { return JSON.stringify(obj).length * 2; } catch (e) { return 0; }   // UTF-16 code units ≈ bytes, close enough for an estimate
    }
    // The single source of truth for "where did the storage go" — used by both the compact
    // sidebar indicator and the Manage storage panel, and reusable as-is once attachments ship
    // (attachmentsBytes just stops being hardcoded to 0).
    async function getVaultStorageStats() {
        let browser = { usage: 0, quota: 0, supported: false };
        if (navigator.storage && navigator.storage.estimate) {
            try {
                const { usage, quota } = await navigator.storage.estimate();
                browser = { usage: usage || 0, quota: quota || 0, supported: true };
            } catch (e) { /* unsupported in this context (e.g. some private-browsing modes) */ }
        }
        let lsBytes = 0;
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                lsBytes += (k.length + (localStorage.getItem(k) || '').length) * 2;
            }
        } catch (e) { /* private mode, blocked storage, etc. */ }
        let notesBytes = 0, revisionsBytes = 0;
        try { notesBytes = (await dbGetAll()).reduce((sum, n) => sum + roughSize(n), 0); }
        catch (e) { console.warn('Notes Vault: could not estimate notes size', e); }
        try { revisionsBytes = (await dbGetAllRevisions()).reduce((sum, r) => sum + roughSize(r), 0); }
        catch (e) { console.warn('Notes Vault: could not estimate version-history size', e); }
        let attachmentsBytes = 0;
        try { attachmentsBytes = (await dbGetAllAttachments()).reduce((sum, a) => sum + (a.size || 0), 0); }   // exact — every Blob carries a real .size
        catch (e) { console.warn('Notes Vault: could not size attachments', e); }
        const estimatedBytes = notesBytes + revisionsBytes + attachmentsBytes + lsBytes;
        const percent = browser.supported && browser.quota ? Math.min(100, Math.round((browser.usage / browser.quota) * 100)) : 0;
        const freeBytes = browser.supported && browser.quota ? Math.max(0, browser.quota - browser.usage) : 0;
        return {
            browser,
            localStorage: { bytes: lsBytes },
            vault: { notesBytes, revisionsBytes, attachmentsBytes },
            totals: { estimatedBytes, freeBytes, percent }
        };
    }
    // Quota guard: five bands from "not worth mentioning" to "about to fail". blockAttachments
    // is exposed now (even with no attachments feature yet) so Attachment Core can gate on it
    // from day one instead of re-deriving these thresholds. Never gates note-taking itself —
    // only ever a signal, text stays saved even past 95%.
    function getStorageHealth(percent) {
        if (percent > 95) return { level: 'near-full', label: 'Near full', blockAttachments: true };
        if (percent > 90) return { level: 'critical', label: 'Critical', blockAttachments: false };
        if (percent > 80) return { level: 'warning', label: 'Warning', blockAttachments: false };
        if (percent > 70) return { level: 'normal', label: 'Normal', blockAttachments: false };
        return { level: 'healthy', label: 'Healthy', blockAttachments: false };
    }
    function noteAttachmentOriginWarning() {
        if (location.protocol !== 'file:' || !el || !el.toastTxt) return;
        console.warn('Notes Vault: attachments use IndexedDB. file:// origins are browser-dependent; use a local HTTP server for reliable persistent storage.');
        setTimeout(() => toast('Attachments use browser storage. For reliable persistence, open this HTML through localhost rather than file://.'), 250);
    }

    function storageHealthMessage(percent, health) {
        switch (health.level) {
            case 'warning': return 'Storage ' + percent + '% — consider exporting a backup.';
            case 'critical': return 'Storage ' + percent + '% — large files may fail to save.';
            // No attachments feature exists yet, so this doesn't promise one — once Attachment
            // Core ships, it can read health.blockAttachments and say so here.
            case 'near-full': return 'Storage ' + percent + '% — back up soon, space is nearly gone.';
            default: return 'Storage ' + percent + '%';
        }
    }

    /* ═════════════ Attachments: ingest pipeline ═════════════
       Paste → validate → resize (never upscale) → WebP-compress → SHA-256 the compressed
       bytes → dedupe against the `attachments` store by hash → save Blob → caller wires up
       an `attachment://<id>` markdown reference. Keeping the record itself tiny (no note ids,
       no extra metadata) means the dedupe key and the stored bytes are the same object — a
       second paste of an already-seen image is a single indexed lookup, not a new row. */
    const ATTACH_MAX_DIM = 4096;                      // px, longest side — keeps full-resolution screenshots (iPhone ~2532px, Retina Mac ~2880px) sharp
    const ATTACH_MAX_SOURCE_BYTES = 25 * 1024 * 1024; // reject absurdly large pastes before even decoding them
    const ATTACH_WEBP_QUALITY = 0.92;                 // lossy fallback, only used when it is clearly smaller than lossless
    const ATTACH_LOSSY_PICK_RATIO = 0.4;              // use lossy only if it is < 40% of the lossless size (photos/gradients); screenshots/text stay pixel-exact

    function attachError(message) { const e = new Error(message); e.__attach = true; return e; }

    // Decode + resize (never upscale) + WebP-compress. Shared by ingestAttachment (from a File)
    // and optimizeAttachments (re-encoding an already-stored Blob), so both paths always produce
    // bit-for-bit the same kind of output for the same settings.
    async function encodeAttachmentImage(source) {
        const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
        const scale = Math.min(1, ATTACH_MAX_DIM / Math.max(bitmap.width, bitmap.height));
        const outW = Math.max(1, Math.round(bitmap.width * scale));
        const outH = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = outW; canvas.height = outH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, outW, outH);
        if (bitmap.close) bitmap.close();
        // Encode lossless first (pixel-exact: sharp text in screenshots). If the browser really produced WebP,
        // also try lossy and keep it only when it is much smaller (photos, gradients) — never blur a screenshot.
        const encodeWebp = (q) => new Promise((res) => canvas.toBlob(res, 'image/webp', q));
        let blob = await encodeWebp(1);
        if (blob && blob.type === 'image/webp') {
            const lossy = await encodeWebp(ATTACH_WEBP_QUALITY);
            if (lossy && lossy.type === 'image/webp' && lossy.size < blob.size * ATTACH_LOSSY_PICK_RATIO) blob = lossy;
        }
        if (!blob) {   // encoding failed outright — fall back to whatever the canvas can produce
            blob = await new Promise((res) => canvas.toBlob(res));
        }
        if (!blob) return null;
        const mime = blob.type || 'image/png';   // Safari can't encode WebP and silently returns PNG: label it truthfully
        return { blob, mime, width: outW, height: outH };
    }
    // Stored image (usually WebP) → lossless PNG at its full stored size. The system clipboard only takes PNG for images,
    // so "Copy" needs this; PNG is lossless, so pasting into Word / chat apps loses nothing.
    async function attachmentBlobToPng(blob) {
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
        const out = await new Promise((res) => c.toBlob(res, 'image/png'));
        c.width = c.height = 0;
        if (!out) throw new Error('PNG encode failed');
        return out;
    }
    async function hashBlob(blob) {
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Blob <-> base64, used only to embed attachment images inside the JSON backup (see
    // getBackupData / restoreAttachmentsList below). Chunked so a large screenshot's bytes
    // don't blow the call stack via String.fromCharCode.apply(null, hugeArray).
    async function blobToBase64(blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        return btoa(binary);
    }
    function base64ToBlob(b64, mime) {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mime || 'application/octet-stream' });
    }

    // A PDF is stored as-is — no resize/re-encode step makes sense for it the way it does for
    // an image, so this is a thin sibling of the image path below: hash the raw bytes, dedupe
    // against the same `attachments` store, save the Blob untouched, verify it reads back.
    // Kept in the same store/id-space as images (content-addressed by SHA-256) so ref-counting,
    // storage accounting and backup/restore all work on PDFs for free, with no code of their own.
    // Spreadsheets (.xlsx/.xls/.csv…) ride the same pipeline as PDFs: stored byte-for-byte,
    // content-addressed, ref-counted, backed up. The MIME is derived from the extension because
    // browsers often report an empty file.type for Excel files.
    const SHEET_EXT = {
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
        xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
        xls: 'application/vnd.ms-excel',
        csv: 'text/csv',
        ods: 'application/vnd.oasis.opendocument.spreadsheet'
    };
    function sheetMimeOf(file) {
        if (!file) return null;
        const m = /\.([a-z0-9]+)$/i.exec(file.name || '');
        if (m && SHEET_EXT[m[1].toLowerCase()]) return SHEET_EXT[m[1].toLowerCase()];
        return Object.values(SHEET_EXT).indexOf(file.type) !== -1 ? file.type : null;
    }
    function isSheetMime(mime) { return Object.values(SHEET_EXT).indexOf(mime) !== -1; }

    /* ── Attachment text index ──
       The words inside an attached spreadsheet / PDF are extracted once (SheetJS / pdf.js, both loaded
       lazily and cached) and stored on the attachment record as `text` (+ `textV`). They are kept in
       memory in S.attText (id → { raw, fold }) and searched together with the note that embeds the
       file. Files attached before this existed are indexed quietly in the background. ── */
    S.attText = new Map(); S.attVer = 0;
    const ATT_TEXT_MAX = 400000, ATT_PDF_PAGES = 150;
    const attIsIndexable = (mime) => mime === 'application/pdf' || isSheetMime(mime);
    const attIdsOf = (n) => { const ids = []; String(n.markdown || '').replace(/attachment:\/\/(att_[a-f0-9]+)/g, (m, id) => { if (ids.indexOf(id) < 0) ids.push(id); return m; }); return ids; };
    async function attExtractText(rec) {
        let out = '';
        if (rec.mime === 'application/pdf') {
            const pdfjs = await loadPdfJs();
            const doc = await pdfjs.getDocument({ data: new Uint8Array(await rec.blob.arrayBuffer()) }).promise;
            try {
                const pages = Math.min(doc.numPages, ATT_PDF_PAGES);
                for (let i = 1; i <= pages && out.length < ATT_TEXT_MAX; i++) {
                    const tc = await (await doc.getPage(i)).getTextContent();
                    out += tc.items.map((it) => it.str || '').join(' ') + '\n';
                }
            } finally { try { doc.destroy(); } catch (e) { /* ignore */ } }
        } else {
            const X = await loadSheetJs();
            const wb = rec.mime === 'text/csv'
                ? X.read(await rec.blob.text(), { type: 'string' })
                : X.read(await rec.blob.arrayBuffer(), { type: 'array', cellDates: true });
            for (const name of (wb.SheetNames || [])) {
                if (out.length >= ATT_TEXT_MAX) break;
                out += name + '\n' + X.utils.sheet_to_csv(wb.Sheets[name], { FS: ' ', blankrows: false }) + '\n';
            }
        }
        return out.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').slice(0, ATT_TEXT_MAX);
    }
    function attRemember(id, text) {
        const raw = String(text || '').normalize('NFC');
        if (raw) S.attText.set(id, { raw, fold: fold(raw) }); else S.attText.delete(id);
        S.attVer++;
    }
    // Index one attachment record. A library-load failure (offline) propagates so callers can stop;
    // a file that simply can't be read is marked done (textV -1) so it isn't retried forever.
    async function attIndexRecord(rec) {
        if (!rec || rec.textV || !attIsIndexable(rec.mime) || !(rec.blob instanceof Blob)) return false;
        let text = '', textV = 1;
        try { text = await attExtractText(rec); }
        catch (e) {
            if (/couldn.t load|reader unavailable|Failed to fetch|import|NetworkError|dynamically imported/i.test(String(e && e.message || e))) throw e;
            textV = -1;
        }
        const fresh = (await dbGetAttachment(rec.id)) || rec;
        fresh.text = text; fresh.textV = textV;
        await dbPutAttachment(fresh);
        rec.text = text; rec.textV = textV;
        attRemember(rec.id, text);
        return !!text;
    }
    const attPending = new Set();
    function attIndexSoon(rec) {   // fire-and-forget right after an attach
        if (!rec || rec.textV || attPending.has(rec.id) || !attIsIndexable(rec.mime)) return;
        attPending.add(rec.id);
        attIndexRecord(rec).catch((e) => console.warn('Notes Vault: could not index attachment text', e)).finally(() => attPending.delete(rec.id));
    }
    let attBackfillStarted = false;
    async function attLoadIndex() {
        const recs = await dbGetAllAttachments();
        const todo = [];
        for (const r of recs) {
            if (r.text) attRemember(r.id, r.text);
            else if (!r.textV && attIsIndexable(r.mime)) todo.push(r);
        }
        if (attBackfillStarted || !todo.length) return;
        attBackfillStarted = true;
        setTimeout(async () => {
            let done = 0;
            for (const r of todo) {
                if (attPending.has(r.id)) continue;
                try { if (await attIndexRecord(r)) done++; }
                catch (e) { console.warn('Notes Vault: attachment indexing paused (offline?)', e); break; }
                await new Promise((res) => setTimeout(res, 800));   // keep the UI responsive
            }
            if (done) toast('Indexed ' + done + ' attached file' + (done === 1 ? '' : 's') + ' \u2014 their contents are now searchable.');
        }, 6000);
    }
    // A short excerpt from inside an attached file, for a search hit that exists only there.
    function attSnippet(n, tokens) {
        for (const id of attIdsOf(n)) {
            const a = S.attText.get(id);
            if (!a) continue;
            for (const t of tokens) {
                const i = findAt(a.fold, t, 0);
                if (i < 0) continue;
                const from = Math.max(0, i - 40), to = Math.min(a.raw.length, i + t.length + 80);
                return (from ? '\u2026' : '') + a.raw.slice(from, to).replace(/\s+/g, ' ') + (to < a.raw.length ? '\u2026' : '');
            }
        }
        return '';
    }

    async function ingestPdfAttachment(file, mimeOverride, defaultName) {
        const hash = await hashBlob(file);
        const existing = await dbFindAttachmentByHash(hash);
        if (existing) {
            if (existing.blob instanceof Blob && existing.blob.size > 0) {
                S.attachmentCache.set(existing.id, existing);
                attIndexSoon(existing);
                return existing;
            }
            await dbDeleteAttachment(existing.id).catch(() => {});
            await dbDeleteAttachmentRefs(existing.id).catch(() => {});
            S.attachmentCache.delete(existing.id);
        }
        const rec = {
            id: 'att_' + hash.slice(0, 24), hash, blob: file, mime: mimeOverride || 'application/pdf',
            size: file.size, filename: (file.name || defaultName || 'document.pdf').trim() || defaultName || 'document.pdf', createdAt: Date.now()
        };
        await dbPutAttachment(rec);
        const verified = await dbGetAttachment(rec.id);
        if (!verified || !(verified.blob instanceof Blob) || verified.blob.size <= 0) {
            await dbDeleteAttachment(rec.id).catch(() => {});
            throw attachError('The file could not be read back from browser storage. If this app is opened as a local file (file://), open it from a local web server instead.');
        }
        S.attachmentCache.set(rec.id, verified);
        attIndexSoon(verified);
        return verified;
    }

    async function ingestAttachment(file) {
        const isPdf = file && file.type === 'application/pdf';
        const sheetMime = sheetMimeOf(file);
        if (!file || !(/^image\//.test(file.type) || isPdf || sheetMime)) throw attachError('Only images, PDFs and spreadsheets (.xlsx, .xls, .csv) can be attached.');
        if (file.size > ATTACH_MAX_SOURCE_BYTES) throw attachError('That file is too large to attach (25\u202fMB limit).');

        // Storage guard — checked here (not just in the UI) so drag/drop and paste both respect it.
        try {
            const stats = await getVaultStorageStats();
            const health = getStorageHealth(stats.totals.percent);
            if (health.blockAttachments) throw attachError('Storage is almost full — free up space before attaching files.');
        } catch (e) { if (e && e.__attach) throw e; /* stats call itself failing shouldn't block a paste */ }

        if (isPdf) return ingestPdfAttachment(file);
        if (sheetMime) return ingestPdfAttachment(file, sheetMime, 'spreadsheet.xlsx');

        const encoded = await encodeAttachmentImage(file).catch(() => null);
        if (!encoded) throw attachError('Could not read or encode that image.');

        const hash = await hashBlob(encoded.blob);
        const existing = await dbFindAttachmentByHash(hash);
        if (existing) {
            // A stale/corrupt row must not be treated as a valid dedupe hit. Verify that the
            // actual Blob survived IndexedDB structured-cloning before reusing the record.
            if (existing.blob instanceof Blob && existing.blob.size > 0) {
                S.attachmentCache.set(existing.id, existing);
                return existing;
            }
            await dbDeleteAttachment(existing.id).catch(() => {});
            await dbDeleteAttachmentRefs(existing.id).catch(() => {});
            S.attachmentCache.delete(existing.id);
        }

        const rec = { id: 'att_' + hash.slice(0, 24), hash, blob: encoded.blob, mime: encoded.mime, size: encoded.blob.size, width: encoded.width, height: encoded.height, createdAt: Date.now() };
        await dbPutAttachment(rec);
        // Critical integrity check: do not put an attachment:// reference into the note unless
        // the browser can immediately read the Blob back. This turns a silent broken image into
        // a useful storage error and also catches browser/origin-specific IndexedDB failures.
        const verified = await dbGetAttachment(rec.id);
        if (!verified || !(verified.blob instanceof Blob) || verified.blob.size <= 0) {
            await dbDeleteAttachment(rec.id).catch(() => {});
            throw attachError('The image could not be read back from browser storage. If this app is opened as a local file (file://), open it from a local web server instead.');
        }
        S.attachmentCache.set(rec.id, verified);
        return verified;
    }

    /* ═════════════ Attachments: reference counting ═════════════ */
    const ATTACH_REF_RE = /attachment:\/\/([a-zA-Z0-9_-]+)/g;
    function extractAttachmentIds(markdown) {
        const ids = new Set();
        if (!markdown) return ids;
        ATTACH_REF_RE.lastIndex = 0;
        let m;
        while ((m = ATTACH_REF_RE.exec(markdown))) ids.add(m[1]);
        return ids;
    }
    // Adds/removes one referrer id (a note id or a revision id) from one attachment's refs
    // row, in the given list ('notes' or 'revisions'). Every place that adds or drops a
    // reference — live note edits, revision snapshots, revision pruning — funnels through
    // these two so the two lists never drift out of sync with each other's shape.
    async function addAttachmentRef(attId, kind, refId) {
        const rec = (await dbGetAttachmentRefs(attId)) || { id: attId, notes: [], revisions: [] };
        if (!rec.notes) rec.notes = [];
        if (!rec.revisions) rec.revisions = [];
        if (!rec[kind].includes(refId)) rec[kind].push(refId);
        await dbPutAttachmentRefs(rec);
    }
    async function removeAttachmentRef(attId, kind, refId) {
        const rec = await dbGetAttachmentRefs(attId);
        if (!rec) return;
        if (!rec.notes) rec.notes = [];
        if (!rec.revisions) rec.revisions = [];
        rec[kind] = rec[kind].filter((x) => x !== refId);
        await dbPutAttachmentRefs(rec);
    }
    // Diffs a note's current attachment references against what was last synced for it, and
    // only touches the attachmentRefs rows that actually changed. Called from flushSave, so it
    // runs on every persisted edit — a note that never had attachments never touches this store.
    async function syncAttachmentRefs(noteId, markdown) {
        const nextIds = extractAttachmentIds(markdown);
        const prevIds = S.noteAttachRefCache.get(noteId) || new Set();
        if (nextIds.size === prevIds.size && [...nextIds].every((id) => prevIds.has(id))) return;
        const added = [...nextIds].filter((id) => !prevIds.has(id));
        const removed = [...prevIds].filter((id) => !nextIds.has(id));
        for (const id of added) await addAttachmentRef(id, 'notes', noteId);
        for (const id of removed) await removeAttachmentRef(id, 'notes', noteId);
        S.noteAttachRefCache.set(noteId, nextIds);
    }
    // Mirrors syncAttachmentRefs but for version-history rows: called once a revision has
    // actually been written (from snapshot()), so every attachment it pictures stays "in use"
    // even after the live note's markdown moves on or drops the image entirely.
    async function addRevisionAttachmentRefs(revId, markdown) {
        for (const id of extractAttachmentIds(markdown)) await addAttachmentRef(id, 'revisions', revId).catch(() => {});
    }
    // Called just before a revision row is physically deleted (old-version pruning, restore's
    // "before-restore" cap, or wiping a note's whole history) so its attachments can go back to
    // being unreferenced once nothing — no live note, no other revision — needs them anymore.
    async function releaseRevisionAttachments(revId, markdown) {
        for (const id of extractAttachmentIds(markdown)) await removeAttachmentRef(id, 'revisions', revId).catch(() => {});
    }
    // Called when a note is permanently erased (purge / empty trash — NOT the ordinary
    // move-to-Trash, since a trashed note can still be restored with its images intact).
    // Deliberately does NOT trust S.noteAttachRefCache alone: the cache is per-session and only
    // gets populated as notes are opened/edited, so a note deleted forever right after a page
    // reload (cache empty) — or purged from Trash in a session where it was never opened — would
    // otherwise leave its attachmentRefs rows still pointing at a noteId that no longer exists.
    // That doesn't lose the image, but it does keep it invisible to pruneOrphanAttachments
    // forever (an "orphan logic" row: refs a note, but that note is gone). Instead this always
    // re-derives the ids from source: the note's own markdown (when the caller has it) plus a
    // scan of attachmentRefs for any row that still lists this noteId — so it's correct no
    // matter how many reloads happened in between. Only runs on permanent delete, so the scan
    // never touches the hot path (ordinary edits still go through the cheap cache-diffed
    // syncAttachmentRefs).
    async function releaseNoteAttachments(noteId, markdown) {
        S.noteAttachRefCache.delete(noteId);
        const ids = new Set();
        if (typeof markdown === 'string') for (const id of extractAttachmentIds(markdown)) ids.add(id);
        try {
            const allRefs = await dbGetAllAttachmentRefs();
            for (const r of allRefs) if (r.notes && r.notes.includes(noteId)) ids.add(r.id);
        } catch (e) { /* best-effort — markdown-derived ids above still get released */ }
        if (!ids.size) return;
        for (const id of ids) await removeAttachmentRef(id, 'notes', noteId).catch(() => {});
    }
    // Recomputes attachmentRefs from scratch by scanning every live note's markdown and every
    // stored revision's markdown, then reconciling that against what's currently on disk. This
    // is the repair tool for reference drift accumulated across app versions/sessions (stale
    // cache reads, an interrupted import, etc.) rather than something that runs automatically —
    // wired to a "Rebuild index" action in Manage storage, on demand only.
    async function rebuildAttachmentRefs() {
        const [notes, revisions, existingRefs] = await Promise.all([
            dbGetAll(), dbGetAllRevisions(), dbGetAllAttachmentRefs()
        ]);
        const wanted = new Map();   // attachment id → { notes: Set, revisions: Set }
        const touch = (attId, kind, refId) => {
            let e = wanted.get(attId);
            if (!e) { e = { notes: new Set(), revisions: new Set() }; wanted.set(attId, e); }
            e[kind].add(refId);
        };
        for (const n of notes) for (const id of extractAttachmentIds(n.markdown)) touch(id, 'notes', n.id);
        for (const r of revisions) for (const id of extractAttachmentIds(r.markdown)) touch(id, 'revisions', r.id);

        const existingMap = new Map(existingRefs.map((r) => [r.id, r]));
        const allIds = new Set([...wanted.keys(), ...existingMap.keys()]);
        let repaired = 0;
        for (const attId of allIds) {
            const want = wanted.get(attId) || { notes: new Set(), revisions: new Set() };
            const have = existingMap.get(attId) || { notes: [], revisions: [] };
            const wantNotes = [...want.notes].sort();
            const wantRevs = [...want.revisions].sort();
            const haveNotes = (have.notes || []).slice().sort();
            const haveRevs = (have.revisions || []).slice().sort();
            const same = wantNotes.length === haveNotes.length && wantNotes.every((v, i) => v === haveNotes[i])
                      && wantRevs.length === haveRevs.length && wantRevs.every((v, i) => v === haveRevs[i]);
            if (same) continue;
            await dbPutAttachmentRefs({ id: attId, notes: wantNotes, revisions: wantRevs });
            repaired++;
        }
        // The cache now reflects on-disk truth for every note just scanned, so subsequent
        // ordinary edits diff against reality instead of whatever the old cache assumed.
        for (const n of notes) S.noteAttachRefCache.set(n.id, extractAttachmentIds(n.markdown));
        return { repaired, attachments: allIds.size };
    }
    // Deletes every attachment whose refs row exists but lists no live notes AND no stored
    // revisions. Manual/on-demand (wired to a button in Manage storage) rather than automatic,
    // so nothing is ever deleted without the person asking for it.
    async function pruneOrphanAttachments() {
        const refs = await dbGetAllAttachmentRefs();
        let freed = 0, count = 0;
        for (const r of refs) {
            if ((r.notes && r.notes.length) || (r.revisions && r.revisions.length)) continue;
            const rec = await dbGetAttachment(r.id).catch(() => null);
            if (rec) freed += rec.size || 0;
            await dbDeleteAttachment(r.id).catch(() => {});
            await dbDeleteAttachmentRefs(r.id).catch(() => {});
            count++;
        }
        return { count, freed };
    }

    /* ═════════════ Storage Manager v2: Images / Orphans / Largest / Optimize ═════════════ */
    // Every stored attachment joined with how many live notes AND how many stored revisions
    // currently reference it — the single query behind the Images tab (sort/filter happen
    // client-side on this list). An attachment is only truly unused when both are empty.
    async function getAttachmentsOverview() {
        const [atts, refs] = await Promise.all([dbGetAllAttachments(), dbGetAllAttachmentRefs()]);
        const refMap = new Map(refs.map((r) => [r.id, r]));
        return atts.map((rec) => {
            const r = refMap.get(rec.id);
            return { rec, noteIds: (r && r.notes) || [], revIds: (r && r.revisions) || [] };
        });
    }
    // Re-compresses any *in-use* attachment that predates the current WebP/size settings
    // (e.g. the rare PNG fallback, or a max-dimension that's since been tightened). Orphans are
    // skipped on purpose — "Clean up unused attachments" is the right tool for those, since an
    // unused image is worth deleting outright rather than spending time shrinking it.
    async function optimizeAttachments() {
        const atts = await dbGetAllAttachments();
        const refs = await dbGetAllAttachmentRefs();
        const refMap = new Map(refs.map((r) => [r.id, r]));
        let changed = 0, freed = 0;
        for (const rec of atts) {
            const stale = rec.mime !== 'image/webp' || Math.max(rec.width || 0, rec.height || 0) > ATTACH_MAX_DIM;
            if (!stale) continue;
            const refRec = refMap.get(rec.id);
            const noteIds = (refRec && refRec.notes) || [];
            if (!noteIds.length) continue;

            let encoded;
            try { encoded = await encodeAttachmentImage(rec.blob); } catch (e) { continue; }
            if (!encoded || encoded.blob.size >= rec.size) continue;   // only keep the result if it's actually smaller
            const hash = await hashBlob(encoded.blob);
            if (hash === rec.hash) continue;                          // re-encoding produced identical bytes — nothing to do

            let target = await dbFindAttachmentByHash(hash);
            if (!target) {
                target = { id: 'att_' + hash.slice(0, 24), hash, blob: encoded.blob, mime: encoded.mime, size: encoded.blob.size, width: encoded.width, height: encoded.height, createdAt: rec.createdAt };
                await dbPutAttachment(target);
            }
            S.attachmentCache.set(target.id, target);
            // Point every referencing note's markdown at the new id before dropping the old record.
            for (const noteId of noteIds) {
                let note = S.notes.find((x) => x.id === noteId) || (S.note && S.note.id === noteId ? S.note : null);
                if (!note) { try { note = (await dbGetAll()).find((x) => x.id === noteId) || null; } catch (e) { note = null; } }
                if (!note) continue;
                const re = new RegExp('attachment://' + rec.id + '(?=[\\s)])', 'g');
                const newMd = note.markdown.replace(re, 'attachment://' + target.id);
                if (newMd === note.markdown) continue;
                note.markdown = newMd;
                if (S.note && S.note.id === note.id) {
                    S.note.markdown = newMd;
                    if (el.src && S.mode === 'edit') el.src.value = newMd;
                }
                await dbPut(note).catch(() => {});
            }
            const targetRefs = (await dbGetAttachmentRefs(target.id)) || { id: target.id, notes: [], revisions: [] };
            if (!targetRefs.notes) targetRefs.notes = [];
            if (!targetRefs.revisions) targetRefs.revisions = [];
            for (const noteId of noteIds) if (!targetRefs.notes.includes(noteId)) targetRefs.notes.push(noteId);
            await dbPutAttachmentRefs(targetRefs);
            S.noteAttachRefCache.forEach((set) => { if (set.has(rec.id)) { set.delete(rec.id); set.add(target.id); } });

            // Every live note now points at the new (re-encoded) id, but a stored revision is an
            // immutable snapshot and is never rewritten — if one still pictures rec.id by its
            // original attachment://, the old blob has to stay put until that revision is itself
            // pruned. Only drop it here once nothing, note or revision, references it any more.
            const oldRefs = await dbGetAttachmentRefs(rec.id).catch(() => null);
            const oldRevIds = (oldRefs && oldRefs.revisions) || [];
            if (oldRevIds.length) {
                await dbPutAttachmentRefs({ id: rec.id, notes: [], revisions: oldRevIds });
            } else {
                freed += Math.max(0, rec.size - encoded.blob.size);
                await dbDeleteAttachment(rec.id).catch(() => {});
                await dbDeleteAttachmentRefs(rec.id).catch(() => {});
            }
            changed++;
        }
        if (S.note && (S.mode !== 'edit' || S.split)) renderInto(el.read, S.note.markdown);   // picks up any swapped attachment ids
        return { changed, freed };
    }

    const FOLDER_ICONS = [
        [/study|learn|course|class|cfa/i, 'graduation-cap'],
        [/prompt/i, 'terminal'],
        [/transcript|call|meeting/i, 'microphone'],
        [/research|paper/i, 'magnifying-glass'],
        [/brain|dump|inbox|idea/i, 'brain'],
        [/session|log|journal|diary/i, 'clock']
    ];
    // Picker options for "Customize folder" — a person can override the guessed icon/color
    // per folder; the choice is saved in S.folderStyles (see loadFolderStyles/saveFolderStyles).
    const FOLDER_ICON_CHOICES = [
        'folder', 'folder-open', 'folder-tree', 'briefcase', 'book', 'book-open', 'graduation-cap',
        'chart-line', 'chart-pie', 'flask', 'code', 'laptop-code', 'lightbulb', 'star', 'heart',
        'house', 'wallet', 'coins', 'piggy-bank', 'calendar-days', 'clipboard-list', 'pen',
        'palette', 'camera', 'music', 'plane', 'map', 'compass', 'gamepad', 'dumbbell',
        'utensils', 'mug-hot', 'seedling', 'paw', 'globe', 'rocket', 'shield', 'gear',
        'file-lines', 'tag', 'bookmark', 'bullseye', 'brain', 'microphone', 'magnifying-glass'
    ];
    const FOLDER_COLOR_CHOICES = [
        '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6',
        '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
        '#f43f5e', '#78716c'
    ];
    function loadFolderStyles() {
        try { S.folderStyles = JSON.parse(localStorage.getItem('nvFolderStyles') || '{}') || {}; }
        catch (e) { S.folderStyles = {}; }
    }
    function saveFolderStyles() { try { localStorage.setItem('nvFolderStyles', JSON.stringify(S.folderStyles)); } catch (e) { /* ignore */ } }
    function heuristicIconFor(t) {
        const s = normType(t);
        for (const [re, ic] of FOLDER_ICONS) if (re.test(s)) return ic;
        return 'folder';
    }
    function iconFor(t) {
        const custom = (S.folderStyles || {})[typeKey(normType(t))];
        return (custom && custom.icon) || heuristicIconFor(t);
    }
    function colorFor(t) {
        const custom = (S.folderStyles || {})[typeKey(normType(t))];
        return (custom && custom.color) || '';
    }
    function folderPillHtml(type) {
        const color = colorFor(type);
        return '<span class="nv-folder-pill"><i class="fa-solid fa-' + iconFor(type) + '"' + (color ? ' style="color:' + esc(color) + '"' : '') + '></i>' + esc(normType(type)) + '</span>';
    }

    /* ───────── Accent/case-insensitive search (works for Vietnamese) ─────────
       fold() keeps the string length identical, so match positions in the
       folded text can be used to slice + highlight the original text. */
    function fold(s) {
        if (!s) return '';
        return s.replace(/[^\x00-\x7f]/g, (ch) => {
            if (ch === 'đ' || ch === 'Đ') return 'd';
            const b = ch.normalize('NFD')[0];
            return b.length === 1 ? b.toLowerCase() : ch;
        }).replace(/[A-Z]+/g, (m) => m.toLowerCase());
    }
    const foldCache = new Map();
    function getFold(n) {
        let e = foldCache.get(n.id);
        if (!e || e.u !== n.updatedAt || e.l !== n.markdown.length || e.t !== n.title || e.av !== S.attVer) {
            const body = n.markdown.normalize('NFC');
            const title = n.title.normalize('NFC');
            e = {
                u: n.updatedAt, l: n.markdown.length, t: n.title, av: S.attVer,
                fa: attIdsOf(n).map((id) => (S.attText.get(id) || {}).fold || '').join('\n'),
                body, title,
                fb: fold(body), ft: fold(title),
                fg: fold(n.tags.join(' ').normalize('NFC')),
                fy: fold(normType(n.type).normalize('NFC')),
                // course + linked career/skill, so e.g. "MIT 14.13" or a skill name finds its notes too
                fc: fold([n.course, n.linkedCareer, n.linkedSkill].filter(Boolean).join(' ').normalize('NFC'))
            };
            foldCache.set(n.id, e);
        }
        return e;
    }
    // A search token must start a word (so "ke" finds "Kế toán" but not "key" or "market");
    // tokens that begin with a symbol, and non-Latin scripts, match anywhere.
    const isW = (c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    function findAt(folded, t, from) {
        let i = from;
        while ((i = folded.indexOf(t, i)) >= 0) {
            if (i === 0 || !isW(folded[i - 1]) || !isW(t[0])) return i;
            i++;
        }
        return -1;
    }
    function qTokens() {
        const q = S.query.trim();
        return q ? fold(q.normalize('NFC')).split(/\s+/).filter(Boolean) : [];
    }
    const cleanSeg = (s) => s.replace(/[#*`>_~|]/g, '').replace(/\s+/g, ' ');
    function highlight(raw, folded, tokens) {
        const marks = [];
        for (const t of tokens) {
            let i = 0;
            while ((i = findAt(folded, t, i)) >= 0) { marks.push([i, i + t.length]); i += t.length; }
        }
        marks.sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const m of marks) {
            const last = merged[merged.length - 1];
            if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]); else merged.push([m[0], m[1]]);
        }
        let out = '', p = 0;
        for (const [a, b] of merged) {
            out += esc(cleanSeg(raw.slice(p, a))) + '<mark class="nv-hit">' + esc(cleanSeg(raw.slice(a, b))) + '</mark>';
            p = b;
        }
        return out + esc(cleanSeg(raw.slice(p)));
    }
    function plainSnippet(md) {
        // Preview text reads better without heading lines glued onto the first sentence.
        let head = md.slice(0, 900);
        const noHeads = head.replace(/^[ \t]{0,3}#{1,6}[ \t]+.*$/gm, '');
        if (noHeads.replace(/\s/g, '').length >= 24) head = noHeads;
        return head
            .replace(/```[\s\S]*?(```|$)/g, ' ')
            .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/^\s{0,3}#{1,6}\s+/gm, '')
            .replace(/[*_`>~|]/g, '')
            .replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    /* ───────── Internal links: [[Note title]] or [[Note title|Display text]] ─────────
       Resolution is by title, case/accent-insensitive (via fold()), computed fresh on every
       render rather than stored — so renaming or deleting a note is instantly reflected in
       every link that pointed to it, with no separate index to keep in sync. */
    const WIKILINK_RE = /\[\[([^\[\]\|\n]+?)(?:\|([^\[\]\n]+?))?\]\]/g;
    function stripFences(md) {
        // Same length as the input, with fenced code blocks and inline code blanked out, so a
        // "[[" that is only sample text inside code never becomes a link or a backlink hit.
        const lines = md.split('\n');
        let inFence = false;
        for (let i = 0; i < lines.length; i++) {
            if (/^\s*(`{3,}|~{3,})/.test(lines[i])) { inFence = !inFence; lines[i] = ' '.repeat(lines[i].length); continue; }
            if (inFence) lines[i] = ' '.repeat(lines[i].length);
            else lines[i] = lines[i].replace(/`[^`]+`/g, (m) => ' '.repeat(m.length));
        }
        return lines.join('\n');
    }
    function extractWikilinks(md) {
        const clean = stripFences(md);
        const out = [];
        WIKILINK_RE.lastIndex = 0;
        let m;
        while ((m = WIKILINK_RE.exec(clean))) {
            const title = m[1].trim();
            if (!title) continue;
            out.push({ title, alias: (m[2] || '').trim() || null, index: m.index, len: m[0].length });
        }
        return out;
    }
    function plainSnippetWiki(md) {
        return plainSnippet(md.replace(WIKILINK_RE, (mm, t, a) => (a || t).trim()));
    }
    function findNoteByTitle(title) {
        const key = fold(String(title || '').trim());
        if (!key) return null;
        return S.notes.find((n) => fold((n.title || '').trim()) === key) || null;
    }

    /* ═════════════ Duplicate title guard ═════════════
       Called right before a note is written to the DB (flushSave). If another live note already
       has the same title (case/accent-insensitive), the incoming title is suffixed " (2)", " (3)"…
       — the lowest number that isn't already taken — so two notes never silently share a title. */
    function dedupeTitle(title, excludeId) {
        const base = String(title || '').trim();
        if (!base) return base;
        const key = (s) => fold(s.trim());
        const taken = new Set(
            S.notes.filter((n) => n.id !== excludeId && !n.deletedAt).map((n) => key(n.title || ''))
        );
        if (!taken.has(key(base))) return base;
        let i = 2;
        while (taken.has(key(base + ' (' + i + ')'))) i++;
        return base + ' (' + i + ')';
    }

    /* ═════════════ Find duplicates: similarity scoring ═════════════
       Four cheap, offline signals, none needing a server:
         · titleSim   — character-bigram (Dice) similarity: catches "CFA Accounting" vs
                        "CFA Accounting 2" / "…final" / "…final2" even with no shared words.
         · contentSim — Jaccard overlap of the notes' unique words (via the same fold() used
                        for search, so it's accent-insensitive for Vietnamese too).
         · tagSim     — Jaccard overlap of tag sets.
         · sourceMatch— true when both notes carry the same "**Source:** …" capture header. */
    const DUP_STOP = new Set([
        'note', 'notes', 'untitled', 'new', 'copy', 'final', 'draft', 'old', 'v1', 'v2',
        'the', 'a', 'an', 'and', 'of', 'for', 'to', 'in', 'on', 'is', 'are',
        'ghi', 'chu', 'va', 'cua', 'la', 'moi', 'cu', 'ban'
    ]);
    function titleTokens(title) {
        return fold(String(title || '').trim()).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    }
    function bigramMap(s) {
        const m = new Map(), str = ' ' + s + ' ';
        for (let i = 0; i < str.length - 1; i++) { const bg = str.slice(i, i + 2); m.set(bg, (m.get(bg) || 0) + 1); }
        return m;
    }
    function diceSim(a, b) {
        const A = fold(String(a || '').trim()) || 'untitled note';
        const B = fold(String(b || '').trim()) || 'untitled note';
        if (A === B) return 1;
        const ma = bigramMap(A), mb = bigramMap(B);
        let totalA = 0, totalB = 0, inter = 0;
        for (const v of ma.values()) totalA += v;
        for (const v of mb.values()) totalB += v;
        for (const [k, v] of ma) if (mb.has(k)) inter += Math.min(v, mb.get(k));
        return (totalA + totalB) ? (2 * inter / (totalA + totalB)) : 1;
    }
    function noteWordSet(n) {
        const f = getFold(n);
        const words = f.fb.replace(/[`*_#>\-\[\]().,!?:;"'~|]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
        return new Set(words);
    }
    function jaccardSets(a, b) {
        if (!a.size && !b.size) return 1;
        if (!a.size || !b.size) return 0;
        let inter = 0;
        const [small, big] = a.size < b.size ? [a, b] : [b, a];
        for (const w of small) if (big.has(w)) inter++;
        const union = a.size + b.size - inter;
        return union ? inter / union : 1;
    }
    function tagSet(n) { return new Set((n.tags || []).map((t) => fold(t))); }
    function noteSourceKey(n) {
        const m = SOURCE_HEADER_RE.exec(n.markdown || '');
        if (!m) return null;
        // m[1] is the site NAME (often just "Investopedia"), so keying on it made any two articles from one
        // site look like the same source. The URL identifies the page; tracking params / www / #hash don't.
        const raw = String(m[2] || '').trim();
        if (!raw) return null;
        try {
            const u = new URL(raw);
            [...u.searchParams.keys()].forEach((k) => { if (/^(utm_|fbclid$|gclid$|mc_|ref$|ref_)/i.test(k)) u.searchParams.delete(k); });
            u.searchParams.sort();
            return fold(u.hostname.replace(/^www\./i, '') + u.pathname.replace(/\/+$/, '') + u.search);
        } catch (e) { return fold(raw.replace(/#.*$/, '').replace(/\/+$/, '')); }
    }
    /* ── Duplicate finder v2 ─────────────────────────────────────────────────────────────────────
       Tier 1  EXACT      normalised text equal (CRLF/whitespace/frontmatter/attachment-id/Source-header
                          noise removed) → grouped through a Map, no similarity maths, score 100.
       Tier 2  NEAR       word 3-shingles. Candidates come from an inverted shingle index (so notes with
                          completely different titles are still compared, at any vault size), not only
                          from title words. Similarity = shingle Jaccard, word Jaccard, and containment
                          (a short note sitting inside a long one).
       Tier 3  SCORE      content 60 · title 20 · tags 5 · source ≤15. Content ≥ 0.85 can't be dragged
                          down by a different title. Shown as "87 / 100 · HIGH" — a heuristic, NOT a
                          probability. Same-title-different-content only ever reaches LOW.
       Extra   REGION     notes derived from the same PDF pages ("Source: file, p. 87–91", OCR page
                          callouts) are flagged "Same source region" even when titles/text differ.
       Not included: embedding / semantic matching (would need a model download — a future "deep scan"). */
    /*DUP2-PURE-START*/
    const DUP_HIGH = 85, DUP_REVIEW = 70, DUP_MAX_TOKENS = 200000, DUP_K = 8192, DUP_WORDS = 20000, DUP_KEY = 100000;   // K = bottom-k sketch size: a note up to 8192 distinct shingles is compared exactly, a bigger one by its 8192 smallest hashes
    function dupNorm(md) {
        return String(md || '').normalize('NFC').replace(/\r\n?/g, '\n')
            .replace(/^\uFEFF?---\n[\s\S]*?\n---\n/, '').replace(SOURCE_HEADER_RE, '')
            .replace(/attachment:\/\/[A-Za-z0-9_-]+/g, 'attachment://').replace(/\s+/g, ' ').trim();
    }
    // Scripts written without spaces. A \p{M} (Thai/Indic vowel + tone signs) is part of its word, and a Han/kana/Thai run must be cut into words.
    const DUP_NOSPACE = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+)/u;
    const dupSeg = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
    function dupCut(run) {
        if (dupSeg) { const o = []; for (const g of dupSeg.segment(run)) if (g.isWordLike) o.push(g.segment); if (o.length) return o; }
        const cs = Array.from(run); if (cs.length < 2) return [run];       // no Segmenter: overlapping character pairs
        const o = []; for (let i = 0; i + 1 < cs.length; i++) o.push(cs[i] + cs[i + 1]); return o;
    }
    function dupTokens(norm) {
        const out = [];
        for (const part of fold(norm).replace(/<[^>]+>/g, ' ').split(/[^\p{L}\p{M}\p{N}]+/u)) {
            if (!part) continue;
            const bits = part.split(DUP_NOSPACE);
            for (let i = 0; i < bits.length; i++) {
                if (!bits[i]) continue;
                if (i & 1) for (const w of dupCut(bits[i])) out.push(w); else out.push(bits[i]);
            }
            if (out.length >= DUP_MAX_TOKENS) { out.length = DUP_MAX_TOKENS; break; }
        }
        return out;
    }
    const dupWordOk = (w) => w.length > 2 || (w.length === 2 && DUP_NOSPACE.test(w));   // a 2-character Chinese/Japanese/Thai word is a real word
    const dupH = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
    function dupShingles(tokens) {
        const out = new Set();
        if (tokens.length < 3) { if (tokens.length) out.add(dupH(tokens.join(' '))); return out; }
        const hs = tokens.map(dupH);
        for (let i = 0; i + 3 <= hs.length; i++) out.add((Math.imul(Math.imul(hs[i], 0x9E3779B1) + hs[i + 1] | 0, 0x9E3779B1) + hs[i + 2]) >>> 0);
        return out;
    }
    // Which PDF (and pages) a note was made from: crop lines "*Source: file, p. 87–91*", the 📄 import link,
    // and "OCR text · page N" callouts.
    function dupFingerprint(n) {
        const md = String(n.markdown || ''), files = new Set(), pages = new Map();
        const add = (f, p) => { files.add(f); if (p != null) { if (!pages.has(f)) pages.set(f, new Set()); pages.get(f).add(p); } };
        const fname = (s) => 'file:' + fold(String(s).replace(/\\(.)/g, '$1').replace(/\.pdf$/i, '').trim());
        let head = null; const hm = /\[\uD83D\uDCC4\s*([^\]]+)\]\(attachment:\/\//.exec(md);
        if (hm) { head = fname(hm[1]); add(head, null); }
        for (const m of md.matchAll(/\*Source:\s*(.+?),\s*pp?\.\s*(\d+)(?:\s*[\u2013\-]\s*(\d+))?\*/g)) {
            const f = fname(m[1]), a = +m[2], b = Math.min(+(m[3] || m[2]), a + 60);
            for (let p = a; p <= b; p++) add(f, p);
        }
        if (head) for (const m of md.matchAll(/\[!(?:warning|info)\]\s*OCR (?:text|table)[^\n]*?page (\d+)/g)) add(head, +m[1]);
        return { files, pages };
    }
    // 'region' = same file AND overlapping pages; 'file' = same file, pages unknown on a side. Disjoint pages of one report = null.
    function dupRegion(fa, fb) {
        let lvl = null;
        for (const f of fa.files) {
            if (!fb.files.has(f)) continue;
            const pa = fa.pages.get(f), pb = fb.pages.get(f);
            if (pa && pb) { for (const p of pa) if (pb.has(p)) return 'region'; }
            else lvl = 'file';
        }
        return lvl;
    }
    // Bottom-k sketch: the K smallest shingle hashes (sorted). `card` keeps the exact distinct-shingle count.
    function dupSketch(set) { const a = Uint32Array.from(set); a.sort(); return a.length > DUP_K ? a.slice(0, DUP_K) : a; }
    function dupHas(arr, x) { let lo = 0, hi = arr.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] === x) return true; if (arr[m] < x) lo = m + 1; else hi = m - 1; } return false; }
    // A, B = features { sk, card }. Returns { j: Jaccard, c: share of the smaller note found in the other, small }.
    // Both sketches complete → exact. Otherwise Jaccard comes from the K smallest hashes of the union (valid because each side's
    // K smallest hashes contain every union-bottom-K hash that belongs to it), and containment is measured only where the
    // truncated sketch can actually see (hashes ≤ its largest kept hash); too few samples → 0, never a guess.
    function dupOverlap(A, B) {
        const a = A.sk, b = B.sk, small = Math.min(A.card, B.card);
        if (!a.length || !b.length) return { j: 0, c: 0, small: 0 };
        const fullA = a.length >= A.card, fullB = b.length >= B.card, lim = fullA && fullB ? Infinity : DUP_K;
        let i = 0, k = 0, u = 0, both = 0;
        while (u < lim && (i < a.length || k < b.length)) {
            const x = i < a.length ? a[i] : 4294967296, y = k < b.length ? b[k] : 4294967296;
            if (x === y) { both++; i++; k++; } else if (x < y) i++; else k++;
            u++;
        }
        const j = u ? both / u : 0;
        if (fullA && fullB) return { j, c: both / small, small };
        if (fullA !== fullB) {
            const sh = fullA ? a : b, lg = fullA ? b : a, cut = lg[lg.length - 1];
            let seen = 0, hit = 0; for (const h of sh) { if (h > cut) break; seen++; if (dupHas(lg, h)) hit++; }
            return { j, c: seen >= 8 ? hit / seen : 0, small };
        }
        return { j, c: Math.min(1, (j / (1 + j)) * (A.card + B.card) / small), small };
    }
    const dupFeatCache = new Map();
    function dupFeat(n) {
        let e = dupFeatCache.get(n.id);
        if (e && e.u === n.updatedAt && e.l === n.markdown.length) return e;
        const norm = dupNorm(n.markdown), tokens = dupTokens(norm), full = dupShingles(tokens);
        e = { u: n.updatedAt, l: n.markdown.length, norm, nTok: tokens.length, sk: dupSketch(full), card: full.size, cov: full.size > DUP_K ? DUP_K / full.size : 1, words: new Set(tokens.slice(0, DUP_WORDS).filter(dupWordOk)), fp: dupFingerprint(n) };
        dupFeatCache.set(n.id, e);
        return e;
    }
    function comparePair(a, b) {
        const fa = dupFeat(a), fb = dupFeat(b);
        const exact = fa.norm.length >= 12 && fa.norm === fb.norm;
        const titleSim = (fold(String(a.title || '').trim()) && fold(String(b.title || '').trim())) ? diceSim(a.title, b.title) : 0;   // two untitled notes are not "same title"
        const o = dupOverlap(fa, fb), wj = (fa.words.size && fb.words.size) ? jaccardSets(fa.words, fb.words) : 0;   // jaccardSets(∅,∅) is 1: two empty / all-short-token notes must not look identical
        const lenRatio = Math.min(fa.nTok, fb.nTok) / Math.max(1, Math.max(fa.nTok, fb.nTok));
        const contained = o.small >= 12 && o.c >= 0.9 && lenRatio < 0.7;
        const contentSim = exact ? 1 : Math.max(o.j, wj * 0.85, contained ? o.c * 0.9 : 0);
        const tagSim = (a.tags.length || b.tags.length) ? jaccardSets(tagSet(a), tagSet(b)) : 0;
        const srcA = noteSourceKey(a), srcB = noteSourceKey(b), sourceMatch = !!(srcA && srcB && srcA === srcB);
        const region = dupRegion(fa.fp, fb.fp);
        const bonus = region === 'region' ? 0.15 : sourceMatch ? 0.10 : region === 'file' ? 0.05 : 0;
        let score = exact ? 1 : contentSim * 0.6 + titleSim * 0.2 + tagSim * 0.05 + bonus;
        if (!exact && contentSim >= 0.85) score = Math.max(score, contentSim * 0.95);
        const score100 = Math.round(Math.min(1, score) * 100);
        const level = exact ? 'EXACT' : score100 >= DUP_HIGH ? 'HIGH' : score100 >= DUP_REVIEW ? 'REVIEW' : 'LOW';
        const reasons = [];
        if (exact) reasons.push('Identical text after normalising');
        else {
            if (contentSim >= 0.3) reasons.push('Content ' + Math.round(contentSim * 100));
            if (contained) reasons.push('Shorter note is contained in the longer one');
            if (titleSim >= 0.6) reasons.push('Title ' + Math.round(titleSim * 100));
        }
        if (region === 'region') reasons.push('\u26a0 Same source region \u2014 possible derived note');
        else if (sourceMatch) reasons.push('Same source');
        else if (region === 'file') reasons.push('Same PDF');
        if (tagSim >= 0.5) reasons.push('Shared tags');
        return { titleSim, contentSim, tagSim, sourceMatch, region, exact, contained, lenRatio, score, score100, level, reasons };
    }
    function dupBuildPairs(live, feats) {
        const keys = new Set(), n = live.length, K = Math.max(DUP_KEY, n);
        const add = (x, y) => { if (x !== y) keys.add(x < y ? x * K + y : y * K + x); };
        const allPairs = (ids) => { for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) add(ids[x], ids[y]); };
        // 1 exact groups
        const byNorm = new Map();
        feats.forEach((f, i) => { if (f.norm.length >= 12) { const g = byNorm.get(f.norm); if (g) g.push(i); else byNorm.set(f.norm, [i]); } });
        for (const g of byNorm.values()) { if (g.length < 2) continue; if (g.length <= 40) allPairs(g); else for (let q = 1; q < g.length; q++) add(g[0], g[q]); }   // a pile of identical notes: pair each with the first
        // 2 inverted shingle index (hash-sampled only when the vault is huge)
        let total = 0; feats.forEach((f) => { total += f.sk.length; });
        const mod = Math.max(1, Math.ceil(total / 400000)), post = new Map();
        const sampled = feats.map((f, i) => { let c = 0; for (const h of f.sk) if (h % mod === 0) { c++; const p = post.get(h); if (p) p.push(i); else post.set(h, [i]); } return c; });
        const shared = new Map();
        for (const ids of post.values()) {
            if (ids.length < 2 || ids.length > 30) continue;
            for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) { const k = ids[x] * K + ids[y]; shared.set(k, (shared.get(k) || 0) + 1); }
        }
        shared.forEach((cnt, k) => { const x = Math.floor(k / K), y = k % K; if (cnt >= Math.max(2, 0.25 * Math.min(sampled[x], sampled[y]) * Math.min(feats[x].cov, feats[y].cov))) keys.add(k); });
        // 3 same PDF region
        const byFp = new Map();
        feats.forEach((f, i) => { for (const [file, ps] of f.fp.pages) for (const p of ps) { const k = file + '|' + p, g = byFp.get(k); if (g) g.push(i); else byFp.set(k, [i]); } });
        for (const g of byFp.values()) if (g.length > 1 && g.length <= 30) allPairs(g);
        // 4 title words (kept from v1)
        const byWord = new Map();
        live.forEach((note, i) => { const seen = new Set(); titleTokens(note.title).forEach((w) => { if (DUP_STOP.has(w) || seen.has(w)) return; seen.add(w); const g = byWord.get(w); if (g) g.push(i); else byWord.set(w, [i]); }); });
        for (const g of byWord.values()) if (g.length > 1 && g.length <= 40) allPairs(g);
        // 5 small vault: everything
        if (n <= 120) allPairs(live.map((_, i) => i));
        return keys;
    }
    /*DUP2-PURE-END*/
    function dupResultFor(a, b) {
        const c = comparePair(a, b);
        if (c.exact || c.score >= 0.5 || c.titleSim >= 0.8 || (c.region === 'region' && c.score >= 0.3)) return { a, b, key: pairKey(a.id, b.id), ...c };
        return null;
    }
    const dupSortResults = (arr) => arr.sort((p, q) => (q.exact - p.exact) || (q.score - p.score));
    function findDuplicateCandidates() {
        const live = S.notes.filter((n) => !n.deletedAt), results = [], K = Math.max(DUP_KEY, live.length);
        const liveIds = new Set(live.map((n) => n.id));
        for (const id of [...dupFeatCache.keys()]) if (!liveIds.has(id)) dupFeatCache.delete(id);   // trashed / deleted notes no longer pin memory
        const feats = live.map(dupFeat);
        dupBuildPairs(live, feats).forEach((k) => {
            const a = live[Math.floor(k / K)], b = live[k % K];
            if (!a || !b) return;
            const r = dupResultFor(a, b);
            if (r) results.push(r);
        });
        return dupSortResults(results);
    }
    const pairKey = (id1, id2) => (id1 < id2 ? id1 + '::' + id2 : id2 + '::' + id1);
    // Every note this note links to, deduped by title — each resolved to a live note, or
    // null when nothing with that title exists yet.
    function computeOutgoingLinks(note) {
        if (!note) return [];
        const seen = new Map();
        for (const l of extractWikilinks(note.markdown)) {
            const key = fold(l.title);
            if (!key || seen.has(key)) continue;
            seen.set(key, { title: l.title, note: findNoteByTitle(l.title) });
        }
        return [...seen.values()];
    }
    // Every live note that links to this one, with a short snippet of surrounding text.
    function computeBacklinks(note) {
        if (!note || !note.title.trim()) return [];
        const key = fold(note.title.trim());
        const out = [];
        for (const n of S.notes) {
            if (n.id === note.id) continue;
            const hit = extractWikilinks(n.markdown).find((l) => fold(l.title) === key);
            if (!hit) continue;
            const start = Math.max(0, hit.index - 70), end = Math.min(n.markdown.length, hit.index + hit.len + 90);
            out.push({ note: n, snippet: plainSnippetWiki(n.markdown.slice(start, end)) });
        }
        out.sort((a, b) => b.note.updatedAt - a.note.updatedAt);
        return out;
    }

    /* ═════════════ Safe rename ═════════════
       Wikilinks resolve by title (see above), so renaming a note is silent data loss for
       every other note that still says [[Old Title]] — that link simply stops resolving.
       Before a title change is persisted (flushSave), we check whether any other live note
       links to the OLD title; if so we ask, Obsidian-style, whether to rewrite those links
       to the new title, leave them (now-broken) as-is, or cancel the rename outright. */
    function findBacklinksToTitle(title, excludeId) {
        const key = fold(String(title || '').trim());
        if (!key) return [];
        const out = [];
        for (const n of S.notes) {
            if (n.id === excludeId || n.deletedAt) continue;
            const hits = extractWikilinks(n.markdown).filter((l) => fold(l.title) === key);
            if (hits.length) out.push({ note: n, count: hits.length });
        }
        out.sort((a, b) => b.note.updatedAt - a.note.updatedAt);
        return out;
    }
    // Rewrites every [[Old Title]] / [[Old Title|Alias]] occurrence in the given target notes
    // to the new title (alias text is preserved), then persists each changed note.
    async function renameLinksAcrossVault(oldTitle, newTitle, excludeId, backlinks) {
        const key = fold(String(oldTitle || '').trim());
        if (!key) return 0;
        const targets = backlinks || findBacklinksToTitle(oldTitle, excludeId);
        let updated = 0;
        for (const { note: n } of targets) {
            const hits = extractWikilinks(n.markdown).filter((l) => fold(l.title) === key);
            if (!hits.length) continue;
            await snapshot({ id: n.id, title: n.title, markdown: n.markdown }, { label: 'before-relink' });   // never throws; keeps the old text one click away in History
            let md = n.markdown;
            hits.sort((a, b) => b.index - a.index).forEach((h) => {
                const repl = h.alias ? ('[[' + newTitle + '|' + h.alias + ']]') : ('[[' + newTitle + ']]');
                md = md.slice(0, h.index) + repl + md.slice(h.index + h.len);
            });
            n.markdown = md;
            n.updatedAt = Date.now();
            foldCache.delete(n.id);
            try { await dbPut(n); updated++; }
            catch (e) { console.error('Notes Vault: failed updating link in', n.id, e); }
        }
        return updated;
    }
    // Promise-based "Rename note?" dialog. Resolves to 'update' | 'keep' | 'cancel'.
    function showRenameDialog(oldTitle, newTitle, backlinks) {
        return new Promise((resolve) => {
            if (!el || !el.renScrim) { resolve('keep'); return; }   // DOM not ready — fail safe, don't block the save
            const n = backlinks.length;
            el.renBody.innerHTML = esc(n) + ' ' + (n === 1 ? 'note' : 'notes') + ' link' + (n === 1 ? 's' : '') +
                ' to “<strong>' + esc(oldTitle) + '</strong>”.<span class="nv-ren-count">Rename to “' + esc(newTitle) + '”?</span>';
            el.renScrim.hidden = false;
            const prevFocus = document.activeElement;
            function finish(choice) {
                el.renUpdate.onclick = null; el.renOnly.onclick = null; el.renCancel.onclick = null;
                el.renScrim.onclick = null;
                document.removeEventListener('keydown', onKey);
                el.renScrim.hidden = true;
                if (prevFocus && prevFocus.focus) prevFocus.focus();
                resolve(choice);
            }
            function onKey(e) { if (e.key === 'Escape') finish('cancel'); }
            el.renUpdate.onclick = () => finish('update');
            el.renOnly.onclick = () => finish('keep');
            el.renCancel.onclick = () => finish('cancel');
            el.renScrim.onclick = (e) => { if (e.target === el.renScrim) finish('cancel'); };
            document.addEventListener('keydown', onKey);
            el.renUpdate.focus();
        });
    }
    function searchSnippet(n, tokens) {
        const f = getFold(n);
        // Prefer a spot where all the search words appear close together; else the earliest hit.
        let pos = -1, len = 0;
        const t0 = tokens[0];
        let i = findAt(f.fb, t0, 0), tries = 0;
        while (i >= 0 && tries++ < 60) {
            if (pos < 0) { pos = i; len = t0.length; }
            const win = f.fb.slice(Math.max(0, i - 160), i + 200);
            if (tokens.every((t) => findAt(win, t, 0) >= 0)) { pos = i; len = t0.length; break; }
            i = findAt(f.fb, t0, i + t0.length);
        }
        if (pos < 0) {
            for (const t of tokens) {
                const j = findAt(f.fb, t, 0);
                if (j >= 0 && (pos < 0 || j < pos)) { pos = j; len = t.length; }
            }
        }
        if (pos < 0) return esc(plainSnippet(f.body));
        const start = Math.max(0, pos - 70), end = Math.min(f.body.length, pos + len + 120);
        return (start > 0 ? '…' : '') + highlight(f.body.slice(start, end), f.fb.slice(start, end), tokens) + (end < f.body.length ? '…' : '');
    }

    /* ───────── Version history (IndexedDB store "revisions") ─────────
       A version is a full copy of a note's title + text. One is saved:
         · about every 10 minutes while you are writing,
         · when you leave a note or close the vault,
         · when you press "Save a version now",
         · just before a restore replaces your text (so a restore can be undone).
       History is best-effort: if it ever fails, saving the note itself is not affected. */
    const revLast = new Map();   // noteId → { at, sig } for the newest version (null = none yet)
    const REV_LABELS = {
        manual: 'Saved by you',
        'before-replace': 'Before Find & Replace',
        original: 'Before your first edit',
        'before-restore': 'Before a restore',
        'before merge': 'Before a merge',
        'before-relink': 'Before links were updated',
        restore: 'After a restore'
    };
    const revRange = (id) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

    async function revList(noteId, limit) {          // newest first
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const out = [];
            const req = db.transaction(DB_REV).objectStore(DB_REV).index('noteAt').openCursor(revRange(noteId), 'prev');
            req.onsuccess = () => {
                const c = req.result;
                if (!c || (limit && out.length >= limit)) return resolve(out);
                out.push(c.value);
                c.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }
    async function revPut(rec) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DB_REV, 'readwrite');
            tx.objectStore(DB_REV).put(rec);
            tx.oncomplete = () => resolve(rec);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }
    async function revKeys(noteId) {                 // primary keys only, newest first (cheap: no note text is loaded)
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const out = [];
            const req = db.transaction(DB_REV).objectStore(DB_REV).index('noteAt').openKeyCursor(revRange(noteId), 'prev');
            req.onsuccess = () => {
                const c = req.result;
                if (!c) return resolve(out);
                out.push(c.primaryKey);
                c.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }
    async function revDeleteKeys(keys) {
        if (!keys.length) return;
        // Read each revision's markdown before it disappears so its attachment refs can be
        // released — otherwise an image only pictured in an older/trimmed revision would keep
        // pointing at a "revisions" ref that's about to become unreachable, silently leaking it.
        try {
            const recs = await Promise.all(keys.map((k) => dbGetRevision(k).catch(() => null)));
            for (const rec of recs) if (rec) await releaseRevisionAttachments(rec.id, rec.markdown);
        } catch (e) { /* best-effort — worst case a ref lingers until the next prune, never data loss */ }
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DB_REV, 'readwrite');
            const st = tx.objectStore(DB_REV);
            keys.forEach((k) => st.delete(k));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }
    async function revPrune(noteId, chars) {
        const keep = chars > BIG_NOTE ? REV_KEEP_BIG : REV_KEEP;
        const keys = await revKeys(noteId);
        if (keys.length > keep) await revDeleteKeys(keys.slice(keep));
    }
    async function revDeleteForNote(noteId) {
        revLast.delete(noteId);
        await revDeleteKeys(await revKeys(noteId));
    }
    // Every version of every note, across the whole store — used only for a full backup
    // (getBackupData), never by the app's normal per-note history views.
    async function dbGetAllRevisions() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(DB_REV).objectStore(DB_REV).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    function sigOf(n) {                              // cheap fingerprint of title + text
        const t = (n.title || '') + '\u0001' + (n.markdown || '');
        let h = 5381;
        for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
        return t.length + ':' + (h >>> 0).toString(36);
    }
    async function revLatest(noteId) {
        if (revLast.has(noteId)) return revLast.get(noteId);
        const [r] = await revList(noteId, 1);
        const v = r ? { at: r.savedAt, sig: r.sig } : null;
        revLast.set(noteId, v);
        return v;
    }
    // Store a version unless it is identical to the newest one. Never throws.
    async function snapshot(src, opts) {
        opts = opts || {};
        try {
            const last = await revLatest(src.id);
            const sig = sigOf(src);
            if (last && last.sig === sig) return false;
            const md = src.markdown || '';
            const savedAt = opts.at || Math.max(Date.now(), last ? last.at + 1 : 0);
            const rec = {
                id: uid(), noteId: src.id, savedAt, title: src.title || '', markdown: md,
                words: (md.match(/\S+/g) || []).length, chars: md.length, sig, label: opts.label || ''
            };
            await revPut(rec);
            await addRevisionAttachmentRefs(rec.id, md);
            revLast.set(src.id, { at: savedAt, sig });
            await revPrune(src.id, md.length);
            if (S.note && S.note.id === src.id) renderHistory();
            return true;
        } catch (e) {
            console.warn('Notes Vault: could not store a version', e);
            return false;
        }
    }
    // The first time an older note is edited, keep how it looked before that edit.
    async function captureOriginal(n) {
        const b = S.base;
        if (!b || b.id !== n.id || !S.persisted) return;
        try {
            const last = await revLatest(n.id);
            if (!last && sigOf(b) !== sigOf(n)) await snapshot(b, { at: b.updatedAt, label: 'original' });
        } catch (e) { console.warn('Notes Vault: history skipped', e); }
    }
    async function autoSnapshot(n) {
        try {
            if (!S.edited || S.note !== n) return;
            const last = await revLatest(n.id);
            const ref = Math.max(S.editStart || 0, last ? last.at : 0);
            if (Date.now() - ref >= REV_EVERY) await snapshot(n, {});
        } catch (e) { console.warn('Notes Vault: history skipped', e); }
    }
    // Save now, and keep a version of what was just written (used when leaving a note).
    async function settle() {
        flushReadPos();   // save the reading position before the note changes or the page goes away
        await rpFlush();   // the note in the right panel (Focus mode) is saved on its own
        await flushSave();
        const n = S.note;
        if (n && S.persisted && S.edited && !S.dirty) await snapshot(n, {});
    }

    /* ───────── Loading ───────── */
    async function loadAll() {
        const all = (await dbGetAll()).map(normalizeNote);
        S.notes = all.filter((n) => !n.deletedAt);
        S.trash = all.filter((n) => n.deletedAt);
    }
    // Tracker → Notes direction of the link: "how many notes point at each skill?" Reads
    // straight from IndexedDB (not S.notes) so it works even before the user has ever
    // opened the Notes Vault overlay in this session — Tracker can call it on page load.
    // Shape: { [careerKey]: { [skillName]: count } }.
    async function getLinkCounts() {
        try {
            const all = await dbGetAll();
            const counts = {};
            for (const raw of all) {
                if (raw.deletedAt) continue;                       // trashed notes don't count
                const skill = EntityLinks.idFromRaw(raw, 'skill');
                const career = raw.linkedCareer;
                if (!career || !skill) continue;
                if (!counts[career]) counts[career] = {};
                counts[career][skill] = (counts[career][skill] || 0) + 1;
            }
            return counts;
        } catch (e) { console.warn('Notes Vault: could not compute skill link counts', e); return {}; }
    }
    // Opens the overlay straight into "notes linked to this one skill" — the click target
    // for the Tracker-side badge (see nvApplySkillNoteBadges in the Tracker script).
    async function openForSkill(career, skillName) {
        await open();
        await setScope('skill', { career, skill: skillName });
    }
    // Course-side counterpart of getLinkCounts: "how many notes point at each course?"
    // Shape: { [courseId]: count }. Same IndexedDB-direct read so the Courses tracker can
    // call it on page load, before the user has ever opened the Notes Vault overlay.
    async function getCourseLinkCounts() {
        try {
            const all = await dbGetAll();
            const counts = {};
            for (const raw of all) {
                if (raw.deletedAt) continue;
                const id = EntityLinks.idFromRaw(raw, 'course');
                if (!id) continue;
                counts[id] = (counts[id] || 0) + 1;
            }
            return counts;
        } catch (e) { console.warn('Notes Vault: could not compute course link counts', e); return {}; }
    }
    // Opens the overlay straight into "notes linked to this one course" — the click target
    // for the Courses-tracker-side badge (see nvApplyCourseNoteBadges in the Tracker script).
    async function openForCourse(courseId, courseTitle, career) {
        await open();
        await setScope('course', { id: courseId, title: courseTitle || '', career: career || '' });
    }
    // Resource-side counterpart of getLinkCounts/getCourseLinkCounts: "how many notes
    // point at each resource?" Shape: { [resourceId]: count }. Same direct-IndexedDB read
    // so the Resource Library can call it on page load, before the Notes Vault overlay
    // has ever been opened.
    async function getResourceLinkCounts() {
        try {
            const all = await dbGetAll();
            const counts = {};
            for (const raw of all) {
                if (raw.deletedAt) continue;
                const id = EntityLinks.idFromRaw(raw, 'resource');
                if (!id) continue;
                counts[id] = (counts[id] || 0) + 1;
            }
            return counts;
        } catch (e) { console.warn('Notes Vault: could not compute resource link counts', e); return {}; }
    }
    // Opens the overlay straight into "notes linked to this one resource" — the click
    // target for the Resource Library's Notes badge (see nvApplyResourceNoteBadges).
    // Looks the title up itself from the global resourceLibrary so callers only need to
    // pass the id.
    async function openForResource(resourceId) {
        const r = (typeof resourceLibrary !== 'undefined') ? resourceLibrary.find((x) => x.id == resourceId) : null;
        await open();
        await setScope('resource', { id: resourceId, title: r ? r.title : '' });
    }
    // Analysis-side counterpart of getLinkCounts/getResourceLinkCounts: "how many notes
    // point at each Investment Analysis entry?" Shape: { [analysisId]: count }. Same
    // direct-IndexedDB read so the Investment Analysis tracker can call it on page load,
    // before the Notes Vault overlay has ever been opened.
    async function getAnalysisLinkCounts() {
        try {
            const all = await dbGetAll();
            const counts = {};
            for (const raw of all) {
                if (raw.deletedAt) continue;
                const id = EntityLinks.idFromRaw(raw, 'analysis');
                if (!id) continue;
                counts[id] = (counts[id] || 0) + 1;
            }
            return counts;
        } catch (e) { console.warn('Notes Vault: could not compute analysis link counts', e); return {}; }
    }
    // Opens the overlay straight into "notes linked to this one Investment Analysis" — the
    // click target for the Investment Analysis tracker's Notes badge (see
    // nvApplyAnalysisNoteBadges). Looks the title up itself from the global
    // investmentAnalyses array so callers only need to pass the id.
    async function openForAnalysis(analysisId) {
        const a = (typeof investmentAnalyses !== 'undefined') ? investmentAnalyses.find((x) => x.id == analysisId) : null;
        await open();
        await setScope('analysis', { id: analysisId, title: a ? a.title : '' });
    }
    // Deal-side counterpart of getAnalysisLinkCounts: "how many notes point at each
    // Deal Diary entry?" Shape: { [dealId]: count }. Same direct-IndexedDB read so
    // the Deal Diary tracker can call it on page load, before the Notes Vault
    // overlay has ever been opened.
    async function getDealLinkCounts() {
        try {
            const all = await dbGetAll();
            const counts = {};
            for (const raw of all) {
                if (raw.deletedAt) continue;
                const id = EntityLinks.idFromRaw(raw, 'deal');
                if (!id) continue;
                counts[id] = (counts[id] || 0) + 1;
            }
            return counts;
        } catch (e) { console.warn('Notes Vault: could not compute deal link counts', e); return {}; }
    }
    // Opens the overlay straight into "notes linked to this one Deal Diary entry" —
    // the click target for the Deal Diary's Notes badge (see nvApplyDealNoteBadges).
    // Looks the title up itself from the global dealDiary array so callers only
    // need to pass the id.
    async function openForDeal(dealId) {
        const d = (typeof dealDiary !== 'undefined') ? dealDiary.find((x) => x.id == dealId) : null;
        await open();
        await setScope('deal', { id: dealId, title: d ? d.dealName : '' });
    }
    /* ───────── Entity-scoped linking UI ─────────
       The relationship is many notes ↔ one entity: each note stores one link of a given type,
       while an entity can have any number of linked notes. The UI therefore lives on the entity
       side as a stable `Notes` action, with two explicit paths: create a new linked note or attach
       an existing note. */
    const LINKABLE_SCOPES = new Set(['skill', 'course', 'resource', 'analysis', 'deal']);
    function scopedEntityTitle(kind, value) {
        value = value || {};
        if (kind === 'skill') return value.skill || 'Skill';
        return value.title || ({ course: 'Course', resource: 'Resource', analysis: 'Analysis', deal: 'Deal' }[kind] || 'Entity');
    }
    function scopedEntityIcon(kind) {
        return ({ skill: 'graduation-cap', course: 'book', resource: 'book-open', analysis: 'chart-line', deal: 'handshake' }[kind] || 'link');
    }
    function renderScopeActions() {
        if (!el || !el.scopeActions) return;
        const sc = S.scope || {};
        if (!LINKABLE_SCOPES.has(sc.kind) || !sc.value || !sc.value.id && sc.kind !== 'skill') {
            el.scopeActions.hidden = true;
            el.scopeActions.innerHTML = '';
            return;
        }
        const title = scopedEntityTitle(sc.kind, sc.value);
        const count = filterNotes([]).length;
        const kindLabel = sc.kind === 'skill' ? 'skill' : sc.kind;
        el.scopeActions.hidden = false;
        el.scopeActions.innerHTML =
            '<span class="nv-scope-context"><i class="fa-solid fa-' + scopedEntityIcon(sc.kind) + '" aria-hidden="true"></i><span>Notes for <strong title="' + esc(title) + '">' + esc(title) + '</strong></span></span>'
            + '<button type="button" class="nv-btn nv-btn-primary nv-entity-note-action" data-scope-new><i class="fa-solid fa-plus"></i> New note</button>'
            + '<button type="button" class="nv-btn nv-btn-ghost nv-entity-note-action" data-scope-link><i class="fa-solid fa-link"></i> Link existing</button>';
    }
    function linkTargetDescriptor(type, id) {
        const out = { type, id, title: '', career: '' };
        if (type === 'skill') {
            const career = (S.scope.value && S.scope.value.career) || '';
            out.career = career; out.title = (S.scope.value && S.scope.value.skill) || '';
        } else if (type === 'course') {
            const c = (typeof courses !== 'undefined') ? courses.find((x) => x.id === id) : null;
            out.title = c ? c.title : ((S.scope.value && S.scope.value.title) || 'Course');
            out.career = c ? (c.career || '') : ((S.scope.value && S.scope.value.career) || '');
        } else if (type === 'resource') {
            const r = (typeof resourceLibrary !== 'undefined') ? resourceLibrary.find((x) => x.id == id) : null;
            out.title = r ? r.title : ((S.scope.value && S.scope.value.title) || 'Resource');
        } else if (type === 'analysis') {
            const a = (typeof investmentAnalyses !== 'undefined') ? investmentAnalyses.find((x) => x.id == id) : null;
            out.title = a ? a.title : ((S.scope.value && S.scope.value.title) || 'Analysis');
        } else if (type === 'deal') {
            const d = (typeof dealDiary !== 'undefined') ? dealDiary.find((x) => x.id == id) : null;
            out.title = d ? d.dealName : ((S.scope.value && S.scope.value.title) || 'Deal');
        }
        return out;
    }
    function noteCanBeLinkedToTarget(note, type, id) {
        if (!note || note.deletedAt || !id) return false;
        return !EntityLinks.has(note, type, id);
    }
    function linkPickerMatches(note, query) {
        if (!query) return true;
        const f = getFold(note);
        const q = fold(query);
        return f.ft.includes(q) || f.fb.includes(q) || f.fy.includes(q) || f.fc.includes(q);
    }
    // Ranking for the Link Existing picker. Signals, strongest first: a title match
    // matters far more than anything else (someone typing "MBB" wants the note titled
    // "MBB" long before one that merely mentions it in passing); recency is the natural
    // default sort and clearly outranks the two weakest, roughly-tied signals — pinned
    // and a content-only match. Recency uses a 60-day linear decay so it can never
    // approach a title-match score, and pinned/content each add a small, equal nudge.
    function linkPickerScore(note, query) {
        const f = getFold(note);
        let score = 0;
        if (query) {
            const q = fold(query);
            if (f.ft.includes(q)) score += 1000 + (f.ft.startsWith(q) ? 100 : 0);
            if (f.fb.includes(q)) score += 15;
        }
        score += Math.max(0, 60 - (Date.now() - note.updatedAt) / 86400000);
        if (note.pinned) score += 15;
        return score;
    }
    function renderLinkPicker() {
        if (!S.linkPicker.open || !el.linkPicker || !el.linkList) return;
        const lp = S.linkPicker;
        const candidates = S.notes
            .filter((n) => noteCanBeLinkedToTarget(n, lp.type, lp.id) && linkPickerMatches(n, lp.query))
            .map((n) => ({ n, s: linkPickerScore(n, lp.query) }))
            .sort((a, b) => b.s - a.s || b.n.updatedAt - a.n.updatedAt)
            .map((x) => x.n);
        if (el.linkSub) el.linkSub.textContent = 'Select a note to link to “' + lp.title + '”. Existing links stay unchanged; only the selected note gets a new ' + lp.type + ' link.';
        if (!candidates.length) {
            el.linkList.innerHTML = '<div class="nv-link-empty"><i class="fa-solid fa-link"></i><strong>' + (lp.query ? 'No matching notes' : 'No unlinked notes') + '</strong><div>' + (lp.query ? 'Try a shorter search.' : 'Every existing note is already linked to this ' + lp.type + ' or your vault is empty.') + '</div></div>';
            return;
        }
        const shown = candidates.slice(0, 80);
        el.linkList.innerHTML = shown.map((n) => {
            const title = n.title.trim() || 'Untitled note';
            const snippet = plainSnippet(n.markdown);
            const tags = n.tags.slice(0, 3).map((t) => '#' + esc(t)).join(' ');
            return '<button type="button" class="nv-link-option" role="option" data-link-note="' + esc(n.id) + '">'
                + '<span><span class="nv-link-option-title">' + esc(title) + '</span>'
                + '<span class="nv-link-option-meta"><span>' + esc(normType(n.type)) + '</span><span>' + esc(fmtRel(n.updatedAt)) + '</span>' + (tags ? '<span>' + tags + '</span>' : '') + '</span>'
                + (snippet ? '<span class="nv-link-option-snip">' + esc(snippet) + '</span>' : '')
                + '</span><span class="nv-link-option-cta">Link</span></button>';
        }).join('');
        if (candidates.length > shown.length) {
            el.linkList.insertAdjacentHTML('beforeend', '<div class="nv-link-empty" style="padding:12px 16px 18px;">Showing 80 of ' + candidates.length + ' matches. Refine the search to see another note.</div>');
        }
    }
    function openLinkPicker(type, id, title, career) {
        if (!LINKABLE_SCOPES.has(type) || !id || !el.linkPicker) return;
        closeMenus();
        S.linkPicker = { open: true, type, id, title: title || linkTargetDescriptor(type, id).title, career: career || '', query: '', prevFocus: document.activeElement };
        el.linkSearch.value = '';
        el.linkScrim.hidden = false;
        el.linkPicker.hidden = false;
        renderLinkPicker();
        el.linkSearch.focus({ preventScroll: true });
    }
    function closeLinkPicker() {
        if (!S.linkPicker.open) return;
        S.linkPicker.open = false;
        if (el.linkPicker) el.linkPicker.hidden = true;
        if (el.linkScrim) el.linkScrim.hidden = true;
        const f = S.linkPicker.prevFocus;
        S.linkPicker = { open: false, type: '', id: '', title: '', career: '', query: '', prevFocus: null };
        refocus(f);
    }
    function afterEntityLinkChanged(type) {
        const fn = { skill: 'nvRefreshSkillBadges', course: 'nvRefreshCourseBadges', resource: 'nvRefreshResourceBadges', analysis: 'nvRefreshAnalysisBadges', deal: 'nvRefreshDealBadges' }[type];
        if (fn && typeof window[fn] === 'function') window[fn]();
    }
    async function linkExistingNote(noteId) {
        const lp = S.linkPicker;
        if (!lp.open) return;
        const note = S.notes.find((n) => n.id === noteId);
        if (!note || !noteCanBeLinkedToTarget(note, lp.type, lp.id)) return;
        const before = { title: note.title, updatedAt: note.updatedAt };
        try {
            EntityLinks.link(note, lp.type, lp.id, lp.type === 'skill' ? { career: lp.career } : {});
            if (lp.type === 'skill') { note.linkedCareer = lp.career || note.linkedCareer || ''; note.linkedSkill = lp.id; }
            else if (lp.type === 'course') { note.course = lp.title || note.course || ''; if (lp.career) note.linkedCareer = lp.career; }
            else if (lp.type === 'resource') note.resource = lp.title || note.resource || '';
            else if (lp.type === 'analysis') note.analysis = lp.title || note.analysis || '';
            else if (lp.type === 'deal') note.deal = lp.title || note.deal || '';
            note.updatedAt = Date.now();
            await dbPut(note);
            rebuildLinksFromLegacy(note);
            if (S.note && S.note.id === note.id) {
                S.note = note; S.savedAt = note.updatedAt; S.dirty = false; renderDocMeta(); renderContextPane(); renderAll();
            } else {
                renderSide(); renderLibrary();
            }
            afterEntityLinkChanged(lp.type);
            closeLinkPicker();
            flash('Linked “' + (note.title.trim() || 'Untitled note') + '” to ' + lp.title);
        } catch (e) {
            console.warn('Notes Vault: could not link existing note', e);
            toast('Couldn’t link that note. No changes were saved.');
        }
    }
    async function unlinkScopedNote(noteId) {
        const sc = S.scope;
        if (!LINKABLE_SCOPES.has(sc.kind)) return;
        const note = S.notes.find((n) => n.id === noteId);
        if (!note) return;
        const targetTitle = scopedEntityTitle(sc.kind, sc.value);
        try {
            EntityLinks.unlink(note, sc.kind);
            if (sc.kind === 'course') note.course = '';
            if (sc.kind === 'resource') note.resource = '';
            if (sc.kind === 'analysis') note.analysis = '';
            if (sc.kind === 'deal') note.deal = '';
            if (sc.kind === 'skill') note.linkedSkill = '';
            note.updatedAt = Date.now();
            await dbPut(note);
            if (S.note && S.note.id === note.id) { renderDocMeta(); renderContextPane(); }
            renderAll();
            afterEntityLinkChanged(sc.kind);
            flash('Unlinked “' + (note.title.trim() || 'Untitled note') + '” from ' + targetTitle);
        } catch (e) {
            console.warn('Notes Vault: could not unlink note', e);
            toast('Couldn’t remove that link.');
        }
    }

    async function purgeExpired() {                  // Trash empties itself after 30 days
        try {
            const cutoff = Date.now() - TRASH_MS;
            const old = S.trash.filter((n) => n.deletedAt < cutoff);
            for (const n of old) {
                await dbDelete(n.id);
                try { await revDeleteForNote(n.id); } catch (e) { /* history is best-effort */ }
                foldCache.delete(n.id);
            }
            if (old.length) S.trash = S.trash.filter((n) => n.deletedAt >= cutoff);
        } catch (e) { console.warn('Notes Vault: could not clear old Trash', e); }
    }

    /* ───────── Filtering ───────── */
    function filterNotes(tokens) {
        const active = filtersActive();
        if (tokens.length) {
            const hits = [];
            for (const n of S.notes) {
                if (active && !passesFilters(n)) continue;
                const f = getFold(n);
                let score = 0, ok = true;
                for (const t of tokens) {
                    const inT = findAt(f.ft, t, 0) >= 0, inG = findAt(f.fg, t, 0) >= 0 || findAt(f.fy, t, 0) >= 0 || findAt(f.fc, t, 0) >= 0, inB = findAt(f.fb, t, 0) >= 0 || (!!f.fa && findAt(f.fa, t, 0) >= 0);
                    if (!inT && !inG && !inB) { ok = false; break; }
                    score += inT ? 2 : (inG ? 1 : 0);
                }
                if (ok) hits.push({ n, score });
            }
            // Search relevance always wins the order here — Sort-by only shapes plain browsing below.
            hits.sort((a, b) => (b.score - a.score) || (b.n.updatedAt - a.n.updatedAt));
            return hits.map((h) => h.n);
        }
        const { kind, value } = S.scope;
        const now = Date.now();
        let list;
        if (kind === 'trash') return S.trash.slice().sort((a, b) => b.deletedAt - a.deletedAt);
        if (kind === 'recent') list = S.notes.filter((n) => now - n.updatedAt < RECENT_MS);
        else if (kind === 'pinned') list = S.notes.filter((n) => n.pinned);
        else if (kind === 'folder') list = S.notes.filter((n) => typeKey(n.type) === value);
        else if (kind === 'tag') list = S.notes.filter((n) => n.tags.some((t) => t.toLowerCase() === value));
        else if (kind === 'skill') list = S.notes.filter((n) => n.linkedCareer === value.career && EntityLinks.has(n, 'skill', value.skill));
        else if (kind === 'course') list = S.notes.filter((n) => EntityLinks.has(n, 'course', value.id));
        else if (kind === 'resource') list = S.notes.filter((n) => EntityLinks.has(n, 'resource', value.id));
        else if (kind === 'analysis') list = S.notes.filter((n) => EntityLinks.has(n, 'analysis', value.id));
        else if (kind === 'deal') list = S.notes.filter((n) => EntityLinks.has(n, 'deal', value.id));
        else list = S.notes.slice();
        if (active) list = list.filter(passesFilters);
        return sortList(list);
    }

    /* ═════════════ Rendering: sidebar ═════════════ */
    // Keeps the Filter panel's Folder dropdown and Tag autocomplete in sync with the
    // vault's current folders/tags (called from renderSide, right after S.fmap/S.tmap rebuild).
    function renderFilterOptions() {
        if (!el || !el.fFolder) return;
        const cur = el.fFolder.value;
        const fl = [...S.fmap.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
        el.fFolder.innerHTML = '<option value="">Any folder</option>' + fl.map(([k, f]) => `<option value="${esc(k)}">${esc(f.label)}</option>`).join('');
        if (fl.some(([k]) => k === cur)) el.fFolder.value = cur;
        const tl = [...S.tmap.values()].sort((a, b) => a.label.localeCompare(b.label));
        // Feeds both the filter panel's Tag combo and the note-info Tags combo (attachCombo) —
        // this runs more often than renderDatalists(), so it's the freshest source.
        S.tagOpts = tl.map((g) => g.label);
    }

    function renderSide() {
        rpSyncSoon();
        const now = Date.now();
        let recent = 0, pinned = 0;
        const folders = new Map(), tags = new Map();
        for (const n of S.notes) {
            if (now - n.updatedAt < RECENT_MS) recent++;
            if (n.pinned) pinned++;
            const k = typeKey(n.type);
            let f = folders.get(k);
            if (!f) { f = { label: normType(n.type), count: 0, latest: 0 }; folders.set(k, f); }
            f.count++;
            if (n.updatedAt >= f.latest) { f.latest = n.updatedAt; f.label = normType(n.type); }
            for (const t of n.tags) {
                const tk = t.toLowerCase();
                let g = tags.get(tk);
                if (!g) { g = { label: t, count: 0 }; tags.set(tk, g); }
                g.count++;
            }
        }
        S.fmap = folders; S.tmap = tags;
        renderFilterOptions();

        const sc = S.scope;
        if ((sc.kind === 'folder' && !folders.has(sc.value)) || (sc.kind === 'tag' && !tags.has(sc.value))) {
            S.scope = { kind: 'all', value: '' };
        }
        const searching = !!S.query.trim();
        const isCur = (k, v) => !searching && S.scope.kind === k && S.scope.value === (v || '');
        const item = (kind, val, icon, label, count, color) =>
            `<button type="button" class="nv-nav-item${isCur(kind, val) ? ' nv-cur' : ''}" data-kind="${kind}" data-val="${esc(val)}"${isCur(kind, val) ? ' aria-current="true"' : ''}>` +
            `<i class="fa-solid fa-${icon}"${color ? ` style="color:${esc(color)}"` : ''}></i><span class="nv-nm">${esc(label)}</span><span class="nv-count">${count}</span></button>`;

        let html = item('all', '', 'layer-group', 'All notes', S.notes.length)
            + item('recent', '', 'clock', 'Recent', recent)
            + item('pinned', '', 'star', 'Pinned', pinned)
            + item('trash', '', 'trash', 'Trash', S.trash.length);

        const fl = [...folders.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
        html += '<div class="nv-side-h nv-side-h-row"><span>Folders</span><button type="button" class="nv-side-h-add" data-new-folder title="New folder" aria-label="New folder"><i class="fa-solid fa-plus" aria-hidden="true"></i>New</button>'
            + (folderDupGroups().length ? '<button type="button" class="nv-side-h-add" data-merge-folders title="Some folders are duplicates — merge them" aria-label="Merge duplicate folders"><i class="fa-solid fa-code-merge" aria-hidden="true"></i>Merge</button>' : '')
            + '</div>';
        if (fl.length) html += fl.map(([k, f]) => '<div class="nv-fitem">'
            + item('folder', k, iconFor(f.label), f.label, f.count, colorFor(f.label))
            + '<button type="button" class="nv-fitem-edit" data-edit-folder="' + esc(k) + '" title="Customize folder" aria-label="Customize ' + esc(f.label) + ' folder"><i class="fa-solid fa-palette" aria-hidden="true"></i></button>'
            + '</div>').join('');

        const tl = [...tags.entries()].sort((a, b) => (b[1].count - a[1].count) || a[1].label.localeCompare(b[1].label));
        if (tl.length) {
            const shown = S.tagsAll ? tl : tl.slice(0, 14);
            html += '<div class="nv-side-h">Tags</div><div class="nv-tagcloud">'
                + shown.map(([k, g]) => `<button type="button" class="nv-tagchip${isCur('tag', k) ? ' nv-cur' : ''}" data-kind="tag" data-val="${esc(k)}" title="${g.count} note${g.count === 1 ? '' : 's'}">#${esc(g.label)}</button>`).join('')
                + (tl.length > 14 ? `<button type="button" class="nv-tagchip" data-kind="moretags">${S.tagsAll ? 'Show less' : '+' + (tl.length - 14) + ' more'}</button>` : '')
                + '</div>';
        }
        el.sideScroll.innerHTML = html;
    }

    /* ═════════════ Rendering: library ═════════════ */
    function libHeader(count) {
        const q = S.query.trim(), sc = S.scope;
        const pl = count === 1 ? 'note' : 'notes';
        const fx = (sc.kind !== 'trash' && filtersActive()) ? ' · filtered' : '';
        if (q) return ['Search results', `${count} of ${S.notes.length} notes match “${q}”${fx}`];
        if (sc.kind === 'trash') return ['Trash', count ? `${count} ${pl} · removed for good after 30 days` : 'Deleted notes wait here for 30 days'];
        if (sc.kind === 'recent') return ['Recent', `${count} ${pl} edited in the last 7 days${fx}`];
        if (sc.kind === 'pinned') return ['Pinned', `${count} ${pl}${fx}`];
        if (sc.kind === 'folder') return [(S.fmap.get(sc.value) || {}).label || 'Folder', `${count} ${pl}${fx}`];
        if (sc.kind === 'tag') return ['#' + ((S.tmap.get(sc.value) || {}).label || sc.value), `${count} ${pl}${fx}`];
        if (sc.kind === 'skill') {
            const careerTitle = (typeof skillsData !== 'undefined' && skillsData[sc.value.career]) ? skillsData[sc.value.career].title : sc.value.career;
            return [sc.value.skill, `${count} ${pl} linked · ${careerTitle}${fx}`];
        }
        if (sc.kind === 'course') return [sc.value.title || 'Course', `${count} ${pl} linked${fx}`];
        if (sc.kind === 'resource') return [sc.value.title || 'Resource', `${count} ${pl} linked${fx}`];
        if (sc.kind === 'analysis') return [sc.value.title || 'Analysis', `${count} ${pl} linked${fx}`];
        if (sc.kind === 'deal') return [sc.value.title || 'Deal', `${count} ${pl} linked${fx}`];
        return ['All notes', `${count} ${pl}${fx}`];
    }

    function loadingHtml() {
        return `<div class="nv-loading"><span class="nv-loading-spin" aria-hidden="true"></span>Opening your notes…</div>`;
    }

    function emptyHtml(searching) {
        if (S.loadError) {
            return `<div class="nv-empty nv-empty-error"><i class="fa-solid fa-triangle-exclamation"></i><strong>Couldn't open your notes</strong>Your notes live in this browser's local storage (IndexedDB), and it failed to open just now — nothing was deleted. This can happen in a private/incognito window, if site storage was cleared or blocked, or right after a browser update.<br><button type="button" class="nv-btn nv-btn-primary" data-retry-load><i class="fa-solid fa-rotate-right"></i> Try again</button></div>`;
        }
        if (searching) {
            return `<div class="nv-empty"><i class="fa-solid fa-magnifying-glass"></i><strong>No matches</strong>Nothing found for “${esc(S.query.trim())}”. Search ignores capital letters and accents, so try fewer or shorter words.</div>`;
        }
        if (S.scope.kind === 'trash') {
            return `<div class="nv-empty"><i class="fa-solid fa-trash"></i><strong>Trash is empty</strong>Deleted notes wait here for 30 days so you can change your mind. After that they are removed for good.</div>`;
        }
        if (!S.notes.length) {
            return `<div class="nv-empty"><i class="fa-solid fa-feather"></i><strong>Your vault is empty</strong>Paste a prompt, transcript or study note. Everything is saved as Markdown on this device, with no length limit.<br><button type="button" class="nv-btn nv-btn-primary" data-new><i class="fa-solid fa-plus"></i> New note</button></div>`;
        }
        const msg = { recent: 'Nothing has been edited in the last 7 days.', pinned: 'Pin a note and it will stay at the top of your vault.', skill: 'No notes are linked to this skill yet — open a note, use “Linked skill” in the Info panel.', course: 'No notes are linked to this course yet — “+ New note” here creates one already linked, or set “Course” in any note’s Info panel.', resource: 'No notes are linked to this resource yet — “+ New note” here creates one already linked, or set “Resource” in any note’s Info panel.', analysis: 'No notes are linked to this analysis yet — “+ New note” here creates one already linked, or set “Analysis” in any note’s Info panel.', deal: 'No notes are linked to this deal yet — “+ New note” here creates one already linked, or set “Deal” in any note’s Info panel.' }[S.scope.kind] || 'There are no notes here yet.';
        return `<div class="nv-empty"><i class="fa-solid fa-feather"></i><strong>Nothing here</strong>${msg}</div>`;
    }

    function rowHtml(n, tokens) {
        const searching = tokens.length > 0;
        const f = searching ? getFold(n) : null;
        const hasTitle = !!n.title.trim();
        const titleHtml = (searching && hasTitle) ? highlight(f.title, f.ft, tokens) : esc(hasTitle ? n.title : 'Untitled note');
        let snip = searching ? searchSnippet(n, tokens) : esc(plainSnippet(n.markdown));
        if (searching && f.fa && tokens.some((t) => findAt(f.fa, t, 0) >= 0 && findAt(f.fb, t, 0) < 0 && findAt(f.ft, t, 0) < 0)) {
            const ex = attSnippet(n, tokens);   // the words are only inside an attached file — say so
            if (ex) snip += (snip ? '<br>' : '') + '<i class="fa-solid fa-paperclip" aria-hidden="true"></i> ' + esc(ex);
        }
        const tagsHtml = n.tags.slice(0, 4).map((t) => `<span>#${esc(t)}</span>`).join('');
        const scoped = LINKABLE_SCOPES.has(S.scope.kind);
        const entityRowAction = scoped ? `<button type="button" class="nv-btn nv-btn-ghost nv-row-unlink" data-act="unlinkEntity" title="Remove this ${esc(S.scope.kind)} link"><i class="fa-solid fa-link-slash"></i> Unlink</button>` : '';
        return `<article class="nv-row" data-id="${esc(n.id)}">
            <div>
                <button type="button" class="nv-row-open" data-act="open">
                    <span class="nv-row-title">${n.pinned ? '<i class="fa-solid fa-star" aria-label="Pinned"></i>' : ''}<span>${titleHtml}</span></span>
                </button>
                ${snip ? `<div class="nv-row-snip">${snip}</div>` : ''}
                <div class="nv-row-meta">${folderPillHtml(n.type)}${tagsHtml}</div>
            </div>
            <div class="nv-row-side">
                <span title="${esc(fmtFull(n.updatedAt))}">${esc(fmtRel(n.updatedAt))}</span>
                <span class="nv-row-acts">
                    <button type="button" class="nv-ib${n.pinned ? ' nv-on-pin' : ''}" data-act="pin" title="${n.pinned ? 'Unpin' : 'Pin'}" aria-label="${n.pinned ? 'Unpin' : 'Pin'} note"><i class="fa-solid fa-star"></i></button>
                    <button type="button" class="nv-ib" data-act="move" title="Move to folder" aria-label="Move to folder"><i class="fa-solid fa-folder-tree"></i></button>
                    ${entityRowAction}
                    <button type="button" class="nv-ib nv-danger" data-act="del" title="Move to Trash" aria-label="Move note to Trash"><i class="fa-solid fa-trash"></i></button>
                </span>
            </div>
        </article>`;
    }

    function trashRowHtml(n) {
        const left = Math.max(0, Math.ceil((n.deletedAt + TRASH_MS - Date.now()) / 864e5));
        const hasTitle = !!n.title.trim();
        const snip = esc(plainSnippet(n.markdown));
        const when = fmtRel(n.deletedAt);
        return `<article class="nv-row nv-row-trash" data-id="${esc(n.id)}">
            <div>
                <div class="nv-row-title"><span>${esc(hasTitle ? n.title : 'Untitled note')}</span></div>
                ${snip ? `<div class="nv-row-snip">${snip}</div>` : ''}
                <div class="nv-row-meta">${folderPillHtml(n.type)}<span title="${esc(fmtFull(n.deletedAt))}">Deleted ${esc(when.charAt(0).toLowerCase() + when.slice(1))}</span><span>Removed for good in ${left} ${left === 1 ? 'day' : 'days'}</span></div>
            </div>
            <div class="nv-row-side">
                <span class="nv-row-acts nv-always">
                    <button type="button" class="nv-btn" data-act="restore"><i class="fa-solid fa-rotate-left"></i> Restore</button>
                    <button type="button" class="nv-btn nv-btn-warn" data-act="purge"><i class="fa-solid fa-trash"></i> Delete forever</button>
                </span>
            </div>
        </article>`;
    }

    function renderLibrary() {
        const tokens = qTokens();
        const list = filterNotes(tokens);
        const inTrash = S.scope.kind === 'trash' && !tokens.length;
        const [title, sub] = libHeader(list.length);
        el.libTitle.textContent = title;
        el.libSub.textContent = sub;
        el.emptyTrash.hidden = !(inTrash && list.length);
        renderScopeActions();
        if (!list.length) { el.list.innerHTML = emptyHtml(tokens.length > 0); updateStatusRight(); return; }
        const shown = list.slice(0, S.limit);
        el.list.innerHTML = shown.map((n) => inTrash ? trashRowHtml(n) : rowHtml(n, tokens)).join('')
            + (list.length > shown.length ? `<button type="button" class="nv-btn nv-more" data-more>Show ${Math.min(PAGE, list.length - shown.length)} more</button>` : '');
        updateStatusRight();
    }

    function renderAll() {
        renderSide();
        renderLibrary();
        renderTabStrip();
    }

    function updateStatusRight() {
        if (S.note) return refreshStats();
        el.statRight.textContent = S.notes.length + (S.notes.length === 1 ? ' note' : ' notes');
    }

    async function updateStorage() {
        try {
            const stats = await getVaultStorageStats();
            S.storageStats = stats;
            if (stats.browser.supported && stats.browser.quota) {
                const health = getStorageHealth(stats.totals.percent);
                el.storage.textContent = storageHealthMessage(stats.totals.percent, health);
                el.storage.title = fmtBytes(stats.browser.usage) + ' of ' + fmtBytes(stats.browser.quota) + ' — click the gear menu → Manage storage for a breakdown';
                el.storage.dataset.health = health.level;
                return;
            }
        } catch (e) { /* fall through */ }
        el.storage.removeAttribute('data-health');
        el.storage.title = '';
        el.storage.textContent = S.notes.length + ' notes';
    }

    // Turns literal "[[Title]]" / "[[Title|Alias]]" text left over from marked (which has no
    // wikilink syntax of its own) into real, clickable <a> elements. Built with createElement +
    // textContent rather than innerHTML, so this never needs a second DOMPurify pass.
    function linkifyWikilinks(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || node.nodeValue.indexOf('[[') === -1) return NodeFilter.FILTER_REJECT;
                for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
                    if (p.nodeName === 'CODE' || p.nodeName === 'PRE' || p.nodeName === 'A') return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        const nodes = [];
        let cur;
        while ((cur = walker.nextNode())) nodes.push(cur);
        nodes.forEach((node) => {
            const text = node.nodeValue;
            WIKILINK_RE.lastIndex = 0;
            let m, last = 0, hit = false;
            const frag = document.createDocumentFragment();
            while ((m = WIKILINK_RE.exec(text))) {
                const title = m[1].trim();
                if (!title) continue;
                hit = true;
                if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
                const alias = (m[2] || '').trim();
                const resolved = findNoteByTitle(title);
                const a = document.createElement('a');
                a.href = '#';
                a.className = resolved ? 'nv-wikilink' : 'nv-wikilink nv-wikilink-new';
                a.dataset.wikilink = title;
                a.title = resolved ? 'Open “' + title + '”' : 'Create note “' + title + '”';
                a.textContent = alias || title;
                frag.appendChild(a);
                last = m.index + m[0].length;
            }
            if (!hit) return;
            if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
            node.parentNode.replaceChild(frag, node);
        });
    }

    /* ═════════════ Frontmatter: "---\n…\n---" header at the very start of a note ═════════════
       Obsidian-style. Read mode always hides the block (stripped before markdown parsing,
       below); the raw block is left untouched in the note's own markdown/Edit mode. Pasting
       one into a blank note also pre-fills Folder/Tags/Title/Course/Deadline/Linked skill —
       see applyFrontmatterFill(), wired up from onEditorPaste. Recognised keys: title, type
       (or folder), tags, course, deadline (YYYY-MM-DD), career (a skillsData key) and skill
       (matched against skillsData — see findSkillMatch). */
    const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
    function stripYamlQuotes(s) {
        s = String(s == null ? '' : s).trim();
        if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
            return s.slice(1, -1);
        }
        return s;
    }
    // Minimal YAML reader: flat "key: value" pairs, inline "[a, b]" lists, and block lists
    // ("key:" followed by indented "- item" lines). Enough for the properties Obsidian and
    // this app actually write; not a general-purpose YAML parser.
    function parseYamlBlock(block) {
        const lines = block.split(/\r?\n/);
        const data = {};
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
            if (!m) continue;
            const key = m[1].toLowerCase();
            const rest = m[2].trim();
            if (!rest) {
                const items = [];
                let j = i + 1;
                while (j < lines.length && /^\s*-\s+/.test(lines[j])) { items.push(stripYamlQuotes(lines[j].replace(/^\s*-\s+/, ''))); j++; }
                if (items.length) { data[key] = items; i = j - 1; }
                continue;
            }
            if (rest[0] === '[' && rest[rest.length - 1] === ']') {
                data[key] = rest.slice(1, -1).split(',').map(stripYamlQuotes).filter(Boolean);
            } else {
                data[key] = stripYamlQuotes(rest);
            }
        }
        return data;
    }
    // Best-effort resolver for a frontmatter `skill:` field against the live skillsData —
    // an exact skill name typed by hand won't always match verbatim, so this only ever
    // auto-fills when there's exactly one unambiguous hit; anything looser is left for the
    // person to pick by hand in the Linked skill dropdown instead of silently guessing wrong.
    function findSkillMatch(skillName, careerHint) {
        if (typeof skillsData === 'undefined') return null;
        const norm = (s) => String(s || '').trim().toLowerCase();
        const target = norm(skillName);
        if (!target) return null;
        const searchCareer = (key) => {
            const c = skillsData[key];
            if (!c) return null;
            for (const cat of Object.values(c.categories || {})) {
                for (const sk of cat.skills || []) {
                    if (norm(sk.name) === target) return { career: key, skill: sk.name };
                }
            }
            return null;
        };
        if (careerHint && skillsData[careerHint]) {
            const hit = searchCareer(careerHint);
            if (hit) return hit;
        }
        const matches = Object.keys(skillsData).map(searchCareer).filter(Boolean);
        return matches.length === 1 ? matches[0] : null;
    }
    // Splits a note's markdown into { body, data }: body has the frontmatter block removed
    // (used to keep it out of Read mode, and out of re-exported .md files); data is a
    // normalised { title?, type?, tags?, career?, skill?, course?, deadline? } or null when
    // there's no recognised block.
    function extractFrontmatter(md) {
        const m = md.match(FRONTMATTER_RE);
        if (!m) return { body: md, data: null };
        const raw = parseYamlBlock(m[1]);
        const data = {};
        if (raw.title) data.title = String(Array.isArray(raw.title) ? raw.title[0] : raw.title).trim();
        const folderVal = raw.type || raw.folder;
        if (folderVal) data.type = String(Array.isArray(folderVal) ? folderVal[0] : folderVal).trim();
        if (raw.tags) {
            const arr = Array.isArray(raw.tags) ? raw.tags : String(raw.tags).split(',');
            const tags = arr.map((t) => normTag(t)).filter(Boolean);
            if (tags.length) data.tags = tags;
        }
        if (raw.career) data.career = String(Array.isArray(raw.career) ? raw.career[0] : raw.career).trim();
        if (raw.skill) data.skill = String(Array.isArray(raw.skill) ? raw.skill[0] : raw.skill).trim();
        if (raw.course) data.course = String(Array.isArray(raw.course) ? raw.course[0] : raw.course).trim();
        if (raw.deadline) {
            const dl = String(Array.isArray(raw.deadline) ? raw.deadline[0] : raw.deadline).trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(dl)) data.deadline = dl;   // only ISO dates — anything else is ambiguous to parse safely
        }
        return { body: md.slice(m[0].length), data: Object.keys(data).length ? data : null };
    }
    // Pasting an Obsidian-style note into a blank one pre-fills Folder/Tags/Title, and now
    // also Course/Deadline/Linked skill, from its frontmatter — never overwrites a field the
    // note already has, only fills what's empty.
    function applyFrontmatterFill(pastedText) {
        const n = S.note;
        if (!n) return;
        const { data } = extractFrontmatter(pastedText);
        if (!data) return;
        let changed = false;
        if (data.title && !n.title.trim()) {
            n.title = data.title;
            if (el.title) { el.title.value = n.title; fitTitle(); }
            changed = true;
        }
        if (data.type && normType(n.type) === 'General') {
            n.type = data.type;
            if (el.folderIn) el.folderIn.value = normType(n.type);
            changed = true;
        }
        if (data.tags && data.tags.length && !n.tags.length) {
            n.tags = data.tags.slice();
            changed = true;
        }
        if (data.course && !n.course) {
            n.course = data.course;
            if (el.course) el.course.value = n.course;
            changed = true;
        }
        if (data.deadline && !n.deadline) {
            n.deadline = data.deadline;
            if (el.deadline) el.deadline.value = n.deadline;
            changed = true;
        }
        if ((data.skill || data.career) && !EntityLinks.getId(n, 'skill')) {
            const hit = data.skill ? findSkillMatch(data.skill, data.career) : null;
            if (hit) {
                EntityLinks.link(n, 'skill', hit.skill, { career: hit.career });
                nvPopulateCareerOptions();
                if (el.linkedCareer) el.linkedCareer.value = n.linkedCareer;
                nvPopulateSkillOptions();
                if (el.linkedSkill) el.linkedSkill.value = n.linkedSkill;
                changed = true;
                if (window.nvRefreshSkillBadges) window.nvRefreshSkillBadges();
            }
        }
        if (changed) { renderTagChips(); renderDocMeta(); nvUpdateLinkCount(); markDirty(); toast('Filled in note details from the pasted frontmatter.'); }
    }

    /* ═════════════ Footnotes: "[^1]" refs + "[^1]: text" definitions ═════════════
       marked has no footnote syntax of its own, so definitions are pulled out of the raw
       markdown before parsing (extractFootnoteDefs — skips fenced code, keeps indented
       continuation lines), and the "[^id]" references left in the parsed HTML are turned
       into numbered, linked superscripts afterwards (renderFootnotes), numbered in the
       order they're first referenced. Ids with no matching reference in the text are
       silently dropped, same as unreferenced link definitions. */
    function extractFootnoteDefs(md) {
        const lines = md.split('\n');
        const defs = new Map();      // id -> array of raw markdown lines
        const bodyLines = [];
        let inFence = false, fenceCh = '', fenceLen = 0;
        let curId = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const fm = line.match(/^\s*(`{3,}|~{3,})/);
            if (fm) {
                if (!inFence) { inFence = true; fenceCh = fm[1][0]; fenceLen = fm[1].length; }
                else if (fm[1][0] === fenceCh && fm[1].length >= fenceLen) { inFence = false; }
                bodyLines.push(line);
                curId = null;
                continue;
            }
            if (!inFence) {
                const dm = line.match(/^\[\^([^\]\s]+)\]:[ \t]?(.*)$/);
                if (dm) {
                    curId = dm[1];
                    if (!defs.has(curId)) defs.set(curId, []);
                    defs.get(curId).push(dm[2]);
                    continue;
                }
                if (curId !== null) {
                    if (/^(\t| {2,})/.test(line)) { defs.get(curId).push(line.replace(/^(\t| {1,})/, '')); continue; }
                    if (line.trim() === '' && i + 1 < lines.length && /^(\t| {2,})/.test(lines[i + 1])) { defs.get(curId).push(''); continue; }
                    curId = null;
                }
            }
            bodyLines.push(line);
        }
        const out = new Map();
        defs.forEach((arr, id) => { const text = arr.join('\n').trim(); if (text) out.set(id, text); });
        return { body: bodyLines.join('\n'), defs: out };
    }
    const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g;
    function renderFootnotes(root, defs) {
        if (!defs || !defs.size) return;
        const order = [];                 // ids, in first-reference order
        const numberOf = new Map();
        const gotFirstAnchor = new Set();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || node.nodeValue.indexOf('[^') === -1) return NodeFilter.FILTER_REJECT;
                for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
                    if (p.nodeName === 'CODE' || p.nodeName === 'PRE' || p.nodeName === 'A') return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        const nodes = [];
        let cur;
        while ((cur = walker.nextNode())) nodes.push(cur);
        nodes.forEach((node) => {
            const text = node.nodeValue;
            FOOTNOTE_REF_RE.lastIndex = 0;
            let m, last = 0, hit = false;
            const frag = document.createDocumentFragment();
            while ((m = FOOTNOTE_REF_RE.exec(text))) {
                const id = m[1];
                if (!defs.has(id)) continue;
                hit = true;
                if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
                if (!numberOf.has(id)) { numberOf.set(id, numberOf.size + 1); order.push(id); }
                const n = numberOf.get(id);
                const sup = document.createElement('sup');
                sup.className = 'nv-fnref';
                const a = document.createElement('a');
                a.href = '#nv-fn-' + n;
                a.textContent = String(n);
                a.title = 'Jump to footnote ' + n;
                if (!gotFirstAnchor.has(id)) { a.id = 'nv-fnref-' + n; gotFirstAnchor.add(id); }
                sup.appendChild(a);
                frag.appendChild(sup);
                last = m.index + m[0].length;
            }
            if (!hit) return;
            if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
            node.parentNode.replaceChild(frag, node);
        });
        if (!order.length) return;
        const section = document.createElement('section');
        section.className = 'nv-footnotes';
        section.appendChild(document.createElement('hr'));
        const ol = document.createElement('ol');
        order.forEach((id, i) => {
            const n = i + 1;
            const li = document.createElement('li');
            li.id = 'nv-fn-' + n;
            const raw = defs.get(id) || '';
            let bodyHtml;
            try {
                bodyHtml = window.marked ? (window.marked.parseInline ? window.marked.parseInline(raw, { gfm: true }) : window.marked.parse(raw, { gfm: true })) : esc(raw);
            } catch (e) { bodyHtml = esc(raw); }
            if (window.DOMPurify) bodyHtml = DOMPurify.sanitize(bodyHtml, { FORBID_TAGS: ['style'] });
            const span = document.createElement('span');
            span.className = 'nv-fn-body';
            span.innerHTML = bodyHtml;
            span.querySelectorAll('a[href]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
            const back = document.createElement('a');
            back.href = '#nv-fnref-' + n;
            back.className = 'nv-fn-back';
            back.title = 'Back to text';
            back.setAttribute('aria-label', 'Back to reference ' + n);
            back.innerHTML = '<i class="fa-solid fa-turn-up" aria-hidden="true"></i>';
            li.appendChild(span);
            li.appendChild(document.createTextNode(' '));
            li.appendChild(back);
            ol.appendChild(li);
        });
        section.appendChild(ol);
        root.appendChild(section);
    }

    /* ═════════════ LaTeX protection for the Markdown → reading pipeline ═════════════
       MathJax (loaded globally elsewhere, delimiters \( \), $$ $$, \[ \]) only typesets
       math it can recognise as one intact chunk of text. Two things break that before it
       ever sees the note:
         1. Content pasted from elsewhere often uses a bare "[" / "]" on their own line as
            an informal display-math delimiter, which MathJax does not understand at all.
         2. Markdown (marked, with breaks:true) will (a) turn "_x_" / "*x*" inside a formula
            into <em>, mangling things like Revenue_t, and (b) insert <br> at every internal
            newline, splitting one formula across several text nodes so MathJax can't match
            the whole thing even when real \[ \] delimiters are used.
       mjxPrepare() runs before marked: it upgrades bare [ ... ] blocks to \[ ... \], then
       swaps every recognised math span (display or inline) out for an opaque placeholder
       token so Markdown can't touch its contents. Its restore() puts the original LaTeX
       back — as a single flattened line, HTML-escaped (safe to run before DOMPurify, since
       it's just escaped text, not markup) — right after marked has produced HTML, so
       MathJax finally sees one clean text node per formula. */
    function mjxPrepare(src) {
        // Park fenced code blocks and inline code behind tokens so the math rules below never touch them.
        const codeStore = [];
        const cnonce = 'MJXCODE' + Math.random().toString(36).slice(2, 8);
        const park = (t) => { codeStore.push(t); return cnonce + (codeStore.length - 1) + 'E'; };
        const unpark = (t) => codeStore.length
            ? t.replace(new RegExp(cnonce + '(\\d+)E', 'g'), (_, i) => codeStore[Number(i)]) : t;
        {
            const out = []; let fence = null, buf = [];
            for (const line of src.split('\n')) {
                if (!fence) {
                    const m = /^[ \t]*(`{3,}|~{3,})/.exec(line);
                    if (m) { fence = { ch: m[1][0], len: m[1].length }; buf = [line]; } else out.push(line);
                } else {
                    buf.push(line);
                    const m = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
                    if (m && m[1][0] === fence.ch && m[1].length >= fence.len) { out.push(park(buf.join('\n'))); fence = null; buf = []; }
                }
            }
            if (fence) out.push(park(buf.join('\n')));
            src = out.join('\n').replace(/(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g, (m) => park(m));
        }
        // Bare "[ ... ]" block on its own lines → "\[ ... \]" (flattened to one line so it
        // can't be split by breaks:true later).
        src = src.replace(/^[ \t]*\[[ \t]*\n([\s\S]*?)\n[ \t]*\][ \t]*$/gm, (_, body) =>
            '\\[' + body.split('\n').map((l) => l.trim()).filter(Boolean).join(' ') + '\\]');
        const store = [];
        const nonce = 'MJXPH' + Math.random().toString(36).slice(2, 8);
        const guard = (re) => {
            src = src.replace(re, (m) => {
                store.push(unpark(m.split('\n').map((l) => l.trim()).join(' ')));
                return nonce + (store.length - 1) + 'E';
            });
        };
        guard(/\$\$[\s\S]*?\$\$/g);
        guard(/\\\[[\s\S]*?\\\]/g);
        guard(/\\\([\s\S]*?\\\)/g);

        // Bare "$ ... $" inline math (what Gemini / ChatGPT / Pandoc emit, e.g. "$G$", "$\frac{a}{b}$").
        // Pandoc's rules keep currency literal: the opener can't be followed by whitespace, the closer
        // can't be preceded by whitespace or followed by a digit or letter. So "$100 vs $99" and
        // "$5-$10" stay plain text, while "$G$" and "$3 \times 2 = 6$" become real formulas.
        // Runs after the delimiters above are parked, so "$$ ... $$" is never split.
        src = src.replace(/(?<![\\$\w])\$(?![\s$])((?:\\.|[^$\n\\])+?)(?<![\s\\])\$(?![\d\w$])/g, (m, inner) => {
            store.push('\\(' + inner + '\\)');
            return nonce + (store.length - 1) + 'E';
        });
        return { text: unpark(src), restore: (html) => store.length
            ? html.replace(new RegExp(nonce + '(\\d+)E', 'g'), (_, i) => esc(store[Number(i)]))
            : html };
    }

    /* ═════════════ Markdown → reading view ═════════════ */
    function renderInto(target, md, interactive, attachOpts) {
        if (target === el.read) { tblSess = null; blkSess = null; }
        if (!md.trim()) {
            target.innerHTML = '<p class="nv-blank">Nothing here yet — switch to Edit and start writing.</p>';
            return;
        }
        const afterFm = extractFrontmatter(md).body;            // frontmatter never shows in Read mode
        const { body: forMarked, defs: footnoteDefs } = extractFootnoteDefs(afterFm);
        const mjx = mjxPrepare(forMarked);
        let html;
        try {
            const opts = { gfm: true, breaks: true };   // single newline = line break (Obsidian default; good for transcripts)
            html = window.marked ? (window.marked.parse ? window.marked.parse(mjx.text, opts) : window.marked(mjx.text, opts)) : null;
        } catch (e) { console.warn('Notes Vault markdown error:', e); html = null; }
        if (html == null || !window.DOMPurify) {
            // No renderer/sanitiser available: show plain text rather than inject unsanitised HTML.
            target.innerHTML = '<pre style="white-space:pre-wrap">' + esc(md) + '</pre>';
            return;
        }
        html = mjx.restore(html);
        // DOMPurify's default ALLOWED_URI_REGEXP only accepts a small whitelist of protocols
        // (http, https, mailto, …) in src/href — "attachment:" isn't in it, so an attached
        // image's src would otherwise get silently stripped. Extend the same default regex
        // rather than replacing it, so nothing else about link sanitisation changes.
        html = DOMPurify.sanitize(html, {
            FORBID_TAGS: ['style'],
            ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|attachment):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
        });
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        linkifyWikilinks(tpl.content);
        mmMarkBlocks(tpl.content);   // ```mermaid fences → diagram placeholders (drawn once they're in the page)
        vizMarkBlocks(tpl.content);  // ```visual fences → pasted charts (drawn once they're in the page)
        tpl.content.querySelectorAll('table').forEach((tb) => {
            const w = document.createElement('div');
            w.className = 'nv-tablewrap';
            tb.replaceWith(w);
            w.appendChild(tb);
            if (interactive !== false && target === el.read) {
                const pb = document.createElement('button');
                pb.type = 'button'; pb.className = 'nv-tbl-pencil'; pb.title = 'Edit this table in place'; pb.setAttribute('aria-label', 'Edit table');
                pb.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i>';
                w.insertBefore(pb, tb);
            }
        });
        highlightCode(tpl.content);
        addCodeCopyButtons(tpl.content);
        convertCallouts(tpl.content);
        // GFM task checkboxes ("- [ ] …") come out of marked as disabled <input>s. The
        // `checked` HTML attribute always survives (marked writes it, DOMPurify keeps it),
        // but some browsers don't reliably carry the *live* `.checked` property through a
        // <template>'s inert content being adopted into the real document — every box then
        // renders unchecked no matter what the source says. Force it back from the attribute
        // every time, regardless of browser quirks. Also leave boxes disabled while previewing
        // an old revision (read-only); otherwise make them clickable — the click handler on
        // el.read does the actual toggling + writes back to the source.
        tpl.content.querySelectorAll('li > input[type="checkbox"]').forEach((cb) => {
            cb.checked = cb.hasAttribute('checked');
            if (interactive !== false) cb.disabled = false;
        });
        tpl.content.querySelectorAll('a[href]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
        // Footnote refs/backlinks are added after the pass above so they keep plain in-page
        // "#id" navigation (no target="_blank", which would open a blank new tab instead of
        // scrolling) — they're same-document jumps, not external links.
        renderFootnotes(tpl.content, footnoteDefs);
        applyImageSizes(tpl.content);
        target.replaceChildren(tpl.content);
        mmRenderPending(target);
        vizRenderPending(target);
        if (window.MathJax && window.MathJax.typesetPromise) window.MathJax.typesetPromise([target]).catch(() => {});
        return resolveAttachments(target, attachOpts);
    }

    // Swaps every <img src="attachment://ID"> left over from marked/DOMPurify for a real
    // blob: URL read out of the attachments store, and wires the click-to-open popover.
    // Object URLs from the *previous* render are revoked first — nothing here is cached
    // across renders, since the note being shown can change at any time.
    async function resolveAttachments(target, opts) {
        // `opts.urls` = isolated mode (PDF export): blob: URLs go into the caller's own array and the
        // Read view's URLs are left alone — otherwise exporting would revoke the on-screen images.
        const sink = opts && opts.urls ? opts.urls : null;
        if (!sink) {
            S.attachObjectUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
            S.attachObjectUrls = [];
        }
        const urlSink = sink || S.attachObjectUrls;
        const imgs = Array.from(target.querySelectorAll('img[src^="attachment://"]'));
        // Read every attachment the note needs from IndexedDB in ONE parallel batch (they used to be fetched one at a time,
        // so a note with 30 pictures waited for 30 sequential database round-trips).
        {
            const need = new Set();
            target.querySelectorAll('img[src^="attachment://"]').forEach((i) => need.add(i.getAttribute('src').slice('attachment://'.length)));
            target.querySelectorAll('a[href^="attachment://"]').forEach((a) => need.add(a.getAttribute('href').slice('attachment://'.length)));
            await Promise.all(Array.from(need).filter((id) => !S.attachmentCache.has(id)).map((id) =>
                dbGetAttachment(id).then((rec) => { if (rec && rec.blob instanceof Blob && rec.blob.size > 0) S.attachmentCache.set(id, rec); }).catch(() => {})));
            if (!target.isConnected) return;
        }
        for (const img of imgs) {
            const id = img.getAttribute('src').slice('attachment://'.length);
            img.removeAttribute('src');
            let rec = S.attachmentCache.get(id) || null;
            if (!rec) {
                try { rec = await dbGetAttachment(id); } catch (e) { /* try session cache below */ }
            }
            if (!target.isConnected) return;   // the view moved on while this lookup was in flight
            if (!rec || !(rec.blob instanceof Blob) || rec.blob.size <= 0) {
                // One last cache check covers the common case where the attachment was just
                // inserted and a browser is slow/inconsistent about the follow-up IndexedDB read.
                rec = S.attachmentCache.get(id) || null;
            }
            if (!rec || !(rec.blob instanceof Blob) || rec.blob.size <= 0) {
                img.setAttribute('data-nv-attach-missing', '');
                img.alt = (img.alt || 'image') + ' (attachment no longer available)';
                continue;
            }
            S.attachmentCache.set(id, rec);
            let url;
            try { url = URL.createObjectURL(rec.blob); }
            catch (e) {
                img.setAttribute('data-nv-attach-missing', '');
                img.alt = (img.alt || 'image') + ' (attachment could not be opened)';
                continue;
            }
            urlSink.push(url);
            if (!sink) { img.decoding = 'async'; img.loading = 'lazy'; }   // on-screen Read view only — printing forces eager
            img.src = url;
            img.setAttribute('data-nv-attach', id);
            img.addEventListener('click', (e) => { e.preventDefault(); openAttachMenu(rec, img); });
        }

        // Non-image attachments (currently: PDFs) are inserted as a plain markdown link —
        // `[label](attachment://id)` — since a browser can't decode them as an <img>. Swap each
        // one for an inline viewer card instead of leaving a dead "attachment://…" href behind.
        const links = Array.from(target.querySelectorAll('a[href^="attachment://"]'));
        for (const a of links) {
            const id = a.getAttribute('href').slice('attachment://'.length);
            let rec = S.attachmentCache.get(id) || null;
            if (!rec) {
                try { rec = await dbGetAttachment(id); } catch (e) { /* try session cache below */ }
            }
            if (!target.isConnected) return;
            if (!rec || !(rec.blob instanceof Blob) || rec.blob.size <= 0) rec = S.attachmentCache.get(id) || null;
            if (!rec || !(rec.blob instanceof Blob) || rec.blob.size <= 0) {
                a.removeAttribute('href');
                a.classList.add('nv-attach-missing');
                a.textContent = (a.textContent || 'file') + ' (attachment no longer available)';
                continue;
            }
            S.attachmentCache.set(id, rec);
            let url;
            try { url = URL.createObjectURL(rec.blob); } catch (e) { continue; }
            urlSink.push(url);
            if (rec.mime === 'application/pdf') {
                renderPdfEmbed(a, rec, url);
            } else if (isSheetMime(rec.mime)) {
                renderFileCard(a, rec, url);
            } else {
                // Any other non-image attachment reached via a plain link — just point it at a
                // working blob: URL rather than leaving the inert "attachment://…" scheme in place.
                a.href = url;
                a.target = '_blank';
                a.rel = 'noopener';
            }
        }
    }

    // Replaces a `[label](attachment://id)` anchor with an inline PDF viewer: a small title bar
    // (filename, size, "…" menu reusing openAttachMenu) plus an <iframe> onto the blob: URL,
    // which every modern desktop/mobile browser renders using its own built-in PDF viewer — no
    // pdf.js or other bundled renderer needed, and it keeps working if that CDN is ever offline.
    function renderPdfEmbed(anchor, rec, url) {
        const wrap = document.createElement('div');
        wrap.className = 'nv-pdf-embed';
        wrap.innerHTML =
            '<div class="nv-pdf-embed-bar">'
            + '<i class="fa-solid fa-file-pdf" aria-hidden="true"></i>'
            + '<span class="nv-pdf-embed-name"></span>'
            + '<span class="nv-pdf-embed-size"></span>'
            + '<button type="button" class="nv-pdf-embed-more" aria-label="PDF options" title="PDF options"><i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i></button>'
            + '</div>'
            + '<iframe class="nv-pdf-embed-frame" loading="lazy"></iframe>';
        const name = (rec.filename || anchor.textContent || 'PDF document').replace(/^\uD83D\uDCC4\s*/, '');
        wrap.querySelector('.nv-pdf-embed-name').textContent = name;
        wrap.querySelector('.nv-pdf-embed-size').textContent = fmtBytes(rec.size);
        const frame = wrap.querySelector('.nv-pdf-embed-frame');
        frame.title = name;
        frame.src = url;
        wrap.querySelector('.nv-pdf-embed-more').addEventListener('click', (e) => {
            e.preventDefault();
            openAttachMenu(rec, e.currentTarget);
        });
        anchor.replaceWith(wrap);
    }

    /* ── Spreadsheet preview: SheetJS is fetched lazily on the first "Preview" click (never at
       page load), reads only the first rows of each sheet, and renders through textContent so
       cell contents can never inject markup. Read-only — the stored file is never modified. ── */
    const SHEETJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    const SHEET_PREVIEW_ROWS = 200, SHEET_PREVIEW_COLS = 40;
    setTimeout(() => { if (navigator.onLine !== false && window.caches) sheetJsFromCache().catch(() => {}); }, 15000);
    let sheetJsPromise = null;
    // Offline-first: after one successful download the reader is kept in the browser's Cache Storage
    // and loaded from there next time (no network). Where Cache Storage doesn't exist (file://) or
    // nothing is cached yet and we're offline, this rejects and the plain CDN <script> below runs.
    async function sheetJsFromCache() {
        if (!window.caches) throw new Error('no Cache Storage');
        const c = await caches.open('nv-libs-v1');
        let r = await c.match(SHEETJS_URL);
        if (!r) {
            r = await fetch(SHEETJS_URL, { mode: 'cors' });
            if (!r.ok) throw new Error('http ' + r.status);
            await c.put(SHEETJS_URL, r.clone());
        }
        const url = URL.createObjectURL(new Blob([await r.text()], { type: 'text/javascript' }));
        try {
            await new Promise((res, rej) => {
                const s = document.createElement('script');
                s.src = url;
                s.onload = res;
                s.onerror = () => { s.remove(); rej(new Error('cached copy unusable')); };
                document.head.appendChild(s);
            });
        } finally { URL.revokeObjectURL(url); }
        if (!window.XLSX) { try { await c.delete(SHEETJS_URL); } catch (e) { /* ignore */ } throw new Error('cached copy unusable'); }
        return window.XLSX;
    }
    function loadSheetJs() {
        if (window.XLSX) return Promise.resolve(window.XLSX);
        if (!sheetJsPromise) sheetJsPromise = sheetJsFromCache().catch(() => new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = SHEETJS_URL; s.async = true;
            s.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error('reader unavailable'));
            s.onerror = () => { sheetJsPromise = null; s.remove(); reject(new Error('couldn\u2019t load the spreadsheet reader (offline?)')); };
            document.head.appendChild(s);
        }));
        return sheetJsPromise;
    }
    function sheetToTable(X, ws, onSel, rowCap, onMore) {
        const scroll = document.createElement('div');
        scroll.className = 'nv-sheet-scroll';
        const holder = document.createElement('div');
        if (!ws || !ws['!ref']) { scroll.textContent = 'This sheet is empty.'; scroll.style.padding = '10px'; holder.appendChild(scroll); return holder; }
        const rng = X.utils.decode_range(ws['!ref']);
        const full = ws['!fullref'] ? X.utils.decode_range(ws['!fullref']) : rng;
        const lastC = Math.min(rng.e.c, rng.s.c + SHEET_PREVIEW_COLS - 1);
        const lastR = Math.min(rng.e.r, rng.s.r + (rowCap || SHEET_PREVIEW_ROWS) - 1);
        const rows = X.utils.sheet_to_json(ws, {
            header: 1, raw: false, defval: '', blankrows: false,
            range: X.utils.encode_range({ s: rng.s, e: { r: lastR, c: lastC } })
        });
        const width = lastC - rng.s.c + 1;
        const table = document.createElement('table');
        const grid = [];
        const thead = document.createElement('thead'), tbody = document.createElement('tbody');
        rows.forEach((row, ri) => {
            const tr = document.createElement('tr');
            const gr = []; grid.push(gr);
            for (let c = 0; c < width; c++) {
                const cell = document.createElement(ri === 0 ? 'th' : 'td');
                cell.dataset.r = ri; cell.dataset.c = c; gr.push(cell);
                const v = row[c];
                cell.textContent = v == null ? '' : String(v);
                if (cell.textContent) cell.title = cell.textContent;
                tr.appendChild(cell);
            }
            (ri === 0 ? thead : tbody).appendChild(tr);
        });
        table.append(thead, tbody);
        scroll.appendChild(table);
        holder.appendChild(scroll);
        // Cell-range selection: mouse drag or shift-click; on touch, tap one cell then another.
        // Ctrl/Cmd+C copies the range as tab-separated text (which pastes into a note as a table).
        scroll.tabIndex = 0;
        let sel = null, anchor = null, dragging = false, ptype = 'mouse';
        const paint = (on) => { if (sel) for (let r = sel.r1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) if (grid[r] && grid[r][c]) grid[r][c].classList.toggle('nv-sel', on); };
        const setSel = (a, b) => {
            paint(false);
            sel = a && b ? { r1: Math.min(a.r, b.r), r2: Math.max(a.r, b.r), c1: Math.min(a.c, b.c), c2: Math.max(a.c, b.c) } : null;
            paint(true);
            holder.sel = sel;
            if (onSel) onSel(sel);
        };
        const cellAt = (e) => {
            const t = e.target && e.target.closest ? e.target.closest('th,td') : null;
            return t && table.contains(t) ? { r: +t.dataset.r, c: +t.dataset.c } : null;
        };
        holder.sel = null;
        holder.clearSel = () => { anchor = null; setSel(null, null); };
        // Selected cells' text; when the range doesn't start at the sheet's header row, that row is prepended.
        holder.selectedRows = (withHeader) => {
            if (!sel) return null;
            const pick = (r) => grid[r].slice(sel.c1, sel.c2 + 1).map((x) => x.textContent);
            const out = [];
            if (withHeader && sel.r1 > 0) out.push(pick(0));
            for (let r = sel.r1; r <= sel.r2; r++) out.push(pick(r));
            return out;
        };
        table.addEventListener('pointerdown', (e) => {
            ptype = e.pointerType || 'mouse';
            if (ptype !== 'mouse' || e.button !== 0) return;
            const cell = cellAt(e); if (!cell) return;
            e.preventDefault();
            scroll.focus({ preventScroll: true });
            if (e.shiftKey && anchor) setSel(anchor, cell); else { anchor = cell; setSel(cell, cell); }
            dragging = true;
            document.addEventListener('pointerup', () => { dragging = false; }, { once: true });
        });
        table.addEventListener('pointerover', (e) => { if (!dragging) return; const cell = cellAt(e); if (cell) setSel(anchor, cell); });
        table.addEventListener('click', (e) => {
            if (ptype === 'mouse') return;
            const cell = cellAt(e); if (!cell) return;
            const single = sel && sel.r1 === sel.r2 && sel.c1 === sel.c2;
            if (single && anchor) setSel(anchor, cell); else { anchor = cell; setSel(cell, cell); }
        });
        scroll.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sel) { e.stopPropagation(); holder.clearSel(); } });
        scroll.addEventListener('copy', (e) => {
            const rowsSel = holder.selectedRows(false);
            if (!rowsSel || !e.clipboardData) return;
            e.clipboardData.setData('text/plain', rowsSel.map((r) => r.join('\t')).join('\n'));
            e.preventDefault();
        });
        const totR = full.e.r - full.s.r + 1, totC = full.e.c - full.s.c + 1;
        if (rows.length < totR || width < totC) {
            const note = document.createElement('div');
            note.className = 'nv-sheet-note';
            note.textContent = 'Showing the first ' + rows.length + ' rows \u00d7 ' + width + ' columns of ' + totR + ' \u00d7 ' + totC + '.' + (width < totC ? ' Download the file to see every column.' : '');
            if (onMore && full.e.r > lastR) {
                const more = document.createElement('button');
                more.type = 'button'; more.className = 'nv-sheet-copy'; more.style.marginLeft = '8px';
                more.textContent = 'Show 500 more rows';
                more.addEventListener('click', () => { more.disabled = true; more.textContent = 'Loading\u2026'; onMore(); });
                note.appendChild(more);
            }
            holder.appendChild(note);
        }
        return holder;
    }
    function sheetRowsOf(X, ws, rowCap) {   // same window the preview shows, as plain string rows
        if (!ws || !ws['!ref']) return [];
        const rng = X.utils.decode_range(ws['!ref']);
        const lastC = Math.min(rng.e.c, rng.s.c + SHEET_PREVIEW_COLS - 1);
        const lastR = Math.min(rng.e.r, rng.s.r + (rowCap || SHEET_PREVIEW_ROWS) - 1);
        return X.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false,
            range: X.utils.encode_range({ s: rng.s, e: { r: lastR, c: lastC } }) });
    }
    // "Insert into note": writes the sheet as a Markdown table into the note's source, directly
    // below the line holding this file's card (the card only exists in Read mode, where there is
    // no visible caret). Same path as ticking a task box: edit S.note.markdown, sync the
    // textarea, mark dirty, re-render. One-step Undo from the toast.
    function insertSheetTableIntoNote(card, md, truncated, rowCap) {
        const n = S.note;
        if (!n || S.viewRev || !el.read.contains(card)) { toast('Open the note in Read mode (not a version preview) to insert a table.'); return; }
        const before = n.markdown, marker = 'attachment://' + card.dataset.att;
        const k = Array.from(el.read.querySelectorAll('.nv-file-card')).filter((c) => c.dataset.att === card.dataset.att).indexOf(card);
        const lines = before.split('\n');
        let inFence = false, seen = 0, at = -1, off = 0;
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (/^\s*(`{3,}|~{3,})/.test(l)) inFence = !inFence;
            else if (!inFence && l.indexOf(marker) !== -1) { if (seen === k) { at = off + l.length; break; } seen++; }
            off += l.length + 1;
        }
        if (at === -1) at = before.length;   // link not found (unusual markup): append at the end
        const after = before.slice(at);
        const newMd = before.slice(0, at) + '\n\n' + md + (after === '' || after.startsWith('\n\n') ? '' : '\n') + after;
        const sc = el.docScroll.scrollTop;
        n.markdown = newMd; el.src.value = newMd;
        markDirty();
        renderInto(el.read, newMd);
        el.docScroll.scrollTop = sc;
        toast(truncated ? 'Table inserted below the file (first ' + (rowCap || SHEET_PREVIEW_ROWS) + ' rows \u00d7 40 columns).' : 'Table inserted below the file.', 'Undo', () => {
            if (S.note !== n || n.markdown !== newMd) { toast('The note changed since — use version history to go back.'); return; }
            n.markdown = before; el.src.value = before;
            markDirty();
            renderInto(el.read, before);
        });
    }
    async function fillSheetPreview(panel, rec) {
        panel.textContent = 'Loading preview\u2026';
        try {
            const X = await loadSheetJs();
            let rowCap = SHEET_PREVIEW_ROWS;
            const readWb = async () => {
                const opts = { sheetRows: rowCap + 1, cellDates: true };
                return rec.mime === 'text/csv'
                    ? X.read(await rec.blob.text(), Object.assign({ type: 'string' }, opts))     // text() keeps UTF-8 intact
                    : X.read(await rec.blob.arrayBuffer(), Object.assign({ type: 'array' }, opts));
            };
            let wb = await readWb();
            const names = wb.SheetNames || [];
            if (!names.length) throw new Error('no sheets found');
            panel.textContent = '';
            const tabs = document.createElement('div');
            tabs.className = 'nv-sheet-tabs';
            tabs.setAttribute('role', 'tablist');
            const body = document.createElement('div');
            let cur = 0, tbl = null;
            const bar = document.createElement('div');
            bar.className = 'nv-sheet-bar';
            const copy = document.createElement('button');
            copy.type = 'button'; copy.className = 'nv-sheet-copy'; copy.title = 'Copy this sheet as a Markdown table';
            copy.innerHTML = '<i class="fa-solid fa-copy" aria-hidden="true"></i> <span>Copy as Markdown</span>';
            copy.addEventListener('click', async () => {
                const md = rowsToMarkdownTable(currentRows());
                if (!md) { toast(tbl && tbl.sel ? 'Select at least 2 columns to copy as a table.' : 'This sheet has no table to copy (needs 2+ rows and 2+ columns).'); return; }
                try { await navigator.clipboard.writeText(md); toast(tbl && tbl.sel ? 'Selection copied as a Markdown table.' : 'Markdown table copied \u2014 paste it into any note.'); }
                catch (err) { toast('Couldn\u2019t access the clipboard.'); }
            });
            // A selected range wins; the sheet's header row is added when the range starts below it.
            const currentRows = () => (tbl && tbl.selectedRows && tbl.selectedRows(true)) || sheetRowsOf(X, wb.Sheets[names[cur]], rowCap);
            const info = document.createElement('span');
            info.className = 'nv-sheet-info';
            const ins = document.createElement('button');
            ins.type = 'button'; ins.className = 'nv-sheet-copy'; ins.title = 'Insert this sheet as a Markdown table below this file in the note';
            ins.innerHTML = '<i class="fa-solid fa-table-list" aria-hidden="true"></i> <span>Insert into note</span>';
            ins.addEventListener('click', () => {
                const ws = wb.Sheets[names[cur]];
                const md = rowsToMarkdownTable(currentRows());
                if (!md) { toast(tbl && tbl.sel ? 'Select at least 2 columns to insert as a table.' : 'This sheet has no table to insert (needs 2+ rows and 2+ columns).'); return; }
                insertSheetTableIntoNote(panel.closest('.nv-file-card'), md, !(tbl && tbl.sel) && !!(ws && ws['!fullref']) || (ws && ws['!ref'] && X.utils.decode_range(ws['!ref']).e.c >= SHEET_PREVIEW_COLS), rowCap);
            });
            const btns = names.map((n, i) => {
                const b = document.createElement('button');
                b.type = 'button'; b.className = 'nv-sheet-tab'; b.textContent = n; b.title = n;
                b.setAttribute('role', 'tab');
                b.addEventListener('click', () => show(i));
                tabs.appendChild(b);
                return b;
            });
            const show = (i) => {
                cur = i;
                btns.forEach((b, j) => b.setAttribute('aria-selected', j === i ? 'true' : 'false'));
                body.textContent = '';
                tbl = sheetToTable(X, wb.Sheets[names[i]], updateBar, rowCap, async () => {
                    try { rowCap += 500; wb = await readWb(); show(cur); }
                    catch (err) { rowCap -= 500; toast('Couldn\u2019t load more rows.'); show(cur); }
                });
                body.appendChild(tbl);
                updateBar(null);
            };
            const updateBar = (s) => {
                info.textContent = s ? (s.r2 - s.r1 + 1) + ' \u00d7 ' + (s.c2 - s.c1 + 1) + ' selected \u00b7 Esc to clear' : 'Drag or shift-click to select cells';
                copy.querySelector('span').textContent = s ? 'Copy selection' : 'Copy as Markdown';
                ins.querySelector('span').textContent = s ? 'Insert selection' : 'Insert into note';
            };
            if (names.length > 1) bar.appendChild(tabs);
            bar.append(info, ins, copy);
            panel.append(bar, body);
            show(0);
        } catch (e) {
            panel.textContent = 'Couldn\u2019t preview this file' + (e && e.message ? ' (' + e.message + ')' : '') + '. You can still download it.';
            throw e;
        }
    }

    // Replaces a `[label](attachment://id)` anchor for a spreadsheet with a compact card:
    // icon, filename, type + size, a Download button and the shared "…" menu (Save as / Delete).
    function renderFileCard(anchor, rec, url) {
        const name = (rec.filename || anchor.textContent || 'spreadsheet').replace(/^(\uD83D\uDCC4|\uD83D\uDCCA)\s*/, '');
        const ext = ((/\.([a-z0-9]+)$/i.exec(name) || [])[1] || extFromMime(rec.mime)).toUpperCase();
        const wrap = document.createElement('div');
        wrap.className = 'nv-file-card';
        wrap.dataset.att = rec.id;
        wrap.innerHTML =
            '<i class="fa-solid ' + (/csv$/i.test(ext) ? 'fa-file-csv' : 'fa-file-excel') + ' nv-file-card-ico" aria-hidden="true"></i>'
            + '<div class="nv-file-card-txt"><span class="nv-file-card-name"></span><span class="nv-file-card-meta"></span></div>'
            + '<button type="button" class="nv-file-card-pv" aria-expanded="false"><i class="fa-solid fa-table" aria-hidden="true"></i><span>Preview</span></button>'
            + '<a class="nv-file-card-dl" role="button"><i class="fa-solid fa-download" aria-hidden="true"></i> Download</a>'
            + '<button type="button" class="nv-pdf-embed-more" aria-label="File options" title="File options"><i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i></button>';
        wrap.querySelector('.nv-file-card-name').textContent = name;
        wrap.querySelector('.nv-file-card-name').title = name;
        wrap.querySelector('.nv-file-card-meta').textContent = ext + ' \u00b7 ' + fmtBytes(rec.size);
        const dl = wrap.querySelector('.nv-file-card-dl');
        dl.href = url; dl.download = name;
        const pv = wrap.querySelector('.nv-file-card-pv');
        const panel = document.createElement('div');
        panel.className = 'nv-sheet-prev';
        panel.hidden = true;
        wrap.appendChild(panel);
        pv.addEventListener('click', () => {
            const open = panel.hidden;
            panel.hidden = !open;
            pv.classList.toggle('nv-on', open);
            pv.setAttribute('aria-expanded', open ? 'true' : 'false');
            pv.querySelector('span').textContent = open ? 'Hide' : 'Preview';
            if (open && !panel.dataset.ready) { panel.dataset.ready = '1'; fillSheetPreview(panel, rec).catch(() => { delete panel.dataset.ready; }); }
        });
        wrap.querySelector('.nv-pdf-embed-more').addEventListener('click', (e) => {
            e.preventDefault();
            openAttachMenu(rec, e.currentTarget);
        });
        anchor.replaceWith(wrap);
    }

    /* ── "Open image externally" — a tiny fixed-position popover, not an editor ── */
    let attachMenuEl = null, attachMenuOutsideHandler = null;
    function closeAttachMenu() {
        if (!attachMenuEl) return;
        attachMenuEl.remove();
        attachMenuEl = null;
        if (attachMenuOutsideHandler) {
            document.removeEventListener('pointerdown', attachMenuOutsideHandler, true);
            document.removeEventListener('keydown', attachMenuOutsideHandler, true);
            attachMenuOutsideHandler = null;
        }
    }
    function openAttachMenu(rec, imgEl, opts) {
        opts = opts || {};
        const context = opts.context || 'note';
        closeAttachMenu();
        const menu = document.createElement('div');
        menu.className = 'nv-attach-menu nv-open';
        menu.setAttribute('role', 'menu');
        const dims = rec.width && rec.height ? rec.width + '\u00d7' + rec.height + ' \u00b7 ' : '';
        let usageLine = '';
        if (context === 'manager') {
            const n = opts.noteCount || 0, rv = opts.revCount || 0;
            if (n) usageLine = ' \u00b7 Used in ' + n + (n === 1 ? ' note' : ' notes');
            else if (rv) usageLine = ' \u00b7 In version history only';
            else usageLine = ' \u00b7 Unused';
        }
        const canDelete = context === 'note' || (context === 'manager' && !opts.noteCount && !opts.revCount);
        const isImage = /^image\//.test(rec.mime || '');
        const noun = isImage ? 'image' : 'file';
        const canResize = isImage && context === 'note' && !S.viewRev && !!S.note && imgEl && imgEl.tagName === 'IMG';
        menu.innerHTML =
            '<div class="nv-attach-meta">' + esc((rec.filename ? rec.filename + ' \u00b7 ' : '') + dims + fmtBytes(rec.size) + ' \u00b7 ' + (rec.mime || noun) + usageLine) + '</div>'
            + (canResize ? '<div class="nv-attach-size"><div class="nv-attach-sizelabel"><span>Size</span><b data-size-val></b></div>'
                + '<div class="nv-attach-sizebtns"><button type="button" data-size="240">S</button><button type="button" data-size="480">M</button><button type="button" data-size="720">L</button><button type="button" data-size="0" title="Original / fit width">Full</button></div>'
                + '<input type="range" min="80" max="1200" step="10" data-size-range aria-label="Image width">'
                + '<div class="nv-attach-sizebtns" style="margin:8px 0 0"><button type="button" data-align="left" title="Align left"><i class="fa-solid fa-align-left"></i></button><button type="button" data-align="center" title="Center"><i class="fa-solid fa-align-center"></i></button><button type="button" data-align="right" title="Align right"><i class="fa-solid fa-align-right"></i></button></div></div>' : '')
            + (isSheetMime(rec.mime) ? '' : '<button type="button" class="nv-act" data-act="open"><i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i> Open</button>')
            + (isImage ? '<button type="button" class="nv-act" data-act="zoom"><i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i> View full size</button>' : '')
            + (canResize ? '<button type="button" class="nv-act" data-act="caption"><i class="fa-regular fa-comment-dots" aria-hidden="true"></i> Caption…</button>' : '')
            + (isImage ? '<button type="button" class="nv-act" data-act="copy"><i class="fa-regular fa-copy" aria-hidden="true"></i> Copy</button>' : '')
            + (/pdf/i.test(rec.mime || '') && context === 'note' ? '<button type="button" class="nv-act" data-act="crop"><i class="fa-solid fa-crop" aria-hidden="true"></i> Extract region…</button>' : '')
            + '<button type="button" class="nv-act" data-act="save"><i class="fa-solid fa-download" aria-hidden="true"></i> Save as…</button>'
            + (canDelete ? '<button type="button" class="nv-act nv-danger" data-act="delete"><i class="fa-solid fa-trash" aria-hidden="true"></i> Delete</button>' : '');
        document.body.appendChild(menu);
        const r = imgEl.getBoundingClientRect();
        const top = Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 6);
        const left = Math.min(window.innerWidth - menu.offsetWidth - 8, r.left);
        menu.style.top = Math.max(8, top) + 'px';
        menu.style.left = Math.max(8, left) + 'px';
        if (canResize) {
            const range = menu.querySelector('[data-size-range]'), val = menu.querySelector('[data-size-val]');
            const current = () => Math.round(imgEl.getBoundingClientRect().width) || (rec.width || 480);
            const show = (w) => { val.textContent = w ? w + ' px' : 'Full width'; };
            const startW = imgEl.getAttribute('data-nv-w') ? +imgEl.getAttribute('data-nv-w') : 0;
            range.value = String(Math.min(1200, Math.max(80, startW || current())));
            show(startW);
            const apply = (w, commit) => {
                imgEl.style.width = w ? w + 'px' : '';
                imgEl.style.maxWidth = '100%';
                if (w) imgEl.setAttribute('data-nv-w', String(w)); else imgEl.removeAttribute('data-nv-w');
                show(w);
                if (commit && !setImageWidthInMarkdown(rec, imgEl, w)) flash('Couldn’t resize this image');
            };
            range.addEventListener('input', () => apply(+range.value, false));      // live preview
            range.addEventListener('change', () => apply(+range.value, true));     // save to the note
            const curAlign = imgEl.getAttribute('data-nv-align') || '';
            menu.querySelectorAll('[data-align]').forEach((btn) => {
                if (btn.getAttribute('data-align') === curAlign) btn.classList.add('nv-on');
                btn.addEventListener('click', async () => {
                    const a = btn.getAttribute('data-align');
                    closeAttachMenu();
                    if (!updateImageInMarkdown(rec, imgEl, { align: a === curAlign ? '' : a })) { flash('Couldn’t align this image'); return; }
                    await rerenderKeepScroll();
                });
            });
            menu.querySelectorAll('[data-size]').forEach((btn) => btn.addEventListener('click', () => {
                const w = +btn.getAttribute('data-size');
                if (w) range.value = String(w);
                apply(w, true);
            }));
        }
        menu.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.getAttribute('data-act');
            closeAttachMenu();
            if (act === 'open') {
                const url = URL.createObjectURL(rec.blob);
                window.open(url, '_blank', 'noopener');
                setTimeout(() => URL.revokeObjectURL(url), 60000);
            } else if (act === 'copy') {
                // Puts the image on the clipboard twice: a lossless PNG (for other apps) and the note reference
                // `![](attachment://id)` as text. Pasting into another note here uses the reference — the very same stored
                // image: no re-encode, no quality loss, no duplicate in storage (see onEditorPaste).
                try {
                    if (navigator.clipboard && window.ClipboardItem) {
                        const refBlob = new Blob(['![](attachment://' + rec.id + ')'], { type: 'text/plain' });
                        const pngP = rec.mime === 'image/png' ? Promise.resolve(rec.blob) : attachmentBlobToPng(rec.blob);
                        try {
                            await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngP, 'text/plain': refBlob })]);
                            flash('Image copied — paste it into any note (original quality)');
                        } catch (e1) {
                            await navigator.clipboard.write([new ClipboardItem({ 'text/plain': refBlob })]);
                            flash('Image link copied — paste it into another note');
                        }
                    } else { flash('Copy isn’t supported in this browser'); }
                } catch (err) { flash('Couldn’t copy that image'); }
            } else if (act === 'zoom') {
                const cap = imgEl.getAttribute && imgEl.getAttribute('data-nv-cap');
                openLightbox(rec.blob, cap || '');
            } else if (act === 'caption') {
                const v = window.prompt('Caption under the image (empty = remove)', imgEl.getAttribute('data-nv-cap') || '');
                if (v === null) return;
                if (!updateImageInMarkdown(rec, imgEl, { caption: v.trim() })) { flash('Couldn’t set the caption'); return; }
                await rerenderKeepScroll();
            } else if (act === 'crop') {
                openPdfCrop({ id: rec.id, name: rec.filename || 'document.pdf', blob: rec.blob });
            } else if (act === 'save') {
                const ext = (rec.mime && rec.mime.split('/')[1]) || 'webp';
                const url = URL.createObjectURL(rec.blob);
                const a = document.createElement('a');
                a.href = url; a.download = rec.filename || (rec.id + '.' + ext);
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 2000);
            } else if (act === 'delete' && context === 'manager') {
                if (!confirm('Delete this unused ' + noun + ' permanently? This cannot be undone.')) return;
                await dbDeleteAttachment(rec.id).catch(() => {});
                await dbDeleteAttachmentRefs(rec.id).catch(() => {});
                flash((isImage ? 'Image' : 'File') + ' deleted');
                if (opts.onDeleted) opts.onDeleted();
            } else if (act === 'delete') {
                if (!confirm('Remove this ' + noun + ' from the note? The file stays stored until Storage → Clean up unused attachments is run, in case you undo.')) return;
                if (S.note && S.mode === 'edit') {
                    // Matches both the image syntax (`![alt](attachment://id)`) and the plain-link
                    // syntax used for PDFs/other files (`[label](attachment://id)`).
                    const md = S.note.markdown.replace(new RegExp('!?\\[[^\\]]*\\]\\(attachment://' + rec.id + '(?:\\s+"[^"]*")?\\)'), '');
                    S.note.markdown = md;
                    if (el.src) el.src.value = md;
                    markDirty();
                    renderInto(el.read, md);
                    toast((isImage ? 'Image' : 'File') + ' removed from the note');
                } else {
                    const embed = imgEl.closest('.nv-pdf-embed');
                    if (embed) embed.remove(); else imgEl.remove();
                }
            }
        });
        setTimeout(() => {
            attachMenuOutsideHandler = (e) => {
                if (e.type === 'keydown' && e.key !== 'Escape') return;
                if (e.type === 'pointerdown' && menu.contains(e.target)) return;
                closeAttachMenu();
            };
            document.addEventListener('pointerdown', attachMenuOutsideHandler, true);
            document.addEventListener('keydown', attachMenuOutsideHandler, true);
        }, 0);
    }

    // Syntax-highlight fenced code blocks (```js, ```py, …) with highlight.js, and tag each
    // block with its detected language for the little corner label. No-op if hljs failed to load.
    // Adds the quick-copy icon (top-left) to every code block. The click itself is handled by one
    // delegated listener (see initCodeCopy) so it works in Read mode, previews and compare views alike.
    function addCodeCopyButtons(root) {
        root.querySelectorAll('pre > code').forEach((code) => {
            const pre = code.parentElement;
            if (pre.querySelector(':scope > .nv-code-copy')) return;
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'nv-code-copy'; b.title = 'Copy'; b.setAttribute('aria-label', 'Copy code');
            b.innerHTML = '<i class="fa-regular fa-copy" aria-hidden="true"></i>';
            pre.classList.add('nv-has-copy');
            pre.insertBefore(b, code);
            // language chip (click to change the fence's language in the note)
            const lb = document.createElement('button');
            lb.type = 'button'; lb.className = 'nv-code-lang'; lb.title = 'Change language';
            lb.textContent = pre.getAttribute('data-lang') || 'text';
            pre.insertBefore(lb, code);
            // long blocks: collapsed by default
            const lines = (code.textContent || '').replace(/\n$/, '').split('\n').length;
            if (lines > CODE_COLLAPSE_LINES) {
                pre.classList.add('nv-collapsed');
                pre.setAttribute('data-nv-lines', String(lines));
                const t = document.createElement('button');
                t.type = 'button'; t.className = 'nv-code-toggle'; t.textContent = 'Show all ' + lines + ' lines';
                pre.appendChild(t);
            }
        });
    }
    const CODE_COLLAPSE_LINES = 18;
    const CODE_LANGS = ['markdown', 'text', 'javascript', 'typescript', 'python', 'sql', 'json', 'html', 'css', 'bash', 'java', 'cpp', 'yaml'];
    function closeLangMenu() { const m = document.querySelector('.nv-lang-menu'); if (m) m.remove(); }
    // Rewrites the info string of the Nth code block in the note's markdown. The Nth <pre> of the Read view is matched to
    // the Nth code token of the markdown; if the two lists disagree the change is refused instead of guessing.
    async function setCodeLangInMarkdown(pre, lang) {
        if (!S.note || S.viewRev || !el.read.contains(pre) || !window.marked || !marked.lexer) return false;
        const pres = Array.from(el.read.querySelectorAll('pre > code')).map((c) => c.parentElement);
        const idx = pres.indexOf(pre);
        const tokens = [];
        const walk = (list) => (list || []).forEach((t) => {
            if (t.type === 'code') tokens.push(t);
            else if (t.type === 'list') (t.items || []).forEach((it) => walk(it.tokens));
            else if (t.tokens && t.type !== 'paragraph' && t.type !== 'heading') walk(t.tokens);
        });
        walk(marked.lexer(S.note.markdown));
        if (idx < 0 || tokens.length !== pres.length) return false;
        const t = tokens[idx];
        if (t.codeBlockStyle === 'indented') return false;
        let cursor = 0, at = -1;
        for (let i = 0; i <= idx; i++) {
            const f = S.note.markdown.indexOf(tokens[i].raw, cursor);
            if (f < 0) { if (i === idx) return false; continue; }
            if (i === idx) at = f; else cursor = f + tokens[i].raw.length;
        }
        if (at < 0) return false;
        const m = /^([ \t]*)(`{3,}|~{3,})[^\n]*/.exec(t.raw);
        if (!m) return false;
        const newRaw = m[1] + m[2] + (lang === 'text' ? '' : lang) + t.raw.slice(m[0].length);
        const md = S.note.markdown.slice(0, at) + newRaw + S.note.markdown.slice(at + t.raw.length);
        S.note.markdown = md;
        if (el.src) el.src.value = md;
        markDirty();
        return true;
    }
    function openLangMenu(btn) {
        closeLangMenu();
        const pre = btn.closest('pre');
        const cur = (pre.getAttribute('data-lang') || 'text').toLowerCase();
        const m = document.createElement('div');
        m.className = 'nv-lang-menu';
        const list = CODE_LANGS.includes(cur) ? CODE_LANGS : [cur].concat(CODE_LANGS);
        m.innerHTML = list.map((l) => '<button type="button" data-lang-pick="' + esc(l) + '"' + (l === cur ? ' class="nv-cur"' : '') + '>' + esc(l) + '</button>').join('')
            + '<button type="button" data-lang-pick="__other">Other…</button>';
        document.body.appendChild(m);
        const r = btn.getBoundingClientRect();
        m.style.left = Math.max(8, Math.min(innerWidth - 170, r.right - 150)) + 'px';
        m.style.top = Math.max(8, Math.min(innerHeight - 290, r.bottom + 6)) + 'px';
        m.addEventListener('click', async (e) => {
            const pick = e.target.closest('[data-lang-pick]');
            if (!pick) return;
            let lang = pick.getAttribute('data-lang-pick');
            closeLangMenu();
            if (lang === '__other') {
                lang = (window.prompt('Language (e.g. rust, go, php; empty = none)', cur === 'text' ? '' : cur) || '').trim().toLowerCase();
                if (!/^[a-z0-9_+#.-]{0,30}$/.test(lang)) { flash('Invalid language name'); return; }
                if (!lang) lang = 'text';
            }
            const sc = (function () { let n = el.read; while (n && n !== document.body) { const o = getComputedStyle(n).overflowY; if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n; n = n.parentElement; } return null; })();
            const st = sc ? sc.scrollTop : 0;
            if (!(await setCodeLangInMarkdown(pre, lang))) { flash('Can’t change the language of this block here — edit the fence in Edit mode'); return; }
            await renderInto(el.read, S.note.markdown);
            if (sc) sc.scrollTop = st;
        });
        setTimeout(() => {
            const off = (e) => { if (!e.target.closest('.nv-lang-menu')) { closeLangMenu(); document.removeEventListener('pointerdown', off, true); } };
            document.addEventListener('pointerdown', off, true);
        }, 0);
    }
    function initCodeCopy() {
        if (window.__nvCodeCopyBound) return;
        window.__nvCodeCopyBound = true;
        document.addEventListener('click', async (e) => {
            const tg = e.target.closest('.nv-code-toggle');
            if (tg) {
                e.preventDefault(); e.stopPropagation();
                const pre = tg.closest('pre'), open = pre.classList.toggle('nv-collapsed');
                tg.textContent = open ? 'Show all ' + (pre.getAttribute('data-nv-lines') || '') + ' lines' : 'Show less';
                return;
            }
            const lg = e.target.closest('.nv-code-lang');
            if (lg) { e.preventDefault(); e.stopPropagation(); openLangMenu(lg); return; }
            const b = e.target.closest('.nv-code-copy');
            if (!b) return;
            e.preventDefault(); e.stopPropagation();
            const code = b.parentElement && b.parentElement.querySelector('code');
            const ok = await copyText(code ? code.textContent : '');
            b.classList.toggle('nv-done', ok);
            b.innerHTML = ok ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
            b.title = ok ? 'Copied' : 'Couldn’t copy';
            setTimeout(() => { b.classList.remove('nv-done'); b.innerHTML = '<i class="fa-regular fa-copy" aria-hidden="true"></i>'; b.title = 'Copy'; }, 1500);
        }, true);
    }
    // Obsidian-style sizing: ![alt|300](src) renders the image 300px wide (and the "|300" never shows as alt text).
    // alt text may end with |WIDTH and/or |left|center|right  →  "name|300|center"
    function parseImgAlt(alt) {
        const parts = String(alt || '').split('|').map((x) => x.trim());
        let w = 0, align = '', i = parts.length - 1;
        for (; i >= 1; i--) {
            const t = parts[i].toLowerCase();
            if (/^\d{2,4}(?:x\d{2,4})?$/.test(t)) { if (!w) w = parseInt(t, 10); else break; }
            else if (t === 'left' || t === 'center' || t === 'right') { if (!align) align = t; else break; }
            else break;
        }
        return { base: parts.slice(0, i + 1).join('|'), w, align };
    }
    function buildImgAlt(base, w, align) { return base + (w ? '|' + w : '') + (align ? '|' + align : ''); }
    function applyImageSizes(root) {
        root.querySelectorAll('img').forEach((img) => {
            const p = parseImgAlt(img.getAttribute('alt') || '');
            const isAtt = /^attachment:/.test(img.getAttribute('src') || '');
            const cap = isAtt ? (img.getAttribute('title') || '').trim() : '';
            if (!p.w && !p.align && !cap) return;
            img.setAttribute('alt', p.base);
            if (p.w) {
                img.setAttribute('data-nv-w', String(p.w));
                img.style.width = p.w + 'px'; img.style.maxWidth = '100%'; img.style.height = 'auto';
            }
            if (cap) {
                img.removeAttribute('title');
                img.setAttribute('data-nv-cap', cap);
                const fig = document.createElement('figure'); fig.className = 'nv-fig';
                if (p.align) fig.setAttribute('data-align', p.align);
                if (p.align) img.setAttribute('data-nv-align', p.align);
                const par = img.parentElement;
                const only = par && par.tagName === 'P' && Array.from(par.childNodes).every((n) => n === img || (n.nodeType === 3 && !n.textContent.trim()));
                (only ? par : img).replaceWith(fig);
                const fc = document.createElement('figcaption'); fc.textContent = cap;
                fig.append(img, fc);
            } else if (p.align) {
                img.setAttribute('data-nv-align', p.align);
            }
        });
    }
    // Re-renders the Read view without losing the scroll position (used after align / caption edits).
    async function rerenderKeepScroll() {
        let n = el.read, sc = null;
        while (n && n !== document.body) { const o = getComputedStyle(n).overflowY; if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) { sc = n; break; } n = n.parentElement; }
        const st = sc ? sc.scrollTop : 0;
        await renderInto(el.read, S.note.markdown);
        if (sc) sc.scrollTop = st;
    }
    /* ── Find in note (Read mode) ─ Ctrl/Cmd+F. Accent- and case-insensitive by default (typing "lien lac" finds
       "liên lạc"); matches may span inline formatting (bold/italic/links) but never two paragraphs. Highlights use the
       CSS Custom Highlight API, so the rendered note is never modified. ── */
    const NF = { bar: null, input: null, count: null, matches: [], cur: -1, caseS: false, accS: false, timer: 0, watch: 0, mo: null, open: false };
    function foldChar(ch, caseS, accS) {
        if (/\s/.test(ch)) return ' ';
        let c = ch;
        if (!accS) {
            if (ch === '\u0111') c = 'd'; else if (ch === '\u0110') c = 'D';
            else c = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        }
        return caseS ? c : c.toLowerCase();
    }
    function noteFindCollect(root) {
        const skip = 'button, script, style, .nv-code-copy, .nv-code-lang, .nv-code-toggle, .nv-img-handle';
        const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,figcaption,div,summary,dt,dd';
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [], chars = [], meta = [];
        let prevBlock = null, nd;
        while ((nd = walker.nextNode())) {
            const par = nd.parentElement;
            if (!par || par.closest(skip)) continue;
            if (!nd.data.trim() && /^(UL|OL|TABLE|TBODY|THEAD|TR|DL)$/.test(par.tagName)) continue;
            const blk = par.closest(BLOCK) || root;
            if (prevBlock && blk !== prevBlock) { chars.push('\u0001'); meta.push(null); }
            prevBlock = blk;
            const ni = nodes.push(nd) - 1, data = nd.data;
            for (let i = 0; i < data.length; i++) {
                const f = foldChar(data[i], NF.caseS, NF.accS);
                for (let k = 0; k < f.length; k++) { chars.push(f[k]); meta.push([ni, i]); }
            }
        }
        return { nodes, hay: chars.join(''), meta };
    }
    function noteFindRun(keepCur) {
        const q = NF.input.value;
        NF.matches = []; if (!keepCur) NF.cur = -1;
        if (q && S.note && el.read && el.read.offsetParent) {
            const needle = Array.from(q).map((c) => foldChar(c, NF.caseS, NF.accS)).join('');
            if (needle.trim()) {
                const { nodes, hay, meta } = noteFindCollect(el.read);
                let from = 0, at;
                while (NF.matches.length < 2000 && (at = hay.indexOf(needle, from)) !== -1) {
                    const a = meta[at], z = meta[at + needle.length - 1];
                    from = at + Math.max(1, needle.length);
                    if (!a || !z) continue;
                    const r = document.createRange();
                    try { r.setStart(nodes[a[0]], a[1]); r.setEnd(nodes[z[0]], z[1] + 1); } catch (e) { continue; }
                    NF.matches.push(r);
                }
            }
        }
        if (NF.cur >= NF.matches.length) NF.cur = NF.matches.length - 1;
        if (NF.cur < 0 && NF.matches.length) NF.cur = 0;
        noteFindShow(!keepCur);
    }
    function noteFindPaint() {
        if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
        CSS.highlights.set('nv-find', new Highlight(...NF.matches.filter((_, i) => i !== NF.cur)));
        if (NF.cur >= 0 && NF.matches[NF.cur]) CSS.highlights.set('nv-find-cur', new Highlight(NF.matches[NF.cur])); else CSS.highlights.delete('nv-find-cur');
    }
    function noteFindShow(scroll) {
        const n = NF.matches.length;
        NF.count.textContent = n ? (NF.cur + 1) + '/' + n + (n >= 2000 ? '+' : '') : (NF.input.value ? '0/0' : '');
        NF.count.classList.toggle('nv-none', !n && !!NF.input.value.trim());
        noteFindPaint();
        if (scroll && NF.cur >= 0) noteFindScroll(NF.matches[NF.cur]);
    }
    function noteFindScroll(range) {
        const base = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
        const pre = base && base.closest ? base.closest('pre.nv-collapsed') : null;
        if (pre) { pre.classList.remove('nv-collapsed'); const t = pre.querySelector('.nv-code-toggle'); if (t) t.textContent = 'Show less'; }
        let sc = el.read;
        while (sc && sc !== document.body) { const o = getComputedStyle(sc).overflowY; if ((o === 'auto' || o === 'scroll') && sc.scrollHeight > sc.clientHeight) break; sc = sc.parentElement; }
        const r = range.getBoundingClientRect();
        if (!sc || sc === document.body) { if (base) base.scrollIntoView({ block: 'center' }); return; }
        const cr = sc.getBoundingClientRect();
        if (r.top < cr.top + 70 || r.bottom > cr.bottom - 70) sc.scrollTop += r.top - (cr.top + cr.height / 3);
    }
    function noteFindStep(d) {
        if (!NF.matches.length) return;
        NF.cur = (NF.cur + d + NF.matches.length) % NF.matches.length;
        noteFindShow(true);
    }
    function noteFindClose() {
        if (!NF.bar || !NF.open) return;
        NF.open = false; NF.bar.hidden = true;
        clearInterval(NF.watch); if (NF.mo) NF.mo.disconnect();
        NF.matches = []; NF.cur = -1;
        if (window.CSS && CSS.highlights) { CSS.highlights.delete('nv-find'); CSS.highlights.delete('nv-find-cur'); }
    }
    function noteFindCan() {
        return !!(S.open && S.note && S.mode === 'read' && el.read && el.read.offsetParent && !document.querySelector('.nv-lightbox, .nv-pdfopt-scrim'));
    }
    function openNoteFind() {
        if (!noteFindCan()) { flash('Open a note in Read mode to search inside it'); return; }
        if (!NF.bar) {
            const bar = document.createElement('div');
            bar.className = 'nv-find'; bar.setAttribute('role', 'search'); bar.hidden = true;
            bar.innerHTML = '<input type="text" placeholder="Find in note" aria-label="Find in note" spellcheck="false" autocomplete="off">'
                + '<span class="nv-find-count" aria-live="polite"></span>'
                + '<button type="button" data-f="prev" title="Previous (Shift+Enter)" aria-label="Previous match"><i class="fa-solid fa-chevron-up"></i></button>'
                + '<button type="button" data-f="next" title="Next (Enter)" aria-label="Next match"><i class="fa-solid fa-chevron-down"></i></button>'
                + '<button type="button" data-f="case" title="Match case">Aa</button>'
                + '<button type="button" data-f="acc" title="Match accents (á ≠ a)">á</button>'
                + '<button type="button" data-f="close" title="Close (Esc)" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>';
            document.body.appendChild(bar);
            NF.bar = bar; NF.input = bar.querySelector('input'); NF.count = bar.querySelector('.nv-find-count');
            let t = 0;
            NF.input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => noteFindRun(false), 80); });
            NF.input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); noteFindStep(e.shiftKey ? -1 : 1); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); noteFindClose(); }
                e.stopPropagation();       // keep vault shortcuts from firing while typing
            });
            bar.addEventListener('click', (e) => {
                const b = e.target.closest('[data-f]'); if (!b) return;
                const f = b.getAttribute('data-f');
                if (f === 'next') noteFindStep(1);
                else if (f === 'prev') noteFindStep(-1);
                else if (f === 'close') noteFindClose();
                else if (f === 'case') { NF.caseS = !NF.caseS; b.classList.toggle('nv-on', NF.caseS); noteFindRun(false); }
                else if (f === 'acc') { NF.accS = !NF.accS; b.classList.toggle('nv-on', NF.accS); noteFindRun(false); }
            });
        }
        const sel = window.getSelection ? String(window.getSelection()) : '';
        if (sel && sel.length < 80 && !/\n/.test(sel.trim())) NF.input.value = sel.trim();
        NF.open = true; NF.bar.hidden = false;
        NF.input.focus(); NF.input.select();
        // re-run when the note re-renders; close if the user leaves Read mode / the note
        if (!NF.mo) NF.mo = new MutationObserver(() => { clearTimeout(NF.timer); NF.timer = setTimeout(() => { if (NF.open) noteFindRun(true); }, 150); });
        NF.mo.observe(el.read, { childList: true });
        clearInterval(NF.watch);
        NF.watch = setInterval(() => { if (NF.open && !noteFindCan()) noteFindClose(); }, 400);
        noteFindRun(false);
    }
    function initNoteFind() {
        if (window.__nvFindBound) return;
        window.__nvFindBound = true;
        document.addEventListener('keydown', (e) => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (e.key !== 'f' && e.key !== 'F')) return;
            if (!noteFindCan()) return;              // Edit mode / library view: leave the browser's own find alone
            e.preventDefault(); e.stopPropagation();
            openNoteFind();
        }, true);
    }
    // Zoomable full-screen viewer: click the picture to toggle fit ↔ 100 %, click backdrop / Esc / × to close.
    let lightboxOff = null;
    function closeLightbox() { const lb = document.querySelector('.nv-lightbox'); if (lb) lb.remove(); if (lightboxOff) { lightboxOff(); lightboxOff = null; } }
    function openLightbox(blobOrUrl, caption) {
        closeLightbox(); closeAttachMenu();
        const own = blobOrUrl instanceof Blob ? URL.createObjectURL(blobOrUrl) : null;
        const lb = document.createElement('div');
        lb.className = 'nv-lightbox'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', 'Image viewer');
        lb.innerHTML = '<button class="nv-lb-x" type="button" aria-label="Close" title="Close (Esc)"><i class="fa-solid fa-xmark"></i></button><div class="nv-lb-stage"><img alt=""></div>' + (caption ? '<div class="nv-lb-cap"></div>' : '');
        lb.querySelector('img').src = own || blobOrUrl;
        if (caption) lb.querySelector('.nv-lb-cap').textContent = caption;
        document.body.appendChild(lb);
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLightbox(); } };
        document.addEventListener('keydown', onKey, true);
        lightboxOff = () => { document.removeEventListener('keydown', onKey, true); if (own) URL.revokeObjectURL(own); };
        lb.addEventListener('click', (e) => {
            if (e.target.closest('.nv-lb-x') || e.target === lb || e.target.classList.contains('nv-lb-stage')) { closeLightbox(); return; }
            if (e.target.tagName === 'IMG') lb.classList.toggle('nv-full');
        });
        lb.querySelector('.nv-lb-x').focus();
    }
    function initImageLightbox() {
        if (window.__nvLbBound) return;
        window.__nvLbBound = true;
        el.read.addEventListener('dblclick', (e) => {
            const img = e.target.closest && e.target.closest('img[data-nv-attach]');
            if (!img) return;
            e.preventDefault();
            const rec = S.attachmentCache.get(img.getAttribute('data-nv-attach'));
            openLightbox(rec && rec.blob instanceof Blob ? rec.blob : img.currentSrc || img.src, img.getAttribute('data-nv-cap') || '');
        });
    }
    // Drag-to-resize: a single floating handle follows the hovered attached image (Read mode, live note only).
    // Drag = live width + label; release = written into the markdown as ![alt|WIDTH](attachment://id).
    // Double-click the handle to go back to the original / fit-width size.
    function initImageResize() {
        if (window.__nvImgResizeBound) return;
        window.__nvImgResizeBound = true;
        const hd = document.createElement('div');
        hd.className = 'nv-img-handle'; hd.title = 'Drag to resize · double-click to reset';
        hd.innerHTML = '<i class="fa-solid fa-expand" aria-hidden="true"></i><span class="nv-img-w"></span>';
        document.body.appendChild(hd);
        const label = hd.querySelector('.nv-img-w');
        let cur = null, dragging = false, hideT = 0;
        const eligible = (img) => img && img.tagName === 'IMG' && img.hasAttribute('data-nv-attach') && !!S.note && !S.viewRev && el.read.contains(img);
        const place = () => {
            if (!cur || !cur.isConnected) { hide(true); return; }
            const r = cur.getBoundingClientRect();
            const rr = el.read.getBoundingClientRect();
            if (r.bottom < rr.top + 8 || r.top > rr.bottom - 8 || r.width < 40) { hd.classList.remove('nv-show'); return; }
            hd.style.left = Math.round(Math.min(r.right, rr.right - 4) - 26) + 'px';
            hd.style.top = Math.round(Math.min(r.bottom, rr.bottom - 4) - 26) + 'px';
            hd.classList.add('nv-show');
        };
        const hide = (force) => { if (dragging && !force) return; clearTimeout(hideT); hd.classList.remove('nv-show', 'nv-drag'); cur = null; };
        el.read.addEventListener('pointerover', (e) => {
            const img = e.target.closest && e.target.closest('img[data-nv-attach]');
            if (!eligible(img)) return;
            clearTimeout(hideT); cur = img; place();
        });
        el.read.addEventListener('pointerout', (e) => {
            if (dragging || e.relatedTarget === hd) return;
            const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('img[data-nv-attach]') : null;
            if (to) return;
            hideT = setTimeout(() => { if (!hd.matches(':hover')) hide(); }, 250);
        });
        hd.addEventListener('pointerleave', () => { if (!dragging) hideT = setTimeout(() => { if (!cur || !cur.matches(':hover')) hide(); }, 250); });
        hd.addEventListener('pointerenter', () => clearTimeout(hideT));
        el.read.addEventListener('scroll', place, { passive: true });
        window.addEventListener('resize', place);
        hd.addEventListener('dblclick', () => {
            if (!cur) return;
            cur.style.width = ''; cur.removeAttribute('data-nv-w');
            if (!setImageWidthInMarkdown({ id: cur.getAttribute('data-nv-attach') }, cur, 0)) flash('Couldn’t resize this image');
            place();
        });
        hd.addEventListener('pointerdown', (e) => {
            if (!cur || e.button > 0) return;
            e.preventDefault(); e.stopPropagation();
            dragging = true; hd.classList.add('nv-drag');
            try { hd.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            const img = cur, startX = e.clientX, startW = img.getBoundingClientRect().width;
            let box = img.parentElement; if (box && box.tagName === 'FIGURE') box = box.parentElement;
            const maxW = Math.max(120, Math.floor((box ? box.clientWidth : 1200) || 1200));
            let w = Math.round(startW);
            label.textContent = w + ' px';
            const move = (ev) => {
                w = Math.max(80, Math.min(maxW, Math.round(startW + (ev.clientX - startX))));
                img.style.width = w + 'px'; img.style.maxWidth = '100%'; img.style.height = 'auto';
                img.setAttribute('data-nv-w', String(w));
                label.textContent = w + ' px';
                place();
            };
            const up = () => {
                hd.removeEventListener('pointermove', move);
                hd.removeEventListener('pointerup', up);
                hd.removeEventListener('pointercancel', up);
                dragging = false; hd.classList.remove('nv-drag');
                if (!setImageWidthInMarkdown({ id: img.getAttribute('data-nv-attach') }, img, w)) flash('Couldn’t resize this image');
                place();
            };
            hd.addEventListener('pointermove', move);
            hd.addEventListener('pointerup', up);
            hd.addEventListener('pointercancel', up);
        });
    }
    // Writes the new width into the note's markdown (as ![alt|WIDTH](attachment://id)); width 0 = original size.
    // When the same image appears several times, the clicked one is matched by its position in the page.
    function updateImageInMarkdown(rec, imgEl, ch) {
        if (!S.note || S.viewRev) return false;
        const id = rec.id;
        const imgs = Array.from(el.read.querySelectorAll('img[data-nv-attach="' + id + '"]'));
        let idx = imgs.indexOf(imgEl); if (idx < 0) idx = 0;
        const re = new RegExp('!\\[([^\\]]*)\\]\\(attachment://' + id + '(\\s+"[^"]*")?(?=\\s*\\))', 'g');
        let n = -1, changed = false;
        const md = S.note.markdown.replace(re, (full, alt, title) => {
            n++;
            if (n !== idx) return full;
            changed = true;
            const p = parseImgAlt(alt);
            const w = ch.w !== undefined ? ch.w : p.w, al = ch.align !== undefined ? ch.align : p.align;
            let t = title || '';
            if (ch.caption !== undefined) t = ch.caption ? ' "' + ch.caption.replace(/"/g, '\u201d').replace(/\s*\n+\s*/g, ' ').trim() + '"' : '';
            return '![' + buildImgAlt(p.base, w, al) + '](attachment://' + id + t;
        });
        if (!changed) return false;
        S.note.markdown = md;
        if (el.src) el.src.value = md;
        markDirty();
        return true;
    }
    function setImageWidthInMarkdown(rec, imgEl, width) { return updateImageInMarkdown(rec, imgEl, { w: width }); }

    function highlightCode(root) {
        if (!window.hljs) return;
        root.querySelectorAll('pre > code').forEach((block) => {
            const langClass = (block.className.match(/language-([\w-]+)/) || [])[1];
            const known = langClass && hljs.getLanguage(langClass);
            let res;
            try {
                res = known ? hljs.highlight(block.textContent, { language: langClass }) : hljs.highlightAuto(block.textContent);
            } catch (e) { return; }
            if (!res) return;
            block.innerHTML = res.value;
            block.classList.add('hljs');
            // Explicit ```lang fences always get the label; auto-detected ones only when hljs is confident —
            // avoids slapping a wrong-looking tag on plain text or ambiguous snippets.
            const lang = (known ? langClass : res.language || '').toLowerCase();
            if (lang && (known || (res.relevance || 0) > 0)) {
                block.closest('pre').setAttribute('data-lang', lang);
            }
        });
    }

    // Obsidian-style callouts: a blockquote whose first line is "[!TYPE]" (optionally
    // followed by a custom title on the same line) becomes a labelled, coloured box.
    // Unrecognised types still render as a callout (falls back to the Note look) rather
    // than being left as a plain quote, so a typo in the type name doesn't look broken.
    const CALLOUT_TYPES = {
        note: { icon: 'circle-info', label: 'Note' },
        tip: { icon: 'lightbulb', label: 'Tip' },
        important: { icon: 'circle-exclamation', label: 'Important' },
        warning: { icon: 'triangle-exclamation', label: 'Warning' },
        question: { icon: 'circle-question', label: 'Question' },
        info: 'note', abstract: 'note', summary: 'note', example: 'note', quote: 'note',
        hint: 'tip', success: 'tip', check: 'tip', done: 'tip',
        caution: 'warning', danger: 'warning', bug: 'warning', attention: 'warning',
        help: 'question', faq: 'question'
    };
    function convertCallouts(root) {
        root.querySelectorAll('blockquote').forEach((bq) => {
            const first = bq.firstElementChild;
            if (!first || first.tagName !== 'P') return;
            const m = first.innerHTML.match(/^\s*\[!([A-Za-z][\w-]*)\]\s*([\s\S]*)$/i);
            if (!m) return;
            const key = m[1].toLowerCase();
            let entry = CALLOUT_TYPES[key];
            if (typeof entry === 'string') entry = CALLOUT_TYPES[entry];
            const known = !!entry;
            entry = entry || CALLOUT_TYPES.note;
            const defaultTitle = known ? entry.label : key.charAt(0).toUpperCase() + key.slice(1);

            const br = m[2].match(/^([\s\S]*?)<br\s*\/?>([\s\S]*)$/i);
            const titleHTML = (br ? br[1] : m[2]).trim();
            const restOfFirstP = br ? br[2] : '';

            const box = document.createElement('div');
            box.className = 'nv-callout' + (known ? ' nv-callout-' + key : '');
            const titleEl = document.createElement('div');
            titleEl.className = 'nv-callout-title';
            titleEl.innerHTML = '<i class="fa-solid fa-' + entry.icon + '" aria-hidden="true"></i><span>' + (titleHTML || defaultTitle) + '</span>';
            const bodyEl = document.createElement('div');
            bodyEl.className = 'nv-callout-body';
            if (restOfFirstP.trim()) {
                const p = document.createElement('p');
                p.innerHTML = restOfFirstP;
                bodyEl.appendChild(p);
            }
            let sib = first.nextSibling;
            while (sib) { const next = sib.nextSibling; bodyEl.appendChild(sib); sib = next; }
            box.appendChild(titleEl);
            if (bodyEl.childNodes.length) box.appendChild(bodyEl);
            bq.replaceWith(box);
        });
    }

    /* ═════════════ Document view ═════════════ */
    function fitTitle() {
        const t = el.title;
        t.style.height = 'auto';
        t.style.height = t.scrollHeight + 'px';
    }

    // Does n.linkedSkill still exist under n.linkedCareer in the current skillsData? A skill
    // can get renamed/removed from the tracker after a note already links to it, so the chip
    // needs to degrade gracefully instead of pointing at nothing.
    function nvLinkedSkillLive(n) {
        return !!EntityLinks.resolve(n, 'skill');
    }
    function renderSkillLinkPill(n) {
        const skillName = EntityLinks.getId(n, 'skill');
        if (!n.linkedCareer || !skillName) return '';
        const live = nvLinkedSkillLive(n);
        const careerTitle = (typeof skillsData !== 'undefined' && skillsData[n.linkedCareer]) ? skillsData[n.linkedCareer].title : n.linkedCareer;
        if (!live) {
            return `<span class="nv-folder-pill nv-skill-pill-dead" title="“${esc(skillName)}” no longer exists in the Tracker"><i class="fa-solid fa-link-slash"></i>${esc(skillName)}</span>`;
        }
        return `<button type="button" class="nv-folder-pill nv-skill-pill" title="Open “${esc(skillName)}” in Tracker — ${esc(careerTitle)}" onclick="window.jumpFromNoteToSkill('${esc(n.linkedCareer)}', '${esc(skillName).replace(/'/g, "&#39;")}')"><i class="fa-solid fa-bullseye"></i>${esc(skillName)}</button>`;
    }
    // Does n.linkedCourseId still exist in the Courses tracker? A course can be deleted
    // after a note already links to it, so the chip needs to degrade gracefully instead
    // of pointing at nothing — same idea as nvLinkedSkillLive above.
    function nvLinkedCourseLive(n) {
        return EntityLinks.resolve(n, 'course');
    }
    function renderCourseLinkPill(n) {
        if (!EntityLinks.getId(n, 'course')) return '';
        const course = nvLinkedCourseLive(n);
        if (!course) {
            return `<span class="nv-folder-pill nv-skill-pill-dead" title="This course no longer exists in the Courses tracker"><i class="fa-solid fa-link-slash"></i>${esc(n.course || 'Course')}</span>`;
        }
        return `<button type="button" class="nv-folder-pill nv-skill-pill" title="Open “${esc(course.title)}” in Courses" onclick="window.jumpFromNoteToCourse('${esc(course.id)}')"><i class="fa-solid fa-book"></i>${esc(course.title)}</button>`;
    }
    // Best-effort resolver for the free-text Course field against the live Courses tracker —
    // same philosophy as findSkillMatch: only auto-link on an exact, unambiguous title match
    // (case-insensitive), otherwise leave it as a plain text label rather than guessing.
    function resolveCourseLink(text) {
        if (typeof courses === 'undefined') return null;
        const target = String(text || '').trim().toLowerCase();
        if (!target) return null;
        const hit = courses.find((c) => String(c.title || '').trim().toLowerCase() === target);
        return hit || null;
    }
    // Resource-side counterpart of nvLinkedCourseLive — degrades gracefully to a dead-link
    // pill if the resource was deleted from the Resource Library after a note linked to it.
    function nvLinkedResourceLive(n) {
        return EntityLinks.resolve(n, 'resource');
    }
    function renderResourceLinkPill(n) {
        if (!EntityLinks.getId(n, 'resource')) return '';
        const resource = nvLinkedResourceLive(n);
        if (!resource) {
            return `<span class="nv-folder-pill nv-skill-pill-dead" title="This resource no longer exists in the Resource Library"><i class="fa-solid fa-link-slash"></i>${esc(n.resource || 'Resource')}</span>`;
        }
        return `<button type="button" class="nv-folder-pill nv-skill-pill" title="Open “${esc(resource.title)}” in the Resource Library" onclick="window.jumpFromNoteToResource('${esc(resource.id)}')"><i class="fa-solid fa-book-open"></i>${esc(resource.title)}</button>`;
    }
    // Best-effort resolver for the free-text Resource field against the live Resource
    // Library — same philosophy as resolveCourseLink: only auto-link on an exact,
    // unambiguous title match (case-insensitive), otherwise leave it as plain text.
    function resolveResourceLink(text) {
        if (typeof resourceLibrary === 'undefined') return null;
        const target = String(text || '').trim().toLowerCase();
        if (!target) return null;
        const hit = resourceLibrary.find((r) => String(r.title || '').trim().toLowerCase() === target);
        return hit || null;
    }
    // Analysis-side counterpart of nvLinkedResourceLive — degrades gracefully to a
    // dead-link pill if the analysis was deleted from the Investment Analysis tracker
    // after a note linked to it.
    function nvLinkedAnalysisLive(n) {
        return EntityLinks.resolve(n, 'analysis');
    }
    function renderAnalysisLinkPill(n) {
        if (!EntityLinks.getId(n, 'analysis')) return '';
        const analysis = nvLinkedAnalysisLive(n);
        if (!analysis) {
            return `<span class="nv-folder-pill nv-skill-pill-dead" title="This analysis no longer exists in Investment Analysis"><i class="fa-solid fa-link-slash"></i>${esc(n.analysis || 'Analysis')}</span>`;
        }
        return `<button type="button" class="nv-folder-pill nv-skill-pill" title="Open “${esc(analysis.title)}” in Investment Analysis" onclick="window.jumpFromNoteToAnalysis('${esc(analysis.id)}')"><i class="fa-solid fa-chart-line"></i>${esc(analysis.title)}</button>`;
    }
    // Best-effort resolver for the free-text Analysis field against the live Investment
    // Analysis tracker — same philosophy as resolveResourceLink: only auto-link on an
    // exact, unambiguous title match (case-insensitive), otherwise leave it as plain text.
    function resolveAnalysisLink(text) {
        if (typeof investmentAnalyses === 'undefined') return null;
        const target = String(text || '').trim().toLowerCase();
        if (!target) return null;
        const hit = investmentAnalyses.find((a) => String(a.title || '').trim().toLowerCase() === target);
        return hit || null;
    }
    // Deal-side counterpart of nvLinkedAnalysisLive — degrades gracefully to a
    // dead-link pill if the deal was deleted from the Deal Diary after a note
    // linked to it.
    function nvLinkedDealLive(n) {
        return EntityLinks.resolve(n, 'deal');
    }
    function renderDealLinkPill(n) {
        if (!EntityLinks.getId(n, 'deal')) return '';
        const deal = nvLinkedDealLive(n);
        if (!deal) {
            return `<span class="nv-folder-pill nv-skill-pill-dead" title="This deal no longer exists in Deal Diary"><i class="fa-solid fa-link-slash"></i>${esc(n.deal || 'Deal')}</span>`;
        }
        return `<button type="button" class="nv-folder-pill nv-skill-pill" title="Open “${esc(deal.dealName)}” in Deal Diary" onclick="window.jumpFromNoteToDeal('${esc(deal.id)}')"><i class="fa-solid fa-handshake"></i>${esc(deal.dealName)}</button>`;
    }
    // Best-effort resolver for the free-text Deal field against the live Deal
    // Diary — same philosophy as resolveAnalysisLink: only auto-link on an exact,
    // unambiguous name match (case-insensitive), otherwise leave it as plain text.
    function resolveDealLink(text) {
        if (typeof dealDiary === 'undefined') return null;
        const target = String(text || '').trim().toLowerCase();
        if (!target) return null;
        const hit = dealDiary.find((d) => String(d.dealName || '').trim().toLowerCase() === target);
        return hit || null;
    }
    // Notes Vault → Daily Planner: keeps a note's Deadline mirrored as a reminder item in
    // DLT (window.DLT.syncNoteDeadline upserts/removes by note id — see that function for
    // the other half). Called after every successful save, so title/skill-name edits and
    // clearing the date all stay in sync without a dedicated listener per field. A no-op
    // if the planner script hasn't loaded yet or the note has never had a deadline.
    function nvSyncPlannerDeadline(n) {
        try { remIndexNote(n); } catch (e) { /* reminders are optional */ }
        if (!n || typeof window.DLT === 'undefined' || typeof window.DLT.syncNoteDeadline !== 'function') return;
        const careerTitle = (n.linkedCareer && typeof skillsData !== 'undefined' && skillsData[n.linkedCareer])
            ? skillsData[n.linkedCareer].title : '';
        window.DLT.syncNoteDeadline({
            noteId: n.id,
            title: (n.title || '').trim(),
            date: n.deletedAt ? '' : (n.deadline || ''),   // in Trash (or no deadline) → remove the reminder
            skillName: n.linkedSkill || '',
            careerTitle
        });
    }

    function renderDocMeta() {
        const n = S.note;
        if (!n) return;
        const link = S.fileLinks.get(n.id);
        const pendingRelink = !link ? S.pendingRelinks.get(n.id) : null;
        el.docMeta.innerHTML =
            folderPillHtml(n.type)
            + n.tags.map((t) => `<span>#${esc(t)}</span>`).join('')
            + (link ? `<span class="nv-folder-pill" title="Linked — “Save changes to file” writes here"><i class="fa-solid fa-link"></i>${esc(link.name)}</span>` : '')
            + (pendingRelink ? `<span class="nv-relink-pill" title="Restored from a backup — the file handle itself can't be backed up, so this note needs to be pointed at the file again"><i class="fa-solid fa-triangle-exclamation"></i> Needs relinking${pendingRelink.name ? ': ' + esc(pendingRelink.name) : ''}</span>` : '')
            + renderSkillLinkPill(n)
            + (EntityLinks.getId(n, 'course') ? renderCourseLinkPill(n) : (n.course ? `<span title="Course"><i class="fa-solid fa-book" aria-hidden="true"></i> ${esc(n.course)}</span>` : ''))
            + (EntityLinks.getId(n, 'resource') ? renderResourceLinkPill(n) : (n.resource ? `<span title="Resource"><i class="fa-solid fa-book-open" aria-hidden="true"></i> ${esc(n.resource)}</span>` : ''))
            + (EntityLinks.getId(n, 'analysis') ? renderAnalysisLinkPill(n) : (n.analysis ? `<span title="Analysis"><i class="fa-solid fa-chart-line" aria-hidden="true"></i> ${esc(n.analysis)}</span>` : ''))
            + (EntityLinks.getId(n, 'deal') ? renderDealLinkPill(n) : (n.deal ? `<span title="Deal"><i class="fa-solid fa-handshake" aria-hidden="true"></i> ${esc(n.deal)}</span>` : ''))
            + (n.deadline ? `<span title="Deadline"><i class="fa-solid fa-calendar" aria-hidden="true"></i> ${esc(nvFmtDate(n.deadline))}</span>` : '')
            + (n.remindAt ? `<span title="Reminder"><i class="fa-solid fa-bell" aria-hidden="true"></i> ${esc(remShort(n.remindAt))}</span>` : '')
            + '<span class="nv-grow"></span>'
            + `<span title="${esc(fmtFull(n.updatedAt))}">${S.persisted ? 'Edited ' + esc(fmtRel(n.updatedAt)) : 'Not saved yet'}</span>`;
    }

    function renderTagChips() {
        el.tagBox.querySelectorAll('.nv-t').forEach((x) => x.remove());
        const frag = document.createDocumentFragment();
        S.note.tags.forEach((t, i) => {
            const chip = document.createElement('span');
            chip.className = 'nv-t';
            chip.appendChild(document.createTextNode('#' + t));
            const b = document.createElement('button');
            b.type = 'button'; b.dataset.rm = String(i);
            b.setAttribute('aria-label', 'Remove tag ' + t);
            b.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            chip.appendChild(b);
            frag.appendChild(chip);
        });
        el.tagBox.insertBefore(frag, el.tagIn);
    }

    function renderDatalists() {
        const folders = new Map(), tags = new Map();
        S.notes.forEach((n) => {
            folders.set(typeKey(n.type), normType(n.type));
            n.tags.forEach((t) => tags.set(t.toLowerCase(), t));
        });
        // Feeds the themed .nv-combo suggestion popups (Folder / Tags / filter Tag) —
        // see attachCombo(). Kept as plain arrays rather than a native <datalist> so the
        // dropdown can be styled to match the app instead of showing bare browser chrome.
        S.folderOpts = [...folders.values()].sort();
        S.tagOpts = [...tags.values()].sort();
        // Suggests real Courses-tracker titles as the person types in the Course field —
        // picking one exactly is what makes resolveCourseLink() auto-link it (see the
        // nvCourse input listener). typeof-guarded since `courses` lives in a later script.
        S.courseOpts = (typeof courses !== 'undefined') ? courses.map((c) => c.title) : [];
        // Same idea for the Resource field, sourced from the Resource Library.
        S.resourceOpts = (typeof resourceLibrary !== 'undefined') ? resourceLibrary.map((r) => r.title) : [];
        // Same idea for the Analysis field, sourced from Investment Analysis.
        S.analysisOpts = (typeof investmentAnalyses !== 'undefined') ? investmentAnalyses.map((a) => a.title) : [];
        // Same idea for the Deal field, sourced from Deal Diary.
        S.dealOpts = (typeof dealDiary !== 'undefined') ? dealDiary.map((d) => d.dealName) : [];
    }

    function actionList() {
        const n = S.note;
        const linked = FS_SUPPORTED ? S.fileLinks.get(n.id) : null;
        const pendingRelink = !linked ? S.pendingRelinks.get(n.id) : null;
        const list = [
            { id: 'pin', icon: 'star', label: n.pinned ? 'Unpin note' : 'Pin note' },
            { id: 'dup', icon: 'copy', label: 'Duplicate' },
            { id: 'copy', icon: 'clipboard', label: 'Copy Markdown' }
        ];
        if (linked) {
            list.push({ id: 'savefsupdate', icon: 'floppy-disk', label: 'Save changes to file' });
            list.push({ id: 'savefs', icon: 'file-export', label: 'Save As .md…' });
            list.push({ id: 'unlinkfs', icon: 'link-slash', label: 'Unlink from file' });
        } else {
            // Same action either way (picking a file creates a fresh, real link) — only the
            // label changes, so a restored note's "needs relinking" hint has an obvious next step.
            // Without the File System Access API, "Save .md (download)" is just a plain download, i.e. exactly
            // what "Export .md" does, so it is not listed twice. (With it, "Save .md to disk…" links the note to a file.)
            if (FS_SUPPORTED || pendingRelink) list.push({ id: 'savefs', icon: pendingRelink ? 'triangle-exclamation' : 'floppy-disk', label: pendingRelink ? 'Relink to file…' : 'Save .md to disk…' });
        }
        list.push(
            { id: 'md', icon: 'file-arrow-down', label: 'Export .md' },
            { id: 'txt', icon: 'file-lines', label: 'Export .txt' },
            { id: 'pdf', icon: 'file-pdf', label: 'Export .pdf' },
            { id: 'hist', icon: 'clock-rotate-left', label: 'Version history' },
            { id: 'del', icon: 'trash', label: 'Move to Trash', danger: true }
        );
        return list;
    }
    function renderActions() {
        if (!S.note) return;
        const html = actionList().map((a) =>
            `<button type="button" class="nv-act${a.danger ? ' nv-danger' : ''}" role="menuitem" data-action="${a.id}"><i class="fa-solid fa-${a.icon}"></i>${esc(a.label)}</button>`).join('');
        el.actions.innerHTML = html;
        el.docMenu.innerHTML = html;
    }


    /* ───────── Tracker link: Career/Skill dropdowns (Info panel) ─────────
       `skillsData` is a top-level `const` declared in a later, separate <script> tag on
       this page. Classic (non-module) scripts share one global lexical scope, so by the
       time these run (on user interaction, well after the whole page has parsed) it's
       already defined — same assumption the Resource↔Skill linker elsewhere relies on. */
    function nvPopulateCareerOptions() {
        if (!el.linkedCareer) return;
        const current = el.linkedCareer.value;
        if (typeof skillsData === 'undefined') {
            el.linkedCareer.innerHTML = '<option value="">No career selected</option>';
            return;
        }
        el.linkedCareer.innerHTML = '<option value="">No career selected</option>' +
            Object.keys(skillsData).map((key) =>
                `<option value="${esc(key)}">${esc(skillsData[key].title || key)}</option>`
            ).join('');
        el.linkedCareer.value = current;
    }
    function nvPopulateSkillOptions() {
        if (!el.linkedCareer || !el.linkedSkill) return;
        const career = el.linkedCareer.value;
        if (!career || typeof skillsData === 'undefined' || !skillsData[career]) {
            el.linkedSkill.innerHTML = '<option value="">No skill selected</option>';
            el.linkedSkill.disabled = true;
            return;
        }
        el.linkedSkill.disabled = false;
        const categories = skillsData[career].categories || {};
        let html = '<option value="">No skill selected</option>';
        Object.entries(categories).forEach(([catName, cat]) => {
            html += `<optgroup label="${esc(catName)}">`;
            (cat.skills || []).forEach((sk) => { html += `<option value="${esc(sk.name)}">${esc(sk.name)}</option>`; });
            html += '</optgroup>';
        });
        el.linkedSkill.innerHTML = html;
    }

    // "Tracker links" group is collapsed by default — its header shows how many of the links are filled in.
    function nvUpdateLinkCount() {
        const out = document.getElementById('nvTrackerCount');
        if (!out) return;
        let n = 0;
        [el.linkedSkill, el.course, el.resource, el.analysis, el.deal].forEach((f) => { if (f && String(f.value || '').trim()) n++; });
        out.textContent = n ? n + ' linked' : 'None';
        out.classList.toggle('nv-has', n > 0);
    }

    function fillDoc() {
        const n = S.note;
        S.viewRev = null; el.revBar.hidden = true; el.title.readOnly = false;   // never carry a version preview over to another note
        el.title.value = n.title;
        el.src.value = n.markdown;
        el.folderIn.value = normType(n.type);
        el.tagIn.value = '';
        nvPopulateCareerOptions();
        if (el.linkedCareer) el.linkedCareer.value = n.linkedCareer || '';
        nvPopulateSkillOptions();
        if (el.linkedSkill) el.linkedSkill.value = n.linkedSkill || '';
        if (el.course) el.course.value = n.course || '';
        if (el.resource) el.resource.value = n.resource || '';
        if (el.analysis) el.analysis.value = n.analysis || '';
        if (el.deal) el.deal.value = n.deal || '';
        if (el.deadline) el.deadline.value = n.deadline || '';
        fillRemind();
        renderTagChips();
        renderDocMeta();
        renderActions();
        renderDatalists();
        el.created.textContent = fmtFull(n.createdAt);
        el.updated.textContent = S.persisted ? fmtFull(n.updatedAt) : 'Not saved yet';
        refreshStats();
        renderHistory();
        renderLinksPane();
        renderMentions();
        renderContextPane();
        renderMapRel();
        nvUpdateLinkCount();
    }

    // 12345 → "12.3k" (keeps the status bar short; exact counts stay in the Info tab)
    function nvShortCount(n) {
        return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
    }
    function refreshStats() {
        const n = S.note;
        if (!n) return;
        const md = n.markdown;
        const words = (md.match(/\S+/g) || []).length;
        el.words.textContent = words.toLocaleString();
        el.chars.textContent = md.length.toLocaleString();
        const readMin = words ? Math.max(1, Math.round(words / 220)) : 0;
        el.readTime.textContent = words ? '~' + readMin + ' min' : '—';
        rpWords = words;
        rpStatBase = nvShortCount(words) + ' words' + (words ? ' · ~' + readMin + ' min read' : '');
        el.statRight.textContent = rpStatBase;
        if (S.mode === 'read') rpShowStatus(rpCurrentPct());   // keep the "% read" part in sync after an edit/rename
    }

    /* Reading progress bar — only meaningful in Read mode, and only when the note
       actually needs scrolling. Recomputed synchronously whenever the doc's layout
       could have changed (mode switch, revision preview, font size / width, resize);
       on scroll itself it's throttled to one update per animation frame so fast
       scrolling doesn't spam layout work. */
    function updateProgress() {
        if (!el.progress) return;
        if (!S.note || S.mode !== 'read') { el.progress.classList.remove('nv-progress-on'); rpShowStatus(null); return; }
        const sc = el.docScroll;
        const max = sc.scrollHeight - sc.clientHeight;
        if (max <= 24) {                       // note fits on screen — nothing to track
            el.progress.classList.remove('nv-progress-on');
            el.progressFill.style.width = '0%';
            rpShowStatus(null);
            return;
        }
        el.progress.classList.add('nv-progress-on');
        const pct = Math.min(100, Math.max(0, (sc.scrollTop / max) * 100));
        el.progressFill.style.width = pct.toFixed(1) + '%';
        rpShowStatus(pct);
        if (!rpGuard && !S.viewRev) rpQueue(S.note.id, pct / 100);
    }

    /* Reading position memory — remembers how far down each note you read (as a fraction of
       its scrollable height) so reopening a long note in Read mode drops you back where you
       stopped. Stored in localStorage as { noteId: [fraction, timestamp] }, newest 400 kept.
       `var` (not let) so settle()/refreshStats() can safely touch these at any point. */
    var RP_KEY = 'nvReadPos';
    var rpGuard = false;      // true while a note is being opened/restored, so the reset-to-top doesn't overwrite the saved spot
    var rpTimer = null, rpLive = null, rpSkipOnce = false;   // rpSkipOnce: next openNote starts at the top (Previous/Next buttons)
    var rpStatBase = '', rpWords = 0;
    function rpLoad() {
        try { const o = JSON.parse(localStorage.getItem(RP_KEY) || '{}'); return (o && typeof o === 'object') ? o : {}; }
        catch (e) { return {}; }
    }
    function rpWrite(map) {
        try {
            const ids = Object.keys(map);
            if (ids.length > 400) ids.sort((a, b) => (map[a][1] || 0) - (map[b][1] || 0)).slice(0, ids.length - 400).forEach((k) => { delete map[k]; });
            localStorage.setItem(RP_KEY, JSON.stringify(map));
        } catch (e) { /* private mode or quota — position memory is a nice-to-have */ }
    }
    function rpGet(id) {
        const r = rpLoad()[id];
        return (Array.isArray(r) && typeof r[0] === 'number') ? { p: r[0], t: r[1] || 0 } : null;
    }
    function rpSet(id, p) {
        const map = rpLoad();
        if (p < 0.03) delete map[id];                       // basically at the top: nothing worth remembering
        else map[id] = [Math.min(1, +p.toFixed(4)), Date.now()];
        rpWrite(map);
    }
    function rpQueue(id, p) {                               // debounced: scrolling fires this constantly
        rpLive = { id: id, p: p };
        clearTimeout(rpTimer);
        rpTimer = setTimeout(flushReadPos, 600);
    }
    function flushReadPos() {
        clearTimeout(rpTimer); rpTimer = null;
        if (!rpLive) return;
        const live = rpLive; rpLive = null;
        rpSet(live.id, live.p);
    }
    function rpCurrentPct() {
        if (!S.note || S.mode !== 'read') return null;
        const sc = el.docScroll, max = sc.scrollHeight - sc.clientHeight;
        return max > 24 ? Math.min(100, Math.max(0, (sc.scrollTop / max) * 100)) : null;
    }
    // Appends "· 42% read · ~3 min left" to the status bar (Read mode, scrollable notes only).
    function rpShowStatus(pct) {
        if (!el.statRight || !S.note || !rpStatBase) return;
        if (pct === null || pct === undefined) { el.statRight.textContent = rpStatBase; return; }
        const left = Math.ceil(rpWords * (1 - pct / 100) / 220);
        el.statRight.textContent = rpStatBase + ' · ' + Math.round(pct) + '%'
            + (pct >= 99 ? ' · finished' : (pct >= 1 && left > 0 ? ' · ~' + left + ' min left' : ''));
    }
    // Called right after a note is opened. Jumps back to the saved spot unless the note was
    // basically unread (<3%) or already finished (>97%) — those just start from the top.
    function restoreReadPos(n) {
        const release = () => setTimeout(() => { rpGuard = false; }, 250);
        const rec = (S.mode === 'read' && !rpSkipOnce) ? rpGet(n.id) : null;
        if (!rec || rec.p < 0.03 || rec.p > 0.97) { release(); return; }
        requestAnimationFrame(() => {
            const sc = el.docScroll, max = sc.scrollHeight - sc.clientHeight;
            if (S.note && S.note.id === n.id && S.mode === 'read' && max > 24) {
                sc.scrollTop = Math.round(rec.p * max);
                updateProgress();
                toast('Resumed where you left off (' + Math.round(rec.p * 100) + '%).', 'Start over', () => { sc.scrollTop = 0; });
            }
            release();
        });
    }
    let S_progressRAF = null;
    function scheduleProgress() {
        if (S_progressRAF) return;
        S_progressRAF = requestAnimationFrame(() => { S_progressRAF = null; updateProgress(); });
    }

    function scheduleDerived() {
        clearTimeout(S.derivedTimer);
        S.derivedTimer = setTimeout(() => {
            if (!S.note) return;
            refreshStats();
            if (S.mode === 'edit') renderOutline();
            renderLinksPane();
            renderMentions();
            renderContextPane();
        }, 250);
    }

    function showLibrary() {
        if (S.focus) { S.focus = false; applyFocus(); }
        el.docView.hidden = true;
        el.lib.hidden = false;
        ppRelease();
        applyLayout();
        setSave('idle');
        updateStatusRight();
    }
    function showDoc() {
        el.lib.hidden = true;
        el.docView.hidden = false;
        applyLayout();
    }

    function setMode(m, focus) {
        if (S.viewRev) exitRevView();
        if (m === 'split' && S.focus) m = 'live';   // in Focus mode the split button means "PDF beside the note" — see ppToggle
        const split = m === 'split', live = m === 'live';
        if (split || live) m = 'edit';
        const pos = spCapture();          // where in the text the person is, so the other view opens at the same spot
        tblSess = null;
        S.mode = m;
        S.split = split;
        S.live = live;
        const edit = m === 'edit';
        el.app.classList.toggle('nv-reading', !edit);
        el.modeRead.setAttribute('aria-pressed', String(!edit));
        el.modeEdit.setAttribute('aria-pressed', String(edit && !split && !live));
        el.modeSplit.setAttribute('aria-pressed', String(S.focus ? pp.on : split));
        el.modeSource.setAttribute('aria-pressed', String(edit && !split && !live));
        const tg = $('nvModeToggle');
        if (tg) {
            const ic = tg.querySelector('i');
            if (ic) ic.className = 'fa-solid ' + (edit ? 'fa-book-open' : 'fa-pen');
            tg.title = edit ? 'Switch to reading view (Ctrl+E)' : 'Switch to editing view (Ctrl+E)';
            tg.setAttribute('aria-pressed', String(edit && live));
        }
        el.docScroll.classList.toggle('nv-editing', edit);
        el.docScroll.classList.toggle('nv-split', split);
        el.docScroll.classList.toggle('nv-live-on', live);
        el.read.hidden = edit && !split;
        el.src.hidden = !edit || live;
        el.live.hidden = !(edit && live);
        if (edit && live) liveLoad();
        el.tools.hidden = !edit;
        if (!edit || split) renderInto(el.read, S.note.markdown);
        if (!edit) closeWlPopup();
        fitTitle();
        renderOutline();
        renderLinksPane();
        renderMentions();
        renderContextPane();
        if (edit) refreshToolbar();
        if (edit && focus) el.src.focus({ preventScroll: true });
        spRestore(pos, edit);
        updateProgress();
        seqUpdateNav();
        ppApply();
    }

    /* ═════════════ Tab strip: several notes held open at once, browser-tab style ═════════════
       S.tabs is just a list of note ids — never anything heavier — so a stale id (the note got
       deleted or purged elsewhere) is harmless and gets swept out the next time the strip
       renders. Nothing here duplicates a note's data; the strip always reads titles live off
       S.note / S.notes. */
    const TABS_KEY = 'nvTabs';
    function saveTabsToStorage() {
        try { localStorage.setItem(TABS_KEY, JSON.stringify(S.tabs)); } catch (e) { /* private mode, quota, etc. — fine, session-only */ }
    }
    function loadTabsFromStorage() {
        try { return JSON.parse(localStorage.getItem(TABS_KEY) || '[]').filter((x) => typeof x === 'string'); }
        catch (e) { return []; }
    }
    function tabLabel(n) { return (n && n.title && n.title.trim()) || 'Untitled note'; }
    function addTab(id) {
        if (!S.tabs.includes(id)) S.tabs.push(id);
        S.activeTab = id;
        renderTabStrip();
    }
    // A brand-new, never-typed-in note isn't worth a permanent tab — same "nothing to keep"
    // rule flushSave() already applies to whether it gets saved at all.
    function pruneCurrentTabIfBlank() {
        const n = S.note;
        if (!n || S.persisted || n.title.trim() || n.markdown.trim() || (n.tags && n.tags.length)) return;
        S.tabs = S.tabs.filter((x) => x !== n.id);
    }
    // A saved note that has been emptied out (title, text and tags all gone — e.g. someone typed,
    // then cleared it, or an import left it behind) is just clutter once you move away from it.
    // Called when leaving a note. Truly empty with no history → deleted. Empty but with saved
    // versions (the old text lives in History) → moved to Trash quietly so nothing is lost.
    // Pinned or linked notes are never touched.
    async function discardCurrentIfBlank() {
        const n = S.note;
        if (!n || !S.persisted) return false;
        if (String(n.title || '').trim() || String(n.markdown || '').trim()) return false;
        if ((n.tags && n.tags.length) || (n.links && n.links.length) || n.pinned) return false;
        try {
            const hasHistory = (await revList(n.id, 1)).length > 0;
            if (hasHistory) {
                n.deletedAt = Date.now();
                await dbPut(n);
                nvSyncPlannerDeadline(n);
                S.notes = S.notes.filter((x) => x.id !== n.id);
                S.trash.push(n);
            } else {
                await dbDelete(n.id);
                try { await revDeleteForNote(n.id); } catch (e) { /* history is best-effort */ }
                S.notes = S.notes.filter((x) => x.id !== n.id);
                foldCache.delete(n.id);
            }
        } catch (e) { console.warn('Notes Vault: could not discard empty note', e); return false; }
        S.tabs = S.tabs.filter((x) => x !== n.id);
        try { renderSide(); renderLibrary(); } catch (e) { /* counts refresh on next render */ }
        return true;
    }
    function renderTabStrip() {
        if (!el.tabStrip) return;
        S.tabs = S.tabs.filter((id) => (S.note && S.note.id === id) || S.notes.some((x) => x.id === id));
        if (S.activeTab && !S.tabs.includes(S.activeTab)) S.activeTab = null;
        saveTabsToStorage();
        if (!S.tabs.length) { el.tabStrip.hidden = true; el.tabStrip.innerHTML = ''; return; }
        el.tabStrip.hidden = false;
        el.tabStrip.innerHTML = S.tabs.map((id) => {
            const n = (S.note && S.note.id === id) ? S.note : S.notes.find((x) => x.id === id);
            const label = tabLabel(n);
            return `<button type="button" class="nv-tabitem" role="tab" data-tab-id="${esc(id)}" aria-selected="${S.activeTab === id}" title="${esc(label)}">
                <span class="nv-tabitem-title">${esc(label)}</span>
                <span class="nv-tabitem-close" data-close-tab="${esc(id)}" title="Close tab" aria-label="Close ${esc(label)} tab"><i class="fa-solid fa-xmark" aria-hidden="true"></i></span>
            </button>`;
        }).join('');
    }
    // Closes one tab. If it was the active one, falls back to whichever tab was opened most
    // recently — same "closed tab → nearest sibling" feel as a browser.
    async function closeTab(id) {
        const wasActive = !!(S.note && S.note.id === id);
        if (wasActive) { await settle(); await discardCurrentIfBlank(); }
        S.tabs = S.tabs.filter((x) => x !== id);
        renderTabStrip();
        if (!wasActive) return;
        S.note = null; S.dirty = false; S.activeTab = null;
        const next = S.tabs[S.tabs.length - 1];
        if (next) { await openNote(next); return; }
        showLibrary();
        renderAll();
    }

    async function openNote(id) {
        if (S.note && S.note.id === id) { addTab(id); showDoc(); closeDrawers(); return; }  // already the active tab
        await settle();
        pruneCurrentTabIfBlank();
        if (await discardCurrentIfBlank()) { S.note = null; S.dirty = false; }
        const n = S.notes.find((x) => x.id === id);
        if (!n) { renderTabStrip(); return; }
        S.note = n; S.persisted = true; S.dirty = false;
        S.edited = false; S.editStart = 0;
        rpGuard = true;   // setMode() scrolls to the top; don't let that overwrite the saved reading spot
        S.base = { id: n.id, title: n.title, markdown: n.markdown, updatedAt: n.updatedAt };
        addTab(id);
        fillDoc();
        showDoc();
        S.savedAt = n.updatedAt;
        setSave('saved');
        setMode(n.markdown.trim() ? 'read' : preferredEditStyle(), false);
        restoreReadPos(n);
        closeDrawers();
    }

    async function newNote(folderName) {
        await settle();
        pruneCurrentTabIfBlank();
        if (await discardCurrentIfBlank()) { S.note = null; S.dirty = false; }
        const now = Date.now();
        const sc = S.scope;
        const note = {
            id: uid(), title: '', markdown: '',
            type: folderName ? normType(findExistingFolder(folderName) || folderName) : ((sc.kind === 'folder' && S.fmap.get(sc.value)) ? S.fmap.get(sc.value).label : 'General'),
            tags: (sc.kind === 'tag' && S.tmap.get(sc.value)) ? [S.tmap.get(sc.value).label] : [],
            pinned: false, createdAt: now, updatedAt: now
        };
        // "+ New note" from a linkable entity is a real linked-note creation path, not
        // just a filtered view. Skill was the only entity missing this pre-link behavior.
        if (sc.kind === 'skill' && sc.value && sc.value.career && sc.value.skill) {
            EntityLinks.link(note, 'skill', sc.value.skill, { career: sc.value.career });
            note.linkedCareer = sc.value.career;
            note.linkedSkill = sc.value.skill;
        }
        // "+ New note" while scoped to a course (via Courses tracker's note badge) pre-links
        // it right away, instead of leaving the person to set Course by hand afterwards.
        if (sc.kind === 'course' && sc.value && sc.value.id) {
            EntityLinks.link(note, 'course', sc.value.id);
            note.course = sc.value.title || '';
            if (sc.value.career) note.linkedCareer = sc.value.career;
        }
        // "+ New note" while scoped to a resource (via the Resource Library's Notes
        // badge) pre-links it right away, same as the course case above.
        if (sc.kind === 'resource' && sc.value && sc.value.id) {
            EntityLinks.link(note, 'resource', sc.value.id);
            note.resource = sc.value.title || '';
        }
        // "+ New note" while scoped to an Investment Analysis (via that tracker's Notes
        // badge) pre-links it right away, same as the course/resource cases above.
        if (sc.kind === 'analysis' && sc.value && sc.value.id) {
            EntityLinks.link(note, 'analysis', sc.value.id);
            note.analysis = sc.value.title || '';
        }
        // "+ New note" while scoped to a Deal Diary entry (via that tracker's Notes
        // badge) pre-links it right away, same as the course/resource/analysis cases above.
        if (sc.kind === 'deal' && sc.value && sc.value.id) {
            EntityLinks.link(note, 'deal', sc.value.id);
            note.deal = sc.value.title || '';
        }
        S.note = note; S.persisted = false; S.dirty = false;
        S.edited = false; S.editStart = 0; S.base = null;
        addTab(note.id);
        fillDoc();
        showDoc();
        setSave('idle');
        setMode(preferredEditStyle(), false);
        closeDrawers();
        requestAnimationFrame(() => { fitTitle(); el.title.focus(); });
    }

    // Folders aren't a stored entity of their own — they're just each note's "type" field,
    // and one shows up in the sidebar the moment any note uses it. So "creating a folder"
    // means: ask for a name, then open a new blank note already filed under it. Typing a
    // title/body for that note is what actually makes the folder appear (a still-blank note
    // is never saved — see flushSave() — same as "+ New note").
    async function promptNewFolder() {
        const name = (await skPrompt('Name this folder', ''))?.trim();
        if (!name) return;
        const existing = findExistingFolder(name);
        await newNote(name);
        toast(existing
            ? 'Folder “' + existing + '” already exists — using it instead of creating a duplicate. Give the note a title to keep it.'
            : 'New note started in “' + normType(name) + '” — give it a title to keep it.');
    }

    // Groups of folders that are really the same one written differently (Tài chính / Tai chinh,
    // AI Finance / AI-Finance). Biggest folder first — that one is kept.
    function folderDupGroups() {
        const g = new Map();
        for (const [k, f] of S.fmap) {
            const lk = looseFolderKey(f.label);
            if (!g.has(lk)) g.set(lk, []);
            g.get(lk).push({ key: k, label: f.label, count: f.count, latest: f.latest });
        }
        return [...g.values()].filter((a) => a.length > 1).map((a) => a.sort((x, y) => (y.count - x.count) || (y.latest - x.latest)));
    }
    async function mergeDuplicateFolders() {
        const groups = folderDupGroups();
        if (!groups.length) { toast('No duplicate folders found.'); return; }
        const lines = groups.map((a) => '• ' + a.map((f) => f.label + ' (' + f.count + ')').join(' + ') + '  →  “' + a[0].label + '”').join('\n');
        const ok = await skConfirm('Notes move into the folder with the most notes in each group; the others disappear. A backup file downloads first.\n\n' + lines,
            { title: 'Merge ' + groups.length + ' duplicate folder' + (groups.length === 1 ? '' : 's') + '?', okText: 'Merge' });
        if (!ok) return;
        await settle();   // flush the open note first so its latest edits aren't lost
        try { await exportAllJson(); toast('Backup downloaded \u2014 merging folders\u2026'); }
        catch (e) { console.error('Notes Vault: pre-merge backup failed', e); toast('Couldn\u2019t create the backup, so nothing was merged.'); return; }
        let moved = 0; const now = Date.now();
        for (const a of groups) {
            const keep = a[0];
            for (const f of a.slice(1)) {
                for (const n of S.notes) {
                    if (typeKey(n.type) !== f.key) continue;
                    n.type = keep.label; n.updatedAt = now;
                    await dbPut(n); moved++;
                }
                // carry the icon/colour over if the kept folder has none of its own
                if (S.folderStyles[f.key] && !S.folderStyles[keep.key]) S.folderStyles[keep.key] = S.folderStyles[f.key];
                delete S.folderStyles[f.key];
            }
        }
        saveFolderStyles();
        if (S.note && el.folderIn) el.folderIn.value = normType(S.note.type);
        renderAll();
        toast('Merged ' + groups.length + ' folder group' + (groups.length === 1 ? '' : 's') + ' — ' + moved + ' note' + (moved === 1 ? '' : 's') + ' moved.');
    }

    // "Customize folder": pick an icon + color for one folder, saved in S.folderStyles.
    // Every pick is applied (and persisted) immediately, so there's nothing to lose by
    // just closing the popover once you're happy with the preview.
    let fedKey = null, fedLabel = '', fedPick = { icon: '', color: '' };
    function fedRenderPreview() {
        el.fedPreview.innerHTML = '<i class="fa-solid fa-' + fedPick.icon + '"' + (fedPick.color ? ' style="color:' + esc(fedPick.color) + '"' : '') + '></i><span>' + esc(fedLabel) + '</span>';
    }
    function fedRenderIcons() {
        el.fedIcons.innerHTML = FOLDER_ICON_CHOICES.map((ic) =>
            '<button type="button" class="nv-fed-swatch' + (ic === fedPick.icon ? ' nv-cur' : '') + '" data-fed-icon="' + ic + '" title="' + ic + '" aria-label="' + ic + '"><i class="fa-solid fa-' + ic + '" aria-hidden="true"></i></button>'
        ).join('');
    }
    function fedRenderColors() {
        el.fedColors.innerHTML = '<button type="button" class="nv-fed-color nv-fed-color-none' + (!fedPick.color ? ' nv-cur' : '') + '" data-fed-color="" title="No color" aria-label="No color"><i class="fa-solid fa-ban" aria-hidden="true"></i></button>'
            + FOLDER_COLOR_CHOICES.map((c) =>
                '<button type="button" class="nv-fed-color' + (c === fedPick.color ? ' nv-cur' : '') + '" data-fed-color="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>'
            ).join('');
    }
    function openFolderEditor(key, label) {
        closeMenus();
        fedKey = key; fedLabel = label;
        const cur = S.folderStyles[key] || {};
        fedPick = { icon: cur.icon || heuristicIconFor(label), color: cur.color || '' };
        el.fedTitle.innerHTML = '<i class="fa-solid fa-palette" aria-hidden="true"></i> Customize “' + esc(label) + '”';
        fedRenderIcons(); fedRenderColors(); fedRenderPreview();
        el.fedScrim.hidden = false;
        el.fed.hidden = false;
    }
    function closeFolderEditor() {
        el.fed.hidden = true;
        el.fedScrim.hidden = true;
        fedKey = null;
    }
    function applyFolderStyleChange(patch) {
        if (!fedKey) return;
        const cur = Object.assign({}, S.folderStyles[fedKey] || {});
        if ('icon' in patch) { if (patch.icon && patch.icon !== heuristicIconFor(fedLabel)) cur.icon = patch.icon; else delete cur.icon; }
        if ('color' in patch) { if (patch.color) cur.color = patch.color; else delete cur.color; }
        if (Object.keys(cur).length) S.folderStyles[fedKey] = cur; else delete S.folderStyles[fedKey];
        saveFolderStyles();
        fedPick = { icon: cur.icon || heuristicIconFor(fedLabel), color: cur.color || '' };
        fedRenderIcons(); fedRenderColors(); fedRenderPreview();
        renderSide(); renderLibrary();
    }
    function resetFolderStyle() {
        if (!fedKey) return;
        delete S.folderStyles[fedKey];
        saveFolderStyles();
        fedPick = { icon: heuristicIconFor(fedLabel), color: '' };
        fedRenderIcons(); fedRenderColors(); fedRenderPreview();
        renderSide(); renderLibrary();
    }

    // Clicking a [[wikilink]] opens the note with that title, or — if none exists — creates a
    // blank one with that title and drops straight into Edit mode, the way Obsidian does.
    async function openOrCreateByTitle(title) {
        const t = String(title || '').trim();
        if (!t) return;
        const existing = findNoteByTitle(t);
        if (existing) { await openNote(existing.id); return; }
        await settle();
        pruneCurrentTabIfBlank();
        closeWlPopup();
        const now = Date.now();
        const note = {
            id: uid(), title: t, markdown: '',
            type: (S.scope.kind === 'folder' && S.fmap.get(S.scope.value)) ? S.fmap.get(S.scope.value).label : 'General',
            tags: [], pinned: false, createdAt: now, updatedAt: now
        };
        S.note = note; S.persisted = false; S.dirty = false;
        S.edited = false; S.editStart = 0; S.base = null;
        addTab(note.id);
        fillDoc();
        showDoc();
        setSave('idle');
        setMode(preferredEditStyle(), false);
        closeDrawers();
        markDirty();                       // schedule the save that actually creates the note
        requestAnimationFrame(() => el.src.focus());
        flash('Created “' + t + '”');
    }

    async function leaveDoc() {
        if (!S.note) return;
        closeWlPopup();
        await settle();
        pruneCurrentTabIfBlank();
        await discardCurrentIfBlank();
        exitRevView();
        S.note = null; S.dirty = false; S.activeTab = null;
        showLibrary();
        renderTabStrip();
        renderAll();
    }

    /* ═════════════ Version history panel ═════════════ */
    function fmtVer(ts) {
        const d = new Date(ts), now = new Date();
        if (d.toDateString() === now.toDateString()) return 'Today ' + clock(ts);
        const y = new Date(now); y.setDate(now.getDate() - 1);
        if (d.toDateString() === y.toDateString()) return 'Yesterday ' + clock(ts);
        return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() === now.getFullYear() ? '' : ' ' + d.getFullYear()) + ', ' + clock(ts);
    }

    async function renderHistory() {
        if (!S.note || !S.inspOpen || S.inspTab !== 'history') return;
        const id = S.note.id;
        let revs = [];
        if (S.persisted) { try { revs = await revList(id); } catch (e) { console.warn('Notes Vault: could not read history', e); } }
        if (!S.note || S.note.id !== id) return;      // user moved on while we were reading
        S.revs = revs;
        paintHistory();
    }
    function paintHistory() {
        const n = S.note;
        if (!n) return;
        const revs = S.revs;
        el.histClear.hidden = !revs.length;
        if (!revs.length) {
            el.histList.innerHTML = '<li class="nv-ol-empty">No earlier versions yet. The first one appears about 10 minutes into writing, or when you leave the note. You can also save one yourself with the button above.</li>';
            return;
        }
        const viewing = S.viewRev ? S.viewRev.id : null;
        const cur = `<li><button type="button" class="nv-rev${viewing ? '' : ' nv-cur'}" data-rev="current"${viewing ? '' : ' aria-current="true"'}><span class="nv-rev-when">Current version</span><span class="nv-rev-meta">Edited ${esc(fmtRel(n.updatedAt))}</span></button></li>`;
        const rows = revs.map((r, i) => {
            const older = revs[i + 1];
            let delta = '';
            if (older) {
                const d = r.words - older.words;
                if (d) delta = ' · ' + (d > 0 ? '+' : '−') + Math.abs(d).toLocaleString();
            }
            const tag = REV_LABELS[r.label] || '';
            const on = viewing === r.id;
            return `<li><button type="button" class="nv-rev${on ? ' nv-cur' : ''}" data-rev="${esc(r.id)}"${on ? ' aria-current="true"' : ''} title="${esc(fmtFull(r.savedAt))}"><span class="nv-rev-when">${esc(fmtVer(r.savedAt))}</span><span class="nv-rev-meta">${r.words.toLocaleString()} words${delta}</span>${tag ? `<span class="nv-rev-tag">${esc(tag)}</span>` : ''}</button></li>`;
        });
        el.histList.innerHTML = cur + rows.join('');
    }

    // Preview an old version in the reading view. Nothing is changed until "Restore this version".
    async function viewRevision(id) {
        const rev = S.revs.find((r) => r.id === id);
        if (!S.note || !rev) return;
        await flushSave();
        if (!S.viewRev) S.revPrev = S.split ? 'split' : S.mode;
        setMode('read');
        S.viewRev = rev;
        el.revTxt.textContent = 'Viewing the version from ' + fmtFull(rev.savedAt) + '. Read only.';
        el.revBar.hidden = false;
        el.title.value = rev.title;
        el.title.readOnly = true;
        fitTitle();
        renderInto(el.read, rev.markdown, false);
        el.docScroll.scrollTop = 0;
        renderOutline();
        renderMentions();
        paintHistory();
        closeDrawers();
        updateProgress();
    }
    function exitRevView() {
        if (!S.viewRev) return;
        S.viewRev = null;
        el.revBar.hidden = true;
        el.title.readOnly = false;
        if (S.note) { el.title.value = S.note.title; fitTitle(); }
        renderMentions();
        paintHistory();
    }
    function backToCurrent() {
        if (!S.viewRev || !S.note) return;
        const m = S.revPrev || 'read';
        exitRevView();
        setMode(m, false);
    }
    async function restoreRevision(id) {
        const rev = S.revs.find((r) => r.id === id);
        const n = S.note;
        if (!rev || !n || !S.persisted) return;
        await flushSave();
        await snapshot(n, { label: 'before-restore' });   // what you have now stays available in History
        exitRevView();
        n.title = rev.title;
        n.markdown = rev.markdown;
        S.dirty = true; S.edited = true;
        if (!S.editStart) S.editStart = Date.now();
        await flushSave();
        await snapshot(n, { label: 'restore' });
        fillDoc();
        setMode(S.revPrev || 'read', false);
        flash('Restored the version from ' + fmtFull(rev.savedAt));
    }
    async function saveVersionNow() {
        if (!S.note || !S.persisted) { flash('Write something first, then save a version'); return; }
        await flushSave();
        const ok = await snapshot(S.note, { label: 'manual' });
        flash(ok ? 'Version saved' : 'Nothing has changed since the last version');
        renderHistory();
    }
    async function clearHistory() {
        if (!S.note) return;
        if (!confirm('Delete every saved version of this note? The note itself is not affected.')) return;
        const id = S.note.id;
        backToCurrent();
        try { await revDeleteForNote(id); } catch (e) { console.warn(e); }
        S.base = null; S.revs = [];
        paintHistory();
        flash('History cleared');
    }

    /* ═════════════ Outline ═════════════ */
    function outlineFromMd(md) {
        const out = [];
        let fence = null, off = 0;
        for (const line of md.split('\n')) {
            const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
            if (f) {
                if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null;
            } else if (!fence) {
                const h = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
                if (h) out.push({ level: h[1].length, text: h[2].replace(/[*_`]/g, ''), off });
            }
            off += line.length + 1;
        }
        return out;
    }
    function outlineFromDom() {
        return [...el.read.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({ level: +h.tagName[1], text: h.textContent.trim() }));
    }
    function renderOutline() {
        if (!S.note || !S.inspOpen || S.inspTab !== 'outline') return;
        const items = S.mode === 'edit' ? outlineFromMd(S.note.markdown) : outlineFromDom();
        S.outline = items;
        if (!items.length) {
            el.outline.innerHTML = '<li class="nv-ol-empty">No headings yet. Start a line with # or ## and it will show up here.</li>';
            return;
        }
        const min = Math.min(...items.map((i) => i.level));
        el.outline.innerHTML = items.map((it, k) =>
            `<li><button type="button" data-o="${k}" class="${it.level === min ? 'nv-l1' : ''}" style="padding-left:${8 + (it.level - min) * 14}px" title="${esc(it.text)}">${esc(it.text)}</button></li>`).join('');
    }
    function linkRowHtml(title, note) {
        return note
            ? `<li><button type="button" class="nv-lk-item" data-open="${esc(note.id)}"><i class="fa-solid fa-file-lines" aria-hidden="true"></i><span>${esc(note.title.trim() || 'Untitled note')}</span></button></li>`
            : `<li><button type="button" class="nv-lk-item nv-lk-new" data-create="${esc(title)}"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>${esc(title)}</span><em>Create</em></button></li>`;
    }
    function renderLinksPane() {
        if (!S.note || !S.inspOpen || S.inspTab !== 'links') return;
        const out = computeOutgoingLinks(S.note);
        el.linksOut.innerHTML = out.length
            ? out.map((o) => linkRowHtml(o.title, o.note)).join('')
            : '<li class="nv-ol-empty">No links yet. Type <code>[[</code> in Edit mode to link to another note.</li>';
        const back = computeBacklinks(S.note);
        el.backlinkCount.textContent = back.length ? String(back.length) : '';
        el.linksBack.innerHTML = back.length
            ? back.map((b) => `<li><button type="button" class="nv-lk-item nv-lk-back-item" data-open="${esc(b.note.id)}">
                <span class="nv-lk-back-title">${b.note.pinned ? '<i class="fa-solid fa-star" aria-hidden="true"></i> ' : ''}${esc(b.note.title.trim() || 'Untitled note')}</span>
                <span class="nv-lk-back-snip">${esc(b.snippet)}</span>
            </button></li>`).join('')
            : '<li class="nv-ol-empty">No other notes link here yet. Once one does, it will show up here automatically.</li>';
    }

    /* ═════════════ Linked mentions: same data as the Links tab's "Linked from" list,
       but surfaced right under the note body in Read mode — Obsidian-style — so backlinks
       are visible without opening the Inspector at all. Collapsed/expanded state is kept
       per note (in memory only) via S.mentionsOpen so re-opening a note you collapsed
       earlier this session remembers your choice; defaults to open. ═════════════ */
    function renderMentions() {
        if (!el.mentions) return;
        if (!S.note || S.mode === 'edit' || S.viewRev) { el.mentions.hidden = true; return; }
        const back = computeBacklinks(S.note);
        if (!back.length) { el.mentions.hidden = true; return; }
        el.mentions.hidden = false;
        el.mentionsCount.textContent = String(back.length);
        const isOpen = !S.mentionsClosed.has(S.note.id);
        el.mentionsToggle.setAttribute('aria-expanded', String(isOpen));
        el.mentionsList.innerHTML = back.map((b) => `<li><button type="button" class="nv-lk-item nv-lk-back-item" data-open="${esc(b.note.id)}">
                <span class="nv-lk-back-title">${b.note.pinned ? '<i class="fa-solid fa-star" aria-hidden="true"></i> ' : ''}${esc(b.note.title.trim() || 'Untitled note')}</span>
                <span class="nv-lk-back-snip">${esc(b.snippet)}</span>
            </button></li>`).join('');
    }

    /* ═════════════ Context pane: "where does this note sit in the vault?" ═════════════
       Two parts, both built on EntityLinks (see normalizeNote):
       1. The entity links section (Skill/Course/Resource/Analysis/Deal) — one row per type
          the note is actually linked to, jumping straight to that entry in its own tracker.
          A link whose target was since deleted/renamed shows as a dead row (same graceful-
          degradation idea as the doc-meta pills), instead of just disappearing.
       2. Related notes — other live notes that share at least one of those same entity
          links (e.g. two notes both linked to the "Financial Statement Analysis" skill),
          ranked by how many links they share, then by how recently they were touched. This
          is deliberately a different relation than the Links tab's backlinks (explicit
          [[wikilinks]]) — it surfaces notes nobody thought to cross-link, because they sit
          under the same course/skill/deal without saying so. */
    const CONTEXT_TYPE_META = {
        skill: { label: 'Skill', icon: 'fa-bullseye' },
        course: { label: 'Course', icon: 'fa-book' },
        resource: { label: 'Resource', icon: 'fa-book-open' },
        analysis: { label: 'Investment analysis', icon: 'fa-chart-line' },
        deal: { label: 'Deal', icon: 'fa-handshake' }
    };
    // Display text for a resolved (still-live) linked entity.
    function contextLiveLabel(type, live) {
        if (type === 'skill') return live.name;
        if (type === 'deal') return live.dealName;
        return live.title;
    }
    // Display text when the link is dead (target renamed/deleted) — falls back to whatever
    // free-text label the note itself is still carrying (entry.id for skill, since a skill
    // "link" has no separate free-text field), same source the old per-type pill used.
    function contextDeadLabel(type, n, entry) {
        if (type === 'skill') return entry.id;
        return n[type] || (CONTEXT_TYPE_META[type].label);
    }
    // Other live notes that share at least one entity link with `n`. Ranked by number of
    // shared links (most-relevant first), then by recency. Capped so a heavily-linked skill
    // (e.g. "Financial Modeling") doesn't turn this into a second copy of the whole vault.
    function computeRelatedNotes(n, limit) {
        const mine = (n.links || []).map((l) => l.type + '::' + l.id);
        if (!mine.length) return [];
        const mineSet = new Set(mine);
        const scored = [];
        for (const other of S.notes) {
            if (other.id === n.id) continue;
            let shared = 0;
            for (const l of (other.links || [])) if (mineSet.has(l.type + '::' + l.id)) shared++;
            if (shared) scored.push({ note: other, shared });
        }
        scored.sort((a, b) => (b.shared - a.shared) || (b.note.updatedAt - a.note.updatedAt));
        return scored.slice(0, limit || 8);
    }
    function contextEntityRowHtml(type, entry, n) {
        const meta = CONTEXT_TYPE_META[type];
        const live = EntityLinks.resolve(n, type);
        if (!live) {
            const label = contextDeadLabel(type, n, entry);
            return `<li><span class="nv-lk-item-dead" title="No longer exists"><i class="fa-solid fa-link-slash" aria-hidden="true"></i><span>${esc(label)}</span></span></li>`;
        }
        const label = contextLiveLabel(type, live);
        return `<li><button type="button" class="nv-lk-item" data-ctx-jump="${esc(type)}"><i class="fa-solid ${meta.icon}" aria-hidden="true"></i><span>${esc(label)}</span></button></li>`;
    }
    function renderContextPane() {
        if (!S.note || !S.inspOpen || S.inspTab !== 'context') return;
        const n = S.note;
        const linkedTypes = EntityLinks.TYPES.filter((t) => EntityLinks.getEntry(n, t));
        const related = computeRelatedNotes(n);
        if (!linkedTypes.length && !related.length) {
            el.context.innerHTML = '<p class="nv-ctx-empty">This note isn\'t connected to anything yet. Link a skill, course, resource, analysis or deal in the Info tab, or add a <code>[[wikilink]]</code> to another note.</p>';
            return;
        }
        let html = '';
        if (linkedTypes.length) {
            html += linkedTypes.map((type) => {
                const entry = EntityLinks.getEntry(n, type);
                return `<div class="nv-side-h">${esc(CONTEXT_TYPE_META[type].label)}</div><ul class="nv-lk">${contextEntityRowHtml(type, entry, n)}</ul>`;
            }).join('');
        }
        if (related.length) {
            html += `<div class="nv-side-h">Related notes</div><ul class="nv-lk">${related.map((r) => linkRowHtml('', r.note)).join('')}</ul>`;
        }
        el.context.innerHTML = html;
    }
    function scrollSrcTo(off) {
        if (S.live && lv) { lv.scrollTo(off); return; }
        const ta = el.src, cs = getComputedStyle(ta);
        const m = document.createElement('div');
        m.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;';
        ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'borderLeftWidth', 'borderRightWidth', 'borderTopWidth', 'borderBottomWidth', 'borderStyle']
            .forEach((p) => { m.style[p] = cs[p]; });
        m.style.width = ta.offsetWidth + 'px';
        m.textContent = ta.value.slice(0, off);
        const mark = document.createElement('span');
        mark.textContent = '\u200b';
        m.appendChild(mark);
        el.app.appendChild(m);
        const y = mark.offsetTop;
        m.remove();
        ta.scrollTop = Math.max(0, y - 28);
    }
    function jumpToHeading(k) {
        const it = S.outline[k];
        if (!it) return;
        if (S.mode === 'edit') {
            el.src.focus();
            el.src.setSelectionRange(it.off, it.off);
            scrollSrcTo(it.off);
        } else {
            const h = el.read.querySelectorAll('h1,h2,h3,h4,h5,h6')[k];
            if (h) h.scrollIntoView({ block: 'start' });
            closeDrawers();
        }
    }

    /* ═════════════ Saving ═════════════ */
    function setSave(state) {
        S.saveState = state;
        el.save.dataset.s = state;
        el.saveTxt.textContent =
            state === 'saving' ? 'Saving…' :
            state === 'saved' ? 'Saved locally · ' + clock(S.savedAt || Date.now()) :
            state === 'error' ? 'Couldn’t save — browser storage may be full' : 'Autosave on';
    }
    function flash(msg) {
        el.saveTxt.textContent = msg;
        clearTimeout(S.flashTimer);
        S.flashTimer = setTimeout(() => setSave(S.saveState), 2200);
    }
    function hideToast() {
        clearTimeout(S.toastTimer);
        S.toastAct = null;
        if (el && el.toast) el.toast.hidden = true;
    }
    function toast(msg, label, act) {
        clearTimeout(S.toastTimer);
        el.toastTxt.textContent = msg;
        el.toastBtn.textContent = label || '';
        el.toastBtn.hidden = !act;
        S.toastAct = act || null;
        el.toast.hidden = false;
        S.toastTimer = setTimeout(hideToast, act ? 9000 : 3500);
    }
    // Matches a GFM task marker at the start of a (non-fenced) list-item line: bullet or
    // ordered marker, then "[ ]" / "[x]" / "[X]". Only the bracket itself is captured/replaced,
    // so anything else on the line is left untouched.
    const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/;
    // Flips the n-th task checkbox (in document order, skipping fenced code blocks so a literal
    // "- [ ]" inside a code sample doesn't throw off the count) in the current note's markdown.
    // Returns true if a matching line was found and toggled.
    function toggleTaskAt(index) {
        if (!S.note) return false;
        const lines = S.note.markdown.split('\n');
        let count = 0, inFence = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^\s*(`{3,}|~{3,})/.test(line)) { inFence = !inFence; continue; }
            if (inFence) continue;
            const m = TASK_RE.exec(line);
            if (!m) continue;
            if (count === index) {
                const next = m[2].toLowerCase() === 'x' ? ' ' : 'x';
                lines[i] = line.slice(0, m[1].length) + '[' + next + ']' + line.slice(m[1].length + 3);
                S.note.markdown = lines.join('\n');
                return true;
            }
            count++;
        }
        return false;
    }
    // Sets (rather than flips) the checked state of the Nth task line, matching an already-
    // known target state. Used by the checkbox click handler below: a native checkbox click
    // flips element.checked to its new value BEFORE the 'click' listener runs (per the HTML
    // activation-behavior spec), so by the time our handler sees it, cb.checked already IS
    // the value the user wants. Writing that value directly avoids a "flip a value that's
    // already flipped" double-toggle, which would silently put the checkbox one click behind
    // the underlying markdown.
    function setTaskCheckedAt(index, checked) {
        if (!S.note) return false;
        const lines = S.note.markdown.split('\n');
        let count = 0, inFence = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^\s*(`{3,}|~{3,})/.test(line)) { inFence = !inFence; continue; }
            if (inFence) continue;
            const m = TASK_RE.exec(line);
            if (!m) continue;
            if (count === index) {
                lines[i] = line.slice(0, m[1].length) + '[' + (checked ? 'x' : ' ') + ']' + line.slice(m[1].length + 3);
                S.note.markdown = lines.join('\n');
                return true;
            }
            count++;
        }
        return false;
    }
    function markDirty() {
        if (!S.note) return;
        S.dirty = true;
        if (!S.edited) { S.edited = true; S.editStart = Date.now(); }
        setSave('saving');
        clearTimeout(S.saveTimer);
        S.saveTimer = setTimeout(() => flushSave(), SAVE_DELAY);
        scheduleDerived();
    }
    async function flushSave(opts) {
        clearTimeout(S.saveTimer);
        const n = S.note;
        if (!n || !S.dirty) return;
        // A brand-new note that is still completely blank is not worth storing.
        if (!S.persisted && !n.title.trim() && !n.markdown.trim() && !n.tags.length) {
            S.dirty = false; setSave('idle'); return;
        }
        S.dirty = false;
        // Safe rename: if the title changed since the note was opened and other live notes
        // link to the OLD title, ask before persisting — a silent title change would turn
        // every [[Old Title]] elsewhere into a dead link with no way to tell which notes broke.
        if (n.title.trim() && S.base && S.base.id === n.id && !S.renamePrompted) {
            const oldTitle = (S.base.title || '').trim();
            const newTitle = n.title.trim();
            if (oldTitle && fold(oldTitle) !== fold(newTitle)) {
                const backlinks = findBacklinksToTitle(oldTitle, n.id);
                if (backlinks.length) {
                    S.renamePrompted = true;
                    const choice = await showRenameDialog(oldTitle, newTitle, backlinks);
                    S.renamePrompted = false;
                    if (choice === 'cancel') {
                        n.title = oldTitle;
                        if (S.note === n && el.title) { el.title.value = oldTitle; fitTitle(); }
                    } else {
                        if (choice === 'update') {
                            const count = await renameLinksAcrossVault(oldTitle, newTitle, n.id, backlinks);
                            renderSide(); renderLibrary();
                            if (S.note === n) { renderLinksPane(); renderMentions(); }
                            flash(count + (count === 1 ? ' link updated' : ' links updated'));
                        }
                        S.base.title = newTitle;
                    }
                } else {
                    S.base.title = newTitle;
                }
            }
        }
        if (n.title.trim()) {
            const renamed = dedupeTitle(n.title, n.id);
            if (renamed !== n.title.trim()) {
                const original = n.title.trim();
                n.title = renamed;
                if (S.note === n && el.title) { el.title.value = renamed; fitTitle(); }
                toast('Renamed to “' + renamed + '” — a note titled “' + original + '” already exists.');
            }
        }
        if (!(opts && opts.keepTime)) n.updatedAt = Date.now();
        try {
            await captureOriginal(n);
            await dbPut(n);
            syncAttachmentRefs(n.id, n.markdown).catch((e) => console.warn('Notes Vault: attachment ref sync failed', e));
            if (!S.persisted) {
                S.persisted = true;
                if (!S.notes.includes(n)) S.notes.push(n);
                // "+ New note" from a linkable entity (see newNote()) pre-links the note before
                // it's ever saved — linkExistingNote/unlinkScopedNote both call
                // afterEntityLinkChanged so their host tracker's badge updates live, but this
                // first-save path never did, so the badge stayed stale until a full reload.
                // Firing it here for whichever scope(s) the new note carries closes that gap.
                LINKABLE_SCOPES.forEach((kind) => { if (EntityLinks.getId(n, kind)) afterEntityLinkChanged(kind); });
            }
            // A note keeps no "base title" to compare against until it's first persisted; once
            // it exists, later renames in the same session need something to diff against too.
            if (S.note === n && (!S.base || S.base.id !== n.id)) S.base = { id: n.id, title: n.title, markdown: n.markdown, updatedAt: n.updatedAt };
            S.savedAt = n.updatedAt;
            if (S.note === n) {
                if (!S.dirty) setSave('saved');
                renderDocMeta();
                el.updated.textContent = fmtFull(n.updatedAt);
            }
            renderSide();
            renderLibrary();
            renderTabStrip();
            renderDatalists();
            await autoSnapshot(n);
            nvSyncPlannerDeadline(n);
        } catch (e) {
            console.error('Notes Vault save failed:', e);
            S.dirty = true;
            if (S.note === n) setSave('error');
        }
    }
    // Autosave is debounced (SAVE_DELAY). Without this, closing the tab / shutting down within that window left the last edit
    // — e.g. a screenshot pasted just before closing — unsaved. Hiding or leaving the page now saves immediately.
    document.addEventListener('visibilitychange', () => { if (document.hidden) { flushSave().catch(() => {}); rpFlush().catch(() => {}); } });
    window.addEventListener('pagehide', () => { flushSave().catch(() => {}); rpFlush().catch(() => {}); });

    /* ═════════════ Actions ═════════════ */
    function download(content, filename, mime) {
        const blob = new Blob([content], { type: mime + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    function slugify(title) {
        return (title || 'untitled-note').toLowerCase()
            .replace(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff\s-]/gi, '')
            .trim().replace(/\s+/g, '-').slice(0, 60) || 'untitled-note';
    }
    const yamlStr = (s) => (/^[\w][\w .\-\/]*$/.test(s) && !/\s$/.test(s)) ? s : JSON.stringify(s);
    function extFromMime(mime) {
        if (mime === 'application/pdf') return 'pdf';
        if (isSheetMime(mime)) return Object.keys(SHEET_EXT).find((k) => SHEET_EXT[k] === mime);
        const m = /^image\/([a-z0-9.+-]+)/i.exec(mime || '');
        if (!m) return 'bin';
        return m[1].split('+')[0] === 'jpeg' ? 'jpg' : m[1].split('+')[0];
    }
    // Rewrites `attachment://id` references so an exported note works *outside* the app —
    // Obsidian/GitHub/VS Code have no idea what an `attachment://` scheme is, only this app's
    // own IndexedDB-backed renderer does. Two modes:
    //   'folder' — used when exporting into a real folder (exportNotesToFolder): rewrites to a
    //     relative `attachments/<id>.<ext>` path, and reports each attachment via
    //     opts.onAttachment(rec, filename) so the caller can write the actual image file once
    //     per unique id (several notes, or several references in one note, can share an image).
    //   anything else ('inline', the default) — used for single-file exports (Save .md to disk,
    //     the plain "Export as .md" download) where there's nowhere to put a sidecar file:
    //     embeds the image right in the Markdown as a base64 data: URI.
    // An id that no longer resolves locally (attachment missing/orphaned) is left as
    // `attachment://` untouched — better a reference the app itself can still make sense of
    // than a silently vanished image.
    async function resolveAttachmentForExport(id, opts) {
        const rec = await dbGetAttachment(id).catch(() => null);
        if (!rec) return null;
        if (opts.mode === 'folder') {
            const filename = id + '.' + extFromMime(rec.mime);
            if (opts.onAttachment) await opts.onAttachment(rec, filename);
            return 'attachments/' + filename;
        }
        try {
            const b64 = await blobToBase64(rec.blob);
            return 'data:' + (rec.mime || 'image/webp') + ';base64,' + b64;
        } catch (e) { return null; }
    }
    async function portableizeAttachments(markdown, opts) {
        opts = opts || {};
        if (!markdown || markdown.indexOf('attachment://') === -1) return markdown;
        const re = /!\[([^\]]*)\]\(attachment:\/\/([a-zA-Z0-9_-]+)(\s+"[^"]*")?\)/g;
        const cache = new Map();   // attachment id -> resolved target (filename or data URI), or null if unavailable
        let out = '', last = 0, m;
        while ((m = re.exec(markdown))) {
            out += markdown.slice(last, m.index);
            last = re.lastIndex;
            const [full, alt, id, ttl] = m;
            if (!cache.has(id)) cache.set(id, await resolveAttachmentForExport(id, opts));
            const target = cache.get(id);
            out += target !== null ? ('![' + alt + '](' + target + (ttl || '') + ')') : full;
        }
        return out + markdown.slice(last);
    }
    async function toMarkdownFile(n, opts) {
        // Obsidian-friendly: YAML properties on top, then the note itself.
        // course/deadline/career/skill are only written when set, so plain notes keep a clean
        // frontmatter block — these round-trip back in via extractFrontmatter()/applyFrontmatterFill().
        const fm = ['---',
            'title: ' + yamlStr(n.title || 'Untitled note'),
            'type: ' + yamlStr(normType(n.type)),
            'tags: [' + n.tags.map(yamlStr).join(', ') + ']',
            ...(n.course ? ['course: ' + yamlStr(n.course)] : []),
            ...(n.deadline ? ['deadline: ' + yamlStr(n.deadline)] : []),
            ...(n.linkedCareer ? ['career: ' + yamlStr(n.linkedCareer)] : []),
            ...(n.linkedSkill ? ['skill: ' + yamlStr(n.linkedSkill)] : []),
            'created: ' + new Date(n.createdAt).toISOString(),
            'updated: ' + new Date(n.updatedAt).toISOString(),
            '---', '', ''].join('\n');
        // If the note's own markdown already starts with a pasted "---…---" block (e.g. an
        // Obsidian note copied in as-is), drop it here — its fields were already folded into
        // title/type/tags when it was pasted (see applyFrontmatterFill), so keeping it would
        // just export two frontmatter blocks back to back.
        const body = await portableizeAttachments(extractFrontmatter(n.markdown).body, opts);
        const hasH1 = /^\s*#\s/.test(body);
        return fm + ((n.title && !hasH1) ? '# ' + n.title + '\n\n' : '') + body;
    }
    /* ───────── Save straight to disk (File System Access API) ─────────
       "Save .md to disk…" opens the OS save dialog and writes the note there right away — no
       separate export-then-drag step. The chosen file becomes linked to the note, so a later
       "Save changes to file" (or Ctrl/Cmd+Shift+S) writes back to the same file silently, and
       "Overwrite existing file" happens naturally by picking the same file again in the dialog.
       Falls back to a normal download in browsers without the API (Firefox, Safari). */
    async function saveNoteAsFile(n) {
        if (!FS_SUPPORTED) {
            download(await toMarkdownFile(n), slugify(n.title) + '.md', 'text/markdown');
            flash('Your browser can’t save straight to a file — downloaded instead');
            return null;
        }
        let handle;
        try {
            handle = await window.showSaveFilePicker({
                suggestedName: slugify(n.title) + '.md',
                types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }]
            });
        } catch (e) { return null; }                      // user cancelled the dialog
        try {
            await writeToHandle(handle, await toMarkdownFile(n));
            await setLinkedFile(n.id, handle);
            if (S.note && S.note.id === n.id) { renderDocMeta(); renderActions(); }
            flash('Saved to ' + handle.name);
            return handle;
        } catch (e) {
            console.error('Notes Vault: could not save file', e);
            flash('Couldn’t save that file');
            return null;
        }
    }
    // Writes to the file this note is already linked to. No dialog — this is the "keep this
    // note synced to a real .md file on disk" button. Falls back to Save As if never linked,
    // or if the link has gone stale (file moved/deleted/renamed, or permission was revoked).
    async function saveNoteToLinkedFile(n) {
        const rec = S.fileLinks.get(n.id);
        if (!rec) return saveNoteAsFile(n);
        if (!(await verifyWritePermission(rec.handle))) {
            flash('Permission needed — choose Save .md to relink');
            return null;
        }
        try {
            await writeToHandle(rec.handle, await toMarkdownFile(n));
            rec.linkedAt = Date.now();
            try { await dbPutLink(rec); } catch (e) { /* best-effort refresh of the timestamp */ }
            if (S.note && S.note.id === n.id) renderDocMeta();
            flash('Saved to ' + rec.name);
            return rec.handle;
        } catch (e) {
            console.error('Notes Vault: could not write to linked file', e);
            flash('Couldn’t write to the linked file — it may have moved. Choose Save .md to relink.');
            return null;
        }
    }
    async function unlinkNoteFile(n) {
        await clearLinkedFile(n.id);
        if (S.note && S.note.id === n.id) { renderDocMeta(); renderActions(); }
        flash('Unlinked from file');
    }
    // Bulk export: writes every note currently in `list` as its own .md file into a folder the
    // user picks. Used for "export current folder" and "export search results" alike — both are
    // just whatever filterNotes() is showing right now, so no separate selection UI is needed.
    async function exportNotesToFolder(list, label) {
        if (!list.length) { flash('Nothing to export here'); return; }
        if (!FS_SUPPORTED) {
            for (const n of list) download(await toMarkdownFile(n), slugify(n.title) + '.md', 'text/markdown');
            flash('Your browser can’t save to a folder — downloaded ' + list.length + ' files instead');
            return;
        }
        let dir;
        try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); }
        catch (e) { return; }                              // user cancelled
        // Lazily created on the first image, and shared across every note in this export — two
        // notes (or two references in one note) pointing at the same attachment id write that
        // image file only once.
        let attachDir = null;
        const written = new Set();
        const onAttachment = async (rec, filename) => {
            if (written.has(filename)) return;
            written.add(filename);
            try {
                if (!attachDir) attachDir = await dir.getDirectoryHandle('attachments', { create: true });
                const fh = await attachDir.getFileHandle(filename, { create: true });
                await writeToHandle(fh, rec.blob);
            } catch (e) { console.error('Notes Vault: could not export attachment', filename, e); written.delete(filename); }
        };
        const used = new Set();
        let ok = 0;
        for (const n of list) {
            let name = slugify(n.title) + '.md', i = 2;
            while (used.has(name)) { name = slugify(n.title) + '-' + i + '.md'; i++; }   // two notes, same title
            used.add(name);
            try {
                const fh = await dir.getFileHandle(name, { create: true });
                await writeToHandle(fh, await toMarkdownFile(n, { mode: 'folder', onAttachment }));
                ok++;
            } catch (e) { console.error('Notes Vault: could not export', n.title, e); }
        }
        const imgMsg = written.size ? ' + ' + written.size + (written.size === 1 ? ' image' : ' images') : '';
        flash('Exported ' + ok + ' of ' + list.length + (label ? ' notes (' + label + ')' : ' notes') + imgMsg);
    }
    async function copyText(t) {
        try { await navigator.clipboard.writeText(t); return true; }
        catch (e) {
            const ta = document.createElement('textarea');
            ta.value = t; ta.style.cssText = 'position:fixed;opacity:0;';
            document.body.appendChild(ta); ta.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch (err) { /* ignore */ }
            ta.remove();
            return ok;
        }
    }

    /* ── Trash: "delete" moves a note here for 30 days ── */
    const shortName = (n) => { const t = (n.title || '').trim() || 'Untitled note'; return t.length > 42 ? t.slice(0, 41) + '…' : t; };

    async function deleteNote(id) {                  // moves to Trash (recoverable), never erases
        const isOpen = !!(S.note && S.note.id === id);
        if (isOpen) await settle();                  // store the latest text first (a brand-new note is created here)
        const n = S.notes.find((x) => x.id === id);
        if (!n) {                                    // a blank note that was never saved: nothing to keep
            if (isOpen) { exitRevView(); clearTimeout(S.saveTimer); S.dirty = false; S.note = null; showLibrary(); renderAll(); }
            return isOpen;
        }
        n.deletedAt = Date.now();
        try { await dbPut(n); }
        catch (e) { n.deletedAt = 0; console.error('Notes Vault: could not move to Trash', e); flash('Couldn’t move that note to Trash'); return false; }
        nvSyncPlannerDeadline(n);   // clears any planner reminder while the note is in Trash
        S.notes = S.notes.filter((x) => x.id !== id);
        S.trash.push(n);
        if (isOpen) { exitRevView(); clearTimeout(S.saveTimer); S.dirty = false; S.note = null; showLibrary(); }
        renderAll();
        toast('Moved “' + shortName(n) + '” to Trash', 'Undo', () => restoreNote(id));
        return true;
    }

    async function restoreNote(id) {
        const n = S.trash.find((x) => x.id === id);
        if (!n) return;
        const was = n.deletedAt;
        n.deletedAt = 0;
        try { await dbPut(n); }
        catch (e) { n.deletedAt = was; console.error('Notes Vault: could not restore', e); flash('Couldn’t restore that note'); return; }
        nvSyncPlannerDeadline(n);   // re-adds the planner reminder if the note still has a deadline
        S.trash = S.trash.filter((x) => x.id !== id);
        S.notes.push(n);
        renderAll();
        flash('Restored “' + shortName(n) + '”');
    }

    async function purgeNote(id) {                   // permanent
        const n = S.trash.find((x) => x.id === id);
        if (!n) return;
        if (!confirm('Delete “' + shortName(n) + '” forever? This cannot be undone.')) return;
        await dbDelete(id);
        try { await revDeleteForNote(id); } catch (e) { /* history is best-effort */ }
        try { await clearLinkedFile(id); } catch (e) { /* ignore */ }
        try { await releaseNoteAttachments(id, n.markdown); } catch (e) { /* attachments become orphans, catchable by "Clean up unused" */ }
        clearPendingRelink(id);
        S.trash = S.trash.filter((x) => x.id !== id);
        foldCache.delete(id);
        renderAll();
        flash('Deleted forever');
    }

    async function emptyTrash() {
        const count = S.trash.length;
        if (!count) return;
        if (!confirm('Delete ' + count + (count === 1 ? ' note' : ' notes') + ' in Trash forever? This cannot be undone.')) return;
        for (const n of S.trash.slice()) {
            await dbDelete(n.id);
            try { await revDeleteForNote(n.id); } catch (e) { /* history is best-effort */ }
            try { await clearLinkedFile(n.id); } catch (e) { /* ignore */ }
            try { await releaseNoteAttachments(n.id, n.markdown); } catch (e) { /* attachments become orphans, catchable by "Clean up unused" */ }
            clearPendingRelink(n.id);
            foldCache.delete(n.id);
        }
        S.trash = [];
        renderAll();
        flash('Trash emptied');
    }

    async function togglePinById(id) {
        const n = S.notes.find((x) => x.id === id);
        if (!n) return;
        n.pinned = !n.pinned;
        await dbPut(n);
        renderAll();
    }

    /* ── Merge v2: choose what survives, keep the tracker links ─────────────────────────────────────
       Sections of the other note that are NOT already in the surviving note are pre-ticked; nothing is
       lost silently (the other note goes to Trash, the survivor is snapshotted first). ─────────────── */
    const dupSq = (t) => String(t || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
    function dupSections(md) {
        const units = []; let cur = null, fence = false;
        const push = () => { if (cur && cur.text.trim()) units.push(cur); };
        for (const ln of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
            if (/^\s*(```|~~~)/.test(ln)) fence = !fence;
            if (!fence && /^#{1,6}\s/.test(ln)) { push(); cur = { title: ln.replace(/^#+\s*/, '').trim(), text: ln + '\n' }; }
            else { if (!cur) cur = { title: '', text: '' }; cur.text += ln + '\n'; }
        }
        push();
        if (units.filter((u) => u.title).length >= 2) return units;
        // No usable headings: split on blank lines, but never inside a fenced code block
        const paras = []; let buf = [], inFence = false;
        const flush = () => { const t = buf.join('\n').trim(); if (t) paras.push({ title: '', text: t + '\n' }); buf = []; };
        for (const ln of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
            const isFence = /^\s*(```|~~~)/.test(ln);
            if (isFence) inFence = !inFence;
            if (!inFence && !isFence && !ln.trim()) flush(); else buf.push(ln);
        }
        flush();
        return paras;
    }
    function mergeNoteMeta(primary, secondary) {
        const lost = [], groups = [['linkedCareer', 'linkedSkill', 'skill'], ['course', 'linkedCourseId', 'course'], ['resource', 'linkedResourceId', 'resource'], ['analysis', 'linkedAnalysisId', 'analysis'], ['deal', 'linkedDealId', 'deal']];
        for (const g of groups) {
            const keys = g.slice(0, 2), pHas = keys.some((k) => primary[k]), sHas = keys.some((k) => secondary[k]);
            if (!pHas && sHas) keys.forEach((k) => { primary[k] = secondary[k]; });
            else if (pHas && sHas && keys.some((k) => primary[k] !== secondary[k])) lost.push(g[2]);
        }
        if (!primary.remindAt && secondary.remindAt) { primary.remindAt = secondary.remindAt; primary.remindState = secondary.remindState || ''; }
        if (!primary.deadline) primary.deadline = secondary.deadline || '';
        else if (secondary.deadline && secondary.deadline !== primary.deadline) lost.push('deadline');
        if (normType(primary.type) === normType('') && normType(secondary.type) !== normType('')) primary.type = secondary.type;
        try { rebuildLinksFromLegacy(primary); } catch (e) { /* derived view only */ }
        return lost;
    }
    function dupMergeDialog(primary, secondary) {
        return new Promise((resolve) => {
            if (!document.getElementById('nvmStyle')) {
                const st = document.createElement('style'); st.id = 'nvmStyle';
                st.textContent = `.nvm-scrim{position:fixed;inset:0;z-index:100001;background:rgba(40,20,32,.5);display:flex;align-items:center;justify-content:center;padding:14px}
                .nvm{width:min(100%,720px);max-height:94vh;display:flex;flex-direction:column;background:var(--bg-white,#fff);color:var(--text-dark,#222);border:1px solid var(--border-color,#ddd);border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden}
                .nvm h3{margin:0;padding:16px 18px 4px;font-size:1.05rem}.nvm-sub{padding:0 18px 8px;font-size:.82rem;color:var(--text-muted,#666)}
                .nvm-body{padding:4px 18px 8px;overflow:auto;display:flex;flex-direction:column;gap:6px}
                .nvm-opt{display:flex;gap:8px;align-items:flex-start;font-size:.9rem;cursor:pointer}.nvm-opt small{display:block;color:var(--text-muted,#666)}
                .nvm-list{margin:2px 0 4px 24px;max-height:170px;overflow:auto;border:1px solid var(--border-color,#ddd);border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:3px;font-size:.82rem}
                .nvm-list label{display:flex;gap:6px;align-items:flex-start}.nvm-new{font-size:.68rem;font-weight:700;color:var(--primary,#db2777);margin-left:4px}
                .nvm-prev{width:100%;min-height:110px;resize:vertical;padding:8px;border-radius:8px;border:1px solid var(--border-color,#ccc);background:var(--bg-light,#f5f5f5);color:inherit;font:.78rem/1.4 ui-monospace,Consolas,monospace}
                .nvm-foot{display:flex;gap:8px;justify-content:flex-end;padding:10px 18px 16px}`;
                document.head.appendChild(st);
            }
            const title = (secondary.title || '').trim() || 'Untitled note';
            const units = dupSections(secondary.markdown), pn = dupSq(primary.markdown);
            const psh = dupShingles(dupTokens(dupNorm(primary.markdown)));
            // A part is NEW unless most of its word-triples already occur in the surviving note (an edited copy of a section is not new)
            const isNew = units.map((u) => {
                const t = dupSq(u.text); if (t.length <= 3 || pn.includes(t)) return false;
                const sh = dupShingles(dupTokens(dupNorm(u.text))); if (sh.size < 3) return true;
                let hit = 0; for (const h of sh) if (psh.has(h)) hit++;
                return hit / sh.size < 0.8;
            });
            const nBack = fold(title) !== fold((primary.title || '').trim()) && (secondary.title || '').trim() ? findBacklinksToTitle(secondary.title, secondary.id).reduce((a, x) => a + x.count, 0) : 0;
            const relinkHtml = nBack ? `<label class="nvm-opt"><input type="checkbox" id="nvmRelink" checked><span>Re-point ${nBack} ${nBack === 1 ? 'link' : 'links'} to “${esc(title)}” so they open this note<small>Other notes keep working instead of showing a broken [[link]].</small></span></label>` : '';
            const nNew = isNew.filter(Boolean).length, same = dupSq(primary.markdown) === dupSq(secondary.markdown);
            let mode = same || !nNew ? 'primary' : 'pick';
            const scrim = document.createElement('div'); scrim.className = 'nvm-scrim';
            const label = (u) => esc((u.title || u.text.replace(/\s+/g, ' ').trim()).slice(0, 80));
            scrim.innerHTML = `<div class="nvm" role="dialog" aria-modal="true"><h3>Merge into “${esc((primary.title || '').trim() || 'Untitled note')}”</h3>
              <div class="nvm-sub">“${esc(title)}” goes to Trash; the surviving note is snapshotted first (History → undo). ${nNew ? nNew + ' of ' + units.length + ' parts of the other note are new.' : 'Nothing in the other note is new.'}</div>
              <div class="nvm-body">
                <label class="nvm-opt"><input type="radio" name="nvmm" value="primary"><span>Keep this note’s content<small>Discard the other note’s text.</small></span></label>
                <label class="nvm-opt"><input type="radio" name="nvmm" value="pick"><span>Add only parts I pick<small>New parts are ticked; add or remove any.</small></span></label>
                <div class="nvm-list">${units.map((u, i) => `<label><input type="checkbox" data-i="${i}" ${isNew[i] ? 'checked' : ''}><span>${label(u)}${isNew[i] ? '<span class="nvm-new">NEW</span>' : ''}</span></label>`).join('')}</div>
                <label class="nvm-opt"><input type="radio" name="nvmm" value="secondary"><span>Use the other note’s content instead<small>Replace this note’s text with “${esc(title)}”.</small></span></label>
                <label class="nvm-opt"><input type="radio" name="nvmm" value="both"><span>Keep both, one after the other<small>Longest result; may repeat text.</small></span></label>
                <textarea class="nvm-prev" readonly aria-label="Preview of merged note"></textarea>${relinkHtml}
              </div>
              <div class="nvm-foot"><button type="button" class="nv-btn nv-btn-ghost" data-a="x">Cancel</button><button type="button" class="nv-btn nv-btn-primary" data-a="ok"><i class="fa-solid fa-code-merge"></i> Merge</button></div></div>`;
            document.body.appendChild(scrim);
            const prev = scrim.querySelector('.nvm-prev'), list = scrim.querySelector('.nvm-list');
            const build = () => {
                const P = primary.markdown.trim(), S2 = secondary.markdown.trim(), hdr = '\n\n---\n\n*Merged from \u201c' + title + '\u201d:*\n\n';
                if (mode === 'primary') return P;
                if (mode === 'secondary') return S2;
                if (mode === 'both') return same || !S2 ? P : P + hdr + S2;
                const chosen = [...list.querySelectorAll('input:checked')].map((c) => units[+c.dataset.i].text.trim());
                return chosen.length ? P + hdr + chosen.join('\n\n') : P;
            };
            const refresh = () => { list.style.opacity = mode === 'pick' ? '1' : '.45'; const t = build(); prev.value = t; };
            scrim.querySelectorAll('input[name=nvmm]').forEach((r) => { r.checked = r.value === mode; r.addEventListener('change', () => { mode = r.value; refresh(); }); });
            list.addEventListener('change', () => { mode = 'pick'; scrim.querySelector('input[value=pick]').checked = true; refresh(); });
            const done = (v) => { document.removeEventListener('keydown', onKey, true); scrim.remove(); resolve(v); };
            const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(null); } };
            document.addEventListener('keydown', onKey, true);
            scrim.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) done(b.dataset.a === 'ok' ? { markdown: build(), relink: !scrim.querySelector('#nvmRelink') || scrim.querySelector('#nvmRelink').checked } : null); });
            refresh(); scrim.querySelector('[data-a=ok]').focus();
        });
    }

    /* ═════════════ Merge (used by Find duplicates) ═════════════
       `primary` survives and absorbs `secondary`'s content/tags; `secondary` is moved to Trash
       (recoverable, same as a normal delete). Before overwriting, `primary`'s pre-merge state is
       snapshotted into its own version history, so "Merge" can be undone from the History panel
       even after the Trash's own Undo toast has expired. */
    async function mergeNotes(primary, secondary, opts) {
        if (!primary || !secondary || primary.id === secondary.id) return false;
        try { await snapshot({ id: primary.id, title: primary.title, markdown: primary.markdown }, { label: 'before merge' }); }
        catch (e) { /* history is best-effort */ }
        const before = Object.assign({}, primary);   // restored if the write below fails, so memory never drifts from the DB
        const otherTitle = (secondary.title || '').trim() || 'Untitled note';
        const sameContent = primary.markdown.trim() === secondary.markdown.trim();
        primary.markdown = (opts && typeof opts.markdown === 'string') ? opts.markdown
            : primary.markdown.trim() + (sameContent || !secondary.markdown.trim() ? '' : ('\n\n---\n\n*Merged from “' + otherTitle + '”:*\n\n' + secondary.markdown.trim()));
        const seenTag = new Set();   // "CFA" and "cfa" / "kế toán" and "ke toan" are one tag
        primary.tags = [...(primary.tags || []), ...(secondary.tags || [])].filter((t) => { const k = fold(String(t).trim()); if (!k || seenTag.has(k)) return false; seenTag.add(k); return true; });
        primary.pinned = !!(primary.pinned || secondary.pinned);
        const lostMeta = mergeNoteMeta(primary, secondary);   // course / skill / resource / analysis / deal / deadline / type
        primary.updatedAt = Date.now();
        try { await dbPut(primary); }
        catch (e) { Object.assign(primary, before); console.error('Notes Vault: merge failed', e); flash('Couldn’t merge those notes'); return false; }
        await syncAttachmentRefs(primary.id, primary.markdown).catch(() => {});
        try { nvSyncPlannerDeadline(primary); } catch (e) { /* planner optional */ }
        // Wikilinks resolve by title: without this every [[Other note]] that pointed at the trashed note would break.
        let relinked = 0;
        const oldT = (secondary.title || '').trim(), newT = (primary.title || '').trim();
        if ((!opts || opts.relink !== false) && oldT && newT && fold(oldT) !== fold(newT)) {
            try { relinked = await renameLinksAcrossVault(oldT, newT, secondary.id, findBacklinksToTitle(oldT, secondary.id)); }
            catch (e) { console.warn('Notes Vault: couldn’t re-point links after merge', e); }
        }
        if (S.note && (S.note.id === primary.id || relinked)) { fillDoc(); }
        const trashed = await deleteNote(secondary.id);   // shows its own "Moved to Trash · Undo" toast
        renderAll();
        if (!trashed) { flash('Merged, but couldn’t move “' + otherTitle + '” to Trash'); return false; }
        const msg = [];
        if (relinked) msg.push('Re-pointed ' + relinked + (relinked === 1 ? ' note’s links' : ' notes’ links') + ' to this note.');
        if (lostMeta.length) msg.push('Kept this note’s ' + lostMeta.join(', ') + ' link; the other note’s ' + (lostMeta.length === 1 ? 'one is' : 'ones are') + ' still in Trash.');
        if (msg.length) toast(msg.join(' '));
        return true;
    }

    /* Export a note as PDF: the note is rendered with the normal Read-mode renderer into a hidden
       #nvPrintRoot, then the browser's own print engine is invoked — "Save as PDF" in the print
       dialog. That keeps Vietnamese/Unicode text, code highlighting, tables, math and attached
       images exactly as in Read mode (no bundled PDF library, nothing extra to load). Only the
       print root is visible while printing; the dialog's default filename is the note's title. */
    function ensurePrintStyle() {
        if (document.getElementById('nvPrintStyle')) return;
        const st = document.createElement('style');
        st.id = 'nvPrintStyle';
        st.textContent = `
        #nvPrintRoot { display: none; }
        /* margin:0 makes Chrome/Edge skip their automatic header & footer (date, title, page URL, page number).
           The visual margins come from #nvPrintRoot's side padding + repeating spacer rows (.nv-pt-*) instead. */
        @page { margin: 0; }
        @media print {
            html, body { background: #fff !important; height: auto !important; overflow: visible !important; }
            body > *:not(#nvPrintRoot) { display: none !important; }
            #nvPrintRoot { display: block !important; position: static !important; width: auto !important; max-width: none !important; margin: 0 !important; padding: 0 var(--nv-pm-x, 15mm) !important;
                background: #fff !important; color: #111 !important; font-size: 11pt; line-height: 1.65;
                --text-dark: #111; --text-muted: #555; --bg-light: #f4f4f5; --bg-card: #fff; --border-color: #d4d4d8; --primary: #9d2867; }
            #nvPrintRoot table.nv-pt { display: table; width: 100%; max-width: none; border-collapse: collapse; table-layout: fixed; }
            #nvPrintRoot table.nv-pt > thead { display: table-header-group; }
            #nvPrintRoot table.nv-pt > tfoot { display: table-footer-group; }
            #nvPrintRoot table.nv-pt > thead > tr > td, #nvPrintRoot table.nv-pt > tfoot > tr > td { height: var(--nv-pm-y, 16mm); padding: 0; border: 0; background: none; }
            #nvPrintRoot table.nv-pt > tbody > tr > td { padding: 0; border: 0; background: none; vertical-align: top; }
            #nvPrintRoot .nv-print-title { font-size: 22pt; line-height: 1.25; margin: 0 0 4pt; color: #111; }
            #nvPrintRoot .nv-print-meta { font-size: 9pt; color: #666; margin: 0 0 14pt; padding-bottom: 8pt; border-bottom: 1px solid #d4d4d8; }
            #nvPrintRoot h1, #nvPrintRoot h2, #nvPrintRoot h3, #nvPrintRoot h4 { break-after: avoid; page-break-after: avoid; color: #111; }
            #nvPrintRoot pre, #nvPrintRoot blockquote, #nvPrintRoot img, #nvPrintRoot tr, #nvPrintRoot svg { break-inside: avoid; page-break-inside: avoid; }
            #nvPrintRoot pre { white-space: pre-wrap !important; word-break: break-word; overflow: visible !important; background: #f4f4f5 !important; border: 1px solid #e4e4e7; }
            #nvPrintRoot img { max-width: 100% !important; height: auto !important; }
            #nvPrintRoot .nv-tablewrap { overflow: visible !important; }
            #nvPrintRoot table { border-collapse: collapse; max-width: 100%; }
            #nvPrintRoot a { color: var(--primary-dark, #9d2867); text-decoration: underline; }
            #nvPrintRoot .nv-pdf-embed-frame, #nvPrintRoot .nv-pdf-embed-more { display: none !important; }
            #nvPrintRoot figure.nv-fig { break-inside: avoid; page-break-inside: avoid; }
            #nvPrintRoot .nv-code-copy, #nvPrintRoot .nv-code-toggle, #nvPrintRoot .nv-code-lang { display: none !important; }
            #nvPrintRoot pre.nv-collapsed { max-height: none !important; overflow: visible !important; }
            #nvPrintRoot pre.nv-collapsed::after { display: none !important; }
            #nvPrintRoot pre.nv-has-copy[data-lang]::before { display: block !important; }
            #nvPrintRoot pre.nv-has-copy { padding-top: 14px !important; }
            * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }`;
        document.head.appendChild(st);
    }
    // ── PDF export options (remembered between exports) ──
    const PDF_OPT_KEY = 'nvPdfOpts';
    const PDF_OPT_DEFAULT = { paper: 'A4', orient: 'portrait', margin: 'normal', title: true, meta: false };
    const PDF_MARGINS = { narrow: ['8mm', '8mm'], normal: ['15mm', '16mm'], wide: ['22mm', '24mm'] };   // [left/right, top/bottom]
    function loadPdfOpts() {
        try { return Object.assign({}, PDF_OPT_DEFAULT, JSON.parse(localStorage.getItem(PDF_OPT_KEY) || '{}')); } catch (e) { return Object.assign({}, PDF_OPT_DEFAULT); }
    }
    function askPdfOptions() {
        const o = loadPdfOpts();
        return new Promise((resolve) => {
            const scrim = document.createElement('div');
            scrim.className = 'nv-pdfopt-scrim';
            const sel = (id, opts, v) => '<select id="' + id + '">' + opts.map((x) => '<option value="' + x[0] + '"' + (x[0] === v ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select>';
            scrim.innerHTML = '<div class="nv-pdfopt" role="dialog" aria-modal="true" aria-label="Export PDF">'
                + '<h3>Export PDF</h3>'
                + '<div class="nv-pdfopt-row"><label for="nvPoPaper">Paper</label>' + sel('nvPoPaper', [['A4', 'A4'], ['Letter', 'Letter'], ['A5', 'A5'], ['A3', 'A3']], o.paper) + '</div>'
                + '<div class="nv-pdfopt-row"><label for="nvPoOrient">Orientation</label>' + sel('nvPoOrient', [['portrait', 'Portrait'], ['landscape', 'Landscape']], o.orient) + '</div>'
                + '<div class="nv-pdfopt-row"><label for="nvPoMargin">Margins</label>' + sel('nvPoMargin', [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']], o.margin) + '</div>'
                + '<div class="nv-pdfopt-row"><label for="nvPoTitle">Include note title</label><input type="checkbox" id="nvPoTitle"' + (o.title ? ' checked' : '') + '></div>'
                + '<div class="nv-pdfopt-row"><label for="nvPoMeta">Include folder &amp; date line</label><input type="checkbox" id="nvPoMeta"' + (o.meta ? ' checked' : '') + '></div>'
                + '<p class="nv-pdfopt-hint">In the print window, set the destination to “Save as PDF”.</p>'
                + '<div class="nv-pdfopt-acts"><button type="button" id="nvPoCancel">Cancel</button><button type="button" class="nv-primary" id="nvPoGo">Export</button></div>'
                + '</div>';
            document.body.appendChild(scrim);
            const q = (id) => scrim.querySelector('#' + id);
            const close = (val) => { document.removeEventListener('keydown', onKey, true); scrim.remove(); resolve(val); };
            const go = () => {
                const v = { paper: q('nvPoPaper').value, orient: q('nvPoOrient').value, margin: q('nvPoMargin').value, title: q('nvPoTitle').checked, meta: q('nvPoMeta').checked };
                try { localStorage.setItem(PDF_OPT_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ }
                close(v);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
                else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); e.stopPropagation(); go(); }
            };
            document.addEventListener('keydown', onKey, true);
            q('nvPoCancel').addEventListener('click', () => close(null));
            q('nvPoGo').addEventListener('click', go);
            scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(null); });
            q('nvPoGo').focus();
        });
    }
    /* PDF accent colours follow the vault theme that is active right now (Lavender Haze, Eucalyptus, ...).
       #nvPrintRoot lives on <body>, outside #nvOverlay where each theme declares its variables, so it used to
       fall back to a hard-coded magenta (#9d2867) + the site's Sakura values. Here we read the active theme's
       accent from #nvOverlay and set it inline on the print root. The page itself stays white with dark text
       (print-friendly): only accents (links, bullets, code chips, headings' colour accents) take the theme hue.
       Colours are darkened if needed so they stay legible on white paper, also when the site is in dark mode. */
    function applyPrintTheme(root) {
        try {
            const src = (typeof el !== 'undefined' && el && el.overlay) || document.getElementById('nvOverlay');
            if (!src) return;
            const cs = getComputedStyle(src);
            const toRGB = (v) => {
                v = (v || '').trim(); if (!v) return null;
                const t = document.createElement('span'); t.style.color = v; document.body.appendChild(t);
                const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(getComputedStyle(t).color); t.remove();
                return m ? [+m[1], +m[2], +m[3]] : null;
            };
            const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
            const fit = (c, max) => { let k = 1; while (k > 0.2 && lum(c.map((x) => x * k)) > max) k -= 0.05; return c.map((x) => Math.round(x * k)); };
            const hex = (c) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
            const pr = toRGB(cs.getPropertyValue('--primary'));
            if (!pr) return;
            const pd = toRGB(cs.getPropertyValue('--primary-dark')) || pr;
            const accent = fit(pr, 0.55), link = fit(pd, 0.38);
            const tint = accent.map((x) => Math.round(x + (255 - x) * 0.88));
            root.style.setProperty('--primary', hex(accent));
            root.style.setProperty('--primary-dark', hex(link));
            root.style.setProperty('--primary-light', hex(tint));
            root.style.setProperty('--primary-rgb', accent.join(', '));
        } catch (e) { console.warn('Notes Vault: could not apply theme to PDF', e); }
    }
    async function exportNotePdf(n) {
        const opts = await askPdfOptions();
        if (!opts) return;
        await flushSave();
        ensurePrintStyle();
        // Page size is chosen per export; @page margin stays 0 (see ensurePrintStyle) so no browser header/footer/URL is printed.
        const oldPage = document.getElementById('nvPrintPageStyle'); if (oldPage) oldPage.remove();
        const pageStyle = document.createElement('style');
        pageStyle.id = 'nvPrintPageStyle';
        pageStyle.textContent = '@page { size: ' + opts.paper + ' ' + opts.orient + '; margin: 0; }';
        document.head.appendChild(pageStyle);
        const pm = PDF_MARGINS[opts.margin] || PDF_MARGINS.normal;
        const old = document.getElementById('nvPrintRoot'); if (old) old.remove();
        const root = document.createElement('div');
        root.id = 'nvPrintRoot';
        root.className = 'nv-prose';
        root.style.setProperty('--nv-pm-x', pm[0]);
        root.style.setProperty('--nv-pm-y', pm[1]);
        applyPrintTheme(root);
        const h = document.createElement('h1'); h.className = 'nv-print-title'; h.textContent = n.title || 'Untitled note';
        const body = document.createElement('div');
        // Only the note itself is exported: title + content. No folder/date line, no app link, no URL.
        // Real <table> with empty header/footer rows: Chrome repeats those on every printed page, which
        // gives top/bottom margins on ALL pages even though @page margin is 0 (see ensurePrintStyle).
        const pt = document.createElement('table'); pt.className = 'nv-pt'; pt.setAttribute('role', 'presentation');
        pt.innerHTML = '<thead><tr><td></td></tr></thead><tbody><tr><td></td></tr></tbody><tfoot><tr><td></td></tr></tfoot>';
        const cellEl = pt.querySelector('tbody td');
        if (opts.title) cellEl.appendChild(h);
        if (opts.meta) {
            const meta = document.createElement('div'); meta.className = 'nv-print-meta';
            meta.textContent = [n.folder, new Date(n.updatedAt || Date.now()).toLocaleDateString()].filter(Boolean).join(' \u00b7 ');
            cellEl.appendChild(meta);
        }
        cellEl.appendChild(body);
        root.appendChild(pt);
        // The root MUST be in the document before rendering: resolveAttachments() bails out when
        // target.isConnected is false, leaving every attached image with its src stripped (the
        // broken "image" / grey placeholder that showed up in the exported PDF).
        document.body.appendChild(root);
        const printUrls = [];
        try { await renderInto(body, n.markdown || '', false, { urls: printUrls }); } catch (e) { console.warn('Notes Vault: print render failed', e); }
        // Wait until every image is really decoded (blob: URLs resolve async), max ~6s.
        const imgs = Array.from(body.querySelectorAll('img'));
        imgs.forEach((im) => { im.loading = 'eager'; });
        // Inline every attached image as a data: URL. The print engine (and Chrome's preview, which
        // re-lays-out the page whenever a print setting changes) then never depends on a blob: URL that
        // could be revoked or not yet resolved. The temporary blob URLs are released right away.
        await Promise.all(imgs.filter((im) => /^blob:/.test(im.src || '')).map(async (im) => {
            try {
                const blob = await (await fetch(im.src)).blob();
                const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
                im.src = dataUrl;
            } catch (e) { console.warn('Notes Vault: could not inline an image for PDF', e); }
        }));
        printUrls.splice(0).forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
        await Promise.race([
            Promise.all(imgs.map((im) => (im.src && im.decode ? im.decode().catch(() => {}) : Promise.resolve()))),
            new Promise((r) => setTimeout(r, 6000))
        ]);
        try { if (window.MathJax && window.MathJax.typesetPromise) await window.MathJax.typesetPromise([body]); } catch (e) { /* print anyway */ }
        const prevTitle = document.title;
        document.title = slugify(n.title) || 'note';
        const done = () => { window.removeEventListener('afterprint', done); document.title = prevTitle; root.remove(); pageStyle.remove(); printUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } }); };
        window.addEventListener('afterprint', done);
        toast('In the print dialog, choose “Save as PDF” as the destination.');
        setTimeout(() => window.print(), 250);
    }

    async function runAction(id) {
        const n = S.note;
        if (!n) return;
        if (id === 'pin') {
            await flushSave();
            n.pinned = !n.pinned;
            S.dirty = true;
            await flushSave({ keepTime: true });
            renderActions();
            flash(n.pinned ? 'Pinned' : 'Unpinned');
        } else if (id === 'dup') {
            await flushSave();
            const now = Date.now();
            const copy = Object.assign({}, n, { id: uid(), title: (n.title || 'Untitled note') + ' (copy)', tags: n.tags.slice(), pinned: false, createdAt: now, updatedAt: now,
                mapParent: '', mapOrder: 0, mapLinks: [] });   // a copy isn't part of the structure until you place it
            await dbPut(copy);
            await syncAttachmentRefs(copy.id, copy.markdown).catch(() => {});
            S.notes.push(copy);
            await openNote(copy.id);
            renderSide();
            flash('Duplicated');
        } else if (id === 'copy') {
            flash((await copyText(n.markdown)) ? 'Markdown copied' : 'Couldn’t copy — select the text in Edit mode instead');
        } else if (id === 'savefs') {
            await flushSave();
            await saveNoteAsFile(n);
        } else if (id === 'savefsupdate') {
            await flushSave();
            await saveNoteToLinkedFile(n);
        } else if (id === 'unlinkfs') {
            await unlinkNoteFile(n);
        } else if (id === 'md') {
            await flushSave();
            download(await toMarkdownFile(n), slugify(n.title) + '.md', 'text/markdown');
        } else if (id === 'pdf') {
            await exportNotePdf(n);
        } else if (id === 'txt') {
            download((n.title ? n.title + '\n\n' : '') + n.markdown, slugify(n.title) + '.txt', 'text/plain');
        } else if (id === 'hist') {
            if (S.focus) toggleFocus(false);
            S.inspOpen = true;
            applyLayout();
            setInspTab('history');
        } else if (id === 'del') {
            await deleteNote(n.id);
        }
    }

    /* ── Backup / restore / persistence ── */
    // "Export folder" and "Export selected notes" are really the same action: whatever the
    // sidebar is currently showing — a single folder, a tag, search results, or all notes —
    // exported as one real .md file per note into a folder on disk.
    async function exportCurrentView() {
        await flushSave();
        const list = filterNotes(qTokens());
        await exportNotesToFolder(list, el.libTitle ? el.libTitle.textContent : '');
    }
    async function exportAllJson() {
        const backup = await getBackupData();
        const payload = {
            app: 'FinanceTracker-NotesVault', schema: BACKUP_SCHEMA, exportedAt: new Date().toISOString(),
            notes: backup.notes, revisions: backup.revisions, fileLinks: backup.fileLinks, attachments: backup.attachments
        };
        download(JSON.stringify(payload, null, 2), 'notes-vault-backup-' + toLocalDateStr(new Date()) + '.json', 'application/json');
    }
    // The raw notes + their version history + file-link metadata (all three IndexedDB stores),
    // flushed and ready to embed in any backup file — used both by this module's own Export
    // button and by the app-wide "Data Management" full backup, which otherwise only ever sees
    // localStorage and would silently miss the vault entirely.
    //   · notes      — every live and trashed note, verbatim.
    //   · revisions  — every stored version of every note (up to REV_KEEP/REV_KEEP_BIG each).
    //     Without this, a restore looks complete (the note is there) but its whole edit
    //     history is gone — a loss you only discover the day you actually need to roll back.
    //   · fileLinks  — NOT the raw IndexedDB records: a FileSystemFileHandle can't survive
    //     JSON (it's a live, structured-clone-only browser object), so trying to serialize it
    //     would just produce "{}" silently. Only what's actually useful to restore — the file's
    //     name and when it was linked — is kept; restoreFileLinksList turns that into a
    //     "needs relinking" hint rather than a fake, broken link.
    //   · attachments — every stored image Blob, base64-encoded. Without this, a note's
    //     Markdown (`attachment://att_xxx`) survives a restore but the picture itself doesn't —
    //     looks like a complete backup, renders as a broken image the day you actually restore
    //     it on a fresh browser/device. Every attachment currently in the store is included
    //     (not just ones a live note references), so an image only pictured in an older
    //     revision is preserved too.
    async function getBackupData() {
        await flushSave();
        const notes = await dbGetAll();
        const revisions = await dbGetAllRevisions().catch((e) => { console.warn('Notes Vault: could not back up version history', e); return []; });
        const rawLinks = await dbGetAllLinks().catch((e) => { console.warn('Notes Vault: could not back up file links', e); return []; });
        const fileLinks = rawLinks.map((r) => ({ noteId: r.id, name: r.name || '', linkedAt: r.linkedAt || 0 }));
        const attRecs = await dbGetAllAttachments().catch((e) => { console.warn('Notes Vault: could not back up attachments', e); return []; });
        const attachments = [];
        for (const rec of attRecs) {
            try {
                attachments.push({
                    id: rec.id, hash: rec.hash, mime: rec.mime, size: rec.size,
                    width: rec.width, height: rec.height, filename: rec.filename, createdAt: rec.createdAt,
                    dataB64: await blobToBase64(rec.blob)
                });
            } catch (e) { console.warn('Notes Vault: could not back up an attachment', rec.id, e); }
        }
        try { localStorage.setItem('nvLastBackup', String(Date.now())); } catch (e) { /* ignore */ }
        return { schema: BACKUP_SCHEMA, notes, revisions, fileLinks, attachments };
    }
    /* ───────── Split checklist into sub-notes ─────────
       Every unchecked top-level "- [ ] item" of the open note can become its own sub-note (same folder and tags,
       parent set to this note, so the Map draws it right away). Optionally the line becomes "- [ ] [[item]]",
       but only when the line is plain text, so nothing you wrote is lost. Items that already are a sub-note
       of this note (same title) are skipped, so running it twice never duplicates. */
    function splitClean(t) {
        return String(t || '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => b || a)
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`|\*|~~/g, '').replace(/\s+/g, ' ').trim();
    }
    const splitTitle = (t) => splitClean(t).replace(/[\[\]|]/g, '').trim().slice(0, 120).trim();
    function splitItems(md, parent) {
        const lines = String(md || '').split('\n'), live = mapLive(), have = new Set(mapKids(parent, live).map((k) => fold(mapTitle(k))));
        const out = []; let inFence = false;
        lines.forEach((line, i) => {
            if (/^\s*(`{3,}|~{3,})/.test(line)) { inFence = !inFence; return; }
            if (inFence) return;
            const m = TASK_RE.exec(line);
            if (!m || m[2] !== ' ' || /^\s*/.exec(m[1])[0].length > 1) return;   // unchecked, top-level only
            const raw = line.slice(m[1].length + 3).replace(/\r$/, '').trim();
            if (!raw || /^\[\[[^\]]+\]\]$/.test(raw)) return;                  // empty, or already a link
            const title = splitTitle(raw);
            if (!title) return;
            out.push({ i, line, prefix: m[1], raw, title, plain: raw === title, dup: have.has(fold(title)) });
        });
        return out;
    }
    function splitClose() {
        const p = document.getElementById('nvSplitPanel');
        if (p) { p.remove(); document.removeEventListener('keydown', splitKey, true); }
    }
    function splitKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); splitClose(); } }
    async function splitOpen() {
        const parent = S.note;
        if (!parent) return;
        if (S.viewRev) { toast('Leave the version preview first.'); return; }
        if (!parent.title.trim()) { toast('Give this note a title first — the sub-notes link back to it.'); return; }
        await flushSave();
        const items = splitItems(parent.markdown, parent).slice(0, 100);
        splitClose();
        const rows = items.map((it, k) => '<li class="nvrem-row nvsp-row"><input type="checkbox" data-k="' + k + '"' + (it.dup ? ' disabled' : ' checked') + ' aria-label="Include">'
            + '<input type="text" class="nvsp-t" data-k="' + k + '" maxlength="120" value="' + esc(it.title) + '"' + (it.dup ? ' disabled' : '') + '>'
            + (it.dup ? '<span class="nvrem-m">already a sub-note</span>' : '') + '</li>').join('');
        const p = document.createElement('div');
        p.id = 'nvSplitPanel';
        p.className = 'nvrem-panel';
        p.innerHTML = '<div class="nvrem-box" role="dialog" aria-modal="true" aria-label="Split checklist into sub-notes">'
            + '<div class="nvrem-hd"><i class="fa-solid fa-list-check" aria-hidden="true"></i> Split checklist<button type="button" class="nvrem-x" data-a="close" aria-label="Close">&times;</button></div>'
            + '<div class="nvrem-body">' + (items.length
                ? '<p class="nvsp-hint">Each ticked item becomes a sub-note of “' + esc(parent.title.trim()) + '”. You can rename them here first.</p><ul class="nvrem-list">' + rows + '</ul>'
                  + '<label class="nvsp-opt"><input type="checkbox" id="nvSplitLink" checked> Turn the checklist lines into links to the new sub-notes</label>'
                : '<div class="nvrem-empty">No unchecked checklist items found.<br>Write them like “- [ ] Do the thing”.</div>') + '</div>'
            + '<div class="nvsp-ft"><button type="button" data-a="close">Cancel</button>' + (items.length ? '<button type="button" class="nvsp-go" data-a="go" id="nvSplitGo">Create sub-notes</button>' : '') + '</div></div>';
        p.addEventListener('click', (ev) => {
            if (ev.target === p) { splitClose(); return; }
            const b = ev.target.closest('[data-a]');
            if (!b) return;
            if (b.getAttribute('data-a') === 'close') splitClose();
            else if (b.getAttribute('data-a') === 'go') splitRun(parent, items, p);
        });
        p.addEventListener('change', (ev) => {
            const cb = ev.target.closest('input[type="checkbox"][data-k]');
            if (!cb) return;
            const t = p.querySelector('.nvsp-t[data-k="' + cb.getAttribute('data-k') + '"]');
            if (t) t.disabled = !cb.checked;
            const n = p.querySelectorAll('input[type="checkbox"][data-k]:checked').length, go = p.querySelector('#nvSplitGo');
            if (go) { go.disabled = !n; go.textContent = n ? 'Create ' + n + ' sub-note' + (n > 1 ? 's' : '') : 'Create sub-notes'; }
        });
        document.body.appendChild(p);
        document.addEventListener('keydown', splitKey, true);
        const go = p.querySelector('#nvSplitGo');
        if (go) { const n = items.filter((x) => !x.dup).length; go.disabled = !n; go.textContent = n ? 'Create ' + n + ' sub-note' + (n > 1 ? 's' : '') : 'Create sub-notes'; go.focus(); }
        else { const x = p.querySelector('.nvrem-x'); if (x) x.focus(); }
    }
    async function splitRun(parent, items, panel) {
        const link = !!(panel.querySelector('#nvSplitLink') || {}).checked;
        const picked = [];
        panel.querySelectorAll('input[type="checkbox"][data-k]:checked').forEach((cb) => {
            const k = +cb.getAttribute('data-k'), t = panel.querySelector('.nvsp-t[data-k="' + k + '"]');
            const title = splitTitle(t ? t.value : items[k].title);
            if (title) picked.push({ it: items[k], title, edited: title !== items[k].title });
        });
        splitClose();
        if (!picked.length) return;
        const parentTitle = parent.title.trim();
        const now = Date.now();
        const taken = new Set(mapLive().map((n) => fold(mapTitle(n))));   // titles already in the vault, so a new link never points at two notes
        const have = new Set(mapKids(mapRel(parent), mapLive()).map((k) => fold(mapTitle(k))));
        let order = mapNextOrder(parent), made = 0, skipped = 0, failed = 0;
        const linkable = [];
        for (let k = 0; k < picked.length; k++) {
            const { it, title, edited } = picked[k];
            const f = fold(title);
            if (have.has(f)) { skipped++; continue; }
            const clash = taken.has(f);
            const note = normalizeNote({
                id: uid(), title, markdown: 'Part of [[' + parentTitle + ']]\n', type: parent.type, tags: (parent.tags || []).slice(),
                pinned: false, createdAt: now + k, updatedAt: now + k
            });
            note.mapParent = parent.id; note.mapOrder = order++; note.mapLinks = [];
            try { await dbPut(note); } catch (e) { console.error('Notes Vault: could not create a sub-note', e); failed++; continue; }
            S.notes.push(note);
            have.add(f); taken.add(f); made++;
            if (link && !clash && !edited && it.plain && /^[^\[\]|#^]+$/.test(title)) linkable.push(it);
        }
        if (linkable.length) {
            const lines = parent.markdown.split('\n'), used = new Set();
            linkable.forEach((it) => {
                let j = lines[it.i] === it.line && !used.has(it.i) ? it.i : lines.findIndex((l, x) => l === it.line && !used.has(x));
                if (j < 0) return;
                used.add(j);
                lines[j] = it.prefix + '[ ] [[' + it.title + ']]' + (it.line.endsWith('\r') ? '\r' : '');
            });
            const md = lines.join('\n');
            if (md !== parent.markdown) {
                parent.markdown = md;
                if (S.note === parent) { el.src.value = md; markDirty(); await flushSave(); }
                else { try { await dbPut(parent); } catch (e) { console.warn('Notes Vault: could not link the checklist', e); } }
            }
        }
        renderSide(); renderLibrary();
        if (S.note) mapChanged();
        if (!made && !failed) { toast('Nothing new to create — those are already sub-notes.'); return; }
        toast('Created ' + made + ' sub-note' + (made === 1 ? '' : 's') + ' under \u201C' + parentTitle + '\u201D'
            + (skipped ? ' \u00B7 ' + skipped + ' skipped' : '') + (failed ? ' \u00B7 ' + failed + ' failed' : ''),
            'View Map', () => { const b = document.getElementById('nvMapBtn'); if (b) b.click(); });
    }

    /* ───────── Reminders: "Remind me at…" on a note ─────────
       note.remindAt is local time ('YYYY-MM-DDTHH:MM'); note.remindState is 'fired' once it went off and
       is still waiting for you. A small mirror in localStorage (nvRemIdx) lets a 30-second timer check
       without reading every note, and it runs even while the Vault is closed. It only works while this
       app is open in a browser tab — there is no background push. */
    const REM_KEY = 'nvRemIdx', REM_TICK = 30000, REM_NAG_GAP = 4 * 36e5;
    const remHidden = new Set();        // cards you hid with × this session (they stay in Today)
    let remNagPending = false, remTimer = 0, remBusy = false;
    function remLoad() { try { return JSON.parse(localStorage.getItem(REM_KEY) || '{}') || {}; } catch (e) { return {}; } }
    function remSave(idx) { try { localStorage.setItem(REM_KEY, JSON.stringify(idx)); } catch (e) { /* storage blocked */ } try { remBadge(); } catch (e) { /* UI not ready */ } }
    function remParse(at) {
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at || '');
        return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : NaN;
    }
    const remPad = (x) => String(x).padStart(2, '0');
    function remFmtLocal(ms) { const d = new Date(ms); return d.getFullYear() + '-' + remPad(d.getMonth() + 1) + '-' + remPad(d.getDate()) + 'T' + remPad(d.getHours()) + ':' + remPad(d.getMinutes()); }
    function remDay(ms) { return remFmtLocal(ms).slice(0, 10); }
    function remShort(at) {
        const t = remParse(at);
        return isNaN(t) ? '' : new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
    function remTomorrow8() { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.getTime(); }
    function remEntry(n) { return { at: n.remindAt, t: (n.title || '').trim() || 'Untitled', f: n.remindState === 'fired' ? 1 : 0 }; }
    function remIndexNote(n) {
        if (!n || !n.id) return;
        const idx = remLoad();
        if (!n.deletedAt && n.remindAt && !isNaN(remParse(n.remindAt))) idx[n.id] = remEntry(n);
        else delete idx[n.id];
        remSave(idx);
    }
    function remReindexAll(notes) {
        const idx = {};
        (notes || []).forEach((n) => { if (n && !n.deletedAt && n.remindAt && !isNaN(remParse(n.remindAt))) idx[n.id] = remEntry(n); });
        remSave(idx);
    }
    async function remDbGet(id) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const r = db.transaction(STORE).objectStore(STORE).get(id);
            r.onsuccess = () => resolve(r.result || null);
            r.onerror = () => reject(r.error);
        });
    }
    // Prefer the in-memory note (it may carry edits that are not saved yet); fall back to the database.
    async function remGetNote(id) {
        const live = S.notes.find((x) => x.id === id) || S.trash.find((x) => x.id === id);
        if (live) return live;
        try { const raw = await remDbGet(id); return raw ? normalizeNote(raw) : null; } catch (e) { return null; }
    }
    async function remApply(n, patch) {
        Object.assign(n, patch);
        await dbPut(n);
        nvSyncPlannerDeadline(n);   // also refreshes the reminder index and the Today badge
        if (S.note && S.note.id === n.id) { if (el.deadline) el.deadline.value = n.deadline || ''; fillRemind(); renderDocMeta(); }
    }
    function remAskPerm() {
        try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
    function remNotify(id, e) {
        try {
            if (!('Notification' in window) || Notification.permission !== 'granted') return;
            const nt = new Notification('Reminder: ' + e.t, { body: 'Set for ' + remShort(e.at) + ' — click to open the note.', tag: 'nv-rem-' + id });
            nt.onclick = () => { try { window.focus(); } catch (x) { /* ignore */ } remOpen(id); nt.close(); };
        } catch (err) { /* ignore */ }
    }

    // ── field in the Info tab ──
    function fillRemind() {
        if (!el || !el.remind || !S.note) return;
        const n = S.note;
        el.remind.value = n.remindAt || '';
        let t = '';
        if (n.remindAt) {
            t = n.remindState === 'fired' ? 'It went off — still waiting for you in Today.' : 'Alert at ' + remShort(n.remindAt) + '.';
            if ('Notification' in window && Notification.permission === 'denied') t += ' Browser notifications are blocked, so you will only see the card in the app.';
        }
        t += (t ? ' ' : '') + 'Works while this app is open in a tab.';
        if (el.remindHint) el.remindHint.textContent = t;
    }
    function remSet(v) {
        if (!S.note) return;
        S.note.remindAt = v || '';
        S.note.remindState = '';
        if (v) remAskPerm();
        fillRemind();
        renderDocMeta();
        markDirty();
    }
    function remChip(kind) {
        if (!S.note) return;
        if (kind === 'clr') { remSet(''); return; }
        let ms = NaN;
        if (kind === 'h1') ms = Date.now() + 36e5;
        else if (kind === 'tom') ms = remTomorrow8();
        else {
            const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(S.note.deadline || '');
            if (!m) { toast('Set a due date first.'); return; }
            ms = kind === 'due8' ? new Date(+m[1], +m[2] - 1, +m[3], 8, 0).getTime() : new Date(+m[1], +m[2] - 1, +m[3] - 1, 18, 0).getTime();
        }
        if (isNaN(ms) || ms <= Date.now()) { toast('That time has already passed.'); return; }
        remSet(remFmtLocal(ms));
    }

    // ── checker (runs on a timer, also when the Vault is closed) ──
    async function remCheck() {
        if (remBusy) return;
        remBusy = true;
        try {
            const idx = remLoad(), now = Date.now();
            const ids = Object.keys(idx).filter((id) => !idx[id].f && remParse(idx[id].at) <= now);
            const fired = [];
            for (const id of ids) {
                const n = await remGetNote(id);
                if (!n || n.deletedAt || !n.remindAt) { delete idx[id]; continue; }      // note gone / reminder cleared elsewhere
                if (remParse(n.remindAt) > Date.now()) { idx[id] = remEntry(n); continue; }  // time was changed
                n.remindState = 'fired';
                try { await dbPut(n); } catch (e) { console.warn('Notes Vault: could not save reminder state', e); }
                idx[id] = remEntry(n);
                fired.push(id);
            }
            if (ids.length) remSave(idx);
            fired.forEach((id) => remNotify(id, idx[id]));
            if (fired.length) {
                remRenderCards();
                if (S.note && fired.includes(S.note.id)) fillRemind();
            }
        } catch (e) { console.warn('Notes Vault: reminder check failed', e); }
        remBusy = false;
    }

    // ── alert cards (global, not inside the Vault, so they show anywhere in the app) ──
    function remHost() {
        let h = document.getElementById('nvRemHost');
        if (!h) {
            h = document.createElement('div');
            h.id = 'nvRemHost';
            h.setAttribute('aria-live', 'polite');
            h.addEventListener('click', (ev) => {
                const b = ev.target.closest('[data-a]');
                if (!b) return;
                const card = b.closest('[data-id]');
                const id = card && card.getAttribute('data-id');
                const a = b.getAttribute('data-a');
                if (a === 'all') { remOpenPanel(); return; }
                if (!id) return;
                if (a === 'x') { remHidden.add(id); remRenderCards(); }
                else remAction(id, a);
            });
            document.body.appendChild(h);
        }
        return h;
    }
    function remRenderCards() {
        const idx = remLoad(), host = remHost();
        const ids = Object.keys(idx).filter((id) => idx[id].f && !remHidden.has(id)).sort((a, b) => remParse(idx[a].at) - remParse(idx[b].at));
        host.innerHTML = ids.slice(0, 3).map((id) => {
            const e = idx[id], late = Date.now() - remParse(e.at) > 120000;
            return '<div class="nvrem-card" role="status" data-id="' + esc(id) + '">'
                + '<div class="nvrem-ct"><i class="fa-solid fa-bell" aria-hidden="true"></i> Reminder<button type="button" class="nvrem-x" data-a="x" aria-label="Hide for now" title="Hide for now (stays in Today)">&times;</button></div>'
                + '<div class="nvrem-cn">' + esc(e.t) + '</div>'
                + '<div class="nvrem-cm">' + (late ? 'Was set for ' + esc(remShort(e.at)) : 'Now') + '</div>'
                + '<div class="nvrem-ca"><button type="button" data-a="open">Open</button><button type="button" data-a="h1">Snooze 1h</button><button type="button" data-a="tom">Tomorrow</button><button type="button" data-a="done">Done</button></div>'
                + '</div>';
        }).join('') + (ids.length > 3
            ? '<div class="nvrem-card" role="status"><div class="nvrem-cn">+' + (ids.length - 3) + ' more reminders waiting</div><div class="nvrem-ca"><button type="button" data-a="all">View all</button></div></div>' : '');
    }
    // Shared by the cards and the Today panel.
    async function remAction(id, a) {
        const n = await remGetNote(id);
        if (!n) { const idx = remLoad(); delete idx[id]; remSave(idx); remRenderCards(); return; }
        if (a === 'open') { await remOpen(id); return; }
        if (a === 'done') await remApply(n, { remindAt: '', remindState: '', deadline: n.deadline && remDay(Date.now()) >= n.deadline.slice(0, 10) ? '' : n.deadline });
        else if (a === 'h1') await remApply(n, { remindAt: remFmtLocal(Date.now() + 36e5), remindState: '' });
        else if (a === 'tom') await remApply(n, { remindAt: remFmtLocal(remTomorrow8()), remindState: '' });
        remHidden.delete(id);
        remRenderCards();
        if (document.getElementById('nvRemPanel')) remOpenPanel();
        if (S.open) { renderSide(); renderLibrary(); }
    }
    async function remOpen(id) {
        remClosePanel();
        await open();
        await openNote(id);
        const n = S.notes.find((x) => x.id === id);
        // Opening it counts as seeing it: a reminder that already went off is cleared (the due date stays).
        if (n && n.remindAt && remParse(n.remindAt) <= Date.now()) await remApply(n, { remindAt: '', remindState: '' });
        remHidden.delete(id);
        remRenderCards();
    }

    // ── Today panel ──
    function remGather() {
        const now = Date.now(), today = remDay(now), soonEnd = remDay(now + 3 * 864e5);
        const g = { waiting: [], overdue: [], today: [], soon: [], later: [] };
        S.notes.forEach((n) => {
            if (n.deletedAt) return;
            const dl = (n.deadline || '').slice(0, 10), rt = n.remindAt ? remParse(n.remindAt) : NaN, hasR = !isNaN(rt);
            const row = { n, dl, rt: hasR ? rt : NaN };
            if (hasR && (n.remindState === 'fired' || rt <= now)) g.waiting.push(row);
            else if (dl && dl < today) g.overdue.push(row);
            else if (dl === today) g.today.push(row);
            else if (dl && dl <= soonEnd) g.soon.push(row);
            else if (hasR && remDay(rt) === today) g.later.push(row);
        });
        const byDl = (a, b) => (a.dl || '9').localeCompare(b.dl || '9') || (a.rt || 0) - (b.rt || 0);
        g.waiting.sort((a, b) => a.rt - b.rt); g.overdue.sort(byDl); g.today.sort(byDl); g.soon.sort(byDl); g.later.sort((a, b) => a.rt - b.rt);
        return g;
    }
    function remBadge() {
        if (typeof el === 'undefined' || !el || !el.todayBadge) return;
        const g = remGather(), c = g.waiting.length + g.overdue.length + g.today.length;
        el.todayBadge.textContent = c > 99 ? '99+' : String(c);
        el.todayBadge.hidden = !c;
    }
    function remRowHtml(r) {
        const bits = [];
        if (r.dl) bits.push('Due ' + esc(nvFmtDate(r.dl)));
        if (!isNaN(r.rt)) bits.push('Reminder ' + esc(remShort(r.n.remindAt)));
        return '<li class="nvrem-row" data-id="' + esc(r.n.id) + '">'
            + '<button type="button" class="nvrem-open" data-a="open"><span class="nvrem-t">' + esc((r.n.title || '').trim() || 'Untitled') + '</span><span class="nvrem-m">' + bits.join(' · ') + '</span></button>'
            + '<button type="button" class="nvrem-b" data-a="tom" title="Remind me again tomorrow at 08:00">Tomorrow</button>'
            + '<button type="button" class="nvrem-b" data-a="done" title="Clear the reminder (and the due date if it is today or overdue)">Done</button></li>';
    }
    function remClosePanel() {
        const p = document.getElementById('nvRemPanel');
        if (p) { p.remove(); document.removeEventListener('keydown', remPanelKey, true); }
    }
    function remPanelKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); remClosePanel(); } }
    async function remOpenPanel() {
        if (!S.open) await open();
        remClosePanel();
        const g = remGather();
        const sec = (title, rows) => rows.length ? '<div class="nvrem-sec">' + title + ' (' + rows.length + ')</div><ul class="nvrem-list">' + rows.map(remRowHtml).join('') + '</ul>' : '';
        const body = sec('Waiting for you', g.waiting) + sec('Overdue', g.overdue) + sec('Due today', g.today) + sec('Reminders later today', g.later) + sec('Next 3 days', g.soon);
        const p = document.createElement('div');
        p.id = 'nvRemPanel';
        p.className = 'nvrem-panel';
        p.innerHTML = '<div class="nvrem-box" role="dialog" aria-modal="true" aria-label="Today"><div class="nvrem-hd"><i class="fa-solid fa-bell" aria-hidden="true"></i> Today<button type="button" class="nvrem-x" data-a="close" aria-label="Close">&times;</button></div>'
            + '<div class="nvrem-body">' + (body || '<div class="nvrem-empty">Nothing needs your attention today.</div>') + '</div></div>';
        p.addEventListener('click', (ev) => {
            if (ev.target === p) { remClosePanel(); return; }
            const b = ev.target.closest('[data-a]');
            if (!b) return;
            if (b.getAttribute('data-a') === 'close') { remClosePanel(); return; }
            const row = b.closest('[data-id]');
            if (row) remAction(row.getAttribute('data-id'), b.getAttribute('data-a'));
        });
        document.body.appendChild(p);
        document.addEventListener('keydown', remPanelKey, true);
        const x = p.querySelector('.nvrem-x'); if (x) x.focus();
    }
    // On Vault open: rebuild the index from the loaded notes (covers restore/import/merge) and nudge once.
    function remTodayNag() {
        remNagPending = false;
        try {
            remReindexAll(S.notes);
            const g = remGather(), c = g.waiting.length + g.overdue.length + g.today.length;
            if (!c) return;
            const now = Date.now(), last = +localStorage.getItem('nvTodayNagAt') || 0;
            if (now - last < REM_NAG_GAP) return;
            localStorage.setItem('nvTodayNagAt', String(now));
            remNagPending = true;
            setTimeout(() => {
                remNagPending = false;
                if (S.open) toast(c + (c === 1 ? ' note needs' : ' notes need') + ' your attention today', 'View', () => { remOpenPanel(); });
            }, 1500);
        } catch (e) { /* storage blocked */ }
    }
    async function remStart() {
        try { remReindexAll((await dbGetAll()).map(normalizeNote)); } catch (e) { /* database not available */ }
        remRenderCards();       // reminders that went off while the tab was closed come back until you answer them
        await remCheck();
        clearInterval(remTimer);
        remTimer = setInterval(remCheck, REM_TICK);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) remCheck(); });
    }
    setTimeout(remStart, 4000);

    // Weekly nudge: the vault lives only in this browser, so clearing site data would wipe it.
    // Asks at most once a day, only once there are notes, and not on the very first visit.
    function backupNagSoon() {
        try {
            const now = Date.now(), DAY = 864e5, WEEK = 7 * DAY;
            const last = +localStorage.getItem('nvLastBackup') || 0;
            let base = last || +localStorage.getItem('nvBackupBase') || 0;
            if (!base) { localStorage.setItem('nvBackupBase', String(now)); return; }   // start counting from now
            const nagAt = +localStorage.getItem('nvBackupNagAt') || 0;
            if (!S.notes.length || now - base < WEEK || now - nagAt < DAY) return;
            localStorage.setItem('nvBackupNagAt', String(now));
            const days = Math.floor((now - base) / DAY);
            setTimeout(() => toast((last ? 'Last backup was ' + days + ' days ago' : 'No backup yet (' + days + ' days of notes)') + ' \u2014 export one now?',
                'Export backup', () => { exportAllJson().catch(() => toast('Backup failed \u2014 try Export backup (JSON) from the menu.')); }), remNagPending ? 11000 : 1500);
        } catch (e) { /* storage blocked: skip the reminder */ }
    }
    // Same merge rule either way: a note already here newer than the one in the backup wins,
    // so importing an old file can never clobber more recent edits.
    async function restoreNotesList(list, opts = {}) {
        if (!Array.isArray(list) || !list.length) return { added: 0, updated: 0, skipped: 0 };
        await flushSave();
        let known;
        try { known = (await dbGetAll()).map(normalizeNote); }
        catch (e) { known = S.notes.concat(S.trash); }
        const existing = new Map(known.map((n) => [n.id, n]));
        let added = 0, updated = 0, skipped = 0;
        for (const raw of list) {
            if (!raw || typeof raw.markdown !== 'string') continue;
            const inc = normalizeNote({
                id: raw.id || uid(), title: raw.title, markdown: raw.markdown, type: raw.type,
                tags: raw.tags, pinned: raw.pinned, createdAt: raw.createdAt, updatedAt: raw.updatedAt, deletedAt: raw.deletedAt,
                // These ride along on the note record itself, so a backup that only kept the
                // fields above would quietly un-link every note from its skill/course/resource/
                // analysis/deal/deadline on restore — same "looks fine, data's actually gone"
                // shape as the revisions/fileLinks gap above. (normalizeNote rebuilds n.links
                // from these legacy fields, so restoring the legacy fields is all that's needed.)
                linkedCareer: raw.linkedCareer, linkedSkill: raw.linkedSkill,
                course: raw.course, deadline: raw.deadline, remindAt: raw.remindAt, remindState: raw.remindState, linkedCourseId: raw.linkedCourseId,
                resource: raw.resource, linkedResourceId: raw.linkedResourceId,
                analysis: raw.analysis, linkedAnalysisId: raw.linkedAnalysisId,
                deal: raw.deal, linkedDealId: raw.linkedDealId,
                // Map relations ride on the note record too — without these a restore would drop every parent / connection.
                mapParent: raw.mapParent, mapOrder: raw.mapOrder, mapLinks: raw.mapLinks
            });
            const ex = existing.get(inc.id);
            if (ex && ex.updatedAt > inc.updatedAt) { skipped++; continue; }   // never overwrite a newer note with an older backup
            await dbPut(inc);
            // A restored note is written straight to IndexedDB (dbPut), bypassing flushSave —
            // which is normally what calls syncAttachmentRefs. Do it here too, or a restored
            // note's images stay untracked as "in use" until the note happens to be opened and
            // edited, and could get swept up by "Clean up unused attachments" in the meantime.
            // Awaited (not fire-and-forget): restoreNotesList can restore many notes in a row,
            // and a backup with lots of images made this a real race — without the await, the
            // ref index could still be mid-write for an earlier note when the import finished
            // and the UI reported done. Awaiting means the index is guaranteed consistent by the
            // time this function's promise resolves.
            try { await syncAttachmentRefs(inc.id, inc.markdown); } catch (e) { console.warn('Notes Vault: attachment ref sync failed', e); }
            if (ex) updated++; else added++;
        }
        if (!opts.silent) {
            await loadAll();
            if (S.note) { const again = S.notes.find((n) => n.id === S.note.id); if (again) S.note = again; }
            renderAll();
            updateStorage();
        }
        return { added, updated, skipped };
    }
    // Merges backed-up versions in by id, skipping any already present (a version's id never
    // changes, so this makes restoring the same backup twice a safe no-op rather than a pile of
    // duplicates). revLast is cleared since a note's "newest known version" pointer may now be
    // stale if the backup carried something more recent than what this browser had cached.
    async function restoreRevisionsList(list) {
        if (!Array.isArray(list) || !list.length) return { added: 0 };
        let existingIds;
        try { existingIds = new Set((await dbGetAllRevisions()).map((r) => r.id)); }
        catch (e) { console.warn('Notes Vault: could not read existing version history', e); return { added: 0 }; }
        let added = 0;
        for (const raw of list) {
            if (!raw || !raw.id || !raw.noteId || typeof raw.markdown !== 'string') continue;
            if (existingIds.has(raw.id)) continue;
            const rec = {
                id: raw.id, noteId: raw.noteId, savedAt: +raw.savedAt || Date.now(),
                title: raw.title || '', markdown: raw.markdown,
                words: +raw.words || 0, chars: +raw.chars || raw.markdown.length, sig: raw.sig || '', label: raw.label || ''
            };
            try { await revPut(rec); added++; await addRevisionAttachmentRefs(rec.id, rec.markdown); } catch (e) { console.warn('Notes Vault: could not restore a version', e); }
        }
        revLast.clear();
        return { added };
    }
    // A restored file link can never carry a real handle (see getBackupData), so this only ever
    // sets a "needs relinking" hint — never touches the real fileLinks store — and only for
    // notes that don't already have a working link here (a link made on THIS device since the
    // backup was taken is more current than the backup, and stays untouched).
    async function restoreFileLinksList(list) {
        if (!Array.isArray(list) || !list.length) return { added: 0 };
        let added = 0;
        for (const raw of list) {
            if (!raw || !raw.noteId) continue;
            if (S.fileLinks.has(raw.noteId)) continue;
            setPendingRelink(raw.noteId, raw.name, raw.linkedAt);
            added++;
        }
        return { added };
    }
    // Restores attachments embedded in a backup (see getBackupData). Content-addressed by id
    // (which is derived from the image's hash), so a blob already present locally — the common
    // case when re-importing your own backup, or restoring onto a device that already has some
    // of the same screenshots — is left alone rather than re-written. Doesn't touch
    // attachmentRefs itself: restoreNotesList/restoreRevisionsList register the "in use" refs
    // once the notes/revisions that point at these ids are restored.
    async function restoreAttachmentsList(list) {
        if (!Array.isArray(list) || !list.length) return { added: 0 };
        let added = 0;
        for (const raw of list) {
            if (!raw || !raw.id || !raw.dataB64) continue;
            try {
                const existing = await dbGetAttachment(raw.id);
                if (existing) continue;
                const blob = base64ToBlob(raw.dataB64, raw.mime);
                const rec = {
                    id: raw.id, hash: raw.hash || raw.id, blob, mime: raw.mime || blob.type,
                    size: +raw.size || blob.size, width: +raw.width || 0, height: +raw.height || 0,
                    filename: raw.filename || undefined, createdAt: +raw.createdAt || Date.now()
                };
                await dbPutAttachment(rec);
                S.attachmentCache.set(rec.id, rec);
                added++;
            } catch (e) { console.warn('Notes Vault: could not restore an attachment', raw && raw.id, e); }
        }
        return { added };
    }
    // Entry point for the app-wide "Data Management" import: a full backup JSON carries a
    // notesVault field alongside the localStorage dump; that page reloads right after restoring,
    // so there is no UI here worth refreshing — just get everything into IndexedDB/localStorage.
    async function restoreFromBackup(payload) {
        try { await restoreAttachmentsList(payload && payload.attachments); } catch (e) { console.warn('Notes Vault: attachment restore skipped', e); }
        const list = payload && Array.isArray(payload.notes) ? payload.notes : [];
        const result = await restoreNotesList(list, { silent: true });
        try { await restoreRevisionsList(payload && payload.revisions); } catch (e) { console.warn('Notes Vault: version history restore skipped', e); }
        try { await restoreFileLinksList(payload && payload.fileLinks); } catch (e) { console.warn('Notes Vault: file link restore skipped', e); }
        return result;
    }
    /* Import PDF as a note. Text PDFs: the selectable text is read with pdf.js (loaded lazily on
       first use). Pages with no selectable text (scans, photos) are offered OCR with Tesseract.js
       (Vietnamese + English; loaded lazily, downloads language data on first use, runs in the
       browser — nothing is uploaded). The original PDF is also attached at the top of the note,
       so Read mode shows the viewer above the extracted text. OCR is never automatic: it's slow
       and imperfect, so it asks first. */
    // Pinned exact versions (current releases): pdf.js 6.3.289 and Tesseract.js 7.0.0 — Tesseract 7 is
    // ~15–35% faster than 6. pdf.js 4+ ships as ES modules only (no global <script> build), so it is
    // loaded with a dynamic import(); browsers too old for the modern build get pdf.js's "legacy" build.
    const PDFJS_VER = '6.3.289';
    const TESS_VER = '7.0.0';
    let pdfJsPromise = null, tessPromise = null;
    function loadScriptOnce(src) {
        return new Promise((resolve, reject) => {
            const sc = document.createElement('script');
            sc.src = src; sc.async = true;
            sc.onload = resolve;
            sc.onerror = () => { sc.remove(); reject(new Error('Couldn\u2019t load ' + src.split('/').slice(-1)[0] + ' (offline?)')); };
            document.head.appendChild(sc);
        });
    }
    function loadPdfJs() {
        if (!pdfJsPromise) pdfJsPromise = (async () => {
            const modern = typeof Promise.withResolvers === 'function' && typeof Array.prototype.at === 'function' && typeof structuredClone === 'function';
            const base = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VER + (modern ? '' : '/legacy') + '/build/';
            const lib = await import(base + 'pdf.min.mjs');
            // A worker can't be started straight from another origin, so wrap it in a same-origin blob URL.
            const code = await (await fetch(base + 'pdf.worker.min.mjs')).text();
            lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
            return lib;
        })().catch((e) => { pdfJsPromise = null; throw e; });
        return pdfJsPromise;
    }
    function loadTesseract() {
        if (window.Tesseract) return Promise.resolve(window.Tesseract);
        if (!tessPromise) tessPromise = loadScriptOnce('https://cdn.jsdelivr.net/npm/tesseract.js@' + TESS_VER + '/dist/tesseract.min.js')
            .then(() => window.Tesseract).catch((e) => { tessPromise = null; throw e; });
        return tessPromise;
    }
    const mdEscapePara = (t) => t.replace(/</g, '\\<').replace(/^(\s*)([#>*+\-]|\d+[.)])(?=\s)/, '$1\\$2');
    // pdf.js text items → paragraphs: items on one baseline form a line; lines close together
    // join into one paragraph (so wrapped lines don't become hard breaks), a bigger gap starts a new one.
    async function pdfPageText(page) {
        const tc = await page.getTextContent();
        const lines = []; let cur = null;
        for (const it of tc.items) {
            if (typeof it.str !== 'string') continue;
            const y = it.transform[5], h = Math.abs(it.height) || Math.abs(it.transform[3]) || 10;
            if (!cur || Math.abs(y - cur.y) > h * 0.5) { if (cur) lines.push(cur); cur = { y, h, t: '' }; }
            cur.t += it.str;
            if (it.hasEOL) { lines.push(cur); cur = null; }
        }
        if (cur) lines.push(cur);
        const paras = []; let prev = null;
        for (const l of lines) {
            const t = l.t.replace(/\s+/g, ' ').trim();
            if (!t) continue;
            if (!prev || Math.abs(prev.y - l.y) > prev.h * 1.9) paras.push(t);
            else paras[paras.length - 1] += ' ' + t;
            prev = l;
        }
        return paras.map(mdEscapePara).join('\n\n');
    }
    /* OCR is never presented as truth. Every OCR'd page is written into the note as a ⚠ warning
       box (clearly different from plain, native-text pages) with a confidence score and a list of
       what to double-check — numbers, decimal points, %, currency symbols, table-like layouts.
       Individual numbers Tesseract is unsure about (<80%) are highlighted inline, because one
       misread digit ("1.05%" → "10.5%" → "105%") can wreck a whole analysis. A summary box at the
       top of the note says how many pages were native text vs OCR. */
    const OCR_LOW_WORD = 80;
    const escOcrWord = (w) => w.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/([\\`*_~\[\]])/g, '\\$1');
    function ocrPageToMarkdown(pageNo, data) {
        const paras = [], wordConf = [];
        let nums = 0, decimals = 0, pcts = 0, cur = 0, lowNums = 0, numericLines = 0, tableHint = false;
        const startEsc = (t) => t.replace(/^(\s*)([#>*+\-]|\d+[.)])(?=\s)/, '$1\\$2');
        const flagWord = (w) => {
            const raw = String(w.text || '').trim();
            if (!raw) return '';
            const esc = escOcrWord(raw);
            if (/%/.test(raw)) pcts++;
            if (/[$€£¥₫]|^(?:VND|VNĐ|USD|EUR|đ|vnd)$/i.test(raw)) cur++;
            if (/\d/.test(raw)) {
                nums++;
                if (/\d[.,]\d/.test(raw)) decimals++;
                if (typeof w.confidence === 'number' && w.confidence < OCR_LOW_WORD) {
                    lowNums++;
                    return '<mark title="OCR confidence ' + Math.round(w.confidence) + '% \u2014 verify against the PDF">' + esc + '</mark>';
                }
            }
            return esc;
        };
        if (Array.isArray(data.blocks)) {
            for (const b of data.blocks) {
                if (/TABLE/i.test(b.blocktype || '')) tableHint = true;
                for (const p of b.paragraphs || []) {
                    const lineTxt = [];
                    for (const l of p.lines || []) {
                        let numericInLine = 0;
                        const ws = (l.words || []).map((w) => {
                            if (/\d/.test(w.text || '')) numericInLine++;
                            if (typeof w.confidence === 'number') wordConf.push(w.confidence);
                            return flagWord(w);
                        }).filter(Boolean);
                        if (numericInLine >= 3) numericLines++;
                        if (ws.length) lineTxt.push(ws.join(' '));
                    }
                    const t = lineTxt.join(' ').trim();
                    if (t) paras.push(startEsc(t));
                }
            }
        } else {
            // No word-level data available: keep the text, still flag what we can by pattern.
            (data.text || '').split(/\n\s*\n/).map((q) => q.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).forEach((q) => {
                nums += (q.match(/\d+/g) || []).length; decimals += (q.match(/\d[.,]\d/g) || []).length;
                pcts += (q.match(/%/g) || []).length; cur += (q.match(/[$€£¥₫]/g) || []).length;
                paras.push(mdEscapePara(q));
            });
        }
        if (!paras.length) return { md: '', page: pageNo, conf: 0 };
        if (numericLines >= 3) tableHint = true;
        let conf = typeof data.confidence === 'number' ? data.confidence : (wordConf.length ? wordConf.reduce((a, c) => a + c, 0) / wordConf.length : 0);
        conf = Math.max(0, Math.min(100, Math.round(conf)));
        const filled = Math.round(conf / 10), bar = '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
        const level = conf >= 90 ? 'good' : conf >= 75 ? 'fair' : 'LOW';
        const issues = [];
        if (nums) issues.push('numbers (' + nums + ')');
        if (decimals) issues.push('decimal points / separators (' + decimals + ')');
        if (pcts) issues.push('% values (' + pcts + ')');
        if (cur) issues.push('currency symbols (' + cur + ')');
        if (tableHint) issues.push('table-like layout');
        const lines = ['[!warning] OCR text \u2014 page ' + pageNo + ' \u00b7 ' + level + ' confidence ' + conf + '%',
            '`' + bar + '` ' + conf + '% \u2014 accuracy may be imperfect. Verify against the original PDF.'];
        if (issues.length) lines.push('\u26a0 Potential issues: ' + issues.join(' \u00b7 '));
        if (lowNums) lines.push('\u26a0 ' + lowNums + ' low-confidence number' + (lowNums === 1 ? '' : 's') + ' highlighted in the text below.');
        if (decimals || pcts || cur) lines.push('A misread decimal point changes a value 10\u00d7 or 100\u00d7 (1.05% vs 10.5% vs 105%).');
        lines.push('');
        paras.forEach((t, k) => { if (k) lines.push(''); lines.push(t); });
        return { md: lines.map((l) => (l === '' ? '>' : '> ' + l)).join('\n'), page: pageNo, conf, lowNums, issues };
    }
    function pdfImportSummary(total, nativeCount, ocrStats, skipped) {
        const lines = ['[!info] PDF import \u2014 ' + (ocrStats.length ? 'native text + OCR' : 'native text only')];
        if (nativeCount) lines.push('**Native text:** ' + nativeCount + ' of ' + total + ' page' + (total === 1 ? '' : 's') + ', extracted from the PDF itself (exact).');
        if (ocrStats.length) {
            const avg = Math.round(ocrStats.reduce((a, o) => a + o.conf, 0) / ocrStats.length);
            lines.push('**OCR text:** ' + ocrStats.length + ' page' + (ocrStats.length === 1 ? '' : 's') + ' read from images, average confidence ' + avg + '%. They appear in \u26a0 warning boxes.');
            lines.push('OCR can misread digits, decimal points, % and currency symbols \u2014 check every figure against the attached original.');
        }
        if (skipped.length) lines.push('**Skipped:** ' + skipped.length + ' page' + (skipped.length === 1 ? '' : 's') + ' with no text (' + skipped.slice(0, 10).join(', ') + (skipped.length > 10 ? ', \u2026' : '') + ').');
        return lines.map((l) => '> ' + l).join('\n') + '\n\n';
    }
    /* Clear OCR prompt for scanned PDF pages (replaces the browser's plain confirm box).
       Resolves { action: 'ocr' | 'skip' | 'cancel', lang }. Esc = cancel; clicking the dimmed
       background does nothing, so a stray click can't start (or abort) a long job. */
    function askOcrModal({ fileName, total, blank }) {
        return new Promise((resolve) => {
            if (!document.getElementById('nvOcrStyle')) {
                const st = document.createElement('style');
                st.id = 'nvOcrStyle';
                st.textContent = `
                .nv-ocr-scrim { position: fixed; inset: 0; z-index: 100000; background: rgba(40,20,32,.5); display: flex; align-items: center; justify-content: center; padding: 16px; }
                .nv-ocr { width: min(100%, 520px); max-height: 92vh; overflow-y: auto; background: var(--bg-white, #fff); color: var(--text-dark, #222); border: 1px solid var(--border-color, #ddd);
                    border-radius: 16px; box-shadow: 0 28px 70px -20px rgba(74,50,64,.55); font-family: var(--nv-sans, system-ui, sans-serif); }
                .nv-ocr-head { display: flex; gap: 12px; align-items: flex-start; padding: 18px 20px 12px; }
                .nv-ocr-ico { width: 38px; height: 38px; flex: none; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: var(--bg-light, #f5f5f5); color: var(--primary, #db2777); font-size: 1.1rem; }
                .nv-ocr-title { margin: 0; font-size: 1.05rem; font-weight: 700; line-height: 1.3; }
                .nv-ocr-file { margin: 2px 0 0; font-size: .82rem; color: var(--text-muted, #666); word-break: break-word; }
                .nv-ocr-body { padding: 0 20px 6px; font-size: .9rem; line-height: 1.55; }
                .nv-ocr-pages { margin: 10px 0; padding: 10px 12px; border-radius: 10px; background: var(--bg-light, #f5f5f5); border: 1px solid var(--border-color, #ddd); }
                .nv-ocr-pages b { color: var(--primary, #db2777); }
                .nv-ocr-list { margin: 8px 0 0; padding-left: 18px; font-size: .84rem; color: var(--text-muted, #666); }
                .nv-ocr-list li { margin: 2px 0; }
                .nv-ocr-lbl { display: block; margin: 12px 0 4px; font-size: .8rem; font-weight: 600; }
                .nv-ocr-sel { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-color, #ccc); background: var(--bg-white, #fff); color: inherit; font: inherit; }
                .nv-ocr-foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 14px 20px 18px; }
                .nv-ocr-foot .nv-btn { padding: 8px 14px; }`;
                document.head.appendChild(st);
            }
            // 54,55,56,60 → "54–56, 60"
            const ranges = []; let a = blank[0], b = blank[0];
            for (let i = 1; i <= blank.length; i++) {
                if (blank[i] === b + 1) { b = blank[i]; continue; }
                ranges.push(a === b ? String(a) : a + '\u2013' + b);
                a = b = blank[i];
            }
            const shown = ranges.length > 12 ? ranges.slice(0, 12).join(', ') + ', \u2026 (+' + (ranges.length - 12) + ' more)' : ranges.join(', ');
            const n = blank.length;
            const scrim = document.createElement('div');
            scrim.className = 'nv-ocr-scrim';
            scrim.innerHTML = `
              <div class="nv-ocr" role="dialog" aria-modal="true" aria-labelledby="nvOcrTitle">
                <div class="nv-ocr-head">
                  <div class="nv-ocr-ico"><i class="fa-solid fa-file-image" aria-hidden="true"></i></div>
                  <div><h3 class="nv-ocr-title" id="nvOcrTitle">Some pages have no selectable text</h3><p class="nv-ocr-file"></p></div>
                </div>
                <div class="nv-ocr-body">
                  <div class="nv-ocr-pages"><b>${n} of ${total}</b> page${total === 1 ? '' : 's'} look scanned or image-only: <span class="nv-ocr-pg"></span></div>
                  <div>OCR (optical character recognition) can read the text from those pages as images:</div>
                  <ul class="nv-ocr-list">
                    <li>Runs <b>in your browser</b> with Tesseract.js \u2014 nothing is uploaded.</li>
                    <li>The first time it downloads language data (a few MB to ~20 MB).</li>
                    <li>Roughly 5\u201320 seconds per page, so about <b>${Math.max(1, Math.round(n * 12 / 60))} min</b> for ${n} page${n === 1 ? '' : 's'}.</li>
                    <li>OCR is <b>not exact</b>: pages appear in a <b>⚠ warning box</b> with a confidence score, and numbers, decimals, %, currency and table-like text are flagged for you to verify.</li>
                  </ul>
                  <label class="nv-ocr-lbl" for="nvOcrLang">OCR language</label>
                  <select class="nv-ocr-sel" id="nvOcrLang">
                    <option value="vie">Vietnamese only (best for Vietnamese documents)</option>
                    <option value="vie+eng">Vietnamese + English (mixed documents)</option>
                    <option value="eng">English only (faster, best for English text)</option>
                  </select>
                </div>
                <div class="nv-ocr-foot">
                  <button type="button" class="nv-btn nv-btn-ghost" data-a="cancel">Cancel import</button>
                  <button type="button" class="nv-btn" data-a="skip">Skip \u2014 import text only</button>
                  <button type="button" class="nv-btn nv-btn-primary" data-a="ocr"><i class="fa-solid fa-wand-magic-sparkles"></i> Run OCR on ${n} page${n === 1 ? '' : 's'}</button>
                </div>
              </div>`;
            scrim.querySelector('.nv-ocr-file').textContent = fileName;
            scrim.querySelector('.nv-ocr-pg').textContent = (n === 1 ? 'page ' : 'pages ') + shown;
            const prevFocus = document.activeElement;
            const finish = (action) => {
                const lang = scrim.querySelector('#nvOcrLang').value;
                document.removeEventListener('keydown', onKey, true);
                scrim.remove();
                if (prevFocus && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
                resolve({ action, lang });
            };
            const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('cancel'); } };
            scrim.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) finish(b.dataset.a); });
            document.addEventListener('keydown', onKey, true);
            (document.getElementById('nvApp') || document.body).appendChild(scrim);
            scrim.querySelector('[data-a="ocr"]').focus();
        });
    }
    /* ── OCR pipeline v2 ─────────────────────────────────────────────────────────────────────────
       Why: the old pipeline rendered scans at ~180 DPI and left Tesseract.js on its own PSM default.
       Now: (1) render at 300 DPI, (2) set PSM / DPI / interword spaces EXPLICITLY on every call,
       (3) score the result (confidence, implausible tokens, missing Vietnamese diacritics) and ONLY if
       it is below OCR_GOOD re-read a cleaned copy (deskew + contrast stretch + adaptive threshold)
       and keep whichever read scores higher, (4) table/form pages are rebuilt as a grid instead of
       being flattened into prose. Preprocessing never runs on pages that already read well. ────── */
    /*OCR2-PURE-START*/
    const OCR_DPI = 300, OCR_MAX_SIDE = 4600, OCR_GOOD = 85;
    const VI_VOWEL = /[aeiouyàáạảãâấầậẩẫăắằặẳẵèéẹẻẽêếềệểễìíịỉĩòóọỏõôốồộổỗơớờợởỡùúụủũưứừựửữỳýỵỷỹ]/i;
    const VI_DIAC = /[àáạảãâấầậẩẫăắằặẳẵèéẹẻẽêếềệểễìíịỉĩòóọỏõôốồộổỗơớờợởỡùúụủũưứừựửữỳýỵỷỹđ]/i;
    const ocrScaleFor = (wPt, hPt) => Math.min(OCR_DPI / 72, OCR_MAX_SIDE / Math.max(wPt, hPt));
    function ocrWords(data) {
        const out = [];
        for (const b of (data && data.blocks) || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || [])
            if (w && String(w.text || '').trim()) out.push(w);
        return out;
    }
    // 0-100: 60% mean word confidence, 25% share of implausible tokens, 15% Vietnamese diacritic density.
    function ocrQuality(data, lang) {
        const ws = ocrWords(data);
        if (!ws.length) return { score: 0, conf: 0, bad: 1, dia: 0, n: 0 };
        let sum = 0, bad = 0, dia = 0, alpha = 0;
        for (const w of ws) {
            const t = String(w.text).trim(); sum += typeof w.confidence === 'number' ? w.confidence : 70;
            const letters = t.replace(/[^A-Za-zÀ-ỹĐđ]/g, '');
            if ((letters.length >= 3 && !VI_VOWEL.test(letters) && letters !== letters.toUpperCase()) || (t.length >= 2 && /^[^\p{L}\p{N}]+$/u.test(t) && !/^[-\u2013\u2014.,;:()%\/\u2026"'\u201c\u201d]+$/.test(t))) bad++;
            if (letters.length >= 2) { alpha++; if (VI_DIAC.test(t)) dia++; }
        }
        const n = ws.length, conf = sum / n, wantsVi = /vie/.test(lang || '');
        const diaScore = wantsVi && alpha >= 12 ? Math.min(1, (dia / alpha) / 0.3) : 1;
        const score = Math.round(Math.max(0, Math.min(100, 0.6 * conf + 25 * (1 - Math.min(1, (bad / n) * 4)) + 15 * diaScore)));
        return { score, conf: Math.round(conf), bad: bad / n, dia: alpha ? dia / alpha : 0, n };
    }
    // Skew (degrees, rotate-by value) from the sharpest row projection of dark pixels; g = gray, any size.
    function ocrSkewAngle(g, w, h) {
        let m = 0; for (let i = 0; i < g.length; i++) m += g[i]; m /= g.length;
        const xs = [], ys = [];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y * w + x] < m * 0.7) { xs.push(x); ys.push(y); }
        if (xs.length < 200) return 0;
        let best = 0, bs = -1;
        for (let a = -3; a <= 3.001; a += 0.25) {
            const r = a * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), rows = new Float32Array(h + w + 2), off = w * 0.05 + 1;
            for (let i = 0; i < xs.length; i++) rows[Math.max(0, Math.round(xs[i] * s + ys[i] * c + off))]++;
            let sc = 0; for (let i = 0; i < rows.length; i++) sc += rows[i] * rows[i];
            if (sc > bs) { bs = sc; best = a; }
        }
        return best;
    }
    // Contrast stretch (1%–99%) then local-mean threshold via an integral image. Returns a 0/255 array.
    function ocrBinarize(g, w, h) {
        const n = w * h, hist = new Uint32Array(256);
        for (let i = 0; i < n; i++) hist[g[i]]++;
        let lo = 0, hi = 255, acc = 0;
        while (lo < 255 && (acc += hist[lo]) < n * 0.01) lo++;
        acc = 0; while (hi > 0 && (acc += hist[hi]) < n * 0.01) hi--;
        if (hi - lo < 30) { lo = 0; hi = 255; }
        const k = 255 / (hi - lo), W = w + 1, I = new Uint32Array(W * (h + 1)), s = new Uint8Array(n);
        for (let i = 0; i < n; i++) s[i] = Math.max(0, Math.min(255, (g[i] - lo) * k));
        for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += s[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row; } }
        const r = Math.max(15, Math.round(w / 60)), out = new Uint8Array(n);
        for (let y = 0; y < h; y++) {
            const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
            for (let x = 0; x < w; x++) {
                const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
                const mean = (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
                out[y * w + x] = s[y * w + x] < mean * 0.88 ? 0 : 255;
            }
        }
        return out;
    }
    /*OCR2-PURE-END*/
    function ocrEnhance(cv) {
        const w = cv.width, h = cv.height, sc = Math.min(1, 700 / w), sw = Math.max(1, Math.round(w * sc)), sh = Math.max(1, Math.round(h * sc));
        const gray = (d, n) => { const g = new Uint8Array(n); for (let i = 0, p = 0; i < n; i++, p += 4) g[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8; return g; };
        const t = document.createElement('canvas'); t.width = sw; t.height = sh;
        const tc = t.getContext('2d', { willReadFrequently: true }); tc.drawImage(cv, 0, 0, sw, sh);
        const ang = ocrSkewAngle(gray(tc.getImageData(0, 0, sw, sh).data, sw * sh), sw, sh); t.width = t.height = 0;
        const o = document.createElement('canvas'); o.width = w; o.height = h;
        const c = o.getContext('2d', { willReadFrequently: true });
        c.fillStyle = '#fff'; c.fillRect(0, 0, w, h);
        if (Math.abs(ang) >= 0.4) { c.translate(w / 2, h / 2); c.rotate(ang * Math.PI / 180); c.drawImage(cv, -w / 2, -h / 2); c.setTransform(1, 0, 0, 1, 0, 0); }
        else c.drawImage(cv, 0, 0);
        const im = c.getImageData(0, 0, w, h), bin = ocrBinarize(gray(im.data, w * h), w, h);
        for (let i = 0, p = 0; i < bin.length; i++, p += 4) { im.data[p] = im.data[p + 1] = im.data[p + 2] = bin[i]; im.data[p + 3] = 255; }
        c.putImageData(im, 0, 0);
        return o;
    }
    // Read once with an explicit PSM; if the quality score is under OCR_GOOD, read a cleaned copy too and keep the better one.
    async function ocrBest(worker, cv, lang, psm) {
        const run = async (c) => {
            await worker.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '1', user_defined_dpi: String(OCR_DPI) });
            return (await worker.recognize(c, {}, { blocks: true })).data;
        };
        let data = await run(cv), q = ocrQuality(data, lang), used = cv, retried = false;
        if (q.score < OCR_GOOD) {
            retried = true;
            const e = ocrEnhance(cv), d2 = await run(e), q2 = ocrQuality(d2, lang);
            if (q2.score > q.score) { data = d2; q = q2; used = e; } else e.width = e.height = 0;
        }
        return { data, q, retried, cv: used };
    }
    // A page that reads as a grid (many rows with the same number of cells) becomes a Markdown table.
    function ocrTablePage(pageNo, data) {
        const items = ocrWords(data).filter((w) => w.bbox).map((w) => ({ str: String(w.text).trim(), ocr: true, conf: w.confidence, x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1 }));
        const lay = pcLayout(items, 'auto');
        if (!lay.table) return null;
        const conf = Math.max(0, Math.min(100, Math.round(typeof data.confidence === 'number' ? data.confidence : 0)));
        return { md: '> [!warning] OCR table \u00b7 page ' + pageNo + ' \u00b7 confidence ' + conf + '%\n> Table / form page rebuilt as a grid \u2014 verify columns and every figure against the PDF.\n\n' + lay.md,
            page: pageNo, conf, lowNums: 0, issues: ['table-like layout'] };
    }
    // Native text that is empty OR garbled (broken font maps give \uFFFD / private-use glyphs) needs OCR.
    function pdfPageNeedsOcr(t) {
        const s = String(t || '').replace(/\s/g, '');
        if (s.length < 25) return true;
        return ((s.match(/[\uFFFD\uE000-\uF8FF\u0000-\u0008]/g) || []).length / s.length) > 0.08;
    }

    /* ── Import Word (.docx) as a note ──────────────────────────────────────────────────────────────
       mammoth.js reads the .docx → clean HTML (headings, bold/italic, lists, tables, links, images);
       Turndown (+ GFM tables) turns that HTML into Markdown. Embedded pictures are stored as note
       attachments (![](attachment://id)); the original .docx is attached too, as a safety net for
       anything Markdown can't hold (equations, text boxes, tracked-change history). ───────────── */
    const MAMMOTH_VER = '1.11.0', TURNDOWN_VER = '7.2.0', TDGFM_VER = '1.0.2';
    let docxLibPromise = null;
    function loadDocxLibs() {
        if (!docxLibPromise) docxLibPromise = (async () => {
            const cdn = 'https://cdn.jsdelivr.net/npm/';
            if (!window.mammoth) await loadScriptOnce(cdn + 'mammoth@' + MAMMOTH_VER + '/mammoth.browser.min.js');
            if (!window.TurndownService) await loadScriptOnce(cdn + 'turndown@' + TURNDOWN_VER + '/dist/turndown.js');
            if (!window.turndownPluginGfm) await loadScriptOnce(cdn + 'turndown-plugin-gfm@' + TDGFM_VER + '/dist/turndown-plugin-gfm.js');
            return { mammoth: window.mammoth, Turndown: window.TurndownService, gfm: window.turndownPluginGfm };
        })().catch((e) => { docxLibPromise = null; throw e; });
        return docxLibPromise;
    }
    // Word tables rarely mark a header row, but Markdown tables need one: promote the first row.
    // Multi-paragraph cells are flattened to one line (a Markdown cell can't hold a line break).
    function docxPrepareHtml(html) {
        const doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
        doc.querySelectorAll('table').forEach((t) => {
            const rows = t.querySelectorAll('tr'); if (!rows.length) return;
            t.querySelectorAll('td, th').forEach((c) => {
                c.querySelectorAll('p').forEach((p, i, all) => { if (i < all.length - 1) p.insertAdjacentHTML('afterend', ' <br> '); p.replaceWith(...p.childNodes); });
                c.querySelectorAll('ul, ol').forEach((l) => { l.replaceWith(doc.createTextNode(Array.from(l.children).map((li) => '\u2022 ' + li.textContent.trim()).join('; '))); });
            });
            Array.from(rows[0].children).forEach((c) => { if (c.nodeName === 'TD') { const th = doc.createElement('th'); th.innerHTML = c.innerHTML; c.replaceWith(th); } });
            let thead = t.querySelector('thead');
            if (!thead) { thead = doc.createElement('thead'); t.insertBefore(thead, t.firstChild); }
            if (rows[0].parentNode !== thead) thead.appendChild(rows[0]);
        });
        return doc.body.innerHTML;
    }
    async function importDocxAsNotes(fileList) {
        const all = Array.from(fileList || []);
        const files = all.filter((f) => /\.docx$/i.test(f.name));
        if (all.some((f) => /\.doc$/i.test(f.name))) alert('Old Word files (.doc) can\u2019t be read. Open them in Word and use Save As \u2192 .docx, then import again.');
        if (!files.length) return;
        let libs;
        try { toast('Loading Word reader\u2026'); libs = await loadDocxLibs(); }
        catch (e) { alert('Could not load the Word reader: ' + (e.message || e)); return; }
        const td = new libs.Turndown({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', hr: '---' });
        td.use(libs.gfm.gfm);
        let made = 0, failed = 0, warns = 0, skippedImgs = 0, lastId = null;
        for (const f of files) {
            try {
                toast(f.name + ' \u2014 converting\u2026');
                let imgN = 0;
                const res = await libs.mammoth.convertToHtml({ arrayBuffer: await f.arrayBuffer() }, {
                    styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh", "u => u"],
                    convertImage: libs.mammoth.images.imgElement(async (image) => {
                        try {
                            const b64 = await image.read('base64'), bin = atob(b64), bytes = new Uint8Array(bin.length);
                            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                            const ext = (image.contentType || 'image/png').split('/')[1].replace(/[^a-z0-9]/gi, '') || 'png';
                            const rec = await ingestAttachment(new File([bytes], 'word-image-' + (++imgN) + '.' + ext, { type: image.contentType || 'image/png' }));
                            return { src: 'attachment://' + rec.id, alt: image.altText || '' };
                        } catch (err) { skippedImgs++; return { src: '', alt: '[image could not be imported]' }; }
                    })
                });
                warns += (res.messages || []).filter((m) => m.type === 'warning').length;
                let md = td.turndown(docxPrepareHtml(res.value)).trim();
                let head = '';
                try { const rec = await ingestAttachment(f); head = '[\uD83D\uDCC4 ' + f.name + '](attachment://' + rec.id + ')\n\n'; } catch (e) { /* attach is a bonus */ }
                const id = uid();
                await restoreNotesList([{ id, title: f.name.replace(/\.docx$/i, ''), markdown: head + (md || '*No text could be extracted from this Word file.*'), type: 'General',
                    tags: ['word'], pinned: false, createdAt: Date.now(), updatedAt: Date.now() }]);
                made++; lastId = id;
            } catch (e) { console.warn('Notes Vault: Word import failed', f.name, e); failed++; }
        }
        toast('Imported ' + made + ' Word note' + (made === 1 ? '' : 's') + (failed ? ' \u2014 ' + failed + ' couldn\u2019t be read (damaged or password-protected?)' : '')
            + (warns ? ' \u2014 ' + warns + ' element' + (warns === 1 ? '' : 's') + ' (equations / text boxes?) were skipped: compare with the attached original' : '')
            + (skippedImgs ? ' \u2014 ' + skippedImgs + ' image' + (skippedImgs === 1 ? '' : 's') + ' couldn\u2019t be imported' : ''));
        if (made === 1 && lastId) openNote(lastId);
    }

    /* Spreadsheets dropped anywhere in the vault: each file becomes a new note holding the
       original (stored byte-for-byte as an attachment card → "Preview" in Read mode). */
    async function importSheetsAsNotes(fileList) {
        const files = Array.from(fileList || []).filter((f) => !!sheetMimeOf(f));
        if (!files.length) return;
        let made = 0, failed = 0, lastId = null;
        for (const f of files) {
            try {
                toast(f.name + ' — attaching…');
                const rec = await ingestAttachment(f);
                const label = (f.name || rec.filename || 'spreadsheet').replace(/[\[\]]/g, '').trim() || 'spreadsheet';
                const id = uid();
                await restoreNotesList([{ id, title: label.replace(/\.[a-z0-9]+$/i, ''),
                    markdown: '[📊 ' + label + '](attachment://' + rec.id + ')\n',
                    type: 'General', tags: ['excel'], pinned: false, createdAt: Date.now(), updatedAt: Date.now() }]);
                made++; lastId = id;
            } catch (e) { console.warn('Notes Vault: spreadsheet import failed', f.name, e); failed++; toast(e && e.message ? e.message : 'Could not attach that spreadsheet.'); }
        }
        if (made) toast('Imported ' + made + ' spreadsheet note' + (made === 1 ? '' : 's') + (failed ? ' — ' + failed + ' failed' : '') + '. Open it in Read mode and press Preview.');
        if (made === 1 && lastId) openNote(lastId);
    }

    async function importPdfAsNotes(fileList) {
        const files = Array.from(fileList || []).filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
        if (!files.length) return;
        let pdfjs;
        try { toast('Loading PDF reader…'); pdfjs = await loadPdfJs(); }
        catch (e) { alert('Could not load the PDF reader: ' + (e.message || e)); return; }
        let ocrWorker = null, ocrLang = '', ocrTotal = 0, made = 0, failed = 0, lastId = null;
        try {
            for (const f of files) {
                try {
                    const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
                    const N = doc.numPages, pages = new Array(N + 1).fill(''), blank = [];
                    for (let i = 1; i <= N; i++) {
                        toast(f.name + ' — reading page ' + i + '/' + N + '…');
                        const page = await doc.getPage(i);
                        pages[i] = await pdfPageText(page);
                        if (pdfPageNeedsOcr(pages[i])) blank.push(i);
                    }
                    let usedOcr = false; const ocrStats = [];
                    const choice = blank.length ? await askOcrModal({ fileName: f.name, total: N, blank }) : { action: 'skip', lang: 'vie+eng' };
                    if (choice.action === 'cancel') continue;
                    if (choice.action === 'ocr') {
                        try {
                            if (ocrWorker && ocrLang !== choice.lang) { try { await ocrWorker.terminate(); } catch (e) { /* ignore */ } ocrWorker = null; }
                            if (!ocrWorker) {
                                toast('Loading OCR engine…');
                                const T = await loadTesseract();
                                ocrLang = choice.lang; ocrWorker = await T.createWorker(choice.lang, 1, { logger: (m) => { if (m.status === 'recognizing text') toast('OCR… ' + Math.round(m.progress * 100) + '%'); } });
                            }
                            for (let k = 0; k < blank.length; k++) {
                                const i = blank[k];
                                toast(f.name + ' — OCR page ' + i + ' (' + (k + 1) + '/' + blank.length + ')…');
                                const page = await doc.getPage(i);
                                const base = page.getViewport({ scale: 1 });
                                const vp = page.getViewport({ scale: ocrScaleFor(base.width, base.height) });
                                const cv = document.createElement('canvas');
                                cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
                                await page.render({ canvas: cv, viewport: vp }).promise;
                                const r = await ocrBest(ocrWorker, cv, ocrLang, 3);
                                const rec = ocrTablePage(i, r.data) || ocrPageToMarkdown(i, r.data);
                                if (rec.md) rec.md = rec.md.replace('%', '% \u00b7 quality ' + r.q.score + '/100' + (r.retried ? ' (re-read after cleanup)' : ''));
                                pages[i] = rec.md;
                                if (rec.md) ocrStats.push(rec);
                                cv.width = cv.height = 0; if (r.cv !== cv) r.cv.width = r.cv.height = 0;
                            }
                            usedOcr = true;
                        } catch (e) { console.warn('Notes Vault: OCR failed', e); alert('OCR failed: ' + (e.message || e) + '\nThe note will be created with the text that could be read.'); }
                    }
                    let title = '';
                    try { const md = await doc.getMetadata(); title = ((md.info && md.info.Title) || '').trim(); } catch (e) { /* no metadata */ }
                    if (!title || title.length > 150) title = f.name.replace(/\.pdf$/i, '');
                    let head = '';
                    try { const rec = await ingestAttachment(f); head = '[\uD83D\uDCC4 ' + (f.name || 'document.pdf') + '](attachment://' + rec.id + ')\n\n'; } catch (e) { /* attach is a bonus */ }
                    const text = pages.slice(1).filter(Boolean).join('\n\n---\n\n');
                    const summary = pdfImportSummary(N, N - blank.length, ocrStats, blank.filter((i) => !pages[i]));
                    const when = f.lastModified || Date.now();
                    const id = uid();
                    await restoreNotesList([{ id, title, markdown: head + summary + (text || '*No text could be extracted from this PDF.*'), type: 'General',
                        tags: usedOcr ? ['pdf', 'ocr'] : ['pdf'], pinned: false, createdAt: Date.now(), updatedAt: Date.now() }]);
                    made++; ocrTotal += ocrStats.length; lastId = id;
                } catch (e) { console.warn('Notes Vault: PDF import failed', f.name, e); failed++; }
            }
        } finally { if (ocrWorker) { try { await ocrWorker.terminate(); } catch (e) { /* ignore */ } } }
        if (!made && !failed) { toast('PDF import cancelled.'); return; }
        toast('Imported ' + made + ' PDF note' + (made === 1 ? '' : 's') + (failed ? ' — ' + failed + ' couldn\u2019t be read (encrypted or damaged?)' : '') + (ocrTotal ? ' — OCR used on ' + ocrTotal + ' page' + (ocrTotal === 1 ? '' : 's') + ': review the ⚠ warning boxes.' : '') + '.');
        if (made === 1 && lastId) openNote(lastId);
    }

    /* ── Extract a region of a PDF page (drag a box → text / table → caret) ─────────────────────────
       Light preview (pdf.js, zoomable), rubber-band selection kept in page units (so zoom never loses
       it), then:  1) the box has a native text layer → exact text, no OCR at all (instant);
                   2) otherwise ONLY the cropped area is rendered at 2.5× into a small canvas and read by
                      Tesseract (sub-second, no header/footer noise).
       Both paths yield positioned words, so the same layout step can turn them into a Markdown table
       (columns found from the rows' cell gaps) or paragraphs. Result is editable, then inserted at the
       caret; the modal stays open so several regions can be collected in a row. ─────────────────── */
    const PC_MARK_OPEN = '\uE000', PC_MARK_CLOSE = '\uE001';
    /*PC-PURE-START*/
    const pcMul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
    // Keep the text items whose vertical centre is inside the box; a line cut mid-way is sliced by character.
    function pcClip(items, s) {
        const out = [];
        for (const it of items) {
            const cy = (it.y0 + it.y1) / 2, n = it.str.length;
            if (!n || cy < s.y0 || cy > s.y1 || it.x1 <= s.x0 || it.x0 >= s.x1) continue;
            const cw = (it.x1 - it.x0) / n;
            const lo = Math.max(0, Math.ceil((s.x0 - it.x0) / cw - 0.5)), hi = Math.min(n - 1, Math.floor((s.x1 - it.x0) / cw - 0.5));
            if (hi < lo) continue;
            const str = it.str.slice(lo, hi + 1);
            if (str.trim()) out.push({ str, x0: it.x0 + lo * cw, x1: it.x0 + (hi + 1) * cw, y0: it.y0, y1: it.y1 });
        }
        return out;
    }
    const pcTxt = (it) => (it.conf != null && it.conf < OCR_LOW_WORD && /\d/.test(it.str)) ? PC_MARK_OPEN + it.str.trim() + PC_MARK_CLOSE : it.str;
    function pcJoin(its) {
        let t = '', prev = null;
        for (const it of its) {
            const s = pcTxt(it);
            if (prev && !/\s$/.test(t) && !/^\s/.test(s) && (it.ocr || it.x0 - prev.x1 > (prev.y1 - prev.y0) * 0.12)) t += ' ';
            t += s; prev = it;
        }
        return t.replace(/\s+/g, ' ').trim();
    }
    function pcLines(items) {
        const hs = items.map((i) => i.y1 - i.y0).sort((a, b) => a - b), mh = hs[hs.length >> 1] || 10;
        const sorted = items.slice().sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1)), lines = [];
        for (const it of sorted) {
            const cy = (it.y0 + it.y1) / 2, ln = lines[lines.length - 1];
            if (ln && Math.abs(cy - ln.cy) <= mh * 0.6) { ln.cy = (ln.cy * ln.its.length + cy) / (ln.its.length + 1); ln.its.push(it); }
            else lines.push({ cy, its: [it] });
        }
        lines.forEach((l) => { l.its.sort((a, b) => a.x0 - b.x0); l.y0 = Math.min(...l.its.map((i) => i.y0)); l.y1 = Math.max(...l.its.map((i) => i.y1)); });
        return { lines, mh };
    }
    // A "cell" = words closer than ~0.9 line-heights; a wider gap starts the next column.
    function pcCells(line, mh) {
        const cells = []; let c = null, last = null;
        for (const it of line.its) {
            if (c && it.x0 - last.x1 <= mh * 0.9) { c.its.push(it); c.x1 = Math.max(c.x1, it.x1); }
            else { c = { its: [it], x0: it.x0, x1: it.x1 }; cells.push(c); }
            last = it;
        }
        cells.forEach((k) => { k.t = pcJoin(k.its); });
        return cells;
    }
    const PC_NUM = /^[(\-\u2212\u2013+]?\s?\d[\d.,\s]*\s?[%)x]*$/;
    function pcTable(lines, mh, force) {
        const rows = lines.map((l) => pcCells(l, mh)), multi = rows.filter((r) => r.length >= 2);
        if (multi.length < 2 || (!force && multi.length < rows.length * 0.5)) return null;
        // Column count = the most common cell count among multi-cell rows; ONLY those rows define the
        // column boundaries (a stray single-cell title or a merged header must not shift them).
        const freq = {}; multi.forEach((r) => { freq[r.length] = (freq[r.length] || 0) + 1; });
        let k = 0, best = 0;
        Object.keys(freq).forEach((n) => { if (freq[n] > best || (freq[n] === best && +n > k)) { best = freq[n]; k = +n; } });
        let ref = rows.filter((r) => r.length === k);
        if (ref.length < 2) { if (!force) return null; ref = [multi.reduce((a, r) => (r.length > a.length ? r : a))]; k = ref[0].length; }
        const cols = [];
        for (let i = 0; i < k; i++) cols.push({ x0: Math.min(...ref.map((r) => r[i].x0)), x1: Math.max(...ref.map((r) => r[i].x1)) });
        // Single-cell rows before/after the table (caption, source note) are text, NOT a header row.
        const first = rows.findIndex((r) => r.length >= 2), last = rows.length - 1 - rows.slice().reverse().findIndex((r) => r.length >= 2);
        const grid = rows.slice(first, last + 1).map((r) => {
            const a = new Array(k).fill('');
            r.forEach((c) => {
                let j = 0, bo = -Infinity;
                cols.forEach((col, i) => { const ov = Math.min(c.x1, col.x1) - Math.max(c.x0, col.x0); if (ov > bo) { bo = ov; j = i; } });
                a[j] = a[j] ? a[j] + ' ' + c.t : c.t;
            });
            return a;
        });
        const ce = (t) => t.replace(/\|/g, '\\|').replace(/</g, '\\<');
        const al = cols.map((_, i) => {
            const v = grid.slice(1).map((r) => r[i]).filter(Boolean);
            return v.length && v.filter((x) => PC_NUM.test(x.split(PC_MARK_OPEN).join('').split(PC_MARK_CLOSE).join(''))).length >= v.length * 0.8 ? '---:' : '---';
        });
        const row = (r) => '| ' + r.map(ce).join(' | ') + ' |';
        const tbl = [row(grid[0]), '| ' + al.join(' | ') + ' |'].concat(grid.slice(1).map(row)).join('\n');
        const txt = (r) => mdEscapePara(r.map((c) => c.t).join(' '));
        return rows.slice(0, first).map(txt).concat([tbl], rows.slice(last + 1).map(txt)).join('\n\n');
    }
    function pcParas(lines, mh) {
        const out = []; let prev = null;
        for (const l of lines) {
            const t = pcJoin(l.its); if (!t) continue;
            if (!prev || l.y0 - prev.y1 > mh * 0.9) out.push(t); else out[out.length - 1] += ' ' + t;
            prev = l;
        }
        return out.map(mdEscapePara).join('\n\n');
    }
    const pcFin = (t) => t.split(PC_MARK_OPEN).join('<mark title="Low OCR confidence \u2014 verify against the PDF">').split(PC_MARK_CLOSE).join('</mark>');
    function pcLayout(items, mode) {
        if (!items.length) return { md: '', table: false };
        const { lines, mh } = pcLines(items);
        if (mode !== 'text') { const t = pcTable(lines, mh, mode === 'table'); if (t) return { md: pcFin(t), table: true }; }
        return { md: pcFin(pcParas(lines, mh)), table: false };
    }
    /*PC-PURE-END*/

    function pcStyle() {
        if (document.getElementById('nvcStyle')) return;
        const st = document.createElement('style'); st.id = 'nvcStyle';
        st.textContent = `
        .nvc-scrim { position: fixed; inset: 0; z-index: 100000; background: rgba(20,12,18,.55); display: flex; align-items: center; justify-content: center; padding: 10px; }
        .nvc { width: min(100%, 1200px); height: min(100%, 900px); display: flex; flex-direction: column; background: var(--bg-white,#fff); color: var(--text-dark,#222); border: 1px solid var(--border-color,#ddd); border-radius: 14px; box-shadow: 0 24px 60px rgba(0,0,0,.35); overflow: hidden; outline: 0; }
        .nvc-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border-color,#ddd); background: var(--bg-light,#f5f5f5); font-size: .85rem; }
        .nvc-bar select, .nvc-side select { max-width: 200px; padding: 5px 7px; border-radius: 7px; border: 1px solid var(--border-color,#ccc); background: var(--bg-white,#fff); color: inherit; font: inherit; }
        .nvc-sp { flex: 1; }
        .nvc-ib { min-width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border-color,#ccc); background: var(--bg-white,#fff); color: inherit; cursor: pointer; }
        .nvc-ib:hover, .nvc-ib[aria-pressed="true"] { background: var(--primary,#db2777); color: #fff; border-color: transparent; }
        .nvc-pg { width: 52px; padding: 5px; border-radius: 7px; border: 1px solid var(--border-color,#ccc); background: var(--bg-white,#fff); color: inherit; text-align: center; font: inherit; }
        .nvc-main { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 340px; }
        .nvc-stage { position: relative; overflow: auto; background: #7d7d86; padding: 12px; }
        .nvc-wrap { position: relative; margin: 0 auto; background: #fff; box-shadow: 0 2px 14px rgba(0,0,0,.4); }
        .nvc-cv { display: block; width: 100%; height: 100%; }
        .nvc-ov { position: absolute; inset: 0; cursor: crosshair; touch-action: none; }
        .nvc.nvc-pan .nvc-ov { touch-action: pan-x pan-y; }
        .nvc-box { position: absolute; border: 2px solid var(--primary,#db2777); background: rgba(219,39,119,.14); pointer-events: none; }
        .nvc-empty { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 10px; align-items: center; justify-content: center; color: #fff; text-align: center; padding: 20px; }
        .nvc-side { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-left: 1px solid var(--border-color,#ddd); min-height: 0; }
        .nvc-side label { display: flex; flex-direction: column; gap: 3px; font-size: .75rem; font-weight: 600; }
        .nvc-side .nvc-chk { flex-direction: row; align-items: center; gap: 6px; font-weight: 500; }
        .nvc-opts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .nvc-opts label:first-child { grid-column: 1 / -1; }
        .nvc-side select { max-width: none; width: 100%; }
        .nvc-status { font-size: .8rem; color: var(--text-muted,#666); min-height: 1.2em; }
        .nvc-out { flex: 1; min-height: 120px; resize: none; padding: 9px; border-radius: 8px; border: 1px solid var(--border-color,#ccc); background: var(--bg-white,#fff); color: inherit; font: .82rem/1.45 ui-monospace, Consolas, monospace; }
        .nvc-foot { display: flex; gap: 8px; justify-content: flex-end; }
        .nvc-hint { font-size: .72rem; color: var(--text-muted,#666); }
        @media (max-width: 760px) { .nvc-main { grid-template-columns: 1fr; grid-template-rows: 1fr 46%; } .nvc-side { border-left: 0; border-top: 1px solid var(--border-color,#ddd); } .nvc-out { min-height: 60px; } }`;
        document.head.appendChild(st);
    }

    async function openPdfCrop(src) {
        if (!S.note) { toast('Open or create a note first.'); return; }
        if (document.querySelector('.nvc-scrim')) return;
        if (S.mode !== 'edit') setMode(preferredEditStyle(), false);
        pcStyle();
        let pdfjs;
        try { toast('Loading PDF reader…'); pdfjs = await loadPdfJs(); }
        catch (e) { alert('Could not load the PDF reader: ' + (e.message || e)); return; }
        // PDFs already attached to this note (+ the one the caller passed in) are offered directly.
        const srcs = [];
        if (src && src.blob) srcs.push(src);
        try {
            const seen = new Set(srcs.map((x) => x.id));
            for (const m of (S.note.markdown || '').matchAll(/attachment:\/\/([A-Za-z0-9_-]+)/g)) {
                if (seen.has(m[1])) continue; seen.add(m[1]);
                const r = await dbGetAttachment(m[1]);
                if (r && /pdf/i.test(r.mime || '') && r.blob) srcs.push({ id: r.id, name: r.filename || 'document.pdf', blob: r.blob });
            }
        } catch (e) { /* attachments are optional */ }

        const P = { doc: null, name: '', page: 1, n: 0, zoom: 1, fit: 'init', w: 0, h: 0, sel: null, cache: new Map(), run: 0, rtok: 0, task: null, worker: null, wlang: '', last: null };
        const scrim = document.createElement('div'); scrim.className = 'nvc-scrim';
        scrim.innerHTML = `
          <div class="nvc" tabindex="-1" role="dialog" aria-modal="true" aria-label="Extract region from PDF">
            <div class="nvc-bar">
              <b><i class="fa-solid fa-crop" aria-hidden="true"></i> Extract region</b>
              <select class="nvc-src" title="PDF"></select>
              <button type="button" class="nvc-ib" data-a="open" title="Open a PDF file…"><i class="fa-solid fa-folder-open"></i></button>
              <span class="nvc-sp"></span>
              <button type="button" class="nvc-ib" data-a="prev" title="Previous page (PageUp)"><i class="fa-solid fa-chevron-left"></i></button>
              <input class="nvc-pg" type="number" min="1" value="1" aria-label="Page"><span class="nvc-of"></span>
              <button type="button" class="nvc-ib" data-a="next" title="Next page (PageDown)"><i class="fa-solid fa-chevron-right"></i></button>
              <button type="button" class="nvc-ib" data-a="zout" title="Zoom out (-)"><i class="fa-solid fa-magnifying-glass-minus"></i></button>
              <span class="nvc-zv">100%</span>
              <button type="button" class="nvc-ib" data-a="zin" title="Zoom in (+)"><i class="fa-solid fa-magnifying-glass-plus"></i></button>
              <button type="button" class="nvc-ib" data-a="fit" title="Fit width"><i class="fa-solid fa-arrows-left-right"></i></button>
              <button type="button" class="nvc-ib" data-a="pan" aria-pressed="false" title="Touch: scroll the page instead of selecting"><i class="fa-solid fa-hand"></i></button>
              <button type="button" class="nvc-ib" data-a="close" title="Close (Esc)"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="nvc-main">
              <div class="nvc-stage">
                <div class="nvc-wrap"><canvas class="nvc-cv"></canvas><div class="nvc-ov"><div class="nvc-box" hidden></div></div></div>
                <div class="nvc-empty"><div>Choose a PDF, then drag a box around the paragraph, chart caption or table you want.</div><button type="button" class="nv-btn nv-btn-primary" data-a="open"><i class="fa-solid fa-folder-open"></i> Open PDF…</button></div>
              </div>
              <div class="nvc-side">
                <div class="nvc-opts">
                  <label>Read with<select class="nvc-method"><option value="auto">Auto — text layer, else OCR</option><option value="ocr">Always OCR (image)</option></select></label>
                  <label>Layout<select class="nvc-layout"><option value="auto">Auto</option><option value="table">Table</option><option value="text">Paragraph</option></select></label>
                  <label>OCR language<select class="nvc-lang"><option value="vie">Vietnamese</option><option value="vie+eng">Vietnamese + English</option><option value="eng">English</option></select></label>
                </div>
                <div class="nvc-status" aria-live="polite">Drag on the page to select a region.</div>
                <textarea class="nvc-out" spellcheck="false" placeholder="Extracted Markdown appears here — edit it before inserting."></textarea>
                <label class="nvc-chk"><input type="checkbox" class="nvc-srcline" checked> Add source line (file, page)</label>
                <div class="nvc-foot"><button type="button" class="nv-btn" data-a="clear">Clear</button><button type="button" class="nv-btn nv-btn-primary" data-a="insert"><i class="fa-solid fa-arrow-right-to-bracket"></i> Insert at cursor</button></div>
                <div class="nvc-hint">Drag = new box · drag inside = move · Ctrl+Enter = insert · Esc = clear / close</div>
              </div>
            </div>
          </div>`;
        document.body.appendChild(scrim);
        const q = (s) => scrim.querySelector(s);
        const dlg = q('.nvc'), stage = q('.nvc-stage'), wrap = q('.nvc-wrap'), cv = q('.nvc-cv'), ov = q('.nvc-ov'), box = q('.nvc-box'), empty = q('.nvc-empty'),
            selSrc = q('.nvc-src'), pgIn = q('.nvc-pg'), pgOf = q('.nvc-of'), zv = q('.nvc-zv'), out = q('.nvc-out'), stat = q('.nvc-status'),
            method = q('.nvc-method'), layoutSel = q('.nvc-layout'), langSel = q('.nvc-lang'), srcChk = q('.nvc-srcline');
        const status = (t, spin) => { stat.innerHTML = (spin ? '<i class="fa-solid fa-spinner fa-spin"></i> ' : '') + esc(t); };
        const addOpt = (s, i) => { const o = document.createElement('option'); o.value = i; o.textContent = s.name; selSrc.appendChild(o); };
        srcs.forEach(addOpt);
        if (!srcs.length) selSrc.hidden = true;

        const drawBox = () => {
            const s = P.sel; box.hidden = !s;
            if (!s) return;
            box.style.left = s.x0 * P.zoom + 'px'; box.style.top = s.y0 * P.zoom + 'px';
            box.style.width = (s.x1 - s.x0) * P.zoom + 'px'; box.style.height = (s.y1 - s.y0) * P.zoom + 'px';
        };
        const render = async () => {
            const tok = ++P.rtok;
            if (P.task) { try { P.task.cancel(); await P.task.promise; } catch (e) { /* cancelled */ } P.task = null; }
            const page = await P.doc.getPage(P.page); if (tok !== P.rtok) return;
            const v1 = page.getViewport({ scale: 1 }); P.w = v1.width; P.h = v1.height;
            if (P.fit) { P.zoom = Math.max(0.4, Math.min(P.fit === 'w' ? 3 : 1, (stage.clientWidth - 24) / P.w)); P.fit = null; }
            const dpr = Math.min(window.devicePixelRatio || 1, 2), vp = page.getViewport({ scale: P.zoom * dpr });
            cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
            wrap.style.width = P.w * P.zoom + 'px'; wrap.style.height = P.h * P.zoom + 'px';
            zv.textContent = Math.round(P.zoom * 100) + '%';
            const task = page.render({ canvas: cv, viewport: vp }); P.task = task;
            try { await task.promise; } catch (e) { if (!/cancel/i.test((e && (e.name || e.message)) || '')) console.warn('Notes Vault: crop preview', e); }
            if (P.task === task) P.task = null;
            drawBox();
        };
        const goPage = async (n) => {
            if (!P.doc) return;
            n = Math.max(1, Math.min(P.n, Math.round(+n) || 1));
            P.page = n; P.sel = null; P.last = null; pgIn.value = n; drawBox();
            await render();
        };
        const zoomBy = (f) => { P.zoom = Math.max(0.4, Math.min(4, P.zoom * f)); render(); };
        const loadSource = async (s) => {
            status('Opening PDF…', true);
            try {
                if (P.doc) { try { P.doc.destroy(); } catch (e) { /* ignore */ } }
                P.cache.clear(); P.sel = null; P.last = null; out.value = ''; P.fit = 'init';
                P.doc = await pdfjs.getDocument({ data: new Uint8Array(await s.blob.arrayBuffer()) }).promise;
                P.name = s.name; P.n = P.doc.numPages; pgIn.max = P.n; pgOf.textContent = '/ ' + P.n;
                empty.hidden = true; status('Drag on the page to select a region.');
                await goPage(1);
            } catch (e) { console.warn('Notes Vault: crop open', e); status('Could not open that PDF (encrypted or damaged?).'); }
        };

        // ── words in page units (scale 1, origin top-left) ──
        const nativeItems = async (page) => {
            if (P.cache.has(page.pageNumber)) return P.cache.get(page.pageNumber);
            const tc = await page.getTextContent(), vt = page.getViewport({ scale: 1 }).transform, items = [];
            for (const it of tc.items) {
                if (typeof it.str !== 'string' || !it.str.trim()) continue;
                const t = pcMul(vt, it.transform), h = Math.hypot(t[2], t[3]) || Math.abs(it.height) || 10;
                items.push({ str: it.str, x0: t[4], x1: t[4] + (it.width || 0), y0: t[5] - h, y1: t[5] });
            }
            P.cache.set(page.pageNumber, items); return items;
        };
        const getWorker = async (lang) => {
            if (P.worker && P.wlang === lang) return P.worker;
            if (P.worker) { try { await P.worker.terminate(); } catch (e) { /* ignore */ } P.worker = null; }
            status('Loading OCR engine… (first use downloads language data)', true);
            const T = await loadTesseract();
            P.worker = await T.createWorker(lang, 1, { logger: (m) => { if (m.status === 'recognizing text') status('OCR… ' + Math.round(m.progress * 100) + '%', true); } });
            P.wlang = lang;
            return P.worker;
        };
        // Render ONLY the selected rectangle (padded) into its own small canvas, then OCR it.
        const ocrItems = async (page, s) => {
            const pad = 3, x0 = Math.max(0, s.x0 - pad), y0 = Math.max(0, s.y0 - pad), x1 = Math.min(P.w, s.x1 + pad), y1 = Math.min(P.h, s.y1 + pad);
            const sc = Math.min(OCR_DPI / 72, OCR_MAX_SIDE / (x1 - x0), OCR_MAX_SIDE / (y1 - y0)), vp = page.getViewport({ scale: sc });
            const c = document.createElement('canvas'); c.width = Math.ceil((x1 - x0) * sc); c.height = Math.ceil((y1 - y0) * sc);
            await page.render({ canvas: c, viewport: vp, transform: [1, 0, 0, 1, -x0 * sc, -y0 * sc] }).promise;
            const worker = await getWorker(langSel.value);
            status('OCR…', true);
            const r = await ocrBest(worker, c, langSel.value, 6), data = r.data;
            c.width = c.height = 0; if (r.cv !== c) r.cv.width = r.cv.height = 0;
            const items = [], confs = [];
            for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) {
                const str = String(w.text || '').trim(); if (!str || !w.bbox) continue;
                if (typeof w.confidence === 'number') confs.push(w.confidence);
                items.push({ str, ocr: true, conf: w.confidence, x0: x0 + w.bbox.x0 / sc, x1: x0 + w.bbox.x1 / sc, y0: y0 + w.bbox.y0 / sc, y1: y0 + w.bbox.y1 / sc });
            }
            const avg = confs.length ? confs.reduce((a, v) => a + v, 0) / confs.length : 0;
            const conf = Math.max(0, Math.min(100, Math.round(typeof data.confidence === 'number' ? data.confidence : avg)));
            // No word boxes (unexpected build): keep the plain text so the user still gets something.
            return { items, conf, score: r.q.score, retried: r.retried, text: items.length ? null : mdEscapePara((data.text || '').replace(/\s*\n\s*/g, ' ').trim()) };
        };
        const compose = () => {
            const L = P.last; if (!L) return;
            const lay = L.text != null ? { md: L.text, table: false } : pcLayout(L.items, layoutSel.value);
            let t = lay.md;
            if (!t) { out.value = ''; status('No text found in that box — try a slightly larger one.'); return; }
            if (L.ocr) t = '> [!warning] OCR text \u00b7 page ' + L.page + ' \u00b7 confidence ' + L.conf + '% \u00b7 quality ' + L.score + '/100\n> Check numbers, decimals, % and currency against the PDF.\n\n' + t;
            if (srcChk.checked) t += '\n\n*Source: ' + P.name.replace(/[*_\[\]]/g, '\\$&') + ', p. ' + L.page + '*';
            out.value = t;
            status((L.ocr ? 'OCR \u00b7 quality ' + L.score + '/100' + (L.retried ? ' (re-read after cleanup)' : '') : 'Native text (exact)') + (lay.table ? ' \u00b7 table detected' : '') + ' \u00b7 ' + L.ms + ' ms');
        };
        const extract = async () => {
            const s = P.sel; if (!s || !P.doc) return;
            const run = ++P.run, t0 = performance.now();
            try {
                status('Reading…', true);
                const page = await P.doc.getPage(P.page);
                let items = null, ocr = false, conf = 0, text = null, score = 0, retried = false;
                if (method.value === 'auto') {
                    const clipped = pcClip(await nativeItems(page), s);
                    if (clipped.reduce((n, i) => n + i.str.trim().length, 0) >= 2) items = clipped;
                }
                if (!items) { const r = await ocrItems(page, s); items = r.items; conf = r.conf; text = r.text; score = r.score; retried = r.retried; ocr = true; }
                if (run !== P.run) return;
                P.last = { items, text, ocr, conf, score, retried, page: P.page, ms: Math.round(performance.now() - t0) };
                compose();
            } catch (e) { console.warn('Notes Vault: crop extract', e); if (run === P.run) status('Extraction failed: ' + (e.message || e)); }
        };
        const insert = () => {
            const t = out.value.trim(); if (!t) { status('Nothing to insert yet — select a region first.'); return; }
            const ta = el.src, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd, b = v.slice(0, s), a = v.slice(e);
            const pre = b && !/\n\n$/.test(b) ? (/\n$/.test(b) ? '\n' : '\n\n') : '';
            const post = a ? (/^\n\n/.test(a) ? '' : /^\n/.test(a) ? '\n' : '\n\n') : '\n';
            const txt = pre + t + post;
            replaceRange(s, e, txt, s + txt.length);
            markDirty(); toast('Inserted from page ' + (P.last ? P.last.page : P.page));
            P.sel = null; drawBox(); dlg.focus(); status('Inserted. Select another region, or close.');
        };

        // ── rubber-band selection (mouse / pen / touch) ──
        let drag = null;
        const pt = (e) => { const r = ov.getBoundingClientRect(); return { x: Math.max(0, Math.min(P.w, (e.clientX - r.left) / P.zoom)), y: Math.max(0, Math.min(P.h, (e.clientY - r.top) / P.zoom)) }; };
        ov.addEventListener('pointerdown', (e) => {
            if (!P.doc || e.button > 0 || (e.pointerType === 'touch' && dlg.classList.contains('nvc-pan'))) return;
            const p = pt(e), s = P.sel;
            drag = s && p.x >= s.x0 && p.x <= s.x1 && p.y >= s.y0 && p.y <= s.y1 ? { mv: true, ox: p.x, oy: p.y, s0: { ...s } } : { mv: false, ax: p.x, ay: p.y };
            if (!drag.mv) P.sel = null;
            ov.setPointerCapture(e.pointerId); e.preventDefault();
        });
        ov.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const p = pt(e);
            if (drag.mv) {
                const s0 = drag.s0, dx = Math.max(-s0.x0, Math.min(P.w - s0.x1, p.x - drag.ox)), dy = Math.max(-s0.y0, Math.min(P.h - s0.y1, p.y - drag.oy));
                P.sel = { x0: s0.x0 + dx, x1: s0.x1 + dx, y0: s0.y0 + dy, y1: s0.y1 + dy };
            } else P.sel = { x0: Math.min(drag.ax, p.x), x1: Math.max(drag.ax, p.x), y0: Math.min(drag.ay, p.y), y1: Math.max(drag.ay, p.y) };
            drawBox();
        });
        const endDrag = () => {
            if (!drag) return; drag = null;
            if (P.sel && (P.sel.x1 - P.sel.x0) * P.zoom < 8 || P.sel && (P.sel.y1 - P.sel.y0) * P.zoom < 8) { P.sel = null; drawBox(); return; }
            if (P.sel) extract();
        };
        ov.addEventListener('pointerup', endDrag);
        ov.addEventListener('pointercancel', () => { drag = null; });

        const fileIn = document.createElement('input'); fileIn.type = 'file'; fileIn.accept = '.pdf,application/pdf'; fileIn.hidden = true; scrim.appendChild(fileIn);
        fileIn.addEventListener('change', () => {
            const f = fileIn.files && fileIn.files[0]; fileIn.value = ''; if (!f) return;
            const s = { id: null, name: f.name, blob: f }; srcs.push(s); addOpt(s, srcs.length - 1);
            selSrc.hidden = false; selSrc.value = srcs.length - 1; loadSource(s);
        });
        selSrc.addEventListener('change', () => loadSource(srcs[+selSrc.value]));
        pgIn.addEventListener('change', () => goPage(pgIn.value));
        [method, langSel].forEach((x) => x.addEventListener('change', () => { if (P.sel) extract(); }));
        layoutSel.addEventListener('change', compose);
        srcChk.addEventListener('change', compose);

        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (P.sel) { P.sel = null; drawBox(); } else close(); return; }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); insert(); return; }
            if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
            if (e.key === 'PageDown' || e.key === 'ArrowRight') goPage(P.page + 1);
            else if (e.key === 'PageUp' || e.key === 'ArrowLeft') goPage(P.page - 1);
            else if (e.key === '+' || e.key === '=') zoomBy(1.25);
            else if (e.key === '-') zoomBy(0.8);
        };
        document.addEventListener('keydown', onKey, true);
        function close() {
            document.removeEventListener('keydown', onKey, true);
            P.run++; P.rtok++;
            if (P.worker) { P.worker.terminate().catch(() => {}); P.worker = null; }
            if (P.doc) { try { P.doc.destroy(); } catch (e) { /* ignore */ } }
            scrim.remove(); el.src.focus();
        }
        scrim.addEventListener('click', (e) => {
            const b = e.target.closest('[data-a]'); if (!b) return;
            const a = b.dataset.a;
            if (a === 'open') fileIn.click();
            else if (a === 'close') close();
            else if (a === 'prev') goPage(P.page - 1);
            else if (a === 'next') goPage(P.page + 1);
            else if (a === 'zin') zoomBy(1.25);
            else if (a === 'zout') zoomBy(0.8);
            else if (a === 'fit') { P.fit = 'w'; render(); }
            else if (a === 'pan') b.setAttribute('aria-pressed', String(dlg.classList.toggle('nvc-pan')));
            else if (a === 'clear') { P.sel = null; P.last = null; out.value = ''; drawBox(); status('Drag on the page to select a region.'); }
            else if (a === 'insert') insert();
        });
        dlg.focus();
        if (srcs.length) loadSource(srcs[0]); else fileIn.click();
    }

    /* Import Markdown: each .md/.markdown/.txt file becomes a new note. Reads the same YAML
       frontmatter Export writes (title, type, tags, course, deadline, career, skill, created,
       updated), so Export → Import round-trips. Title falls back to the first "# heading", then
       the filename. For folder imports, files with no `type:` take their parent folder's name.
       Files whose title + text already match an existing note are skipped, so re-importing
       the same files never makes duplicates. */
    async function importMarkdownFiles(fileList, fromFolder) {
        const files = Array.from(fileList || []).filter((f) => /\.(md|markdown|mdown|txt)$/i.test(f.name) && !/(^|\/)\./.test(f.webkitRelativePath || ''));
        if (!files.length) { alert('No Markdown files (.md, .markdown, .txt) found.'); return; }
        // Only live notes count as duplicates — a copy sitting in Trash shouldn't block re-importing.
        const seen = new Set(S.notes.map(sigOf));
        const liveBySig = new Map(S.notes.map((n) => [sigOf(n), n]));   // so a skipped file can point at the note it matched
        const dupHits = [];
        const list = []; let dup = 0, failed = 0;
        const now = Date.now();
        for (const f of files) {
            try {
                const text = (await f.text()).replace(/^\uFEFF/, '');
                const { body: rawBody, data } = extractFrontmatter(text);
                let body = rawBody.replace(/^(?:[ \t]*\r?\n)+/, '');
                const fm = FRONTMATTER_RE.exec(text);
                const fmDate = (k) => {
                    const m = fm && new RegExp('^' + k + ':\\s*["\']?([^"\'\\r\\n]+)', 'm').exec(fm[1]);
                    const t = m ? Date.parse(m[1].trim()) : NaN;
                    return isNaN(t) ? 0 : t;
                };
                const h1 = /^#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(body);
                let title = (data && data.title) || (h1 && h1[1].trim()) || f.name.replace(/\.[^.]+$/, '');
                // Export adds "# Title" when the note had none — drop it again so it isn't doubled.
                if (data && data.title && h1 && h1[1].trim() === data.title) body = body.slice(h1[0].length).replace(/^(?:[ \t]*\r?\n)+/, '');
                let type = data && data.type;
                if (!type && fromFolder && f.webkitRelativePath) {
                    const parts = f.webkitRelativePath.split('/');
                    if (parts.length > 2) type = parts[parts.length - 2];
                }
                const hit = data && data.skill ? findSkillMatch(data.skill, data.career) : null;
                const sig = sigOf({ title, markdown: body });
                if (seen.has(sig)) { dup++; const hitNote = liveBySig.get(sig); if (hitNote) dupHits.push(hitNote); continue; }
                seen.add(sig);
                const t0 = f.lastModified || now;
                list.push({
                    id: uid(), title, markdown: body, type: type || 'General',
                    tags: (data && data.tags) || [], pinned: false,
                    createdAt: fmDate('created') || t0, updatedAt: fmDate('updated') || t0,
                    course: data && data.course, deadline: data && data.deadline,
                    linkedCareer: hit ? hit.career : '', linkedSkill: hit ? hit.skill : ''
                });
            } catch (e) { console.warn('Notes Vault: could not read', f.name, e); failed++; }
        }
        // If the note on screen is an empty one (e.g. a fresh "Untitled note") and exactly one file
        // is being imported, fill that note instead of leaving an empty tab behind. Reusing its id
        // makes restoreNotesList overwrite it; updatedAt is bumped so the "never overwrite a newer
        // note" guard doesn't skip it when the file's own modified date is older.
        let reusedBlank = false;
        if (list.length === 1 && !fromFolder && el.docView && !el.docView.hidden) {
            const b = S.note;
            if (b && !String(b.title || '').trim() && !String(b.markdown || '').trim() && !(b.tags && b.tags.length)) {
                list[0].id = b.id;
                list[0].createdAt = b.createdAt || list[0].createdAt;
                list[0].updatedAt = Date.now();
                reusedBlank = true;
            }
        }
        if (list.length) await restoreNotesList(list);
        // openNote() returns early when the target is already the active note, so drop the
        // in-memory copy first to force it to reload the freshly imported text.
        if (reusedBlank) { S.note = null; S.persisted = false; S.dirty = false; }
        const msg = 'Imported ' + list.length + ' note' + (list.length === 1 ? '' : 's')
            + (dup ? ' — ' + dup + ' skipped (already in the vault)' : '')
            + (failed ? ' — ' + failed + ' couldn\u2019t be read' : '') + '.';
        if (list.length === 1 && !fromFolder) {
            // One file imported: open it right away (same as PDF import) so it's never "lost".
            const newId = list[0].id;
            toast(msg, 'Open', () => openNote(newId));   // safety net if auto-open is ever interrupted
            try { await openNote(newId); }
            catch (e) { console.warn('Notes Vault: could not auto-open imported note', e); }
        } else if (list.length) {
            // Several files: show the first one's button so it's one click away.
            toast(msg, 'Open first', () => openNote(list[0].id));
        } else if (dup || failed) {
            // Nothing new was imported. Say *which* note the file matched and offer to open it.
            const first = dupHits[0];
            const shortT = (n) => { const t = String(n.title || '').trim() || 'Untitled note'; return t.length > 50 ? t.slice(0, 47) + '\u2026' : t; };
            let m2 = msg;
            if (dup === 1 && first && !failed) m2 = '\u201C' + shortT(first) + '\u201D is already in the vault (same title and text) \u2014 skipped.';
            else if (first) m2 = msg + ' First match: \u201C' + shortT(first) + '\u201D.';
            if (first) toast(m2, 'Open', () => openNote(first.id)); else toast(m2);
        }
    }

    function importJson(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);
                const list = Array.isArray(data) ? data : (data.notes || []);
                if (!Array.isArray(list) || !list.length) { alert('No notes found in that file.'); return; }
                const attResult = await restoreAttachmentsList(data.attachments).catch(() => ({ added: 0 }));
                const { added, updated, skipped } = await restoreNotesList(list);
                const revResult = await restoreRevisionsList(data.revisions).catch(() => ({ added: 0 }));
                await restoreFileLinksList(data.fileLinks).catch(() => ({ added: 0 }));
                if (S.note) renderDocMeta();
                const revMsg = revResult.added ? ' + ' + revResult.added + ' version' + (revResult.added === 1 ? '' : 's') + ' of history' : '';
                const imgMsg = attResult.added ? ' + ' + attResult.added + ' image' + (attResult.added === 1 ? '' : 's') : '';
                alert('Imported ' + (added + updated) + ' note(s)' + revMsg + imgMsg + (skipped ? ' — ' + skipped + ' skipped because a newer version is already here.' : '.'));
            } catch (err) {
                console.error(err);
                alert('Could not read that file — is it a Notes Vault JSON backup?');
            }
        };
        reader.readAsText(file);
        el.importFile.value = '';
    }
    async function requestPersist() {
        if (!navigator.storage || !navigator.storage.persist) { alert('This browser does not support persistent storage requests.'); return; }
        try {
            const granted = await navigator.storage.persist();
            alert(granted
                ? 'Persistent storage granted — your notes are now protected from automatic browser cleanup.'
                : 'The browser did not grant persistent storage this time. Your notes are still saved, just without the extra protection.');
        } catch (e) { alert('Could not request persistent storage.'); }
    }

    /* ═════════════ Formatting toolbar (edits the Markdown source) ═════════════
       Every button rewrites plain Markdown in the textarea, so the saved note and
       the exported .md are always exactly what you see in Edit mode. Edits go
       through execCommand('insertText') so the browser's own Ctrl+Z / Ctrl+Y
       history keeps working across toolbar actions. */
    const MARK = { bold: '**', italic: '*', strike: '~~', code: '`' };
    const MOD_LABEL = /Mac|iPhone|iPad/i.test(navigator.platform || '') ? '⌘' : 'Ctrl+';
    const SHORTCUTS = { bold: 'B', italic: 'I', link: 'K', strike: 'Shift+X', code: '`' };
    // indent · quote markers · (bullet [checkbox] | number)
    const LINE_RE = /^(\s*)((?:>[ \t]?)*)(?:([-*+])[ \t]+(?:\[([ xX])\][ \t]+)?|(\d{1,9})([.)])[ \t]+)?/;
    const isWordCh = (c) => /[\p{L}\p{N}\p{M}_]/u.test(c || '');

    const lineStart = (v, pos) => (pos <= 0 ? 0 : v.lastIndexOf('\n', pos - 1) + 1);
    const lineEnd = (v, pos) => { const i = v.indexOf('\n', pos); return i < 0 ? v.length : i; };
    function lineRange(v, s, e) {
        // Whole lines touched by the selection (a selection ending right after a newline doesn't count the next line).
        const e2 = (e > s && v[e - 1] === '\n') ? e - 1 : e;
        return { a: lineStart(v, s), b: lineEnd(v, e2) };
    }
    function contentStart(line) {
        const m = LINE_RE.exec(line);
        let n = m[0].length;
        if (n === m[1].length + m[2].length) {
            const h = /^#{1,6}[ \t]+/.exec(line.slice(n));
            if (h) n += h[0].length;
        }
        return n;
    }
    function inFence(v, pos) {
        const before = v.slice(0, pos).match(/^[ \t]{0,3}(?:```|~~~)/gm);
        return !!before && before.length % 2 === 1;
    }

    function replaceRange(a, b, text, selA, selB) {
        if (S.live && lv) { if (text === '' && b === a) return; lv.replace(a, b, text, selA, selB); return; }
        const ta = el.src;
        ta.focus();
        ta.setSelectionRange(a, b);
        let ok = false;
        if (text === '' && b === a) return;
        try { ok = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text); } catch (e) { ok = false; }
        if (!ok) {
            ta.setRangeText(text, a, b, 'end');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        ta.setSelectionRange(selA, selB == null ? selA : selB);
    }

    // Apply a change to whole lines, keeping the caret/selection where the user expects it.
    function editLines(mapper) {
        const ta = el.src, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
        const { a, b } = lineRange(v, s, e);
        const old = v.slice(a, b).split('\n');
        const nw = mapper(old.slice());
        if (!nw) return;
        const text = nw.join('\n');
        if (text === v.slice(a, b)) return;
        const d0 = nw[0].length - old[0].length;
        const ns = Math.max(a, s + d0);
        const ne = Math.max(ns, e + (text.length - (b - a)));
        replaceRange(a, b, text, ns, ne);
    }
    const targetsOf = (lines) => { const any = lines.some((l) => l.trim()); return lines.map((l) => (any ? l.trim() !== '' : true)); };

    /* ── inline: bold / italic / strike / code ── */
    function inlineSpans(str, base) {
        const spans = [], open = {};
        const flip = (t, len, k) => {
            if (open[t] == null) {
                if (k + len < str.length && !/\s/.test(str[k + len])) open[t] = k;
            } else if (k > 0 && !/\s/.test(str[k - 1])) {
                spans.push({ type: t, open: base + open[t], close: base + k, len });
                open[t] = null;
            }
        };
        for (let k = 0; k < str.length;) {
            const ch = str[k];
            if (ch === '\\') { k += 2; continue; }
            if (ch === '`') { flip('code', 1, k); k++; continue; }
            if (open.code != null) { k++; continue; }
            if (ch === '*') { if (str[k + 1] === '*') { flip('bold', 2, k); k += 2; } else { flip('italic', 1, k); k++; } continue; }
            if (ch === '~' && str[k + 1] === '~') { flip('strike', 2, k); k += 2; continue; }
            k++;
        }
        return spans;
    }
    function toggleInline(type) {
        const ta = el.src, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
        const M = MARK[type], L = M.length;
        // A span "contains" the selection when it lies between its markers; a real selection may also touch the markers
        // themselves (e.g. after wrapping, the selection still covers the closing ** at the end of a line).
        const spanAt = (line, from, to) => inlineSpans(line.slice(contentStart(line)), contentStart(line)).find((sp) => sp.type === type &&
            (from === to ? (sp.open + L <= from && to <= sp.close) : (sp.open <= from && to <= sp.close + L)));

        if (s === e) {                                   // caret only
            const a = lineStart(v, s), line = v.slice(a, lineEnd(v, s)), off = s - a;
            const hit = spanAt(line, off, off);
            if (hit) {                                   // inside a span → remove its markers
                replaceRange(a + hit.open, a + hit.close + L, line.slice(hit.open + L, hit.close), s - L);
                return;
            }
            const cs = contentStart(line);
            let ws = off, we = off;                      // otherwise wrap the word under the caret
            while (ws > cs && isWordCh(line[ws - 1])) ws--;
            while (we < line.length && isWordCh(line[we])) we++;
            if (ws === we) replaceRange(s, s, M + M, s + L);
            else replaceRange(a + ws, a + we, M + line.slice(ws, we) + M, s + L);
            return;
        }

        const { a, b } = lineRange(v, s, e);
        const lines = v.slice(a, b).split('\n');
        let pos = a;
        const segs = lines.map((line) => {
            const ls = pos; pos += line.length + 1;
            let from = Math.max(s - ls, contentStart(line)), to = Math.min(e - ls, line.length);
            while (from < to && /\s/.test(line[from])) from++;
            while (to > from && /\s/.test(line[to - 1])) to--;
            return { line, from, to, ok: to > from, hit: null };
        });
        const live = segs.filter((x) => x.ok);
        if (!live.length) return;
        live.forEach((x) => { x.hit = spanAt(x.line, x.from, x.to); });
        const removing = live.every((x) => x.hit);

        const out = []; let cursor = a, newStart = null, newEnd = null;
        segs.forEach((x) => {
            let nl = x.line, nf = x.from, nt = x.to;
            if (x.ok) {
                if (removing) {
                    const h = x.hit;
                    nl = x.line.slice(0, h.open) + x.line.slice(h.open + L, h.close) + x.line.slice(h.close + L);
                    const gone = (p) => Math.min(Math.max(p - h.open, 0), L) + Math.min(Math.max(p - h.close, 0), L);   // marker chars removed before p
                    nf = x.from - gone(x.from);
                    nt = x.to - gone(x.to);
                } else if (!x.hit) {
                    nl = x.line.slice(0, x.from) + M + x.line.slice(x.from, x.to) + M + x.line.slice(x.to);
                    nf = x.from + L; nt = x.to + L;
                }
                if (newStart === null) newStart = cursor + nf;
                newEnd = cursor + nt;
            }
            out.push(nl); cursor += nl.length + 1;
        });
        replaceRange(a, b, out.join('\n'), newStart, newEnd);
    }

    /* ── block: headings, lists, quote, callout ── */
    function setHeading(n) {
        editLines((lines) => {
            const t = targetsOf(lines);
            const lvl = (l) => { const m = /^ {0,3}(#{1,6})[ \t]+/.exec(l); return m ? m[1].length : 0; };
            const all = lines.every((l, i) => !t[i] || lvl(l) === n);
            return lines.map((l, i) => {
                if (!t[i]) return l;
                const bare = l.replace(/^ {0,3}#{1,6}[ \t]+/, '');
                return all ? bare : '#'.repeat(n) + ' ' + bare;
            });
        });
    }
    function listKind(m) { return m[5] ? 'ol' : (m[3] ? (m[4] !== undefined ? 'task' : 'ul') : null); }
    function setList(kind) {
        editLines((lines) => {
            const t = targetsOf(lines);
            const info = lines.map((l, i) => { const m = LINE_RE.exec(l); return t[i] ? { m, kind: listKind(m), rest: l.slice(m[0].length) } : null; });
            const all = info.every((x) => !x || x.kind === kind);
            let n = 1;
            return lines.map((l, i) => {
                const x = info[i];
                if (!x) return l;
                const lead = x.m[1] + x.m[2];
                if (all) return lead + x.rest;
                return lead + (kind === 'ul' ? '- ' : kind === 'task' ? '- [ ] ' : (n++) + '. ') + x.rest;
            });
        });
    }
    function toggleQuote() {
        editLines((lines) => {
            const t = targetsOf(lines);
            const all = lines.every((l, i) => !t[i] || /^\s*>/.test(l));
            return lines.map((l, i) => (!t[i] ? l : all ? l.replace(/^(\s*)>[ \t]?/, '$1') : '> ' + l));
        });
    }
    function insertCallout() {
        editLines((lines) => {
            const t = targetsOf(lines);
            let first = true;
            return lines.map((l, i) => {
                if (!t[i]) return l;
                const label = first ? '[!IMPORTANT] ' : '';
                first = false;
                return '> ' + label + l.replace(/^\s*>[ \t]?/, '');
            });
        });
    }
    function clearFormatting() {
        editLines((lines) => lines.map((l) => l
            .replace(/^\s*(?:>[ \t]?)+/, '')
            .replace(/^\s*#{1,6}[ \t]+/, '')
            .replace(/^(\s*)(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '$1')
            .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*\s][^*]*)\*/g, '$1')
            .replace(/~~([^~]+)~~/g, '$1')
            .replace(/`([^`]+)`/g, '$1')));
    }

    /* ── inserts: link, code block, table, divider ── */
    function insertLink() {
        const ta = el.src, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd, sel = v.slice(s, e);
        if (/^https?:\/\/\S+$/.test(sel.trim())) {                    // selected a URL → give it link text
            replaceRange(s, e, '[link text](' + sel.trim() + ')', s + 1, s + 10);
        } else if (sel && !sel.includes('\n')) {                      // selected words → link them, select "url"
            replaceRange(s, e, '[' + sel + '](url)', s + sel.length + 3, s + sel.length + 6);
        } else {
            replaceRange(e, e, '[link text](url)', e + 1, e + 10);
        }
    }
    function insertBlock(text, selFrom, selTo) {
        const ta = el.src, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
        const before = v.slice(0, s), after = v.slice(e);
        const pre = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
        const post = !after ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
        replaceRange(s, e, pre + text + post, s + pre.length + selFrom, s + pre.length + selTo);
    }
    function insertTable() {
        insertBlock('| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |', 2, 10);
    }
    function insertDivider() { insertBlock('---', 3, 3); }
    function toggleCodeBlock() {
        const ta = el.src, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
        const { a, b } = lineRange(v, s, e);
        const prevStart = a > 0 ? lineStart(v, a - 1) : -1;
        const prevLine = a > 0 ? v.slice(prevStart, a - 1) : null;
        const nextEnd = b < v.length ? lineEnd(v, b + 1) : -1;
        const nextLine = b < v.length ? v.slice(b + 1, nextEnd) : null;
        if (prevLine !== null && nextLine !== null && /^\s*(```|~~~)/.test(prevLine) && /^\s*(```|~~~)\s*$/.test(nextLine)) {
            const inner = v.slice(a, b);                              // already fenced → unwrap
            replaceRange(prevStart, nextEnd, inner, prevStart, prevStart + inner.length);
            return;
        }
        const block = v.slice(a, b);
        if (!block.trim()) replaceRange(a, b, '```\n\n```', a + 4);
        else replaceRange(a, b, '```\n' + block + '\n```', a + 4, a + 4 + block.length);
    }

    // Gathers the selected text (several long paragraphs, say) into ONE fenced ```markdown block.
    //  · nothing selected + caret in a paragraph → that whole paragraph is wrapped
    //  · nothing selected on a blank line       → an empty block, caret inside
    //  · selection already sits inside a ```markdown fence → unwrap (toggle)
    //  · text that itself contains ``` fences   → a longer outer fence is used so nothing breaks
    function wrapAsMarkdownBlock() {
        const ta = el.src, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
        let { a, b } = lineRange(v, s, e);
        const prevStart = a > 0 ? lineStart(v, a - 1) : -1;
        const prevLine = a > 0 ? v.slice(prevStart, a - 1) : null;
        const nextEnd = b < v.length ? lineEnd(v, b + 1) : -1;
        const nextLine = b < v.length ? v.slice(b + 1, nextEnd) : null;
        if (prevLine !== null && nextLine !== null && /^\s*(`{3,}|~{3,})\s*(markdown|md)\s*$/i.test(prevLine) && /^\s*(`{3,}|~{3,})\s*$/.test(nextLine)) {
            const inner = v.slice(a, b);                                  // already wrapped → unwrap
            replaceRange(prevStart, nextEnd, inner, prevStart, prevStart + inner.length);
            return;
        }
        if (s === e && v.slice(a, b).trim()) {                            // caret only → grow to the whole paragraph
            while (a > 0) { const ps = lineStart(v, a - 1); if (!v.slice(ps, a - 1).trim()) break; a = ps; }
            while (b < v.length) { const ne = lineEnd(v, b + 1); if (!v.slice(b + 1, ne).trim()) break; b = ne; }
        }
        const block = v.slice(a, b);
        let longest = 0;
        (block.match(/^[ \t]*`{3,}/gm) || []).forEach((m) => { longest = Math.max(longest, m.trim().length); });
        const fence = '`'.repeat(Math.max(3, longest + 1));
        const head = fence + 'markdown\n';
        if (!block.trim()) replaceRange(a, b, head + '\n' + fence, a + head.length);
        else replaceRange(a, b, head + block + '\n' + fence, a + head.length, a + head.length + block.length);
    }

    function insertWikilink() {
        const ta = el.src, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd, sel = v.slice(s, e);
        if (sel && !sel.includes('\n')) replaceRange(s, e, '[[' + sel + ']]', s + 2, s + 2 + sel.length);
        else replaceRange(s, e, '[[]]', s + 2, s + 2);
        checkWlTrigger();
    }

    /* ── Extract selection → new note ──────────────────────────────────────
       Turns a highlighted chunk of the current note into its own note, and
       drops "See [[Title]]" in its place — the fast path for splitting a long
       dump note into smaller, linkable, atomic ones. If the selection's first
       non-blank line is a heading, that becomes the new note's title (and is
       dropped from its body, since the title already carries it); otherwise
       the first line is used as the title and stays in the body. */
    function extractSelectionToNote() {
        if (!S.note) return;
        const ta = el.src, s = ta.selectionStart, e = ta.selectionEnd;
        if (s === e || !ta.value.slice(s, e).trim()) { flash('Select some text first to extract it into a new note'); return; }
        const lines = ta.value.slice(s, e).replace(/\r\n/g, '\n').split('\n');
        let i = lines.findIndex((l) => l.trim());
        if (i === -1) i = 0;
        const h = /^\s{0,3}(#{1,6})[ \t]+(.*?)\s*#*\s*$/.exec(lines[i]);
        let title;
        if (h) {
            title = h[2].trim();
            lines.splice(i, 1);
            while (lines.length && !lines[0].trim()) lines.shift();
        } else {
            title = lines[i].trim().slice(0, 80);
        }
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        title = title || 'Untitled note';
        const newId = uid();
        const finalTitle = dedupeTitle(title, newId);
        const now = Date.now();
        const child = {
            id: newId, title: finalTitle, markdown: lines.join('\n'),
            type: normType(S.note.type), tags: [], pinned: false, createdAt: now, updatedAt: now
        };
        dbPut(child).then(() => {
            syncAttachmentRefs(child.id, child.markdown).catch(() => {});
            S.notes.push(child);
            const link = 'See [[' + finalTitle + ']]';
            replaceRange(s, e, link, s, s + link.length);
            renderSide();
            renderDatalists();
            toast('Extracted to “' + finalTitle + '”', 'Open', () => openNote(newId));
        }).catch((err) => {
            console.error('Notes Vault: extract to note failed', err);
            flash('Couldn’t create the note — try again');
        });
    }

    const CMD = {
        undo: () => { if (S.live && lv) lv.undo(); else { el.src.focus(); document.execCommand('undo'); } },
        redo: () => { if (S.live && lv) lv.redo(); else { el.src.focus(); document.execCommand('redo'); } },
        bold: () => toggleInline('bold'), italic: () => toggleInline('italic'),
        strike: () => toggleInline('strike'), code: () => toggleInline('code'),
        h1: () => setHeading(1), h2: () => setHeading(2), h3: () => setHeading(3),
        ul: () => setList('ul'), ol: () => setList('ol'), task: () => setList('task'),
        quote: toggleQuote, link: insertLink, wikilink: insertWikilink,
        image: () => { if (el.attachInput) el.attachInput.click(); },
        pdf: () => { if (el.pdfInput) el.pdfInput.click(); }, pdfcrop: () => openPdfCrop(),
        file: () => { if (el.fileInput) el.fileInput.click(); },
        codeblock: toggleCodeBlock, mdblock: wrapAsMarkdownBlock,
        table: insertTable, hr: insertDivider, callout: insertCallout, clear: clearFormatting,
        extract: extractSelectionToNote,
        textools: () => ttToggle()
    };
    function runCmd(name) {
        if (S.mode !== 'edit' || !CMD[name]) return;
        CMD[name]();
        refreshToolbar();
    }

    // Which toolbar buttons are "on" at the caret (heading level, list type, bold…).
    function currentFormats() {
        const ta = el.src, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
        const a = lineStart(v, s), end = lineEnd(v, s), line = v.slice(a, end);
        const f = {};
        const h = /^ {0,3}(#{1,6})[ \t]/.exec(line);
        if (h) f['h' + h[1].length] = true;
        const m = LINE_RE.exec(line);
        const k = listKind(m);
        if (k) f[k] = true;
        if (m[2]) f.quote = true;
        const from = s - a, to = Math.min(e, end) - a;
        const cs = contentStart(line);
        for (const sp of inlineSpans(line.slice(cs), cs)) {
            if (sp.open + sp.len <= from && to <= sp.close) f[sp.type] = true;
        }
        return f;
    }
    let tbRaf = 0;
    function refreshToolbar() {
        if (S.mode !== 'edit' || !el.tools) return;
        cancelAnimationFrame(tbRaf);
        tbRaf = requestAnimationFrame(() => {
            const f = currentFormats();
            el.tools.querySelectorAll('[aria-pressed]').forEach((b) => b.setAttribute('aria-pressed', f[b.dataset.cmd] ? 'true' : 'false'));
        });
    }

    /* ── keyboard behaviour inside the editor ── */
    function onEnter(e) {
        const ta = el.src, v = ta.value, s = ta.selectionStart;
        if (s !== ta.selectionEnd || inFence(v, s)) return;
        const a = lineStart(v, s), end = lineEnd(v, s), line = v.slice(a, end), m = LINE_RE.exec(line);
        if (!m[2] && !m[3] && !m[5]) return;                           // not a list / quote line
        if (s - a < m[0].length) return;                               // caret sits inside the marker
        e.preventDefault();
        const rest = line.slice(m[0].length);
        if (!rest.trim() && s === end) {                               // empty item → step out of the list
            let nl = '';
            if ((m[3] || m[5]) && m[1].length) nl = line.replace(/^(?: {1,4}|\t)/, '');    // nested → outdent
            else if ((m[3] || m[5]) && m[2]) nl = m[1] + m[2];                                // keep the quote
            replaceRange(a, end, nl, a + nl.length);
            return;
        }
        let marker = '';
        if (m[5]) marker = (parseInt(m[5], 10) + 1) + m[6] + ' ';
        else if (m[3]) marker = m[3] + ' ' + (m[4] !== undefined ? '[ ] ' : '');
        const prefix = m[1] + m[2] + marker;
        replaceRange(s, s, '\n' + prefix, s + 1 + prefix.length);
    }
    function onTab(e) {
        const ta = el.src, v = ta.value;
        const { a, b } = lineRange(v, ta.selectionStart, ta.selectionEnd);
        if (inFence(v, a)) return;
        const lines = v.slice(a, b).split('\n');
        const isItem = (l) => { const m = LINE_RE.exec(l); return !!(m[3] || m[5]); };
        if (!lines.some(isItem)) return;                               // leave Tab alone so keyboard focus can still move on
        e.preventDefault();
        editLines((ls) => ls.map((l) => (!isItem(l) ? l : e.shiftKey ? l.replace(/^(?: {1,4}|\t)/, '') : '    ' + l)));
    }
    /* ═════════════ [[ ]] autocomplete while typing in the editor ═════════════ */
    const WL = { open: false, items: [], sel: 0, start: -1, end: -1 };
    function closeWlPopup() {
        if (!WL.open) return;
        WL.open = false;
        if (el.wlPop) el.wlPop.hidden = true;
    }
    function wlCandidates(q) {
        const key = fold(q);
        return S.notes
            .filter((n) => n.title.trim())
            .map((n) => ({ n, idx: fold(n.title.trim()).indexOf(key) }))
            .filter((x) => x.idx >= 0)
            .sort((a, b) => (a.idx - b.idx) || (a.n.title.length - b.n.title.length))
            .slice(0, 8)
            .map((x) => x.n);
    }
    // Pixel position of the caret in a plain <textarea>, via an offscreen mirror element —
    // the same trick scrollSrcTo() uses to scroll the editor to a given offset.
    function caretCoords(ta) {
        const cs = getComputedStyle(ta);
        const div = document.createElement('div');
        ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'borderLeftWidth', 'borderRightWidth', 'borderTopWidth', 'borderBottomWidth', 'borderStyle', 'boxSizing']
            .forEach((p) => { div.style[p] = cs[p]; });
        div.style.cssText += 'position:absolute;visibility:hidden;left:-9999px;top:0;white-space:pre-wrap;overflow-wrap:break-word;';
        div.style.width = ta.clientWidth + 'px';
        div.textContent = ta.value.slice(0, ta.selectionStart);
        const mark = document.createElement('span');
        mark.textContent = '\u200b';
        div.appendChild(mark);
        document.body.appendChild(div);
        const rect = ta.getBoundingClientRect();
        const x = rect.left + (mark.offsetLeft - ta.scrollLeft);
        const y = rect.top + (mark.offsetTop - ta.scrollTop) + parseFloat(cs.lineHeight || '20');
        div.remove();
        return { x, y };
    }
    function openWlPopup(items) {
        WL.items = items; WL.sel = 0; WL.open = items.length > 0;
        if (!el.wlPop) return;
        if (!WL.open) { el.wlPop.hidden = true; return; }
        el.wlPop.innerHTML = items.map((n, i) => `<li data-i="${i}" class="${i === 0 ? 'nv-wl-sel' : ''}">${esc(n.title.trim())}</li>`).join('')
            + '<li class="nv-wl-hint">↑↓ choose · Enter to link · Esc to cancel</li>';
        let { x, y } = caretCoords(el.src);
        if (S.live && lv) { const c = lv.coordsAt(el.src.selectionStart); if (c) { x = c.left; y = c.bottom + 4; } }
        el.wlPop.style.left = Math.max(4, Math.min(x, window.innerWidth - 324)) + 'px';
        el.wlPop.style.top = Math.min(y, window.innerHeight - 200) + 'px';
        el.wlPop.hidden = false;
    }
    // Fires on every keystroke/click in the editor: opens (or updates) the popup whenever the
    // caret sits right after an unclosed "[[", closes it otherwise.
    function checkWlTrigger() {
        const ta = el.src;
        if (S.mode !== 'edit' || !(S.live ? (lv && lv.hasFocus()) : document.activeElement === ta) || ta.selectionStart !== ta.selectionEnd) { closeWlPopup(); return; }
        const before = ta.value.slice(Math.max(0, ta.selectionStart - 80), ta.selectionStart);
        const m = /\[\[([^\[\]\n]*)$/.exec(before);
        if (!m) { closeWlPopup(); return; }
        WL.start = ta.selectionStart - m[1].length; WL.end = ta.selectionStart;
        openWlPopup(wlCandidates(m[1]));
    }
    function applyWlPick(n) {
        if (!n) return;
        const title = n.title.trim();
        replaceRange(WL.start, WL.end, title + ']]', WL.start + title.length + 2, WL.start + title.length + 2);
        closeWlPopup();
        refreshToolbar();
    }
    const keyIs = (e, ch) => (e.key && e.key.toLowerCase() === ch) || e.code === 'Key' + ch.toUpperCase();
    function onEditorKey(e) {
        if (e.isComposing || e.keyCode === 229) return;                // Vietnamese IME is mid-composition
        if (WL.open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                WL.sel = (WL.sel + (e.key === 'ArrowDown' ? 1 : -1) + WL.items.length) % WL.items.length;
                [...el.wlPop.children].forEach((li, i) => li.classList.toggle('nv-wl-sel', i === WL.sel));
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyWlPick(WL.items[WL.sel]); return; }
            if (e.key === 'Escape') { e.preventDefault(); closeWlPopup(); return; }
        }
        const mod = e.ctrlKey || e.metaKey;
        if (mod && !e.altKey) {
            let cmd = null;
            if (!e.shiftKey && keyIs(e, 'b')) cmd = 'bold';
            else if (!e.shiftKey && keyIs(e, 'i')) cmd = 'italic';
            else if (!e.shiftKey && keyIs(e, 'k')) cmd = 'link';
            else if (e.shiftKey && keyIs(e, 'x')) cmd = 'strike';
            else if (!e.shiftKey && (e.key === '`' || e.code === 'Backquote')) cmd = 'code';
            if (cmd) { e.preventDefault(); e.stopPropagation(); runCmd(cmd); }
            return;
        }
        if (e.altKey) return;
        if (e.key === 'Enter' && !e.shiftKey) onEnter(e);
        else if (e.key === 'Tab') onTab(e);
    }
    /* ═════════════ Source Capture ═════════════
       Pasting a bare URL into an otherwise-empty note turns it into a sourced clip: a small
       "Source / URL / Captured" header, then a blank line for the person's own notes. Domain,
       URL and date are always available offline; the human-readable Source name starts as a
       guess from the domain and is quietly upgraded if the site's page can be read (most sites
       block cross-origin reads with no CORS headers, so this silently keeps the guess then). */
    const SOURCE_HEADER_RE = /^\*\*Source:\*\* (.*)\n\*\*URL:\*\* (.*)\n\*\*Captured:\*\* (.*)\n\n---\n\n/;
    function sourceDomain(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
    }
    function domainLabel(domain) {
        const base = domain.split('.')[0].replace(/[-_]+/g, ' ').trim();
        return base ? base.replace(/\b\w/g, (c) => c.toUpperCase()) : domain;
    }
    const sourceHeader = (name, url, captured) => `**Source:** ${name}\n**URL:** ${url}\n**Captured:** ${captured}\n\n---\n\n`;

    async function captureSource(url) {
        if (!S.note) return;
        const fallback = domainLabel(sourceDomain(url));
        const captured = fmtFull(Date.now()).split(',')[0].trim();     // "22 Sep 2026" — drop the time
        const header = sourceHeader(fallback, url, captured);

        S.note.markdown = header;
        if (!S.note.title.trim()) S.note.title = fallback;
        if (normType(S.note.type) === 'General') S.note.type = 'Sources';
        if (!S.note.tags.some((t) => t.toLowerCase() === 'source')) S.note.tags.push('source');
        fillDoc();
        fitTitle();
        el.src.focus();
        el.src.setSelectionRange(header.length, header.length);
        markDirty();
        flash('Source captured');

        // Best-effort upgrade — see comment above. Silently gives up on any failure, timeout,
        // or if the person has since moved on to another note or edited the header away.
        const noteId = S.note.id;
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 6000);
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!res.ok) return;
            const html = await res.text();
            const siteName = (html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i) || [])[1];
            const pageTitle = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
            const name = ((siteName || pageTitle || fallback) + '').trim() || fallback;
            if (!S.note || S.note.id !== noteId) return;
            const m = SOURCE_HEADER_RE.exec(S.note.markdown);
            if (!m || m[2] !== url) return;                            // header was edited/removed meanwhile
            const newHeader = sourceHeader(name, url, m[3]);
            S.note.markdown = newHeader + S.note.markdown.slice(m[0].length);
            if (S.note.title.trim() === fallback && pageTitle) S.note.title = pageTitle.trim();
            if (S.mode === 'edit' && !el.src.hidden) {
                const pos = Math.max(0, el.src.selectionStart + (newHeader.length - m[0].length));
                el.src.value = S.note.markdown;
                el.title.value = S.note.title;
                fitTitle();
                el.src.setSelectionRange(pos, pos);
            }
            markDirty();
        } catch (e) { /* offline, blocked by CORS, or timed out — the domain-based guess stands */ }
    }

    function getImageFilesFromClipboard(cd) {
        if (!cd) return [];
        const files = [];
        if (cd.files && cd.files.length) {
            for (const f of cd.files) if (/^image\//.test(f.type)) files.push(f);
        }
        if (!files.length && cd.items && cd.items.length) {
            for (const it of cd.items) {
                if (it.kind === 'file' && /^image\//.test(it.type)) { const f = it.getAsFile(); if (f) files.push(f); }
            }
        }
        return files;
    }
    // Fallback for screenshot tools / browsers that don't put the image into the paste
    // event's DataTransfer the way getImageFilesFromClipboard() expects. Reads the live
    // system clipboard directly. Only ever tried when the event-based check finds nothing —
    // the native `paste` event stays the primary, first-choice path.
    async function tryClipboardReadImage() {
        if (!navigator.clipboard || !navigator.clipboard.read) return [];
        try {
            const items = await navigator.clipboard.read();
            const files = [];
            for (const item of items) {
                const type = item.types.find((t) => /^image\//.test(t));
                if (!type) continue;
                const blob = await item.getType(type);
                const ext = (type.split('/')[1] || 'png').split('+')[0];
                files.push(new File([blob], 'pasted-image.' + ext, { type }));
            }
            return files;
        } catch (e) {
            return [];   // permission denied, nothing image-shaped on the clipboard, or unsupported — fail silently
        }
    }
    // Runs a pasted/dropped image through the attachment pipeline, showing an inline
    // "Uploading…" placeholder while it works so the caret position isn't left guessing.
    // Each job gets a unique placeholder token (rather than a fixed literal string) so that
    // pasting several images in a row — or while a previous one is still encoding — can never
    // have its indexOf() match land on the wrong placeholder.
    let attachJobSeq = 0;
    let attachInFlight = 0;   // images still being processed — closing the tab now would lose them
    window.addEventListener('beforeunload', (ev) => { if (attachInFlight > 0) { ev.preventDefault(); ev.returnValue = ''; } });
    // The person switched to another note while an image was still processing: put the finished image into the note it was
    // pasted into (the shared editor now shows a different note, so it can't be patched through the editor).
    async function patchPendingAttachment(noteId, placeholder, md) {
        try {
            const n = S.notes.find((x) => x.id === noteId);
            if (!n || typeof n.markdown !== 'string' || n.markdown.indexOf(placeholder) === -1) return false;
            n.markdown = n.markdown.replace(placeholder, () => md);
            n.updatedAt = Date.now();
            await dbPut(n);
            syncAttachmentRefs(n.id, n.markdown).catch(() => {});
            return true;
        } catch (e) { return false; }
    }
    async function insertAttachments(files) {
        const ta = el.src;
        for (const file of files) {
            const isPdf = file.type === 'application/pdf';
            const isSheet = !isPdf && !!sheetMimeOf(file);
            const jobId = 'j' + (++attachJobSeq) + Date.now().toString(36);
            const noteId = S.note ? S.note.id : null;
            attachInFlight++;
            // A PDF is inserted as a plain markdown link (not `![]()`) — a browser can't decode a
            // PDF blob as an <img>, so it gets its own inline viewer at render time instead (see
            // resolveAttachments/renderPdfEmbed) rather than pretending to be a picture.
            const placeholder = (isPdf || isSheet) ? '[Uploading…](attachment-pending:' + jobId + ')' : '![Uploading…](attachment-pending:' + jobId + ')';
            const s = ta.selectionStart, en = ta.selectionEnd;
            replaceRange(s, en, placeholder, s + placeholder.length);
            markDirty();
            let md, err;
            try {
                const rec = await ingestAttachment(file);
                if (isPdf) {
                    const label = (file.name || rec.filename || 'document.pdf').trim() || 'document.pdf';
                    md = '[\uD83D\uDCC4 ' + label + '](attachment://' + rec.id + ')';
                } else if (isSheet) {
                    const label = (file.name || rec.filename || 'spreadsheet').replace(/[\[\]]/g, '').trim() || 'spreadsheet';
                    md = '[\uD83D\uDCCA ' + label + '](attachment://' + rec.id + ')';
                } else {
                    const alt = (file.name || 'image').replace(/\.[a-z0-9]+$/i, '').trim() || 'image';
                    md = '![' + alt + '](attachment://' + rec.id + ')';
                }
            } catch (e) {
                err = e; md = '';
            }
            // `ta` is shared by every note: only touch it while the note the image was pasted into is still the open one.
            const sameNote = !noteId || (S.note && S.note.id === noteId);
            const idx = sameNote ? ta.value.indexOf(placeholder) : -1;
            if (idx !== -1) replaceRange(idx, idx + placeholder.length, md, idx + md.length);
            else if (!sameNote) {
                const ok = await patchPendingAttachment(noteId, placeholder, md);
                if (!ok && md) toast('The image was stored, but the note you pasted it into could not be updated.');
            }
            else if (md) { const p = ta.selectionStart; replaceRange(p, p, md, p + md.length); }
            attachInFlight--;
            if (sameNote) { markDirty(); flushSave().catch(() => {}); }   // save now — don't leave a window where closing loses the image
            if (err) toast(err.message || 'Could not attach that file.');
        }
    }
    /* ── Paste a table (Excel / Google Sheets / a web page) → Markdown table ──
       Reads text/html first (exact cell text, colspan, in-cell line breaks), falling back to the
       tab-separated text/plain that every spreadsheet also puts on the clipboard. A single cell,
       a single row/column, or tab-indented code is left alone and pastes normally. ── */
    let plainPasteOnce = false;   // Ctrl/Cmd+Shift+V = "paste as plain text", skip conversion once
    function cleanTableCell(v) {
        return String(v == null ? '' : v).normalize('NFC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ')
            .replace(/\u0001/g, '<br>').replace(/\s*<br>\s*/g, '<br>').replace(/^(<br>)+|(<br>)+$/g, '')
            .replace(/\|/g, '\\|').trim();
    }
    function parseTsv(text) {
        const rows = []; let row = [], cell = '', q = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (q) {
                if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
                else if (ch === '\n') cell += '\u0001';
                else if (ch !== '\r') cell += ch;
            } else if (ch === '"' && cell === '') q = true;
            else if (ch === '\t') { row.push(cell); cell = ''; }
            else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
            else cell += ch;
        }
        if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
        return rows;
    }
    function rowsFromHtml(html) {
        let doc;
        try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return null; }
        const tbl = doc.querySelector('table');
        if (!tbl) return null;
        // Only treat it as "a table paste" when the table is (nearly) all of what was copied —
        // otherwise a web page with a table plus paragraphs would silently lose the paragraphs.
        const bodyLen = (doc.body.textContent || '').replace(/\s+/g, '').length;
        const tblLen = (tbl.textContent || '').replace(/\s+/g, '').length;
        if (!tblLen || tblLen < bodyLen * 0.9) return null;
        const rows = [];
        tbl.querySelectorAll('tr').forEach((tr) => {
            if (tr.closest('table') !== tbl) return;   // skip nested tables' rows
            const cells = [];
            Array.from(tr.children).forEach((c) => {
                if (!/^(TD|TH)$/.test(c.tagName)) return;
                const clone = c.cloneNode(true);
                clone.querySelectorAll('br').forEach((b) => b.replaceWith('\u0001'));
                cells.push(clone.textContent);
                for (let k = 1; k < (parseInt(c.getAttribute('colspan'), 10) || 1); k++) cells.push('');
            });
            rows.push(cells);
        });
        return rows;
    }
    function rowsToMarkdownTable(rows) {
        const n = Math.max(0, ...rows.map((r) => r.length));
        rows = rows.map((r) => Array.from({ length: n }, (_, i) => cleanTableCell(r[i])));
        rows = rows.filter((r) => r.some(Boolean));
        if (rows.length < 2 || n < 2) return null;
        const keep = [];
        for (let c = 0; c < n; c++) if (rows.some((r) => r[c])) keep.push(c);
        if (keep.length < 2) return null;
        rows = rows.map((r) => keep.map((c) => r[c]));
        const numRe = /^[-+(]?[$€£¥₫]?\s?\d[\d.,\s]*%?\)?$/;
        const align = keep.map((_, c) => {
            const vals = rows.slice(1).map((r) => r[c]).filter(Boolean);
            return vals.length && vals.every((v) => numRe.test(v)) ? '---:' : '---';
        });
        // Pad cells so the columns line up in the raw (Edit) view; capped so one long cell can't
        // stretch every other row. Renders identically — Markdown ignores the extra spaces.
        const w = keep.map((_, c) => Math.min(30, Math.max(3, ...rows.map((r) => r[c].length))));
        const pad = (t, c) => align[c] === '---:' ? t.padStart(w[c]) : t.padEnd(w[c]);
        const line = (r) => '| ' + r.map(pad).join(' | ') + ' |';
        const sep = '| ' + align.map((a, c) => a === '---:' ? '-'.repeat(w[c] - 1) + ':' : '-'.repeat(w[c])).join(' | ') + ' |';
        return [line(rows[0]), sep].concat(rows.slice(1).map(line)).join('\n');
    }
    function tableMarkdownFromClipboard(cd) {
        if (!cd) return null;
        const html = cd.getData('text/html') || '';
        const plain = cd.getData('text/plain') || '';
        let rows = /<table[\s>]/i.test(html) ? rowsFromHtml(html) : null;
        if (!rows) {
            if (plain.indexOf('\t') === -1) return null;
            rows = parseTsv(plain.replace(/(\r?\n)+$/, ''));
            const widths = new Set(rows.map((r) => r.length));
            if (rows.length < 2 || widths.size !== 1 || rows[0].length < 2) return null;   // ragged = probably code
        }
        return rowsToMarkdownTable(rows);
    }
    function insertPastedTable(md, plain) {
        const ta = el.src, v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
        const before = v.slice(0, s), after = v.slice(en);
        if (((before.match(/^\s*(```|~~~)/gm) || []).length) % 2 === 1) return false;   // inside a code fence: paste as-is
        const pre = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
        const suf = after === '' ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
        const text = pre + md + suf;
        replaceRange(s, en, text, s + text.length);
        markDirty();
        toast('Pasted as a table', 'Paste as text', () => {
            ta.focus();
            try { document.execCommand('undo'); } catch (err) { /* fall through */ }
            const p = ta.selectionStart;
            replaceRange(p, p, plain, p + plain.length);
            markDirty();
        });
        return true;
    }
    /* ── Visual blocks: charts / bar graphs / SVG copied from Gemini, ChatGPT, Claude, web pages … ──
       Markdown has no way to say "a bar 70% wide in blue", so a normal rich paste keeps the words of a chart
       and loses the chart. When the clipboard HTML contains a chart (a cluster of empty coloured boxes = bars,
       or a real inline <svg> graphic) that part is kept as a ```visual fenced block holding cleaned-up HTML
       (inline styles only: no scripts, no classes, no links, no external images). The reading view draws it
       inside a Shadow DOM so the note's own CSS can't disturb it and it can't disturb the note. Everything
       around the chart is still converted to normal Markdown.
       You can also write one by hand: a ```visual fence containing HTML with inline styles. */
    const VIZ_MAX = 600000;                                        // characters of cleaned HTML per block
    const VIZ_DROP = 'script,style,link,meta,title,base,iframe,frame,object,embed,form,input,button,select,textarea,audio,video,canvas,noscript,template,foreignObject,animate,animateTransform,animateMotion,set,use,image';
    const VIZ_INHERITED = /^(color|font|font-[a-z-]+|line-height|letter-spacing|word-spacing|text-align|text-transform|text-indent|white-space|visibility|direction|list-style|list-style-[a-z-]+|-webkit-text-fill-color)$/;
    const VIZ_BAD_PROP = /^(z-index|cursor|pointer-events|behavior|-moz-binding|will-change|content|resize|user-select|-webkit-user-drag|-webkit-tap-highlight-color|animation|animation-[a-z-]+|transition|transition-[a-z-]+)$/;
    const VIZ_BAD_ATTR = /^(on.*|data-.*|class|name|for|href|src|srcset|xlink:href|tabindex|contenteditable|draggable|target|rel|download|formaction|action|poster|ping|autofocus)$/;
    function vizCleanDecls(css, parentEff, eff) {
        const out = [];
        String(css || '').split(';').forEach((d) => {
            const i = d.indexOf(':');
            if (i < 1) return;
            const k = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim().replace(/\s*!important\s*$/i, '');
            if (!k || !v || VIZ_BAD_PROP.test(k)) return;
            if (/url\s*\(|expression\s*\(|javascript:|@import|\\|[<>]/i.test(v)) return;
            if (k === 'position' && /^(fixed|sticky)$/i.test(v)) return;
            if (VIZ_INHERITED.test(k)) {                          // same as what's already inherited from the parent: no need to repeat it
                eff[k] = v;
                if (parentEff[k] === v) return;
            }
            out.push(k + ':' + v);
        });
        return out.join(';');
    }
    function vizSanitize(html) {
        html = String(html || '');
        if (!html.trim() || html.length > VIZ_MAX * 4) return '';
        let doc;
        try { doc = new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html'); } catch (e) { return ''; }
        const body = doc.body;
        if (!body) return '';
        body.querySelectorAll(VIZ_DROP).forEach((n) => n.remove());
        body.querySelectorAll('a').forEach((a) => a.replaceWith(...Array.from(a.childNodes)));   // keep the words, lose the link
        const cw = doc.createTreeWalker(body, 128 /* SHOW_COMMENT */), comments = [];
        while (cw.nextNode()) comments.push(cw.currentNode);
        comments.forEach((c) => c.remove());
        const effOf = new Map();
        body.querySelectorAll('*').forEach((n) => {               // document order: a parent is always handled before its children
            const parentEff = (n.parentElement && effOf.get(n.parentElement)) || {};
            const eff = Object.assign({}, parentEff);
            effOf.set(n, eff);
            const inSvg = !!n.closest('svg');
            Array.from(n.attributes).forEach((a) => {
                const k = a.name.toLowerCase(), v = a.value;
                if (k === 'style') return;
                if (VIZ_BAD_ATTR.test(k) || (k === 'id' && !inSvg)) { n.removeAttribute(a.name); return; }
                if (/javascript:|data:text\/html|expression\s*\(/i.test(v)) { n.removeAttribute(a.name); return; }
                if (/url\s*\(/i.test(v) && !/^\s*url\(\s*#[\w.:-]+\s*\)\s*$/.test(v)) n.removeAttribute(a.name);   // only gradient / clip references inside the same graphic
            });
            const css = vizCleanDecls(n.getAttribute('style'), parentEff, eff);
            if (css) n.setAttribute('style', css); else n.removeAttribute('style');
        });
        let out = body.innerHTML.replace(/\s*\n\s*/g, ' ').trim();
        try {
            if (window.DOMPurify) out = DOMPurify.sanitize(out, { FORBID_TAGS: ['style', 'script'], FORBID_ATTR: ['class'] });
        } catch (e) { return ''; }
        return out.length > VIZ_MAX ? '' : out;
    }
    /* A "bar" = an element with no children and no text that has a real fill colour (the coloured part of a bar,
       a legend swatch…). Chrome writes the computed fill into style="" when text is copied. */
    function vizIsBar(n) {
        if (n.nodeType !== 1 || n.children.length || /\S/.test(n.textContent || '')) return false;
        if (!/^(DIV|SPAN|I|B|P)$/.test(n.tagName)) return false;
        const raw = n.getAttribute('style') || '';
        if (!raw) return false;
        const clear = /^(transparent|none|initial|inherit|unset|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\))/i;
        let m; const re = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/gi;
        while ((m = re.exec(raw))) if (!clear.test(m[1].trim())) return true;
        return /(?:^|;)\s*background-image\s*:[^;]*gradient/i.test(raw);
    }
    function vizIsSvgChart(n) {
        if (!n || n.nodeType !== 1 || String(n.tagName).toLowerCase() !== 'svg') return false;
        const w = parseFloat(n.getAttribute('width')), h = parseFloat(n.getAttribute('height'));
        if ((w && w <= 32) || (h && h <= 32)) return false;       // an icon
        return n.querySelectorAll('rect,path,circle,line,polyline,polygon,ellipse').length >= 4;
    }
    function vizFindRoots(body) {
        const score = new Map(), roots = [];
        const bump = (n, by) => { for (let p = n.parentElement; p; p = p.parentElement) score.set(p, (score.get(p) || 0) + by); };
        body.querySelectorAll('*').forEach((n) => { if (vizIsBar(n)) bump(n, 1); else if (vizIsSvgChart(n)) bump(n, 3); });
        const hasProse = (n) => n.tagName === 'BLOCKQUOTE' || n.tagName === 'PRE' || !!n.querySelector('blockquote,pre,h1,h2,h3,h4,h5,h6,table')
            || Array.from(n.querySelectorAll('p')).some((p) => p.textContent.trim().length > 80) || (n.textContent || '').length > 3000;
        const visit = (n) => {
            const own = vizIsSvgChart(n) ? 3 : 0;
            if ((score.get(n) || 0) + own < 3) return;
            if (n !== body && !hasProse(n)) { roots.push(n); return; }   // the highest element that is "all chart" (no long paragraphs inside)
            Array.from(n.children).forEach(visit);
        };
        visit(body);
        return roots;
    }
    function vizFence(h) {
        let f = '```';
        while (h.indexOf(f) !== -1) f += '`';
        return f + 'visual\n' + h + '\n' + f;
    }

    /* ── drawing a ```visual block (Read view, print / PDF) ── */
    const VIZ_CSS = ':host{display:block}.v{box-sizing:border-box;position:relative;overflow:auto;padding:14px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2328;text-align:left;white-space:normal}.v svg{max-width:100%}';
    function vizMarkBlocks(root) {
        root.querySelectorAll('pre > code').forEach((code) => {
            if (!/(^|\s)language-visual(\s|$)/.test(code.className || '')) return;
            const box = document.createElement('div');
            box.className = 'nv-visual';
            box.setAttribute('data-viz-src', code.textContent || '');
            code.parentElement.replaceWith(box);
        });
    }
    function vizLuma(c) {
        let m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(c || '');
        if (!m) { const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c || ''); if (!h) return null; const x = h[1].length === 3 ? h[1].replace(/./g, '$&$&') : h[1]; m = [0, parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4), 16)]; }
        return 0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3];
    }
    function vizRenderPending(target) {
        target.querySelectorAll('.nv-visual[data-viz-src]').forEach((box) => {
            const src = box.getAttribute('data-viz-src') || '';
            box.removeAttribute('data-viz-src');
            const html = vizSanitize(src);
            if (!html) { box.className = 'nv-visual nv-visual-err'; box.textContent = 'This visual block is empty, or too large to draw.'; return; }
            const wrap = document.createElement('div');
            wrap.className = 'v';
            wrap.innerHTML = html;
            // Text copied from a dark page is light-coloured: give it a dark backdrop (and the reverse), whatever theme the vault is in.
            let light = 0, dark = 0;
            wrap.querySelectorAll('*').forEach((n) => {
                if (!Array.from(n.childNodes).some((t) => t.nodeType === 3 && /\S/.test(t.nodeValue))) return;
                let c = '';
                for (let p = n; p && p !== wrap; p = p.parentElement) if (p.style && p.style.color) { c = p.style.color; break; }
                const l = c ? vizLuma(c) : null;
                if (l == null) dark++; else if (l > 150) light++; else dark++;
            });
            wrap.style.background = light > dark ? '#17181c' : '#ffffff';
            box.setAttribute('role', 'group');
            box.setAttribute('aria-label', 'Chart or visual pasted into this note');
            let host = null;
            try { host = box.attachShadow ? box.attachShadow({ mode: 'open' }) : null; } catch (e) { host = null; }
            if (host) {
                const st = document.createElement('style');
                st.textContent = VIZ_CSS;
                host.append(st, wrap);
            } else box.appendChild(wrap);
        });
    }

    /* ── Paste formatted text (Word / Google Docs / web pages / ChatGPT / Claude …) → Markdown ──
       Reads text/html from the clipboard and rebuilds the formatting as Markdown: bold, italic,
       strikethrough, headings, bullet / numbered / task lists (nested too), links, images, quotes,
       code, tables and KaTeX / Wikipedia math (→ \( … \) and $$ … $$ for MathJax).
       Left alone (pastes natively): plain text, a lone URL, anything copied from a code editor
       (a single <pre>, VS Code) and anything pasted inside a ``` block.
       Ctrl/Cmd+Shift+V = paste as plain text. ── */
    function htmlToMarkdown(html) {
        if (!html || html.length > 3000000) return null;
        const frag = html.match(/<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i);
        if (frag) html = frag[1];
        let doc;
        try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return null; }
        const body = doc.body;
        if (!body) return null;
        // Charts (coloured bars / inline SVG graphics) can't be expressed in Markdown: lift each one out as a ```visual block.
        const vizBlocks = [];
        try {
            body.querySelectorAll('script,style,button').forEach((n) => n.remove());
            vizFindRoots(body).forEach((r) => {
                const h = vizSanitize(r.outerHTML);
                if (!h) return;
                const p = doc.createElement('p');
                p.textContent = 'NVVIZ' + vizBlocks.length + 'END';
                vizBlocks.push(vizFence(h));
                r.replaceWith(p);
            });
        } catch (e) { console.warn('Notes Vault: chart detection failed', e); }
        body.querySelectorAll('script,style,meta,link,title,noscript,template,button,svg,canvas,iframe,video,audio,select,textarea,.sr-only,.visually-hidden,[hidden]').forEach((n) => n.remove());
        const kids0 = Array.from(body.children);
        if (kids0.length === 1 && kids0[0].tagName === 'PRE') return null;   // a code snippet: paste it as it is

        const BLOCK_TAGS = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|TABLE|HR|SECTION|ARTICLE|HEADER|FOOTER|ASIDE|NAV|MAIN|FIGURE|FIGCAPTION|DETAILS|SUMMARY|DL|DT|DD|ADDRESS|FORM|FIELDSET|CENTER|THEAD|TBODY|TFOOT|TR|TD|TH|CAPTION)$/;
        const BLOCK_SEL = 'p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,pre,table,hr,section,article,header,footer,aside,nav,main,figure,figcaption,details,summary,dl,dt,dd,address,form,fieldset,center';
        const LISTLINE = /^\s*(?:[-*+]|\d+[.)])\s/;
        const st = (n) => (n && n.style) || {};
        const hidden = (n) => st(n).display === 'none';
        const hasBlockDesc = (n) => !!n.querySelector(BLOCK_SEL);

        /* ── what formatting an element carries (tag OR inline style — Google Docs / Word use styles) ── */
        const isBoldEl = (n) => {
            const w = String(st(n).fontWeight || '').toLowerCase();
            if (w) return w === 'bold' || w === 'bolder' || (/^\d+$/.test(w) && +w >= 600);
            return n.tagName === 'STRONG' || n.tagName === 'B';
        };
        const isItalicEl = (n) => {
            const f = String(st(n).fontStyle || '').toLowerCase();
            if (f) return f === 'italic' || f === 'oblique';
            return /^(EM|I|CITE|DFN)$/.test(n.tagName);
        };
        const isStrikeEl = (n) => /^(DEL|S|STRIKE)$/.test(n.tagName) || /line-through/.test(String(st(n).textDecoration || '') + ' ' + String(st(n).textDecorationLine || ''));
        const isMonoEl = (n) => /(consolas|courier|menlo|monaco|monospace|lucida console|source code pro|fira code|jetbrains mono|sf mono|cascadia)/i.test(String(st(n).fontFamily || ''));

        /* ── math: KaTeX / MathML annotation / Wikipedia ── */
        const cleanTex = (t) => String(t || '').replace(/^\{\\displaystyle\s*/, '').replace(/\}\s*$/, '').replace(/\s+/g, ' ').trim();
        const texOf = (n) => {
            const a = n.querySelector('annotation[encoding="application/x-tex"]');
            if (a) return cleanTex(a.textContent);
            const im = n.querySelector('img.mwe-math-fallback-image-inline,img.mwe-math-fallback-image-display');
            return im ? cleanTex(im.getAttribute('alt')) : '';
        };
        const mathOf = (n) => {
            const c = n.classList;
            if (!c) return null;
            if (c.contains('katex-display')) return { tex: texOf(n), display: true, text: n.textContent };
            if (c.contains('katex')) return { tex: texOf(n), display: false, text: n.textContent };
            if (c.contains('mwe-math-element')) return { tex: texOf(n), display: !!n.querySelector('.mwe-math-fallback-image-display,.mwe-math-mathml-display'), text: '' };
            if (n.tagName === 'MATH') return { tex: texOf(n), display: n.getAttribute('display') === 'block', text: n.textContent };
            return null;
        };

        /* ── small text helpers ── */
        const alnum = /[\p{L}\p{N}]/u;
        const esc = (s) => s.replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ')
            .replace(/\*/g, (m, o, str) => (o > 0 && o < str.length - 1 && str[o - 1] === ' ' && str[o + 1] === ' ') ? m : '\\*')
            .replace(/_/g, (m, o, str) => (o > 0 && o < str.length - 1 && alnum.test(str[o - 1]) && alnum.test(str[o + 1])) ? m : '\\_')
            .replace(/`/g, '\\`')
            .replace(/~~/g, '\\~\\~')
            .replace(/<(?=[A-Za-z\/!?])/g, '\\<');
        const encUrl = (u) => u.replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
        const wrap = (s, m) => {
            if (!s.trim()) return s;
            const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0];
            return lead + m + s.slice(lead.length, s.length - trail.length) + m + trail;
        };
        const codeSpan = (t) => {
            t = String(t).replace(/\s+/g, ' ').trim();
            if (!t) return '';
            const runs = t.match(/`+/g) || [];
            let n = 1;
            while (runs.some((r) => r.length === n)) n++;
            const f = '`'.repeat(n);
            return f + (t[0] === '`' || t[t.length - 1] === '`' ? ' ' + t + ' ' : t) + f;
        };
        const tidy = (s) => {
            const t = s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
            return t;
        };
        const joinBlocks = (arr) => arr.reduce((acc, b, i) => {
            if (!i) return b;
            const prev = arr[i - 1];                                         // consecutive list pieces of one nested list (Google Docs) stay tight
            const tight = LISTLINE.test(prev) && LISTLINE.test(b) && (/^\s/.test(b) || /(^|\n)\s+\S[^\n]*$/.test(prev));
            return acc + (tight ? '\n' : '\n\n') + b;
        }, '');
        const joinLi = (arr) => arr.reduce((acc, b, i) => (!i ? b : acc + (LISTLINE.test(b) ? '\n' : '\n\n') + b), '');
        const imgOk = (n) => {
            const src = (n.getAttribute('src') || '').trim();
            if (!/^https?:\/\//i.test(src)) return false;
            const w = parseInt(n.getAttribute('width'), 10), h = parseInt(n.getAttribute('height'), 10);
            return !((w && w <= 2) || (h && h <= 2));
        };

        /* ── inline content ── */
        function inlineKids(n, ctx) { return Array.from(n.childNodes).map((k) => inline(k, ctx)).join(''); }
        function linkMd(n, inner) {
            const raw = (n.getAttribute('href') || '').trim();
            if (!/^(https?:\/\/|mailto:|tel:)/i.test(raw) || !inner.trim()) return inner;
            if (n.textContent.trim() === raw) return raw;                      // the URL as its own label → bare URL
            const lead = inner.match(/^\s*/)[0], trail = inner.match(/\s*$/)[0];
            let core = inner.slice(lead.length, inner.length - trail.length);
            if (core.indexOf('![') === -1) core = core.replace(/([\[\]])/g, '\\$1');
            return lead + '[' + core + '](' + encUrl(raw) + ')' + trail;
        }
        function imageMd(n) {
            if (!imgOk(n)) return '';
            const alt = (n.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
            if (/\bemoji\b/i.test(n.getAttribute('class') || '') && alt) return alt;
            return '![' + alt.replace(/[\[\]]/g, '\\$&') + '](' + encUrl(n.getAttribute('src').trim()) + ')';
        }
        function inline(n, ctx) {
            if (n.nodeType === 3) return esc(n.nodeValue);
            if (n.nodeType !== 1 || hidden(n)) return '';
            const tag = n.tagName;
            const mth = mathOf(n);
            if (mth) return mth.tex ? '\\(' + mth.tex + '\\)' : esc(mth.text || '');
            if (tag === 'BR') return '\n';
            if (tag === 'WBR' || tag === 'INPUT') return '';
            if (tag === 'IMG') return imageMd(n);
            if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') return codeSpan(n.textContent);
            if ((tag === 'SPAN' || tag === 'FONT') && isMonoEl(n) && n.textContent.trim() && !n.querySelector('img,a')) return codeSpan(n.textContent);
            if (BLOCK_TAGS.test(tag)) return ' ' + inlineKids(n, ctx) + ' ';
            const bold = !ctx.bold && isBoldEl(n), ital = !ctx.ital && isItalicEl(n), strike = !ctx.strike && isStrikeEl(n);
            const c = (bold || ital || strike) ? Object.assign({}, ctx, { bold: ctx.bold || bold, ital: ctx.ital || ital, strike: ctx.strike || strike }) : ctx;
            let out = inlineKids(n, c);
            if (tag === 'A') out = linkMd(n, out);
            const va = String(st(n).verticalAlign || '').toLowerCase();
            if (out.trim() && (tag === 'SUP' || va === 'super')) out = '<sup>' + out.trim() + '</sup>';
            else if (out.trim() && (tag === 'SUB' || va === 'sub')) out = '<sub>' + out.trim() + '</sub>';
            if (ital) out = wrap(out, '*');
            if (bold) out = wrap(out, '**');
            if (strike) out = wrap(out, '~~');
            return out;
        }

        /* ── block content ── */
        function wordItem(p, ctx) {
            const m = (p.getAttribute('style') || '').match(/mso-list:[^;]*?level(\d+)/i);
            const level = m ? +m[1] : 1;
            const clone = p.cloneNode(true);
            let marker = '';
            clone.querySelectorAll('span').forEach((s) => {
                if (/mso-list:\s*Ignore/i.test(s.getAttribute('style') || '')) { marker += s.textContent; s.remove(); }
            });
            marker = marker.replace(/[\s\u00a0]+/g, '');
            const text = tidy(inlineKids(clone, ctx)).replace(/\n+/g, ' ');
            if (!text) return null;
            const id = (p.getAttribute('style') || '').match(/mso-list:\s*(l\d+)/i);
            return { level, id: id ? id[1] : '', ordered: /^(?:\d+|[a-z]|[ivxlcdm]+)[.)]$/i.test(marker), text };
        }
        function wordListMd(items) {
            let cnt = {};                                                    // counters per "list id : level"
            return items.map((it) => {
                Object.keys(cnt).forEach((k) => { const [i, l] = k.split(':'); if (i === it.id && +l > it.level) delete cnt[k]; });   // a shallower item restarts the deeper levels
                const key = it.id + ':' + it.level;
                cnt[key] = (cnt[key] || 0) + 1;
                return '    '.repeat(it.level - 1) + (it.ordered ? cnt[key] + '. ' : '- ') + it.text;
            }).join('\n');
        }
        function codeBlock(pre) {
            const code = pre.querySelector('code');
            const src = (code || pre).cloneNode(true);
            src.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
            const lang = ((code && code.getAttribute('class')) || pre.getAttribute('class') || '').match(/(?:language|lang)-([\w#+-]+)/i);
            const t = src.textContent.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/^\n+/, '').replace(/\s+$/, '');
            if (!t.trim()) return '';
            let fence = '```';
            while (t.indexOf(fence) !== -1) fence += '`';
            return fence + (lang ? lang[1] : '') + '\n' + t + '\n' + fence;
        }
        function listMd(list, ctx) {
            const ordered = list.tagName === 'OL';
            let idx = parseInt(list.getAttribute('start'), 10);
            if (isNaN(idx)) idx = 1;
            const lctx = Object.assign({}, ctx, { depth: (ctx.depth || 0) + 1 });
            const lines = [];
            Array.from(list.children).forEach((li) => {
                if (li.tagName === 'UL' || li.tagName === 'OL') {                      // list nested straight inside a list
                    const sub = listMd(li, lctx);
                    if (sub) lines.push(sub.split('\n').map((l) => l ? '    ' + l : l).join('\n'));
                    return;
                }
                if (li.tagName !== 'LI' || hidden(li)) return;
                const cb = li.querySelector('input[type="checkbox"]');
                const own = cb && cb.closest('li') === li ? cb : null;
                const task = own ? ((own.checked || own.hasAttribute('checked')) ? '[x] ' : '[ ] ') : '';
                const parts = blocks(li, lctx).filter(Boolean);
                if (!parts.length && !task) return;
                const marker = ordered ? (idx++) + '. ' : '- ';
                const pad = ' '.repeat(marker.length);
                const body = joinLi(parts).split('\n').map((l, i) => i === 0 ? l : (l ? pad + l : l)).join('\n');
                let item = marker + task + body;
                const lvl = parseInt(li.getAttribute('aria-level'), 10);             // Google Docs flattens nesting into aria-level
                if (!ctx.depth && lvl > 1) item = item.split('\n').map((l) => l ? '    '.repeat(lvl - 1) + l : l).join('\n');
                lines.push(item);
            });
            return lines.join('\n');
        }
        function tableMd(tbl, ctx) {
            const rows = [];
            tbl.querySelectorAll('tr').forEach((tr) => {
                if (tr.closest('table') !== tbl) return;
                const cells = [];
                Array.from(tr.children).forEach((c) => {
                    if (!/^(TD|TH)$/.test(c.tagName)) return;
                    cells.push(joinBlocks(blocks(c, ctx)).replace(/\n+/g, '\u0001'));
                    for (let k = 1; k < (parseInt(c.getAttribute('colspan'), 10) || 1); k++) cells.push('');
                });
                rows.push(cells);
            });
            return rowsToMarkdownTable(rows)
                || rows.map((r) => r.map((c) => c.replace(/\u0001/g, ' ')).filter(Boolean).join(' — ')).filter(Boolean).join('\n\n');
        }
        function block(n, ctx, out) {
            const tag = n.tagName;
            if (/^H[1-6]$/.test(tag)) {
                const t = tidy(inlineKids(n, Object.assign({}, ctx, { bold: true }))).replace(/\n+/g, ' ');
                if (t) out.push('#'.repeat(+tag[1]) + ' ' + t);
            } else if (tag === 'HR') out.push('---');
            else if (tag === 'PRE') { const c = codeBlock(n); if (c) out.push(c); }
            else if (tag === 'UL' || tag === 'OL') { const l = listMd(n, ctx); if (l) out.push(l); }
            else if (tag === 'BLOCKQUOTE') {
                const inner = joinBlocks(blocks(n, ctx));
                if (inner) out.push(inner.split('\n').map((l) => l ? '> ' + l : '>').join('\n'));
            } else if (tag === 'TABLE') { const t = tableMd(n, ctx); if (t) out.push(t); }
            else blocks(n, ctx).forEach((b) => out.push(b));
        }
        function blocks(parent, ctx) {
            const out = [];
            let run = '', wl = [];
            const flushRun = () => { const t = tidy(run); run = ''; if (t) out.push(t); };
            const flushWl = () => { if (wl.length) { out.push(wordListMd(wl)); wl = []; } };
            Array.from(parent.childNodes).forEach((n) => {
                if (n.nodeType === 3) {
                    if (!/\S/.test(n.nodeValue)) { run += ' '; return; }
                    flushWl(); run += esc(n.nodeValue); return;
                }
                if (n.nodeType !== 1 || hidden(n)) return;
                const tag = n.tagName;
                const mth = mathOf(n);
                if (mth && mth.display && mth.tex) { flushRun(); flushWl(); out.push('$$\n' + mth.tex + '\n$$'); return; }
                if (tag === 'P' && /mso-list/i.test(n.getAttribute('style') || '') && !/mso-list:\s*none/i.test(n.getAttribute('style') || '')) {
                    flushRun();
                    const it = wordItem(n, ctx);
                    if (it) { wl.push(it); return; }
                }
                flushWl();
                if (!BLOCK_TAGS.test(tag) && !hasBlockDesc(n)) { run += inline(n, ctx); return; }
                flushRun();
                block(n, ctx, out);
            });
            flushRun(); flushWl();
            return out;
        }

        /* ── is there anything worth converting? (otherwise let the browser paste natively) ── */
        const total = body.textContent.replace(/\s+/g, '').length;
        if (!total) return null;                                             // only images: the image-attachment path handles those
        const rich = () => {
            if (vizBlocks.length) return true;
            for (const e of Array.from(body.querySelectorAll('*'))) {
                const tag = e.tagName;
                if (/^(H[1-6]|UL|OL|BLOCKQUOTE|TABLE|HR)$/.test(tag) || mathOf(e)) return true;
                if (tag === 'P' && /mso-list/i.test(e.getAttribute('style') || '') && !/mso-list:\s*none/i.test(e.getAttribute('style') || '')) return true;   // Word list paragraph
                if (tag === 'IMG') { if (imgOk(e)) return true; continue; }
                const txt = e.textContent.trim();
                if (!txt || BLOCK_TAGS.test(tag)) continue;
                if (tag === 'A' && /^(https?:|mailto:)/i.test(e.getAttribute('href') || '')) return true;
                if (isBoldEl(e) || isItalicEl(e) || isStrikeEl(e)) return true;
                if ((tag === 'CODE' || tag === 'KBD') && !e.closest('pre') && txt.replace(/\s+/g, '').length < total) return true;
            }
            const pre = body.querySelector('pre');
            return !!(pre && pre.textContent.replace(/\s+/g, '').length < total);
        };
        if (!rich()) return null;

        let md = joinBlocks(blocks(body, {})).replace(/\n{3,}/g, '\n\n').trim();
        md = md.replace(/(\S)\*\*\*\*(?=\S)/g, '$1').replace(/(\S)\*\* \*\*(?=\S)/g, '$1 ')
            .replace(/(\S)~~~~(?=\S)/g, '$1').replace(/(\S)~~ ~~(?=\S)/g, '$1 ');   // adjacent runs with the same format → one run
        if (vizBlocks.length) md = md.replace(/NVVIZ(\d+)END/g, (m, i) => '\n\n' + (vizBlocks[+i] || '') + '\n\n').replace(/\n{3,}/g, '\n\n').trim();
        return md || null;
    }
    function richPasteMarkdown(cd, value, pos) {
        if (!cd) return null;
        if (Array.from(cd.types || []).indexOf('vscode-editor-data') !== -1) return null;   // copied from VS Code: keep as plain code text
        const html = cd.getData('text/html') || '';
        if (!html || !/<[a-z][\s\S]*>/i.test(html)) return null;
        const plain = (cd.getData('text/plain') || '').trim();
        if (/^https?:\/\/\S+$/.test(plain)) return null;                                    // lone URL: the link / Source Capture logic below handles it
        if (FRONTMATTER_RE.test(plain)) return null;                                        // an Obsidian note with frontmatter: keep verbatim
        if (inFence(value, pos)) return null;                                               // inside a ``` block: paste as-is
        try { return htmlToMarkdown(html); }
        catch (err) { console.warn('Notes Vault: rich paste conversion failed — pasting as plain text', err); return null; }
    }
    function insertPastedRich(md, plain) {
        const ta = el.src, v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
        const before = v.slice(0, s), after = v.slice(en);
        let text = md;
        if (/\n/.test(md) || /^(#{1,6} |> |[-*+] |\d+\. |\||```|\$\$|---$)/.test(md)) {      // block-level result: keep it on its own lines
            const pre = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
            const suf = after === '' ? '' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
            text = pre + md + suf;
        }
        replaceRange(s, en, text, s + text.length);
        markDirty();
        toast('Pasted with formatting', 'Paste as text', () => {
            ta.focus();
            try { document.execCommand('undo'); } catch (err) { /* fall through */ }
            if (ta.value === v) { replaceRange(s, en, plain, s + plain.length); markDirty(); }
        });
    }
    async function onEditorPaste(e) {
        const ta = el.src, s = ta.selectionStart, en = ta.selectionEnd;
        const forcePlain = plainPasteOnce; plainPasteOnce = false;
        if (!forcePlain) {
            const tableMd = tableMarkdownFromClipboard(e.clipboardData);
            if (tableMd) {   // checked before images: Excel also puts a screenshot of the range on the clipboard
                e.preventDefault();
                if (insertPastedTable(tableMd, e.clipboardData.getData('text/plain'))) return;
                const p = ta.selectionStart; replaceRange(p, ta.selectionEnd, e.clipboardData.getData('text/plain'), p + e.clipboardData.getData('text/plain').length); markDirty();
                return;
            }
            // Formatted text (bold / italic / headings / lists / links / quotes / code / math…) → Markdown
            const richMd = richPasteMarkdown(e.clipboardData, ta.value, s);
            if (richMd) { e.preventDefault(); insertPastedRich(richMd, e.clipboardData.getData('text/plain')); return; }
        }
        const imgFiles = getImageFilesFromClipboard(e.clipboardData);
        // An image copied from a note here carries its `![](attachment://id)` reference next to the PNG. Paste the reference when
        // that image exists in this vault: same stored bytes, so no re-encode / no blur / no duplicate. Otherwise fall back to the PNG.
        const refTxt = ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').trim();
        const refM = /^!\[[^\]]*\]\(attachment:\/\/(att_[A-Za-z0-9_-]+)\)$/.exec(refTxt);
        if (refM) {
            e.preventDefault();   // before the first await, so the editor knows the paste is handled
            const hit = await dbGetAttachment(refM[1]).catch(() => null);
            if (hit && hit.blob) { replaceRange(s, en, refTxt, s + refTxt.length); markDirty(); }
            else if (imgFiles.length) insertAttachments(imgFiles);
            else toast('That image isn’t in this vault, so only its link could be pasted.');
            return;
        }
        if (imgFiles.length) { e.preventDefault(); insertAttachments(imgFiles); return; }
        const t = ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').trim();
        // Nothing usable in the DataTransfer synchronously, but it's flagged as carrying a
        // file with no text alongside it — the shape a screenshot tool leaves when it doesn't
        // populate DataTransfer.items the way we expect. Worth the async Clipboard API fallback.
        const filesHint = e.clipboardData && Array.from(e.clipboardData.types || []).includes('Files');
        if (!t && filesHint) {
            e.preventDefault();
            const imgs = await tryClipboardReadImage();
            if (imgs.length) insertAttachments(imgs);
            else toast('Couldn’t read that image from the clipboard.');
            return;
        }
        const isLoneUrl = /^https?:\/\/\S+$/.test(t);
        // Paste a URL over selected words → [words](url)
        if (s !== en) {
            const sel = ta.value.slice(s, en);
            if (isLoneUrl && !sel.includes('\n')) {
                e.preventDefault();
                replaceRange(s, en, '[' + sel + '](' + t + ')', s + sel.length + t.length + 4);
            }
            return;
        }
        // Source Capture: a bare URL pasted into an otherwise-empty note becomes a sourced clip
        if (isLoneUrl && !ta.value.trim()) {
            e.preventDefault();
            captureSource(t);
            return;
        }
        // Pasting an Obsidian-style "---…---" note into an empty note pre-fills Folder/Tags/
        // Title from its frontmatter. Default paste isn't prevented — the block stays in the
        // note's own markdown/Edit mode, it's only hidden from Read mode (see renderInto).
        if (!ta.value.trim() && FRONTMATTER_RE.test(t)) {
            setTimeout(() => applyFrontmatterFill(t), 0);
        }
    }

    /* ═════════════ Focus reading mode ═════════════
       Hides sidebar, inspector and status bar so the note fills the screen.
       Text size and line width are remembered on this device. */
    const FS_OLD_STEPS = [0.95, 1.0625, 1.1875, 1.3125, 1.4375];   // pre-v2 saved indexes refer to this list
    const FS_STEPS = [0.65, 0.72, 0.8, 0.88, 0.95, 1.0625, 1.1875, 1.3125, 1.4375, 1.6, 1.8, 2.05, 2.3, 2.6];
    const WD_STEPS = [
        { n: 'Narrow', w: '38rem', we: '56rem' },
        { n: 'Medium', w: '46rem', we: '74rem' },
        { n: 'Wide', w: '58rem', we: '96rem' }
    ];
    try {
        const r = JSON.parse(localStorage.getItem('nvReading') || 'null');
        if (r && r.v === 2 && r.fs >= 0 && r.fs < FS_STEPS.length) S.fs = r.fs | 0;
        else if (r && r.fs >= 0 && r.fs < FS_OLD_STEPS.length) S.fs = FS_STEPS.indexOf(FS_OLD_STEPS[r.fs | 0]);   // migrate old saved size
        if (r && r.wd >= 0 && r.wd < WD_STEPS.length) S.wd = r.wd | 0;
    } catch (e) { /* ignore */ }
    try {
        const d = localStorage.getItem('nvDensity');
        if (d === 'compact' || d === 'comfortable') S.density = d;
    } catch (e) { /* ignore */ }
    loadFolderStyles();
    try {
        const t = localStorage.getItem('nvTheme');
        if (t === 'sakura' || t === 'comfort' || t === 'blue' || t === 'red' || t === 'sage' || t === 'monastic' || t === 'nordic' || t === 'petrol' || t === 'ink' || t === 'rosewood' || t === 'peach' || t === 'lavender' || t === 'dustylilac' || t === 'eucalyptus' || t === 'oxford' || t === 'library' || t === 'coffee' || t === 'slate' || t === 'ocean' || t === 'mono' || t === 'espresso' || t === 'matcha' || t === 'blueberry' || t === 'terracotta' || t === 'airy') S.theme = t;
    } catch (e) { /* ignore */ }
    function applyTheme() {
        el.overlay.dataset.nvTheme = S.theme;
        const label = { comfort: 'Comfort Bloom', blue: 'Misty Blue', red: 'Poppy Red', sage: 'Sage Focus', monastic: 'Monastic Coffee', nordic: 'Nordic Moss', petrol: 'Deep Petrol', ink: 'Ink & Parchment', rosewood: 'Rosewood', peach: 'Peach Milk', lavender: 'Lavender Haze', dustylilac: 'Dusty Lilac', eucalyptus: 'Eucalyptus', oxford: 'Oxford Paper', library: 'Library Green', coffee: 'Coffee Paper', slate: 'Midnight Slate', ocean: 'Deep Ocean', mono: 'Monochrome', espresso: 'Espresso Night', matcha: 'Matcha Milk', blueberry: 'Blueberry Cream', terracotta: 'Terracotta Paper', airy: 'Airy Gray' }[S.theme] || 'Sakura Mist';
        el.themeBtn.title = 'Vault theme: ' + label;
        el.themeMenu.querySelectorAll('.nv-sort-opt').forEach((o) => o.setAttribute('aria-checked', String(o.dataset.theme === S.theme)));
    }
    function applyDensity() {
        const compact = S.density === 'compact';
        el.app.dataset.density = S.density;
        el.densityBtn.setAttribute('aria-pressed', String(compact));
        el.densityBtn.title = compact ? 'Density: Compact — click for Comfortable' : 'Density: Comfortable — click for Compact';
        el.densityBtn.querySelector('.nv-btn-label').textContent = compact ? 'Compact' : 'Comfortable';
        el.densityBtn.querySelector('i').className = 'fa-solid fa-' + (compact ? 'table-list' : 'list');
    }
    function toggleDensity() {
        S.density = S.density === 'compact' ? 'comfortable' : 'compact';
        try { localStorage.setItem('nvDensity', S.density); } catch (e) { /* ignore */ }
        applyDensity();
    }
    function applyFontSize() {
        // Applied unconditionally (unlike --nv-w below) so text size works the same
        // whether or not Focus mode is on, and reaches Edit mode too — .nv-src reads
        // the same --nv-fs variable. See the A−/A+ buttons in the main doc toolbar.
        el.app.style.setProperty('--nv-fs', FS_STEPS[S.fs] + 'rem');
        el.fsDown.disabled = S.fs === 0;
        el.fsUp.disabled = S.fs === FS_STEPS.length - 1;
    }
    function applyFocus() {
        const on = S.focus;
        el.app.classList.toggle('nv-focus', on);
        el.overlay.classList.toggle('nv-focus-on', on);
        el.focusBtn.setAttribute('aria-pressed', String(on));
        el.focusBtn.title = on ? 'Exit focus mode (Esc)' : 'Focus mode (Ctrl+Shift+F)';
        const ic = el.focusBtn.querySelector('i');
        if (ic) ic.className = 'fa-solid fa-' + (on ? 'compress' : 'expand');
        if (on) {
            el.app.style.setProperty('--nv-w', WD_STEPS[S.wd].w);
            el.app.style.setProperty('--nv-w-edit', WD_STEPS[S.wd].we);
        } else {
            el.app.style.removeProperty('--nv-w');
            el.app.style.removeProperty('--nv-w-edit');
        }
        el.widthBtn.textContent = WD_STEPS[S.wd].n;
        fitTitle();
        updateProgress();
        ppApply();
    }
    function saveReading() { try { localStorage.setItem('nvReading', JSON.stringify({ fs: S.fs, wd: S.wd, v: 2 })); } catch (e) { /* ignore */ } }
    function toggleFocus(force) {
        if (!S.note) return;
        S.focus = force === undefined ? !S.focus : !!force;
        if (S.focus) { S.sideOpen = false; closeMenus(); }
        applyLayout();
        applyFocus();
    }

    /* ═════════════ Focus-mode PDF split ═════════════
       In Focus mode the Split-view button opens a PDF on the right instead of an edit/preview pair.
       The note on the left stays in whatever view it was in — normally Read, where a click on any
       block turns it into an editor in place — so reading is undisturbed and editing is one click away.
       The PDF is shown with the browser's own viewer (same as the inline PDF cards), taken from:
       the PDF remembered for this note → the first PDF embedded in the note → "no PDF yet".
       Pick any PDF stored in the vault, or open one from the computer (viewed only, never stored). */
    var PP_ON_KEY = 'nvPdfSplitOn', PP_W_KEY = 'nvPdfSplitW', PP_MAP_KEY = 'nvPdfSplitFor';
    var pp = { on: false, w: 48, noteId: null, url: null, rec: null, seq: 0, menuOpen: false, wired: false };
    function ppGet(id) { return document.getElementById(id); }
    function ppIsPdf(rec) { return !!rec && (rec.mime === 'application/pdf' || /\.pdf$/i.test(rec.filename || '')); }
    function ppLoadPrefs() {
        try {
            const w = parseFloat(localStorage.getItem(PP_W_KEY));
            if (w >= 25 && w <= 75) pp.w = w;
            pp.on = localStorage.getItem(PP_ON_KEY) === '1';
        } catch (e) { /* prefs are optional */ }
    }
    function ppRemember(noteId, attId) {
        try {
            const m = JSON.parse(localStorage.getItem(PP_MAP_KEY) || '{}') || {};
            if (attId) m[noteId] = attId; else delete m[noteId];
            localStorage.setItem(PP_MAP_KEY, JSON.stringify(m));
        } catch (e) { /* optional */ }
    }
    function ppRemembered(noteId) { try { return (JSON.parse(localStorage.getItem(PP_MAP_KEY) || '{}') || {})[noteId] || null; } catch (e) { return null; } }
    function ppVisible() { return !!(S.focus && pp.on && S.note); }
    function ppSetWidth(w, save) {
        pp.w = Math.min(75, Math.max(25, w));
        el.app.style.setProperty('--nv-pdf-w', pp.w + '%');
        if (save) { try { localStorage.setItem(PP_W_KEY, String(Math.round(pp.w * 10) / 10)); } catch (e) { /* optional */ } }
    }
    function ppApply() {
        if (!pp.wired) return;
        rpGuardSame();
        const vis = ppVisible();
        el.app.classList.toggle('nv-pdf-on', vis);
        ppGet('nvPdfPane').hidden = !vis;
        el.modeSplit.setAttribute('aria-pressed', String(S.focus ? pp.on : S.split));
        el.modeSplit.title = S.focus ? 'Split view: a PDF or another note on the right (switch with the PDF / Note tabs)' : 'Split view: edit on the left, live preview on the right';
        if (vis) { rpApplyView(); if (rp.view === 'note') rpEnter(); else ppLoadForNote(); }
        else { ppCloseMenu(); rpCloseMenu(); rpFlush(); }
    }
    function ppRelease() {
        pp.seq++;
        const fr = ppGet('nvPdfFrame');
        if (fr) fr.src = 'about:blank';
        if (pp.url) { try { URL.revokeObjectURL(pp.url); } catch (e) { /* ignore */ } }
        pp.url = null; pp.rec = null; pp.noteId = null;
        const pane = ppGet('nvPdfPane');
        if (pane) pane.classList.remove('nv-pdf-has');
        const nm = ppGet('nvPdfName'); if (nm) nm.textContent = 'No PDF open';
        const sz = ppGet('nvPdfSize'); if (sz) sz.textContent = '';
        const nt = ppGet('nvPdfNewTab'); if (nt) nt.disabled = true;
    }
    function ppShow(rec, remember) {
        if (!rec || !(rec.blob instanceof Blob)) return false;
        const fr = ppGet('nvPdfFrame'), pane = ppGet('nvPdfPane');
        if (pp.url) { try { URL.revokeObjectURL(pp.url); } catch (e) { /* ignore */ } }
        let url;
        try { url = URL.createObjectURL(rec.blob); } catch (e) { return false; }
        pp.url = url; pp.rec = rec;
        const name = (rec.filename || 'PDF document').replace(/^📄\s*/, '');
        fr.title = name;
        fr.src = url + '#view=FitH';
        ppGet('nvPdfName').textContent = name;
        ppGet('nvPdfName').title = name;
        ppGet('nvPdfSize').textContent = rec.size ? fmtBytes(rec.size) : '';
        ppGet('nvPdfNewTab').disabled = false;
        pane.classList.add('nv-pdf-has');
        if (remember && S.note && rec.id) ppRemember(S.note.id, rec.id);
        return true;
    }
    async function ppLoadForNote() {
        const note = S.note;
        if (!note || pp.noteId === note.id) return;
        ppRelease();
        pp.noteId = note.id;
        const seq = ++pp.seq;
        const fetchRec = async (id) => {
            let rec = S.attachmentCache.get(id);
            if (!rec || !(rec.blob instanceof Blob)) { try { rec = await dbGetAttachment(id); } catch (e) { rec = null; } }
            return ppIsPdf(rec) ? rec : null;
        };
        let rec = null;
        const saved = ppRemembered(note.id);
        if (saved) rec = await fetchRec(saved);
        if (!rec) {
            const re = /attachment:\/\/([A-Za-z0-9_-]+)/g, md = note.markdown || '';
            let m;
            while (!rec && (m = re.exec(md))) rec = await fetchRec(m[1]);
        }
        if (seq !== pp.seq || !ppVisible() || S.note !== note) return;   // moved on while loading
        if (rec) ppShow(rec, false);
        else ppGet('nvPdfEmptyMsg').innerHTML = 'Open a PDF to read it beside this note.<br>Drop a PDF file here, or pick one.';
    }
    function ppToggle(force) {
        if (!S.note) return;
        const next = force === undefined ? !(S.focus && pp.on) : !!force;
        pp.on = next;
        try { localStorage.setItem(PP_ON_KEY, next ? '1' : '0'); } catch (e) { /* optional */ }
        if (next && !S.focus) { toggleFocus(true); }
                // Left side = the note as a normal-looking page you can click into to edit in place (Live preview).
        // Source mode is left alone; Read and the old edit+preview pair become Live.
        if (next && (S.mode === 'read' || S.split)) setMode('live');
        ppApply();
    }
    function ppCloseMenu() {
        if (!pp.menuOpen) return false;
        pp.menuOpen = false;
        ppGet('nvPdfMenu').classList.remove('nv-open');
        ppGet('nvPdfPick').setAttribute('aria-expanded', 'false');
        return true;
    }
    async function ppOpenMenu() {
        const menu = ppGet('nvPdfMenu'), btn = ppGet('nvPdfPick');
        if (pp.menuOpen) { ppCloseMenu(); return; }
        menu.textContent = '';
        const add = (icon, label, small, run) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'nv-act'; b.setAttribute('role', 'menuitem');
            const i = document.createElement('i'); i.className = 'fa-solid fa-' + icon; i.setAttribute('aria-hidden', 'true');
            const sp = document.createElement('span'); sp.textContent = label; sp.title = label;
            b.append(i, sp);
            if (small) { const sm = document.createElement('small'); sm.textContent = small; b.appendChild(sm); }
            b.addEventListener('click', () => { ppCloseMenu(); run(); });
            menu.appendChild(b);
        };
        add('upload', 'Open a file from this computer…', '', () => ppGet('nvPdfLocal').click());
        menu.lastChild.title = 'Just viewed — the file is not saved into the vault';
        const h = document.createElement('div'); h.className = 'nv-pdfmenu-h'; h.textContent = 'PDFs in your vault';
        menu.appendChild(h);
        menu.classList.add('nv-open'); pp.menuOpen = true; btn.setAttribute('aria-expanded', 'true');
        let items = [];
        try { items = (await getAttachmentsOverview()).filter((it) => ppIsPdf(it.rec)); } catch (e) { items = []; }
        const nid = S.note && S.note.id;
        items.sort((a, b) => (b.noteIds.includes(nid) - a.noteIds.includes(nid)) || ((b.rec.createdAt || 0) - (a.rec.createdAt || 0)));
        if (!pp.menuOpen) return;
        if (!items.length) {
            const e = document.createElement('div'); e.className = 'nv-pdfmenu-h'; e.style.textTransform = 'none'; e.style.letterSpacing = '0';
            e.textContent = 'None yet — attach a PDF to a note first.';
            menu.appendChild(e);
        }
        items.forEach((it) => add('file-pdf', it.rec.filename || 'PDF document', it.noteIds.includes(nid) ? 'this note' : fmtBytes(it.rec.size), () => ppShow(it.rec, true)));
    }
    function ppOpenLocal(file) {
        if (!file) return;
        if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''))) { flash('That is not a PDF file'); return; }
        // Viewed straight from the file: not stored in the vault, so nothing is remembered for the note.
        if (S.note) ppRemember(S.note.id, null);
        rpSetView('pdf');   // a PDF dropped while the Note tab is showing switches back to the PDF tab
        ppShow({ blob: file, filename: file.name, size: file.size, mime: 'application/pdf' }, false);
    }
    function ppWire() {
        if (pp.wired) return;
        const pane = ppGet('nvPdfPane'), grip = ppGet('nvPdfGrip'), body = ppGet('nvDocBody');
        if (!pane) return;
        pp.wired = true;
        ppLoadPrefs();
        ppSetWidth(pp.w, false);
        ppGet('nvPdfPick').addEventListener('click', (e) => { e.stopPropagation(); ppOpenMenu(); });
        ppGet('nvPdfEmptyPick').addEventListener('click', (e) => { e.stopPropagation(); ppOpenMenu(); });
        ppGet('nvPdfClose').addEventListener('click', () => ppToggle(false));
        ppGet('nvPdfNewTab').addEventListener('click', () => { if (pp.url) window.open(pp.url, '_blank', 'noopener'); });
        ppGet('nvPdfLocal').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; ppOpenLocal(f); });
        document.addEventListener('click', (e) => { if (pp.menuOpen && !e.target.closest('#nvPdfMenu, #nvPdfPick, #nvPdfEmptyPick')) ppCloseMenu(); });
        // drop a PDF anywhere on the panel
        const isFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0;
        pane.addEventListener('dragover', (e) => { if (!isFiles(e)) return; e.preventDefault(); pane.classList.add('nv-pdf-drop'); });
        pane.addEventListener('dragleave', (e) => { if (!pane.contains(e.relatedTarget)) pane.classList.remove('nv-pdf-drop'); });
        pane.addEventListener('drop', (e) => {
            if (!isFiles(e)) return;
            e.preventDefault(); e.stopPropagation(); pane.classList.remove('nv-pdf-drop');
            ppOpenLocal(Array.from(e.dataTransfer.files).find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) || e.dataTransfer.files[0]);
        });
        // drag the divider (the iframe is made click-through while dragging so it can't swallow the pointer)
        grip.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            e.preventDefault();
            grip.setPointerCapture(e.pointerId);
            pane.classList.add('nv-pdf-drag'); document.body.classList.add('nv-pdf-resizing');
            const move = (ev) => {
                const r = body.getBoundingClientRect();
                if (!r.width) return;
                ppSetWidth((r.right - ev.clientX) / r.width * 100, false);
            };
            const up = () => {
                grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
                pane.classList.remove('nv-pdf-drag'); document.body.classList.remove('nv-pdf-resizing');
                ppSetWidth(pp.w, true);
            };
            grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
        });
        grip.addEventListener('dblclick', () => ppSetWidth(48, true));
        grip.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); ppSetWidth(pp.w + 3, true); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); ppSetWidth(pp.w - 3, true); }
        });
        rpWire();
        ppApply();
    }


    /* ═════════════ Right panel · Note view ═════════════
       The panel on the right of Focus mode has two tabs: PDF (above) and Note. The Note tab shows a second
       note that can be read AND edited while the first stays open on the left. It is saved on its own
       (rpFlush — same steps as flushSave: write to IndexedDB, sync attachments, refresh the lists, keep
       versions), so the two notes can never overwrite each other. The same note cannot be open on both
       sides: whichever side opens it second wins and the other side is cleared.
         • Tab switch / choice are remembered (nvRightPaneView, nvRightPaneNote).
         • Click a [[link]] on the right to open it on the right; Shift+click opens it on the left.
         • Ctrl/⌘+click a [[link]] on the left opens it on the right. */
    var RP_VIEW_KEY = 'nvRightPaneView', RP_NOTE_KEY = 'nvRightPaneNote';
    var rp = { view: 'pdf', note: null, restoreId: null, dirty: false, edit: false, timer: null, menuOpen: false,
               urls: [], base: null, edited: false, editStart: 0, lastMd: '', syncTimer: 0, wired: false };
    function rpLoadPrefs() {
        try {
            rp.view = localStorage.getItem(RP_VIEW_KEY) === 'note' ? 'note' : 'pdf';
            rp.restoreId = localStorage.getItem(RP_NOTE_KEY) || null;
        } catch (e) { /* prefs are optional */ }
    }
    function rpRememberNote(id) { try { if (id) localStorage.setItem(RP_NOTE_KEY, id); else localStorage.removeItem(RP_NOTE_KEY); } catch (e) { /* optional */ } }
    function rpApplyView() {
        const pane = ppGet('nvPdfPane'); if (!pane) return;
        pane.dataset.view = rp.view;
        [['nvRpTabPdf', 'pdf'], ['nvRpTabNote', 'note']].forEach(([id, v]) => {
            const b = ppGet(id); b.setAttribute('aria-selected', String(rp.view === v)); b.tabIndex = rp.view === v ? 0 : -1;
        });
        if (rp.view !== 'note') rpCloseMenu(); else ppCloseMenu();
    }
    function rpSetView(v) {
        v = v === 'note' ? 'note' : 'pdf';
        rp.view = v;
        try { localStorage.setItem(RP_VIEW_KEY, v); } catch (e) { /* optional */ }
        rpApplyView();
        if (!ppVisible()) return;
        if (v === 'note') rpEnter(); else ppLoadForNote();
    }
    function rpEnter() {
        if (!rp.note && rp.restoreId) {
            const id = rp.restoreId; rp.restoreId = null;
            const n = S.notes.find((x) => x.id === id);
            if (n && !(S.note && S.note.id === n.id)) { rpBind(n); return; }
        }
        rpRender();
    }
    function rpRevokeUrls(list) { (list || rp.urls).forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } }); }
    function rpRenderRead() {
        const n = rp.note, read = ppGet('nvRpRead'); if (!n || !read) return;
        const old = rp.urls; rp.urls = [];
        // `urls` keeps this pane's images apart from the left pane's, so neither revokes the other's blob: URLs
        Promise.resolve(renderInto(read, n.markdown || '', true, { urls: rp.urls })).catch(() => {});
        rpRevokeUrls(old);
    }
    function rpSetStatus(state) {
        const t = ppGet('nvRpSave'); if (!t) return;
        t.textContent = state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? 'Not saved!' : '';
        t.style.color = state === 'error' ? 'var(--danger, #d33)' : '';
    }
    function rpRender() {
        const n = rp.note, box = ppGet('nvRp'); if (!box) return;
        const read = ppGet('nvRpRead'), src = ppGet('nvRpSrc'), mode = ppGet('nvRpMode'), swap = ppGet('nvRpSwap'), nm = ppGet('nvRpName');
        box.classList.toggle('nv-rp-has', !!n);
        mode.disabled = !n; swap.disabled = !n;
        if (!n) {
            nm.textContent = 'No note open'; nm.title = '';
            src.value = ''; src.hidden = true; read.hidden = false; read.replaceChildren();
            rpRevokeUrls(); rp.urls = []; rpSetStatus('');
            return;
        }
        const title = (n.title || '').trim() || 'Untitled note';
        nm.textContent = title; nm.title = title;
        src.hidden = !rp.edit; read.hidden = rp.edit;
        if (src.value !== n.markdown) src.value = n.markdown || '';
        if (!rp.edit) rpRenderRead();
        const ic = mode.querySelector('i');
        if (ic) ic.className = 'fa-solid fa-' + (rp.edit ? 'book-open' : 'pen');
        mode.title = rp.edit ? 'Back to reading (Ctrl+E)' : 'Edit this note (Ctrl+E)';
        mode.setAttribute('aria-label', rp.edit ? 'Back to reading' : 'Edit this note');
        mode.setAttribute('aria-pressed', String(rp.edit));
    }
    function rpMarkDirty() {
        if (!rp.note) return;
        rp.dirty = true;
        if (!rp.edited) { rp.edited = true; rp.editStart = Date.now(); }
        rpSetStatus('saving');
        clearTimeout(rp.timer);
        rp.timer = setTimeout(() => rpFlush(), SAVE_DELAY);
    }
    async function rpFlush() {
        clearTimeout(rp.timer);
        const n = rp.note;
        if (!n || !rp.dirty) return;
        rp.dirty = false;
        n.updatedAt = Date.now();
        try {
            const b = rp.base;   // first edit of an older note: keep how it looked before (same rule as captureOriginal)
            if (b && b.id === n.id) {
                try { const last = await revLatest(n.id); if (!last && sigOf(b) !== sigOf(n)) await snapshot(b, { at: b.updatedAt, label: 'original' }); }
                catch (e) { console.warn('Notes Vault: history skipped', e); }
            }
            await dbPut(n);
            syncAttachmentRefs(n.id, n.markdown).catch((e) => console.warn('Notes Vault: attachment ref sync failed', e));
            rp.lastMd = n.markdown;
            if (rp.note === n && !rp.dirty) rpSetStatus('saved');
            renderSide(); renderLibrary(); renderTabStrip(); renderDatalists();
            if (S.note) { try { renderLinksPane(); renderMentions(); } catch (e) { /* panes are optional */ } }
            try {
                if (rp.edited) {
                    const last = await revLatest(n.id);
                    if (Date.now() - Math.max(rp.editStart || 0, last ? last.at : 0) >= REV_EVERY) await snapshot(n, {});
                }
            } catch (e) { console.warn('Notes Vault: history skipped', e); }
            nvSyncPlannerDeadline(n);
        } catch (e) {
            console.error('Notes Vault: right-pane save failed:', e);
            rp.dirty = true;
            if (rp.note === n) rpSetStatus('error');
        }
    }
    // Save, and keep a version of what was just written — used when the right pane moves to another note.
    async function rpSettle() {
        await rpFlush();
        const n = rp.note;
        if (n && rp.edited && !rp.dirty) await snapshot(n, {});
    }
    async function rpBind(note) {
        if (!note) return;
        if (S.note && S.note.id === note.id) { flash('That note is already open on the left'); return; }
        if (rp.note && rp.note.id === note.id) { rpSetView('note'); rpRender(); return; }
        await rpSettle();
        if (S.note && S.note.id === note.id) return;          // the left side moved onto it while we were saving
        const live = S.notes.find((x) => x.id === note.id);
        if (!live) { flash('That note is no longer in the vault'); return; }
        rp.note = live; rp.dirty = false; rp.edited = false; rp.editStart = 0;
        rp.base = { id: live.id, title: live.title, markdown: live.markdown, updatedAt: live.updatedAt };
        rp.lastMd = live.markdown; rp.restoreId = null;
        rp.edit = !(live.markdown || '').trim();                // a blank note opens ready to type in
        rpRememberNote(live.id);
        if (rp.view !== 'note') rpSetView('note');
        rpRender(); rpSetStatus('');
        const sc = ppGet('nvRpScroll'); if (sc) sc.scrollTop = 0;
        if (rp.edit) ppGet('nvRpSrc').focus({ preventScroll: true });
    }
    function rpUnbind(forget) {
        clearTimeout(rp.timer);
        rp.note = null; rp.dirty = false; rp.base = null; rp.edited = false; rp.edit = false;
        if (forget !== false) rpRememberNote(null);
        rpRender();
    }
    // The same note on both sides would mean two editors over one text. The side that opened it last wins.
    function rpGuardSame() {
        if (rp.note && S.note && rp.note.id === S.note.id) {
            rpFlush();   // a pending save still writes (the save holds its own reference to the note)
            rpUnbind(true);
            flash('That note is now open on the left, so the right panel was cleared');
        }
    }
    function rpToggleMode() {
        if (!rp.note) return;
        rp.edit = !rp.edit;
        if (!rp.edit) rpFlush();
        rpRender();
        if (rp.edit) ppGet('nvRpSrc').focus({ preventScroll: true });
    }
    async function rpSwap() {
        const left = S.note, right = rp.note;
        if (!left || !right) return;
        if (!S.persisted || !S.notes.some((x) => x.id === left.id)) { flash('Write something in the left note first — it is not saved yet'); return; }
        await settle();
        await rpSettle();
        rpUnbind(false);                       // unbound first so the same-note guard does not fire
        await openNote(right.id);
        const L = S.notes.find((x) => x.id === left.id);
        if (L) await rpBind(L);
    }
    function rpOpenLink(title, onLeft) {
        const t = findNoteByTitle(title);
        if (!t) { flash('No note called “' + String(title).trim() + '” yet'); return; }
        if (onLeft) { openNote(t.id); return; }
        if (S.note && S.note.id === t.id) { flash('That note is open on the left'); return; }
        rpBind(t);
    }
    // Ctrl/⌘+click on a [[link]] in the left note: open it on the right instead. Returns true if handled.
    function rpOpenFromLeft(title) {
        if (!ppVisible()) return false;
        const t = findNoteByTitle(title);
        if (!t || (S.note && S.note.id === t.id)) return false;
        rpSetView('note');
        rpBind(t);
        return true;
    }
    function rpCloseMenu() {
        if (!rp.menuOpen) return false;
        rp.menuOpen = false;
        const m = ppGet('nvRpMenu'); if (m) m.classList.remove('nv-open');
        const b = ppGet('nvRpPick'); if (b) b.setAttribute('aria-expanded', 'false');
        return true;
    }
    function rpOpenMenu() {
        const menu = ppGet('nvRpMenu'), btn = ppGet('nvRpPick');
        if (rp.menuOpen) { rpCloseMenu(); return; }
        menu.textContent = '';
        const inp = document.createElement('input');
        inp.type = 'search'; inp.className = 'nv-rp-find'; inp.placeholder = 'Find a note…'; inp.setAttribute('aria-label', 'Find a note');
        const list = document.createElement('div');
        menu.append(inp, list);
        menu.classList.add('nv-open'); rp.menuOpen = true; btn.setAttribute('aria-expanded', 'true');
        const fill = () => {
            const q = fold(inp.value.trim()), cur = S.note && S.note.id;
            const items = S.notes.filter((n) => n.id !== cur && (!q || fold(n.title || '').indexOf(q) >= 0))
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 60);
            list.textContent = '';
            if (!items.length) { const e = document.createElement('div'); e.className = 'nv-rp-nohit'; e.textContent = q ? 'No note matches.' : 'No other notes yet.'; list.appendChild(e); return; }
            items.forEach((n) => {
                const b = document.createElement('button');
                b.type = 'button'; b.className = 'nv-act'; b.setAttribute('role', 'menuitem');
                const i = document.createElement('i'); i.className = 'fa-solid fa-file-lines'; i.setAttribute('aria-hidden', 'true');
                const sp = document.createElement('span'); const t = (n.title || '').trim() || 'Untitled note'; sp.textContent = t; sp.title = t;
                b.append(i, sp);
                const sm = document.createElement('small'); sm.textContent = fmtRel(n.updatedAt); b.appendChild(sm);
                b.addEventListener('click', () => { rpCloseMenu(); rpBind(n); });
                list.appendChild(b);
            });
        };
        inp.addEventListener('input', fill);
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); const f = list.querySelector('button'); if (f) f.click(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); const f = list.querySelector('button'); if (f) f.focus(); }
        });
        list.addEventListener('keydown', (e) => {
            const bs = Array.from(list.querySelectorAll('button')), i = bs.indexOf(document.activeElement);
            if (e.key === 'ArrowDown' && i >= 0) { e.preventDefault(); (bs[i + 1] || bs[i]).focus(); }
            else if (e.key === 'ArrowUp' && i >= 0) { e.preventDefault(); if (i === 0) inp.focus(); else bs[i - 1].focus(); }
        });
        fill();
        inp.focus();
    }
    // Keeps the right pane honest when something else changes notes: deleted/trashed, restored from a backup,
    // renamed, or edited by Find & Replace. Runs (debounced) from renderSide().
    function rpSyncSoon() {
        if (!rp.note || rp.syncTimer) return;
        rp.syncTimer = setTimeout(() => { rp.syncTimer = 0; rpSync(); }, 60);
    }
    function rpSync() {
        const n = rp.note; if (!n) return;
        const live = S.notes.find((x) => x.id === n.id);
        if (!live) {
            if (!rp.dirty) { rpUnbind(true); flash('The note on the right is no longer in the vault'); }
            return;
        }
        if (live !== n && !rp.dirty) { rp.note = live; rp.lastMd = live.markdown; rp.base = { id: live.id, title: live.title, markdown: live.markdown, updatedAt: live.updatedAt }; rpRender(); return; }
        const nm = ppGet('nvRpName');
        if (nm) { const t = (n.title || '').trim() || 'Untitled note'; if (nm.textContent !== t) { nm.textContent = t; nm.title = t; } }
        if (!rp.dirty && n.markdown !== rp.lastMd) {
            rp.lastMd = n.markdown;
            const src = ppGet('nvRpSrc'); if (src && src.value !== n.markdown) src.value = n.markdown || '';
            if (!rp.edit && ppVisible() && rp.view === 'note') rpRenderRead();
        }
    }
    function rpSetTask(index, checked) {
        const n = rp.note; if (!n) return false;
        const lines = (n.markdown || '').split('\n');
        let count = 0, inFence = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^\s*(`{3,}|~{3,})/.test(line)) { inFence = !inFence; continue; }
            if (inFence) continue;
            const m = TASK_RE.exec(line);
            if (!m) continue;
            if (count === index) {
                lines[i] = line.slice(0, m[1].length) + '[' + (checked ? 'x' : ' ') + ']' + line.slice(m[1].length + 3);
                n.markdown = lines.join('\n');
                return true;
            }
            count++;
        }
        return false;
    }
    function rpWire() {
        if (rp.wired) return;
        rp.wired = true;
        rpLoadPrefs();
        rpApplyView();
        const tabs = [ppGet('nvRpTabPdf'), ppGet('nvRpTabNote')];
        tabs.forEach((b) => {
            b.addEventListener('click', () => rpSetView(b.dataset.view));
            b.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                const other = tabs[b === tabs[0] ? 1 : 0];
                other.focus(); rpSetView(other.dataset.view);
            });
        });
        ppGet('nvRpPick').addEventListener('click', (e) => { e.stopPropagation(); rpOpenMenu(); });
        ppGet('nvRpEmptyPick').addEventListener('click', (e) => { e.stopPropagation(); rpOpenMenu(); });
        ppGet('nvRpMode').addEventListener('click', rpToggleMode);
        ppGet('nvRpSwap').addEventListener('click', () => { rpSwap().catch((e) => console.error(e)); });
        document.addEventListener('click', (e) => { if (rp.menuOpen && !e.target.closest('#nvRpMenu, #nvRpPick, #nvRpEmptyPick')) rpCloseMenu(); });
        const src = ppGet('nvRpSrc'), read = ppGet('nvRpRead');
        src.addEventListener('input', () => { if (!rp.note) return; rp.note.markdown = src.value; rpMarkDirty(); });
        src.addEventListener('blur', () => { rpFlush(); });
        src.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); e.stopPropagation(); rpToggleMode(); }
        });
        read.addEventListener('click', (e) => {
            const wl = e.target.closest('.nv-wikilink');
            if (wl) { e.preventDefault(); rpOpenLink(wl.dataset.wikilink, e.shiftKey); return; }
            const cb = e.target.closest('input[type="checkbox"]');
            if (!cb || !rp.note) return;
            const items = Array.from(read.querySelectorAll('input[type="checkbox"]'));
            const idx = items.indexOf(cb);
            if (idx === -1 || !rpSetTask(idx, cb.checked)) return;
            src.value = rp.note.markdown;
            rpMarkDirty();
        });
        // a PDF file dropped on the pane while the Note tab shows is handled by the pane's own drop handler (ppOpenLocal → PDF tab)
    }

    /* ═════════════ Layout, menus, drawers ═════════════ */
    function applyLayout() {
        const insp = S.inspOpen && !!S.note && !S.focus;
        el.app.classList.toggle('nv-insp-on', insp);
        el.app.classList.toggle('nv-side-open', S.sideOpen);
        el.inspBtn.setAttribute('aria-pressed', String(S.inspOpen));
        const sideDrawer = S.sideOpen && mq('(max-width: 900px)');
        const inspDrawer = insp && mq('(max-width: 1180px)');
        el.scrim.hidden = !(sideDrawer || inspDrawer);
    }
    function closeDrawers() {
        let changed = false;
        if (S.sideOpen) { S.sideOpen = false; changed = true; }
        if (S.inspOpen && mq('(max-width: 1180px)')) { S.inspOpen = false; changed = true; }
        if (changed) applyLayout();
        return changed;
    }
    function closeMenus() {
        let any = false;
        [[el.moreBtn, el.docMenu], [el.gear, el.gearMenu], [el.toolsMore, el.toolsMenu], [el.sortBtn, el.sortMenu], [el.filterBtn, el.filterMenu], [el.themeBtn, el.themeMenu]].forEach(([b, m]) => {
            if (m.classList.contains('nv-open')) { m.classList.remove('nv-open'); b.setAttribute('aria-expanded', 'false'); any = true; }
        });
        if (ppCloseMenu()) any = true;
        return any;
    }
    function toggleMenu(btn, menu) {
        const wasOpen = menu.classList.contains('nv-open');
        closeMenus();
        if (!wasOpen) { menu.classList.add('nv-open'); btn.setAttribute('aria-expanded', 'true'); }
    }
    function toggleInspector() {
        S.inspOpen = !S.inspOpen;
        if (mq('(min-width: 1181px)')) { try { localStorage.setItem('nvInspector', S.inspOpen ? '1' : '0'); } catch (e) { /* ignore */ } }
        applyLayout();
        renderOutline();
        renderLinksPane();
        renderMentions();
        renderContextPane();
        renderHistory();
    }
    function setInspTab(tab) {
        S.inspTab = tab;
        [['info', el.tabInfo, el.paneInfo], ['outline', el.tabOutline, el.paneOutline], ['links', el.tabLinks, el.paneLinks], ['context', el.tabContext, el.paneContext], ['history', el.tabHistory, el.paneHistory]].forEach(([k, t, p]) => {
            t.setAttribute('aria-selected', String(k === tab));
            p.hidden = k !== tab;
        });
        renderOutline();
        renderLinksPane();
        renderMentions();
        renderContextPane();
        renderHistory();
    }
    async function setScope(kind, value) {
        S.query = ''; el.search.value = ''; el.clear.hidden = true;
        if (S.note) await leaveDoc();
        S.scope = { kind, value: value || '' };
        S.limit = PAGE;
        S.sideOpen = false;
        applyLayout();
        renderAll();
        el.libScroll.scrollTop = 0;
    }

    /* ═════════════ Open / close ═════════════ */
    function lockScroll() {
        S.prevOverflow = [document.documentElement.style.overflow, document.body.style.overflow];
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
    }
    function unlockScroll() {
        if (!S.prevOverflow) return;
        document.documentElement.style.overflow = S.prevOverflow[0];
        document.body.style.overflow = S.prevOverflow[1];
        S.prevOverflow = null;
    }
    async function loadVaultData() {
        try {
            await loadAll(); await purgeExpired(); await loadAllLinks(); loadPendingRelinks();
            S.loadError = false;
            attLoadIndex().catch((e) => console.warn('Notes Vault: attachment index not loaded', e));
        } catch (e) {
            console.error('Notes Vault could not open its database:', e);
            S.notes = []; S.trash = []; S.loadError = true;
        }
    }
    async function retryLoad() {
        el.list.innerHTML = loadingHtml();
        await loadVaultData();
        renderAll();
        updateStorage();
    }
    async function open() {
        if (S.open) return;
        S.open = true;
        S.lastFocus = document.activeElement;
        el.overlay.classList.add('nv-on');
        el.overlay.setAttribute('aria-hidden', 'false');
        el.fab.setAttribute('aria-expanded', 'true');
        lockScroll();
        let pref = null;
        try { pref = localStorage.getItem('nvInspector'); } catch (e) { /* ignore */ }
        S.inspOpen = mq('(min-width: 1181px)') && pref !== '0';
        S.sideOpen = false; S.note = null; S.dirty = false;
        showLibrary();
        revLast.clear();
        // Notes from a previous successful open this session are still sitting in
        // S.notes/el.list — only show the loading state on a cold first read, so
        // reopening the Vault doesn't flash blank over content that's still valid.
        const firstLoad = !S.notes.length && !S.trash.length && !S.loadError;
        if (firstLoad) el.list.innerHTML = loadingHtml();
        await loadVaultData();
        renderAll();
        updateStorage();
        remTodayNag();   // rebuilds the reminder index from the loaded notes, nudges once if something needs attention
        backupNagSoon();   // after the notes are loaded, so it knows whether there is anything to protect
        el.app.focus();
    }
    async function close() {
        if (!S.open) return;
        if (Gr.open) closeGraph();
        await settle();
        S.open = false;
        closeMenus();
        hideToast();
        el.overlay.classList.remove('nv-on');
        el.overlay.setAttribute('aria-hidden', 'true');
        el.fab.setAttribute('aria-expanded', 'false');
        unlockScroll();
        if (S.lastFocus && S.lastFocus.focus) S.lastFocus.focus();
    }
    function toggle() { return S.open ? close() : open(); }

    function trapTab(e) {
        const nodes = [...el.app.querySelectorAll('button,[href],input,textarea,select,[tabindex]:not([tabindex="-1"])')]
            .filter((x) => !x.disabled && x.offsetParent !== null);
        if (!nodes.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1], a = document.activeElement;
        if (e.shiftKey && (a === first || a === el.app)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    }

/* ═════════════ Command palette ═════════════
       Ctrl/⌘+K (or Ctrl/⌘+Shift+P) opens one box for everything: commands, folders, tags and notes.
       Type to filter, ↑ ↓ to move, Enter to run, Esc to close. Commands that need a second answer
       ("Move to folder…", "Add or remove tags…") turn the same box into a chooser.
       The palette stores nothing itself: every command calls the same function its button already uses.
       Inside the note text box Ctrl+K stays "insert link"; Ctrl+Shift+P opens the palette from there. */
    const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || '');
    const KEYNAME = { mod: IS_MAC ? '⌘' : 'Ctrl', shift: IS_MAC ? '⇧' : 'Shift', alt: IS_MAC ? '⌥' : 'Alt', esc: 'Esc' };
    const kbds = (keys) => keys.map((k) => '<kbd>' + esc(KEYNAME[k] || k) + '</kbd>').join('');
    const keyText = (keys) => keys.map((k) => KEYNAME[k] || k).join(IS_MAC ? '' : '+');
    const P = { open: false, mode: 'root', items: [], active: 0, prevFocus: null, timer: 0, targetId: null };
    const PAL_PLACE = { root: 'Type a command or search notes…', folder: 'Pick a folder, or type a new name', tag: 'Pick a tag to add, or type a new one' };
    const PAL_CHIP = { folder: 'Move to folder', tag: 'Tags' };
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

    const tokensOf = (q) => { q = (q || '').trim(); return q ? fold(q.normalize('NFC')).split(/\s+/).filter(Boolean) : []; };
    function textScore(folded, tokens) {              // every word must start a word in the text
        let s = 0;
        for (const t of tokens) {
            const i = findAt(folded, t, 0);
            if (i < 0) return -1;
            s += i === 0 ? 30 : 20;
        }
        return s;
    }
    function cmdScore(c, tokens) {                    // words may match the label, or its extra search words
        const fl = fold(c.label), fk = fold(c.kw || '');
        let s = 0;
        for (const t of tokens) {
            const i = findAt(fl, t, 0);
            if (i >= 0) s += i === 0 ? 30 : 20;
            else if (findAt(fk, t, 0) >= 0) s += 8;
            else return -1;
        }
        return s;
    }

    /* ── small actions the palette needs that had no single function yet ── */
    function showInspector(tab) {
        if (S.focus) toggleFocus(false);
        S.inspOpen = true;
        applyLayout();
        setInspTab(tab);
    }
    function focusSearch() {
        if (S.focus) toggleFocus(false);
        if (mq('(max-width: 900px)')) { S.sideOpen = true; applyLayout(); }
        el.search.focus();
        el.search.select();
    }
    async function applySearch(q) {
        if (S.note) await leaveDoc();
        S.query = q; S.limit = PAGE;
        el.search.value = q; el.clear.hidden = !q;
        renderSide(); renderLibrary();
        el.libScroll.scrollTop = 0;
    }
    async function openBrainDump() {
        await close();
        const p = document.getElementById('bdPanel');
        if (window.BrainDump && p && !p.classList.contains('bd-visible')) window.BrainDump.toggle();
    }
    function liveFolders() {                          // fresh counts, including an unsaved note's folder
        const m = new Map();
        for (const n of S.notes) {
            const k = typeKey(n.type), f = m.get(k) || { key: k, label: normType(n.type), count: 0 };
            f.count++; m.set(k, f);
        }
        if (S.note) { const k = typeKey(S.note.type); if (!m.has(k)) m.set(k, { key: k, label: normType(S.note.type), count: 0 }); }
        return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
    }
    function liveTags() {
        const m = new Map();
        for (const n of S.notes) for (const t of n.tags) {
            const k = t.toLowerCase(), g = m.get(k) || { label: t, count: 0 };
            g.count++; m.set(k, g);
        }
        return m;
    }
    // The actual move, once we already know which note. Split out from moveToFolder() because
    // palRun() closes the palette (which clears P.targetId) BEFORE it runs the picked item's
    // callback — so looking up P.targetId again inside that callback always saw it already
    // cleared, and the note silently never moved. palFolderGroups() below resolves the note
    // once, while P.targetId is still valid, and closes over that reference instead.
    function applyMoveToFolder(n, label) {
        if (!n) return;
        const dupOf = findExistingFolder(label);
        if (dupOf && dupOf !== label) { flash('Using existing folder \u201c' + dupOf + '\u201d'); label = dupOf; }
        if (label === normType(n.type)) { flash('Already in “' + label + '”'); return; }
        n.type = label;
        if (S.note === n) {
            el.folderIn.value = label;
            renderDocMeta();
            markDirty();
        } else {
            // Moved from the library list, without opening the note — there's no open-document
            // autosave pipeline to piggyback on here, so persist this one field change directly.
            n.updatedAt = Date.now();
            dbPut(n).then(renderAll).catch((e) => console.error('Notes Vault: move failed', e));
        }
        flash('Moved to “' + label + '”');
    }
    function moveToFolder(name) {         // used by "Move to folder…" when a note is already open
        const n = S.note;
        if (!n) return;
        const typed = normType(name), ex = liveFolders().find((f) => f.key === typeKey(typed));
        applyMoveToFolder(n, ex ? ex.label : typed);   // typing "study" reuses the existing "Study"
    }
    function tagsChanged() {
        renderTagChips(); renderDocMeta(); markDirty();
        el.palIn.value = ''; P.active = 0;
        palRender();
        el.palList.scrollTop = 0;
    }
    function addNoteTag(raw) {
        const n = S.note, t = normTag(raw);
        if (!n || !t || n.tags.some((x) => x.toLowerCase() === t.toLowerCase())) return;
        const ex = liveTags().get(t.toLowerCase());
        n.tags.push(ex ? ex.label : t);
        tagsChanged();
    }
    function removeNoteTag(t) {
        const n = S.note;
        if (!n) return;
        n.tags = n.tags.filter((x) => x !== t);
        tagsChanged();
    }

    /* ── what the palette can do ── */
    function palCommands() {
        const n = S.note, out = [];
        const add = (g, id, icon, label, run, o) => out.push(Object.assign({ g, id, icon, label, run }, o));
        if (n) {
            const T = 'This note';
            if (S.viewRev) add(T, 'cur', 'clock-rotate-left', 'Back to current version', backToCurrent, { kw: 'history restore preview' });
            else add(T, 'mode', S.mode === 'edit' ? 'eye' : 'pen', S.mode === 'edit' ? 'Read this note' : 'Edit this note',
                () => toggleEditRead(), { kw: 'read edit write view toggle', keys: ['mod', 'E'] });
            if (!S.viewRev) add(T, 'split', 'table-columns', S.focus ? 'Split view: PDF or another note beside this one' : 'Split view: edit and preview side by side', () => { if (S.focus) { ppToggle(); return; } saveEditStyle('split'); setMode('split', true); }, { kw: 'split preview live side by side edit read two panes' });
            if (!S.viewRev) add(T, 'live', 'pen', 'Live preview editing', () => { saveEditStyle('live'); setMode('live', true); }, { kw: 'live preview wysiwyg obsidian edit' });
            if (!S.viewRev) add(T, 'source', 'code', 'Source mode (plain markdown)', () => { saveEditStyle('edit'); setMode('edit', true); }, { kw: 'source markdown raw text edit' });
            add(T, 'focus', S.focus ? 'compress' : 'expand', S.focus ? 'Exit focus mode' : 'Enter focus mode', () => toggleFocus(),
                { kw: 'reading distraction fullscreen zen', keys: ['mod', 'shift', 'F'] });
            add(T, 'pin', 'star', n.pinned ? 'Unpin note' : 'Pin note', () => runAction('pin'), { kw: 'favourite favorite star' });
            add(T, 'move', 'folder-open', 'Move to folder…', () => palSub('folder'), { kw: 'folder category type file', stay: true });
            add(T, 'tags', 'tag', 'Add or remove tags…', () => palSub('tag'), { kw: 'tag label hashtag', stay: true });
            add(T, 'hist', 'clock-rotate-left', 'Version history', () => runAction('hist'), { kw: 'versions revisions restore earlier' });
            add(T, 'ver', 'camera', 'Save a version now', saveVersionNow, { kw: 'snapshot checkpoint revision' });
            add(T, 'outline', 'list', 'Show outline', () => showInspector('outline'), { kw: 'headings contents toc' });
            add(T, 'info', 'circle-info', 'Show note info', () => showInspector('info'), { kw: 'details words characters created updated', more: true });
            add(T, 'dup', 'copy', 'Duplicate note', () => runAction('dup'), { kw: 'copy clone' });
            add(T, 'copy', 'clipboard', 'Copy Markdown', () => runAction('copy'), { kw: 'clipboard' });
            if (S.fileLinks.get(n.id)) {
                add(T, 'savefsupdate', 'floppy-disk', 'Save changes to file', () => runAction('savefsupdate'), { kw: 'sync write disk obsidian', keys: ['mod', 'shift', 'S'] });
                add(T, 'savefs', 'file-export', 'Save As .md…', () => runAction('savefs'), { kw: 'save disk file location', more: true });
                add(T, 'unlinkfs', 'link-slash', 'Unlink from file', () => runAction('unlinkfs'), { kw: 'unlink disconnect', more: true });
            } else {
                add(T, 'savefs', 'floppy-disk', FS_SUPPORTED ? 'Save .md to disk…' : 'Save .md (download)', () => runAction('savefs'), { kw: 'save disk file location obsidian', keys: ['mod', 'shift', 'S'] });
            }
            if (S.mode === 'read') add(T, 'find', 'magnifying-glass', 'Find in note…', () => openNoteFind(), { kw: 'search text highlight inside this note', keys: ['mod', 'F'] });
            add(T, 'md', 'file-arrow-down', 'Export as .md', () => runAction('md'), { kw: 'download markdown obsidian' });
            add(T, 'txt', 'file-lines', 'Export as .txt', () => runAction('txt'), { kw: 'download text plain', more: true });
            add(T, 'pdf', 'file-pdf', 'Export as .pdf', () => runAction('pdf'), { kw: 'download pdf print save document' });
            add(T, 'back', 'arrow-left', 'Back to notes', leaveDoc, { kw: 'close library list', keys: ['esc'] });
            add(T, 'del', 'trash', 'Move to Trash', () => runAction('del'), { kw: 'delete remove', danger: true });
            if (S.mode === 'edit' && !S.viewRev) {            // formatting: found by typing, kept out of the default list
                [['h1', 'heading', 'Heading 1'], ['h2', 'heading', 'Heading 2'], ['h3', 'heading', 'Heading 3'],
                    ['bold', 'bold', 'Bold', ['mod', 'B']], ['italic', 'italic', 'Italic', ['mod', 'I']],
                    ['strike', 'strikethrough', 'Strikethrough', ['mod', 'shift', 'X']], ['code', 'code', 'Inline code', ['mod', '`']],
                    ['ul', 'list-ul', 'Bulleted list'], ['ol', 'list-ol', 'Numbered list'], ['task', 'list-check', 'Checklist'],
                    ['quote', 'quote-left', 'Quote'], ['codeblock', 'file-code', 'Code block'], ['mdblock', 'file-lines', 'Wrap selection in a markdown block'], ['table', 'table', 'Table'],
                    ['callout', 'circle-exclamation', 'Callout'], ['hr', 'minus', 'Divider'], ['link', 'link', 'Insert link', ['mod', 'K']],
                    ['extract', 'scissors', 'Extract selection to new note']]
                    .forEach(([c, ic, lb, keys]) => add('Format', 'fmt-' + c, ic, lb, () => runCmd(c), { more: true, keys, kw: 'format markdown insert' }));
            }
        }
        const V = 'Vault';
        add(V, 'new', 'plus', 'New note', newNote, { kw: 'create write blank add', keys: ['alt', 'N'] });
        add(V, 'search', 'magnifying-glass', 'Search notes', focusSearch, { kw: 'find filter', keys: ['/'] });
        add(V, 'fr', 'right-left', 'Find & Replace…', openFrModal, { kw: 'replace substitute rename text bulk change all', keys: IS_MAC ? ['mod', 'alt', 'F'] : ['mod', 'H'] });
        if (window.BrainDump && document.getElementById('bdPanel')) add(V, 'bd', 'brain', 'Open Brain Dump', openBrainDump, { kw: 'inbox capture tracker thoughts' });
        add(V, 'exportmd', 'folder-tree', 'Export notes as .md files…', exportCurrentView, { kw: 'save disk folder obsidian bulk backup' });
        add(V, 'exp', 'download', 'Export backup (JSON)', exportAllJson, { kw: 'backup save download all' });
        add(V, 'imp', 'upload', 'Import backup…', () => el.importFile.click(), { kw: 'backup restore load json', more: true });
        add(V, 'impmd', 'file-import', 'Import .md files…', () => el.mdFile.click(), { kw: 'import markdown obsidian open upload txt' });
        add(V, 'impmddir', 'folder-open', 'Import .md folder…', () => el.mdDir.click(), { kw: 'import markdown obsidian vault folder bulk' });
        add(V, 'imppdf', 'file-pdf', 'Import PDF as note (text / OCR)…', () => el.pdfNote.click(), { kw: 'import pdf extract text ocr scan convert' });
        add(V, 'impdocx', 'file-word', 'Import Word (.docx) as note…', () => el.docxNote.click(), { kw: 'import word docx doc microsoft office convert markdown' });
        add(V, 'pdfcrop', 'crop', 'Extract region from PDF (crop → text / OCR)…', () => openPdfCrop(), { kw: 'crop region snip select pdf ocr table chart paragraph extract' });
        add(V, 'persist', 'shield-alt', 'Protect from browser cleanup', requestPersist, { kw: 'storage persistent', more: true });
        if (S.trash.length) add(V, 'empty', 'trash', 'Empty Trash', emptyTrash, { kw: 'delete forever purge', danger: true });
        add(V, 'close', 'xmark', 'Close Notes Vault', close, { kw: 'exit quit hide', more: true });

        const G = 'Go to', now = Date.now();
        let recent = 0, pinned = 0;
        for (const x of S.notes) { if (now - x.updatedAt < RECENT_MS) recent++; if (x.pinned) pinned++; }
        [['all', 'layer-group', 'All notes', S.notes.length], ['recent', 'clock', 'Recent', recent], ['pinned', 'star', 'Pinned', pinned], ['trash', 'trash', 'Trash', S.trash.length]]
            .forEach(([kind, icon, label, count]) => add(G, 'go-' + kind, icon, label, () => setScope(kind, ''), { hint: plural(count, 'note'), kw: 'go open show' }));
        [...S.fmap.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label))
            .forEach(([k, f]) => add(G, 'f-' + k, iconFor(f.label), f.label, () => setScope('folder', k), { hint: 'Folder · ' + plural(f.count, 'note'), kw: 'folder go open' }));
        [...S.tmap.entries()].sort((a, b) => (b[1].count - a[1].count) || a[1].label.localeCompare(b[1].label))
            .forEach(([k, g]) => add(G, 't-' + k, 'hashtag', g.label, () => setScope('tag', k), { hint: 'Tag · ' + plural(g.count, 'note'), kw: 'tag go open', more: true }));
        return out;
    }

    function noteItem(n, tokens, score) {
        const f = tokens.length ? getFold(n) : null, has = !!n.title.trim();
        const inMeta = !!f && tokens.every((t) => findAt(f.ft, t, 0) >= 0 || findAt(f.fg, t, 0) >= 0 || findAt(f.fy, t, 0) >= 0);
        return {
            id: 'n:' + n.id, g: 'Notes', icon: n.pinned ? 'star' : 'file-lines', score,
            titleHtml: (f && has) ? highlight(f.title, f.ft, tokens) : esc(has ? n.title : 'Untitled note'),
            hintHtml: (f && !inMeta) ? searchSnippet(n, tokens) : esc(normType(n.type) + ' · ' + fmtRel(n.updatedAt)),
            run: () => openNote(n.id)
        };
    }
    function palRecent() {
        const cur = S.note && S.note.id;
        return S.notes.filter((n) => n.id !== cur).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5).map((n) => noteItem(n, [], 0));
    }
    function palNotes(tokens) {
        const cur = S.note && S.note.id, deep = tokens.join('').length >= 2, hits = [];
        for (const n of S.notes) {
            if (n.id === cur) continue;
            const f = getFold(n);
            let s = 0, ok = true;
            for (const t of tokens) {
                const it = findAt(f.ft, t, 0);
                if (it >= 0) { s += it === 0 ? 100 : 80; continue; }
                if (findAt(f.fg, t, 0) >= 0 || findAt(f.fy, t, 0) >= 0) { s += 40; continue; }
                if (deep && findAt(f.fb, t, 0) >= 0) { s += 15; continue; }
                ok = false; break;
            }
            if (ok) hits.push({ n, s });
        }
        hits.sort((a, b) => (b.s - a.s) || (b.n.updatedAt - a.n.updatedAt));
        return hits.slice(0, 8).map((h) => noteItem(h.n, tokens, h.s));
    }

    // second-step choosers
    function palFolderGroups(q, tokens) {
        const n = (P.targetId && S.notes.find((x) => x.id === P.targetId)) || S.note;
        if (!n) return [];
        const cur = typeKey(n.type), items = [];
        for (const f of liveFolders()) {
            let sc = 0;
            if (tokens.length) { sc = textScore(fold(f.label), tokens); if (sc < 0) continue; }
            const isCur = f.key === cur;
            items.push({ icon: iconFor(f.label), label: f.label, hint: isCur ? 'Current folder' : plural(f.count, 'note'), score: sc, run: () => applyMoveToFolder(n, f.label) });
        }
        const typed = q.trim();
        if (typed && !items.some((i) => i.label.toLowerCase() === typed.toLowerCase())) {
            items.push({ icon: 'folder-plus', label: 'Create folder “' + typed + '”', plain: true, score: -1, run: () => applyMoveToFolder(n, normType(typed)) });
        }
        items.sort((a, b) => b.score - a.score);
        return [{ label: 'Folders', items }];
    }
    function palTagGroups(q, tokens) {
        const n = S.note;
        if (!n) return [];
        const has = new Set(n.tags.map((t) => t.toLowerCase())), all = liveTags(), add = [], rm = [];
        for (const [k, g] of [...all.entries()].sort((a, b) => (b[1].count - a[1].count) || a[1].label.localeCompare(b[1].label))) {
            if (has.has(k)) continue;
            let sc = 0;
            if (tokens.length) { sc = textScore(fold(g.label), tokens); if (sc < 0) continue; }
            add.push({ icon: 'hashtag', label: g.label, hint: plural(g.count, 'note'), score: sc, stay: true, run: () => addNoteTag(g.label) });
        }
        add.sort((a, b) => b.score - a.score);
        const typed = normTag(q);
        const groups = [{ label: 'Add a tag', items: add.slice(0, 40) }];
        if (typed && !has.has(typed.toLowerCase()) && !all.has(typed.toLowerCase())) {
            groups[0].items.push({ icon: 'plus', label: 'Create tag “' + typed + '”', plain: true, score: -1, stay: true, run: () => addNoteTag(typed) });
        }
        for (const t of n.tags) {
            if (tokens.length && textScore(fold(t), tokens) < 0) continue;
            rm.push({ icon: 'xmark', label: 'Remove “' + t + '”', plain: true, score: 0, stay: true, run: () => removeNoteTag(t) });
        }
        groups.push({ label: 'On this note', items: rm });
        return groups;
    }

    function palBuild(q) {
        const tokens = tokensOf(q);
        if (P.mode === 'folder') return { tokens, groups: palFolderGroups(q, tokens) };
        if (P.mode === 'tag') return { tokens, groups: palTagGroups(q, tokens) };
        const cmds = palCommands(), groups = [], byG = new Map();
        const push = (g, it) => {
            let x = byG.get(g);
            if (!x) { x = { label: g, items: [], best: -1 }; byG.set(g, x); groups.push(x); }
            x.items.push(it);
            if (it.score > x.best) x.best = it.score;
        };
        if (!tokens.length) {                                   // nothing typed: a short, predictable list
            cmds.filter((c) => !c.more).forEach((c) => push(c.g, Object.assign({ score: 0 }, c)));
            palRecent().forEach((it) => push('Recent notes', it));
            const order = ['This note', 'Recent notes', 'Vault', 'Go to'];
            groups.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
        } else {                                                // typing: everything that matches, best group first
            for (const c of cmds) { const s = cmdScore(c, tokens); if (s >= 0) push(c.g, Object.assign({ score: s }, c)); }
            palNotes(tokens).forEach((it) => push('Notes', it));
            push('Notes', { id: 'search-all', icon: 'magnifying-glass', label: 'Search all notes for “' + q.trim() + '”', plain: true, score: 0, run: () => applySearch(q.trim()) });
            groups.forEach((g) => g.items.sort((a, b) => b.score - a.score));
            groups.sort((a, b) => b.best - a.best);
        }
        return { tokens, groups };
    }

    function palRender() {
        const q = el.palIn.value, { tokens, groups } = palBuild(q);
        P.items = [];
        let html = '';
        for (const g of groups) {
            if (!g.items.length) continue;
            html += '<div class="nv-pal-h" role="presentation">' + esc(g.label) + '</div>';
            for (const it of g.items) {
                const i = P.items.push(it) - 1;
                const title = it.titleHtml || ((tokens.length && !it.plain) ? highlight(it.label, fold(it.label), tokens) : esc(it.label));
                const hint = it.hintHtml || (it.hint ? esc(it.hint) : '');
                html += '<div class="nv-pal-row' + (it.danger ? ' nv-danger' : '') + '" role="option" id="nvPalO' + i + '" data-i="' + i + '" aria-selected="false">'
                    + '<span class="nv-pal-ic"><i class="fa-solid fa-' + it.icon + '" aria-hidden="true"></i></span>'
                    + '<span class="nv-pal-tx"><span class="nv-pal-t">' + title + '</span>' + (hint ? '<span class="nv-pal-s">' + hint + '</span>' : '') + '</span>'
                    + (it.keys ? '<span class="nv-pal-k">' + kbds(it.keys) + '</span>' : '') + '</div>';
            }
        }
        if (!P.items.length) {
            html = '<div class="nv-pal-empty">' + (P.mode === 'folder' ? 'Type a name to create a folder.' : P.mode === 'tag' ? 'Type a name to create a tag.' : 'Nothing matches.') + '</div>';
        }
        el.palList.innerHTML = html;
        el.palLive.textContent = plural(P.items.length, 'result');
        palSetActive(Math.min(P.active, Math.max(0, P.items.length - 1)), false);
    }
    function palSetActive(i, scroll) {
        const rows = el.palList.querySelectorAll('.nv-pal-row');
        if (!rows.length) { P.active = 0; el.palIn.setAttribute('aria-activedescendant', ''); return; }
        i = (i + rows.length) % rows.length;
        P.active = i;
        rows.forEach((r, k) => r.setAttribute('aria-selected', k === i ? 'true' : 'false'));
        el.palIn.setAttribute('aria-activedescendant', rows[i].id);
        if (scroll) { if (i === 0) el.palList.scrollTop = 0; else rows[i].scrollIntoView({ block: 'nearest' }); }
    }
    function palFlush() {                                       // render now if a keystroke is still waiting to be shown
        if (!P.timer) return;
        clearTimeout(P.timer); P.timer = 0;
        palRender();
    }
    function palRun(i) {
        palFlush();
        const it = P.items[i == null ? P.active : i];
        if (!it) return;
        if (it.stay) { it.run(); return; }
        closePalette();                                         // put focus back first, so a command can move it elsewhere
        try {
            const r = it.run();
            if (r && r.catch) r.catch((e) => console.error('Notes Vault command failed:', e));
        } catch (e) { console.error('Notes Vault command failed:', e); flash('Couldn’t run that command'); }
    }
    function palChrome() {
        const sub = P.mode !== 'root';
        el.palIn.placeholder = PAL_PLACE[P.mode];
        el.palChip.hidden = !sub;
        el.palChip.textContent = PAL_CHIP[P.mode] || '';
        el.palFoot.innerHTML = '<span>' + kbds(['↑', '↓']) + ' move</span><span>' + kbds(['↵']) + (sub ? ' choose' : ' run') + '</span><span>' + kbds(['esc']) + (sub ? ' back' : ' close') + '</span>';
    }
    function palSub(mode) {
        P.mode = mode; P.active = 0;
        el.palIn.value = '';
        palChrome();
        palRender();
        el.palList.scrollTop = 0;
        el.palIn.focus();
    }
    function openPalette() {
        if (!S.open) return;
        if (P.open) { el.palIn.focus(); return; }
        closeMenus();
        P.open = true; P.mode = 'root'; P.active = 0;
        P.prevFocus = document.activeElement;
        el.palScrim.hidden = false;
        el.pal.hidden = false;
        el.palIn.value = '';
        palChrome();
        palRender();
        el.palList.scrollTop = 0;
        el.palIn.focus();
    }
    function refocus(node) {
        try { if (node && node.isConnected && node.focus) node.focus(); } catch (e) { /* ignore */ }
        if ((!document.activeElement || document.activeElement === document.body) && S.open && el.app) el.app.focus();
    }
    function closePalette(restore) {
        if (!P.open) return;
        clearTimeout(P.timer); P.timer = 0;
        P.open = false; P.mode = 'root'; P.targetId = null;
        el.pal.hidden = true;
        el.palScrim.hidden = true;
        el.palIn.setAttribute('aria-activedescendant', '');
        const f = P.prevFocus;
        P.prevFocus = null;
        if (restore !== false) refocus(f);
    }
    // "Move to folder" from a row in the library list — same folder picker the command
    // palette uses for the open note, just aimed at a note that isn't open yet.
    function openFolderPickerFor(id) {
        if (!S.open || !S.notes.some((x) => x.id === id)) return;
        closeMenus();
        P.open = true; P.mode = 'folder'; P.active = 0; P.targetId = id;
        P.prevFocus = document.activeElement;
        el.palScrim.hidden = false;
        el.pal.hidden = false;
        el.palIn.value = '';
        palChrome();
        palRender();
        el.palList.scrollTop = 0;
        el.palIn.focus();
    }
    function palKey(e) {
        e.stopPropagation();                                    // the palette is modal: nothing behind it should react to keys
        if (e.isComposing || e.keyCode === 229) return;         // Vietnamese IME is mid-composition: Enter/arrows belong to it
        const mod = e.ctrlKey || e.metaKey, k = e.key;
        if (k === 'Escape') { e.preventDefault(); if (P.mode !== 'root') palSub('root'); else closePalette(); }
        else if (k === 'ArrowDown') { e.preventDefault(); palSetActive(P.active + 1, true); }
        else if (k === 'ArrowUp') { e.preventDefault(); palSetActive(P.active - 1, true); }
        else if (k === 'PageDown') { e.preventDefault(); palSetActive(Math.min(P.items.length - 1, P.active + 6), true); }
        else if (k === 'PageUp') { e.preventDefault(); palSetActive(Math.max(0, P.active - 6), true); }
        else if (k === 'Tab') { e.preventDefault(); palSetActive(P.active + (e.shiftKey ? -1 : 1), true); }
        else if (k === 'Enter') { e.preventDefault(); palRun(); }
        else if (k === 'Backspace' && !el.palIn.value && P.mode !== 'root') { e.preventDefault(); palSub('root'); }
        else if (mod && !e.altKey && ((!e.shiftKey && keyIs(e, 'k')) || (e.shiftKey && keyIs(e, 'p')))) { e.preventDefault(); closePalette(); }
    }

    /* ═════════════ Find duplicates: panel ═════════════ */
    function dupNoteMetaLine(n) {
        const wc = wordCount(n.markdown);
        return normType(n.type) + ' · ' + fmtRel(n.updatedAt) + ' · ' + wc + (wc === 1 ? ' word' : ' words');
    }
    function dupPairFor(key) { return S.dup.results.find((r) => r.key === key) || null; }
    // Drop pairs that mention a note that is no longer live (trashed by an earlier merge, deleted elsewhere)
    function dupDropStale() {
        const live = new Set(S.notes.filter((n) => !n.deletedAt).map((n) => n.id));
        S.dup.results = S.dup.results.filter((r) => live.has(r.a.id) && live.has(r.b.id));
    }
    // After A absorbs B: pairs with B are gone, pairs with A are re-scored against A's new text
    function dupAfterMerge(primary, secondary) {
        const out = [];
        for (const r of S.dup.results) {
            if (r.a.id === secondary.id || r.b.id === secondary.id) continue;
            if (r.a.id === primary.id || r.b.id === primary.id) { const nr = dupResultFor(r.a, r.b); if (nr) out.push(nr); continue; }
            out.push(r);
        }
        S.dup.results = dupSortResults(out);
        dupDropStale();
    }
    // Which note "wins" a merge: the older note by default (treated as the original), flippable
    // per-pair via "keep the other one instead".
    function dupPrimarySecondary(r) {
        const swap = S.dup.swapped.has(r.key);
        const aIsOlder = r.a.createdAt <= r.b.createdAt;
        const primary = swap ? (aIsOlder ? r.b : r.a) : (aIsOlder ? r.a : r.b);
        const secondary = primary === r.a ? r.b : r.a;
        return { primary, secondary };
    }
    function dupCardHtml(r) {
        const { primary, secondary } = dupPrimarySecondary(r);
        const noteHtml = (n, isKeep) => '<div class="nv-dup-note' + (isKeep ? ' nv-dup-keep' : '') + '">'
            + (isKeep ? '<span class="nv-dup-keep-tag">Keeps this one</span>' : '')
            + '<div class="nv-dup-note-title">' + esc(n.title.trim() || 'Untitled note') + '</div>'
            + '<div class="nv-dup-note-meta">' + esc(dupNoteMetaLine(n)) + '</div>'
            + '<div class="nv-dup-note-snip">' + esc(plainSnippet(n.markdown) || 'No content yet.') + '</div>'
            + '</div>';
        return '<div class="nv-dup-card" data-pair="' + esc(r.key) + '">'
            + '<span class="nv-dup-score nv-dup-lv-' + r.level.toLowerCase() + '" title="Heuristic score, not a probability">' + (r.exact ? 'EXACT \u00b7 identical text' : r.score100 + ' / 100 \u00b7 ' + r.level) + '</span>'
            + '<div class="nv-dup-why">' + esc(r.reasons.join(' \u00b7 ')) + '</div>'
            + '<div class="nv-dup-pair">' + noteHtml(primary, true) + noteHtml(secondary, false) + '</div>'
            + '<div class="nv-dup-acts">'
            + '<button class="nv-btn nv-btn-ghost" type="button" data-dup-act="compare" data-pair="' + esc(r.key) + '"><i class="fa-solid fa-columns"></i> Compare</button>'
            + '<button class="nv-btn nv-btn-primary" type="button" data-dup-act="merge" data-pair="' + esc(r.key) + '"><i class="fa-solid fa-code-merge"></i> Merge into “' + esc(shortName(primary)) + '”</button>'
            + '<button class="nv-btn nv-btn-ghost" type="button" data-dup-act="keep" data-pair="' + esc(r.key) + '"><i class="fa-solid fa-check"></i> Keep both</button>'
            + '<button class="nv-dup-swap" type="button" data-dup-act="swap" data-pair="' + esc(r.key) + '">keep the other one instead</button>'
            + '</div></div>';
    }
    /* "Keep both" is remembered across sessions (localStorage). It lapses after 90 days, when either note is gone, or when
       the pair has become clearly more similar (+10 points) than it was when dismissed. Undo restores it at once. */
    const DUP_DISMISS_KEY = 'nv.dup.dismissed.v1', DUP_DISMISS_MS = 90 * 864e5, DUP_RISE = 0.10;
    function dupDismissLoad() { try { const o = JSON.parse(localStorage.getItem(DUP_DISMISS_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }
    function dupDismissSave(o) { try { localStorage.setItem(DUP_DISMISS_KEY, JSON.stringify(o)); } catch (e) { /* storage blocked: this session's Set still works */ } }
    function dupApplyDismissals() {
        const saved = dupDismissLoad(), now = Date.now(), ids = new Set(S.notes.map((n) => n.id)), cur = new Map(S.dup.results.map((r) => [r.key, r]));
        let dirty = false; S.dup.dismissed = new Set();
        for (const k of Object.keys(saved)) {
            const v = saved[k], r = cur.get(k);
            if (!v || now - v.at > DUP_DISMISS_MS || !ids.has(v.a) || !ids.has(v.b) || (r && r.score >= v.s + DUP_RISE)) { delete saved[k]; dirty = true; }
            else S.dup.dismissed.add(k);
        }
        if (dirty) dupDismissSave(saved);
    }
    function dupDismiss(key) {
        const r = dupPairFor(key); if (!r) return;
        const saved = dupDismissLoad(); saved[key] = { a: r.a.id, b: r.b.id, at: Date.now(), s: r.score };
        dupDismissSave(saved); S.dup.dismissed.add(key);
    }
    function dupUndismiss(key) { const saved = dupDismissLoad(); delete saved[key]; dupDismissSave(saved); S.dup.dismissed.delete(key); }
    function dupRestoreAll() { dupDismissSave({}); S.dup.dismissed = new Set(); }
    function renderDupList() {
        if (!el.dupBody) return;
        if (!S.dup.scanned) { el.dupBody.innerHTML = '<div class="nv-dup-loading">Scanning your notes…</div>'; return; }
        const visible = S.dup.results.filter((r) => !S.dup.dismissed.has(r.key)), hid = S.dup.results.length - visible.length;
        const hidHtml = hid ? '<p class="nv-dup-hint">' + hid + (hid === 1 ? ' pair is' : ' pairs are') + ' hidden because you kept both. <button type="button" class="nv-btn nv-btn-ghost" data-dup-act="restore">Show again</button></p>' : '';
        if (!visible.length) {
            el.dupBody.innerHTML = '<div class="nv-dup-empty"><i class="fa-solid fa-champagne-glasses" aria-hidden="true"></i>No likely duplicates found — your vault looks tidy.</div>' + hidHtml;
            return;
        }
        el.dupBody.innerHTML =
            '<p class="nv-dup-hint">Scores are a heuristic (0–100), not a probability: EXACT = identical text; HIGH ≥ 85; REVIEW 70–84; LOW below. Matched by content, title, tags, source and PDF page region. The starred note is kept when you merge — use “keep the other one instead” to flip it first.</p>'
            + visible.map(dupCardHtml).join('') + hidHtml;
    }
    function renderDupCompare(key) {
        const r = dupPairFor(key);
        if (!r) { S.dup.compareKey = null; renderDupList(); return; }
        const { primary, secondary } = dupPrimarySecondary(r);
        el.dupBody.innerHTML =
            '<div class="nv-dup-cmp-bar"><button class="nv-btn nv-btn-ghost" type="button" data-dup-act="back"><i class="fa-solid fa-arrow-left"></i> Back</button>'
            + '<span class="nv-dup-cmp-title">Comparing 2 notes</span></div>'
            + '<div class="nv-dup-cmp-pair">'
            + '<div class="nv-dup-cmp-col"><div class="nv-dup-cmp-head"><h3>' + esc(primary.title.trim() || 'Untitled note') + '</h3><span>' + esc(dupNoteMetaLine(primary)) + '</span></div><div class="nv-dup-cmp-scroll" id="nvDupCmpA"></div></div>'
            + '<div class="nv-dup-cmp-col"><div class="nv-dup-cmp-head"><h3>' + esc(secondary.title.trim() || 'Untitled note') + '</h3><span>' + esc(dupNoteMetaLine(secondary)) + '</span></div><div class="nv-dup-cmp-scroll" id="nvDupCmpB"></div></div>'
            + '</div>';
        renderInto(document.getElementById('nvDupCmpA'), primary.markdown, false);
        renderInto(document.getElementById('nvDupCmpB'), secondary.markdown, false);
    }
    function renderDupBody() { if (S.dup.compareKey) renderDupCompare(S.dup.compareKey); else renderDupList(); }
    async function scanDuplicates() {
        S.dup.scanned = false;
        renderDupBody();
        await new Promise((res) => requestAnimationFrame(res));   // let "Scanning…" actually paint first
        try { S.dup.results = findDuplicateCandidates(); }
        catch (e) { console.warn('Notes Vault: duplicate scan failed', e); S.dup.results = []; }
        S.dup.scanned = true;
        dupApplyDismissals();
        renderDupBody();
    }
    async function openDupModal() {
        if (!S.open || !el.dup) return;
        closeMenus();
        S.dup.open = true; S.dup.compareKey = null;
        S.dup.prevFocus = document.activeElement;
        el.dupScrim.hidden = false;
        el.dup.hidden = false;
        el.dupClose.focus({ preventScroll: true });
        await scanDuplicates();
    }
    function closeDupModal() {
        if (!S.dup.open) return;
        S.dup.open = false;
        el.dup.hidden = true;
        el.dupScrim.hidden = true;
        const f = S.dup.prevFocus; S.dup.prevFocus = null;
        refocus(f);
    }

    /* ═════════════ Find & Replace ═════════════
       Scope: current note / current folder / all notes. Replaces NOTE TEXT only (titles are link targets).
       Safety: per-note preview with tick boxes · "Replace N occurrences in M notes?" before Replace All ·
       each changed note is snapshotted into its History first · the whole batch can be undone (notes edited
       since are skipped, never overwritten). By default code, inline code, URLs, link targets, [[wikilink]]
       targets and HTML tags are left alone; "attachment://…" ids are never touched. */
    /*FR-PURE-START*/
    function frProtect(text, raw) {
        const r = [], add = (a, b) => { if (b > a) r.push([a, b]); };
        let m, re = /attachment:\/\/[A-Za-z0-9_-]+/g;
        while ((m = re.exec(text))) add(m.index, m.index + m[0].length);
        if (!raw) {
            let pos = 0, fs = -1, fch = '';
            for (const ln of text.split('\n')) {
                if (fs < 0) { const t = /^\s*(```|~~~)/.exec(ln); if (t) { fs = pos; fch = t[1]; } }
                else if (ln.trimStart().startsWith(fch)) { add(fs, pos + ln.length); fs = -1; }
                pos += ln.length + 1;
            }
            if (fs >= 0) add(fs, text.length);
            re = /(`+)[^`\n][^\n]*?\1(?!`)/g; while ((m = re.exec(text))) add(m.index, m.index + m[0].length);
            re = /\bhttps?:\/\/[^\s<>)\]]+/gi; while ((m = re.exec(text))) add(m.index, m.index + m[0].length);
            re = /\]\(([^)\n]*)\)/g; while ((m = re.exec(text))) add(m.index + 2, m.index + 2 + m[1].length);
            re = /<\/?[A-Za-z][^>\n]*>/g; while ((m = re.exec(text))) add(m.index, m.index + m[0].length);
            re = /\[\[([^\[\]|\n]+?)(?:\|[^\[\]\n]+?)?\]\]/g; while ((m = re.exec(text))) add(m.index, m.index + 2 + m[1].length);
        }
        r.sort((a, b) => a[0] - b[0]);
        const out = [];
        for (const x of r) { const l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push([x[0], x[1]]); }
        return out;
    }
    // Accent-insensitive folding WITH an explicit index map (no reliance on fold() keeping lengths equal). The text is cut into
    // clusters (a base character + its combining marks); a cluster folds to NFD, marks dropped, lower-cased, đ→d, and every folded
    // unit remembers the [start, end) of the ORIGINAL cluster it came from. So a match can never start or stop inside a character,
    // whether the note stores "â" as one code point (NFC) or as a + U+0302 (NFD).
    function frFoldMap(text) {
        if (!/[^\x00-\x7f]/.test(text)) return { h: text.toLowerCase(), st: null, en: null };   // ASCII: identity map
        const parts = [], st = [], en = [];
        for (const m of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
            const a = m.index, b = a + m[0].length;
            const f = m[0].normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/đ/g, 'd');
            parts.push(f); for (let k = 0; k < f.length; k++) { st.push(a); en.push(b); }
        }
        return { h: parts.join(''), st, en };
    }
    // spec: { find, caseI, word, accents, raw } → [{ s, e }] (non-overlapping, ascending; ORIGINAL-text offsets, ready for frApply)
    function frMatches(text, spec) {
        if (!spec.find || !text) return [];
        const isMark = (ch) => !!ch && /\p{M}/u.test(ch), isW = (ch) => !!ch && /[\p{L}\p{M}\p{N}_]/u.test(ch);
        let next;
        if (spec.accents) {
            const fm = frFoldMap(text), needle = frFoldMap(spec.find).h;
            if (!needle) return [];
            next = (from) => {
                const i = fm.h.indexOf(needle, from); if (i < 0) return null;
                const j = i + needle.length - 1;
                return { s: fm.st ? fm.st[i] : i, e: fm.en ? fm.en[j] : j + 1, fs: i, fe: i + needle.length };
            };
        } else {
            let re;
            try { re = new RegExp(spec.find.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'), spec.caseI ? 'giu' : 'g'); } catch (e) { return []; }
            next = (from) => { re.lastIndex = from; const m = re.exec(text); return m ? { s: m.index, e: m.index + m[0].length, fs: m.index, fe: m.index + m[0].length } : null; };
        }
        const endsInMark = isMark(spec.find.slice(-1));
        const out = []; let c, from = 0, last = 0, prot = null, pi = 0;
        while ((c = next(from))) {
            const { s, e } = c; from = c.fe;
            if (e <= s || s < last) { from = c.fs + 1; continue; }
            if (spec.word && (isW(text[s - 1]) || isW(text[e]))) { from = c.fs + 1; continue; }
            if (!spec.accents && !endsInMark && isMark(text[e])) { from = c.fs + 1; continue; }   // would stop in the middle of "a + ̂"
            if (!prot) prot = frProtect(text, spec.raw);
            while (pi < prot.length && prot[pi][1] <= s) pi++;
            if (pi < prot.length && prot[pi][0] < e) continue;
            out.push({ s, e }); last = e;
        }
        return out;
    }
    function frApply(text, ms, repl) {
        let out = '', pos = 0;
        for (const m of ms) { out += text.slice(pos, m.s) + repl; pos = m.e; }
        return out + text.slice(pos);
    }
    /*FR-PURE-END*/
    function frFolderKey() { return S.note ? typeKey(S.note.type) : (S.scope && S.scope.kind === 'folder' ? S.scope.value : null); }
    function frScopeNotes(scope) {
        if (scope === 'note') return S.note ? [S.note] : [];
        if (scope === 'folder') { const k = frFolderKey(); return k ? S.notes.filter((n) => !n.deletedAt && typeKey(n.type) === k) : []; }
        return S.notes.filter((n) => !n.deletedAt);
    }
    function frScopeLabel(scope) {          // human-readable scope shown in the Replace All confirmation
        if (scope === 'note') return S.note ? 'Current note \u2013 \u201c' + (((S.note.title || '').trim()) || 'Untitled note') + '\u201d' : 'Current note';
        if (scope === 'folder') {
            const fk = frFolderKey();
            const nm = fk ? (S.note ? normType(S.note.type) : ((S.fmap && S.fmap.get(fk) && S.fmap.get(fk).label) || fk)) : '';
            return nm ? 'Current folder \u2013 ' + nm : 'Current folder';
        }
        return 'All notes';
    }
    function frConfirmState(sel) {
        return sel.length ? { total: frCount(sel), notes: sel.length, scope: frScopeLabel(S.fr.scope) } : null;
    }
    function frSpec() {
        const f = S.fr;
        return { find: f.find, caseI: f.accents || f.caseI, word: f.word, accents: f.accents, raw: f.md };
    }
    function frScan() {
        const f = S.fr, spec = frSpec(), rows = []; let total = 0;
        if (spec.find) {
            for (const n of frScopeNotes(f.scope)) {
                const ms = frMatches(n.markdown || '', spec);
                if (ms.length) { rows.push({ n, ms }); total += ms.length; }
            }
            rows.sort((a, b) => ((S.note && b.n.id === S.note.id) - (S.note && a.n.id === S.note.id)) || (b.n.updatedAt - a.n.updatedAt));
        }
        f.rows = rows; f.total = total;
    }
    const frMatchN = (n) => n + (n === 1 ? ' match' : ' matches');   // the shared plural() would give "matchs"
    const frSelected = () => S.fr.rows.filter((r) => !S.fr.skip.has(r.n.id));
    const frCount = (rows) => rows.reduce((a, r) => a + r.ms.length, 0);
    function frSnippet(r) {
        const t = r.n.markdown || '', m = r.ms[0], one = (x) => esc(x.replace(/\s+/g, ' '));
        const a = Math.max(0, m.s - 36), b = Math.min(t.length, m.e + 36), repl = S.fr.repl;
        return (a > 0 ? '…' : '') + one(t.slice(a, m.s)) + (repl === S.fr.find && !S.fr.accents ? '<mark>' + one(t.slice(m.s, m.e)) + '</mark>'
            : '<del>' + one(t.slice(m.s, m.e)) + '</del><ins>' + one(repl) + '</ins>') + one(t.slice(m.e, b)) + (b < t.length ? '…' : '');
    }
    function frRender() {
        const f = S.fr; if (!f.open) return;
        const sel = frSelected(), nSel = frCount(sel);
        let sum = '';
        if (!f.find) sum = '<small>Type something to find.</small>';
        else if (!f.rows.length) sum = 'No matches' + (f.scope === 'note' && !S.note ? ' <small>— open a note, or pick another scope.</small>' : '');
        else sum = frMatchN(f.total) + ' in ' + plural(f.rows.length, 'note') + (sel.length !== f.rows.length ? ' <small>· ' + plural(nSel, 'occurrence') + ' selected</small>' : '');
        el.frSum.innerHTML = sum;
        const MAX = 200;
        el.frList.innerHTML = f.rows.slice(0, MAX).map((r, i) => '<div class="nv-fr-item' + (f.skip.has(r.n.id) ? ' nv-fr-skip' : '') + '">'
            + '<input type="checkbox" data-fr-i="' + i + '" aria-label="Include this note"' + (f.skip.has(r.n.id) ? '' : ' checked') + '>'
            + '<span class="nv-fr-title">' + esc((r.n.title || '').trim() || 'Untitled note') + '</span><span class="nv-fr-cnt">' + frMatchN(r.ms.length) + '</span>'
            + '<span class="nv-fr-snip">' + frSnippet(r) + '</span></div>').join('')
            + (f.rows.length > MAX ? '<div class="nv-fr-more">…and ' + (f.rows.length - MAX) + ' more notes (included in Replace All)</div>' : '');
        const noop = !f.find || f.find === f.repl, none = !nSel || f.busy || noop;
        el.frOne.disabled = none; el.frAll.disabled = none;
        el.frActs.hidden = !!f.confirm;
        if (f.confirm) {
            el.frConfirm.hidden = false;
            el.frConfirm.innerHTML = '<strong>Replace ' + plural(f.confirm.total, 'occurrence') + ' in ' + plural(f.confirm.notes, 'note') + '?</strong>'
                + '<p class="nv-fr-scope"><b>Scope:</b> ' + esc(f.confirm.scope || frScopeLabel(f.scope)) + '</p>'
                + '<p>“' + esc(f.find) + '” → “' + esc(f.repl) + '”. Each note is saved to its History first, and you can undo the whole batch afterwards.</p>'
                + '<div class="nv-fr-cacts"><button class="nv-btn nv-btn-primary" type="button" data-fr-act="confirm"' + (f.busy ? ' disabled' : '') + '>Replace ' + f.confirm.total + '</button>'
                + '<button class="nv-btn nv-btn-ghost" type="button" data-fr-act="cancel">Cancel</button></div>';
        } else { el.frConfirm.hidden = true; el.frConfirm.innerHTML = ''; }
        el.frUndo.hidden = !f.undo;
        if (f.undo) el.frUndoTxt.textContent = 'Last replace: ' + plural(f.undo.count, 'occurrence') + ' in ' + plural(f.undo.items.length, 'note') + '.';
    }
    function frScopeUI() {
        const f = S.fr, fk = frFolderKey();
        const opts = el.frScope.options;
        opts[0].disabled = !S.note;
        opts[1].disabled = !fk;
        opts[1].textContent = fk ? 'Current folder (' + (S.note ? normType(S.note.type) : ((S.fmap && S.fmap.get(fk) && S.fmap.get(fk).label) || fk)) + ')' : 'Current folder';
        if (!f.scope || opts[['note', 'folder', 'all'].indexOf(f.scope)].disabled) f.scope = S.note ? 'note' : (fk ? 'folder' : 'all');
        el.frScope.value = f.scope;
    }
    function frReadInputs() {
        const f = S.fr;
        f.find = el.frFind.value; f.repl = el.frRepl.value; f.scope = el.frScope.value;
        f.accents = el.frAccent.checked; f.word = el.frWord.checked; f.md = el.frMd.checked;
        el.frCase.disabled = f.accents; if (f.accents) el.frCase.checked = true;
        el.frCase.parentNode.classList.toggle('nv-fr-off', f.accents);
        f.caseI = el.frCase.checked;
        f.confirm = null; f.cur = null;
    }
    function frRefresh() { frScan(); frRender(); }
    function frFlushInputs() {          // typed <120 ms ago and clicked fast: take the field values as they are NOW
        const f = S.fr; if (!f.pendingIn) return;
        f.pendingIn = false; clearTimeout(f.timer); frReadInputs();
    }
    async function openFrModal() {
        if (!S.open || !el.fr) return;
        closeMenus();
        const f = S.fr;
        let pre = '';
        if (S.note && S.mode === 'edit' && el.src && el.src.selectionStart !== el.src.selectionEnd) {
            pre = el.src.value.slice(el.src.selectionStart, el.src.selectionEnd);
            if (pre.length > 200 || /\n/.test(pre)) pre = '';
        }
        try { await settle(); } catch (e) { /* an unsaved edit is picked up again before every replace */ }
        f.open = true; f.prevFocus = document.activeElement; f.skip = new Set(); f.confirm = null; f.cur = null; f.snapped = new Set();
        if (pre) f.find = pre;
        el.frFind.value = f.find; el.frRepl.value = f.repl;
        el.frAccent.checked = f.accents; el.frWord.checked = f.word; el.frMd.checked = f.md; el.frCase.checked = f.caseI;
        frScopeUI(); frReadInputs();
        el.frScrim.hidden = false; el.fr.hidden = false;
        el.frFind.focus({ preventScroll: true }); el.frFind.select();
        frRefresh();
    }
    function closeFrModal() {
        const f = S.fr; if (!f.open) return;
        f.open = false; f.confirm = null; clearTimeout(f.timer);
        el.fr.hidden = true; el.frScrim.hidden = true;
        const p = f.prevFocus; f.prevFocus = null; refocus(p);
    }
    // Applies [{ n, ms }] to the live notes: History snapshot → write → refresh. Returns { notes, count, failed, items }.
    async function frCommit(items, mode) {
        const repl = S.fr.repl, batch = [], res = { notes: 0, count: 0, failed: 0 };
        let refreshOpen = false;
        for (const it of items) {
            const n = it.n, text = n.markdown || '', after = frApply(text, it.ms, repl);
            if (after === text) continue;
            if (mode !== 'one' || !S.fr.snapped.has(n.id)) {
                try { await snapshot({ id: n.id, title: n.title, markdown: text }, { label: 'before-replace' }); } catch (e) { /* history is best-effort */ }
                S.fr.snapped.add(n.id);
            }
            const prevAt = n.updatedAt;
            n.markdown = after; n.updatedAt = Math.max(Date.now(), prevAt + 1);
            try { await dbPut(n); }
            catch (e) { n.markdown = text; n.updatedAt = prevAt; res.failed++; console.error('Notes Vault: replace failed for', n.id, e); continue; }
            foldCache.delete(n.id);
            await syncAttachmentRefs(n.id, after).catch(() => {});
            if (S.note && S.note.id === n.id) refreshOpen = true;
            batch.push({ id: n.id, before: text, afterAt: n.updatedAt, afterLen: after.length, count: it.ms.length });
            res.notes++; res.count += it.ms.length;
        }
        if (refreshOpen) { try { fillDoc(); } catch (e) { console.warn('Notes Vault: couldn’t refresh the open note', e); } }
        if (batch.length) S.fr.undo = { items: batch, count: res.count };
        renderAll();
        res.items = batch;
        return res;
    }
    function frDone(res) {
        if (res.failed) flash('Couldn’t update ' + plural(res.failed, 'note') + '. The rest were replaced.');
        if (res.count) toast('Replaced ' + plural(res.count, 'occurrence') + ' in ' + plural(res.notes, 'note'), 'Undo', frUndo);
    }
    function frPickNext() {
        const sel = frSelected(); if (!sel.length) return null;
        const c = S.fr.cur;
        if (c) {
            const i = sel.findIndex((r) => r.n.id === c.id);
            if (i >= 0) {
                const m = sel[i].ms.find((x) => x.s >= c.pos);
                if (m) return { n: sel[i].n, m };
                if (i + 1 < sel.length) return { n: sel[i + 1].n, m: sel[i + 1].ms[0] };
                return null;                              // end reached: wrapping could re-hit the text we just wrote
            }
        }
        return { n: sel[0].n, m: sel[0].ms[0] };
    }
    async function frReplaceOne() {
        frFlushInputs();
        const f = S.fr; if (f.busy || !f.find || f.find === f.repl) return;
        f.busy = true; f.confirm = null;
        try {
            await settle(); frScan();
            const pick = frPickNext();
            if (!pick) { if (f.cur) { f.cur = null; flash('Reached the end. Click Replace again to start from the top.'); } return; }
            const res = await frCommit([{ n: pick.n, ms: [pick.m] }], 'one');
            if (res.count) f.cur = { id: pick.n.id, pos: pick.m.s + f.repl.length };
            frDone(res);
        } catch (e) { console.error('Notes Vault: replace failed', e); flash('Couldn’t replace that'); }
        finally { f.busy = false; frRefresh(); }
    }
    async function frStartAll() {
        frFlushInputs();
        const f = S.fr; if (f.busy || !f.find || f.find === f.repl) return;
        f.busy = true;
        try {
            await settle(); frScan();
            const sel = frSelected();
            f.confirm = frConfirmState(sel);
        } catch (e) { console.error('Notes Vault: replace failed', e); flash('Couldn’t prepare that'); }
        finally { f.busy = false; frRender(); const b = el.frConfirm.querySelector('[data-fr-act=confirm]'); if (b) b.focus(); }
    }
    async function frConfirmAll() {
        const f = S.fr, c = f.confirm; if (!c || f.busy) return;
        f.busy = true; frRender();
        try {
            frScan();                                   // fresh against the live text, right before writing
            const sel = frSelected();
            if (frCount(sel) !== c.total || sel.length !== c.notes) { f.confirm = frConfirmState(sel); return; }   // something changed: ask again with the real numbers
            f.confirm = null;
            frDone(await frCommit(sel.map((r) => ({ n: r.n, ms: r.ms })), 'all'));
            f.cur = null;
        } catch (e) { console.error('Notes Vault: replace failed', e); flash('Couldn’t replace everything'); f.confirm = null; }
        finally { f.busy = false; frRefresh(); }
    }
    // Restores every note of the last batch that has not been edited since; skipped ones are reported, never overwritten.
    async function frUndo() {
        const f = S.fr, b = f.undo; if (!b || f.busy) return;
        f.busy = true;
        let ok = 0, skipped = 0, refreshOpen = false;
        try {
            try { await settle(); } catch (e) { /* ignore */ }
            for (const it of b.items) {
                const n = S.notes.find((x) => x.id === it.id);
                if (!n || n.deletedAt || n.updatedAt !== it.afterAt || (n.markdown || '').length !== it.afterLen) { skipped++; continue; }
                const prevMd = n.markdown, prevAt = n.updatedAt;
                n.markdown = it.before; n.updatedAt = Math.max(Date.now(), prevAt + 1);
                try { await dbPut(n); }
                catch (e) { n.markdown = prevMd; n.updatedAt = prevAt; skipped++; continue; }
                foldCache.delete(n.id);
                await syncAttachmentRefs(n.id, n.markdown).catch(() => {});
                if (S.note && S.note.id === n.id) refreshOpen = true;
                ok++;
            }
            if (refreshOpen) { try { fillDoc(); } catch (e) { /* ignore */ } }
            f.undo = null; f.cur = null; f.snapped = new Set();
            renderAll();
            toast('Restored ' + plural(ok, 'note') + (skipped ? ' · skipped ' + skipped + ' edited or removed since' : ''));
        } catch (e) { console.error('Notes Vault: undo failed', e); flash('Couldn’t undo that'); }
        finally { f.busy = false; frRefresh(); }
    }
    function frKey(e) {
        if (e.isComposing || e.keyCode === 229) return;       // Vietnamese IME mid-composition owns Enter
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target === el.frFind) { e.preventDefault(); el.frRepl.focus(); }
        else if (e.target === el.frRepl) { e.preventDefault(); frReplaceOne(); }
    }
    function wireFr() {
        if (!el.fr) return;
        el.frClose.addEventListener('click', closeFrModal);
        el.frScrim.addEventListener('click', closeFrModal);
        const changed = () => { S.fr.pendingIn = false; frReadInputs(); frRefresh(); };
        const typed = () => { S.fr.pendingIn = true; clearTimeout(S.fr.timer); S.fr.timer = setTimeout(changed, 120); };
        el.frFind.addEventListener('input', typed);
        el.frRepl.addEventListener('input', typed);
        [el.frCase, el.frWord, el.frAccent, el.frMd].forEach((c) => c.addEventListener('change', changed));
        el.frScope.addEventListener('change', () => { S.fr.skip = new Set(); changed(); });
        el.frFind.addEventListener('keydown', frKey);
        el.frRepl.addEventListener('keydown', frKey);
        el.frOne.addEventListener('click', frReplaceOne);
        el.frAll.addEventListener('click', frStartAll);
        el.frUndoBtn.addEventListener('click', frUndo);
        el.frConfirm.addEventListener('click', (e) => {
            const b = e.target.closest('[data-fr-act]'); if (!b) return;
            if (b.dataset.frAct === 'confirm') frConfirmAll();
            else { S.fr.confirm = null; frRender(); el.frAll.focus(); }
        });
        el.frList.addEventListener('change', (e) => {
            const c = e.target.closest('[data-fr-i]'); if (!c) return;
            const r = S.fr.rows[+c.dataset.frI]; if (!r) return;
            if (c.checked) S.fr.skip.delete(r.n.id); else S.fr.skip.add(r.n.id);
            S.fr.confirm = null; frRender();
        });
    }

    /* ═════════════ Storage manager: panel (v1 — read-only breakdown + quota guard) ═════════════ */
    function storRowHtml(label, bytes, isEstimate) {
        const val = bytes ? (isEstimate ? '~' : '') + fmtBytes(bytes) : '—';
        return '<div class="nv-stor-row"><span>' + esc(label) + '</span><span>' + val + '</span></div>';
    }
    function updateStorTabsUI() {
        if (!el.stor) return;
        el.stor.querySelectorAll('[data-stor-tab]').forEach((b) => {
            const active = b.dataset.storTab === S.stor.tab;
            b.classList.toggle('nv-cur', active);
            b.setAttribute('aria-selected', String(active));
        });
    }
    function switchStorTab(tab) {
        if (S.stor.tab === tab) return;
        S.stor.tab = tab;
        renderStorBody();
    }
    async function renderStorBody() {
        if (!el.storBody) return;
        updateStorTabsUI();
        el.stor.dataset.tab = S.stor.tab;
        if (S.stor.tab !== 'images') { S.stor.selMode = false; S.stor.sel.clear(); }
        if (S.stor.tab !== 'files') { S.stor.fSelMode = false; S.stor.fSel.clear(); }
        if (S.stor.tab === 'images') return renderStorImages();
        if (S.stor.tab === 'files') return renderStorFiles();
        return renderStorOverview();
    }
    async function renderStorOverview() {
        let stats;
        try { stats = await getVaultStorageStats(); S.storageStats = stats; }
        catch (e) { console.warn('Notes Vault: storage stats failed', e); stats = null; }
        if (!stats || !stats.browser.supported || !stats.browser.quota) {
            el.storBody.innerHTML =
                '<div class="nv-stor-unsupported"><i class="fa-solid fa-database" aria-hidden="true"></i>This browser doesn\'t report overall storage usage, but here\'s what the vault itself holds.</div>'
                + '<div class="nv-stor-section"><div class="nv-stor-section-title">Vault</div>'
                + storRowHtml('Notes', stats ? stats.vault.notesBytes : 0, true)
                + storRowHtml('Version history', stats ? stats.vault.revisionsBytes : 0, true)
                + storRowHtml('Attachments', stats ? stats.vault.attachmentsBytes : 0, false)
                + '</div>';
            return;
        }
        const pct = stats.totals.percent;
        const health = getStorageHealth(pct);
        const warn = health.level === 'warning' || health.level === 'critical' || health.level === 'near-full';
        // Split attachments into images vs files so the bar shows what is really using the space.
        let imgBytes = 0, fileBytes = 0;
        try {
            (await dbGetAllAttachments()).forEach((r) => {
                const sz = r.size || (r.blob && r.blob.size) || 0;
                if (/^image\//.test(r.mime || '')) imgBytes += sz; else fileBytes += sz;
            });
        } catch (e) { imgBytes = stats.vault.attachmentsBytes; fileBytes = 0; }
        const cats = [
            { k: 'files', label: 'Files', hint: 'PDFs and spreadsheets', bytes: fileBytes, est: false, go: 'files' },
            { k: 'images', label: 'Images', hint: 'Screenshots and pictures', bytes: imgBytes, est: false, go: 'images' },
            { k: 'history', label: 'Version history', hint: 'Earlier versions of your notes', bytes: stats.vault.revisionsBytes, est: true },
            { k: 'notes', label: 'Notes', hint: 'The text you wrote', bytes: stats.vault.notesBytes, est: true },
            { k: 'other', label: 'Other app data', hint: 'Settings and everything else in this app', bytes: stats.localStorage.bytes, est: true }
        ].filter((c) => c.bytes > 0).sort((a, b) => b.bytes - a.bytes);
        const total = cats.reduce((n, c) => n + c.bytes, 0) || 1;
        const pctOf = (b) => { const v = b / total * 100; return v < 1 ? '<1%' : Math.round(v) + '%'; };
        const free = Math.max(0, stats.browser.quota - stats.browser.usage);
        const actRow = (id, icon, title, desc, btn) =>
            '<div class="nv-stor-act"><span class="nv-stor-acticon"><i class="fa-solid ' + icon + '" aria-hidden="true"></i></span>'
            + '<span><span class="nv-stor-acttitle">' + title + '</span><span class="nv-stor-actdesc">' + desc + '</span></span>'
            + '<button type="button" class="nv-btn nv-btn-ghost" id="' + id + '">' + btn + '</button></div>';
        el.storBody.innerHTML =
            '<div class="nv-stor-ov">'
            + '<section class="nv-stor-hero" aria-label="Storage used">'
            +   '<div class="nv-stor-hero-top"><span class="nv-stor-hero-num">' + esc(fmtBytes(stats.browser.usage)) + '</span><span class="nv-stor-hero-of">used of ' + esc(fmtBytes(stats.browser.quota)) + '</span></div>'
            +   '<div class="nv-stor-quota" data-level="' + esc(health.level) + '" role="img" aria-label="' + pct + '% of storage used"><i style="width:' + Math.max(1, pct) + '%"></i></div>'
            +   '<div class="nv-stor-quota-cap"><span>' + pct + '% used</span><span>' + esc(fmtBytes(free)) + ' free</span></div>'
            +   (warn ? '<p class="nv-stor-alert" data-level="' + esc(health.level) + '">' + esc(storageHealthMessage(pct, health)) + '</p>' : '')
            + '</section>'
            + '<section><h3 class="nv-stor-h">What is using the space</h3><div class="nv-stor-card nv-stor-comp">'
            +   '<div class="nv-stor-compbar" role="img" aria-label="Storage by type">'
            +     cats.map((c) => '<span style="--b:' + c.bytes + ';--c:var(--sc-' + c.k + ')" title="' + esc(c.label) + '"></span>').join('')
            +   '</div>'
            +   '<ul class="nv-stor-leg">'
            +     cats.map((c) => {
                      const inner = '<span class="nv-stor-dot" style="--c:var(--sc-' + c.k + ')"></span>'
                          + '<span><span class="nv-stor-legname">' + esc(c.label) + '</span><span class="nv-stor-leghint">' + esc(c.hint) + '</span></span>'
                          + '<span class="nv-stor-legsize">' + (c.est ? '~' : '') + esc(fmtBytes(c.bytes)) + '</span>'
                          + '<span class="nv-stor-legpct">' + pctOf(c.bytes) + '</span>'
                          + (c.go ? '<i class="fa-solid fa-chevron-right nv-stor-go" aria-hidden="true"></i>' : '<span class="nv-stor-go"></span>');
                      return '<li>' + (c.go ? '<button type="button" class="nv-stor-legrow" data-stor-goto="' + c.go + '" title="Browse ' + esc(c.label.toLowerCase()) + '">' + inner + '</button>'
                                            : '<div class="nv-stor-legrow">' + inner + '</div>') + '</li>';
                  }).join('')
            +   '</ul>'
            + '</div></section>'
            + '<section><h3 class="nv-stor-h">Free up space</h3><div class="nv-stor-card nv-stor-acts">'
            +   actRow('nvStorPrune', 'fa-broom', 'Remove unused attachments', 'Delete images and files that no note or version uses.', 'Clean up')
            +   actRow('nvStorOptimize', 'fa-wand-magic-sparkles', 'Re-compress older images', 'Shrink images saved with older settings. Sharp screenshots are kept as they are.', 'Optimize')
            +   actRow('nvStorRebuild', 'fa-arrows-rotate', 'Repair attachment links', 'Re-scan every note if an image or file shows the wrong “used in” list.', 'Rebuild')
            + '</div></section>'
            + '<p class="nv-stor-note">Notes, history and other app data are estimates from record size. Images and files are exact.</p>'
            + '</div>';
        el.storBody.querySelectorAll('[data-stor-goto]').forEach((b) => { b.onclick = () => switchStorTab(b.dataset.storGoto); });
        const pruneBtn = $('nvStorPrune');
        if (pruneBtn) pruneBtn.onclick = onPruneAttachmentsClick;
        const optBtn = $('nvStorOptimize');
        if (optBtn) optBtn.onclick = onOptimizeAttachmentsClick;
        const rebuildBtn = $('nvStorRebuild');
        if (rebuildBtn) rebuildBtn.onclick = onRebuildAttachmentRefsClick;
    }
    async function onPruneAttachmentsClick() {
        const btn = $('nvStorPrune');
        if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
        try {
            const { count, freed } = await pruneOrphanAttachments();
            flash(count ? 'Removed ' + count + (count === 1 ? ' unused image' : ' unused images') + ' — freed ' + fmtBytes(freed) : 'No unused attachments found');
            await renderStorBody();
        } catch (e) {
            console.warn('Notes Vault: prune attachments failed', e);
            flash('Couldn’t clean up attachments');
            if (btn) { btn.disabled = false; btn.textContent = 'Clean up'; }
        }
    }
    async function onOptimizeAttachmentsClick() {
        const btn = $('nvStorOptimize');
        if (btn) { btn.disabled = true; btn.textContent = 'Optimizing…'; }
        try {
            const { changed, freed } = await optimizeAttachments();
            flash(changed ? 'Re-compressed ' + changed + (changed === 1 ? ' image' : ' images') + ' — freed ' + fmtBytes(freed) : 'Every image is already optimized');
            await renderStorBody();
        } catch (e) {
            console.warn('Notes Vault: optimize attachments failed', e);
            flash('Couldn’t optimize images');
            if (btn) { btn.disabled = false; btn.textContent = 'Optimize'; }
        }
    }
    // Re-scans every note + revision and rewrites attachmentRefs to match reality. A repair
    // tool for drift, not a routine action — never runs on its own, only from this button.
    async function onRebuildAttachmentRefsClick() {
        const btn = $('nvStorRebuild');
        if (btn) { btn.disabled = true; btn.textContent = 'Rebuilding…'; }
        try {
            const { repaired } = await rebuildAttachmentRefs();
            flash(repaired ? 'Repaired ' + repaired + (repaired === 1 ? ' attachment reference' : ' attachment references') : 'Attachment index was already consistent');
            await renderStorBody();
        } catch (e) {
            console.warn('Notes Vault: rebuild attachment refs failed', e);
            flash('Couldn’t rebuild the attachment index');
            if (btn) { btn.disabled = false; btn.textContent = 'Rebuild'; }
        }
    }

    /* ── Images tab: browse every stored attachment (sort by size/date, filter to unused) ── */
    function revokeStorObjectUrls() {
        S.stor.objectUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
        S.stor.objectUrls = [];
    }
    function applyStorImageSort(items) {
        if (S.stor.imgSort === 'new') items.sort((a, b) => b.rec.createdAt - a.rec.createdAt);
        else if (S.stor.imgSort === 'old') items.sort((a, b) => a.rec.createdAt - b.rec.createdAt);
        else items.sort((a, b) => b.rec.size - a.rec.size);   // 'size' — largest first, the default
        return items;
    }
    function storImgCardHtml(it) {
        const unused = !it.noteIds.length && !it.revIds.length;
        return '<button type="button" class="nv-stor-imgcard' + (unused ? '' : ' nv-locked') + '">'
            + '<span class="nv-stor-tick"><i class="fa-solid fa-check" aria-hidden="true"></i></span>'
            + '<span class="nv-stor-imgthumb-wrap"><img class="nv-stor-imgthumb" alt="" loading="lazy">'
            + '<span class="nv-stor-size">' + esc(fmtBytes(it.rec.size)) + '</span>'
            + (unused ? '<span class="nv-stor-badge-unused">Unused</span>' : '')
            + '</span>'
            + storNoteChipsHtml(it, true)
            + '</button>';
    }
    function storImagesToolbarHtml() {
        return '<div class="nv-stor-toolbar">'
            + '<label class="nv-stor-select"><span>Sort</span><select id="nvStorImgSort">'
            + '<option value="size"' + (S.stor.imgSort === 'size' ? ' selected' : '') + '>Largest first</option>'
            + '<option value="new"' + (S.stor.imgSort === 'new' ? ' selected' : '') + '>Newest first</option>'
            + '<option value="old"' + (S.stor.imgSort === 'old' ? ' selected' : '') + '>Oldest first</option>'
            + '</select></label>'
            + '<label class="nv-stor-check"><input type="checkbox" id="nvStorImgUnused"' + (S.stor.imgFilter === 'unused' ? ' checked' : '') + '> Unused only</label>'
            + '<span class="nv-stor-spacer"></span>'
            + (S.stor.selMode
                ? '<button type="button" class="nv-btn nv-btn-ghost" id="nvStorImgSelUnused"><i class="fa-solid fa-list-check" aria-hidden="true"></i> Select all unused</button>'
                  + '<button type="button" class="nv-btn nv-btn-ghost nv-stor-del" id="nvStorImgDelSel" disabled><i class="fa-solid fa-trash" aria-hidden="true"></i> Delete selected (0)</button>'
                  + '<button type="button" class="nv-btn nv-btn-ghost" id="nvStorImgSelCancel">Cancel</button>'
                : '<button type="button" class="nv-btn nv-btn-ghost" id="nvStorImgSelBtn"><i class="fa-regular fa-square-check" aria-hidden="true"></i> Select</button>')
            + '</div>';
    }
    function wireStorImagesToolbar() {
        const sortSel = $('nvStorImgSort');
        if (sortSel) sortSel.addEventListener('change', () => { S.stor.imgSort = sortSel.value; renderStorImages(); });
        const unusedChk = $('nvStorImgUnused');
        if (unusedChk) unusedChk.addEventListener('change', () => { S.stor.imgFilter = unusedChk.checked ? 'unused' : 'all'; renderStorImages(); });
        const selBtn = $('nvStorImgSelBtn');
        if (selBtn) selBtn.addEventListener('click', () => { S.stor.selMode = true; S.stor.sel.clear(); renderStorImages(); });
        const cancelBtn = $('nvStorImgSelCancel');
        if (cancelBtn) cancelBtn.addEventListener('click', () => { S.stor.selMode = false; S.stor.sel.clear(); renderStorImages(); });
        const allUnused = $('nvStorImgSelUnused');
        if (allUnused) allUnused.addEventListener('click', () => {
            const cards = Array.from(document.querySelectorAll('#nvStorImgGrid .nv-stor-imgcard:not(.nv-locked)'));
            cards.forEach((c) => { if (c._storId) { S.stor.sel.add(c._storId); c.classList.add('nv-sel'); } });
            updateStorSelUI();
        });
        const delBtn = $('nvStorImgDelSel');
        if (delBtn) delBtn.addEventListener('click', deleteSelectedStorImages);
    }
    function updateStorSelUI() {
        const b = $('nvStorImgDelSel');
        if (!b) return;
        const n = S.stor.sel.size;
        b.disabled = !n;
        b.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i> Delete selected (' + n + ')';
    }
    async function deleteSelectedStorImages() {
        const ids = Array.from(S.stor.sel);
        if (!ids.length) return;
        if (!confirm('Delete ' + ids.length + (ids.length === 1 ? ' unused image' : ' unused images') + ' permanently? This cannot be undone.')) return;
        // Re-check against fresh usage data so an image that got referenced in the meantime is never removed.
        let ok = 0, skipped = 0;
        try {
            const fresh = new Map((await getAttachmentsOverview()).map((it) => [it.rec.id, it]));
            for (const id of ids) {
                const it = fresh.get(id);
                if (!it || it.noteIds.length || it.revIds.length) { skipped++; continue; }
                await dbDeleteAttachment(id).catch(() => {});
                await dbDeleteAttachmentRefs(id).catch(() => {});
                ok++;
            }
        } catch (e) { console.warn('Notes Vault: bulk delete failed', e); flash('Couldn’t delete the selected images'); }
        S.stor.sel.clear();
        S.stor.selMode = false;
        flash('Deleted ' + ok + (ok === 1 ? ' image' : ' images') + (skipped ? ' — skipped ' + skipped + ' still in use' : ''));
        renderStorImages();
    }
    async function hydrateStorImageThumbs(items) {
        const grid = $('nvStorImgGrid');
        if (!grid) return;
        const cards = Array.from(grid.children);
        items.forEach((it, i) => {
            const card = cards[i];
            if (!card) return;
            const url = URL.createObjectURL(it.rec.blob);
            S.stor.objectUrls.push(url);
            const img = card.querySelector('img');
            if (img) img.src = url;
            card._storId = it.rec.id;
            const locked = !!(it.noteIds.length || it.revIds.length);
            if (S.stor.sel.has(it.rec.id)) card.classList.add('nv-sel');
            card.addEventListener('click', (e) => {
                const link = e.target.closest && e.target.closest('[data-open-note]');
                if (link && !S.stor.selMode) {           // jump straight to the note that uses this image
                    e.stopPropagation();
                    const id = link.getAttribute('data-open-note');
                    closeStorModal();
                    openNote(id);
                    return;
                }
                if (S.stor.selMode) {
                    if (locked) { flash('Still used in a note or its history — can’t delete'); return; }
                    if (S.stor.sel.has(it.rec.id)) { S.stor.sel.delete(it.rec.id); card.classList.remove('nv-sel'); }
                    else { S.stor.sel.add(it.rec.id); card.classList.add('nv-sel'); }
                    updateStorSelUI();
                    return;
                }
                openAttachMenu(it.rec, card, { context: 'manager', noteCount: it.noteIds.length, revCount: it.revIds.length, onDeleted: renderStorImages });
            });
        });
        updateStorSelUI();
    }
    async function renderStorImages() {
        revokeStorObjectUrls();
        el.storBody.innerHTML = storImagesToolbarHtml() + '<div class="nv-dup-loading">Loading images…</div>';
        wireStorImagesToolbar();
        let items;
        try { items = (await getAttachmentsOverview()).filter((it) => /^image\//.test(it.rec.mime || '')); }
        catch (e) {
            console.warn('Notes Vault: could not load attachments', e);
            el.storBody.innerHTML = storImagesToolbarHtml() + '<div class="nv-stor-unsupported">Couldn’t load attachments.</div>';
            wireStorImagesToolbar();
            return;
        }
        if (S.stor.tab !== 'images') return;   // the panel moved on while this was loading
        if (!items.length) {
            el.storBody.innerHTML = storImagesToolbarHtml() + '<div class="nv-stor-unsupported"><i class="fa-regular fa-images" aria-hidden="true"></i>No images attached to any note yet.</div>';
            wireStorImagesToolbar();
            return;
        }
        applyStorImageSort(items);
        const totalBytes = items.reduce((s, it) => s + (it.rec.size || 0), 0);
        const unusedCount = items.filter((it) => !it.noteIds.length && !it.revIds.length).length;
        const filtered = S.stor.imgFilter === 'unused' ? items.filter((it) => !it.noteIds.length && !it.revIds.length) : items;
        const summary = '<p class="nv-stor-summary"><b>' + items.length + (items.length === 1 ? ' image' : ' images') + '</b><span>' + fmtBytes(totalBytes) + ' total</span>' + (unusedCount ? '<span class="nv-stor-summary-warn">' + unusedCount + ' unused</span>' : '') + '</p>';
        const cards = filtered.length ? filtered.map(storImgCardHtml).join('') : '';
        el.storBody.innerHTML = storImagesToolbarHtml() + summary
            + (filtered.length ? '<div class="nv-stor-imggrid' + (S.stor.selMode ? ' nv-selmode' : '') + '" id="nvStorImgGrid">' + cards + '</div>' : '<div class="nv-stor-unsupported">No unused images — nice and tidy.</div>');
        wireStorImagesToolbar();
        await hydrateStorImageThumbs(filtered);
    }

    /* ── Files/PDFs tab: every non-image attachment (currently: PDFs) — same sort/filter
       pattern as Images, but a plain list since there's no thumbnail worth rendering. ── */
    function applyStorFileSort(items) {
        if (S.stor.fileSort === 'new') items.sort((a, b) => b.rec.createdAt - a.rec.createdAt);
        else if (S.stor.fileSort === 'old') items.sort((a, b) => a.rec.createdAt - b.rec.createdAt);
        else items.sort((a, b) => b.rec.size - a.rec.size);   // 'size' — largest first, the default
        return items;
    }
    // Where is this attachment used? Open-able notes come first and are clickable (jump to the note), then notes
    // in Trash. Version-history-only hits are folded into a "+N" count instead of one chip each.
    function storNoteChipsHtml(it, compact) {
        const ids = Array.from(new Set(it.noteIds));
        const histOnly = Array.from(new Set(it.revIds)).filter((id) => !ids.includes(id));
        const info = ids.map((id) => {
            const live = S.notes.find((n) => n.id === id);
            const trashed = !live && (S.trash || []).find((n) => n.id === id);
            const rec = live || trashed;
            return { id, live: !!live, named: !!rec, title: rec ? (rec.title || 'Untitled note') : '' , trashed: !!trashed };
        });
        const named = info.filter((n) => n.named).sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0));
        const unknown = info.length - named.length;
        const cls = compact ? 'nv-stor-notes nv-compact' : 'nv-stor-notes';
        if (!info.length && !histOnly.length) {
            return compact ? '<span class="' + cls + '"><span class="nv-stor-notelink nv-static"><span>Not used in any note</span></span></span>' : '';
        }
        const limit = compact ? 1 : 2;
        const shown = named.slice(0, limit);
        const hidden = (named.length - shown.length) + unknown + histOnly.length;
        const chip = (n) => {
            const label = n.title + (n.trashed ? ' (in Trash)' : '');
            return n.live
                ? '<span class="nv-stor-notelink" ' + (compact ? '' : 'role="link" tabindex="0" ') + 'data-open-note="' + esc(n.id) + '" title="Open this note"><i class="fa-regular fa-note-sticky" aria-hidden="true"></i><span>' + esc(label) + '</span></span>'
                : '<span class="nv-stor-notelink nv-static" title="This note can’t be opened from here"><i class="fa-regular fa-note-sticky" aria-hidden="true"></i><span>' + esc(label) + '</span></span>';
        };
        let html = shown.map(chip).join('');
        if (!shown.length) html = '<span class="nv-stor-notelink nv-static" title="Only older versions of a note contain this"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><span>Version history only</span></span>';
        else if (hidden > 0) html += '<span class="nv-stor-notelink nv-static nv-stor-more" title="' + hidden + ' more: other notes or version history"><span>+' + hidden + '</span></span>';
        return '<span class="' + cls + '">' + html + '</span>';
    }
    function storFileRowHtml(it, maxSize) {
        const unused = !it.noteIds.length && !it.revIds.length;
        const name = it.rec.filename || (it.rec.id + '.' + extFromMime(it.rec.mime));
        const sheet = isSheetMime(it.rec.mime);
        let added = '';
        try { if (it.rec.createdAt) added = new Date(it.rec.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { /* ignore */ }
        const w = maxSize ? Math.max(3, Math.round((it.rec.size || 0) / maxSize * 100)) : 0;
        return '<div class="nv-stor-filerow' + (unused ? '' : ' nv-locked') + '" role="button" tabindex="0">'
            + '<span class="nv-stor-rowtick"><i class="fa-solid fa-check" aria-hidden="true"></i></span>'
            + '<span class="nv-stor-fileicon" data-kind="' + (sheet ? 'xls' : 'pdf') + '"><i class="fa-solid ' + (sheet ? 'fa-file-excel' : 'fa-file-pdf') + '" aria-hidden="true"></i></span>'
            + '<span class="nv-stor-filebody">'
            + '<span class="nv-stor-filename" title="' + esc(name) + '">' + esc(name) + '</span>'
            + '<span class="nv-stor-filemeta"><span>' + (sheet ? 'Spreadsheet' : 'PDF') + '</span>' + (added ? '<span>Added ' + esc(added) + '</span>' : '') + '</span>'
            + storNoteChipsHtml(it)
            + '</span>'
            + '<span class="nv-stor-filesize"><b>' + esc(fmtBytes(it.rec.size)) + '</b><span class="nv-stor-sizebar"><i style="width:' + w + '%"></i></span></span>'
            + (unused ? '<span class="nv-stor-badge-unused">Unused</span>' : '')
            + '</div>';
    }
    function storFilesToolbarHtml() {
        return '<div class="nv-stor-toolbar">'
            + '<label class="nv-stor-select"><span>Sort</span><select id="nvStorFileSort">'
            + '<option value="size"' + (S.stor.fileSort === 'size' ? ' selected' : '') + '>Largest first</option>'
            + '<option value="new"' + (S.stor.fileSort === 'new' ? ' selected' : '') + '>Newest first</option>'
            + '<option value="old"' + (S.stor.fileSort === 'old' ? ' selected' : '') + '>Oldest first</option>'
            + '</select></label>'
            + '<label class="nv-stor-check"><input type="checkbox" id="nvStorFileUnused"' + (S.stor.fileFilter === 'unused' ? ' checked' : '') + '> Unused only</label>'
            + '<span class="nv-stor-spacer"></span>'
            + (S.stor.fSelMode
                ? '<button type="button" class="nv-btn nv-btn-ghost" id="nvStorFileSelUnused"><i class="fa-solid fa-list-check" aria-hidden="true"></i> Select all unused</button>'
                  + '<button type="button" class="nv-btn nv-btn-ghost nv-stor-del" id="nvStorFileDelSel" disabled><i class="fa-solid fa-trash" aria-hidden="true"></i> Delete selected (0)</button>'
                  + '<button type="button" class="nv-btn nv-btn-ghost" id="nvStorFileSelCancel">Cancel</button>'
                : '<button type="button" class="nv-btn nv-btn-ghost" id="nvStorFileSelBtn"><i class="fa-regular fa-square-check" aria-hidden="true"></i> Select</button>')
            + '</div>';
    }
    function wireStorFilesToolbar() {
        const sortSel = $('nvStorFileSort');
        if (sortSel) sortSel.addEventListener('change', () => { S.stor.fileSort = sortSel.value; renderStorFiles(); });
        const unusedChk = $('nvStorFileUnused');
        if (unusedChk) unusedChk.addEventListener('change', () => { S.stor.fileFilter = unusedChk.checked ? 'unused' : 'all'; renderStorFiles(); });
        const selBtn = $('nvStorFileSelBtn');
        if (selBtn) selBtn.addEventListener('click', () => { S.stor.fSelMode = true; S.stor.fSel.clear(); renderStorFiles(); });
        const cancelBtn = $('nvStorFileSelCancel');
        if (cancelBtn) cancelBtn.addEventListener('click', () => { S.stor.fSelMode = false; S.stor.fSel.clear(); renderStorFiles(); });
        const allUnused = $('nvStorFileSelUnused');
        if (allUnused) allUnused.addEventListener('click', () => {
            document.querySelectorAll('#nvStorFileList .nv-stor-filerow:not(.nv-locked)').forEach((r) => { if (r._storId) { S.stor.fSel.set(r._storId, r._storSize || 0); r.classList.add('nv-sel'); } });
            updateStorFileSelUI();
        });
        const delBtn = $('nvStorFileDelSel');
        if (delBtn) delBtn.addEventListener('click', deleteSelectedStorFiles);
    }
    function updateStorFileSelUI() {
        const b = $('nvStorFileDelSel');
        if (!b) return;
        const n = S.stor.fSel.size;
        let bytes = 0; S.stor.fSel.forEach((v) => { bytes += v; });
        b.disabled = !n;
        b.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i> Delete selected (' + n + (n ? ' \u00b7 ' + fmtBytes(bytes) : '') + ')';
    }
    async function deleteSelectedStorFiles() {
        const ids = Array.from(S.stor.fSel.keys());
        if (!ids.length) return;
        let want = 0; S.stor.fSel.forEach((v) => { want += v; });
        if (!confirm('Delete ' + ids.length + (ids.length === 1 ? ' unused file' : ' unused files') + ' (' + fmtBytes(want) + ') permanently? This cannot be undone.')) return;
        // Re-check against fresh usage data so a file that got attached to a note in the meantime is never removed.
        let ok = 0, skipped = 0, freed = 0;
        try {
            const fresh = new Map((await getAttachmentsOverview()).map((it) => [it.rec.id, it]));
            for (const id of ids) {
                const it = fresh.get(id);
                if (!it || it.noteIds.length || it.revIds.length) { skipped++; continue; }
                await dbDeleteAttachment(id).catch(() => {});
                await dbDeleteAttachmentRefs(id).catch(() => {});
                ok++; freed += it.rec.size || 0;
            }
        } catch (e) { console.warn('Notes Vault: bulk file delete failed', e); flash('Couldn’t delete the selected files'); }
        S.stor.fSel.clear();
        S.stor.fSelMode = false;
        flash('Deleted ' + ok + (ok === 1 ? ' file' : ' files') + (ok ? ' — freed ' + fmtBytes(freed) : '') + (skipped ? ' — skipped ' + skipped + ' still in use' : ''));
        renderStorFiles();
    }
    function wireStorFileRows(items) {
        const list = $('nvStorFileList');
        if (!list) return;
        Array.from(list.children).forEach((row, i) => {
            const it = items[i];
            if (!it) return;
            row._storId = it.rec.id; row._storSize = it.rec.size || 0;
            const locked = !!(it.noteIds.length || it.revIds.length);
            if (S.stor.fSel.has(it.rec.id)) row.classList.add('nv-sel');
            const toggleSel = () => {
                if (locked) { flash('Still used in a note or its history — can’t delete'); return; }
                if (S.stor.fSel.has(it.rec.id)) { S.stor.fSel.delete(it.rec.id); row.classList.remove('nv-sel'); }
                else { S.stor.fSel.set(it.rec.id, it.rec.size || 0); row.classList.add('nv-sel'); }
                updateStorFileSelUI();
            };
            const openMenu = () => { if (S.stor.fSelMode) { toggleSel(); return; } openAttachMenu(it.rec, row, { context: 'manager', noteCount: it.noteIds.length, revCount: it.revIds.length, onDeleted: renderStorFiles }); };
            row.addEventListener('click', (e) => {
                const link = !S.stor.fSelMode && e.target.closest('[data-open-note]');
                if (link) {            // jump to the note that holds this file
                    e.stopPropagation();
                    const id = link.getAttribute('data-open-note');
                    closeStorModal();
                    openNote(id);
                    return;
                }
                if (!S.stor.fSelMode && e.target.closest('.nv-stor-notelink')) return;   // greyed-out chip: do nothing
                openMenu();
            });
            row.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                const link = !S.stor.fSelMode && e.target.closest('[data-open-note]');
                if (link) { closeStorModal(); openNote(link.getAttribute('data-open-note')); }
                else if (e.target === row) openMenu();
            });
        });
    }
    async function renderStorFiles() {
        el.storBody.innerHTML = storFilesToolbarHtml() + '<div class="nv-dup-loading">Loading files…</div>';
        wireStorFilesToolbar();
        let items;
        try { items = (await getAttachmentsOverview()).filter((it) => !/^image\//.test(it.rec.mime || '')); }
        catch (e) {
            console.warn('Notes Vault: could not load attachments', e);
            el.storBody.innerHTML = storFilesToolbarHtml() + '<div class="nv-stor-unsupported">Couldn’t load attachments.</div>';
            wireStorFilesToolbar();
            return;
        }
        if (S.stor.tab !== 'files') return;   // the panel moved on while this was loading
        if (!items.length) {
            el.storBody.innerHTML = storFilesToolbarHtml() + '<div class="nv-stor-unsupported"><i class="fa-regular fa-file-pdf" aria-hidden="true"></i>No PDFs or spreadsheets attached to any note yet.</div>';
            wireStorFilesToolbar();
            return;
        }
        applyStorFileSort(items);
        const totalBytes = items.reduce((s, it) => s + (it.rec.size || 0), 0);
        const unusedCount = items.filter((it) => !it.noteIds.length && !it.revIds.length).length;
        const filtered = S.stor.fileFilter === 'unused' ? items.filter((it) => !it.noteIds.length && !it.revIds.length) : items;
        const summary = '<p class="nv-stor-summary"><b>' + items.length + (items.length === 1 ? ' file' : ' files') + '</b><span>' + fmtBytes(totalBytes) + ' total</span>' + (unusedCount ? '<span class="nv-stor-summary-warn">' + unusedCount + ' unused</span>' : '') + '</p>';
        const maxSize = items.reduce((m, it) => Math.max(m, it.rec.size || 0), 0);
        const rows = filtered.length ? filtered.map((it) => storFileRowHtml(it, maxSize)).join('') : '';
        el.storBody.innerHTML = storFilesToolbarHtml() + summary
            + (filtered.length ? '<div class="nv-stor-filelist' + (S.stor.fSelMode ? ' nv-selmode' : '') + '" id="nvStorFileList">' + rows + '</div>' : '<div class="nv-stor-unsupported">No unused files — nice and tidy.</div>');
        wireStorFilesToolbar();
        wireStorFileRows(filtered);
        updateStorFileSelUI();
    }

    async function openStorModal() {
        if (!S.open || !el.stor) return;
        closeMenus();
        S.stor.open = true;
        S.stor.prevFocus = document.activeElement;
        el.storScrim.hidden = false;
        el.stor.hidden = false;
        el.storClose.focus({ preventScroll: true });
        el.storBody.innerHTML = '<div class="nv-dup-loading">Checking storage…</div>';
        await renderStorBody();
    }
    function closeStorModal() {
        if (!S.stor.open) return;
        S.stor.open = false;
        el.stor.hidden = true;
        el.storScrim.hidden = true;
        revokeStorObjectUrls();
        S.stor.selMode = false; S.stor.sel.clear(); S.stor.fSelMode = false; S.stor.fSel.clear();
        const f = S.stor.prevFocus; S.stor.prevFocus = null;
        refocus(f);
    }
    function handleDupAction(e) {
        const b = e.target.closest('[data-dup-act]');
        if (!b) return;
        const act = b.dataset.dupAct, key = b.dataset.pair;
        if (act === 'compare') { S.dup.compareKey = key; renderDupBody(); }
        else if (act === 'back') { S.dup.compareKey = null; renderDupBody(); }
        else if (act === 'swap') { S.dup.swapped.has(key) ? S.dup.swapped.delete(key) : S.dup.swapped.add(key); renderDupBody(); }
        else if (act === 'keep') { dupDismiss(key); renderDupBody(); toast('Kept both — hidden until they become much more similar (or 90 days).', 'Undo', () => { dupUndismiss(key); renderDupBody(); }); }
        else if (act === 'restore') { dupRestoreAll(); renderDupBody(); }
        else if (act === 'merge') {
            if (S.dup.merging) return;                       // double-click / Enter-repeat must not open two merges
            const r = dupPairFor(key);
            if (!r) return;
            const ca = S.notes.find((n) => n.id === r.a.id), cb = S.notes.find((n) => n.id === r.b.id);
            if (!ca || !cb) { dupDropStale(); renderDupBody(); flash('One of those notes is no longer in your vault'); return; }
            r.a = ca; r.b = cb;                              // always act on the live objects, never a stale scan copy
            S.dup.merging = true; S.dup.compareKey = null;
            (async () => {
                try {
                    await settle();                          // an open note may hold edits that are not saved yet
                    const { primary, secondary } = dupPrimarySecondary(r);
                    const identical = dupSq(primary.markdown) === dupSq(secondary.markdown);   // only skip the dialog when NOTHING would be lost
                    const opts = identical ? { markdown: primary.markdown.trim() } : await dupMergeDialog(primary, secondary);
                    if (opts && await mergeNotes(primary, secondary, opts)) dupAfterMerge(primary, secondary);
                } catch (err) { console.error('Notes Vault: merge failed', err); flash('Couldn’t merge those notes'); }
                finally { S.dup.merging = false; renderDupBody(); }
            })();
        }
    }

    /* Shared full-text tooltip for truncated .nv-combo-opt rows — one fixed-position
       element reused by every combo instance (see attachCombo below). */
    let comboTipEl = null;
    function ensureComboTip() {
        if (comboTipEl) return comboTipEl;
        comboTipEl = document.createElement('div');
        comboTipEl.className = 'nv-combo-tip';
        comboTipEl.hidden = true;
        (el.overlay || document.body).appendChild(comboTipEl);
        return comboTipEl;
    }
    function showComboTip(anchorLi, text) {
        const tip = ensureComboTip();
        tip.textContent = text;
        tip.hidden = false;
        const r = anchorLi.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        tip.style.left = '-9999px'; tip.style.top = '-9999px';  // measure off-screen first
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        let left = r.right + 8;
        if (left + tw > vw - 8) left = Math.max(8, r.left - tw - 8);
        const top = Math.min(Math.max(8, r.top), vh - th - 8);
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
    }
    function hideComboTip() { if (comboTipEl) comboTipEl.hidden = true; }

    /* ── Themed replacement for native <datalist> suggestion popups (.nv-combo-pop). Wires
       an input to a filtered, clickable, keyboard-navigable dropdown of options.
       opts: { getOptions(): string[], multi (comma-separated field), onPick(value),
       enterPicks (default true — set false when the input already has its own Enter
       behaviour, e.g. the tag box) }. ── */
    function attachCombo(input, popEl, opts) {
        if (!input || !popEl) return;
        const { getOptions, multi = false, onPick, enterPicks = true } = opts;
        let items = [], sel = -1;
        const query = () => {
            const v = input.value;
            return (multi ? v.slice(v.lastIndexOf(',') + 1) : v).trim().toLowerCase();
        };
        const close = () => { popEl.hidden = true; popEl.innerHTML = ''; items = []; sel = -1; hideComboTip(); };
        const render = () => {
            const q = query();
            const all = (getOptions() || []).filter((v) => v && v.toLowerCase() !== q);
            items = (q ? all.filter((v) => v.toLowerCase().includes(q)) : all).slice(0, 8);
            if (!items.length) { close(); return; }
            sel = -1;
            popEl.innerHTML = items.map((v, i) => `<li class="nv-combo-opt" data-i="${i}" data-full="${esc(v)}" role="option">${esc(v)}</li>`).join('');
            popEl.hidden = false;
        };
        const move = (d) => {
            if (!items.length) return;
            sel = (sel + d + items.length) % items.length;
            [...popEl.children].forEach((li, i) => li.classList.toggle('nv-combo-sel', i === sel));
            popEl.children[sel] && popEl.children[sel].scrollIntoView({ block: 'nearest' });
        };
        const pick = (i) => {
            const v = items[i];
            if (v == null) return;
            close();
            if (onPick) { onPick(v); return; }
            if (multi) {
                const raw = input.value, cut = raw.lastIndexOf(',');
                input.value = (cut >= 0 ? raw.slice(0, cut + 1) + ' ' : '') + v;
            } else {
                input.value = v;
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
        };
        input.addEventListener('input', render);
        input.addEventListener('focus', render);
        input.addEventListener('keydown', (e) => {
            if (popEl.hidden) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Escape') { close(); }
            else if (e.key === 'Enter' && enterPicks && sel >= 0) { e.preventDefault(); pick(sel); }
        });
        popEl.addEventListener('mousedown', (e) => e.preventDefault());  // don't steal focus before the click lands
        popEl.addEventListener('click', (e) => {
            const li = e.target.closest('.nv-combo-opt');
            if (li) pick(+li.dataset.i);
        });
        // Full-text tooltip on hover — only for rows actually clipped by the ellipsis,
        // and it never changes .nv-combo-pop's own width (see .nv-combo-tip, fixed-position).
        popEl.addEventListener('mouseover', (e) => {
            const li = e.target.closest('.nv-combo-opt');
            if (!li || li.scrollWidth <= li.clientWidth) return;
            showComboTip(li, li.dataset.full);
        });
        popEl.addEventListener('mouseout', (e) => {
            if (e.target.closest('.nv-combo-opt')) hideComboTip();
        });
        input.addEventListener('blur', () => { setTimeout(close, 120); });
    }

    /* ═════════════ Wiring ═════════════ */
    function init() {
        el = {
            fab: $('nvFab'), overlay: $('nvOverlay'), app: $('nvApp'), scrim: $('nvScrim'),
            side: $('nvSide'), sideScroll: $('nvSideScroll'), search: $('nvSearch'), clear: $('nvClear'),
            storage: $('nvStorage'), gear: $('nvGear'), gearMenu: $('nvGearMenu'), importFile: $('nvImportFile'), mdFile: $('nvImportMdFile'), mdDir: $('nvImportMdDir'), pdfNote: $('nvImportPdfNote'), docxNote: $('nvImportDocx'), attachInput: $('nvAttachInput'), pdfInput: $('nvPdfInput'), fileInput: $('nvFileInput'),
            themeBtn: $('nvThemeBtn'), themeMenu: $('nvThemeMenu'),
            lib: $('nvLib'), libScroll: $('nvLibScroll'), libTitle: $('nvLibTitle'), libSub: $('nvLibSub'), list: $('nvList'),
            docView: $('nvDocView'), docScroll: $('nvDocScroll'), title: $('nvTitle'), docMeta: $('nvDocMeta'),
            progress: $('nvProgress'), progressFill: $('nvProgressFill'),
            read: $('nvRead'), src: $('nvSrc'), modeRead: $('nvModeRead'), modeEdit: $('nvModeEdit'), modeSplit: $('nvModeSplit'), modeSource: $('nvModeSource'), live: $('nvLive'),
            moreBtn: $('nvMoreBtn'), docMenu: $('nvDocMenu'), inspBtn: $('nvInspBtn'), focusBtn: $('nvFocusBtn'), fsDown: $('nvFsDown'), fsUp: $('nvFsUp'), widthBtn: $('nvWidthBtn'),
            insp: $('nvInsp'), tabInfo: $('nvTabInfo'), tabOutline: $('nvTabOutline'), paneInfo: $('nvPaneInfo'), paneOutline: $('nvPaneOutline'),
            folderIn: $('nvFolderIn'), folderPop: $('nvFolderPop'), tagBox: $('nvTagBox'), tagIn: $('nvTagIn'), tagPop: $('nvTagPop'),
            linkedCareer: $('nvLinkedCareer'), linkedSkill: $('nvLinkedSkill'), course: $('nvCourse'), coursePop: $('nvCoursePop'), resource: $('nvResource'), resourcePop: $('nvResourcePop'), analysis: $('nvAnalysis'), analysisPop: $('nvAnalysisPop'), deal: $('nvDeal'), dealPop: $('nvDealPop'), deadline: $('nvDeadline'), remind: $('nvRemind'), remindChips: $('nvRemindChips'), remindHint: $('nvRemindHint'), todayBtn: $('nvTodayBtn'), todayBadge: $('nvTodayBadge'),
            relParent: $('nvRelParent'), relParentPop: $('nvRelParentPop'), relParentCur: $('nvRelParentCur'), relKids: $('nvRelKids'), relKidIn: $('nvRelKidIn'), relKidPop: $('nvRelKidPop'), relLinks: $('nvRelLinks'), relLinkLabel: $('nvRelLinkLabel'), relLinkIn: $('nvRelLinkIn'), relLinkPop: $('nvRelLinkPop'), relIn: $('nvRelIn'),
            created: $('nvCreated'), updated: $('nvUpdated'), words: $('nvWords'), chars: $('nvChars'), readTime: $('nvReadTime'),
            actions: $('nvActions'), outline: $('nvOutline'),
            tabHistory: $('nvTabHistory'), paneHistory: $('nvPaneHistory'), histList: $('nvHistList'),
            tabLinks: $('nvTabLinks'), paneLinks: $('nvPaneLinks'), linksOut: $('nvLinksOut'), linksBack: $('nvLinksBack'), backlinkCount: $('nvBacklinkCount'),
            mentions: $('nvMentions'), mentionsToggle: $('nvMentionsToggle'), mentionsCount: $('nvMentionsCount'), mentionsList: $('nvMentionsList'),
            tabContext: $('nvTabContext'), paneContext: $('nvPaneContext'), context: $('nvContext'),
            wlPop: $('nvWlPop'),
            tabStrip: $('nvTabStrip'),
            saveVersion: $('nvSaveVersion'), histClear: $('nvHistClear'),
            revBar: $('nvRevBar'), revTxt: $('nvRevTxt'), revBack: $('nvRevBack'), revRestore: $('nvRevRestore'),
            emptyTrash: $('nvEmptyTrash'), scopeActions: $('nvScopeActions'), toast: $('nvToast'), toastTxt: $('nvToastTxt'), toastBtn: $('nvToastBtn'),
            linkScrim: $('nvLinkScrim'), linkPicker: $('nvLinkPicker'), linkClose: $('nvLinkClose'), linkTitle: $('nvLinkTitle'), linkSub: $('nvLinkSub'), linkSearch: $('nvLinkSearch'), linkList: $('nvLinkList'),
            sortBtn: $('nvSortBtn'), sortMenu: $('nvSortMenu'), densityBtn: $('nvDensityBtn'),
            filterBtn: $('nvFilterBtn'), filterMenu: $('nvFilterMenu'), filterDot: $('nvFilterDot'),
            fType: $('nvFType'), fFolder: $('nvFFolder'), fTag: $('nvFTag'), fTagPop: $('nvFTagPop'),
            fCreated: $('nvFCreated'), fUpdated: $('nvFUpdated'),
            fChecklist: $('nvFChecklist'), fCode: $('nvFCode'), fLink: $('nvFLink'), fPinned: $('nvFPinned'),
            filterClear: $('nvFilterClear'),
            tools: $('nvTools'), toolsScroll: $('nvToolsScroll'), toolsMore: $('nvToolsMore'), toolsMenu: $('nvToolsMenu'),
            save: $('nvSave'), saveTxt: $('nvSaveTxt'), statRight: $('nvStatRight'),
            palOpen: $('nvPalOpen'), palKeyHint: $('nvPalKeyHint'),
            palScrim: $('nvPalScrim'), pal: $('nvPal'), palIn: $('nvPalIn'), palChip: $('nvPalChip'), palClose: $('nvPalClose'),
            palList: $('nvPalList'), palLive: $('nvPalLive'), palFoot: $('nvPalFoot'),
            dupScrim: $('nvDupScrim'), dup: $('nvDup'), dupClose: $('nvDupClose'), dupRescan: $('nvDupRescan'), dupBody: $('nvDupBody'),
            frScrim: $('nvFrScrim'), fr: $('nvFr'), frClose: $('nvFrClose'), frFind: $('nvFrFind'), frRepl: $('nvFrRepl'), frScope: $('nvFrScope'),
            frCase: $('nvFrCase'), frWord: $('nvFrWord'), frAccent: $('nvFrAccent'), frMd: $('nvFrMd'), frSum: $('nvFrSum'), frList: $('nvFrList'),
            frConfirm: $('nvFrConfirm'), frActs: $('nvFrActs'), frOne: $('nvFrOne'), frAll: $('nvFrAll'), frUndo: $('nvFrUndo'), frUndoTxt: $('nvFrUndoTxt'), frUndoBtn: $('nvFrUndoBtn'),
            fedScrim: $('nvFedScrim'), fed: $('nvFed'), fedClose: $('nvFedClose'), fedTitle: $('nvFedTitle'), fedPreview: $('nvFedPreview'),
            fedIcons: $('nvFedIcons'), fedColors: $('nvFedColors'), fedReset: $('nvFedReset'), fedDone: $('nvFedDone'),
            storScrim: $('nvStorScrim'), stor: $('nvStor'), storClose: $('nvStorClose'), storRefresh: $('nvStorRefresh'), storBody: $('nvStorBody'),
            renScrim: $('nvRenScrim'), ren: $('nvRen'), renBody: $('nvRenBody'), renUpdate: $('nvRenUpdate'), renOnly: $('nvRenOnly'), renCancel: $('nvRenCancel')
        };

        noteAttachmentOriginWarning();

        // open / close / new
        el.overlay.addEventListener('click', (e) => {
            if (e.target.closest('[data-close]')) close();
            else if (e.target.closest('[data-new]')) newNote();
            else if (e.target.closest('[data-scope-new]')) newNote();
            else if (e.target.closest('[data-retry-load]')) retryLoad();
            else if (e.target.closest('[data-scope-link]')) {
                const sc = S.scope;
                const d = linkTargetDescriptor(sc.kind, sc.value && (sc.value.id || sc.value.skill));
                openLinkPicker(sc.kind, sc.kind === 'skill' ? (sc.value && sc.value.skill) : (sc.value && sc.value.id), scopedEntityTitle(sc.kind, sc.value), sc.value && sc.value.career || d.career);
            }
        });
        $('nvNewBtn').addEventListener('click', () => newNote());
        // hover hint: "New note (Alt+N)" — shown only on hover, nothing written inside the button
        const NEW_NOTE_TIP = 'New note (' + keyText(['alt', 'N']) + ')';
        const tipNewBtns = (root) => root.querySelectorAll('#nvNewBtn, [data-new], [data-scope-new]').forEach((b) => { b.title = NEW_NOTE_TIP; });
        tipNewBtns(el.overlay);
        el.overlay.addEventListener('mouseover', (e) => {
            const b = e.target.closest && e.target.closest('#nvNewBtn, [data-new], [data-scope-new]');
            if (b && b.title !== NEW_NOTE_TIP) b.title = NEW_NOTE_TIP;
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && S.linkPicker.open) { e.preventDefault(); e.stopPropagation(); closeLinkPicker(); }
        }, true);
        // Read mode, Obsidian-style: Ctrl/Cmd+C with nothing selected copies the WHOLE note
        // straight away, instead of requiring Ctrl+A first. A real text selection still just
        // copies that selection — the browser's own default handles it, untouched.
        document.addEventListener('keydown', (e) => {
            if (!S.open || !S.note || S.mode === 'edit') return;
            if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'c') return;
            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
            const sel = window.getSelection();
            if (sel && sel.toString().length) return;   // real selection present — let default copy run
            e.preventDefault();
            const src = S.viewRev ? S.viewRev.markdown : S.note.markdown;
            const text = extractFrontmatter(src).body;  // skip frontmatter — it's hidden in Read mode too
            const done = () => { if (typeof showNotification === 'function') showNotification('Copied note to clipboard', 'success'); };
            const fail = () => { if (typeof showNotification === 'function') showNotification('Could not copy — please copy manually.', 'error'); };
            const fallbackCopy = () => {
                try {
                    const ta = document.createElement('textarea');
                    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                    document.body.appendChild(ta); ta.focus(); ta.select();
                    document.execCommand('copy'); document.body.removeChild(ta);
                    done();
                } catch (err) { fail(); }
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done).catch(fallbackCopy);
            } else {
                fallbackCopy();
            }
        });
        el.scrim.addEventListener('click', closeDrawers);
        $('nvMenuBtn').addEventListener('click', () => { S.sideOpen = true; applyLayout(); });
        window.addEventListener('resize', () => { if (S.open) applyLayout(); updateProgress(); });

        // reading progress bar — follows scroll in Read mode, throttled to one paint per frame
        el.docScroll.addEventListener('scroll', scheduleProgress, { passive: true });

        // sidebar navigation
        el.sideScroll.addEventListener('click', (e) => {
            if (e.target.closest('[data-merge-folders]')) { mergeDuplicateFolders(); return; }
            if (e.target.closest('[data-new-folder]')) { promptNewFolder(); return; }
            const editBtn = e.target.closest('[data-edit-folder]');
            if (editBtn) {
                const key = editBtn.dataset.editFolder, f = S.fmap.get(key);
                if (f) openFolderEditor(key, f.label);
                return;
            }
            const b = e.target.closest('[data-kind]');
            if (!b) return;
            if (b.dataset.kind === 'moretags') { S.tagsAll = !S.tagsAll; renderSide(); return; }
            setScope(b.dataset.kind, b.dataset.val);
        });

        // search
        let searchTimer = null;
        el.search.addEventListener('input', () => {
            el.clear.hidden = !el.search.value;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(async () => {
                S.query = el.search.value;
                S.limit = PAGE;
                if (S.note) await leaveDoc(); else { renderSide(); renderLibrary(); }
                el.libScroll.scrollTop = 0;
            }, 120);
        });
        el.search.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && el.search.value) {
                e.stopPropagation();
                el.clear.click();
            } else if (e.key === 'Enter') {
                const first = filterNotes(qTokens())[0];
                if (first) openNote(first.id);
            }
        });
        el.clear.addEventListener('click', () => {
            el.search.value = ''; el.clear.hidden = true; S.query = ''; S.limit = PAGE;
            if (S.note) leaveDoc(); else { renderSide(); renderLibrary(); }
            el.search.focus();
        });

        // Link-existing picker
        el.linkClose.addEventListener('click', closeLinkPicker);
        el.linkScrim.addEventListener('click', closeLinkPicker);
        el.linkPicker.addEventListener('click', (e) => {
            const b = e.target.closest('[data-link-note]');
            if (b) linkExistingNote(b.dataset.linkNote);
        });
        el.linkSearch.addEventListener('input', () => {
            S.linkPicker.query = el.linkSearch.value;
            renderLinkPicker();
        });
        el.linkSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); closeLinkPicker(); }
        });

        // library rows
        el.list.addEventListener('click', (e) => {
            if (e.target.closest('[data-more]')) { S.limit += PAGE; renderLibrary(); return; }
            const b = e.target.closest('[data-act]');
            const row = e.target.closest('.nv-row');
            if (!b || !row) return;
            const id = row.dataset.id;
            if (b.dataset.act === 'open') openNote(id);
            else if (b.dataset.act === 'pin') togglePinById(id);
            else if (b.dataset.act === 'move') openFolderPickerFor(id);
            else if (b.dataset.act === 'del') deleteNote(id);
            else if (b.dataset.act === 'unlinkEntity') unlinkScopedNote(id);
            else if (b.dataset.act === 'restore') restoreNote(id);
            else if (b.dataset.act === 'purge') purgeNote(id);
        });
        el.emptyTrash.addEventListener('click', emptyTrash);
        el.toastBtn.addEventListener('click', () => { const f = S.toastAct; hideToast(); if (f) f(); });

        // document: header controls
        $('nvBack').addEventListener('click', leaveDoc);
        el.modeRead.addEventListener('click', () => { if (S.note && (S.mode !== 'read' || S.viewRev)) setMode('read'); });
        el.modeEdit.addEventListener('click', () => { if (S.note) { saveEditStyle('live'); setMode('live', true); } });
        el.modeSource.addEventListener('click', () => { if (S.note && !(S.mode === 'edit' && !S.split && !S.live)) { saveEditStyle('edit'); setMode('edit', true); } });
        el.modeSplit.addEventListener('click', () => {
            if (!S.note) return;
            if (S.focus) { ppToggle(); return; }   // Focus mode: PDF on the right, note on the left
            if (!(S.mode === 'edit' && S.split)) { saveEditStyle('split'); setMode('split', true); }
        });
        ppWire();
        el.moreBtn.addEventListener('click', () => toggleMenu(el.moreBtn, el.docMenu));
        el.inspBtn.addEventListener('click', toggleInspector);
        el.focusBtn.addEventListener('click', () => toggleFocus());
        el.fsDown.addEventListener('click', () => { if (S.fs > 0) { S.fs--; saveReading(); applyFontSize(); } });
        el.fsUp.addEventListener('click', () => { if (S.fs < FS_STEPS.length - 1) { S.fs++; saveReading(); applyFontSize(); } });
        el.widthBtn.addEventListener('click', () => { S.wd = (S.wd + 1) % WD_STEPS.length; saveReading(); applyFocus(); });
        [el.actions, el.docMenu].forEach((box) => box.addEventListener('click', (e) => {
            const b = e.target.closest('[data-action]');
            if (!b) return;
            closeMenus();
            runAction(b.dataset.action);
        }));

        // document: title + body
        el.title.addEventListener('input', () => {
            if (!S.note) return;
            if (el.title.value.includes('\n')) el.title.value = el.title.value.replace(/\n+/g, ' ');
            S.note.title = el.title.value;
            fitTitle();
            markDirty();
        });
        el.title.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (S.mode === 'edit') el.src.focus(); else el.title.blur(); }
        });
        el.src.addEventListener('input', () => { if (!S.note) return; S.note.markdown = el.src.value; markDirty(); });

        // Task checkboxes in Read mode: click toggles the box AND the "[ ]"/"[x]" in the
        // markdown source, kept in sync via markDirty() (same path as any other edit).
        // Wikilinks in Read mode: open the target note, or create it if it doesn't exist yet.
        initCodeCopy();
        initImageResize();
        initImageLightbox();
        initNoteFind();
        el.read.addEventListener('click', (e) => {
            const wl = e.target.closest('.nv-wikilink');
            if (wl) { e.preventDefault(); if ((e.ctrlKey || e.metaKey) && rpOpenFromLeft(wl.dataset.wikilink)) return; openOrCreateByTitle(wl.dataset.wikilink); return; }
            const cb = e.target.closest('input[type="checkbox"]');
            if (!cb) return;
            // Let the native click go through — by this point the browser has already
            // flipped cb.checked to its new value (see setTaskCheckedAt's comment) — then
            // write that exact value into the markdown. No preventDefault(): we want the
            // browser's own toggle to be the one true state, not a second one layered on top.
            if (S.viewRev || cb.disabled || !S.note) { e.preventDefault(); return; }   // read-only revision preview
            const items = [...el.read.querySelectorAll('input[type="checkbox"]')];
            const idx = items.indexOf(cb);
            if (idx === -1 || !setTaskCheckedAt(idx, cb.checked)) return;
            el.src.value = S.note.markdown;
            markDirty();
        });

        // formatting toolbar
        const tip = (b) => {
            const name = b.dataset.tip || b.textContent.trim(), key = SHORTCUTS[b.dataset.cmd];
            b.title = key ? name + ' (' + MOD_LABEL + key + ')' : name;
            b.setAttribute('aria-label', name);
        };
        el.tools.querySelectorAll('.nv-tb[data-cmd]').forEach(tip);
        const tbButtons = () => [...el.toolsScroll.querySelectorAll('.nv-tb'), el.toolsMore];
        const rove = (target) => { tbButtons().forEach((b) => { b.tabIndex = (b === target) ? 0 : -1; }); };
        rove(tbButtons()[0]);
        // keep the textarea's caret + selection: never let a toolbar click take focus away from it
        el.tools.addEventListener('mousedown', (e) => { if (e.target.closest('.nv-tb, .nv-act')) e.preventDefault(); });
        el.tools.addEventListener('click', (e) => {
            const b = e.target.closest('[data-cmd]');
            if (!b) return;
            closeMenus();
            runCmd(b.dataset.cmd);
        });
        el.toolsMore.addEventListener('click', () => toggleMenu(el.toolsMore, el.toolsMenu));
        el.tools.addEventListener('keydown', (e) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            const list = tbButtons(), i = list.indexOf(document.activeElement);
            if (i < 0) return;
            e.preventDefault();
            const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
            rove(list[j]); list[j].focus();
        });
        el.src.addEventListener('keydown', onEditorKey);
        el.src.addEventListener('paste', onEditorPaste);
        el.src.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && String(e.key).toLowerCase() === 'v') { plainPasteOnce = true; setTimeout(() => { plainPasteOnce = false; }, 800); }
        });
        el.src.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); });
        el.src.addEventListener('drop', (e) => {
            const files = e.dataTransfer && e.dataTransfer.files
                ? Array.from(e.dataTransfer.files).filter((f) => /^image\//.test(f.type) || f.type === 'application/pdf' || !!sheetMimeOf(f)) : [];
            if (!files.length) return;
            e.preventDefault();
            insertAttachments(files);   // inserts at the current selection — dropping doesn't move the caret in a plain <textarea>
        });
        if (el.attachInput) {
            el.attachInput.addEventListener('change', () => {
                const files = Array.from(el.attachInput.files || []);
                if (files.length) insertAttachments(files);
                el.attachInput.value = '';   // reset so picking the same file twice still fires 'change'
            });
        }
        if (el.pdfInput) {
            el.pdfInput.addEventListener('change', () => {
                const files = Array.from(el.pdfInput.files || []);
                if (files.length) insertAttachments(files);
                el.pdfInput.value = '';
            });
        }
        if (el.fileInput) {
            el.fileInput.addEventListener('change', () => {
                const files = Array.from(el.fileInput.files || []);
                if (files.length) insertAttachments(files);
                el.fileInput.value = '';
            });
        }
        ['keyup', 'mouseup', 'input', 'focus'].forEach((ev) => el.src.addEventListener(ev, () => { refreshToolbar(); checkWlTrigger(); }));
        el.src.addEventListener('blur', () => setTimeout(closeWlPopup, 150));   // delayed so a click on the popup still registers first
        if (el.wlPop) {
            el.wlPop.addEventListener('mousedown', (e) => e.preventDefault());  // don't steal focus from the textarea
            el.wlPop.addEventListener('click', (e) => {
                const li = e.target.closest('li[data-i]');
                if (li) applyWlPick(WL.items[+li.dataset.i]);
            });
        }

        // inspector
        el.tabInfo.addEventListener('click', () => setInspTab('info'));
        el.tabOutline.addEventListener('click', () => setInspTab('outline'));
        el.tabLinks.addEventListener('click', () => setInspTab('links'));
        el.tabContext.addEventListener('click', () => setInspTab('context'));
        el.tabHistory.addEventListener('click', () => setInspTab('history'));
        // Links tab: open the target note, or create it (for an unresolved outgoing link).
        [el.linksOut, el.linksBack, el.mentionsList].forEach((box) => box.addEventListener('click', (e) => {
            const b = e.target.closest('[data-open],[data-create]');
            if (!b) return;
            if (b.dataset.open) openNote(b.dataset.open);
            else openOrCreateByTitle(b.dataset.create);
        }));
        el.mentionsToggle.addEventListener('click', () => {
            if (!S.note) return;
            const willOpen = el.mentionsToggle.getAttribute('aria-expanded') !== 'true';
            if (willOpen) S.mentionsClosed.delete(S.note.id); else S.mentionsClosed.add(S.note.id);
            renderMentions();
        });
        // Context tab: open a related note, or jump to a linked entity in its own tracker
        // (same window.jumpFromNoteToX bridges the doc-meta pills already use).
        el.context.addEventListener('click', (e) => {
            const openBtn = e.target.closest('[data-open]');
            if (openBtn) { openNote(openBtn.dataset.open); return; }
            const jumpBtn = e.target.closest('[data-ctx-jump]');
            if (!jumpBtn || !S.note) return;
            const type = jumpBtn.dataset.ctxJump;
            const entry = EntityLinks.getEntry(S.note, type);
            if (!entry) return;
            if (type === 'skill' && window.jumpFromNoteToSkill) window.jumpFromNoteToSkill(entry.career, entry.id);
            else if (type === 'course' && window.jumpFromNoteToCourse) window.jumpFromNoteToCourse(entry.id);
            else if (type === 'resource' && window.jumpFromNoteToResource) window.jumpFromNoteToResource(entry.id);
            else if (type === 'analysis' && window.jumpFromNoteToAnalysis) window.jumpFromNoteToAnalysis(entry.id);
            else if (type === 'deal' && window.jumpFromNoteToDeal) window.jumpFromNoteToDeal(entry.id);
        });
        el.histList.addEventListener('click', (e) => {
            const b = e.target.closest('[data-rev]');
            if (!b) return;
            if (b.dataset.rev === 'current') backToCurrent(); else viewRevision(b.dataset.rev);
        });
        el.saveVersion.addEventListener('click', saveVersionNow);
        el.histClear.addEventListener('click', clearHistory);
        el.revBack.addEventListener('click', backToCurrent);
        el.revRestore.addEventListener('click', () => { if (S.viewRev) restoreRevision(S.viewRev.id); });
        el.outline.addEventListener('click', (e) => {
            const b = e.target.closest('[data-o]');
            if (b) jumpToHeading(+b.dataset.o);
        });
        el.folderIn.addEventListener('input', () => {
            if (!S.note) return;
            S.note.type = normType(el.folderIn.value);
            renderDocMeta();
            markDirty();
        });
        el.folderIn.addEventListener('blur', () => {
            if (!S.note) return;
            // Typed a near-duplicate of a folder you already have? Snap to the existing one.
            const dupOf = findExistingFolder(S.note.type);
            if (dupOf && dupOf !== normType(S.note.type)) {
                S.note.type = dupOf; renderDocMeta(); markDirty();
                toast('Folder \u201c' + dupOf + '\u201d already exists \u2014 using it.');
            }
            el.folderIn.value = normType(S.note.type);
        });
        attachCombo(el.folderIn, el.folderPop, { getOptions: () => S.folderOpts || [] });

        if (el.linkedCareer) el.linkedCareer.addEventListener('change', () => {
            if (!S.note) return;
            S.note.linkedCareer = el.linkedCareer.value;
            EntityLinks.unlink(S.note, 'skill');           // career changed → old skill choice no longer applies
            nvPopulateSkillOptions();
            renderDocMeta();
            renderContextPane();
            markDirty();
            if (window.nvRefreshSkillBadges) window.nvRefreshSkillBadges();
        });
        if (el.linkedSkill) el.linkedSkill.addEventListener('change', () => {
            if (!S.note) return;
            EntityLinks.link(S.note, 'skill', el.linkedSkill.value, { career: S.note.linkedCareer });
            renderDocMeta();
            renderContextPane();
            markDirty();
            if (window.nvRefreshSkillBadges) window.nvRefreshSkillBadges();
        });
        if (el.course) el.course.addEventListener('input', () => {
            if (!S.note) return;
            S.note.course = el.course.value;
            const hit = resolveCourseLink(el.course.value);
            EntityLinks.link(S.note, 'course', hit ? hit.id : '');
            renderDocMeta();
            renderContextPane();
            markDirty();
            if (window.nvRefreshCourseBadges) window.nvRefreshCourseBadges();
        });
        attachCombo(el.course, el.coursePop, { getOptions: () => S.courseOpts || [] });
        if (el.resource) el.resource.addEventListener('input', () => {
            if (!S.note) return;
            S.note.resource = el.resource.value;
            const hit = resolveResourceLink(el.resource.value);
            EntityLinks.link(S.note, 'resource', hit ? hit.id : '');
            renderDocMeta();
            renderContextPane();
            markDirty();
            if (window.nvRefreshResourceBadges) window.nvRefreshResourceBadges();
        });
        attachCombo(el.resource, el.resourcePop, { getOptions: () => S.resourceOpts || [] });
        if (el.analysis) el.analysis.addEventListener('input', () => {
            if (!S.note) return;
            S.note.analysis = el.analysis.value;
            const hit = resolveAnalysisLink(el.analysis.value);
            EntityLinks.link(S.note, 'analysis', hit ? hit.id : '');
            renderDocMeta();
            renderContextPane();
            markDirty();
            if (window.nvRefreshAnalysisBadges) window.nvRefreshAnalysisBadges();
        });
        attachCombo(el.analysis, el.analysisPop, { getOptions: () => S.analysisOpts || [] });
        if (el.deal) el.deal.addEventListener('input', () => {
            if (!S.note) return;
            S.note.deal = el.deal.value;
            const hit = resolveDealLink(el.deal.value);
            EntityLinks.link(S.note, 'deal', hit ? hit.id : '');
            renderDocMeta();
            renderContextPane();
            markDirty();
            if (window.nvRefreshDealBadges) window.nvRefreshDealBadges();
        });
        attachCombo(el.deal, el.dealPop, { getOptions: () => S.dealOpts || [] });
        if (el.deadline) el.deadline.addEventListener('change', () => {
            if (!S.note) return;
            S.note.deadline = el.deadline.value;
            renderDocMeta();
            markDirty();
        });
        if (el.remind) {
            el.remind.addEventListener('change', () => {
                if (!S.note) return;
                const v = el.remind.value;
                if (v && remParse(v) <= Date.now()) { toast('That time has already passed.'); fillRemind(); return; }
                remSet(v);
            });
            if (el.remindChips) el.remindChips.addEventListener('click', (e) => {
                const b = e.target.closest('[data-rem]');
                if (b && S.note) remChip(b.getAttribute('data-rem'));
            });
        }
        if (el.todayBtn) el.todayBtn.addEventListener('click', () => { remOpenPanel(); });
        { const sb = document.getElementById('nvSplitBtn'); if (sb) sb.addEventListener('click', () => { splitOpen(); }); }
        { const fold = document.getElementById('nvTrackerFold');
          if (fold) ['input', 'change', 'focusout', 'click'].forEach((ev) => fold.addEventListener(ev, () => requestAnimationFrame(nvUpdateLinkCount))); }
        // ── Map relations (Info tab): parent / sub-notes / connections ──
        if (el.relParent && el.relKidIn && el.relLinkIn) {
            const pickParent = async (title) => {
                const n = S.note, p = mapNoteByTitle(title);
                if (!n) return;
                if (!p) { toast('No note with that title.'); return; }
                el.relParent.value = '';
                const old = mapParentOf(n, mapById());
                if (await mapSetParent(n, p)) {
                    mapChanged();
                    if (old && old !== p) toast('Parent changed: “' + mapTitle(old) + '” → “' + mapTitle(p) + '”. A note has only one parent.', 'Undo', async () => {
                        if (S.note !== n) return;
                        if (await mapSetParent(n, old)) mapChanged();
                    });
                }
            };
            attachCombo(el.relParent, el.relParentPop, {
                getOptions: () => { const n = S.note; if (!n) return []; const by = mapById(); return mapTitles((x) => !mapInside(n, x, by)); },
                onPick: pickParent
            });
            const pickKid = async (title) => {
                const n = S.note, k = mapNoteByTitle(title);
                if (!n) return;
                if (!k) { toast('No note with that title.'); return; }
                if (k === n) { toast('A note can\u2019t be its own sub-note.'); return; }
                el.relKidIn.value = '';
                const moved = k.mapParent && k.mapParent !== n.id;
                if (await mapSetParent(k, n)) {
                    mapChanged();
                    if (moved) toast('Moved \u201C' + mapTitle(k) + '\u201D here from its previous parent.');
                }
            };
            attachCombo(el.relKidIn, el.relKidPop, {
                getOptions: () => { const n = S.note; if (!n) return []; const by = mapById(); return mapTitles((x) => x !== n && x.mapParent !== n.id && !mapInside(x, n, by)); },
                onPick: pickKid
            });
            const pickLink = async (title) => {
                const n = S.note, t = mapNoteByTitle(title);
                if (!n) return;
                if (!t) { toast('No note with that title.'); return; }
                if (t === n) { toast('A note can\u2019t connect to itself.'); return; }
                const label = el.relLinkLabel.value;
                el.relLinkIn.value = ''; el.relLinkLabel.value = '';
                await mapAddLink(n, t, label);
                mapChanged();
            };
            attachCombo(el.relLinkIn, el.relLinkPop, {
                getOptions: () => { const n = S.note; if (!n) return []; mapRel(n); return mapTitles((x) => x !== n && !n.mapLinks.some((l) => l.id === x.id)); },
                onPick: pickLink
            });
            // Enter also works for a title typed in full (the suggestion list hides an exact match).
            [[el.relParent, pickParent], [el.relKidIn, pickKid], [el.relLinkIn, pickLink]].forEach(([inp, fn]) => inp.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' && inp.value.trim()) { ev.preventDefault(); fn(inp.value); }
            }));
            const relClick = async (ev) => {
                const b = ev.target.closest('button');
                const n = S.note;
                if (!b || !n) return;
                if (b.dataset.open) { openNote(b.dataset.open); return; }
                const by = mapById();
                if (b.hasAttribute('data-rm-parent')) await mapSetParent(n, null);
                else if (b.dataset.rmKid) { const k = by.get(b.dataset.rmKid); if (k) await mapSetParent(k, null); }
                else if (b.dataset.up) { const k = by.get(b.dataset.up); if (k) await mapMoveKid(k, -1); }
                else if (b.dataset.down) { const k = by.get(b.dataset.down); if (k) await mapMoveKid(k, 1); }
                else if (b.dataset.rmLink) await mapRemoveLink(n, b.dataset.rmLink);
                else return;
                mapChanged();
            };
            [el.relParentCur, el.relKids, el.relLinks, el.relIn].forEach((x) => x.addEventListener('click', relClick));
        }

        const addTags = (str) => {
            const n = S.note;
            if (!n) return;
            let added = false;
            for (const raw of String(str).split(',')) {
                const t = normTag(raw);
                if (!t || n.tags.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
                n.tags.push(t); added = true;
            }
            if (added) { renderTagChips(); renderDocMeta(); markDirty(); }
        };
        // enterPicks: false — Enter/comma already commit the typed tag below; a click on a
        // suggestion commits it immediately via onPick instead of just filling the text.
        attachCombo(el.tagIn, el.tagPop, {
            getOptions: () => S.tagOpts || [],
            multi: true,
            enterPicks: false,
            onPick: (v) => { addTags(v); el.tagIn.value = ''; el.tagIn.focus(); }
        });
        el.tagIn.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ',') && el.tagIn.value.trim()) {
                e.preventDefault(); addTags(el.tagIn.value); el.tagIn.value = '';
            } else if (e.key === 'Backspace' && !el.tagIn.value && S.note && S.note.tags.length) {
                S.note.tags.pop(); renderTagChips(); renderDocMeta(); markDirty();
            }
        });
        el.tagIn.addEventListener('input', () => {
            if (el.tagIn.value.includes(',')) { addTags(el.tagIn.value); el.tagIn.value = ''; }
        });
        el.tagIn.addEventListener('blur', () => { if (el.tagIn.value.trim()) { addTags(el.tagIn.value); el.tagIn.value = ''; } });
        el.tagBox.addEventListener('click', (e) => {
            const b = e.target.closest('[data-rm]');
            if (b && S.note) { S.note.tags.splice(+b.dataset.rm, 1); renderTagChips(); renderDocMeta(); markDirty(); }
            else if (e.target === el.tagBox) el.tagIn.focus();
        });

        // backup / storage menu
        el.gear.addEventListener('click', () => toggleMenu(el.gear, el.gearMenu));
        el.gearMenu.addEventListener('click', (e) => {
            const b = e.target.closest('[data-gear]');
            if (!b) return;
            closeMenus();
            if (b.dataset.gear === 'exportmd') exportCurrentView();
            else if (b.dataset.gear === 'export') exportAllJson();
            else if (b.dataset.gear === 'import') el.importFile.click();
            else if (b.dataset.gear === 'importmd') el.mdFile.click();
            else if (b.dataset.gear === 'importmddir') el.mdDir.click();
            else if (b.dataset.gear === 'importpdf') el.pdfNote.click();
            else if (b.dataset.gear === 'importdocx') el.docxNote.click();
            else if (b.dataset.gear === 'persist') requestPersist();
            else if (b.dataset.gear === 'dupes') openDupModal();
            else if (b.dataset.gear === 'findreplace') openFrModal();
            else if (b.dataset.gear === 'storage') openStorModal();
        });
        el.importFile.addEventListener('change', () => importJson(el.importFile.files[0]));
        el.mdFile.addEventListener('change', async () => { const fl = Array.from(el.mdFile.files || []); el.mdFile.value = ''; await importMarkdownFiles(fl, false); });
        el.mdDir.addEventListener('change', async () => { const fl = Array.from(el.mdDir.files || []); el.mdDir.value = ''; await importMarkdownFiles(fl, true); });
        el.pdfNote.addEventListener('change', async () => { const fl = Array.from(el.pdfNote.files || []); el.pdfNote.value = ''; await importPdfAsNotes(fl); });
        el.docxNote.addEventListener('change', async () => { const fl = Array.from(el.docxNote.files || []); el.docxNote.value = ''; await importDocxAsNotes(fl); });

        /* Drag & drop files anywhere in the vault: .pdf → note (text / OCR), .md/.txt → note.
           Dropping straight onto the editor in Edit mode keeps its old behaviour (a PDF is
           attached inline at the cursor) — that handler runs first and marks the event handled. */
        (function wireVaultDrop() {
            const app = document.getElementById('nvApp');
            if (!app) return;
            let depth = 0, hint = null;
            const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
            const isPdfF = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
            const isMdF = (f) => /\.(md|markdown|mdown|txt)$/i.test(f.name);
            const isDocxF = (f) => /\.docx$/i.test(f.name);
            const showHint = () => {
                if (hint) return;
                hint = document.createElement('div');
                hint.textContent = 'Drop .pdf, .docx, .md, .txt or Excel (.xlsx, .xls, .csv) files to import them as notes';
                hint.style.cssText = 'position:fixed;inset:12px;z-index:99999;pointer-events:none;display:flex;align-items:center;justify-content:center;'
                    + 'border:3px dashed var(--primary,#db2777);border-radius:18px;background:rgba(219,39,119,.10);color:var(--primary,#db2777);'
                    + 'font:600 1.1rem system-ui,sans-serif;text-align:center;padding:20px;backdrop-filter:blur(2px);';
                app.appendChild(hint);
            };
            const hideHint = () => { depth = 0; if (hint) { hint.remove(); hint = null; } };
            app.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; showHint(); } });
            app.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
            app.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) hideHint(); });
            app.addEventListener('drop', (e) => {
                hideHint();
                if (e.defaultPrevented || !hasFiles(e)) return;
                e.preventDefault();
                const fl = Array.from(e.dataTransfer.files);
                const pdfs = fl.filter(isPdfF), docxs = fl.filter(isDocxF), mds = fl.filter((f) => !isPdfF(f) && isMdF(f)), sheets = fl.filter((f) => !isPdfF(f) && !isDocxF(f) && !isMdF(f) && !!sheetMimeOf(f));
                if (!pdfs.length && !mds.length && !docxs.length && !sheets.length) { toast('Drop .pdf, .docx, .md, .txt or Excel (.xlsx, .xls, .csv) files to import them as notes.'); return; }
                (async () => {
                    if (mds.length) await importMarkdownFiles(mds, false);
                    if (pdfs.length) await importPdfAsNotes(pdfs);
                    if (docxs.length) await importDocxAsNotes(docxs);
                    if (sheets.length) await importSheetsAsNotes(sheets);
                })();
            });
            window.addEventListener('dragend', hideHint);
            window.addEventListener('drop', hideHint);
        })();

        // Find duplicates modal
        el.dupClose.addEventListener('click', closeDupModal);
        el.dupScrim.addEventListener('click', closeDupModal);
        el.dupRescan.addEventListener('click', () => { S.dup.swapped.clear(); S.dup.compareKey = null; scanDuplicates(); });
        el.dupBody.addEventListener('click', handleDupAction);
        // Find & Replace modal
        wireFr();

        // Customize folder popover (icon + color)
        el.fedClose.addEventListener('click', closeFolderEditor);
        el.fedDone.addEventListener('click', closeFolderEditor);
        el.fedScrim.addEventListener('click', closeFolderEditor);
        el.fedReset.addEventListener('click', resetFolderStyle);
        el.fedIcons.addEventListener('click', (e) => {
            const b = e.target.closest('[data-fed-icon]');
            if (b) applyFolderStyleChange({ icon: b.dataset.fedIcon });
        });
        el.fedColors.addEventListener('click', (e) => {
            const b = e.target.closest('[data-fed-color]');
            if (b) applyFolderStyleChange({ color: b.dataset.fedColor });
        });

        // Storage manager modal
        el.storClose.addEventListener('click', closeStorModal);
        el.storScrim.addEventListener('click', closeStorModal);
        el.storRefresh.addEventListener('click', renderStorBody);
        el.stor.querySelectorAll('[data-stor-tab]').forEach((b) => b.addEventListener('click', () => switchStorTab(b.dataset.storTab)));

        // density toggle (Comfortable / Compact row spacing in the list view)
        applyDensity();
        el.densityBtn.addEventListener('click', () => toggleDensity());

        // vault theme (Sakura Mist / Comfort Bloom) — scoped to the vault only, remembered per device
        applyTheme();
        el.themeBtn.addEventListener('click', () => toggleMenu(el.themeBtn, el.themeMenu));
        el.themeMenu.addEventListener('click', (e) => {
            const b = e.target.closest('[data-theme]');
            if (!b) return;
            S.theme = b.dataset.theme;
            try { localStorage.setItem('nvTheme', S.theme); } catch (err) { /* ignore */ }
            applyTheme();
            closeMenus();
        });

        // text size (A−/A+): now applied unconditionally, not just inside Focus mode
        applyFontSize();

        // sort menu
        el.sortBtn.addEventListener('click', () => toggleMenu(el.sortBtn, el.sortMenu));
        el.sortMenu.addEventListener('click', (e) => {
            const b = e.target.closest('[data-sort]');
            if (!b) return;
            S.sort = b.dataset.sort;
            el.sortMenu.querySelectorAll('.nv-sort-opt').forEach((o) => o.setAttribute('aria-checked', String(o === b)));
            closeMenus();
            S.limit = PAGE;
            renderLibrary();
        });

        // filter panel — every change re-renders the library immediately (no separate "Apply" step)
        el.filterBtn.addEventListener('click', () => { renderFilterOptions(); toggleMenu(el.filterBtn, el.filterMenu); });
        function updateFilterDot() { el.filterDot.hidden = !filtersActive(); }
        function applyFilterChange() { S.limit = PAGE; updateFilterDot(); renderLibrary(); }
        el.fType.addEventListener('change', () => { S.filters.type = el.fType.value; applyFilterChange(); });
        el.fFolder.addEventListener('change', () => { S.filters.folder = el.fFolder.value; applyFilterChange(); });
        let fTagTimer = null;
        el.fTag.addEventListener('input', () => {
            clearTimeout(fTagTimer);
            fTagTimer = setTimeout(() => {
                S.filters.tags = el.fTag.value.split(',').map((t) => t.trim().replace(/^#+/, '').toLowerCase()).filter(Boolean);
                applyFilterChange();
            }, 200);
        });
        attachCombo(el.fTag, el.fTagPop, { getOptions: () => S.tagOpts || [], multi: true });
        el.fCreated.addEventListener('change', () => { S.filters.createdDays = el.fCreated.value; applyFilterChange(); });
        el.fUpdated.addEventListener('change', () => { S.filters.updatedDays = el.fUpdated.value; applyFilterChange(); });
        el.fChecklist.addEventListener('change', () => { S.filters.checklist = el.fChecklist.checked; applyFilterChange(); });
        el.fCode.addEventListener('change', () => { S.filters.code = el.fCode.checked; applyFilterChange(); });
        el.fLink.addEventListener('change', () => { S.filters.link = el.fLink.checked; applyFilterChange(); });
        el.fPinned.addEventListener('change', () => { S.filters.pinnedOnly = el.fPinned.checked; applyFilterChange(); });
        el.filterClear.addEventListener('click', () => {
            S.filters = { type: '', folder: '', tags: [], createdDays: '', updatedDays: '', checklist: false, code: false, link: false, pinnedOnly: false };
            el.fType.value = ''; el.fFolder.value = ''; el.fTag.value = ''; el.fCreated.value = ''; el.fUpdated.value = '';
            el.fChecklist.checked = false; el.fCode.checked = false; el.fLink.checked = false; el.fPinned.checked = false;
            applyFilterChange();
        });

        // menus close on outside click
        document.addEventListener('click', (e) => { if (S.open && !e.target.closest('.nv-menuwrap')) closeMenus(); });

        // keyboard
        document.addEventListener('keydown', (e) => {
            if (!S.open) return;
            const mod = e.ctrlKey || e.metaKey;
            if (e.key === 'Escape') {
                if (Gr.open) { closeGraph(); return; }
                if (S.fr.open) { if (S.fr.confirm) { S.fr.confirm = null; frRender(); } else closeFrModal(); return; }
                if (S.dup.open) { closeDupModal(); return; }
                if (S.stor.open) { closeStorModal(); return; }
                if (!el.fed.hidden) { closeFolderEditor(); return; }
                if (rpCloseMenu()) return;
                if (closeMenus()) return;
                if (S.focus) { toggleFocus(false); return; }
                if (closeDrawers()) return;
                if (S.viewRev) { backToCurrent(); return; }
                if (S.note) leaveDoc(); else close();
            } else if ((IS_MAC ? (e.metaKey && e.altKey && !e.ctrlKey && keyIs(e, 'f')) : (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && keyIs(e, 'h')))
                       && !S.dup.open && !S.stor.open && !P.open) {
                // Find & Replace: Ctrl+H (⌘⌥F on Mac, where ⌘H hides the app)
                e.preventDefault();
                if (S.fr.open) { el.frFind.focus(); el.frFind.select(); } else openFrModal();
            } else if (e.altKey && !mod && !e.shiftKey && keyIs(e, 'n')) {
                // Alt/⌥+N = New note (Ctrl+N is reserved by the browser, so it can't be used)
                e.preventDefault();
                newNote();
            } else if (mod && e.shiftKey && (e.key === 'f' || e.key === 'F') && S.note) {
                e.preventDefault();
                toggleFocus();
            } else if (mod && e.shiftKey && (e.key === 's' || e.key === 'S') && S.note) {
                e.preventDefault();
                flushSave().then(() => runAction(S.fileLinks.get(S.note.id) ? 'savefsupdate' : 'savefs'));
            } else if (mod && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                Promise.all([flushSave(), rpFlush()]).then(() => { if (S.note && !S.dirty && !rp.dirty) flash('Saved'); });
            } else if (mod && (e.key === 'e' || e.key === 'E') && S.note) {
                e.preventDefault();
                toggleEditRead();
            } else if (mod && !e.altKey && ((!e.shiftKey && keyIs(e, 'k')) || (e.shiftKey && keyIs(e, 'p')))) {
                e.preventDefault();
                openPalette();
            } else if (e.key === '/' && !mod && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) && !e.target.isContentEditable) {
                e.preventDefault();
                if (mq('(max-width: 900px)')) { S.sideOpen = true; applyLayout(); }
                el.search.focus();
            } else if (e.key === 'Tab') {
                trapTab(e);
            }
        });

        // never lose the last few keystrokes
        window.addEventListener('pagehide', () => { if (S.open) settle(); });
        document.addEventListener('visibilitychange', () => { if (document.hidden && S.open) settle(); });

        // ── command palette ──
        el.palKeyHint.textContent = keyText(['mod', 'K']);
        el.palOpen.addEventListener('click', openPalette);
        el.palClose.addEventListener('click', () => closePalette());
        el.palScrim.addEventListener('click', () => closePalette());
        el.palIn.addEventListener('keydown', palKey);
        el.palIn.addEventListener('input', () => {
            clearTimeout(P.timer);
            P.active = 0;
            P.timer = setTimeout(() => { P.timer = 0; palRender(); }, 90);
        });
        el.palList.addEventListener('mousemove', (e) => {
            const row = e.target.closest('.nv-pal-row');
            if (!row) return;
            const i = +row.dataset.i;
            if (i !== P.active) palSetActive(i, false);
        });
        el.palList.addEventListener('click', (e) => {
            const row = e.target.closest('.nv-pal-row');
            if (row) palRun(+row.dataset.i);
        });

        if (el.tabStrip) el.tabStrip.addEventListener('click', (e) => {
            const close = e.target.closest('[data-close-tab]');
            if (close) { closeTab(close.dataset.closeTab); return; }
            const tab = e.target.closest('[data-tab-id]');
            if (tab) openNote(tab.dataset.tabId);
        });
        S.tabs = loadTabsFromStorage();          // ids only — resolved against S.notes once the vault first opens

        setInspTab('info');
    }

    /* ═════════════ Graph view ═════════════
       A force-directed map of the vault: every live note is a node, [[wikilinks]]
       between notes become edges, and (optionally) each tag becomes its own small
       node linking every note that carries it. Positions are simulated with a
       simple repulsion/spring/centering model and drawn on a single <canvas>;
       the render loop keeps redrawing every frame (not just while the simulation
       is "hot") so panning, zooming and dragging always feel immediate. */
    const Gr = {
        open: false, nodes: [], links: [], byId: new Map(),
        scope: '', query: '', selected: null,
        optTags: true, optUnlinked: true, optLabels: true, optCurrent: true,
        scale: 1, tx: 0, ty: 0, w: 0, h: 0, dpr: 1,
        dragNode: null, panning: false, panStart: null, moved: false,
        alpha: 1, raf: 0
    };
    let gEl = null;

    const GRAPH_PALETTE = ['#d17b96', '#6bbfa8', '#b892c9', '#d99a6c', '#7a9fd1', '#c97f7f', '#8fb87a', '#3f9b72'];
    function graphColorFor(key) {
        let h = 0;
        const s = String(key || '');
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return GRAPH_PALETTE[h % GRAPH_PALETTE.length];
    }
    function nodeRadius(nd) {
        return nd.kind === 'tag' ? 5 + Math.min(6, nd.degree * 0.5) : 8 + Math.min(14, nd.degree * 1.6);
    }
    function truncateLabel(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
    function roundRectPath(ctx, x, y, w, h, r) {
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    // Builds Gr.nodes / Gr.links fresh from S.notes + the current scope/toggle state,
    // carrying position/velocity forward from the previous build so a rebuild (e.g.
    // toggling "show tags") doesn't reset the whole layout.
    function buildGraphData() {
        const scope = Gr.scope;
        const live = S.notes.filter((n) => !n.deletedAt && (!scope || typeKey(n.type) === scope));
        const nodes = [], byId = new Map();

        function noteNode(n) {
            const id = 'n:' + n.id;
            let nd = byId.get(id);
            if (!nd) {
                const folder = normType(n.type);
                nd = {
                    id, kind: 'note', noteId: n.id, title: n.title.trim() || 'Untitled note', folder,
                    color: graphColorFor(typeKey(n.type)), degree: 0,
                    x: (Math.random() - 0.5) * 360, y: (Math.random() - 0.5) * 360, vx: 0, vy: 0, fx: null, fy: null
                };
                byId.set(id, nd); nodes.push(nd);
            }
            return nd;
        }
        function tagNode(t) {
            const id = 't:' + t.toLowerCase();
            let nd = byId.get(id);
            if (!nd) {
                nd = { id, kind: 'tag', title: t, degree: 0, x: (Math.random() - 0.5) * 360, y: (Math.random() - 0.5) * 360, vx: 0, vy: 0, fx: null, fy: null };
                byId.set(id, nd); nodes.push(nd);
            }
            return nd;
        }

        const links = [], linkKeys = new Set();
        function addLink(a, b) {
            if (a === b) return;
            const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
            if (linkKeys.has(key)) return;
            linkKeys.add(key);
            links.push({ a, b });
            a.degree++; b.degree++;
        }

        live.forEach(noteNode);
        for (const n of live) {
            const a = noteNode(n);
            for (const wl of extractWikilinks(n.markdown)) {
                const target = findNoteByTitle(wl.title);
                if (target && !target.deletedAt && (!scope || typeKey(target.type) === scope)) addLink(a, noteNode(target));
            }
        }
        if (Gr.optTags) {
            for (const n of live) {
                if (!n.tags || !n.tags.length) continue;
                const a = noteNode(n);
                for (const t of n.tags) addLink(a, tagNode(t));
            }
        }

        let finalNodes = Gr.optUnlinked ? nodes : nodes.filter((nd) => nd.degree > 0);
        const idset = new Set(finalNodes.map((nd) => nd.id));
        const finalLinks = links.filter((l) => idset.has(l.a.id) && idset.has(l.b.id));

        const prev = Gr.byId;
        for (const nd of finalNodes) {
            const old = prev.get(nd.id);
            if (old) { nd.x = old.x; nd.y = old.y; nd.vx = old.vx; nd.vy = old.vy; }
        }

        Gr.nodes = finalNodes; Gr.links = finalLinks;
        Gr.byId = new Map(finalNodes.map((nd) => [nd.id, nd]));
        applyGraphSearchMatch();
    }
    function applyGraphSearchMatch() {
        const q = fold(Gr.query.trim());
        for (const nd of Gr.nodes) nd.match = !q || fold(nd.title).includes(q);
    }

    function graphTick() {
        if (Gr.alpha <= 0.012) return;
        const { nodes, links, alpha } = Gr;
        const REPEL = 2600, LINK_DIST = 110;
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i], b = nodes[j];
                let dx = a.x - b.x, dy = a.y - b.y;
                let dSq = dx * dx + dy * dy;
                if (dSq < 0.02) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dSq = 1; }
                const d = Math.sqrt(dSq), f = (REPEL / dSq) * alpha;
                const fx = (dx / d) * f, fy = (dy / d) * f;
                a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
            }
        }
        for (const l of links) {
            let dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            const f = (d - LINK_DIST) * 0.045 * alpha;
            const fx = (dx / d) * f, fy = (dy / d) * f;
            l.a.vx += fx; l.a.vy += fy; l.b.vx -= fx; l.b.vy -= fy;
        }
        for (const nd of nodes) { nd.vx += -nd.x * 0.0025 * alpha; nd.vy += -nd.y * 0.0025 * alpha; }
        for (const nd of nodes) {
            if (nd.fx != null) { nd.x = nd.fx; nd.y = nd.fy; nd.vx = 0; nd.vy = 0; continue; }
            nd.vx *= 0.82; nd.vy *= 0.82; nd.x += nd.vx; nd.y += nd.vy;
        }
        Gr.alpha *= 0.985;
    }

    function graphColors() {
        const cs = getComputedStyle(document.documentElement);
        const v = (k, d) => (cs.getPropertyValue(k) || '').trim() || d;
        return {
            edge: v('--border-color', '#e5d2d8'), hi: v('--primary', '#d17b96'),
            text: v('--text-dark', '#4a3240'), muted: v('--text-muted', '#9a7686'),
            tag: v('--theme-accent-3', '#b892c9'), cur: v('--primary', '#d17b96')
        };
    }
    function screenToWorld(px, py) { return { x: (px - Gr.w / 2 - Gr.tx) / Gr.scale, y: (py - Gr.h / 2 - Gr.ty) / Gr.scale }; }
    function nodeAt(px, py) {
        const { x, y } = screenToWorld(px, py);
        let best = null, bestD = Infinity;
        for (const nd of Gr.nodes) {
            const r = nodeRadius(nd) + 3, dx = nd.x - x, dy = nd.y - y, d = dx * dx + dy * dy;
            if (d <= r * r && d < bestD) { bestD = d; best = nd; }
        }
        return best;
    }

    function graphRender() {
        if (!gEl) return;
        const ctx = gEl.ctx, C = graphColors();
        const { w, h, dpr, scale, tx, ty } = Gr;
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.translate(w / 2 + tx, h / 2 + ty);
        ctx.scale(scale, scale);

        const curId = Gr.optCurrent && S.note ? 'n:' + S.note.id : null;
        const sel = Gr.selected;
        const connected = new Set();
        if (sel) {
            connected.add(sel.id);
            for (const l of Gr.links) { if (l.a === sel) connected.add(l.b.id); else if (l.b === sel) connected.add(l.a.id); }
        }

        ctx.lineWidth = 1 / scale;
        for (const l of Gr.links) {
            const hi = sel && (l.a === sel || l.b === sel);
            ctx.strokeStyle = hi ? C.hi : C.edge;
            ctx.globalAlpha = sel ? (hi ? 0.9 : 0.12) : 0.5;
            ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y); ctx.stroke();
        }

        for (const nd of Gr.nodes) {
            const dim = (Gr.query.trim() && !nd.match) || (sel && !connected.has(nd.id));
            ctx.globalAlpha = dim ? 0.22 : 1;
            const r = nodeRadius(nd);
            ctx.beginPath();
            if (nd.kind === 'tag') roundRectPath(ctx, nd.x - r, nd.y - r, r * 2, r * 2, 3);
            else ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
            ctx.fillStyle = nd.kind === 'tag' ? C.tag : nd.color;
            ctx.fill();
            if (nd.id === curId) { ctx.lineWidth = 3 / scale; ctx.strokeStyle = C.cur; ctx.stroke(); }
            else if (nd === sel) { ctx.lineWidth = 2.5 / scale; ctx.strokeStyle = C.text; ctx.stroke(); }
            if (Gr.optLabels && scale > 0.42) {
                ctx.fillStyle = nd.kind === 'tag' ? C.muted : C.text;
                ctx.font = (nd.kind === 'tag' ? '400 ' : '600 ') + (11 / scale).toFixed(1) + 'px ' + (typeof getComputedStyle === 'function' ? getComputedStyle(gEl.canvas).fontFamily || 'sans-serif' : 'sans-serif');
                ctx.textAlign = 'center';
                ctx.fillText(truncateLabel(nd.title, 24), nd.x, nd.y + r + 13 / scale);
            }
        }
        ctx.globalAlpha = 1;
        ctx.restore();
    }
    function graphLoop() {
        if (!Gr.open) return;
        graphTick();
        graphRender();
        Gr.raf = requestAnimationFrame(graphLoop);
    }

    function graphResize() {
        if (!gEl) return;
        const dpr = window.devicePixelRatio || 1;
        const w = gEl.wrap.clientWidth, h = gEl.wrap.clientHeight;
        Gr.w = w; Gr.h = h; Gr.dpr = dpr;
        gEl.canvas.width = Math.max(1, Math.round(w * dpr));
        gEl.canvas.height = Math.max(1, Math.round(h * dpr));
        gEl.canvas.style.width = w + 'px'; gEl.canvas.style.height = h + 'px';
    }
    function updateZoomLabel() { if (gEl) gEl.zoomPct.textContent = Math.round(Gr.scale * 100) + '%'; }
    function zoomBy(factor) { Gr.scale = Math.min(3, Math.max(0.15, Gr.scale * factor)); updateZoomLabel(); }
    function fitToScreen() {
        if (!Gr.nodes.length) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const nd of Gr.nodes) { minX = Math.min(minX, nd.x); maxX = Math.max(maxX, nd.x); minY = Math.min(minY, nd.y); maxY = Math.max(maxY, nd.y); }
        const gw = Math.max(40, maxX - minX), gh = Math.max(40, maxY - minY), pad = 56;
        const sx = (Gr.w - pad * 2) / gw, sy = (Gr.h - pad * 2) / gh;
        // A handful of nodes can end up clustered in a small box — let the view zoom in
        // further to fill the canvas rather than leaving most of it empty. Only truly
        // spread-out graphs are capped at 1.6x so labels stay comfortable to read.
        const cap = Gr.nodes.length <= 8 ? 3 : 1.6;
        Gr.scale = Math.min(cap, Math.max(0.15, Math.min(sx, sy)));
        Gr.tx = -((minX + maxX) / 2) * Gr.scale;
        Gr.ty = -((minY + maxY) / 2) * Gr.scale;
        updateZoomLabel();
    }

    function graphRebuild(resetView) {
        buildGraphData();
        renderGraphStat();
        gEl.empty.hidden = Gr.nodes.length > 0;
        Gr.alpha = 1;
        if (Gr.selected && !Gr.byId.has(Gr.selected.id)) selectGraphNode(null);
        if (resetView) fitToScreen();
    }
    function renderGraphStat() {
        const noteCount = Gr.nodes.filter((n) => n.kind === 'note').length;
        gEl.stat.textContent = 'Showing ' + noteCount + ' note' + (noteCount === 1 ? '' : 's') + ' · ' + Gr.links.length + ' connection' + (Gr.links.length === 1 ? '' : 's');
    }

    function connItemHtml(nd) {
        const dot = nd.kind === 'tag' ? 'var(--theme-accent-3)' : nd.color;
        return '<li><button class="nvg-conn-item" data-id="' + esc(nd.id) + '"><span class="nvg-conn-dot" style="background:' + dot + '"></span><span>' + esc(nd.title) + '</span><i class="fa-solid fa-chevron-right"></i></button></li>';
    }
    function wireConnClicks() {
        gEl.info.querySelectorAll('.nvg-conn-item').forEach((b) => b.addEventListener('click', () => {
            const nd = Gr.byId.get(b.dataset.id);
            if (nd) selectGraphNode(nd);
        }));
    }
    function selectGraphNode(nd) {
        Gr.selected = nd;
        renderGraphInfoPanel();
        if (nd && window.matchMedia('(max-width: 900px)').matches) gEl.side.classList.add('nvg-side-open');
        else if (!nd) gEl.side.classList.remove('nvg-side-open');
    }
    function renderGraphInfoPanel() {
        const nd = Gr.selected;
        if (!nd) {
            gEl.info.innerHTML = '<div class="nvg-hint"><i class="fa-solid fa-hand-pointer"></i> Click a node to see details. Double-click a note to open it.</div>';
            return;
        }
        if (nd.kind === 'tag') {
            const members = [];
            for (const l of Gr.links) {
                if (l.a === nd && l.b.kind === 'note') members.push(l.b);
                else if (l.b === nd && l.a.kind === 'note') members.push(l.a);
            }
            gEl.info.innerHTML =
                '<div class="nvg-node-head"><div class="nvg-node-ic" style="background:var(--theme-accent-3)"><i class="fa-solid fa-tag"></i></div>' +
                '<div><div class="nvg-node-title">' + esc(nd.title) + '</div><div class="nvg-node-sub">Tag · ' + members.length + ' note' + (members.length === 1 ? '' : 's') + '</div></div></div>' +
                '<div class="nvg-conn-h"><i class="fa-solid fa-diagram-project"></i> Notes with this tag</div>' +
                '<ul class="nvg-conn-list">' + (members.map(connItemHtml).join('') || '<li class="nvg-hint" style="padding:4px 8px">No notes yet.</li>') + '</ul>';
            wireConnClicks();
            return;
        }
        const note = S.notes.find((n) => n.id === nd.noteId);
        if (!note) { gEl.info.innerHTML = '<div class="nvg-hint">This note is no longer available.</div>'; return; }
        const connectedIds = new Set();
        for (const l of Gr.links) { if (l.a === nd) connectedIds.add(l.b.id); else if (l.b === nd) connectedIds.add(l.a.id); }
        const connectedNodes = [...connectedIds].map((id) => Gr.byId.get(id)).filter(Boolean)
            .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'tag' ? 1 : -1));
        const outCount = computeOutgoingLinks(note).length;
        const backCount = computeBacklinks(note).length;
        const snippet = plainSnippet(note.markdown);
        const isCurrent = S.note && S.note.id === note.id;
        gEl.info.innerHTML =
            '<div class="nvg-node-head"><div class="nvg-node-ic" style="background:' + nd.color + '"><i class="fa-solid fa-' + iconFor(note.type) + '"></i></div>' +
            '<div><div class="nvg-node-title">' + esc(nd.title) + (isCurrent ? ' <span style="color:var(--primary);font-size:.72rem;font-weight:700">· current</span>' : '') + '</div>' +
            '<div class="nvg-node-sub">' + esc(nd.folder) + '</div></div></div>' +
            (note.tags && note.tags.length ? '<div class="nvg-tagrow">' + note.tags.map((t) => '<span class="nvg-tagpill" data-tag="' + esc(t) + '">' + esc(t) + '</span>').join('') + '</div>' : '') +
            (snippet ? '<div class="nvg-node-desc">' + esc(snippet) + '</div>' : '') +
            '<div class="nvg-metarow"><i class="fa-regular fa-clock"></i><span>Created</span><span>' + esc(fmtFull(note.createdAt)) + '</span></div>' +
            '<div class="nvg-metarow"><i class="fa-solid fa-pen"></i><span>Updated</span><span>' + esc(fmtFull(note.updatedAt)) + '</span></div>' +
            '<div class="nvg-metarow"><i class="fa-regular fa-file-lines"></i><span>Words</span><span>' + wordCount(note.markdown) + '</span></div>' +
            '<div class="nvg-metarow"><i class="fa-solid fa-arrow-up-right-from-square"></i><span>Links out</span><span>' + outCount + '</span></div>' +
            '<div class="nvg-metarow"><i class="fa-solid fa-link"></i><span>Backlinks</span><span>' + backCount + '</span></div>' +
            '<div class="nvg-conn-h"><i class="fa-solid fa-diagram-project"></i> Connected (' + connectedNodes.length + ')</div>' +
            '<ul class="nvg-conn-list">' + (connectedNodes.map(connItemHtml).join('') || '<li class="nvg-hint" style="padding:4px 8px">No connections yet.</li>') + '</ul>' +
            '<button class="nv-btn nv-btn-primary nvg-open-btn" id="nvgOpenNoteBtn" type="button"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open this note</button>';
        const openBtn = $('nvgOpenNoteBtn');
        if (openBtn) openBtn.addEventListener('click', () => { closeGraph(); openNote(note.id); });
        gEl.info.querySelectorAll('.nvg-tagpill').forEach((p) => p.addEventListener('click', () => {
            const tn = Gr.byId.get('t:' + p.dataset.tag.toLowerCase());
            if (tn) selectGraphNode(tn);
        }));
        wireConnClicks();
    }

    function populateGraphScope() {
        const folders = liveFolders();
        gEl.scope.innerHTML = '<option value="">All Notes</option>' + folders.map((f) => '<option value="' + esc(f.key) + '">' + esc(f.label) + '</option>').join('');
        gEl.scope.value = Gr.scope;
    }

    function wireGraphCanvas() {
        const canvas = gEl.canvas, wrap = gEl.wrap;
        let downX = 0, downY = 0;
        canvas.addEventListener('pointerdown', (e) => {
            canvas.setPointerCapture(e.pointerId);
            const rect = canvas.getBoundingClientRect();
            const px = e.clientX - rect.left, py = e.clientY - rect.top;
            downX = px; downY = py; Gr.moved = false;
            const nd = nodeAt(px, py);
            if (nd) { Gr.dragNode = nd; const w = screenToWorld(px, py); nd.fx = w.x; nd.fy = w.y; }
            else { Gr.panning = true; Gr.panStart = { px, py, tx: Gr.tx, ty: Gr.ty }; wrap.classList.add('nvg-panning'); }
        });
        canvas.addEventListener('pointermove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const px = e.clientX - rect.left, py = e.clientY - rect.top;
            if (Math.abs(px - downX) > 3 || Math.abs(py - downY) > 3) Gr.moved = true;
            if (Gr.dragNode) {
                const w = screenToWorld(px, py);
                Gr.dragNode.fx = w.x; Gr.dragNode.fy = w.y;
                Gr.alpha = Math.max(Gr.alpha, 0.3);
            } else if (Gr.panning) {
                Gr.tx = Gr.panStart.tx + (px - Gr.panStart.px);
                Gr.ty = Gr.panStart.ty + (py - Gr.panStart.py);
            } else {
                wrap.style.cursor = nodeAt(px, py) ? 'pointer' : 'grab';
            }
        });
        canvas.addEventListener('pointerup', () => {
            if (Gr.dragNode) {
                if (!Gr.moved) selectGraphNode(Gr.dragNode);
                Gr.dragNode.fx = null; Gr.dragNode.fy = null; Gr.dragNode = null;
            } else if (Gr.panning) {
                if (!Gr.moved) selectGraphNode(null);
                Gr.panning = false; wrap.classList.remove('nvg-panning');
            }
        });
        canvas.addEventListener('pointercancel', () => { Gr.dragNode = null; Gr.panning = false; wrap.classList.remove('nvg-panning'); });
        canvas.addEventListener('dblclick', (e) => {
            const rect = canvas.getBoundingClientRect();
            const nd = nodeAt(e.clientX - rect.left, e.clientY - rect.top);
            if (nd && nd.kind === 'note') { closeGraph(); openNote(nd.noteId); }
        });
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const px = e.clientX - rect.left, py = e.clientY - rect.top;
            const before = screenToWorld(px, py);
            Gr.scale = Math.min(3, Math.max(0.15, Gr.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
            Gr.tx = px - Gr.w / 2 - before.x * Gr.scale;
            Gr.ty = py - Gr.h / 2 - before.y * Gr.scale;
            updateZoomLabel();
        }, { passive: false });
    }

    function initGraphUI() {
        gEl = {
            scrim: $('nvGraphScrim'), panel: $('nvGraph'), wrap: $('nvgCanvasWrap'), canvas: $('nvgCanvas'),
            empty: $('nvgEmpty'), zoomPct: $('nvgZoomPct'), scope: $('nvgScope'), search: $('nvgSearch'),
            side: $('nvgSide'), info: $('nvgInfoPanel'), stat: $('nvgStat'),
            optTags: $('nvgOptTags'), optUnlinked: $('nvgOptUnlinked'), optLabels: $('nvgOptLabels'), optCurrent: $('nvgOptCurrent')
        };
        if (!gEl.canvas) return;
        gEl.ctx = gEl.canvas.getContext('2d');
        wireGraphCanvas();

        $('nvGraphBtn').addEventListener('click', openGraph);
        $('nvGraphClose').addEventListener('click', closeGraph);
        gEl.scrim.addEventListener('click', closeGraph);
        gEl.scope.addEventListener('change', () => { Gr.scope = gEl.scope.value; graphRebuild(true); });
        let gSearchTimer = null;
        gEl.search.addEventListener('input', () => {
            clearTimeout(gSearchTimer);
            gSearchTimer = setTimeout(() => { Gr.query = gEl.search.value; applyGraphSearchMatch(); }, 90);
        });
        gEl.search.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            const hit = Gr.nodes.find((n) => n.kind === 'note' && n.match && Gr.query.trim());
            if (hit) { selectGraphNode(hit); Gr.tx = -hit.x * Gr.scale; Gr.ty = -hit.y * Gr.scale; }
        });
        gEl.optTags.addEventListener('change', () => { Gr.optTags = gEl.optTags.checked; graphRebuild(false); });
        gEl.optUnlinked.addEventListener('change', () => { Gr.optUnlinked = gEl.optUnlinked.checked; graphRebuild(false); });
        gEl.optLabels.addEventListener('change', () => { Gr.optLabels = gEl.optLabels.checked; });
        gEl.optCurrent.addEventListener('change', () => { Gr.optCurrent = gEl.optCurrent.checked; });
        $('nvgZoomIn').addEventListener('click', () => zoomBy(1.2));
        $('nvgZoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
        $('nvgFit').addEventListener('click', fitToScreen);
        window.addEventListener('resize', () => { if (Gr.open) graphResize(); });
    }

    function openGraph() {
        if (!gEl) return;
        Gr.open = true; Gr.scope = ''; Gr.query = ''; Gr.selected = null;
        gEl.search.value = ''; gEl.scope.value = '';
        gEl.optTags.checked = Gr.optTags; gEl.optUnlinked.checked = Gr.optUnlinked;
        gEl.optLabels.checked = Gr.optLabels; gEl.optCurrent.checked = Gr.optCurrent;
        populateGraphScope();
        renderGraphInfoPanel();
        gEl.scrim.hidden = false; gEl.panel.hidden = false;
        $('nvGraphBtn').setAttribute('aria-expanded', 'true');
        requestAnimationFrame(() => {
            graphResize();
            buildGraphData();
            fitToScreen();
            renderGraphStat();
            gEl.empty.hidden = Gr.nodes.length > 0;
            Gr.alpha = 1;
            cancelAnimationFrame(Gr.raf);
            graphLoop();
        });
    }
    function closeGraph() {
        if (!Gr.open) return;
        Gr.open = false;
        cancelAnimationFrame(Gr.raf);
        gEl.scrim.hidden = true; gEl.panel.hidden = true;
        gEl.side.classList.remove('nvg-side-open');
        $('nvGraphBtn').setAttribute('aria-expanded', 'false');
    }

    /* ═════════════ Mermaid diagrams + Note map ═════════════
       1) Any ```mermaid fenced block in a note is drawn as a diagram in Read mode.
       2) "Structure map" draws the relations YOU set on each note (Info tab → Map relations):
            · Parent note   – this note is a sub-note of that one (parent → sub-note arrows),
            · Connected to  – a free link from this note to any other note, with an optional label (thick arrows).
          Nothing is guessed from titles or numbers.
       3) "Link map" draws the same kind of diagram from the [[links]] written in an index note.
       Mermaid is loaded from a CDN the first time it's needed. Every generated diagram ends with
       "%% nv <boxId> <noteId>" lines, which is how a click on a box finds its note again.
       `var` (not let/const) so these are safe to touch from renderInto() at any point. */
    var MM_VER = '10.9.3';
    var mmPromise = null, mmCounter = 0;
    var TM_KEY = 'nvMapOpts2';   // (options saved by the old numbered-notes map are simply left behind)
    var tmUI = { open: false, token: 0, zoom: 1, baseW: 0, el: null, opts: null };

    function loadMermaid() {
        if (window.mermaid) return Promise.resolve(window.mermaid);
        if (!mmPromise) mmPromise = loadScriptOnce('https://cdn.jsdelivr.net/npm/mermaid@' + MM_VER + '/dist/mermaid.min.js')
            .then(() => window.mermaid).catch((e) => { mmPromise = null; throw e; });
        return mmPromise;
    }
    // Is the vault currently showing a dark theme? (Probe the real --bg-white colour.)
    function mmIsDark() {
        try {
            const probe = document.createElement('div');
            probe.style.cssText = 'position:absolute;width:0;height:0;background:var(--bg-white)';
            (el.app || document.body).appendChild(probe);
            const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).backgroundColor);
            probe.remove();
            if (!m) return false;
            return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) < 128;
        } catch (e) { return false; }
    }
    function mmInit() {
        window.mermaid.initialize({
            startOnLoad: false, securityLevel: 'strict', theme: mmIsDark() ? 'dark' : 'default',
            fontFamily: 'inherit', flowchart: { curve: 'basis', htmlLabels: true }
        });
    }
    function mmCleanup(id) {   // mermaid leaves a stray element behind when a render fails
        [id, 'd' + id].forEach((x) => { const n = document.getElementById(x); if (n) n.remove(); });
    }
    function mmShowError(box, msg, src) {
        box.className = 'nv-mermaid nv-mermaid-err';
        box.textContent = '';
        const t = document.createElement('div');
        t.textContent = 'Couldn\u2019t draw this diagram: ' + msg;
        const pre = document.createElement('pre');
        pre.textContent = src;
        box.append(t, pre);
    }

    // ── In-note diagrams ──
    function mmMarkBlocks(root) {
        root.querySelectorAll('pre > code').forEach((code) => {
            if (!/(^|\s)language-mermaid(\s|$)/.test(code.className || '')) return;
            const box = document.createElement('div');
            box.className = 'nv-mermaid';
            box.setAttribute('data-mm-src', code.textContent || '');
            box.textContent = 'Drawing diagram\u2026';
            code.parentElement.replaceWith(box);
        });
    }
    async function mmRenderPending(target) {
        const boxes = Array.from(target.querySelectorAll('.nv-mermaid[data-mm-src]'));
        if (!boxes.length) return;
        let mm;
        try { mm = await loadMermaid(); }
        catch (e) { boxes.forEach((b) => mmShowError(b, e.message || 'Mermaid could not be loaded (offline?)', b.getAttribute('data-mm-src') || '')); return; }
        mmInit();
        for (const box of boxes) {
            if (!box.isConnected) continue;
            const src = box.getAttribute('data-mm-src') || '';
            box.removeAttribute('data-mm-src');
            const id = 'nvmm' + (++mmCounter);
            try {
                const out = await mm.render(id, src);
                if (!box.isConnected) continue;
                box.innerHTML = out.svg;
                mmAttachClicks(box, src, false);
            } catch (e) {
                mmCleanup(id);
                if (box.isConnected) mmShowError(box, String((e && e.message) || e).split('\n')[0], src);
            }
        }
    }
    // Makes diagram boxes open the note they stand for. The "%% nv <boxId> <noteId>" lines at the end of
    // a generated diagram say which note each box is; without them (a hand-written diagram) the exact
    // note title shown in the box is used.
    function mmAttachClicks(root, src, closeMapFirst) {
        const ids = {};
        String(src || '').split(/\r?\n/).forEach((ln) => {
            const m = /^\s*%%\s*nv\s+(\S+)\s+(\S+)\s*$/.exec(ln);
            if (m) ids[m[1]] = m[2];
        });
        root.querySelectorAll('.node').forEach((node) => {
            const label = (node.textContent || '').replace(/\s+/g, ' ').trim();
            const key = /flowchart-(.+)-\d+$/.exec(node.id || '');
            const byId = key && ids[key[1]] ? S.notes.find((n) => n.id === ids[key[1]]) : null;
            const hit = byId || tmNoteForLabel(label);
            if (!hit) return;
            node.style.cursor = 'pointer';
            node.classList.add('nv-mm-click');
            node.setAttribute('tabindex', '0');
            node.setAttribute('role', 'link');
            const full = String(hit.title || label);
            node.setAttribute('aria-label', 'Open note: ' + full);
            if (!node.querySelector(':scope > title')) {
                const tt = document.createElementNS('http://www.w3.org/2000/svg', 'title');
                tt.textContent = full;
                node.insertBefore(tt, node.firstChild);
            }
            const go = (e) => {
                e.stopPropagation();
                if (closeMapFirst) tmClose();
                openNote(hit.id);
            };
            node.addEventListener('click', go);
            node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } });
        });
    }
    function tmNoteForLabel(label) {
        const cut = /\u2026$/.test(label);
        const f = fold(String(label || '').replace(/\u2026$/, '').trim());
        if (!f) return null;
        const live = S.notes.filter((n) => !n.deletedAt);
        const exact = live.find((n) => fold(String(n.title || '').trim()) === f);
        if (exact) return exact;
        if (cut) {   // long titles are shortened with an ellipsis in the box
            const starts = live.filter((n) => fold(String(n.title || '').trim()).indexOf(f) === 0);
            if (starts.length === 1) return starts[0];
        }
        return null;
    }

    // ── Note relations: set by hand, never guessed ──
    //   n.mapParent  id of the note this one is a sub-note of ('' = none)
    //   n.mapOrder   place among its siblings (smaller comes first; 0 = not placed yet)
    //   n.mapLinks   [{ id, label }] — free connections from this note to other notes
    // They live on the note record itself (Info tab → Map relations, or the Map's "Set a relation").
    function mapRel(n) {   // notes saved before this feature (or just created) may lack the fields
        if (typeof n.mapParent !== 'string') n.mapParent = '';
        if (!(+n.mapOrder >= 0)) n.mapOrder = 0;
        if (!Array.isArray(n.mapLinks)) n.mapLinks = [];
        return n;
    }
    function mapLive() { return S.notes.filter((n) => !n.deletedAt).map((n) => mapRel(n)); }
    function mapById(list) { return new Map((list || mapLive()).map((n) => [n.id, n])); }
    function mapTitle(n) { return String(n.title || '').trim() || 'Untitled note'; }
    function mapSort(a, b) {   // siblings: the order you set, then oldest first
        return ((+a.mapOrder || 0) - (+b.mapOrder || 0)) || ((a.createdAt || 0) - (b.createdAt || 0)) || String(a.id).localeCompare(String(b.id));
    }
    function mapParentOf(n, byId) {   // the parent note, or null (no parent, or the parent is in Trash / gone)
        const p = n.mapParent ? byId.get(n.mapParent) : null;
        return p && p !== n ? p : null;
    }
    function mapKids(n, live) { return live.filter((x) => x !== n && x.mapParent === n.id).sort(mapSort); }
    function mapInside(top, node, byId) {   // is `node` the same note as `top`, or somewhere below it?
        let cur = node;
        for (let i = 0; cur && i < 1000; i++) {
            if (cur === top) return true;
            cur = mapParentOf(cur, byId);
        }
        return false;
    }
    function mapNoteByTitle(t) {
        const f = fold(String(t || '').trim());
        if (!f) return null;
        return mapLive().find((n) => fold(String(n.title || '').trim()) === f) || null;
    }
    function mapTitles(allow) {   // titles offered by the pick-a-note drop-downs
        return mapLive().filter((n) => String(n.title || '').trim() && (!allow || allow(n)))
            .map((n) => String(n.title).trim())
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    }
    // Depth-first list of every note (parents before their sub-notes, siblings in their set order) + parent → sub-notes.
    function mapTreeOrder(live, byId) {
        const kids = new Map();
        live.forEach((n) => {
            const p = mapParentOf(n, byId);
            if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(n); }
        });
        kids.forEach((a) => a.sort(mapSort));
        const order = [], seen = new Set();
        const walk = (n, level) => {
            if (seen.has(n)) return;
            seen.add(n); order.push({ note: n, level });
            (kids.get(n) || []).forEach((k) => walk(k, level + 1));
        };
        live.filter((n) => !mapParentOf(n, byId)).sort(mapSort).forEach((n) => walk(n, 1));
        live.forEach((n) => walk(n, 1));   // anything left over (a loop in imported data) still shows up once
        return { order, kids };
    }
    function mapRelatedSet(live, byId) {   // notes that are in at least one relation
        const s = new Set();
        live.forEach((n) => {
            const p = mapParentOf(n, byId);
            if (p) { s.add(n); s.add(p); }
            n.mapLinks.forEach((l) => { const t = byId.get(l.id); if (t && t !== n) { s.add(n); s.add(t); } });
        });
        return s;
    }
    // Saves relation changes. The open note goes through the normal autosave; every other note is written straight to the database.
    // Relations are bookkeeping, so "Edited …" times are left alone (same as pinning a note).
    async function mapCommit(list) {
        for (const n of list) {
            if (S.note === n) { S.dirty = true; await flushSave({ keepTime: true }); }
            else {
                try { await dbPut(n); }
                catch (e) { console.error('Notes Vault: could not save map relations for', n.id, e); toast('Couldn\u2019t save a relation.'); }
            }
        }
    }
    function mapNextOrder(parent, except) {
        let max = 0;
        mapLive().forEach((x) => { if (x !== except && x.mapParent === parent.id) max = Math.max(max, +x.mapOrder || 0); });
        return max + 1;
    }
    async function mapSetParent(child, parent) {   // parent = a note, or null to detach. Returns false when refused.
        mapRel(child);
        if (parent) {
            mapRel(parent);
            if (parent === child) return false;
            if (mapInside(child, parent, mapById())) {
                toast('\u201C' + mapTitle(parent) + '\u201D is already inside \u201C' + mapTitle(child) + '\u201D, so it can\u2019t also be its parent.');
                return false;
            }
        }
        const pid = parent ? parent.id : '';
        if (child.mapParent === pid) return true;
        child.mapParent = pid;
        child.mapOrder = parent ? mapNextOrder(parent, child) : 0;
        await mapCommit([child]);
        return true;
    }
    async function mapMoveKid(kid, dir) {   // dir -1 = earlier, +1 = later among its siblings
        const live = mapLive(), parent = mapById(live).get(kid.mapParent);
        if (!parent) return;
        const sibs = mapKids(parent, live), i = sibs.indexOf(kid), j = i + dir;
        if (i < 0 || j < 0 || j >= sibs.length) return;
        sibs.splice(j, 0, sibs.splice(i, 1)[0]);
        const changed = [];
        sibs.forEach((s, k) => { if (s.mapOrder !== k + 1) { s.mapOrder = k + 1; changed.push(s); } });
        await mapCommit(changed);
    }
    async function mapAddLink(from, to, label) {   // from → to; connecting the same pair again just updates the label
        if (!from || !to || from === to) return false;
        mapRel(from);
        const lab = String(label || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const have = from.mapLinks.find((l) => l.id === to.id);
        if (have) { if (have.label === lab) return true; have.label = lab; }
        else from.mapLinks.push({ id: to.id, label: lab });
        await mapCommit([from]);
        return true;
    }
    async function mapRemoveLink(from, toId) {
        mapRel(from);
        from.mapLinks = from.mapLinks.filter((l) => l.id !== toId);
        await mapCommit([from]);
    }
    // Something changed: refresh everything that shows relations.
    function mapChanged() {
        renderMapRel();
        seqUpdateNav();
        if (tmUI.open) tmRegenerate();
    }
    // Info tab → Map relations for the open note.
    function renderMapRel() {
        if (!el || !el.relParentCur || !S.note) return;
        const n = mapRel(S.note);
        const live = mapLive(), byId = mapById(live);
        const open = (x) => '<button type="button" class="nv-rel-open" data-open="' + esc(x.id) + '" title="' + esc(mapTitle(x)) + '">' + esc(mapTitle(x)) + '</button>';
        const btn = (attr, icon, title, off) => '<button type="button" class="nv-rel-btn" ' + attr + ' title="' + title + '" aria-label="' + title + '"' + (off ? ' disabled' : '') + '><i class="fa-solid fa-' + icon + '"></i></button>';
        const par = mapParentOf(n, byId);
        el.relParent.placeholder = par ? 'Change parent (replaces the current one)…' : 'This note belongs under…';
        el.relParentCur.innerHTML = par ? '<li class="nv-rel-item">' + open(par) + btn('data-rm-parent="1"', 'xmark', 'Remove parent') + '</li>' : '';
        const kids = mapKids(n, live);
        el.relKids.innerHTML = kids.map((k, i) => '<li class="nv-rel-item">' + open(k)
            + btn('data-up="' + esc(k.id) + '"', 'arrow-up', 'Move earlier', i === 0)
            + btn('data-down="' + esc(k.id) + '"', 'arrow-down', 'Move later', i === kids.length - 1)
            + btn('data-rm-kid="' + esc(k.id) + '"', 'xmark', 'Detach from this note') + '</li>').join('');
        el.relLinks.innerHTML = n.mapLinks.map((l) => {
            const t = byId.get(l.id);
            if (!t) return '';
            return '<li class="nv-rel-item">' + open(t) + (l.label ? '<span class="nv-rel-lab" title="' + esc(l.label) + '">' + esc(l.label) + '</span>' : '')
                + btn('data-rm-link="' + esc(t.id) + '"', 'xmark', 'Remove connection') + '</li>';
        }).join('');
        const inc = live.filter((x) => x !== n && x.mapLinks.some((l) => l.id === n.id));
        el.relIn.innerHTML = inc.length ? 'Connected from: ' + inc.map((x) => '<button type="button" class="nv-rel-open" data-open="' + esc(x.id) + '">' + esc(mapTitle(x)) + '</button>').join(', ') : '';
    }

    // ── Structure map: Mermaid source from the relations ──
    function tmLabel(text) {   // safe inside a quoted Mermaid label
        let t = String(text).replace(/\s+/g, ' ').trim();
        if (t.length > 60) t = t.slice(0, 57) + '\u2026';
        return t.replace(/#/g, '#35;').replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
    }
    function tmEdgeLabel(text) {   // |"label"| on an arrow, or nothing
        const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/\|/g, '/');
        return t ? '|"' + t.replace(/#/g, '#35;').replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;') + '"|' : '';
    }
    // Builds the Mermaid source from the relations + options.
    function tmBuild(opts) {
        const live = mapLive(), byId = mapById(live);
        const tree = mapTreeOrder(live, byId);
        const related = mapRelatedSet(live, byId);
        const root = opts.root ? byId.get(opts.root) || null : null;
        const maxDepth = +opts.depth || 0;
        const inFolder = (n) => !opts.folder || n.type === opts.folder;

        // 1) candidates: a whole branch, or every note that has a relation (optionally the loose ones too)
        const cand = new Set();
        if (root) (function add(n) { if (cand.has(n)) return; cand.add(n); (tree.kids.get(n) || []).forEach(add); })(root);
        else live.forEach((n) => { if (inFolder(n) && (opts.loose || related.has(n))) cand.add(n); });

        // 2) level = 1 + how many of its ancestors are candidates too; depth cuts at that level
        const levels = new Map();
        cand.forEach((n) => {
            let d = 1, cur = n;
            const seen = new Set([n]);
            for (;;) {
                const p = mapParentOf(cur, byId);
                if (!p || !cand.has(p) || seen.has(p)) break;
                seen.add(p); cur = p; d++;
            }
            levels.set(n, d);
        });
        const shown = [];
        tree.order.forEach((it) => { if (cand.has(it.note) && (!maxDepth || levels.get(it.note) <= maxDepth)) shown.push(it.note); });
        const shownSet = new Set(shown);

        // 3) notes outside the branch that are connected to it (only with a start note)
        const outside = [];
        if (root && opts.ext && opts.conns) {
            const linkedTo = new Set();
            shown.forEach((s) => s.mapLinks.forEach((l) => linkedTo.add(l.id)));
            live.forEach((n) => {
                if (cand.has(n)) return;
                if (linkedTo.has(n.id) || n.mapLinks.some((l) => shownSet.has(byId.get(l.id)))) outside.push(n);
            });
            outside.sort(mapSort);
        }
        const hiddenLoose = (!root && !opts.loose) ? live.filter((n) => inFolder(n) && !related.has(n)).length : 0;
        if (!shown.length) return { code: '', stats: { nodes: 0, outside: 0, tree: 0, links: 0, hiddenLoose, any: related.size > 0 } };

        const all = shown.concat(outside), extSet = new Set(outside);
        const idOf = new Map(all.map((n, i) => [n, 'n' + i]));
        const lines = ['flowchart ' + (opts.dir === 'LR' ? 'LR' : 'TD')];
        all.forEach((n) => {
            const cls = extSet.has(n) ? 'ext' : 'l' + Math.min(levels.get(n) || 1, 4);
            lines.push('    ' + idOf.get(n) + '["' + tmLabel(mapTitle(n)) + '"]:::' + cls);
        });
        let treeEdges = 0, linkEdges = 0;
        all.forEach((n) => {
            const p = mapParentOf(n, byId);
            if (p && idOf.has(p)) { lines.push('    ' + idOf.get(p) + ' --> ' + idOf.get(n)); treeEdges++; }
        });
        if (opts.order) tree.kids.forEach((list, parent) => {
            if (!idOf.has(parent)) return;
            const vis = list.filter((k) => idOf.has(k));
            for (let i = 1; i < vis.length; i++) lines.push('    ' + idOf.get(vis[i - 1]) + ' -.-> ' + idOf.get(vis[i]));
        });
        if (opts.conns) all.forEach((n) => n.mapLinks.forEach((l) => {
            const t = byId.get(l.id);
            if (!t || t === n || !idOf.has(t)) return;
            lines.push('    ' + idOf.get(n) + ' ==>' + tmEdgeLabel(l.label) + ' ' + idOf.get(t));
            linkEdges++;
        }));
        const pal = mmIsDark()
            ? { l1: 'fill:#c97d96,stroke:#e3a5ba,color:#fff,font-weight:bold', l2: 'fill:#5a3b4b,stroke:#c97d96,color:#f6e9ef', l3: 'fill:#3b2833,stroke:#8d6577,color:#f6e9ef', l4: 'fill:#2a1c24,stroke:#6d4c5c,color:#e9d6df', ext: 'fill:none,stroke:#8d6577,color:#b99aa8,stroke-dasharray:4 3' }
            : { l1: 'fill:#c97d96,stroke:#a85f7b,color:#fff,font-weight:bold', l2: 'fill:#f3dbe4,stroke:#c97d96,color:#4a3240', l3: 'fill:#ffffff,stroke:#d9b8c6,color:#4a3240', l4: 'fill:#fbf4f7,stroke:#e6ccd7,color:#4a3240', ext: 'fill:none,stroke:#b99aa8,color:#8d6577,stroke-dasharray:4 3' };
        Object.keys(pal).forEach((k) => lines.push('    classDef ' + k + ' ' + pal[k]));
        all.forEach((n) => lines.push('    %% nv ' + idOf.get(n) + ' ' + n.id));   // which note each box stands for (see mmAttachClicks)
        return { code: lines.join('\n'), stats: { nodes: shown.length, outside: outside.length, tree: treeEdges, links: linkEdges, hiddenLoose, any: related.size > 0 } };
    }

    // ── Link map: an index note's [[wikilinks]] → ordered Mermaid diagram ──
    // The order comes from the index note itself: headings and nested bullets form the tree, links
    // are drawn in the order they are written, and "[[A]] -> [[B]]" on one line is a sequence.
    function lkLabel(text, cap) {
        let t = String(text).replace(/\s+/g, ' ').trim();
        if (t.length > cap) t = t.slice(0, cap - 1) + '…';
        return t.replace(/#/g, '#35;').replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
    }
    function lkIndexCandidates() {
        const out = [];
        S.notes.forEach((n) => {
            if (n.deletedAt) return;
            const c = extractWikilinks(n.markdown || '').length;
            if (c) out.push({ note: n, count: c });
        });
        return out.sort((a, b) => String(a.note.title || '').localeCompare(String(b.note.title || '')));
    }
    function lkBuild(opts) {
        const idx = S.notes.find((n) => n.id === opts.index);
        if (!idx) return null;
        const NODE_CAP = 250;
        const nodes = new Map(), edges = [], seen = new Set();
        let seq = 0, grp = 0, missing = 0;
        const mk = (key, label, cls, note) => {
            if (!nodes.has(key)) nodes.set(key, { id: 'k' + (seq++), label, cls, note, key });
            return nodes.get(key);
        };
        const noteNode = (title) => {
            const n = findNoteByTitle(title);
            if (n) return mk('n:' + n.id, String(n.title || '').trim() || 'Untitled note', 'note', n);
            const k = 'm:' + fold(title);
            if (!nodes.has(k)) missing++;
            return mk(k, title.trim() + ' (no note yet)', 'ph', null);
        };
        const edge = (a, b, kind) => {
            const k = a.id + kind + b.id;
            if (a === b || seen.has(k)) return;
            seen.add(k); edges.push({ a, b, kind });
        };
        const root = mk('n:' + idx.id, String(idx.title || '').trim() || 'Untitled note', 'root', idx);

        // 1) read the index note into items
        const items = [];
        let headDepth = 0, seenH1 = false;
        stripFences(idx.markdown || '').split('\n').forEach((line) => {
            let m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line), depth, text, head = false;
            if (m) {
                depth = m[1].length; text = m[2]; head = true; headDepth = depth;
                if (depth === 1 && !seenH1) { seenH1 = true; if (!/\[\[/.test(text)) return; }   // first "# Title" is the index note itself
            } else {
                m = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
                if (!m) return;
                depth = headDepth + 1 + Math.floor(m[1].replace(/\t/g, '    ').length / 2); text = m[2];
            }
            const links = extractWikilinks(text).map((l) => l.title);
            const plain = text.replace(WIKILINK_RE, (mm, t, a) => (a || t)).replace(/[*_`~]/g, '').trim();
            items.push({ depth, head, links, plain });
        });

        // 2) tree: nearest shallower item is the parent
        const stack = [{ depth: 0, node: root }];
        const kids = new Map(), tail = new Map();
        const addKid = (p, c) => {
            if (!kids.has(p.id)) kids.set(p.id, []);
            const a = kids.get(p.id);
            if (a.indexOf(c) < 0) a.push(c);
            edge(p, c, '-->');
        };
        items.forEach((it, i) => {
            if (nodes.size >= NODE_CAP) return;
            let first, parentKids;
            if (!it.links.length) {
                if (!it.plain) return;
                const deeper = items[i + 1] && items[i + 1].depth > it.depth;
                if (!it.head && !deeper) return;   // a plain bullet with nothing under it is just a note-to-self
                first = mk('g:' + (grp++), it.plain, 'grp', null);
            } else {
                first = noteNode(it.links[0]);
            }
            while (stack.length > 1 && stack[stack.length - 1].depth >= it.depth) stack.pop();
            const parent = stack[stack.length - 1].node;
            addKid(parent, first);
            if (!tail.has(first)) tail.set(first, first);
            let last = first;
            for (let k = 1; k < it.links.length; k++) {
                const nx = noteNode(it.links[k]);
                if (opts.chain) { edge(last, nx, '==>'); last = nx; }
                else addKid(parent, nx);
            }
            if (opts.chain && last !== first && tail.get(first) === first) tail.set(first, last);
            stack.push({ depth: it.depth, node: first });
        });
        if (opts.order) kids.forEach((list) => {
            for (let i = 1; i < list.length; i++) edge(tail.get(list[i - 1]) || list[i - 1], list[i], '-.->');
        });

        // 3) optionally follow the links inside the listed notes
        const hops = +opts.hops || 0;
        let frontier = Array.from(nodes.values()).filter((n) => n.note && n !== root);
        for (let h = 0; h < hops && frontier.length; h++) {
            const next = [];
            frontier.forEach((n) => {
                extractWikilinks(n.note.markdown || '').forEach((l) => {
                    const t = findNoteByTitle(l.title);
                    if (!t || nodes.size >= NODE_CAP && !nodes.has('n:' + t.id)) return;
                    const had = nodes.has('n:' + t.id);
                    const tn = mk('n:' + t.id, String(t.title || '').trim() || 'Untitled note', 'ref', t);
                    edge(n, tn, '-->');
                    if (!had) next.push(tn);
                });
            });
            frontier = next;
        }

        const lines = ['flowchart ' + (opts.dir === 'LR' ? 'LR' : 'TD')];
        nodes.forEach((n) => lines.push('    ' + n.id + '["' + lkLabel(n.label, n.cls === 'grp' ? 80 : 140) + '"]:::' + n.cls));
        edges.forEach((e) => lines.push('    ' + e.a.id + ' ' + e.kind + ' ' + e.b.id));
        const dark = mmIsDark();
        const pal = dark
            ? { root: 'fill:#c97d96,stroke:#e3a5ba,color:#fff,font-weight:bold', grp: 'fill:#5a3b4b,stroke:#c97d96,color:#f6e9ef,font-weight:bold', note: 'fill:#3b2833,stroke:#8d6577,color:#f6e9ef', ref: 'fill:#2a1c24,stroke:#6d4c5c,color:#e9d6df', ph: 'fill:none,stroke:#8d6577,color:#b99aa8,stroke-dasharray:4 3' }
            : { root: 'fill:#c97d96,stroke:#a85f7b,color:#fff,font-weight:bold', grp: 'fill:#f3dbe4,stroke:#c97d96,color:#4a3240,font-weight:bold', note: 'fill:#ffffff,stroke:#d9b8c6,color:#4a3240', ref: 'fill:#fbf4f7,stroke:#e6ccd7,color:#4a3240', ph: 'fill:none,stroke:#b99aa8,color:#8d6577,stroke-dasharray:4 3' };
        Object.keys(pal).forEach((k) => lines.push('    classDef ' + k + ' ' + pal[k]));
        nodes.forEach((n) => { if (n.note) lines.push('    %% nv ' + n.id + ' ' + n.note.id); });   // which note each box opens (see mmAttachClicks)
        const real = Array.from(nodes.values()).filter((n) => n.note).length;
        return { code: lines.join('\n'), stats: { nodes: real, missing, capped: nodes.size >= NODE_CAP, groups: Array.from(nodes.values()).filter((n) => n.cls === 'grp').length } };
    }
    function lkFillIndex() {
        const sel = tmUI.el.index, cands = lkIndexCandidates();
        sel.textContent = '';
        cands.forEach((c) => {
            const o = document.createElement('option');
            o.value = c.note.id;
            o.textContent = (String(c.note.title || '').trim() || 'Untitled note') + ' (' + c.count + ' link' + (c.count === 1 ? '' : 's') + ')';
            sel.appendChild(o);
        });
        const ids = new Set(cands.map((c) => c.note.id));
        if (!ids.has(tmUI.opts.index)) tmUI.opts.index = (S.note && ids.has(S.note.id)) ? S.note.id : (cands[0] ? cands[0].note.id : '');
        sel.value = tmUI.opts.index;
        return cands.length;
    }
    function lkRegenerate() {
        const e = tmUI.el;
        const n = lkFillIndex();
        if (!n) {
            e.src.value = '';
            tmEmpty('link', 'No index notes yet', 'Write an index note such as \u201C- [[Lesson 1]] -> [[Lesson 2]]\u201D and it will show up here.');
            e.stat.textContent = '';
            tmUI.token++;
            return;
        }
        const out = lkBuild(tmUI.opts);
        if (!out) { e.src.value = ''; tmEmpty('pick', 'Pick an index note', 'Choose the note whose [[links]] should be drawn.'); tmUI.token++; return; }
        e.src.value = out.code;
        const bits = [out.stats.nodes + ' note' + (out.stats.nodes === 1 ? '' : 's') + ' shown'];
        if (out.stats.groups) bits.push(out.stats.groups + ' heading' + (out.stats.groups === 1 ? '' : 's'));
        if (out.stats.missing) bits.push(out.stats.missing + ' link' + (out.stats.missing === 1 ? '' : 's') + ' to notes that don’t exist yet (dashed)');
        if (out.stats.capped) bits.push('stopped at 250 boxes');
        e.stat.textContent = bits.join(' · ') + '.';
        tmDraw(true);
    }
    // ── Map panel: empty / loading / error states, segmented controls ──
    function tmShowSide() {
        const b = $('nvmBody');
        if (b && b.classList.contains('nmp-collapsed')) $('nvmSideToggle').click();
    }
    function tmEmpty(kind, title, text, actionLabel, onAction) {
        const e = tmUI.el, box = document.createElement('div');
        box.className = 'nmp-empty' + (kind === 'error' ? ' nmp-empty-err' : '');
        const ic = document.createElement('div'); ic.className = 'nmp-empty-ic';
        const i = document.createElement('i');
        i.className = 'fa-solid ' + ({ none: 'fa-diagram-project', filter: 'fa-filter', link: 'fa-link', pick: 'fa-list-ul', error: 'fa-triangle-exclamation' }[kind] || 'fa-diagram-project');
        ic.appendChild(i);
        const h = document.createElement('h3'); h.textContent = title;
        box.append(ic, h);
        if (text) { const p = document.createElement('p'); p.textContent = text; box.appendChild(p); }
        if (kind === 'error' && arguments[5]) { const c = document.createElement('div'); c.className = 'nmp-empty-code'; c.textContent = arguments[5]; box.appendChild(c); }
        if (actionLabel && onAction) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'nv-btn nv-btn-primary'; b.textContent = actionLabel;
            b.addEventListener('click', onAction);
            box.appendChild(b);
        }
        e.canvas.textContent = '';
        e.canvas.appendChild(box);
    }
    function tmLoading() {
        const box = document.createElement('div');
        box.className = 'nmp-loading'; box.setAttribute('role', 'status');
        const sp = document.createElement('span'); sp.className = 'nmp-spin'; sp.setAttribute('aria-hidden', 'true');
        const t = document.createElement('span'); t.textContent = 'Drawing map\u2026';
        box.append(sp, t);
        tmUI.el.canvas.textContent = '';
        tmUI.el.canvas.appendChild(box);
    }
    function tmSyncLegend() {   // legend swatches use the exact colours the diagram boxes get
        const d = mmIsDark(), st = tmUI.el.panel.style;
        const v = d ? { k1: '#c97d96', k1s: '#e3a5ba', k2: '#5a3b4b', k2s: '#c97d96', k3: '#3b2833', k3s: '#8d6577', kes: '#8d6577' }
                    : { k1: '#c97d96', k1s: '#a85f7b', k2: '#f3dbe4', k2s: '#c97d96', k3: '#ffffff', k3s: '#d9b8c6', kes: '#b99aa8' };
        Object.keys(v).forEach((k) => st.setProperty('--nmp-' + k, v[k]));
    }
    function tmSyncSeg() {   // keep the segmented buttons in step with the (hidden) selects they drive
        if (!tmUI.el) return;
        tmUI.el.panel.querySelectorAll('.nmp-seg').forEach((seg) => {
            const sel = $(seg.getAttribute('data-for'));
            seg.querySelectorAll('button[data-val]').forEach((b) => {
                const on = !!sel && sel.value === b.getAttribute('data-val');
                b.setAttribute('aria-checked', on ? 'true' : 'false');
                b.tabIndex = on ? 0 : -1;
            });
        });
    }
    function tmApplyMode() {
        const link = tmUI.opts.mode === 'link';
        tmUI.el.panel.querySelectorAll('[data-nvm]').forEach((x) => { x.style.display = (x.getAttribute('data-nvm') === 'link') === link ? '' : 'none'; });
        tmSyncSeg(); tmSyncLegend();
        const t = tmUI.el.order.parentElement.querySelector('span');
        if (t) t.textContent = link ? 'Dotted arrows show the order of items under the same heading' : 'Dotted arrows show the order of sub-notes';
    }

    // ── Map panel ──
    function tmLoadOpts() {
        let o = {};
        try { o = JSON.parse(localStorage.getItem(TM_KEY) || '{}') || {}; } catch (e) { o = {}; }
        return {
            mode: o.mode === 'link' ? 'link' : 'structure', index: String(o.index || ''), hops: String(o.hops || '0'), chain: o.chain !== false,
            folder: String(o.folder || ''), root: String(o.root || ''), dir: o.dir === 'LR' ? 'LR' : 'TD', depth: String(o.depth || '0'),
            order: o.order !== false, conns: o.conns !== false, loose: !!o.loose, ext: !!o.ext
        };
    }
    function tmSaveOpts() { try { localStorage.setItem(TM_KEY, JSON.stringify(tmUI.opts)); } catch (e) { /* optional */ } }
    // Folders, with how many notes each holds.
    function tmFillFolders() {
        const sel = tmUI.el.folder, counts = new Map();
        mapLive().forEach((n) => counts.set(n.type || 'General', (counts.get(n.type || 'General') || 0) + 1));
        sel.textContent = '';
        const all = document.createElement('option'); all.value = ''; all.textContent = 'All folders'; sel.appendChild(all);
        Array.from(counts.keys()).sort((a, b) => a.localeCompare(b)).forEach((f) => {
            const o = document.createElement('option'); o.value = f; o.textContent = f + ' (' + counts.get(f) + ')'; sel.appendChild(o);
        });
        if (tmUI.opts.folder && !counts.has(tmUI.opts.folder)) tmUI.opts.folder = '';
        sel.value = tmUI.opts.folder;
    }
    // "Start from": every note that has sub-notes, indented by how deep it sits.
    function tmFillRoots() {
        const sel = tmUI.el.root, live = mapLive(), tree = mapTreeOrder(live, mapById(live));
        sel.textContent = '';
        const first = document.createElement('option'); first.value = ''; first.textContent = 'Everything'; sel.appendChild(first);
        tree.order.forEach((it) => {
            if (!(tree.kids.get(it.note) || []).length) return;
            const o = document.createElement('option');
            const t = mapTitle(it.note);
            o.value = it.note.id;
            o.textContent = '\u00A0\u00A0'.repeat(it.level - 1) + (t.length > 40 ? t.slice(0, 38) + '\u2026' : t);
            sel.appendChild(o);
        });
        if (tmUI.opts.root && !Array.from(sel.options).some((o) => o.value === tmUI.opts.root)) tmUI.opts.root = '';
        sel.value = tmUI.opts.root;
    }
    function tmSyncDisabled() {   // a start note replaces the folder / loose-notes choices; "outside notes" only makes sense with one
        const e = tmUI.el, has = !!e.root.value;
        e.folder.disabled = has; e.loose.disabled = has; e.ext.disabled = !has;
    }
    function tmReadControls() {
        const e = tmUI.el;
        tmUI.opts = { mode: e.mode.value, index: e.index.value || tmUI.opts.index || '', hops: e.hops.value, chain: e.chain.checked, folder: e.folder.value, root: e.root.value, dir: e.dir.value, depth: e.depth.value, order: e.order.checked, conns: e.conns.checked, loose: e.loose.checked, ext: e.ext.checked };
        tmSyncDisabled();
        tmSaveOpts();
    }
    function tmRegenerate() {
        if (tmUI.opts.mode === 'link') { lkRegenerate(); return; }
        const e = tmUI.el, out = tmBuild(tmUI.opts);
        if (!out.stats.nodes) {
            e.src.value = '';
            if (out.stats.any) {
                tmEmpty('filter', 'Nothing to show with these options', 'Try a wider scope: Everything, All folders and All levels.', 'Reset options', () => {
                    e.root.value = ''; e.folder.value = ''; e.depth.value = '0'; e.loose.checked = true;
                    tmReadControls(); tmRegenerate();
                });
            } else {
                tmEmpty('none', 'No relations yet', 'Open a note \u2192 Info tab \u2192 Map relations, or use \u201CSet a relation\u201D here. Your map appears as soon as one exists.', 'Set a relation', () => { tmShowSide(); $('nvmRel').open = true; e.relA.focus(); });
            }
            e.stat.textContent = out.stats.hiddenLoose ? out.stats.hiddenLoose + ' note' + (out.stats.hiddenLoose === 1 ? ' has' : 's have') + ' no relations yet.' : '';
            tmUI.token++;
            return;
        }
        e.src.value = out.code;
        const s = out.stats, bits = [s.nodes + ' note' + (s.nodes === 1 ? '' : 's') + ' shown'];
        if (s.tree) bits.push(s.tree + ' parent \u2192 sub-note arrow' + (s.tree === 1 ? '' : 's'));
        if (s.links) bits.push(s.links + ' connection' + (s.links === 1 ? '' : 's'));
        if (s.outside) bits.push(s.outside + ' outside note' + (s.outside === 1 ? '' : 's') + ' (dashed)');
        if (s.hiddenLoose) bits.push(s.hiddenLoose + ' note' + (s.hiddenLoose === 1 ? '' : 's') + ' without relations hidden');
        e.stat.textContent = bits.join(' \u00B7 ') + '.';
        tmDraw(true);
    }
    async function tmDraw(fit) {
        const e = tmUI.el, code = e.src.value.trim(), token = ++tmUI.token;
        if (!code) { e.canvas.textContent = ''; return; }
        if (fit || !e.canvas.querySelector('svg')) tmLoading();   // typing in the source keeps the old drawing until the new one is ready
        const id = 'nvmm' + (++mmCounter);
        try {
            const mm = await loadMermaid();
            mmInit();
            const out = await mm.render(id, code);
            if (token !== tmUI.token || !tmUI.open) return;
            e.canvas.innerHTML = out.svg;
            const svg = e.canvas.querySelector('svg');
            if (!svg) return;
            const vb = svg.viewBox && svg.viewBox.baseVal;
            tmUI.baseW = (vb && vb.width) || svg.getBoundingClientRect().width || 800;
            svg.removeAttribute('height');
            if (fit) { tmUI.zoom = Math.max(0.35, Math.min(1, (e.stage.clientWidth - 40) / tmUI.baseW)); }
            tmApplyZoom();
            mmAttachClicks(e.canvas, code, true);
        } catch (err) {
            mmCleanup(id);
            if (token !== tmUI.token) return;
            tmEmpty('error', 'Couldn\u2019t draw the diagram', 'Check the Mermaid source \u2014 a small typo is the usual cause.', 'Open the source', () => {
                tmShowSide(); $('nvmAdv').open = true; e.src.focus();
            }, String((err && err.message) || err).split('\n')[0]);
        }
    }
    function tmApplyZoom() {
        const svg = tmUI.el.canvas.querySelector('svg');
        if (!svg) return;
        svg.style.maxWidth = 'none';
        svg.style.width = Math.round(tmUI.baseW * tmUI.zoom) + 'px';
        tmUI.el.zoomPct.textContent = Math.round(tmUI.zoom * 100) + '%';
    }
    function tmZoomBy(f) { tmUI.zoom = Math.min(3, Math.max(0.2, tmUI.zoom * f)); tmApplyZoom(); }
    function tmOpen() {
        if (!tmUI.el) return;
        tmUI.open = true;
        tmUI.opts = tmLoadOpts();
        const e = tmUI.el;
        e.mode.value = tmUI.opts.mode; e.hops.value = tmUI.opts.hops; e.chain.checked = tmUI.opts.chain;
        e.dir.value = tmUI.opts.dir; e.depth.value = tmUI.opts.depth; e.order.checked = tmUI.opts.order;
        e.conns.checked = tmUI.opts.conns; e.loose.checked = tmUI.opts.loose; e.ext.checked = tmUI.opts.ext;
        tmApplyMode();
        tmFillFolders();
        tmFillRoots();
        e.root.value = tmUI.opts.root;
        tmSyncDisabled();
        e.relLabel.hidden = e.relKind.value !== 'link';
        if (!e.relA.value && S.note && S.persisted && String(S.note.title || '').trim()) e.relA.value = String(S.note.title).trim();   // "Set a relation" starts from the note you're in
        e.scrim.hidden = false; e.panel.hidden = false;
        e.panel.tabIndex = -1; try { e.panel.focus({ preventScroll: true }); } catch (err) { /* optional */ }
        $('nvMapBtn').setAttribute('aria-expanded', 'true');
        requestAnimationFrame(tmRegenerate);
    }
    function tmClose() {
        if (!tmUI.open) return;
        tmUI.open = false; tmUI.token++;
        tmUI.el.scrim.hidden = true; tmUI.el.panel.hidden = true;
        $('nvMapBtn').setAttribute('aria-expanded', 'false');
    }
    async function tmSaveAsNote() {
        const code = tmUI.el.src.value.trim();
        if (!code) return;
        const lkIdx = tmUI.opts.mode === 'link' ? S.notes.find((n) => n.id === tmUI.opts.index) : null;
        const rootNote = (!lkIdx && tmUI.opts.root) ? S.notes.find((n) => n.id === tmUI.opts.root) : null;
        let title = lkIdx ? 'Link map \u2014 ' + mapTitle(lkIdx)
            : 'Note map' + (rootNote ? ' \u2014 ' + mapTitle(rootNote) : (tmUI.opts.folder ? ' \u2014 ' + tmUI.opts.folder : ''));
        if (S.notes.some((n) => fold(String(n.title || '').trim()) === fold(title))) title += ' (' + (toLocalDateStr(new Date()) + ' ' + String(new Date().getHours()).padStart(2, '0') + ':' + String(new Date().getMinutes()).padStart(2, '0')) + ')';
        const md = '# ' + title + '\n\n> Generated from ' + (lkIdx ? 'the links in \u201C' + mapTitle(lkIdx) + '\u201D' : 'the parent / sub-note / connection relations set on each note')
            + '. In Read mode, click a box to open that note. Edit the diagram below to adjust it.\n\n```mermaid\n' + code + '\n```\n';
        const id = uid(), now = Date.now();
        try {
            await restoreNotesList([{ id, title, markdown: md, type: (lkIdx ? lkIdx.type : (rootNote ? rootNote.type : tmUI.opts.folder)) || 'General', tags: ['map'], pinned: false, createdAt: now, updatedAt: now }]);
            tmClose();
            await openNote(id);
            toast('Saved \u201C' + title + '\u201D.');
        } catch (err) { console.warn('Notes Vault: could not save map note', err); toast('Couldn\u2019t save the map note.'); }
    }
    function tmDownloadSvg() {
        const svg = tmUI.el.canvas.querySelector('svg');
        if (!svg) { toast('Nothing to download yet.'); return; }
        const clone = svg.cloneNode(true);
        clone.removeAttribute('style');
        clone.setAttribute('width', String(Math.round(tmUI.baseW)));
        if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        const blob = new Blob([clone.outerHTML], { type: 'image/svg+xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = tmUI.opts.mode === 'link' ? 'link-map.svg' : 'note-map.svg';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    function initOutlineMapUI() {
        const panel = $('nvMap');
        if (!panel || !$('nvMapBtn')) return;
        tmUI.el = {
            panel, scrim: $('nvMapScrim'), folder: $('nvmFolder'), root: $('nvmRoot'), dir: $('nvmDir'), depth: $('nvmDepth'), order: $('nvmOrder'),
            conns: $('nvmConns'), loose: $('nvmLoose'), ext: $('nvmExt'),
            mode: $('nvmMode'), index: $('nvmIndex'), hops: $('nvmHops'), chain: $('nvmChain'),
            relA: $('nvmRelA'), relAPop: $('nvmRelAPop'), relKind: $('nvmRelKind'), relB: $('nvmRelB'), relBPop: $('nvmRelBPop'), relLabel: $('nvmRelLabel'), relAdd: $('nvmRelAdd'),
            src: $('nvmSrc'), stat: $('nvmStat'), canvas: $('nvmCanvas'), stage: $('nvmStage'), zoomPct: $('nvmZoomPct'), pan: $('nvmPan')
        };
        const e = tmUI.el;
        $('nvMapBtn').addEventListener('click', tmOpen);
        $('nvMapClose').addEventListener('click', tmClose);
        e.scrim.addEventListener('click', tmClose);
        [e.folder, e.root, e.dir, e.depth, e.order, e.index, e.hops, e.chain, e.conns, e.loose, e.ext].forEach((c) => c.addEventListener('change', () => { tmReadControls(); tmRegenerate(); }));
        e.mode.addEventListener('change', () => { tmReadControls(); tmApplyMode(); tmRegenerate(); });

        // "Set a relation": [note] is a sub-note of / connects to [note]
        attachCombo(e.relA, e.relAPop, { getOptions: () => mapTitles() });
        attachCombo(e.relB, e.relBPop, { getOptions: () => mapTitles() });
        e.relKind.addEventListener('change', () => { e.relLabel.hidden = e.relKind.value !== 'link'; });
        const relApply = async () => {
            const a = mapNoteByTitle(e.relA.value), b = mapNoteByTitle(e.relB.value);
            if (!a || !b) { toast(!a ? 'Pick the first note from the list.' : 'Pick the second note from the list.'); return; }
            if (a === b) { toast('Pick two different notes.'); return; }
            const asChild = e.relKind.value === 'child';
            const ok = asChild ? await mapSetParent(a, b) : await mapAddLink(a, b, e.relLabel.value);
            if (!ok) return;
            e.relA.value = ''; e.relLabel.value = '';   // keep the second note: the next sub-note usually goes under the same parent
            mapChanged();
            toast(asChild ? '\u201C' + mapTitle(a) + '\u201D is now a sub-note of \u201C' + mapTitle(b) + '\u201D.' : 'Connected \u201C' + mapTitle(a) + '\u201D \u2192 \u201C' + mapTitle(b) + '\u201D.');
        };
        e.relAdd.addEventListener('click', relApply);
        [e.relA, e.relB, e.relLabel].forEach((inp) => inp.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Enter') return;
            ev.preventDefault();
            // Enter on the first box just moves on, so a half-typed title can't be applied by accident.
            if (inp === e.relA) e.relB.focus(); else relApply();
        }));

        let tSrc = null;
        e.src.addEventListener('input', () => { clearTimeout(tSrc); tSrc = setTimeout(() => tmDraw(false), 450); });
        $('nvmSave').addEventListener('click', tmSaveAsNote);
        $('nvmSvg').addEventListener('click', tmDownloadSvg);
        $('nvmCopy').addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(e.src.value); toast('Mermaid source copied.'); }
            catch (err) { e.src.select(); toast('Press Ctrl+C to copy the selected source.'); }
        });
        $('nvmZoomIn').addEventListener('click', () => tmZoomBy(1.2));
        $('nvmZoomOut').addEventListener('click', () => tmZoomBy(1 / 1.2));
        $('nvmFit').addEventListener('click', () => {
            if (!tmUI.baseW) return;
            tmUI.zoom = Math.max(0.2, Math.min(3, (e.stage.clientWidth - 40) / tmUI.baseW));
            tmApplyZoom();
        });
        // ── polish: segmented controls, collapsible options, drag-to-pan, wheel zoom, keyboard ──
        [e.mode, e.dir].forEach((c) => c.addEventListener('change', tmSyncSeg));
        panel.querySelectorAll('.nmp-seg').forEach((seg) => {
            const sel = $(seg.getAttribute('data-for'));
            const pick = (b) => { if (!b || sel.value === b.getAttribute('data-val')) return; sel.value = b.getAttribute('data-val'); sel.dispatchEvent(new Event('change', { bubbles: true })); };
            seg.addEventListener('click', (ev) => pick(ev.target.closest('button[data-val]')));
            seg.addEventListener('keydown', (ev) => {
                const keys = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
                if (!keys[ev.key]) return;
                const bs = Array.from(seg.querySelectorAll('button[data-val]')), i = bs.findIndex((b) => b.getAttribute('aria-checked') === 'true');
                const nb = bs[(Math.max(i, 0) + keys[ev.key] + bs.length) % bs.length];
                ev.preventDefault(); pick(nb); nb.focus();
            });
        });
        const body = $('nvmBody'), tgl = $('nvmSideToggle');
        tgl.addEventListener('click', () => {
            const collapse = !body.classList.contains('nmp-collapsed');
            body.classList.toggle('nmp-collapsed', collapse);
            tgl.setAttribute('aria-expanded', String(!collapse));
        });
        $('nvmZoomPct').addEventListener('click', () => { tmUI.zoom = 1; tmApplyZoom(); });
        const pan = e.pan;
        let drag = null;
        pan.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0 || ev.pointerType === 'touch' || ev.target.closest('.node, a, button, input, textarea, select')) return;
            drag = { x: ev.clientX, y: ev.clientY, l: pan.scrollLeft, t: pan.scrollTop, id: ev.pointerId, on: false };
        });
        pan.addEventListener('pointermove', (ev) => {
            if (!drag || ev.pointerId !== drag.id) return;
            const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
            if (!drag.on) {
                if (Math.abs(dx) + Math.abs(dy) < 4) return;
                drag.on = true; pan.classList.add('nmp-panning');
                try { pan.setPointerCapture(ev.pointerId); } catch (err) { /* optional */ }
            }
            pan.scrollLeft = drag.l - dx; pan.scrollTop = drag.t - dy;
        });
        const endDrag = () => { drag = null; pan.classList.remove('nmp-panning'); };
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => pan.addEventListener(t, endDrag));
        pan.addEventListener('wheel', (ev) => {
            if (!(ev.ctrlKey || ev.metaKey)) return;
            ev.preventDefault();
            tmZoomBy(ev.deltaY < 0 ? 1.1 : 1 / 1.1);
        }, { passive: false });
        panel.addEventListener('keydown', (ev) => {
            if (ev.ctrlKey || ev.metaKey || ev.altKey || !tmUI.open) return;
            if (ev.target.closest && ev.target.closest('input, textarea, select, [contenteditable="true"]')) return;
            if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); tmZoomBy(1.2); }
            else if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); tmZoomBy(1 / 1.2); }
            else if (ev.key === '0') { ev.preventDefault(); $('nvmFit').click(); }
        });
        // Esc closes just the map, not the whole vault behind it.
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && tmUI.open) { ev.preventDefault(); ev.stopImmediatePropagation(); tmClose(); }
        }, true);
    }

    /* ═════════════ Up / Previous / Next / Sub-notes (from the relations you set) ═════════════
       A note that sits under a parent gets a small footer in Read mode: the previous and next sibling
       (in the order set under the parent's "Sub-notes"), plus "Up" to the parent. A note that has
       sub-notes lists them there too. Nothing is worked out from titles or numbers.
       Turning a page replaces the current tab instead of piling up a new one. */
    var seqNavEl = null;
    function seqNeighbors(note) {
        const live = mapLive(), byId = mapById(live);
        const up = mapParentOf(mapRel(note), byId);
        let prev = null, next = null;
        if (up) {
            const sibs = mapKids(up, live), i = sibs.indexOf(note);
            if (i >= 0) { prev = sibs[i - 1] || null; next = sibs[i + 1] || null; }
        }
        return { prev, next, up, kids: mapKids(note, live) };
    }
    async function seqGo(id) {
        const oldId = S.note && S.note.id;
        rpSkipOnce = true;   // start at the top, not at the spot you left that note
        try { await openNote(id); } finally { rpSkipOnce = false; }
        if (oldId && oldId !== id && S.note && S.note.id === id) { S.tabs = S.tabs.filter((x) => x !== oldId); renderTabStrip(); }
        el.docScroll.scrollTop = 0;
    }
    function seqUpdateNav() {
        if (!seqNavEl) {
            seqNavEl = document.createElement('nav');
            seqNavEl.className = 'nv-seqnav';
            seqNavEl.setAttribute('aria-label', 'Parent, sub-notes, previous and next note');
            el.read.insertAdjacentElement('afterend', seqNavEl);
        }
        const n = S.note;
        const nb = (n && S.mode === 'read' && !S.viewRev) ? seqNeighbors(n) : null;
        seqNavEl.textContent = '';
        if (!nb || (!nb.prev && !nb.next && !nb.up && !nb.kids.length)) { seqNavEl.hidden = true; return; }
        seqNavEl.hidden = false;
        if (nb.kids.length) {
            const box = document.createElement('div');
            box.className = 'nv-seqkids';
            const k = document.createElement('span');
            k.className = 'nv-seqkids-k'; k.textContent = 'Sub-notes';
            box.appendChild(k);
            nb.kids.forEach((c) => {
                const b = document.createElement('button');
                b.type = 'button'; b.className = 'nv-seqkid';
                b.textContent = mapTitle(c); b.title = mapTitle(c);
                b.addEventListener('click', () => openNote(c.id));   // going down keeps this note's tab open
                box.appendChild(b);
            });
            seqNavEl.appendChild(box);
        }
        if (!nb.prev && !nb.next && !nb.up) return;
        const slot = (kind, kicker, rec) => {
            if (!rec) { const gap = document.createElement('span'); seqNavEl.appendChild(gap); return; }
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'nv-seqbtn nv-seq-' + kind;
            const full = mapTitle(rec);
            b.title = full;
            const kk = document.createElement('span'); kk.className = 'nv-seq-k'; kk.textContent = kicker;
            const t = document.createElement('span'); t.className = 'nv-seq-t'; t.textContent = full;
            b.append(kk, t);
            b.addEventListener('click', () => seqGo(rec.id));
            seqNavEl.appendChild(b);
        };
        slot('prev', '\u2190 Previous', nb.prev);
        slot('up', '\u2191 Up', nb.up);
        slot('next', 'Next \u2192', nb.next);
    }

    /* ═════════════ Split view · position keeping · in-place table editing ═════════════
       Split = the Edit textarea and a live Read preview side by side (S.mode stays 'edit', S.split is true).
       Switching Read ↔ Edit ↔ Split keeps you at the same place in the text: the position is kept as a
       character offset, and headings are used as anchors to translate it to/from the rendered page.
       Tables in Read/Split get a pencil: click it and the cells show their raw markdown, editable
       in place; every change is written straight back into the note's text. */
    var EDITSTYLE_KEY = 'nvEditStyle';
    var spDomId = null, spIgnoreRead = 0, spIgnoreSrc = 0, spCache = null, spTimer = null, tblSess = null;
    function preferredEditStyle() { try { const v = localStorage.getItem(EDITSTYLE_KEY); return v === 'split' || v === 'edit' ? v : 'live'; } catch (e) { return 'live'; } }
    function saveEditStyle(v) { try { localStorage.setItem(EDITSTYLE_KEY, v); } catch (e) { /* optional */ } }
    function toggleEditRead() {
        if (!S.note) return;
        // One button, two states, same look: Read (view / copy only) <-> Live editing (click a spot and just that
        // element shows its Markdown, e.g. **bold**; everything else stays rendered). Split and Source have their own
        // buttons and no longer hijack this one.
        if (S.mode === 'edit') setMode('read'); else { saveEditStyle('live'); setMode('live', true); }
    }
    function spReadTopAbs() { return el.read.getBoundingClientRect().top - el.docScroll.getBoundingClientRect().top + el.docScroll.scrollTop; }
    function spReadY() { return S.split ? el.read.scrollTop : Math.max(0, el.docScroll.scrollTop - spReadTopAbs()); }
    // Pairs "character offset in the markdown" with "y in the rendered page" at every heading.
    function spAnchors(useCache) {
        const md = S.note ? (S.note.markdown || '') : '';
        const total = S.split ? el.read.scrollHeight : el.read.offsetHeight;
        if (!total || el.read.hidden) return null;
        const key = md.length + '|' + total + '|' + el.read.clientWidth + '|' + (S.split ? 1 : 0);
        if (useCache && spCache && spCache.key === key) return spCache;
        const fm = Math.max(0, md.length - extractFrontmatter(md).body.length);
        const clean = stripFences(md);
        const offs = [fm], re = /^ {0,3}#{1,6}[ \t]+\S/gm;
        let m;
        while ((m = re.exec(clean))) if (m.index >= fm) offs.push(m.index);
        offs.push(md.length);
        const heads = Array.from(el.read.querySelectorAll('h1,h2,h3,h4,h5,h6'));
        const top = el.read.getBoundingClientRect().top, sc = S.split ? el.read.scrollTop : 0;
        let ys = [0].concat(heads.map((h) => h.getBoundingClientRect().top - top + sc), [total]);
        let o2 = offs;
        if (heads.length !== offs.length - 2) { o2 = [fm, md.length]; ys = [0, total]; }   // headings don't line up: plain proportion
        spCache = { key, offs: o2, ys };
        return spCache;
    }
    function spSeg(arr, v) { let i = 0; while (i < arr.length - 2 && arr[i + 1] <= v) i++; return i; }
    function spPosToY(A, pos) { const i = spSeg(A.offs, pos); const d = Math.max(1, A.offs[i + 1] - A.offs[i]); return A.ys[i] + Math.min(1, Math.max(0, (pos - A.offs[i]) / d)) * (A.ys[i + 1] - A.ys[i]); }
    function spYToPos(A, y) { const i = spSeg(A.ys, y); const d = Math.max(1, A.ys[i + 1] - A.ys[i]); return A.offs[i] + Math.min(1, Math.max(0, (y - A.ys[i]) / d)) * (A.offs[i + 1] - A.offs[i]); }
    function spSrcPos() { const ta = el.src, r = ta.scrollHeight - ta.clientHeight, len = (S.note.markdown || '').length; return r > 0 ? ta.scrollTop / r * len : 0; }
    function spCapture() {
        if (!S.note || spDomId !== S.note.id) return null;
        const len = (S.note.markdown || '').length;
        if (!len) return 0;
        try {
            if (S.mode === 'edit') return S.live && lv ? lv.topPos() : Math.round(spSrcPos());
            const A = spAnchors(false);
            return A ? Math.round(spYToPos(A, spReadY())) : null;
        } catch (e) { return null; }
    }
    function spRestore(pos, edit) {
        if (S.note) spDomId = S.note.id;
        const ds = el.docScroll;
        ds.style.scrollBehavior = 'auto';
        const done = () => { ds.style.scrollBehavior = ''; };
        if (pos == null) { ds.scrollTop = 0; if (edit) { el.src.scrollTop = 0; if (S.live && lv) lv.view.scrollDOM.scrollTop = 0; } if (S.split) el.read.scrollTop = 0; done(); return; }
        const md = S.note.markdown || '', len = md.length, p = Math.min(pos, len);
        try {
            if (edit && S.live && lv) {
                ds.scrollTop = 0;
                if (p > 0) lv.scrollTo(p);
                lv.view.scrollDOM.scrollTop = p > 0 ? lv.view.scrollDOM.scrollTop : 0;
            } else if (edit) {
                const ta = el.src;
                if (document.activeElement === ta) { const ls = p > 0 ? md.lastIndexOf('\n', p - 1) + 1 : 0; ta.setSelectionRange(ls, ls); }
                const r = ta.scrollHeight - ta.clientHeight;
                ta.scrollTop = len ? r * p / len : 0;
                ds.scrollTop = 0;
                if (S.split) { const A = spAnchors(false); if (A) { spIgnoreRead = performance.now() + 150; el.read.scrollTop = spPosToY(A, p); } }
            } else {
                const A = spAnchors(false);
                ds.scrollTop = A ? spReadTopAbs() + spPosToY(A, p) : 0;
            }
        } catch (e) { ds.scrollTop = 0; }
        done();
    }
    function spRender() {
        if (!S.split || !S.note || tblSess) return;
        const y = el.read.scrollTop;
        renderInto(el.read, S.note.markdown);
        el.read.scrollTop = y;
        spCache = null;
        spFollowCaret();
    }
    // Keep the preview showing the place being typed in.
    function spFollowCaret() {
        if (!S.split || document.activeElement !== el.src) return;
        const A = spAnchors(false);
        if (!A) return;
        const y = spPosToY(A, el.src.selectionStart || 0), r = el.read;
        if (y < r.scrollTop + 16 || y > r.scrollTop + r.clientHeight - 60) { spIgnoreRead = performance.now() + 150; r.scrollTop = Math.max(0, y - r.clientHeight * 0.3); }
    }

    // ── tables ──
    function tblSplitRow(line) {
        let t = line.trim();
        if (t[0] === '|') t = t.slice(1);
        if (t.length && t[t.length - 1] === '|' && t[t.length - 2] !== '\\') t = t.slice(0, -1);
        const cells = []; let cur = '';
        for (let i = 0; i < t.length; i++) {
            const c = t[i];
            if (c === '\\' && i + 1 < t.length) { cur += c + t[++i]; continue; }
            if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
            cur += c;
        }
        cells.push(cur.trim());
        return cells;
    }
    function tblParseSource(md) {
        const lines = md.split('\n'), starts = [], out = [];
        let off = 0, inFence = false;
        lines.forEach((l) => { starts.push(off); off += l.length + 1; });
        const DELIM = /^\s{0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
        for (let i = 0; i < lines.length; i++) {
            const ln = lines[i];
            if (/^\s*(`{3,}|~{3,})/.test(ln)) { inFence = !inFence; continue; }
            if (inFence || /^\s{4,}/.test(ln) || ln.indexOf('|') < 0 || i + 1 >= lines.length) continue;
            const dl = lines[i + 1];
            if (dl.indexOf('|') < 0 || !DELIM.test(dl)) continue;
            const head = tblSplitRow(ln), align = tblSplitRow(dl);
            if (head.length !== align.length) continue;
            let j = i + 2;
            while (j < lines.length && lines[j].trim() && lines[j].indexOf('|') >= 0) j++;
            const body = [];
            for (let k = i + 2; k < j; k++) { const r = tblSplitRow(lines[k]); while (r.length < head.length) r.push(''); body.push(r.slice(0, head.length)); }
            out.push({ start: starts[i], end: starts[j - 1] + lines[j - 1].length, head, align, body });
            i = j - 1;
        }
        return out;
    }
    function tblSerialize(t) {
        const esc = (x) => String(x).replace(/\\?\|/g, '\\|');
        const row = (r) => '| ' + r.map(esc).join(' | ') + ' |';
        return [row(t.head), row(t.align.map((a) => (/^:?-+:?$/.test(a) ? a : '---'))), ...t.body.map(row)].join('\n');
    }
    function tblStart(wrap) {
        if (!S.note || S.viewRev || !wrap) return;
        const wraps = Array.from(el.read.querySelectorAll('.nv-tablewrap')), idx = wraps.indexOf(wrap);
        const tabs = tblParseSource(S.note.markdown || '');
        const t = tabs[idx];
        const firstRow = wrap.querySelector('tr');
        if (idx < 0 || tabs.length !== wraps.length || !t || !firstRow || firstRow.children.length !== t.head.length) {
            flash('This table can’t be edited in place — use Edit or Split for it');
            return;
        }
        tblSess = { wrap, start: t.start, end: t.end, model: t, cur: { r: -1, c: 0 } };
        tblBuild();
        const first = wrap.querySelector('th,td'); if (first) first.focus();
    }
    function tblReadDom() {
        const S2 = tblSess; if (!S2) return;
        const val = (c) => (c.innerText || '').replace(/\r?\n/g, ' ').trim();
        const rows = Array.from(S2.wrap.querySelectorAll('tr'));
        S2.model.head = Array.from(rows[0].children).map(val);
        S2.model.body = rows.slice(1).map((r) => Array.from(r.children).map(val));
    }
    function tblWrite() {
        const S2 = tblSess; if (!S2) return;
        const md = S.note.markdown || '', nt = tblSerialize(S2.model);
        const nm = md.slice(0, S2.start) + nt + md.slice(S2.end);
        S2.end = S2.start + nt.length;
        S.note.markdown = nm;
        if (el.src) el.src.value = nm;
        markDirty();
    }
    function tblBuild(focusAt) {
        const S2 = tblSess, m = S2.model, w = S2.wrap;
        w.textContent = '';
        w.classList.add('nv-tbl-editing');
        const bar = document.createElement('div'); bar.className = 'nv-tbl-bar';
        [['+ Row', 'addrow'], ['+ Column', 'addcol'], ['− Row', 'delrow'], ['− Column', 'delcol'], ['Done', 'done']].forEach(([label, act]) => {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'nv-tbl-btn' + (act === 'done' ? ' nv-tbl-done' : ''); b.textContent = label; b.setAttribute('data-act', act);
            b.addEventListener('mousedown', (e) => e.preventDefault());   // keep the cell focused
            bar.appendChild(b);
        });
        const table = document.createElement('table'), thead = document.createElement('thead'), tbody = document.createElement('tbody');
        let mode = 'plaintext-only';
        try { const probe = document.createElement('div'); probe.contentEditable = 'plaintext-only'; if (probe.contentEditable !== 'plaintext-only') mode = 'true'; } catch (e) { mode = 'true'; }
        const mk = (tag, text, r, c) => {
            const cell = document.createElement(tag);
            cell.contentEditable = mode; cell.spellcheck = false; cell.textContent = text;
            cell.setAttribute('data-r', r); cell.setAttribute('data-c', c);
            return cell;
        };
        const hr = document.createElement('tr'); m.head.forEach((x, c) => hr.appendChild(mk('th', x, -1, c))); thead.appendChild(hr);
        m.body.forEach((row, r) => { const tr = document.createElement('tr'); row.forEach((x, c) => tr.appendChild(mk('td', x, r, c))); tbody.appendChild(tr); });
        table.append(thead, tbody);
        w.append(bar, table);
        if (focusAt) { const f = w.querySelector('[data-r="' + focusAt.r + '"][data-c="' + focusAt.c + '"]'); if (f) f.focus(); }
    }
    function tblAction(act) {
        const S2 = tblSess; if (!S2) return;
        tblReadDom();
        const m = S2.model, cur = S2.cur, cols = m.head.length;
        let focusAt = { r: cur.r, c: cur.c };
        if (act === 'addrow') { m.body.splice(cur.r + 1, 0, new Array(cols).fill('')); focusAt = { r: cur.r + 1, c: cur.c }; }
        else if (act === 'delrow') { if (cur.r >= 0) { m.body.splice(cur.r, 1); focusAt = { r: Math.min(cur.r, m.body.length - 1), c: cur.c }; } else { flash('Click a body row first'); return; } }
        else if (act === 'addcol') { m.head.splice(cur.c + 1, 0, 'Column'); m.align.splice(cur.c + 1, 0, '---'); m.body.forEach((r) => r.splice(cur.c + 1, 0, '')); focusAt = { r: cur.r, c: cur.c + 1 }; }
        else if (act === 'delcol') { if (cols <= 1) { flash('A table needs at least one column'); return; } m.head.splice(cur.c, 1); m.align.splice(cur.c, 1); m.body.forEach((r) => r.splice(cur.c, 1)); focusAt = { r: cur.r, c: Math.min(cur.c, m.head.length - 1) }; }
        if (focusAt.r >= m.body.length) focusAt.r = m.body.length - 1;
        tblWrite();
        tblBuild(focusAt);
        S2.cur = focusAt;
    }
    function tblStop() {
        if (!tblSess) return;
        tblReadDom(); tblWrite();
        const y = S.split ? el.read.scrollTop : el.docScroll.scrollTop;
        tblSess = null;
        renderInto(el.read, S.note.markdown);
        if (S.split) el.read.scrollTop = y; else el.docScroll.scrollTop = y;
        spCache = null;
        renderOutline(); renderMentions();
    }
    function tblKey(e) {
        const cell = e.target.closest && e.target.closest('th,td');
        if (!cell || !tblSess) return;
        if (!(e.ctrlKey || e.metaKey)) e.stopPropagation();   // typing "/" or "?" in a cell must not trigger vault shortcuts
        if (e.key !== 'Tab' && e.key !== 'Enter') return;
        e.preventDefault();
        if (e.key === 'Enter' && e.shiftKey) { document.execCommand('insertText', false, '<br>'); return; }
        const r = +cell.getAttribute('data-r'), c = +cell.getAttribute('data-c'), m = tblSess.model;
        let nr = r, nc = c;
        if (e.key === 'Enter') nr = r + 1;
        else if (e.shiftKey) { nc = c - 1; if (nc < 0) { nc = m.head.length - 1; nr = r - 1; } }
        else { nc = c + 1; if (nc >= m.head.length) { nc = 0; nr = r + 1; } }
        if (nr < -1) return;
        tblReadDom();
        if (nr >= m.body.length) { m.body.push(new Array(m.head.length).fill('')); tblWrite(); tblBuild({ r: nr, c: nc }); tblSess.cur = { r: nr, c: nc }; return; }
        tblWrite();
        const nx = tblSess.wrap.querySelector('[data-r="' + nr + '"][data-c="' + nc + '"]');
        if (nx) nx.focus();
    }


    /* ═════════════ Text tools (menu in the editing toolbar) ═════════════
       Work on the selection, or on the whole note when nothing is selected. Line tools use the
       whole lines the selection touches. Every result goes through replaceRange(), so Ctrl+Z undoes it. */
    var TT = {
        plain(t) {
            return t.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n?/gm, '')
                .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, '')
                .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '')
                .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
                .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2').replace(/\[\[([^\]\n]+)\]\]/g, '$1')
                .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
                .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '').replace(/^[ \t]*>[ \t]?/gm, '')
                .replace(/^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '$1')
                .replace(/\*\*(.+?)\*\*/g, '$1').replace(/(?<![A-Za-z0-9_])__(.+?)__(?![A-Za-z0-9_])/g, '$1').replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1').replace(/(?<![A-Za-z0-9_])_(?=\S)(.+?)(?<=\S)_(?![A-Za-z0-9_])/g, '$1').replace(/~~(.+?)~~/g, '$1').replace(/`([^`\n]+)`/g, '$1')
                .replace(/^[ \t]*\|[ \t]?|[ \t]?\|[ \t]*$/gm, '').replace(/[ \t]*\|[ \t]*/g, '\t')
                .replace(/\n{3,}/g, '\n\n');
        },
        fullhalf(t) {
            const hasFull = /[！-～　]/.test(t);
            return hasFull
                ? t.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ')
                : t.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)).replace(/ /g, '　');
        },
        insertblank(t) { const L = t.split('\n'), o = []; L.forEach((l, i) => { o.push(l); if (l.trim() && L[i + 1] !== undefined && L[i + 1].trim()) o.push(''); }); return o.join('\n'); },
        removeblank(t) { return t.split('\n').filter((l) => l.trim()).join('\n'); },
        split(t, v) {
            const d = (v.sep || ',').replace(/\\t/g, '\t').replace(/\\n/g, '\n');
            return t.split('\n').map((l) => l.split(d).map((x) => (v.trim ? x.trim() : x)).filter((x) => x !== '').join('\n')).join('\n');
        },
        merge(t, v) { return t.split('\n').filter((l) => l.trim()).map((l) => l.trim()).join((v.sep === undefined ? ' ' : v.sep).replace(/\\t/g, '\t')); },
        dedupe(t) { const seen = new Set(); return t.split('\n').filter((l) => { if (!l.trim()) return true; const k = l.trim(); if (seen.has(k)) return false; seen.add(k); return true; }).join('\n'); },
        affix(t, v) { return t.split('\n').map((l) => (l.trim() ? (v.pre || '') + l + (v.suf || '') : l)).join('\n'); },
        number(t, v) {
            let n = parseInt(v.start, 10); if (isNaN(n)) n = 1;
            const fmt = v.fmt === undefined || v.fmt === '' ? '{n}. ' : v.fmt, pad = Math.max(0, parseInt(v.pad, 10) || 0);
            return t.split('\n').map((l) => (l.trim() ? fmt.replace(/\{n\}/g, String(n++).padStart(pad, '0')) + l : l)).join('\n');
        },
        trim(t) { return t.split('\n').map((l) => l.trim()).join('\n'); },
        shrink(t) { return t.replace(/(\S)[ \t　]{2,}/g, '$1 ').replace(/[ \t]+$/gm, ''); },
        nowhite(t) { return t.replace(/\s+/g, ''); },
        list2table(t, v) {
            const lines = t.split('\n').map((l) => l.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/, '')).filter((l) => l.trim());
            if (!lines.length) return t;
            let d = (v.sep || '').replace(/\\t/g, '\t');
            if (!d) d = lines.some((l) => l.indexOf('\t') >= 0) ? '\t' : lines.some((l) => l.indexOf('|') >= 0) ? '|' : ',';
            const rows = lines.map((l) => l.split(d).map((x) => x.trim().replace(/\|/g, '\\|')));
            const cols = Math.max(...rows.map((r) => r.length));
            rows.forEach((r) => { while (r.length < cols) r.push(''); });
            const row = (r) => '| ' + r.join(' | ') + ' |';
            return [row(rows[0]), row(new Array(cols).fill('---')), ...rows.slice(1).map(row)].join('\n');
        },
        table2list(t, v) {
            const sep = v.sep === undefined ? ', ' : v.sep;
            const rows = t.split('\n').filter((l) => l.indexOf('|') >= 0 && !/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l));
            const out = rows.map((l) => tblSplitRow(l).join(sep));
            return (v.header ? out : out.slice(1)).map((x) => '- ' + x).join('\n');
        },
        between(t, v) {
            if (!v.a || !v.b) return t;
            const out = []; let i = 0;
            while (true) {
                const a = t.indexOf(v.a, i); if (a < 0) break;
                const b = t.indexOf(v.b, a + v.a.length); if (b < 0) break;
                out.push(t.slice(a + v.a.length, b)); i = b + v.b.length;
            }
            return out.length ? out.join('\n') : null;
        }
    };
    var TT_ITEMS = [
        ['Get Plain Text', 'file-lines', 'plain'], ['Full Half Converter', 'arrows-left-right', 'fullhalf'],
        ['Line operations'],
        ['Insert Blank Lines', 'grip-lines', 'insertblank', true], ['Remove Blank Lines', 'compress', 'removeblank', true],
        ['Split Lines…', 'code-fork', 'split', true, [{ id: 'sep', label: 'Split at', value: ',', hint: 'Use \\t for a tab.' }, { id: 'trim', label: 'Trim each piece', type: 'check', value: true }]],
        ['Merge Lines…', 'code-merge', 'merge', true, [{ id: 'sep', label: 'Join with', value: ' ' }]],
        ['Dedupe Lines', 'filter', 'dedupe', true],
        ['Text processing'],
        ['Add Prefix/Suffix…', 'quote-right', 'affix', true, [{ id: 'pre', label: 'Prefix', value: '' }, { id: 'suf', label: 'Suffix', value: '' }]],
        ['Number Lines (Custom)…', 'list-ol', 'number', true, [{ id: 'start', label: 'Start at', value: '1', type: 'number' }, { id: 'fmt', label: 'Format', value: '{n}. ', hint: '{n} is the number, e.g. "({n}) " or "Step {n}: ".' }, { id: 'pad', label: 'Pad with zeros to width (0 = none)', value: '0', type: 'number' }]],
        ['Trim Line Ends', 'scissors', 'trim', true], ['Shrink Extra Spaces', 'minimize', 'shrink'], ['Remove All Whitespace', 'eraser', 'nowhite'],
        ['Advanced tools'],
        ['List to Table…', 'table', 'list2table', true, [{ id: 'sep', label: 'Column separator (empty = auto: tab, | or comma)', value: '' }]],
        ['Table to List…', 'list', 'table2list', true, [{ id: 'sep', label: 'Join cells with', value: ', ' }, { id: 'header', label: 'Include the header row', type: 'check', value: false }]],
        ['Extract Between Strings…', 'code', 'between', false, [{ id: 'a', label: 'Start string', value: '' }, { id: 'b', label: 'End string', value: '' }]]
    ];
    var ttMenu = null, ttDlg = null, ttRange = null;
    function ttClose() {
        if (ttMenu) { ttMenu.remove(); ttMenu = null; document.removeEventListener('mousedown', ttOutside, true); }
    }
    function ttOutside(e) { if (ttMenu && !ttMenu.contains(e.target) && !(e.target.closest && e.target.closest('[data-cmd="textools"]'))) ttClose(); }
    function ttToggle() {
        if (ttMenu) { ttClose(); return; }
        const ta = el.src, btn = el.tools.querySelector('[data-cmd="textools"]');
        ttRange = { s: ta.selectionStart, e: ta.selectionEnd };
        const m = document.createElement('div'); m.className = 'nv-tt-menu'; m.setAttribute('role', 'menu');
        const scope = document.createElement('div'); scope.className = 'nv-tt-scope';
        scope.textContent = ttRange.s === ttRange.e ? 'Applies to the whole note (nothing selected)' : 'Applies to the selection';
        m.appendChild(scope);
        TT_ITEMS.forEach((it) => {
            if (it.length === 1) { const h = document.createElement('div'); h.className = 'nv-tt-h'; h.textContent = it[0]; m.appendChild(h); return; }
            const b = document.createElement('button'); b.type = 'button'; b.className = 'nv-tt-i'; b.setAttribute('role', 'menuitem');
            b.innerHTML = '<i class="fa-solid fa-' + it[1] + '" aria-hidden="true"></i><span></span>';
            b.lastChild.textContent = it[0];
            b.addEventListener('mousedown', (e) => e.preventDefault());
            b.addEventListener('click', () => { ttClose(); if (it[4]) ttDialog(it); else ttRun(it, {}); });
            m.appendChild(b);
        });
        el.overlay.appendChild(m);
        const r = btn.getBoundingClientRect();
        m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 280)) + 'px';
        m.style.top = Math.min(r.bottom + 6, window.innerHeight - 120) + 'px';
        m.style.maxHeight = Math.max(200, window.innerHeight - r.bottom - 20) + 'px';
        ttMenu = m;
        setTimeout(() => document.addEventListener('mousedown', ttOutside, true), 0);
    }
    function ttDialog(it) {
        if (ttDlg) ttDlg.remove();
        const d = document.createElement('div'); d.className = 'nv-tt-dlg'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
        const h = document.createElement('h3'); h.textContent = it[0].replace('…', ''); d.appendChild(h);
        const inputs = {};
        it[4].forEach((f) => {
            const l = document.createElement('label'); const t = document.createElement('span'); t.textContent = f.label;
            const i = document.createElement('input');
            if (f.type === 'check') { l.className = 'nv-tt-chk'; i.type = 'checkbox'; i.checked = !!f.value; l.append(i, t); }
            else { i.type = f.type === 'number' ? 'number' : 'text'; i.value = f.value; i.spellcheck = false; l.append(t, i); }
            d.appendChild(l);
            if (f.hint) { const p = document.createElement('p'); p.className = 'nv-tt-hint'; p.textContent = f.hint; d.appendChild(p); }
            inputs[f.id] = i;
        });
        const acts = document.createElement('div'); acts.className = 'nv-tt-acts';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'nv-btn'; cancel.textContent = 'Cancel';
        const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'nv-btn nv-btn-primary'; ok.textContent = 'Apply';
        acts.append(cancel, ok); d.appendChild(acts);
        const close = () => { d.remove(); if (ttDlg === d) ttDlg = null; el.src.focus(); };
        const go = () => {
            const v = {}; Object.keys(inputs).forEach((k) => { v[k] = inputs[k].type === 'checkbox' ? inputs[k].checked : inputs[k].value; });
            close(); ttRun(it, v);
        };
        cancel.addEventListener('click', close); ok.addEventListener('click', go);
        d.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); go(); } else if (e.key === 'Escape') { e.preventDefault(); close(); } });
        el.overlay.appendChild(d); ttDlg = d;
        const first = d.querySelector('input'); if (first) { first.focus(); if (first.select) first.select(); }
    }
    function ttRun(it, vals) {
        const ta = el.src, v = ta.value;
        let { s, e } = ttRange || { s: ta.selectionStart, e: ta.selectionEnd };
        let a, b;
        if (s === e) { a = 0; b = v.length; }
        else if (it[3]) { const lr = lineRange(v, s, e); a = lr.a; b = lr.b; }
        else { a = s; b = e; }
        const src = v.slice(a, b);
        if (!src.trim()) { flash('Nothing to change here'); return; }
        const out = TT[it[2]](src, vals);
        if (out === null) { flash('No matches found between those strings'); return; }
        if (out === src) { flash('Already clean — nothing changed'); return; }
        replaceRange(a, b, out, a, a + out.length);
        refreshToolbar();
        flash(it[0].replace('…', '') + ' done — Ctrl+Z to undo');
    }

    // ── click a paragraph / heading / list / quote / code block in Read view to edit just that block ──
    var blkSess = null;
    var READ_CLICK_EDIT = false;   // Read view is read-only now; editing in place is the Live preview mode (pen button)
    function blkMap() {
        if (!window.marked || !window.marked.lexer || !S.note) return null;
        const md = S.note.markdown || '';
        const fm = md.length - extractFrontmatter(md).body.length;
        const body = md.slice(fm);
        if (/^\[\^[^\]]+\]:/m.test(body)) return null;   // footnote definitions move text around; use Edit/Split there
        let toks;
        try { toks = window.marked.lexer(body, { gfm: true, breaks: true }); } catch (e) { return null; }
        let off = fm; const list = [];
        toks.forEach((t) => {
            if (t.type !== 'space') list.push({ start: off, end: off + t.raw.replace(/\s+$/, '').length, type: t.type });
            off += t.raw.length;
        });
        const kids = Array.from(el.read.children).filter((c) => !c.classList.contains('nv-blank'));
        return kids.length === list.length ? { list, kids } : null;
    }
    function blkAutosize(ta) { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px'; }
    function blkStart(block) {
        const map = blkMap();
        if (!map) return;
        const i = map.kids.indexOf(block);
        if (i < 0) return;
        const info = map.list[i];
        if (info.type === 'hr' || info.type === 'html') return;
        const md = S.note.markdown || '';
        const ta = document.createElement('textarea');
        ta.className = 'nv-blk-edit'; ta.spellcheck = false; ta.value = md.slice(info.start, info.end);
        ta.setAttribute('aria-label', 'Edit this block (Markdown). Click outside to finish.');
        blkSess = { ta, start: info.start, end: info.end };
        block.replaceWith(ta);
        blkAutosize(ta);
        ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.addEventListener('input', () => blkAutosize(ta));
        ta.addEventListener('blur', blkCommit);
        ta.addEventListener('keydown', (e) => {
            if (!(e.ctrlKey || e.metaKey)) e.stopPropagation();
            else if (e.key === 'Enter') { e.preventDefault(); ta.blur(); }
        });
    }
    function blkCommit() {
        const B = blkSess; if (!B) return;
        blkSess = null;
        const val = B.ta.value.replace(/\s+$/, ''), md = S.note.markdown || '';
        const y = el.docScroll.scrollTop;
        if (val !== md.slice(B.start, B.end)) {
            const nm = md.slice(0, B.start) + val + md.slice(B.end);
            S.note.markdown = nm;
            if (el.src) el.src.value = nm;
            markDirty();
        }
        renderInto(el.read, S.note.markdown);
        el.docScroll.scrollTop = y;
        renderOutline(); renderMentions();
    }
    function initBlockEdit() {
        el.read.addEventListener('click', (e) => {
            if (!READ_CLICK_EDIT || S.mode !== 'read' || S.split || S.viewRev || blkSess || !S.note) return;   // Read = view/copy only; press the pen to edit
            const t = e.target;
            if (!t || !t.closest || t.closest('a, button, input, textarea, img, svg, .nv-mermaid, .nv-visual, .nv-tbl-editing, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
            const sel = window.getSelection && window.getSelection();
            if (sel && sel.toString().length) return;   // selecting text to copy: leave it alone
            const block = Array.from(el.read.children).find((c) => c.contains(t));
            if (!block) return;
            if (block.classList.contains('nv-tablewrap')) {
                const cell = t.closest('th,td');
                tblStart(block);
                if (tblSess && cell) {
                    const r = cell.parentElement.parentElement.tagName === 'THEAD' ? -1 : cell.parentElement.rowIndex - 1;
                    const f = block.querySelector('[data-r="' + r + '"][data-c="' + cell.cellIndex + '"]');
                    if (f) f.focus();
                }
                return;
            }
            blkStart(block);
        });
    }

    /* ═════════════ Live Preview editor (Obsidian-style) ═════════════
       The hidden <textarea> (el.src) stays in step with the live editor, so every existing editing
       feature that reads el.src (toolbar state, text tools, wikilink popup, paste handling…) keeps
       working. Writes go through replaceRange(), which sends them to the live editor instead. */
    var lv = null, lvMirror = false;
    var TA_PROTO = HTMLTextAreaElement.prototype;
    var TA_VALUE = Object.getOwnPropertyDescriptor(TA_PROTO, 'value');
    /* Typeset formulas inside Live-preview table cells.
       Safety rules (so typing in a cell can never be disturbed):
         - only cells that are NOT the focused element are touched;
         - a cell's source lives in data-raw, and focusing a cell resets it to that raw text,
           so rendered SVG never ends up in the saved note;
         - if the user focuses a cell while MathJax is still working, only stray rendered math is removed
           from it; text they typed is never overwritten. */
    var lvMathTimer = 0, lvMathTries = 0;
    function liveMathSoon() {
        clearTimeout(lvMathTimer);
        lvMathTimer = setTimeout(liveTypesetCells, 60);
    }
    function liveTypesetCells() {
        if (!el || !el.live) return;
        var cells = Array.prototype.filter.call(el.live.querySelectorAll('.cm-lv-table th, .cm-lv-table td'), function (c) {
            return c !== document.activeElement && !c.querySelector('mjx-container') && c.textContent.indexOf('\\(') !== -1;
        });
        if (!cells.length) { lvMathTries = 0; return; }
        var mjx = window.MathJax;
        if (!mjx || !mjx.typesetPromise) {            // MathJax loads async; try again shortly
            if (lvMathTries++ < 15) lvMathTimer = setTimeout(liveTypesetCells, 400);
            return;
        }
        lvMathTries = 0;
        mjx.typesetPromise(cells).catch(function () {}).then(function () {
            var a = document.activeElement;
            // The user focused a cell while MathJax was working on it. Never rewrite the cell's text
            // (they may already have typed into it): just drop any rendered math that slipped in.
            if (a && a.closest && a.closest('.cm-lv-table') && a.querySelector && a.querySelector('mjx-container')) {
                a.querySelectorAll('mjx-container, mjx-assistive-mml').forEach(function (n) { n.remove(); });
                if (!(a.textContent || '').trim() && a.dataset.raw) a.textContent = a.dataset.raw;   // only if it ended up empty
            }
        });
    }
    function liveHooks() {
        return {
            renderBlock: async (box, md, inline) => {
                await renderInto(box, md);
                if (inline) {
                    const p = box.firstElementChild;
                    if (p && p.tagName === 'P' && box.children.length === 1) { while (p.firstChild) box.insertBefore(p.firstChild, p); p.remove(); }
                }
            },
            inlineHtml: (raw) => {
                try {
                    // Same math protection as the reading view: park "$x$", "\(x\)" and "$$x$$" behind
                    // placeholders so marked can't eat the backslashes, then put the TeX back as text.
                    // The table widget calls this for every cell that is not being edited; the cell's
                    // real source stays in its data-raw attribute, so nothing here touches saved text.
                    const hasMd = !!(window.marked && window.marked.parseInline);
                    const mj = hasMd ? mjxPrepare(String(raw)) : null;
                    let html = hasMd ? mj.restore(window.marked.parseInline(mj.text, { gfm: true, breaks: false })) : esc(raw);
                    const tpl = document.createElement('template');
                    tpl.innerHTML = window.DOMPurify ? DOMPurify.sanitize(html) : esc(raw);
                    linkifyWikilinks(tpl.content);
                    const out = tpl.innerHTML;
                    if (out.indexOf('\\(') !== -1) liveMathSoon();
                    return out;
                } catch (e) { return esc(raw); }
            },
            wikiExists: (t) => !!findNoteByTitle(t),
            openWiki: (t) => { const n = findNoteByTitle(t); if (n) openNote(n.id); else flash('No note called “' + t + '” yet'); }
        };
    }
    function liveEnsure() {
        if (lv || !window.NvLive) return lv;
        lv = window.NvLive.create({
            parent: el.live, doc: '', hooks: liveHooks(),
            onUpdate: (u) => {
                const ta = el.src;
                if (u.doc !== null) { lvMirror = true; TA_VALUE.set.call(ta, u.doc); lvMirror = false; }
                TA_PROTO.setSelectionRange.call(ta, u.from, u.to);
                if (u.doc !== null) ta.dispatchEvent(new Event('input', { bubbles: true }));   // existing handlers: save, toolbar, [[ popup]]
                else { refreshToolbar(); checkWlTrigger(); }
            },
            onKey: (e) => {
                if (!(e.ctrlKey || e.metaKey || e.altKey) && e.key && e.key.length === 1) e.stopPropagation();   // typing "/" must not trigger vault shortcuts
                if ((e.ctrlKey || e.metaKey) && e.shiftKey && String(e.key).toLowerCase() === 'v') { plainPasteOnce = true; setTimeout(() => { plainPasteOnce = false; }, 800); }
                onEditorKey(e);
                return e.defaultPrevented;
            },
            onPaste: (e) => { onEditorPaste(e); return e.defaultPrevented; },
            onDrop: (e) => {
                const files = e.dataTransfer && e.dataTransfer.files
                    ? Array.from(e.dataTransfer.files).filter((f) => /^image\//.test(f.type) || f.type === 'application/pdf' || !!sheetMimeOf(f)) : [];
                if (!files.length) return false;
                e.preventDefault(); insertAttachments(files); return true;
            },
            onFocus: (f) => { if (f) { refreshToolbar(); checkWlTrigger(); } else setTimeout(closeWlPopup, 150); }
        });
        return lv;
    }
    function liveLoad() {
        if (!liveEnsure()) { S.live = false; el.live.hidden = true; el.src.hidden = false; return; }
        lv.load(S.note.markdown || '');
        TA_PROTO.setSelectionRange.call(el.src, 0, 0);
    }
    function initLiveAdapter() {
        const ta = el.src;
        Object.defineProperty(ta, 'value', {
            configurable: true,
            get() { return TA_VALUE.get.call(ta); },
            set(v) { TA_VALUE.set.call(ta, v); if (S.live && lv && !lvMirror && lv.getDoc() !== String(v)) lv.setDoc(String(v)); }
        });
        ta.setSelectionRange = function (a, b) { TA_PROTO.setSelectionRange.call(ta, a, b); if (S.live && lv && !lvMirror) lv.setSel(a, b, true); };
        ta.focus = function (o) { if (S.live && lv) lv.focus(); else TA_PROTO.focus.call(ta, o); };
    }
    function initSplitUI() {
        if (!el || !el.src || !el.read) return;
        initLiveAdapter();
        initBlockEdit();
        const tgl = $('nvModeToggle'); if (tgl) tgl.addEventListener('click', () => toggleEditRead());
        el.src.addEventListener('input', () => {
            if (!S.split) return;
            tblSess = null;
            clearTimeout(spTimer); spTimer = setTimeout(spRender, 220);
        });
        ['keyup', 'click'].forEach((ev) => el.src.addEventListener(ev, () => { if (S.split) spFollowCaret(); }));
        el.src.addEventListener('scroll', () => {
            if (!S.split || performance.now() < spIgnoreSrc) return;
            const A = spAnchors(true); if (!A) return;
            spIgnoreRead = performance.now() + 120;
            el.read.scrollTop = spPosToY(A, spSrcPos());
        });
        el.read.addEventListener('scroll', () => {
            if (!S.split || performance.now() < spIgnoreRead || tblSess) return;
            const A = spAnchors(true); if (!A) return;
            const ta = el.src, len = (S.note.markdown || '').length, r = ta.scrollHeight - ta.clientHeight;
            spIgnoreSrc = performance.now() + 120;
            ta.scrollTop = len ? r * spYToPos(A, el.read.scrollTop) / len : 0;
        });
        el.read.addEventListener('click', (e) => {
            const pb = e.target.closest && e.target.closest('.nv-tbl-pencil');
            if (pb) { e.preventDefault(); e.stopPropagation(); tblStart(pb.closest('.nv-tablewrap')); return; }
            const ab = e.target.closest && e.target.closest('.nv-tbl-btn');
            if (ab) { e.preventDefault(); e.stopPropagation(); const a = ab.getAttribute('data-act'); if (a === 'done') tblStop(); else tblAction(a); }
        });
        el.read.addEventListener('focusin', (e) => {
            const cell = e.target.closest && e.target.closest('.nv-tbl-editing th, .nv-tbl-editing td');
            if (cell && tblSess) tblSess.cur = { r: +cell.getAttribute('data-r'), c: +cell.getAttribute('data-c') };
        });
        el.read.addEventListener('keydown', tblKey);
        el.read.addEventListener('input', (e) => {
            if (!tblSess || !(e.target.closest && e.target.closest('.nv-tbl-editing'))) return;
            clearTimeout(tblSess.t); const sess = tblSess;
            sess.t = setTimeout(() => { if (tblSess === sess) { tblReadDom(); tblWrite(); } }, 400);
        });
        el.read.addEventListener('paste', (e) => {
            if (!e.target.closest || !e.target.closest('.nv-tbl-editing')) return;
            e.preventDefault();
            const txt = ((e.clipboardData || window.clipboardData).getData('text/plain') || '').replace(/\r?\n/g, ' ');
            document.execCommand('insertText', false, txt);
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGraphUI); else initGraphUI();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initOutlineMapUI); else initOutlineMapUI();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSplitUI); else initSplitUI();

    // Lightweight, read-only note search for the app-wide Global Search (Ctrl/⌘+K outside
    // the vault). Reads straight from IndexedDB like getLinkCounts does, so it works even
    // before the person has ever opened the Notes Vault overlay this session — no S.notes
    // dependency, no side effects. Scores title > body > tags/folder, same idea as the
    // in-vault search, just trimmed down and capped to `limit` results.
    async function searchNotesLite(query, limit) {
        limit = limit || 8;
        const q = (query || '').trim();
        if (!q) return [];
        let all;
        try { all = (await dbGetAll()).map(normalizeNote).filter((n) => !n.deletedAt); }
        catch (e) { return []; }
        const tokens = fold(q.normalize('NFC')).split(/\s+/).filter(Boolean);
        if (!tokens.length) return [];
        const out = [];
        for (const n of all) {
            const e = getFold(n);
            let score = 0, ok = true;
            for (const t of tokens) {
                const it = findAt(e.ft, t, 0), ib = findAt(e.fb, t, 0), ig = findAt(e.fg + ' ' + e.fc, t, 0);
                if (it >= 0) score += it === 0 ? 30 : 20;
                else if (ib >= 0) score += 10;
                else if (ig >= 0) score += 8;
                else { ok = false; break; }
            }
            if (ok) out.push({ id: n.id, title: n.title.trim() || 'Untitled note', type: normType(n.type), snippet: plainSnippet(n.markdown), score });
        }
        out.sort((a, b) => b.score - a.score);
        return out.slice(0, limit);
    }

    window.NotesVault = {
        toggle, open, close, newNote, openNote,
        renderList: () => { if (S.open) renderAll(); },
        exportAllJson, importJson, requestPersist,
        getBackupData, restoreFromBackup,
        getLinkCounts, openForSkill,
        getCourseLinkCounts, openForCourse,
        getResourceLinkCounts, openForResource,
        getAnalysisLinkCounts, openForAnalysis,
        getDealLinkCounts, openForDeal,
        getVaultStorageStats, getStorageHealth,
        searchNotesLite,
        // Used by the planner's "Review again": change a note's deadline (saved + mirrored to the planner).
        setDeadline: async (id, date) => {
            const n = await remGetNote(id);
            if (!n) return false;
            await remApply(n, { deadline: /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : '' });
            if (S.open) { try { renderSide(); renderLibrary(); } catch (e) { /* ignore */ } }
            return true;
        }
    };
})();
