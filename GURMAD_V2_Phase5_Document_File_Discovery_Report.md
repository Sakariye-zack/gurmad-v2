# GURMAD V2 — Phase 5: Document & File Management — Discovery Report

**Status:** DISCOVERY ONLY. No code, schema, dependency, or production changes were made during this stage.
**Prepared against:** V2 HEAD `9020fc617a4e2066d019848e39b0c1c02b9c18e2` (Phase 4 FROZEN), legacy `gurmad system/server`.

---

## 1. Executive Summary

V2 does **not** have a centralized document/file management capability. It has **three independent, hand-copied file-upload implementations** (Cashout attachments, Complaint attachments, Company Settings logo), each reimplementing multer configuration, storage-path handling, and authorization from scratch, with small but real inconsistencies between them (see §4). There is no shared `FileUploader` or `DocumentPreview` component, no shared upload service, no shared storage abstraction, and no generic attachment table.

The legacy system has two overlapping, never-reconciled generic file concepts — a rich `documents` table (versioning, e-sign placeholders, category taxonomy) and a flatter `archives` table (simple filenames, no relational links) — both of which **hard-delete the physical file and the database row together**, and both of which are served through a **publicly unauthenticated static mount** (`/api/uploads`, `/uploads`) that the legacy code's own comments flag as a known residual risk. Neither legacy table nor route should be reused as-is; the *concepts* (categorization, versioning, expiry tracking) are useful input to Decisions, but the implementation must be rejected wholesale.

V2's own three existing upload implementations are architecturally sound in isolation (server-generated storage keys, MIME allowlists, size limits, zone-scoped authorized download routes, `logAudit()` reuse) and are the correct pattern to generalize from — **not** the legacy code.

Two schema-only, currently-dead columns (`employees.photo`, `employees.id_document`) exist with no wired upload endpoint — a candidate integration point, not a working feature today.

---

## 2. Current V2 State

Verified via direct source inspection (`Grep`/`Read`), not assumed from names.

| Item | Found? | Detail |
|---|---|---|
| `multer` dependency | Yes | `server/package.json` — already a direct dependency, used independently by 3 route files |
| Cashout attachments | Yes | `server/routes/cashouts.js` — `cashout_attachments` table, disk storage under `server/uploads/cashouts/`, admin-only soft-void delete |
| Complaint attachments | Yes | `server/routes/complaints.js` + `server/routes/customerPortal.js` (shared table/dir) — `complaint_attachments` table, staff- and customer-portal-side upload, **no delete/void route exists at all** |
| Company Settings logo | Yes | `server/routes/settings.js` — single-row `company_settings.logo_storage_path`, replace-on-upload (old file deleted), **intentionally unauthenticated GET** (public branding asset) |
| Generic upload service | **No** | No shared module; each route file defines its own `multer.diskStorage` inline |
| Generic storage abstraction | **No** | All three write directly to `fs`/`multer`; no interface that could later swap to object storage |
| Generic attachment/document table | **No** | Three separate, purpose-specific tables/columns; no shared `documents` or `attachments` table |
| `FileUploader` component | **No** | Not present in `client/src/components/ui/`; each page (`SettingsPage.jsx`, `ComplaintDetailPage.jsx`, `CashoutDetailPage.jsx`) hand-builds its own `<input type="file">` + `FormData` |
| `DocumentPreview` component | **No** | Not present anywhere in `client/src` |
| Shared download endpoint | **No** | Each module has its own `GET .../file` or `GET .../:attachmentId` route with its own auth logic |
| Shared file-authorization layer | **No** | Authorization is re-implemented per route (zone check inline in cashouts/complaints; none needed for the public logo) |
| `employees.photo`, `employees.id_document` | Yes, but dead | Plain `VARCHAR(255)` columns from the Phase-1-era employee schema (`server/db.js:179-180`); **no multer/upload route exists in `routes/employees.js`** — confirmed via grep, zero matches. These are schema-only placeholders today. |

**Conclusion:** nothing to reuse structurally beyond the *pattern* already proven three times independently. There is no existing generic capability to extend.

---

## 3. Legacy Findings

Verified via direct source inspection of `gurmad system/server/index.js` and `schema.sql`.

### 3.1 `documents` table (legacy, rich model)
```
id, title, category, document_type, related_customer_id, related_employee_id,
related_supplier_id, related_truck_id, file_path, status, version,
parent_document_id, created_by, approved_by, approved_at, signed_by, signed_at,
esign_provider, esign_envelope_id, esign_status, expiry_date, created_at
```
- **Ownership model**: four separate nullable FK columns (customer/employee/supplier/truck), not a true polymorphic pattern — adding a fifth related entity means another migration.
- **Versioning**: `version` + `parent_document_id` self-reference exists and is wired (`POST /api/documents/:id/new-version` inserts a new row pointing at the parent).
- **E-signature**: `signed_by`/`signed_at` is a recorded attestation (name + timestamp), not cryptographic; `esign_provider`/`esign_envelope_id`/`esign_status` are reserved, unused columns — no real e-sign provider is wired.
- **Deletion**: `DELETE /api/documents/:id` is a **true hard delete** of the database row. The physical file is never removed by this route (an orphan-creation bug, not a data-loss one), but there is no soft-delete, void, or tombstone concept at all.
- **Access control**: every route is `checkRole(['admin'])` only — no zone scoping, no ownership check, no per-category sensitivity distinction.

### 3.2 `archives` table (legacy, flat model)
```
id, title, category, file_name, file_type, file_size, uploaded_by, created_at, doc_ref, description
```
- No relational link to any business entity at all — a flat "file cabinet" with a free-text `doc_ref`.
- **Deletion**: `DELETE /api/archives/:id` hard-deletes **both** the physical file (`fs.unlinkSync`) **and** the database row, unconditionally, admin-only, no confirmation of business impact, no audit-preserving tombstone.
- Overlaps with `documents` in purpose (both are "upload a file with a title/category") but the two were never reconciled — evidence of exactly the fragmentation Phase 5 must prevent from recurring in V2.

### 3.3 Storage and serving (legacy)
- Single shared `uploads/` directory for images (5MB limit) and a second `uploadDocument` multer instance (PDF/Word/images, 15MB limit) — filenames are server-generated (`timestamp-random.ext`), which is correct and should be preserved as a principle.
- **`app.use('/api/uploads', express.static(uploadDir))` and `app.use('/uploads', express.static(uploadDir))`** — the entire uploads directory is served **without authentication**. The legacy code's own comment (`index.js:1098-1105`) explicitly documents this as a **KNOWN RESIDUAL RISK**: "Filenames are unguessable... but anyone with a filename can still fetch it with no login... Fully closing this... needs a proper signed-URL or authenticated-image-proxy redesign — tracked as follow-up work, not done here." One concretely-proven leak (full DB backups reachable this way) was already fixed by moving backups to a separate, non-served directory — but ID documents, guarantor photos, attendance selfies, and every `documents`/`archives` file remain reachable by anyone who obtains a filename, logged in or not.
- V2 has **already avoided this exact mistake** — confirmed via grep, `server/index.js` has zero `express.static` calls; every V2 file (cashout attachments, complaint attachments, settings logo) is served through an authenticated, per-request-authorized route.

### 3.4 Legacy Reusability Verdict
Nothing in the legacy `documents`/`archives` implementation is safe to port directly. The two schema *concepts* worth carrying into Decisions are: (a) a category/document_type taxonomy, and (b) version/parent-version linkage. Everything else — the public static mount, the hard-delete-on-void behavior, the admin-only-no-zone-scoping RBAC, the unreconciled dual-table split — must be rejected.

---

## 4. Existing File Infrastructure (V2) — Detailed Comparison

The three existing V2 upload implementations, compared side by side, reveal the inconsistency a centralized system must resolve:

| Aspect | Cashout attachments | Complaint attachments | Settings logo |
|---|---|---|---|
| Storage key stored in DB | `req.file.filename` (bare name) | `req.file.path` (**full absolute path**) | `req.file.filename` (bare name) |
| Path reconstruction at read time | `path.join(UPLOAD_DIR, storage_path)` | used directly as-is | `path.join(UPLOAD_DIR, storage_path)` |
| Download mechanism | `res.sendFile` (inline-capable) | `res.download` (forces attachment) | `res.sendFile` with explicit `Content-Type` |
| Zone scoping on download | Yes, via `resolveUserZoneId` | Yes, via `getComplaintDetailForStaff({ zoneId })` | N/A (intentionally public) |
| Delete/void behavior | Soft-void (`voided_at`/`voided_by`/`voided_reason`), admin-only | **No delete/void route exists at all** | Hard-replace (old file `fs.unlink`'d on new upload) — acceptable since it's a single mutable branding asset, not a business record |
| MIME allowlist | PDF, JPEG, JPG, PNG | PDF, JPEG, JPG, PNG | PNG, JPEG, JPG only (SVG explicitly excluded — documented XSS concern) |
| Size limit | 10MB | 10MB (client complaint) | 2MB |
| Audit | `logAudit()` on upload; `storage_path` explicitly redacted from the audit payload | **No audit call on upload at all** | `logAudit()` on replace |

**Finding**: the `storage_path` shape inconsistency (bare filename vs. full absolute path) between Cashouts/Settings and Complaints is a real latent bug risk if the `UPLOAD_DIR` base ever changes or the app is moved to a different filesystem layout — the Complaints table would break silently (stale absolute paths) while the other two would not. This is exactly the class of problem a shared storage abstraction (§6) prevents.

---

## 5. Reuse / Adapt / Redesign / Reject Matrix

| Existing asset | Verdict | Why |
|---|---|---|
| `multer` dependency | **REUSE** | Already a direct dependency, proven three times, no new dependency needed |
| Server-generated storage-key filename pattern (`Date.now()-random.ext`) | **REUSE** | Correct, already prevents path traversal / client-controlled filenames; identical pattern in all 3 V2 modules |
| Cashouts' soft-void attachment pattern (`voided_at`/`voided_by`/`voided_reason`) | **ADAPT** | Best of the three existing patterns; generalize into the candidate `document_versions`/`documents` lifecycle (§7) |
| Cashouts' zone-scoped authorized download route | **ADAPT** | Correct shape (authenticate → load parent → zone-check → stream); generalize into one shared download handler pattern |
| Settings' MIME-allowlist-with-documented-exclusions comment style | **ADAPT** | Good security-reasoning discipline; carry forward for the new shared file-type policy (§9 in Decisions) |
| Complaints' `storage_path = req.file.path` (full path) convention | **REJECT** | Inconsistent with the other two modules and fragile if `UPLOAD_DIR` ever moves; standardize on bare filename + computed base path |
| Complaints' missing delete/void + missing audit-on-upload | **REJECT** | Gaps to close, not preserve, in the new design |
| Legacy `documents` table (schema) | **REJECT the implementation; ADAPT the category/version concepts only** | See §3.4 |
| Legacy `archives` table | **REJECT** | Fully superseded concept; hard-deletes files+rows together, no relational integrity |
| Legacy public static `/api/uploads` mount | **REJECT — do not reproduce under any circumstance** | Explicitly documented by legacy's own authors as a known, unresolved security risk |
| Legacy admin-only-no-zone-scoping file RBAC | **REJECT** | V2 already has a proven per-module zone-scoping pattern; reuse that, not legacy's flat model |
| A shared `FileUploader`/`DocumentPreview` frontend component | **DOES NOT EXIST — must be newly built** | Confirmed absent from `client/src/components/ui/` |
| A shared upload/storage service | **DOES NOT EXIST — must be newly built** | Confirmed absent server-side |
| `employees.photo`/`employees.id_document` columns | **REDESIGN CANDIDATE (Future CR)** | Currently dead schema; a natural first consumer of the new system, but Employees is a CLOSED module — any wiring requires a separately authorized narrow exception, exactly like Phase 4's Procurement touch |

---

## 6. Storage Architecture Findings

Options evaluated:

| Option | Dev-environment fit | Production fit | Notes |
|---|---|---|---|
| Local filesystem (current V2 pattern) | **Good** — zero new infra, already proven 3×, works with existing `fs`/`multer` code | **Poor in isolation** — no redundancy, doesn't survive a host rebuild/redeploy on typical PaaS, complicates horizontal scaling (multiple app instances need shared storage) | Correct for now; must not be assumed sufficient once real production infrastructure exists |
| Database BLOB storage | Possible but not recommended | Possible but not recommended | Bloats `pg_dump`/backup size, no benefit over object storage, complicates streaming; no existing V2 precedent for this |
| S3-compatible / managed object storage (S3, R2, Spaces, Supabase Storage, etc.) | Requires credentials/local emulation (e.g., MinIO) not currently present | **Best long-term fit** — durable, horizontally scalable, supports signed URLs natively, decouples app servers from binary storage | No credentials, SDK, or bucket currently provisioned in this environment — this is a genuine Production Infrastructure dependency, not something Phase 5 can wire up today |

**Recommendation carried to Decisions (not decided here):** build the storage-abstraction interface (§15) against local filesystem now — matching every existing V2 precedent — but design the interface's method signatures (`put`, `get`, `getSignedUrl`/stream, `delete`) so a future object-storage backend can be swapped in without touching calling code. This mirrors exactly how Phase 4 designed the ledger-balance architecture: correct now, extensible later, no premature infrastructure dependency.

**Backup/restore separation (see §20):** whichever storage is chosen, `pg_dump` alone never captures file binaries stored outside PostgreSQL. This must be flagged to the Production Infrastructure workstream explicitly, not assumed handled.

---

## 7. Security Findings

| Concern | Legacy | V2 (existing 3 modules) | Phase 5 requirement |
|---|---|---|---|
| Authentication on file download | **None** (public static mount) | Yes, all 3 modules | Mandatory, no exception |
| Authorization / zone isolation | None (`admin`-only, no zone) | Yes, zone-scoped in 2 of 3 (logo intentionally public) | Server-side, inherited from parent entity — cannot be client-supplied |
| Filename sanitization | Server-generated names (good) | Server-generated names (good) | Preserve — never use client filename as a storage path |
| MIME/extension validation | Partial (image-only or image+PDF+Word by mimetype only, no extension cross-check) | MIME allowlist per module, no extension cross-check either | Needs an explicit decision: MIME-only vs. MIME+extension+magic-byte sniffing (Decisions item) |
| Executable/script upload risk | Not explicitly blocked beyond MIME allowlist | Not explicitly blocked beyond MIME allowlist; Settings explicitly excludes SVG (XSS vector) | Explicit reject list needed: `.svg`, `.html`, `.js`, `.exe`, `.sh`, `.bat`, archive formats pending a size/zip-bomb decision |
| Path traversal | Mitigated by server-generated filenames | Mitigated by server-generated filenames | Preserve; never construct a path from `req.body`/`req.params`/`req.file.originalname` |
| IDOR on file ID | Not applicable (public mount bypasses IDs entirely) | Protected — every download route re-checks parent-entity zone/ownership before streaming | Mandatory pattern for every new endpoint |
| Predictable storage keys | `timestamp-random.ext` — not predictable | Same | Preserve |
| Public URLs | **Yes, for everything** (legacy) | Only for the one deliberately-public logo | Default private; public only for an explicitly whitelisted category (branding-style assets), never business documents |
| Audit logging on upload | None (legacy); 2 of 3 V2 modules | Partial (Cashouts yes, Complaints no) | Mandatory on upload, and — new requirement per this authorization — on download/preview too |
| Virus/malware scanning | None anywhere | None anywhere | Not currently implemented; must be an explicit Decision (now vs. Future CR), not a silent gap |

**Explicit answer to "should uploaded files ever be publicly accessible?"**: No, as a default. The one legitimate exception already proven in V2 (company logo) is a narrow, deliberate carve-out for a single non-sensitive branding asset with no business-confidentiality concern — not a precedent for documents in general. Hiding a URL (unguessable filename) is not security on its own, as legacy's own postmortem comment concedes; V2's existing pattern of authenticating and re-checking authorization on every stream is the correct baseline and must not be weakened for convenience (e.g., to support a plain `<img src>` tag, which cannot send an Authorization header — this exact tension is what led legacy into its public-mount mistake, and Phase 5 must not repeat it silently).

---

## 8. Ownership / Module Integration

| Module | Attachments plausible? | Who uploads (candidate) | Who views (candidate) | Zone scope? | REQUIRED NOW or FUTURE CR |
|---|---|---|---|---|---|
| Employees / HR | Yes (ID documents, contracts) | Admin | Admin (sensitive — already flagged `SENSITIVE_FIELDS` in `employees.js`) | No (company-wide role) | **FUTURE CR** — Employees is CLOSED; needs a separately authorized narrow exception exactly like Phase 4's Procurement touch |
| Procurement | Plausible (supplier contracts, PO backup docs) | Admin/Gudoomiye | Same as Procurement's existing VIEW_ROLES | Yes, existing zone model | **FUTURE CR** — Procurement is CLOSED |
| Inventory | Plausible (item spec sheets) | Admin | VIEW_ROLES | No (items are company-wide) | **FUTURE CR** — Phase 4 is CLOSED/FROZEN |
| Assets | Plausible (warranty/purchase docs) | Admin | VIEW_ROLES | Zone-aware per asset | **FUTURE CR** — Phase 4 is CLOSED/FROZEN |
| Complaints | **Already exists** (own implementation) | Staff (management roles) + customer portal | VIEW_ROLES, zone-scoped | Yes | Existing — a candidate future migration onto the centralized system, not new scope |
| Cashout / signed documents | **Already exists** (own implementation, most mature pattern) | VIEW_ROLES | VIEW_ROLES, zone-scoped | Yes | Existing — candidate future migration, not new scope |
| Customers | Plausible (signed service agreements) | Admin/Gudoomiye | Same as Customers' existing roles | Yes | **FUTURE CR** |
| Suppliers | Plausible (contracts, certifications) | Admin | Procurement VIEW_ROLES | No | **FUTURE CR** |
| Contracts (generic) | Overlaps with several of the above | — | — | — | Not a distinct module; a document *category*, not a new integration point |
| Reports | Not a document-attachment consumer; reports are generated, not uploaded | — | — | — | Out of scope for Phase 5 entirely |

**REQUIRED NOW (for a meaningful Phase 5 MVP):** the centralized infrastructure itself (storage abstraction, generic document/attachment tables, upload/download/preview endpoints, RBAC/zone inheritance pattern, audit) — with **zero new integration into any existing frozen module**, mirroring exactly how Phase 4 was scoped against Phase 3 (one narrow, explicitly-authorized touch, not a blanket rewrite). Every module integration listed above is a **FUTURE CR**, to be authorized and scoped individually, the same discipline already established across Phases 1-4.

---

## 9. Document Lifecycle Findings

Legacy offers no usable lifecycle (hard delete only). V2's own Cashout pattern (`voided_at`/`voided_by`/`voided_reason`, no hard delete) is the only existing precedent, and it is the right one to generalize.

Candidate lifecycle states for Decisions to resolve: `uploaded` → `active` → `archived`/`voided`. `replaced` (superseded by a new version) is a distinct transition from `voided` (withdrawn without replacement) and should not be conflated.

**Recommendation direction (not a decision):** immutable metadata rows, soft-delete/void only (tombstone, `voided_at`/`voided_by`/`voided_reason` pattern already proven), binary deletion (if ever performed) handled as a separate, deliberately-slower cleanup process — never synchronous with the void action — so a mistaken void can still recover the binary before physical cleanup runs. Historical business records (an approved PO, a signed cashout form) must never silently lose their supporting document.

---

## 10. Versioning Findings

Legacy has a working `version`/`parent_document_id` model. None of V2's three existing implementations have any versioning concept at all (Cashouts/Complaints/Settings are all single-file, replace-or-void only).

**Genuinely unresolved for Decisions:** does Phase 5 MVP need multi-version history, or is "void old, upload new, link via a `replaces_document_id` pointer" (simpler, no version-number sequencing) sufficient? Legacy's `version` INTEGER counter is one option; a simpler linked-list-via-FK (no counter) is another. **If deferred, this is a Future CR — not a silent omission.**

---

## 11. File Type Findings

| Category | Existing V2 precedent | Legacy precedent | Risk if allowed unrestricted |
|---|---|---|---|
| PDF | Yes (Cashouts, Complaints) | Yes | Low — universally treated as inert by browsers |
| DOC/DOCX | No V2 precedent | Yes (legacy `uploadDocument`) | Low, but macro-enabled `.docm` should be excluded if extension-checked |
| XLS/XLSX | No precedent either system | No | Low, same macro caveat |
| CSV | No precedent either system | No | Low, but CSV-injection into spreadsheet apps is a known secondary risk if ever auto-opened |
| JPG/JPEG, PNG | Yes (all 3 V2 modules) | Yes | Low |
| WEBP | No precedent either system | No | Low |
| SVG | **Explicitly excluded** in Settings with a documented reason (can embed executable script — XSS vector) | Not explicitly excluded | **Reject** — carry Settings' own precedent forward |
| HTML, JS, executables (.exe/.sh/.bat), raw archives (.zip/.rar) | Never allowed anywhere | Never allowed anywhere | **Reject** — no legitimate document-management use case, meaningful malware/XSS/zip-bomb risk |

**Unsupported-format handling:** every existing V2 `fileFilter` silently rejects (multer calls back `false`, no file written) and the calling route returns a 400. This is the correct, provable pattern to keep.

---

## 12. File Size Findings

| Module | Existing limit | Rationale given in code |
|---|---|---|
| Cashouts | 10MB | "signed slips/photos, not a general DMS" |
| Complaints | 10MB | (implicit, same order of magnitude) |
| Settings logo | 2MB | "a logo is a small image, not a document" |

No single limit fits every category — a scanned multi-page PDF contract is legitimately larger than a phone photo. **Genuinely unresolved for Decisions:** a per-category limit table (e.g., images capped lower than PDF/DOCX) versus one flat limit. Server-side `multer.limits.fileSize` is confirmed authoritative in every existing implementation (client-side checks, where present, are UX-only) — this must remain the case; client validation is never trusted alone.

---

## 13. Download / Preview Findings

Both existing zone-scoped modules (Cashouts, Complaints) follow: `authenticateToken` → `requireRole` → load parent entity → zone/ownership check → stream file. Cashouts uses `res.sendFile` (browser decides inline vs. download based on `Content-Type`); Complaints uses `res.download` (always forces a download, never inline preview); Settings sets an explicit `Content-Type` header and uses `res.sendFile` for genuine inline display (a logo `<img>` tag).

**Genuinely unresolved for Decisions:** should Phase 5 standardize on always-inline-capable (`Content-Type` + optional `Content-Disposition: inline` vs `attachment` by caller intent, e.g. a `?download=1` query flag) rather than the current mixed `sendFile`/`download` split? Range-request support (for large PDFs / video, if ever needed) is not implemented anywhere today and should be scoped as MVP-in or Future-CR explicitly, not assumed.

---

## 14. Audit Findings

V2's `logAudit()` (`server/db.js:1520`, writing to `v2_audit_log`) is the established, single audit mechanism used across every phase of this program (HR, Fleet, Procurement, Inventory & Assets). Cashouts already calls it on upload (with `storage_path` deliberately redacted from the logged payload — a good precedent to keep, since a storage key is not itself sensitive business data but also has no audit value). Complaints does **not** call it on upload at all — a real gap in the existing code, not something to copy forward.

**Recommendation direction:** reuse `logAudit()` exclusively; do not build a second audit system. At minimum, audit upload, metadata change, archive/void, and — a new requirement introduced by this Discovery's own explicit instruction — download/preview access, which none of the three existing modules currently log.

---

## 15. RBAC / Zone Findings

No new role is implied by anything found. File access should **inherit from the parent business entity's own existing authorization**, exactly as Cashouts and Complaints already do (re-resolve the parent's zone, re-check access, on every single file-touching request — never cache or trust a prior check). For the centralized infrastructure's *own* entities (if a generic `documents` table exists independent of a parent — see §16), a separate, simpler question applies: who may see/upload a document not yet linked to any business entity. This needs a Decisions-stage answer.

Collector: no existing V2 file feature grants Collector access to anything, and nothing found in Discovery suggests a need to change that. Customer Portal users already have a working, narrower file precedent (`customerPortal.js`'s complaint-photo upload, using its own `authenticateCustomerPortal` — a different auth boundary from staff, already correctly separated) — any centralized system must preserve, not merge, that boundary.

---

## 16. Candidate Data Model

**Provisional names only — nothing here is committed.**

| Candidate entity | Purpose | Key fields (draft) | Immutable? | Delete behavior | Required now / Future CR |
|---|---|---|---|---|---|
| `file_objects` (or similar) | One row per physical binary stored — the storage-abstraction layer's own bookkeeping (storage key, mime type, size, checksum) | `id, storage_key, original_filename, mime_type, file_size, checksum, created_by, created_at` | Yes, once written | Tombstone only; physical cleanup is a separate deferred process | Required now — this is the core of "centralized infrastructure" |
| `documents` (or similar) | The business-facing record: title, category, current version pointer | `id, title, category, document_type, current_file_object_id, status, created_by, created_at, updated_at` | Metadata mutable (title/category), file linkage append-only | Soft-void (`voided_at/by/reason`), never hard delete | Required now |
| `document_versions` (or similar) | If versioning is decided IN (not assumed) — one row per version, pointing at a `file_objects` row | `id, document_id, file_object_id, version_number, created_by, created_at` | Fully immutable once created | Never deleted; superseding is a new row, not a mutation | **Only if Decisions locks versioning IN — otherwise Future CR (§10)** |
| `document_attachments` (or similar) | The polymorphic-or-not link between a `documents` row and a business entity | `id, document_id, entity_type, entity_id, zone_id (denormalized for query performance, server-set only), created_by, created_at` | Fully immutable | Soft-void, mirrors parent lifecycle | Required now, but **populated by zero modules at launch** — no integration until a Future CR authorizes one |
| `document_categories` | Optional lookup/taxonomy table, or simply a `CHECK` constraint list like every other V2 enum | `id, key, label` OR just a CHECK constraint | N/A | N/A | **Deferred candidate** — every other V2 enum (movement types, asset statuses, etc.) uses a plain CHECK constraint, not a lookup table; the same precedent likely applies here pending Decisions §9 (this report's) equivalent in the Decisions document |

**Explicitly avoided:** a single denormalized "one table with an entity_type + entity_id column and every possible field" mega-table. Splitting binary/storage bookkeping (`file_objects`) from the business-facing record (`documents`) from the relational link (`document_attachments`) mirrors the same separation-of-concerns discipline already used in Phase 4 (ledger movements vs. items vs. stores) and Phase 3 (POs vs. receipts vs. receipt items).

---

## 17. Candidate API Surface

**Candidates only — none implemented.**

| Candidate endpoint | Actor | AuthZ | Input | Output | Security risk to design against |
|---|---|---|---|---|---|
| `POST /v2/documents` (upload) | Whoever a Decisions-stage role list permits | `authenticateToken` + role check; zone resolved server-side if attaching to a zone-scoped entity | multipart file + metadata (title, category, optional entity link) | Created document record (never the raw storage key) | Oversized/wrong-MIME upload; must reject before any disk write, same as existing `fileFilter` pattern |
| `GET /v2/documents` (list) | View-permitted roles | Zone-scoped, same pattern as every other V2 list route | Filters (category, entity, date, uploader) | Metadata list, never a direct storage path | Must never leak another zone's documents via filter manipulation (IDOR) |
| `GET /v2/documents/:id` (detail) | View-permitted roles | Re-check zone/ownership on every call | — | Metadata + version history (if any) | Same IDOR class as list |
| `GET /v2/documents/:id/file` (download/preview) | View-permitted roles | Re-check zone/ownership; stream via storage abstraction, never a static mount | Optional `?download=1` intent flag (Decisions §13-equivalent) | Binary stream with correct `Content-Type`/`Content-Disposition` | The single highest-risk endpoint — must never become a public/static path, must never trust a client-supplied path |
| `PUT /v2/documents/:id` (metadata update) | Owner or admin-tier role | Same zone/ownership check | Title/category/entity-link changes only — never the binary | Updated record | Mass-assignment: client must never set `storage_key`, `created_by`, `voided_*`, or resulting entity link directly |
| `POST /v2/documents/:id/versions` (new version) | Same as upload | Same | New file replacing/superseding current | New version record, old version preserved | Must not silently orphan or delete the prior version's binary |
| `PUT /v2/documents/:id/void` (archive/void) | Admin-tier, self-void blocked (mirrors Phase 3/4's self-approval-block precedent) | Same | Reason (required, mirrors Cashouts' pattern) | Voided record | Must never be a hard delete |
| `POST /v2/documents/:id/attach` (link to entity) | Module-appropriate role | Zone/entity-existence check | `entity_type`, `entity_id` | Attachment record | Cross-zone/cross-entity linkage must be blocked exactly like every other IDOR check in this program |

---

## 18. Candidate Frontend Surface

**Candidates only — no pages created.**

- Documents list page (filterable by category/entity/date)
- Document detail page (metadata + version history + linked entity)
- Upload modal (reusable across any future integration point)
- A generic "Attachment panel" component — embeddable inside a future module's own detail page (e.g., a future PO detail page could embed it), **without** modifying that module's own page during Phase 5 itself
- Preview modal (image/PDF inline; other types fall back to forced download)
- No Sidebar/navigation change — same "direct-URL-only, Future CR for nav" precedent as Phase 4

---

## 19. Search / Reporting Findings

**Search:** the existing V2 Search module was not modified nor inspected for write access during this Discovery (per the explicit instruction). Document search (filename/title/category/entity/uploader/date) is a plausible Phase 5 need, but whether it belongs inside Phase 5's own list endpoint (simple filter params, the pattern every other V2 list route already uses) or requires integration with a separate, more powerful Search module is a genuinely unresolved question for Decisions — leaning toward the former (simple filters) by precedent, since no other V2 module has needed the latter.

**Reporting:** no dedicated document report exists anywhere today. A minimal candidate set (document count by category, uploads by period) is plausible but not evidenced as a current business need by anything found in Discovery. Recommend deferring full reporting to a Future CR unless Decisions identifies a specific driver.

---

## 20. Backup / Recovery Considerations

**Critical dependency for the Production Infrastructure workstream, not resolvable in Phase 5 alone:** if Phase 5 stores binaries on local disk (the only option available in this environment today, per §6), a PostgreSQL backup (`pg_dump`) captures the `documents`/`file_objects` **metadata only** — it does not capture the binaries themselves. A metadata row pointing at a since-lost file is strictly worse than no record at all (it creates false confidence that a document exists). This exact risk already exists silently for Cashout/Complaint attachments today and is not new to Phase 5 — but Phase 5 is the first point where it should be formally documented and flagged upstream, since a centralized system makes the dependency count larger, not smaller.

Any future production deployment **must** provision either (a) durable, backed-up block storage for the upload directory, or (b) object storage (§6) with its own retention/versioning, before this system holds records anyone depends on. This is flagged as a **Production Infrastructure prerequisite**, not a Phase 5 implementation task.

---

## 21. Architectural Boundary — A vs. B

**Option A** (centralized infrastructure only, no document-management entities — i.e., just a shared storage/upload/download service other modules call directly, each still owning its own attachment table) was evaluated and **not recommended**: it would perpetuate exactly the fragmentation found in §4 (three incompatible `storage_path` conventions) — a shared *service* without a shared *data model* still lets each future module invent its own metadata shape.

**Option B** (centralized infrastructure **plus** document-management entities — `file_objects`/`documents`/`document_attachments` per §16) is the direction Discovery supports, because it is the only option that actually stops "every module inventing its own file storage mechanism," which this authorization explicitly named as the risk to avoid. This is a recommendation for Decisions to formally lock, not a decision made here.

---

## 22. Business Questions (Unresolved — for Decisions, not answered here)

1. Is centralized document management required now, or is generalizing the existing 3-module pattern suffient for the foreseeable future?
2. Which modules need attachments in MVP? (Discovery's answer: **none** — infrastructure only, zero integration, per §8)
3. Who can upload? (No universal answer — varies by eventual integration; needs a default for documents with no parent entity)
4. Who can view? Same caveat.
5. Who can download? Same caveat — likely same as view, but not necessarily (a Decisions call).
6. Who can archive/void? Legacy precedent says admin-only; V2's Cashouts precedent says admin-only too — but is this appropriate for every future document category?
7. Are files immutable? Discovery recommends yes for the binary once written; metadata (title/category) mutable.
8. Is versioning required in MVP, or Future CR? (§10 — genuinely open)
9. Are public links ever allowed? Discovery recommends: only for an explicitly whitelisted non-sensitive category (mirroring the logo precedent), never as a default.
10. What file types are allowed? §11 gives a starting list; final list is a Decisions call.
11. What size limits apply, and are they per-category or flat? §12 — open.
12. What storage model — local filesystem now, with what abstraction for later? §6 — direction given, not decided.
13. Is zone inheritance required for documents with no parent entity (i.e., a "company-wide" document with no zone owner)?
14. What documents are considered sensitive, and does that change access rules (mirrors `employees.js`'s existing `SENSITIVE_FIELDS` precedent)?
15. How long are files retained? No V2 or legacy precedent gives a retention period today.
16. What happens to a document when its parent entity is archived/deleted? (Parent entities in this program are themselves almost never hard-deleted — RESTRICT is the universal FK pattern — so this may resolve itself, but needs an explicit Decision.)
17. Are downloads audited, not just uploads? Discovery recommends yes (§14) — a new requirement beyond current practice.
18. Is inline preview required in MVP, or is forced-download-only acceptable initially?
19. Is virus/malware scanning required now, or Future CR? No current V2 or legacy precedent implements this at all — Discovery flags it as a real, currently-unaddressed risk (§26) but does not assume an answer.
20. What happens to orphaned files (a `file_objects` row whose only referencing `documents` row was voided, or a disk file whose DB row insert failed mid-transaction)? No existing V2 precedent handles this today (confirmed: none of the 3 existing modules has an orphan-sweep process).
21. Is document search required in Phase 5, or Future CR? §19 — leaning toward simple filters in MVP, not decided.
22. Are attachments for frozen modules (Employees, Procurement, Inventory, Assets) in scope for Phase 5 itself, or exclusively Future CRs? Discovery's recommendation: **exclusively Future CRs** — mirrors this program's own established discipline of never bundling a new phase's scope with a prior frozen phase's integration.
23. Is Customer Portal document access required in MVP? The Portal already has its own complaint-photo upload; extending Portal access to the new centralized system (vs. leaving Portal's existing narrow feature alone) is unresolved.
24. Is signed-document handling (cryptographic e-signature, not just the "signed_by name + date" attestation legacy has) part of MVP? No V2 precedent exists; legacy's own `esign_provider`/`esign_envelope_id` columns are unused placeholders, not a working feature — Discovery recommends treating real e-signature integration as clearly out of MVP scope pending explicit demand.
25. *(Additional, found during Discovery)* Should the new system formally migrate Cashout/Complaint attachments onto itself, or coexist indefinitely? Migrating existing, already-QA'd, already-frozen-adjacent modules is itself a CLOSED-module-touching change requiring its own separate authorization — Discovery recommends coexistence unless a Decisions-stage business driver says otherwise.
26. *(Additional)* Should `employees.photo`/`employees.id_document` be wired to the new system as the first real integration, given they are already schema-present but functionally dead? This is attractive precisely because it requires zero new columns on the CLOSED Employees table — but it is still a touch to a CLOSED module and must go through the same Future-CR authorization discipline as any other integration, not be treated as "free" because the columns already exist.

---

## 23. Architectural Decisions (to resolve in the Decisions stage — not decided here)

- Option A vs. B (§21) — Discovery recommends B, formal lock is a Decisions action.
- Data model shape (§16) — three-table split recommended, names/exact columns to be locked.
- Storage backend for now vs. abstraction shape for later (§6).
- Versioning: in MVP or Future CR (§10).
- Download/preview mechanism standardization: `Content-Disposition` intent flag vs. mixed `sendFile`/`download` (§13).

## Business Decisions (to resolve in the Decisions stage)

- Which roles may upload/view/download/void documents with no parent entity.
- File type allowlist, final.
- Size limits, flat vs. per-category.
- Retention period, if any.
- Whether public (unauthenticated) links are ever permitted beyond the existing logo precedent.

## Security Decisions (to resolve in the Decisions stage)

- MIME-only vs. MIME+extension+content-sniffing validation.
- Virus/malware scanning: now or Future CR.
- Audit scope: upload+void only (current practice) vs. upload+download+preview+void (Discovery's recommendation).
- Orphan-file sweep: required in MVP or Future CR.

## Future CR Candidates (explicitly not in Phase 5 MVP per this Discovery)

- Every per-module integration in §8's table (Employees, Procurement, Inventory, Assets, Customers, Suppliers).
- Migrating Cashout/Complaint attachments onto the new centralized system.
- Real cryptographic e-signature provider integration.
- Document search beyond simple list-endpoint filters.
- Document reporting/analytics.
- Object-storage backend migration.
- Range-request/streaming support for large files.
- Virus/malware scanning (if not pulled into MVP by Decisions).

---

## 24. Risks (ranked)

1. **Reproducing legacy's public-static-file mistake** — highest risk if a future integration (e.g., needing a plain `<img src>` for a document thumbnail) tempts a shortcut. V2 has so far correctly avoided this; Phase 5 must not be the phase that reintroduces it.
2. **Cross-zone/IDOR leakage on the download endpoint** — the single highest-consequence endpoint in the whole feature; every existing V2 precedent gets this right, but it must be re-verified on every new endpoint, not assumed inherited.
3. **Orphaned binaries / backup mismatch** — no current V2 or legacy precedent solves this; flagged to Production Infrastructure (§20) and as a Decisions item (§23).
4. **Malicious upload (executable/script/zip-bomb)** — partially mitigated by MIME allowlisting in all 3 existing modules, but no extension/content-sniffing cross-check and no virus scanning anywhere today.
5. **Storage-path convention drift** (§4's finding) — a real, already-existing inconsistency between Complaints and the other two modules; a centralized system must not add a fourth convention on top.
6. **Large-file performance** — not yet exercised at any real scale in this codebase; deferred until a concrete need is demonstrated (no premature optimization, per this authorization's own instruction).
7. **Frozen-module integration risk** — mitigated entirely by this Discovery's own recommendation to keep every integration as a separately authorized Future CR, exactly mirroring the one narrow, disclosed exception already proven safe in Phase 4.
8. **Legacy migration risk** — not attempted in Phase 5's scope; legacy's `documents`/`archives` data, if ever migrated, would need its own dedicated, separately authorized effort (schema mismatch, hard-delete history already lost, no zone data on old rows).

---

## 25. Git / Safety Verification

- Starting HEAD: `9020fc617a4e2066d019848e39b0c1c02b9c18e2` (confirmed via `git log -1`)
- Branch: `main` (confirmed via `git branch --show-current`)
- Working tree: clean at start and remains clean — this report is the only file created during this stage
- Zero implementation changes: confirmed — no route, schema, or frontend file touched
- Zero schema changes: confirmed — no migration written, no `CREATE TABLE`/`ALTER TABLE` executed
- Zero dependency changes: confirmed — `multer` already present, nothing added to `package.json`
- Zero production changes: confirmed — no deployment, migration, or infrastructure action taken

---

## 26. Recommendation

Proceed to the Decisions stage with the following direction (not binding until formally locked in the Decisions document):
- Architectural Boundary: **Option B** (centralized infrastructure + document-management entities), per §21.
- Data model: the three-table split in §16 (`file_objects` / `documents` / `document_attachments`), names TBD.
- Storage: local filesystem now, behind a swappable abstraction, per §6.
- Scope: infrastructure only in Phase 5 MVP — **zero integration into any existing module**, every module touch deferred to its own Future CR, mirroring this program's own established discipline.
- Security baseline: inherit every hardening lesson already proven in Cashouts/Complaints/Settings; never reproduce legacy's public-static-mount mistake under any circumstance.

## 27. Final Status

**PHASE 5 — DOCUMENT & FILE MANAGEMENT — DISCOVERY COMPLETE — READY FOR DECISIONS**

Production:
NOT AUTHORIZED — UNTOUCHED
