# GURMAD V2 — Phase 5: Document & File Management — Implementation Specification

**Status:** SPECIFICATION ONLY. No code, schema, dependency, or production changes were made during this stage.
**Baseline:** V2 HEAD `9020fc617a4e2066d019848e39b0c1c02b9c18e2` (Phase 4 FROZEN).
**Built directly on:** `GURMAD_V2_Phase5_Document_File_Decisions.md` (all decisions there are binding input; nothing here reopens or reinterprets them).

---

## 1. Exact Database Schema

All three tables use `CREATE TABLE IF NOT EXISTS` (additive-only, matching every prior phase's migration convention). No existing table is altered.

```sql
CREATE TABLE IF NOT EXISTS file_objects (
  id SERIAL PRIMARY KEY,
  storage_key VARCHAR(300) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  display_filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  extension VARCHAR(10) NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 15728640), -- 15MB, §13
  checksum_sha256 VARCHAR(64),
  storage_provider VARCHAR(20) NOT NULL DEFAULT 'local' CHECK (storage_provider IN ('local')),
  created_by INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_objects_storage_key ON file_objects(storage_key);

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(20) NOT NULL CHECK (category IN (
    'official', 'contract', 'certificate', 'report', 'financial',
    'hr', 'procurement', 'operational', 'other'
  )),
  description TEXT,
  current_file_object_id INTEGER NOT NULL REFERENCES file_objects(id) ON DELETE RESTRICT,
  zone_id INTEGER REFERENCES zones(id) ON DELETE RESTRICT, -- nullable: NULL = company-wide (§14)
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'voided')),
  replaces_document_id INTEGER REFERENCES documents(id) ON DELETE RESTRICT, -- void-and-replace pointer (§6)
  created_by INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  voided_at TIMESTAMP,
  voided_by INTEGER,
  voided_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_zone_id ON documents(zone_id);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_created_by ON documents(created_by);
-- Partial unique index: a document may be pointed at by at most one replacement
-- (prevents two different documents both claiming to replace the same prior one).
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_replaces_unique ON documents(replaces_document_id) WHERE replaces_document_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_attachments (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  entity_type VARCHAR(30) NOT NULL CHECK (entity_type IN (
    'employee', 'procurement_request', 'purchase_order', 'inventory_item', 'asset',
    'complaint', 'cashout', 'customer', 'supplier'
  )), -- reserved enum values, §4/A4 of Decisions — zero rows populate this table in MVP (§18)
  entity_id INTEGER NOT NULL, -- no FK — cross-module reference without a hard dependency, mirrors Inventory & Assets' source_purchase_order_receipt_item_id precedent
  zone_id INTEGER REFERENCES zones(id) ON DELETE RESTRICT, -- denormalized, server-set only
  created_by INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_document_attachments_document_id ON document_attachments(document_id);
CREATE INDEX IF NOT EXISTS idx_document_attachments_entity ON document_attachments(entity_type, entity_id);
```

**Category Enum — RESOLVED.** The nine values above are LOCKED by explicit Business-Owner decision, recorded in the "DECISIONS AMENDMENT — `documents.category` Taxonomy" section of `GURMAD_V2_Phase5_Document_File_Decisions.md`. (History: an earlier version of this Specification had silently invented a different six-value list — `contract`/`certificate`/`report`/`photo`/`form`/`other` — which was withdrawn as an unauthorized taxonomy; the amendment was then opened as blocked pending business-owner input, and is now resolved with the nine values shown here.) `category` describes the document's business purpose/nature only — per the amendment's explicit design principle, it is never a substitute for `entity_type`/`entity_id`/module ownership/attachment relationship, all of which remain out of scope for MVP (§4, zero `document_attachments` rows populated).

---

## 2. PK / FK / Nullability / Unique / CHECK / Index Decisions

| Table | PK | FKs (all `ON DELETE RESTRICT` except none nullable-cascade) | Nullable columns | Unique constraints | CHECK constraints | Indexes |
|---|---|---|---|---|---|---|
| `file_objects` | `id` SERIAL | none | `checksum_sha256` only | `storage_key` (unique) | `file_size` bounds, `storage_provider` enum | `storage_key` (unique, doubles as lookup) |
| `documents` | `id` SERIAL | `current_file_object_id` → `file_objects`, `zone_id` → `zones`, `replaces_document_id` → `documents` (self) | `zone_id`, `replaces_document_id`, `voided_at`/`voided_by`/`voided_reason`, `description` | `replaces_document_id` (partial unique, WHERE NOT NULL) | `category` enum, `status` enum | `zone_id`, `category`, `status`, `created_by` |
| `document_attachments` | `id` SERIAL | `document_id` → `documents` | `zone_id` (company-wide attachment case) | none | `entity_type` enum | `document_id`, `(entity_type, entity_id)` composite |

No `CASCADE` delete anywhere in this feature — identical to the universal RESTRICT convention already established in every prior phase (Inventory & Assets, Procurement, Fleet, HR). `entity_id` on `document_attachments` deliberately has **no FK** — this is a locked Decisions-stage choice (A4/§6), not an oversight: a hard FK would require `document_attachments` to know about every module's own table today, defeating the "zero integration" boundary this MVP enforces.

---

## 3. Relationship Between the Three Tables

```
file_objects (1) ←──── (1) documents.current_file_object_id
documents (1) ←──── (0..1) documents.replaces_document_id   [self-referencing chain]
documents (1) ←──── (0..N) document_attachments.document_id
```

- One `file_objects` row is referenced by exactly one `documents` row's `current_file_object_id` at any time (no sharing — even a byte-identical re-upload creates a new `file_objects` row, per §9's checksum note; deduplication is explicitly not built, per Decisions).
- A `documents` row may optionally point at a prior `documents` row it replaces (`replaces_document_id`), forming a linear chain, never a tree (enforced by the partial unique index — a document can be replaced by at most one successor).
- A `documents` row may have zero or many `document_attachments` rows — but in MVP, **zero rows are ever inserted into `document_attachments`** by any shipped endpoint (§18). The table exists as ready infrastructure for a Future CR, not as a populated feature.

---

## 4. Attachment Ownership Model and Allowed Attachment Semantics

Per Decisions §4/§15: the attachment model is a **constrained-enum cross-reference**, not an unconstrained polymorphic column and not a per-module FK table. `entity_type` is restricted to the fixed CHECK list in §1; `entity_id` is a plain integer with no referential integrity to the target table (by design — see §2).

**MVP behavior**: no API endpoint in this Specification creates, reads, updates, or deletes a `document_attachments` row. The table is created (additive schema only) so that a Future CR wiring one specific module integration does not also need a new migration for the linking mechanism itself — it only needs its own new endpoint(s) that insert into this existing table. This Specification defines the table's shape but ships **zero attachment functionality**.

---

## 5. Document Lifecycle and State Transitions

```
        upload
          │
          ▼
      [active] ──archive──► [archived] ──restore──► [active]
          │                      │
          └──────void────────────┘
                   │
                   ▼
              [voided]  (terminal via API — row itself is never deleted)
```

- `active → archived`: Admin only, reversible, no reason required (mirrors a routine housekeeping action, not a business-evidence removal).
- `archived → active`: Admin only (restore).
- `active → voided` or `archived → voided`: Admin only, **reason required** (mirrors Cashouts' exact rule — `voided_reason` must be a non-empty trimmed string).
- `voided → *`: **no transition exposed via any endpoint.** The row is permanently inspectable (list/detail still return it, filterable by `status=voided`) but cannot be reactivated through this API surface. (This is intentionally more conservative than `archived`, matching the Decisions-locked distinction between a routine archive and a deliberate void.)
- No transition ever deletes the `documents` row or its `file_objects` binary (§7 of Decisions, restated as binding here).

---

## 6. Void-and-Replace Behavior

`POST /v2/documents/:id/replace` (see §23 for full endpoint definition) performs, in one DB transaction:

1. Load the existing `documents` row by `:id`; `404` if missing, `409` if its `status` is not `active` (an archived or voided document cannot be replaced — it must be restored to `active` first, or is permanently superseded already).
2. Re-run the full authorization chain (role, zone) against the existing document — identical to every other mutating endpoint.
3. Validate and store the new upload exactly as §14 (Upload Validation Sequence) describes, producing a new `file_objects` row.
4. Insert a new `documents` row: same `title`/`category`/`zone_id` as the original unless the caller explicitly supplies replacement metadata in the same request (allowed — replacing a file and correcting its title in one action is a reasonable, common case), `current_file_object_id` = the new `file_objects.id`, `replaces_document_id` = the original document's `id`.
5. Update the **original** `documents` row: `status = 'voided'`, `voided_reason = 'Replaced by document #<new id>'` (system-generated, not user-supplied, so the void reason is always traceable to the replacement), `voided_by = req.user.id`, `voided_at = now()`.
6. Commit. `logAudit()` once for the replacement action (§20), referencing both document IDs.
7. On any failure at step 3 (upload validation), the transaction rolls back and the just-written new binary (if `fs.writeFile` already ran before the DB insert failed) is deleted — identical rollback-safety discipline already proven in Phase 4's ledger-movement transactions.

The original document's own `file_objects` row and binary are **never deleted** by this flow — they remain reachable via the original document's own detail/download endpoints (now returning a `voided` document, which downloads/preview still permit for view-role holders, since voiding hides nothing from authorized viewers — it only marks the record's lifecycle state).

---

## 7. Storage Abstraction / Interface

A single internal module, `server/lib/documentStorage.js` (new file, not yet created — Specification only), exposes exactly three functions, matching Decisions §5's locked interface shape:

```
async function putFile(buffer, storageKey) → Promise<void>
async function getFileStream(storageKey) → Readable stream
async function deleteFile(storageKey) → Promise<void>   // reserved; not called by any MVP endpoint (§7/§31)
```

No route file, controller, or business-logic function ever calls `fs`/`multer`-storage details directly — every read/write of a binary goes through these three functions. This is the seam a future object-storage backend (Future CR, Decisions §5) swaps behind without any caller-side change.

---

## 8. Local Filesystem Implementation Contract

- Base directory: `path.join(__dirname, '..', 'uploads', 'documents')` — created via `fs.mkdirSync(UPLOAD_DIR, { recursive: true })` at module load, identical convention to Cashouts/Complaints/Settings.
- `putFile(buffer, storageKey)` writes to `path.join(UPLOAD_DIR, storageKey)` — the storage key is **always** a flat filename (no subdirectories, no path segments), enforced by the key-generation rule in §9, so `path.join` can never traverse outside `UPLOAD_DIR` regardless of input.
- `getFileStream(storageKey)` resolves the same `path.join(UPLOAD_DIR, storageKey)` and returns `fs.createReadStream(...)`; the caller (the download/preview route) is responsible for checking `fs.existsSync` first and returning `404` if absent (§31).
- `deleteFile(storageKey)` is implemented (for future use by a Future-CR orphan sweep, §31) but is **never invoked by any MVP route** — void/archive/restore never call it.
- No symbolic links are ever followed or created; `storageKey` is validated (§9) to contain only the generated pattern's own character set before being joined into a path, as a second layer of defense beyond "we generated it ourselves."

---

## 9. Storage Key Generation Rules

```
storageKey = `${Date.now()}-${crypto.randomInt(1e9)}${normalizedExtension}`
```

- Identical pattern (timestamp + large random integer + extension) to all three existing V2 modules (Cashouts/Complaints/Settings) — proven, no path-traversal surface, since it never incorporates any client-supplied string.
- `normalizedExtension` is derived from the **validated** MIME type (§11), not from `req.file.originalname`'s own extension — i.e., the extension on disk is chosen by the server based on what the file was validated as, not what the client claimed via filename. This closes a subtle gap none of the three existing modules currently addresses (they all use `path.extname(originalname)` directly) — a deliberate hardening improvement within MVP scope (it is a validation-sequence detail, not a new business rule or dependency).
- Checksum (`checksum_sha256`) is computed via Node's built-in `crypto.createHash('sha256')` over the uploaded buffer — no new dependency. Per Decisions, this is stored for integrity/record-keeping only; **no deduplication logic reads or compares it in MVP** (a byte-identical re-upload still creates a new, independent `file_objects` row).

---

## 10. Original Filename vs. Stored Filename/Key Handling

| Field | Source | Purpose | Ever used as a path? |
|---|---|---|---|
| `original_filename` | `req.file.originalname`, stored as-is (sanitized only by stripping any path-separator characters `/`,`\` if somehow present, and truncated to 255 chars) | Historical record of what the uploader called it; shown in a "originally uploaded as" UI hint if ever needed | **Never** |
| `display_filename` | Derived from `original_filename`, further sanitized (control characters stripped, whitespace-collapsed) | The name shown in the UI and used in `Content-Disposition`'s `filename=` parameter | **Never** — used only as a header value, not a filesystem path |
| `storage_key` | Server-generated per §9 | The actual on-disk filename | **Yes — the only field ever joined into a filesystem path** |

This three-way separation is the direct implementation of Decisions' "client-provided filenames must never become filesystem paths" rule (S3) and Discovery's own explicit path-traversal concern.

---

## 11. MIME/Type Validation Rules

- `multer`'s `fileFilter` rejects (no disk write) any upload whose `file.mimetype` is not in the allowlist below.
- The allowlist is a fixed array of exact MIME strings (not wildcard prefixes like legacy's `image/*`), matching the more precise style already used in Settings.js:

```
application/pdf
application/msword                                                          (DOC)
application/vnd.openxmlformats-officedocument.wordprocessingml.document     (DOCX)
application/vnd.ms-excel                                                    (XLS)
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet           (XLSX)
text/csv
image/jpeg
image/jpg
image/png
image/webp
```

- Extension cross-check (§12): the file's claimed extension (from `originalname`) must belong to the same MIME family as the validated `mimetype` (e.g., a file claiming `.pdf` but whose MIME is `image/png` is rejected) — a new validation step beyond current V2 practice, closing the gap Decisions §S4 locked. This is a comparison against a fixed lookup table, not a content-sniffing library — no new dependency.
- Rejection response: `400` with `{ error: { message: 'File type not allowed. Supported: PDF, DOC, DOCX, XLS, XLSX, CSV, JPG, PNG, WEBP.', code: 'VALIDATION' } }`.

---

## 12. Extension Allowlist

```
.pdf, .doc, .docx, .xls, .xlsx, .csv, .jpg, .jpeg, .png, .webp
```

Explicitly rejected (never reach the allowlist check — checked first, fails fast with a clear message): `.svg`, `.html`, `.htm`, `.js`, `.mjs`, `.exe`, `.sh`, `.bat`, `.cmd`, `.msi`, `.app`, `.zip`, `.rar`, `.7z`, `.docm`, `.xlsm` — per Decisions §9/S7, restated here as the exact denylist for implementation clarity (the allowlist above already excludes all of these; the denylist is documented so a future contributor extending the allowlist sees the explicit prior security reasoning, mirroring Settings.js's own comment style).

---

## 13. File Size Limit

**15MB (15,728,640 bytes) exactly**, per Decisions §10 — no per-category variation. Enforced via:
- `multer({ limits: { fileSize: 15 * 1024 * 1024 } })` — server-side, authoritative.
- Express body-parser/multipart limit configured to accommodate this (the route-level `multer` limit is what actually rejects an oversized file; no separate global body-size config change is needed beyond what already exists, since the three existing upload routes already handle multipart bodies up to 10MB with no separate global change — confirmed no global `express.json({limit})` applies to multipart routes, which bypass the JSON body parser entirely).
- Frontend pre-check (§26): a client-side `file.size` check before submission, purely for UX (immediate feedback instead of waiting for a round-trip) — never trusted as the actual boundary.
- Oversized-file rejection: multer's own `LIMIT_FILE_SIZE` error, caught and mapped to `400` with `{ error: { message: 'File exceeds the 15MB size limit.', code: 'VALIDATION' } }`.

---

## 14. Upload Validation Sequence

Exact order, matching the `authenticateToken → requireRole → resource existence → zone authorization → business validation → DB action` chain mandated for every route in this program, adapted for a file-upload route (no pre-existing "resource" to check on a create):

1. `authenticateToken` — reject `401` if missing/invalid.
2. `requireRole('admin', 'gudoomiye')` — reject `403` if wrong role (§16 RBAC).
3. `multer` middleware runs: extension pre-check → MIME `fileFilter` → size limit. Any failure here means **no disk write occurred at all** (multer's `fileFilter` runs before `destination`/`filename` callbacks execute) — reject `400`.
4. Business validation: `title` required (non-empty, trimmed, max 255 chars); `category` must be one of the nine locked CHECK values (`official`/`contract`/`certificate`/`report`/`financial`/`hr`/`procurement`/`operational`/`other`); if caller is `gudoomiye`, `zone_id` is **server-resolved** from `resolveUserZoneId(req.user)` (identical pattern to every prior phase) and any client-supplied `zone_id` in the request body is silently ignored for that role; if caller is `admin`, an optional client-supplied `zone_id` is accepted (validated against `zones` table) or `null` (company-wide) is the default.
5. Compute checksum (§9), generate storage key (§9), call `putFile()` (§7/§8).
6. Begin DB transaction: insert `file_objects` row, insert `documents` row referencing it. On any DB failure, roll back and call `deleteFile()` on the just-written binary before returning `500`.
7. Commit. `logAudit()` (§20). Return `201` with the created document's metadata (never the raw `storage_key`).

---

## 15. Download/Preview Authorization Sequence

Identical for both `GET .../documents/:id/file` (download/preview) requests, differing only in the `Content-Disposition` header (§11 of Decisions):

1. `authenticateToken` — `401` if missing/invalid.
2. `requireRole('admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier')` — `403` for `collector` or any other role.
3. Load the `documents` row by `:id` — `404` if it does not exist (this check happens **before** any zone comparison, so a nonexistent ID and an unauthorized-zone ID both eventually reach the caller as indistinguishable-in-spirit failures at different codes — `404` vs `403` — matching every prior phase's own precedent of not conflating "doesn't exist" with "you can't see it" merely for extra secrecy, since ID enumeration is not the security boundary here per Decisions §S10).
4. Resolve caller's zone via `resolveUserZoneId(req.user)`, using `ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant']` (copied unchanged from `routes/inventory.js`, see §22). For `gudoomiye`/`zone_accountant`, this returns their resolved zone; for `admin`/`head_of_cashiers`/`cashier`, it returns `null` (no restriction — company-wide). If the resolved value is non-null and the document's own `zone_id` is non-null and does not match, return `403`.
5. Load the linked `file_objects` row via `documents.current_file_object_id`; if the physical file is missing (`!fs.existsSync`), return `404` with a distinct message ("file no longer exists on disk") — §31.
6. Set response headers (§17), stream via `getFileStream()` (§7/§8).
7. `logAudit()` for the download or preview action (§20) — this happens **after** authorization succeeds, never before, and never for a request that was rejected at steps 1-4.

This exact sequence is re-run on **every single request** — no result is cached across requests, per Decisions §S9/§14.

---

## 16. IDOR Protection

- Every list/detail/download/preview/edit/archive/restore/void/replace endpoint independently re-derives the caller's zone and re-checks it against the target `documents` row's own `zone_id` — never trusts a prior request's authorization result.
- No endpoint accepts a client-supplied `zone_id` as the basis for **its own** authorization decision (only `admin`'s optional `zone_id` on upload/edit is client-supplied, and only because `admin` is company-wide and therefore has no zone restriction to bypass).
- Cross-entity ID confusion is not applicable in MVP (no `document_attachments` rows exist to confuse — §4/§18) but the enum-constrained `entity_type` in the schema (§1) prevents a future Future-CR integration from accepting an arbitrary string that could later collide with an unrelated table's ID space.
- `document_id` in every attachment-adjacent future path is validated to actually reference an existing `documents` row before any linkage (again, not exercised in MVP since no linkage endpoint ships, but the validation shape is specified here so a Future CR does not need to re-derive it).

---

## 17. Cache-Control / Security Headers

On every download/preview response:
```
Cache-Control: private, no-store
Content-Type: <file_objects.mime_type>
Content-Disposition: inline; filename="<display_filename>"          (default)
                   or attachment; filename="<display_filename>"      (when ?download=1 is present)
X-Content-Type-Options: nosniff
```
`X-Content-Type-Options: nosniff` is added as a standard, dependency-free hardening header (already available via the `helmet` dependency already present in `server/package.json` — no new dependency) to prevent a browser from MIME-sniffing an inline-served document into an unexpected content type. No `ETag`/`Last-Modified` caching headers are set, consistent with `no-store`.

---

## 18. Path Traversal Protection

- `storageKey` is exclusively server-generated (§9) — no request input ever contributes a character to it.
- `getFileStream`/`putFile`/`deleteFile` (§7/§8) join `storageKey` against `UPLOAD_DIR` using `path.join`, and as a defense-in-depth measure, validate the resulting resolved path (`path.resolve`) still starts with `UPLOAD_DIR` before touching the filesystem — a check that can only ever fail if the storage-key generation itself were ever changed to accept external input (it never is), but is included as a cheap, explicit assertion rather than an implicit trust in §9 alone.
- `document_id`/`file_object_id`/attachment `entity_id` route parameters are always validated via the existing `parseStrictId` pattern (`/^\d+$/` regex) before any query — identical to every prior phase — so no path/route parameter can smuggle a non-numeric traversal payload into a query in the first place.

---

## 19. Public URL / Static Serving Prohibition

**No `express.static` call is ever added for the documents upload directory, under any circumstance.** This Specification contains zero routes that serve a file without the full authorization chain in §15. This is stated as an absolute, non-negotiable implementation constraint — the single most important carried-forward lesson from Discovery's legacy findings (§19 of Discovery, §S1 of Decisions) — and any future contributor proposing a static mount for convenience must be treated as proposing to reopen a rejected security decision, not a minor implementation detail.

---

## 20. Audit Events and Exact Audit Payload Boundaries

Every event below calls the existing `logAudit({ actorId, actorUsername, action, entityType, entityId, before, after })` — no second audit writer.

| Event | `action` | `entityType` | Payload notes |
|---|---|---|---|
| Upload | `document.create` | `document` | `after` = the new document row; `storage_key` is **never** included in the logged payload (mirrors Cashouts' precedent) |
| Metadata update | `document.edit` | `document` | `before`/`after` = the changed fields only (title/category/description) |
| Archive | `document.archive` | `document` | `before`/`after` status transition |
| Restore | `document.restore` | `document` | `before`/`after` status transition |
| Void | `document.void` | `document` | `after` includes `voided_reason` |
| Replace | `document.replace` | `document` | Logged once, `entityId` = the **new** document's ID, `after` includes `{ replaces_document_id: <old id> }` |
| Download | `document.download` | `document` | No `before`/`after` (a read action) — logged purely as an access record |
| Preview | `document.preview` | `document` | Same as download, distinct `action` string so the two are distinguishable in the audit log |

This is a deliberate expansion beyond Cashouts'/Complaints' own current audit coverage (neither logs download/preview today) — per Decisions §12, this closes the gap for Phase 5's own infrastructure without retroactively touching either CLOSED module's own code.

---

## 21. RBAC Endpoint Matrix

| Endpoint | Admin | Gudoomiye | Zone Accountant | Head of Cashiers | Cashier | Collector |
|---|---|---|---|---|---|---|
| `POST /v2/documents` (upload) | ✅ company-wide | ✅ own zone only | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |
| `GET /v2/documents` (list) | ✅ company-wide | ✅ own zone + company-wide | ✅ own zone + company-wide | ✅ company-wide (no zone restriction) | ✅ company-wide (no zone restriction) | ❌ 403 |
| `GET /v2/documents/:id` (detail) | ✅ company-wide | ✅ own zone + company-wide | ✅ own zone + company-wide | ✅ company-wide (no zone restriction) | ✅ company-wide (no zone restriction) | ❌ 403 |
| `GET /v2/documents/:id/file` (download/preview) | ✅ company-wide | ✅ own zone + company-wide | ✅ own zone + company-wide | ✅ company-wide (no zone restriction) | ✅ company-wide (no zone restriction) | ❌ 403 |
| `PUT /v2/documents/:id` (metadata edit) | ✅ | ✅ own-zone documents only | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |
| `POST /v2/documents/:id/replace` | ✅ | ✅ own-zone documents only | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |
| `PUT /v2/documents/:id/archive` | ✅ | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |
| `PUT /v2/documents/:id/restore` | ✅ | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |
| `PUT /v2/documents/:id/void` | ✅ | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |

**Customer Portal**: zero rows in this table — no Customer Portal route is added anywhere in this Specification, per Decisions §B11/§19 (deferred, not MVP). No `authenticateCustomerPortal`-guarded route exists in this feature.

---

## 22. Zone-Scoping Rules

**Correction from the prior version of this Specification:** the previous text here asserted `ZONE_SCOPED_ROLES = ['gudoomiye']` for read operations and claimed Zone Accountant/Head of Cashiers/Cashier all resolve to company-wide — while simultaneously citing `routes/inventory.js`'s own `ZONE_SCOPED_ROLES` list as the source of that claim. That citation was wrong: the actual list in `routes/inventory.js` is `ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant']` (verified directly against the file) — Zone Accountant **is** zone-restricted in the real, existing precedent this Specification is supposed to mirror. This was a self-contradiction, not a Decisions-locked rule, and is corrected below.

- `ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant']` for **both** write operations (upload/edit/replace — Gudoomiye only, per Decisions §B3, since Zone Accountant has no write access at all per §21) and **read** operations (list/detail/download/preview). This is copied unchanged from `routes/inventory.js`'s own real implementation — the exact "existing VIEW_ROLES pattern already used in Procurement/Inventory" Decisions §13 cites as its stated rationale for Cashier's (and, by the same citation, Zone Accountant's and Head of Cashiers') access level.
- **Zone Accountant**: own-zone + company-wide visibility for read operations (resolves via `resolveUserZoneId()` returning their zone, matching Gudoomiye's own resolution mechanism, but with zero write access per §21).
- **Head of Cashiers** and **Cashier**: company-wide visibility for read operations — both are in `VIEW_ROLES` but **not** in `ZONE_SCOPED_ROLES`, so `resolveUserZoneId()` returns `null` (no restriction) for these two roles specifically, identical to their treatment in `routes/inventory.js`.
- `admin` never has a zone restriction on any operation (`resolveUserZoneId()` returns `null` for `admin` in every module, including this one).
- A `documents.zone_id IS NULL` row (company-wide) is visible/accessible to every role permitted by §21's matrix, regardless of their own resolved zone — identical to the "nullable zone is accessible to all" precedent already established for Inventory & Assets' company-wide stores.

---

## 23. API Endpoint Inventory

| Method | Path | Auth | Roles | Validation | Response |
|---|---|---|---|---|---|
| `POST` | `/v2/documents` | Required | admin, gudoomiye | §14 full sequence | `201` document metadata |
| `GET` | `/v2/documents` | Required | admin, gudoomiye, zone_accountant, head_of_cashiers, cashier | Query filters: `title` (ILIKE, min 2 chars), `category`, `status` (default `active` — archived/voided require an explicit `?status=` to surface, so a routine list view is not cluttered by default), `uploaded_by`, `date_from`, `date_to` | `200` array of document metadata |
| `GET` | `/v2/documents/:id` | Required | same as list | `parseStrictId`, zone check | `200` document detail (includes `file_objects` metadata: filename, mime, size — never `storage_key`) |
| `GET` | `/v2/documents/:id/file` | Required | same as list | §15 full sequence; optional `?download=1` | `200` binary stream, or `404`/`403` per §15 |
| `PUT` | `/v2/documents/:id` | Required | admin, gudoomiye (own zone) | `title`/`category`/`description` only; `400` if no valid field provided (mirrors every prior phase's own "no valid fields" guard) | `200` updated document metadata |
| `POST` | `/v2/documents/:id/replace` | Required | admin, gudoomiye (own zone) | §6 full sequence; original must be `active` | `201` new document metadata |
| `PUT` | `/v2/documents/:id/archive` | Required | admin | Must currently be `active` (`409` otherwise) | `200` updated status |
| `PUT` | `/v2/documents/:id/restore` | Required | admin | Must currently be `archived` (`409` otherwise) | `200` updated status |
| `PUT` | `/v2/documents/:id/void` | Required | admin | `voided_reason` required non-empty; must not already be `voided` (`409`) | `200` updated status |

**9 endpoints total.** No attachment/link endpoint ships (§4/§18). No search-beyond-filters endpoint ships (§29). No reporting endpoint ships (§30).

---

## 24. Error / Status-Code Contract

Identical shape to every existing V2 route: `{ error: { message: '<human-readable>', code: '<UPPER_SNAKE>' } }`.

| Code | Status | When |
|---|---|---|
| `AUTH_REQUIRED` | 401 | Missing/invalid token |
| `FORBIDDEN` | 403 | Wrong role, or zone mismatch |
| `NOT_FOUND` | 404 | Document ID doesn't exist, or (distinct message) binary missing from disk |
| `VALIDATION` | 400 | Missing/invalid title, bad category, disallowed file type, oversized file, missing required reason |
| `CONFLICT` | 409 | Invalid state transition (archive-a-voided-document, restore-a-non-archived-document, void-an-already-voided-document, replace-a-non-active-document) |
| `INTERNAL` | 500 | Unexpected DB/filesystem error; rolls back transaction and cleans up any orphaned just-written binary |

---

## 25. Frontend Pages/Components/Hooks Required for MVP

**Pages** (new directory `client/src/pages/documents/`):
- `DocumentsListPage.jsx`
- `DocumentDetailPage.jsx`

**Modals** (co-located with the list/detail pages, matching every prior phase's own file-organization convention):
- Upload modal (title, category select, file input, optional zone select for admin)
- Metadata-edit modal (title, category, description)
- Replace modal (new file input + optional metadata override)
- Archive/Restore/Void confirmation dialogs — reuse the existing shared `ConfirmDialog` component, no new dialog component needed

**Preview modal**: a new, small `DocumentPreviewModal.jsx` component (image/PDF inline via an authenticated `fetch` → `blob:` URL pattern — never a direct `<iframe src="/v2/documents/:id/file">`, since that would send no Authorization header; the frontend fetches the binary with credentials via its existing `apiClient`, converts to a `Blob`, and renders an `<img>`/`<embed>` from a local `blob:` URL that is revoked on modal close).

**Hooks** (new file `client/src/hooks/useDocuments.js`, following the exact factory pattern already used in `useInventory.js`): `useDocuments(params)`, `useDocument(id)`, `useUploadDocument()`, `useUpdateDocument()`, `useReplaceDocument()`, `useArchiveDocument()`, `useRestoreDocument()`, `useVoidDocument()`. No hook fetches or exposes a raw `storage_key`.

**No Attachment panel component** — nothing to attach to in MVP (§4/§18/§15 of Decisions).

**Router**: 2 new routes (`/documents`, `/documents/:id`), additive only in `client/src/routes/router.jsx`, direct-URL-only — **no Sidebar/AppShell change**, identical to Phase 4's own precedent.

---

## 26. Upload/Download/Preview UX Behavior

- **Upload**: modal form; client-side pre-checks (file type extension, size ≤ 15MB) give immediate feedback but the submit button remains enabled regardless (server is authoritative, per §13) — a rejected server response surfaces the server's own message via the existing toast pattern. Submit button disables while the mutation is pending (`isPending`), identical to every prior phase's own modal convention.
- **Download**: a "Download" button on the detail page triggers an authenticated `fetch` → `blob:` → synthetic `<a download>` click → immediate `URL.revokeObjectURL` cleanup — never a plain `<a href="/v2/documents/:id/file">` link (which would not carry the Authorization header either).
- **Preview**: for PDF/JPG/PNG/WEBP documents only (§11 of Decisions), a "Preview" button opens `DocumentPreviewModal`; for DOC/DOCX/XLS/XLSX/CSV, only "Download" is offered (no preview button rendered at all — not a disabled button, since a disabled control implies "coming soon" rather than "not supported," and Office-preview is a genuine, disclosed Future CR, not a near-term promise).

---

## 27. Loading / Error / Empty States

Identical to every prior phase's established convention, reusing the existing shared `LoadingState`, `ErrorState`, and `DataTable`'s own built-in empty-state rendering (`emptyTitle` prop) — no new state-handling pattern invented. List page: "No documents yet." Detail page on a 404: `ErrorState` with a retry button. Upload/replace/edit modals: inline field-level error text (matching every prior modal in this program), never a blocking alert dialog.

---

## 28. Accessibility and Responsive Requirements

- Every interactive control (upload/download/preview/archive/restore/void buttons, category select, file input) is a native, keyboard-focusable element (`<button>`, `<select>`, `<input>`) — no custom non-semantic clickable `<div>`.
- Focus is trapped and returned correctly by the existing shared `Modal` component (already proven across every prior phase's modals) — no new focus-management code needed.
- Responsive behavior: identical flex/grid layout discipline as every prior phase's pages (`FilterBar`, `DataTable`, `Modal` are all already responsive-proven components) — no new CSS pattern introduced. Preview modal images/PDF embeds use `max-width: 100%` to avoid horizontal overflow on narrow viewports, consistent with the shared reset already established for this app.

---

## 29. Search/Filter Behavior (Only Where Explicitly Locked)

Per Decisions §16: `title` (ILIKE, min 2 characters — identical convention to Inventory's `items`/`stores`/`assets` filters), `category` (exact match against the CHECK enum), `uploaded_by` (exact match against `created_by`), `date_from`/`date_to` (range on `created_at`). No full-text content search, no filename search beyond `title` (a document's own title is the searchable field — `original_filename`/`display_filename` are not separately indexed or searched in MVP, since Decisions did not lock filename search as a distinct requirement). The existing shared Search module (if any) is not touched.

---

## 30. Reporting Behavior (Only Where Explicitly Locked)

**None.** Per Decisions §17, zero reporting endpoints or dashboard widgets ship in MVP. The existing Reports module is not touched.

---

## 31. Orphan / Failure Handling

- **Upload-time failure** (validation or DB failure after a binary was already written): the just-written binary is deleted synchronously within the same request (via `deleteFile()`, §7) before the error response is sent — no orphan is created by any normal failure path, per Decisions §19.
- **Binary missing at read time** (metadata exists, file absent from disk): download/preview route returns `404` with the distinct "file no longer exists on disk" message (§15 step 5) — not auto-repaired, flagged for manual investigation, mirrors Cashouts' existing precedent exactly.
- **Interrupted multipart upload**: relies on `multer`'s own default temporary-file handling — no custom cleanup code added, per Decisions (no new dependency, no custom logic where the existing library's default behavior already suffices).
- **Scheduled orphan sweep**: **not implemented.** `deleteFile()` exists in the storage abstraction (§7) specifically so a Future CR can build a sweep process without needing a new storage-layer function — but no sweep job, cron, or manual-trigger endpoint ships in this Specification. **FUTURE CR — ORPHAN FILE SWEEP** (Decisions §19/§24 item 18), blocked on the still-deferred Retention Policy decision.

---

## 32. Transaction Boundaries and Consistency Rules

- **Upload**: one transaction spanning the `file_objects` INSERT and the `documents` INSERT — both succeed or both roll back (with the binary deleted on rollback, per §31).
- **Replace**: one transaction spanning the new `file_objects` INSERT, the new `documents` INSERT, and the original `documents` UPDATE (void) — all three succeed or all roll back atomically, per §6.
- **Metadata edit / Archive / Restore / Void**: single-statement UPDATEs, each already atomic at the database level; no multi-table transaction needed since none of these touch `file_objects`.
- No endpoint in this Specification ever leaves `file_objects` and `documents` in a state where one references a nonexistent row — every reference is created within the same transaction as its target, identical discipline to every prior phase's own transactional writes (e.g., Phase 3's PO+items, Phase 4's transfer_out+transfer_in pair).

---

## 33. Backup / Recovery Boundary for Current Local Storage

Restated as a binding implementation-stage acknowledgment, not a new decision: a `pg_dump` of this application's database captures `file_objects`/`documents`/`document_attachments` **metadata only**. The binaries under `server/uploads/documents/` are not captured by any database backup and must be backed up separately (e.g., a filesystem-level backup of the `uploads/` directory) if this feature's records are to survive a database restore with their supporting files intact. This Specification does not implement any such filesystem backup — it is explicitly out of scope, tracked as the pre-existing **Production Infrastructure dependency** already recorded in Decisions §20/§24 item 19.

---

## 34. Security Hardening Requirements

Consolidated from §11-19 above, restated as a single implementation checklist:
- [ ] MIME allowlist enforced before any disk write.
- [ ] Extension cross-checked against the MIME's own expected extension family.
- [ ] Storage key is 100% server-generated; the extension used on disk comes from the validated MIME, not the client's claimed filename.
- [ ] File size capped at exactly 15MB server-side.
- [ ] No `express.static` or any other unauthenticated path ever serves this directory.
- [ ] Every download/preview re-runs the full auth+zone check on every request — zero caching.
- [ ] `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff` on every binary response.
- [ ] `path.resolve` assertion confirms the resolved file path stays within `UPLOAD_DIR` before any filesystem read/write.
- [ ] Mass-assignment: `created_by`, `voided_by`/`voided_at`, `current_file_object_id`, and (for non-admin) `zone_id` are never accepted from the request body — always server-set.
- [ ] `logAudit()` called for every state-changing action and every download/preview.

---

## 35. QA Test Matrix

| Category | Test |
|---|---|
| RBAC | Each of the 9 endpoints × each of the 6 roles — exact match to §21's matrix |
| Zone isolation | Gudoomiye-A cannot view/download/edit Gudoomiye-B's own-zone document; company-wide (`zone_id IS NULL`) documents visible to all permitted roles |
| IDOR | Nonexistent document ID → 404; foreign-zone document ID → 403; sequential ID guessing does not bypass authorization |
| File type | Each allowed type uploads successfully; each explicitly rejected type (§12) is rejected with 400; a MIME/extension mismatch (e.g., `.pdf` extension with `image/png` MIME) is rejected |
| Category enum | Each of the 9 locked values (`official`/`contract`/`certificate`/`report`/`financial`/`hr`/`procurement`/`operational`/`other`) is accepted; a 10th/unrecognized value is rejected with 400 at the application layer and would be rejected by the DB `CHECK` constraint even if that layer were bypassed |
| File size | Exactly-15MB file succeeds; 15MB+1byte file rejected with 400 |
| Path traversal | Attempted `../../../etc/passwd`-style filenames in `originalname` never affect the generated storage key or resolved path |
| Lifecycle | active→archived→active (restore) succeeds; active→voided succeeds and is terminal via the API; archive-a-voided document → 409; void-a-voided document → 409; restore-a-non-archived document → 409 |
| Replace | Replacing an active document creates a new document, voids the old one, both remain independently downloadable; replacing an already-voided/archived document → 409 |
| Mass assignment | Client-supplied `created_by`/`voided_by`/`zone_id` (non-admin)/`current_file_object_id` on any write request is ignored/rejected, server value used instead |
| Audit | Every action in §20's table produces exactly one `v2_audit_log` row with the correct `action`/`entityType`; `storage_key` never appears in any logged payload |
| Orphan handling | A simulated DB failure after binary write results in zero orphaned files on disk (binary deleted) |
| Concurrency | Two simultaneous uploads with the same original filename never collide (server-generated keys are independent); this feature introduces no shared-resource lock requirement (unlike Phase 4's ledger) since every document is independent — no race condition class analogous to Phase 4's balance concurrency exists here |
| Regression | See §36 |

**Audit-baseline discipline**: all QA testing must restore `v2_audit_log` to its pre-test count after cleanup, identical to every prior phase's own requirement — no exception for this feature.

---

## 36. Regression Matrix Against Existing Frozen Modules

| Module | Expected regression risk | Verification approach |
|---|---|---|
| Cashout attachments | **None** — zero files in this feature touch `routes/cashouts.js`, `cashout_attachments`, or its upload dir | Re-run Cashouts' own existing attachment upload/download/void flow after Phase 5 ships; confirm unchanged behavior |
| Complaint attachments | **None** — zero files touch `routes/complaints.js`, `routes/customerPortal.js`'s complaint-photo code, or `complaint_attachments` | Re-run Complaints' own existing attachment flow (staff and customer-portal sides) |
| Settings logo | **None** — zero files touch `routes/settings.js` or `company_settings` | Re-fetch the company logo, confirm unchanged |
| Employees | **None** — `employees.photo`/`employees.id_document` columns remain exactly as dead as Discovery found them; no route in `routes/employees.js` is touched | Confirm `employees.js` has zero diff |
| Procurement, Inventory & Assets, Fleet, HR/Payroll | **None** — no file in any of these routers is touched | Confirm zero diff on all Phase 1-4 route files |
| Search, Reports, Sidebar/AppShell | **None** — explicitly not modified per this Specification's own boundaries | Confirm zero diff |
| Customer Portal | **None** — no route added to `customerPortal.js`, no new `authenticateCustomerPortal`-guarded endpoint | Confirm zero diff |

Overall expected regression risk: **zero**, because this feature is additive-only (2 new backend files, 1 new frontend hook file, 2-3 new frontend page/modal files, 1 additive router registration block, 1 additive `db.js` migration block, 1 additive `index.js` router-mount block) with no edit to any existing CLOSED/FROZEN file.

---

## 37. Protected Files/Modules That MUST NOT Be Touched

- `server/routes/cashouts.js`, `cashout_attachments` schema
- `server/routes/complaints.js`, `complaint_attachments` schema
- `server/routes/customerPortal.js`
- `server/routes/settings.js`, `company_settings` schema
- `server/routes/employees.js`, `employees` schema (including the dead `photo`/`id_document` columns — their existence is not an authorization to wire them)
- `server/routes/procurement.js`
- `server/routes/inventory.js`, `server/lib/inventoryCalculations.js`
- `server/routes/attendance.js`, `leaveTypes.js`, `leaveRequests.js`, `payrollPeriods.js`, `payrollRecords.js`, `hrReports.js`, `server/lib/hrCalculations.js`
- `server/routes/fleet.js`, `server/lib/fleetCalculations.js`
- Any Search-module file (none identified as needing inspection beyond what Discovery already covered — none touched)
- Any Reports-module file
- `client/src/App.jsx`'s `menuGroups` (Sidebar), any `AppShell`/`MobileNavDrawer`/`MobileTabBar` file
- `client/src/portal/**` (Customer Portal frontend)
- `server/middleware/auth.js`, `server/db.js`'s existing (non-Phase-5) migration blocks — only an **additive** new block is permitted, nothing existing edited

**The only permitted new/additive touches**: a new additive block appended to `server/db.js`'s `runMigrations()`; two new lines in `server/index.js` (router require + mount, identical to every prior phase's own pattern); brand-new files (`server/routes/documents.js`, `server/lib/documentStorage.js`, `client/src/hooks/useDocuments.js`, `client/src/pages/documents/*.jsx`); an additive block in `client/src/routes/router.jsx`.

---

## 38. Exact Future CR Boundaries

All 21 items from Decisions §24 are preserved verbatim, each restated here with why it is outside this Specification's MVP:

1. **DOCUMENT VERSIONING** — MVP uses void-and-replace only (§6); a full version-history table is unbuilt because no demonstrated need exceeds what replace-pointer chaining already provides.
2. **PRODUCTION OBJECT STORAGE MIGRATION** — no object-storage credentials/infrastructure exist in this environment; the storage abstraction (§7) exists specifically to make this a future no-caller-change swap.
3. **CONTENT-SNIFFING VALIDATION** — would require a new dependency; this stage is not authorized to add one.
4. **VIRUS/MALWARE SCANNING** — no scanning infrastructure exists; a production infrastructure dependency, not a code task.
5. **SIGNED URLS** — only relevant once/if object storage (#2) is adopted; not needed while every download flows through an authenticated API route.
6. **OFFICE-DOCUMENT INLINE PREVIEW** — would require a rendering-service dependency; MVP offers PDF/image preview only, DOC/XLS-family is download-only.
7. **HR/EMPLOYEES DOCUMENT ATTACHMENTS** — Employees is CLOSED; wiring the dead `photo`/`id_document` columns requires its own separately authorized exception, exactly like Phase 4's narrow Procurement touch.
8. **PROCUREMENT DOCUMENT ATTACHMENTS** — Procurement is CLOSED.
9. **INVENTORY DOCUMENT ATTACHMENTS** — Inventory & Assets is CLOSED/FROZEN.
10. **ASSET DOCUMENT ATTACHMENTS** — same module, same reason.
11. **COMPLAINTS MIGRATION TO CENTRALIZED DOCUMENTS** — Complaints' own existing attachment feature is untouched and continues working standalone; migrating it is itself a CLOSED-module-touching change.
12. **CASHOUT SIGNED-DOCUMENT MIGRATION** — same reasoning, applied to Cashouts.
13. **CUSTOMER DOCUMENT ATTACHMENTS** — no Customers-module integration exists or is built.
14. **SUPPLIER DOCUMENT ATTACHMENTS** — no Suppliers-module integration exists or is built.
15. **DOCUMENT FULL-TEXT SEARCH** — would require a text-extraction dependency; MVP offers title/metadata filters only (§29).
16. **DOCUMENT REPORTING** — no demonstrated business driver found in Discovery; MVP ships zero reporting (§30).
17. **RETENTION POLICY** — blocked on a legal/organizational-policy input that does not exist in this engagement; no retention rule is invented.
18. **ORPHAN FILE SWEEP** — overlaps with #17's still-undecided age threshold; not built (§31).
19. **PRODUCTION BACKUP INFRASTRUCTURE FOR FILE BINARIES** — a Production Infrastructure workstream item, not a Phase 5 code task (§33).
20. **LEGACY DOCUMENT/ARCHIVE MIGRATION** — no demonstrated need to migrate legacy's already-partially-hard-deleted, zone-incompatible historical data; would require its own dedicated data-mapping effort.
21. **CUSTOMER PORTAL DOCUMENT ACCESS** — explicitly deferred per Decisions §B11/§19; zero Customer Portal routes/pages touched or added.

---

## Summary of Files to Be Created/Modified at Implementation (for the next stage's own reference — not created now)

**New files:**
- `server/lib/documentStorage.js`
- `server/routes/documents.js`
- `client/src/hooks/useDocuments.js`
- `client/src/pages/documents/DocumentsListPage.jsx`
- `client/src/pages/documents/DocumentDetailPage.jsx`
- `client/src/pages/documents/DocumentPreviewModal.jsx` (or co-located within the above)

**Additive-only edits:**
- `server/db.js` — one new migration block (§1)
- `server/index.js` — 2 lines (router require + mount)
- `client/src/routes/router.jsx` — 2 new route entries

**Zero other files touched**, per §37.

---

## Git / Safety Verification for This Stage

- Baseline HEAD: `9020fc617a4e2066d019848e39b0c1c02b9c18e2` — confirmed unchanged via `git log -1` immediately before writing this document.
- Branch: `main`.
- Working tree: the only files present beyond the baseline are the three Phase 5 markdown documents (Discovery, Decisions, and this Specification) — all untracked, no code/schema/dependency file modified.
- Code changes: **ZERO**.
- Schema changes: **ZERO** (no migration written or executed).
- Dependency changes: **ZERO** (`package.json` untouched; `multer` already present, confirmed sufficient, nothing added).
- Production changes: **ZERO**.

---

## STATUS

**PHASE 5 — DOCUMENT & FILE MANAGEMENT — IMPLEMENTATION SPECIFICATION COMPLETE — READY FOR IMPLEMENTATION**

**PRODUCTION:**
NOT AUTHORIZED — UNTOUCHED
