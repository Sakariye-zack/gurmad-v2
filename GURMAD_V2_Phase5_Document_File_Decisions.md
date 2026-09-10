# GURMAD V2 — Phase 5: Document & File Management — Decisions

**Status:** DECISIONS ONLY. No code, schema, dependency, or production changes were made during this stage.
**Baseline:** V2 HEAD `9020fc617a4e2066d019848e39b0c1c02b9c18e2` (Phase 4 FROZEN), built directly on `GURMAD_V2_Phase5_Document_File_Discovery_Report.md`.

---

## 1. Executive Summary

Phase 5 MVP is **centralized file infrastructure + document entities (Option B)**, scoped to **zero integration with any existing module**. It generalizes the one proven pattern already exercised three times in V2 (server-generated storage keys, MIME allowlisting, authenticated per-request-authorized streaming, `logAudit()` reuse) into one shared service and one small, purpose-built data model (`file_objects` / `documents` / `document_attachments`). Storage is local filesystem for now, behind a swappable interface. Versioning, search, reporting, virus scanning, legacy migration, and every module integration are explicitly deferred as Future CRs. No question from Discovery was skipped; every one is marked LOCKED or DEFERRED below with its reasoning.

---

## 2. Locked Business Decisions

| # | Decision | Status |
|---|---|---|
| B1 | Centralized document management is required — generalize the proven pattern rather than let a fourth module invent its own. | **LOCKED** |
| B2 | Zero existing modules receive attachments in Phase 5 MVP. Every module integration is a Future CR. | **LOCKED** |
| B3 | Upload is permitted only for `admin` and `gudoomiye` in MVP (mirrors Inventory & Assets' `OPERATE_ROLES` precedent — the two roles that create/operate business records elsewhere in V2). | **LOCKED** |
| B4 | View metadata / download / preview is permitted for `admin`, `gudoomiye`, `zone_accountant`, `head_of_cashiers`, `cashier` (mirrors the existing company-wide `VIEW_ROLES` pattern used in Procurement/Inventory). `collector` has zero access, identical to every other back-office module. | **LOCKED** |
| B5 | Archive/void is `admin`-only (mirrors Cashouts' existing precedent — the most mature of the three existing implementations). | **LOCKED** |
| B6 | Restore (un-void) is `admin`-only, and is a new capability none of the three existing modules has — included because Phase 5's own void is designed to be recoverable, unlike legacy's hard delete. | **LOCKED** |
| B7 | Permanent physical deletion of a document's binary is never performed synchronously with any user action. See §7 (Delete/Archive Policy) and §23 (Orphan Handling). | **LOCKED** |
| B8 | Documents with no linked business entity are permitted (a "company-wide, unattached" document is a valid state, not an error) — this is required for Option B's own standalone-document use case (§4 Ownership Model). | **LOCKED** |
| B9 | Zone model for standalone documents: a document may optionally carry its own `zone_id` (nullable — `NULL` means company-wide), independent of any future attachment's inherited zone. See §17. | **LOCKED** |
| B10 | Retention period: **not defined in MVP.** No legal or organizational retention policy was identified in Discovery, and inventing one would be exactly the kind of silent assumption this program's standing rules forbid. | **DEFERRED / FUTURE CR** — depends on a legal/compliance input this Discovery/Decisions pass has no authority to supply. |
| B11 | Customer Portal document access: not part of MVP. The Portal's own existing complaint-photo upload is untouched and unrelated. | **DEFERRED / FUTURE CR** — see §19. |
| B12 | Legacy document/archive migration: not performed in MVP. | **DEFERRED / FUTURE CR** — see §28. |

---

## 3. Locked Architecture Decisions

| # | Decision | Status |
|---|---|---|
| A1 | **Option B locked**: centralized infrastructure + document entities (`file_objects` / `documents` / `document_attachments`). Rejected Option A (infrastructure-only) because it does not stop future modules from re-inventing metadata shape, which is the exact fragmentation Discovery found already exists between Cashouts/Complaints/Settings. | **LOCKED** |
| A2 | Storage backend for MVP: **local filesystem**, matching every existing V2 precedent, behind a small storage-abstraction interface (`put`/`get`/`delete`/`stream`) so a future object-storage backend can be swapped in without touching calling code. No object-storage credentials or infrastructure exist in this environment today. | **LOCKED (dev/current), DEFERRED (production backend)** — see §5. |
| A3 | No new dependency. `multer` is already present and sufficient for MVP (local disk, multipart handling). | **LOCKED** |
| A4 | No polymorphic free-text `entity_type` column. Attachment linkage uses a **constrained enum** of known entity types (even though zero are wired in MVP) rather than an unconstrained string, so a future Future-CR integration cannot silently typo a new entity type into existence without a migration. See §4. | **LOCKED** |
| A5 | Versioning: **deferred**. MVP is one-current-file-per-document with void-and-replace (a new document record superseding an old one via an explicit `replaces_document_id` pointer), not a version-number/parent-chain model. | **LOCKED (MVP shape) / DEFERRED (full version history) — FUTURE CR: DOCUMENT VERSIONING** — see §8. |
| A6 | Reuse `logAudit()` exclusively. No second audit system. | **LOCKED** |
| A7 | No modification to Search, Reports, Sidebar/AppShell, or any CLOSED module's own routes/schema. | **LOCKED** |

---

## 4. Locked Security Decisions

| # | Decision | Status |
|---|---|---|
| S1 | Files are **private by default**. No public/unauthenticated static mount, ever — this is the single most important decision carried forward from Discovery's legacy findings and is treated as non-negotiable. | **LOCKED** |
| S2 | Every file-serving request goes through an authenticated, per-request-authorized route (`authenticateToken` → `requireRole` → resource existence → zone/ownership check → stream) — no exception, no shortcut for a plain `<img src>` tag. If a future consumer needs inline `<img>` display, it must be solved with an authenticated fetch-and-blob-URL pattern on the frontend, never a public route. | **LOCKED** |
| S3 | Storage keys are server-generated only (`timestamp-random.ext` pattern, identical to all three existing V2 modules). The client-supplied original filename is stored for display only and is never used to construct a filesystem path. | **LOCKED** |
| S4 | MIME-allowlist validation at upload time, identical mechanism to the three existing modules (`fileFilter` rejects before any disk write). Extension is cross-checked against the same allowlist (defense in depth against a mismatched MIME/extension pair) — a **new** requirement beyond current V2 practice, closing a gap Discovery identified. | **LOCKED** |
| S5 | Content-sniffing (magic-byte verification) is **not** implemented in MVP — Discovery correctly flagged that extension/MIME checking alone is not fully sufficient, but adding a content-sniffing library is a new dependency decision this stage is not authorized to make unilaterally (no dependency additions permitted in Decisions). | **DEFERRED / FUTURE CR** — requires a dependency-addition authorization in Implementation Specification stage. |
| S6 | Virus/malware scanning: **not MVP**. No existing V2 or legacy precedent implements this, and no antivirus/scanning infrastructure exists in this environment. | **DEFERRED / FUTURE CR — production infrastructure dependency.** |
| S7 | Rejected file types, explicit: SVG (XSS vector, mirrors Settings' own precedent), HTML, JS/MJS, any executable (`.exe`/`.sh`/`.bat`/`.cmd`/`.msi`/`.app`), and all archive formats (`.zip`/`.rar`/`.7z` — zip-bomb/nested-content risk, no legitimate MVP use case). | **LOCKED** |
| S8 | Allowed file types, MVP: PDF, DOC, DOCX, XLS, XLSX, CSV, JPG/JPEG, PNG, WEBP. See §8 (File Type Decision) for per-type rationale. | **LOCKED** |
| S9 | IDOR prevention: every document-scoped endpoint re-resolves the caller's own zone and re-checks it against the document's `zone_id` (or, once a Future CR wires an attachment, the parent entity's zone) on **every single request** — no caching of a prior check, identical discipline to every prior phase in this program. | **LOCKED** |
| S10 | Enumeration: sequential integer IDs are retained (matching every other V2 entity — Inventory, Procurement, etc. all use `SERIAL`), because the download route's own authorization check is the actual security boundary, not ID unguessability. Discovery's own finding (legacy's "unguessable filename" is not real security) applies symmetrically to IDs: guessability of the ID is irrelevant if authorization is checked correctly, and Phase 5 does not spend effort obscuring IDs as a substitute for that check. | **LOCKED** |
| S11 | Signed URLs: **not MVP**. Not needed while every download flows through an authenticated API route with server-side streaming; a signed-URL mechanism becomes relevant only if/when a production object-storage backend is adopted (§5), at which point it is evaluated fresh. | **DEFERRED / FUTURE CR — tied to §5's production storage dependency.** |
| S12 | Cache-Control: responses from the download/preview endpoint set `Cache-Control: private, no-store` (never a public/shared cache), since even a legitimate authenticated response should not be cached by an intermediate proxy given the private nature of business documents. | **LOCKED** |
| S13 | Public URLs: never permitted for anything created by this system. (The existing Settings-logo public-GET precedent is untouched, unrelated, and not extended — it remains its own narrow, already-approved exception, not a template for Phase 5.) | **LOCKED** |

---

## 5. Storage Decision

**MVP (development/current environment): local filesystem**, under `server/uploads/documents/` (mirrors the existing `server/uploads/<module>/` convention already used by Cashouts/Complaints/Settings), behind a small internal storage-abstraction module exposing `put(buffer/stream, key) → key`, `get(key) → stream`, `delete(key) → void`. No route or business-logic file calls `fs`/`multer` storage details directly — everything goes through this one seam.

**Future production environment: object storage (S3-compatible), deferred.** No object-storage account, bucket, credentials, or SDK exists in this environment today. This is recorded as an explicit **Production Infrastructure dependency**, not a Phase 5 implementation task — the abstraction in the prior paragraph exists specifically so this swap requires no change to any calling route when that infrastructure eventually exists.

Database BLOB storage: rejected — no existing V2 precedent, would bloat `pg_dump` output, and provides no benefit over the abstraction above.

**FUTURE CR — PRODUCTION OBJECT STORAGE MIGRATION.**

---

## 6. File/Document Data Model Decision

Three entities, minimal, no unnecessary abstraction:

**`file_objects`** — one row per physical binary. Purpose: the storage-abstraction's own bookkeeping; nothing above this layer ever touches the filesystem directly.
- Immutable fields (once written): `storage_key`, `original_filename`, `mime_type`, `extension`, `file_size`, `checksum_sha256`, `created_by`, `created_at`.
- Mutable fields: none — a `file_objects` row is never updated after creation; a new upload always creates a new row.
- Relationships: referenced by exactly one `documents.current_file_object_id` (see below) at any time, plus historically by any superseded `documents` row's own now-void `current_file_object_id` (preserved, never nulled out, so history remains inspectable).
- Delete behavior: DB row is never deleted by a user action. Physical binary cleanup (if ever performed) is a separate, deliberately asynchronous process (§23), never synchronous with any API call.
- FK strategy: `created_by` references `v2_users`-equivalent identity, no `ON DELETE CASCADE` anywhere in this feature (matches this program's universal RESTRICT convention).

**`documents`** — the business-facing record.
- Fields: `id`, `title` (required), `category` (CHECK-constrained enum, not free text — mirrors every other V2 status/type field convention), `description` (optional), `current_file_object_id` (FK → `file_objects`, RESTRICT), `zone_id` (nullable FK → `zones`, RESTRICT — NULL means company-wide, per B9), `status` (CHECK: `active` / `archived` / `voided` — see §7), `replaces_document_id` (nullable self-FK, RESTRICT — the void-and-replace pointer from A5), `created_by`, `created_at`, `updated_at`, `voided_at`, `voided_by`, `voided_reason` (mirrors Cashouts' exact soft-void shape).
- Immutable fields: `created_by`, `created_at`, `replaces_document_id` (set once, at creation, never changed afterward).
- Mutable fields: `title`, `category`, `description` (metadata-only edits, never the binary — replacing the binary always creates a new `documents` row per A5, never an in-place file swap).
- Delete behavior: never a hard delete. Void only (§7).
- Indexes needed later (recorded now, created only at Implementation): `(zone_id)`, `(category)`, `(status)`, `(created_by)`.

**`document_attachments`** — the link between a `documents` row and a business entity. **Created by zero rows in MVP** (no module integration), but the table itself is part of MVP infrastructure so a Future CR can wire an integration without a new migration for the linking mechanism itself.
- Fields: `id`, `document_id` (FK → `documents`, RESTRICT), `entity_type` (CHECK-constrained enum — see A4; the enum's initial value list may be empty or contain only placeholder/reserved values, since nothing populates it yet), `entity_id` (plain INTEGER, no FK — mirrors Inventory & Assets' own established `source_purchase_order_receipt_item_id` pattern for a cross-module reference that must not create a hard dependency), `zone_id` (nullable, denormalized for query performance only, server-set, never client-supplied), `created_by`, `created_at`.
- Immutable: the entire row, once created (an attachment link is never edited — unlink-and-relink, if ever needed, is a Future CR question for whichever integration eventually needs it).
- Delete behavior: soft — mirrors the parent `documents.status` lifecycle; a voided document's attachments are not separately deleted, they simply reflect the parent's void state on read.

**`document_categories`**: **not a separate table.** A plain CHECK constraint list on `documents.category`, matching the universal V2 convention (movement types, asset statuses, etc. are all CHECK constraints, not lookup tables) — no lookup table until a real business need for dynamic categories is demonstrated.

---

## 7. Lifecycle Decision

States: `active` → `archived` (reversible, admin-only) → back to `active` (restore, admin-only) *or* → `voided` (terminal-in-practice but not database-terminal — a voided document is never physically deleted, so "terminal" only means no further state transition is exposed via the API, not that the row disappears).

- **Binaries are immutable.** A `file_objects` row is never edited or replaced in place.
- **Documents are replaceable, not versioned-with-history**, per A5 — replacing a document creates a brand new `documents` row (new `file_objects`, `replaces_document_id` pointing at the old row) and voids the old row. The old row's metadata, binary, and full audit trail remain permanently inspectable.
- **Soft-delete only.** `voided_at`/`voided_by`/`voided_reason` populated, `status = 'voided'`, row never removed. This directly satisfies the standing instruction that historical business evidence must not disappear silently.
- **Permanent physical deletion**: never performed by any synchronous user-facing action. If ever needed (e.g., a legal deletion request), it is an explicit, separately authorized administrative process outside this API surface — not built in MVP.

**LOCKED.**

---

## 8. Versioning Decision

**MVP: one current file per document, no version-number sequence, no multi-generation history browsing.** Replacing a document's file is modeled as void-old + create-new + `replaces_document_id` link (§6), which gives a traceable chain without the complexity of legacy's `version` INTEGER counter or a dedicated `document_versions` table.

Rationale: no existing V2 module (Cashouts/Complaints/Settings) has ever needed multi-version browsing; legacy's own version feature exists in schema but Discovery found no evidence it solved a real, still-relevant business need beyond what void-and-replace already covers. Building a full version-history table now would be exactly the kind of unnecessary abstraction this authorization warns against.

**FUTURE CR — DOCUMENT VERSIONING** (full `document_versions` table with a current-version pointer, multi-generation browsing, and possibly a version-number counter) — to be authorized only if a specific module integration later demonstrates a genuine need (e.g., a contract that legitimately goes through 5 negotiated drafts and all 5 must be browsable together, not just "old vs. new").

---

## 9. File Type Decision

| Category | MVP decision | Rationale |
|---|---|---|
| PDF | **Allowed** | Universal, inert, existing precedent (Cashouts/Complaints) |
| DOC / DOCX | **Allowed** | Legitimate document formats; no V2 precedent yet but no elevated risk beyond the general macro caveat below |
| XLS / XLSX | **Allowed** | Same rationale as DOC/DOCX |
| CSV | **Allowed** | Low risk; CSV-injection risk is a spreadsheet-application concern, not a server-side risk, and out of scope for a file-storage feature |
| JPG / JPEG, PNG | **Allowed** | Existing precedent, all three current modules |
| WEBP | **Allowed** | Same risk class as JPG/PNG, modern format, no reason to exclude |
| SVG | **Rejected** | Can embed executable script (XSS) — mirrors Settings' own explicit, already-documented decision |
| HTML | **Rejected** | Script-execution risk if ever rendered/previewed |
| JS / MJS | **Rejected** | No legitimate document use case |
| Executables (.exe/.sh/.bat/.cmd/.msi/.app) | **Rejected** | No legitimate document use case, malware risk |
| Archives (.zip/.rar/.7z) | **Rejected** | Zip-bomb / nested-malicious-content risk; no MVP use case |
| Macro-enabled Office formats (.docm/.xlsm) | **Rejected** — the allowlist checks the specific non-macro MIME types only, so a `.docm`/`.xlsm` file (different MIME type) is rejected by the same allowlist mechanism, no special-case code needed | Macro-execution risk |

Unsupported-format handling: identical to every existing V2 module — `fileFilter` rejects before any disk write, route returns `400` with a clear message listing allowed types.

**LOCKED.**

---

## 10. File Size Decision

**Flat MVP limit: 15MB**, applied server-side via `multer.limits.fileSize` (authoritative) and mirrored as a client-side UX-only pre-check (never trusted alone, identical to existing precedent).

Rationale for a flat limit over Discovery's evaluated per-category alternative: the three existing modules already use two different flat limits (10MB documents/photos, 2MB logo) with no evidence a per-category table has ever been needed; 15MB comfortably covers a large scanned multi-page PDF while remaining well below a size that would strain local-filesystem storage on typical infrastructure. If a future module integration demonstrates a genuine need for a different limit (e.g., a much smaller limit for a specific document category), that is a Future CR against this specific decision, not a reason to build a per-category table speculatively now.

Request/body limit: Express's own body-parser limit for multipart uploads must accommodate this (an Implementation Specification concern, not a Decisions-stage schema/business question — recorded here so Implementation does not silently miss it).

**LOCKED.**

---

## 11. Download / Preview Decision

**Download**: `GET /v2/documents/:id/file` (candidate name, not final until Implementation Spec) streams the binary through the storage abstraction with `Content-Type` set from the stored `mime_type` and `Content-Disposition` controlled by an explicit `?download=1` query flag — default is `inline` (browser decides, matching Cashouts'/Settings' `sendFile` precedent) unless the caller explicitly requests a forced download. This standardizes the mixed `sendFile`/`download` split Discovery found between Cashouts and Complaints into one consistent rule.

**Preview**: MVP supports inline preview for the types where a browser can render it natively without a plugin — **PDF and the three image types (JPG/PNG/WEBP)**. DOC/DOCX/XLS/XLSX/CSV are **download-only** in MVP (no in-browser Office-document rendering — that would require a third-party rendering service, a new infrastructure/dependency decision this stage is not authorized to make).

**FUTURE CR — OFFICE-DOCUMENT INLINE PREVIEW** (DOC/DOCX/XLS/XLSX rendering) — deferred pending a rendering-service decision.

Range-request support: **not MVP** — no existing V2 precedent needs it (no video/large-file streaming use case identified), and PDF/image inline preview does not require it at the file sizes locked in §10.

Every download/preview request re-runs the full `authenticateToken → requireRole → resource existence → zone check → stream` chain — no exception for preview vs. download.

**LOCKED.**

---

## 12. Audit Decision

`logAudit()` is called for: **upload** (document creation), **metadata update**, **attachment/link creation** (once any Future CR wires one), **archive**, **restore**, **void**, **replacement** (new-document-supersedes-old), **download**, and **preview**.

This is a deliberate **expansion** beyond current V2 practice — Discovery found Cashouts audits upload but not download, and Complaints audits neither upload nor download. Phase 5's own infrastructure closes that gap for itself; it does not retroactively change Cashouts' or Complaints' own CLOSED code (that would be an unauthorized touch to a frozen module).

As with Cashouts' own established precedent, `storage_key` is never written into the audit payload itself (no audit value, and no reason to duplicate a filesystem-adjacent detail into the audit trail) — the audit records the `document_id`/`file_object_id` and the action, not the raw key.

No second audit table or writer is created. `v2_audit_log` via the existing `logAudit()` is the only mechanism.

**LOCKED.**

---

## 13. RBAC Decision

| Action | Admin | Gudoomiye | Zone Accountant | Head of Cashiers | Cashier | Collector | Customer Portal |
|---|---|---|---|---|---|---|---|
| Upload | Yes | Yes (own zone only) | No | No | No | No | No (MVP) |
| View metadata | Yes | Yes | Yes | Yes | Yes | No | No (MVP) |
| Preview | Yes | Yes | Yes | Yes | Yes | No | No (MVP) |
| Download | Yes | Yes | Yes | Yes | Yes | No | No (MVP) |
| Metadata edit | Yes | Yes (own upload or own zone — exact ownership rule below) | No | No | No | No | No |
| Archive | Yes | No | No | No | No | No | No |
| Restore | Yes | No | No | No | No | No | No |
| Void | Yes | No | No | No | No | No | No |

Metadata-edit ownership rule: a Gudoomiye may edit a document's title/category/description only when the document's own `zone_id` matches their resolved zone (identical `resolveUserZoneId()` pattern used everywhere else in this program) — never company-wide (`zone_id IS NULL`) documents, which are Admin-only to edit.

This grants Collector **zero access**, identical to every other back-office module in this program, and grants Cashier read-only access consistent with the existing `VIEW_ROLES` pattern already used in Procurement/Inventory.

**LOCKED.**

---

## 14. Zone Isolation Decision

A `documents` row carries its own **nullable** `zone_id` (NULL = company-wide, visible/accessible to any zone-scoped role subject to the RBAC table above — mirrors the exact "nullable zone is accessible to all" precedent already established in Inventory & Assets for company-wide stores).

This is independent of any future `document_attachments` row's own denormalized `zone_id` (§6) — if a Future CR ever wires an attachment to a zone-scoped business entity, that attachment inherits the parent entity's zone at creation time (server-resolved, never client-supplied), but the `documents` row's own `zone_id` remains the authoritative field for standalone-document access control in MVP, since nothing is attached yet.

Server-side authorization is mandatory on every request — no caching, no client-supplied zone trusted, identical discipline to every prior phase.

**LOCKED.**

---

## 15. Module Integration Decision

**Zero integrations in Phase 5 MVP.** Every module listed below remains untouched; each is recorded as its own Future CR, to be separately authorized and scoped exactly like Phase 4's one narrow Procurement exception — never bundled together, never assumed pre-approved by virtue of appearing on this list.

- **FUTURE CR — HR/EMPLOYEES DOCUMENT ATTACHMENTS** (including finally wiring the existing dead `employees.photo`/`employees.id_document` columns — their existing presence does not pre-authorize this touch, per this authorization's explicit instruction)
- **FUTURE CR — PROCUREMENT DOCUMENT ATTACHMENTS**
- **FUTURE CR — INVENTORY DOCUMENT ATTACHMENTS**
- **FUTURE CR — ASSET DOCUMENT ATTACHMENTS**
- **FUTURE CR — COMPLAINTS MIGRATION TO CENTRALIZED DOCUMENTS** (migrating the existing `complaint_attachments` feature onto this new system — not required, existing feature keeps working standalone)
- **FUTURE CR — CASHOUT SIGNED-DOCUMENT MIGRATION** (same rationale — Cashouts' own attachment feature is untouched and keeps working)
- **FUTURE CR — CUSTOMER DOCUMENT ATTACHMENTS**
- **FUTURE CR — SUPPLIER DOCUMENT ATTACHMENTS**

**LOCKED** (as a scope boundary — the zero-integration decision itself).

---

## 16. Search Decision

**MVP**: simple filter parameters on the `documents` list endpoint — `title` (ILIKE, min 2 characters, identical convention to every other V2 list route), `category`, `uploaded_by`, `date_from`/`date_to`. This mirrors the pattern already used by Inventory's `items`/`stores`/`assets` list endpoints; no separate search infrastructure is built or needed.

Full-text content search (searching *inside* a PDF/DOCX's text) is **not MVP** — no existing V2 precedent, would require a text-extraction dependency this stage is not authorized to add.

The shared Search module (if one exists elsewhere in the app) is **not modified**.

**LOCKED** (simple filters) / **FUTURE CR — DOCUMENT FULL-TEXT SEARCH** (content search).

---

## 17. Reporting Decision

**MVP: none.** No document count, storage-usage, or uploads-by-period reporting is built. Discovery found no demonstrated business driver for this beyond speculative usefulness, and this authorization explicitly instructs keeping reporting minimal absent a demonstrated need. The existing Reports module is **not modified**.

**FUTURE CR — DOCUMENT REPORTING** (document counts, storage usage, uploads-by-category/period, archived/voided counts, orphan-file reporting) — to be scoped if/when a specific reporting requirement is raised.

---

## 18. Retention Decision

**Not defined in MVP.** No document/file retention period is locked, because Discovery found no legal, regulatory, or organizational policy input to base one on — inventing a number (e.g., "7 years") would be exactly the silent business-rule invention this program's standing rules forbid.

**FUTURE CR — RETENTION POLICY**, blocked on: a legal/compliance/organizational-policy input that does not currently exist in this engagement. Until that input arrives, no document is ever auto-purged by any process this system runs.

---

## 19. Orphan / Failure Handling Decision

| Scenario | MVP behavior |
|---|---|
| Binary written to disk, but the `file_objects`/`documents` DB insert fails (mid-transaction) | Upload runs inside a single DB transaction (mirrors every prior phase's own transactional-write discipline); on any DB failure after the file is written, the route deletes the just-written binary before returning the error — the same "delete-on-validation-failure" pattern already proven in Cashouts' `fs.unlink(req.file.path, ...)` calls. No orphan is created by a normal failure path. |
| Metadata exists, binary missing from disk (e.g., manual disk tampering, filesystem corruption) | Download route returns `404` with a clear "file no longer exists on disk" message — mirrors Cashouts' existing `fs.existsSync` check exactly. Not auto-repaired; flagged for manual/administrative investigation. |
| Interrupted/abandoned multipart upload (client disconnects mid-upload) | `multer`'s own behavior already handles a partial temp file; MVP relies on `multer`'s default temp-file cleanup, no custom logic added. |
| Voided document's binary | Never proactively deleted by the void action itself (§7) — remains on disk, retrievable if the void needs to be reversed via restore, for as long as no separate cleanup process runs. |
| Scheduled/proactive orphan sweep (a binary with zero referencing `documents` row, or a voided document older than some age) | **Not built in MVP.** This is a genuinely deferred capability, not a silent gap — recorded explicitly below. |

**FUTURE CR — ORPHAN FILE SWEEP** (a scheduled or manually-triggered cleanup process for binaries that no live `documents` row references) — deferred because it requires its own policy decision (how old before a voided document's binary is eligible for physical cleanup) that overlaps with the deferred Retention decision (§18) and should not be decided independently of it.

---

## 20. Backup / Recovery Decision

**PostgreSQL backup (`pg_dump`) captures `file_objects`/`documents`/`document_attachments` metadata only — it does not capture the binaries themselves**, which live on local disk in MVP. This exact gap already exists silently today for Cashout/Complaint attachments (per Discovery §20); Phase 5 does not fix it (that is an infrastructure question, not a Phase 5 code question) but **formally records it** so it is not lost:

**Production Infrastructure dependency (explicit, not a Phase 5 task):** before this system (or, for that matter, the existing Cashout/Complaint attachment features) is relied upon for records anyone depends on in a real deployment, the production environment must provision either durable backed-up block storage for the upload directory, or migrate to object storage (§5) with its own retention/versioning and backup story. Database backup alone must never be treated as a complete file backup while binaries live outside PostgreSQL.

No production infrastructure change is made in this stage.

**LOCKED** (as a documentation/dependency-recording decision) — the underlying infrastructure gap itself is **DEFERRED / FUTURE CR — PRODUCTION BACKUP INFRASTRUCTURE FOR FILE BINARIES.**

---

## 21. API Boundary Decision

Candidate endpoints, locked as the MVP surface (exact paths/names finalized at Implementation Specification, not here):

| Candidate | Actor / Role | Zone rule | Validation | Security boundary |
|---|---|---|---|---|
| Upload (`POST .../documents`) | Admin, Gudoomiye (own zone) | Server-resolved zone written to the new row; client cannot set `zone_id` directly for a Gudoomiye caller | MIME/extension allowlist (§9), size limit (§10), title required | Reject before any disk write on any validation failure |
| List (`GET .../documents`) | Admin/Gudoomiye/Zone Accountant/Head of Cashiers/Cashier | Zone-scoped (nullable-zone rows visible to all, per §14) | Filter params per §16 | No cross-zone leakage via filter manipulation |
| Detail (`GET .../documents/:id`) | Same view roles | Re-checked per request | — | Same IDOR class as list |
| Download/Preview (`GET .../documents/:id/file`) | Same view roles | Re-checked per request | Optional `?download=1` (§11) | Highest-risk endpoint — never a static/public path |
| Metadata update (`PUT .../documents/:id`) | Admin, Gudoomiye (own-zone documents only) | Re-checked per request | Title/category/description only — binary never touched here | Mass-assignment: client can never set `created_by`, `current_file_object_id`, `voided_*`, `zone_id` (for non-admin) directly |
| Archive (`PUT .../documents/:id/archive`) | Admin only | N/A (admin is company-wide) | Reason optional (archive is reversible) | — |
| Restore (`PUT .../documents/:id/restore`) | Admin only | N/A | — | Only valid from `archived` state |
| Void (`PUT .../documents/:id/void`) | Admin only | N/A | Reason **required** (mirrors Cashouts' exact rule) | Never a hard delete |
| Replace (`POST .../documents/:id/replace`) | Same as upload | Same as upload | Same file-validation rules as upload | Creates a new `documents` row + voids the old one atomically, per §6/§8 |

No attachment/link endpoint is built in MVP (§15 — zero integrations), though the `document_attachments` table exists as infrastructure per §6.

**LOCKED.**

---

## 22. Frontend Boundary Decision

**MVP UI**: Documents List page, Document Detail page, Upload modal, Preview modal (PDF/image inline per §11), Metadata-edit modal, Archive/Restore/Void confirmation dialogs (reusing the existing `ConfirmDialog` component, same as every prior phase). No Categories management page (category is a CHECK-constrained enum per §6, not a user-managed lookup).

No Attachment/link panel is built in MVP (§15 — nothing to attach to yet).

No Sidebar/AppShell/navigation change — direct-URL-only access, identical to Phase 4's own precedent, with the same understanding that adding a nav entry is a trivial Future CR whenever a business decision calls for it.

**LOCKED.**

---

## 23. Legacy Migration Decision

**Not performed in MVP.** No demonstrated requirement for immediate migration of legacy's `documents`/`archives` data was identified in Discovery, and migrating it carries real, non-trivial risk: legacy's `DELETE` routes already hard-deleted an unknown number of historical rows before this program began (their history is unrecoverable), legacy rows have no zone data compatible with V2's zone model, and legacy's category/document_type free-text values do not map cleanly onto the new CHECK-constrained enum without a data-cleaning pass.

**FUTURE CR — LEGACY DOCUMENT/ARCHIVE MIGRATION**, to be scoped as its own dedicated effort (data audit, mapping table, zone backfill strategy) only if and when a business need for the legacy records' continued accessibility inside V2 is demonstrated.

---

## 24. Future CR / Deferred Items (consolidated)

1. FUTURE CR — DOCUMENT VERSIONING (§8)
2. FUTURE CR — PRODUCTION OBJECT STORAGE MIGRATION (§5)
3. FUTURE CR — CONTENT-SNIFFING VALIDATION (dependency addition, §4/S5)
4. FUTURE CR — VIRUS/MALWARE SCANNING (production infrastructure dependency, S6)
5. FUTURE CR — SIGNED URLS (tied to #2, S11)
6. FUTURE CR — OFFICE-DOCUMENT INLINE PREVIEW (§11)
7. FUTURE CR — HR/EMPLOYEES DOCUMENT ATTACHMENTS (§15)
8. FUTURE CR — PROCUREMENT DOCUMENT ATTACHMENTS (§15)
9. FUTURE CR — INVENTORY DOCUMENT ATTACHMENTS (§15)
10. FUTURE CR — ASSET DOCUMENT ATTACHMENTS (§15)
11. FUTURE CR — COMPLAINTS MIGRATION TO CENTRALIZED DOCUMENTS (§15)
12. FUTURE CR — CASHOUT SIGNED-DOCUMENT MIGRATION (§15)
13. FUTURE CR — CUSTOMER DOCUMENT ATTACHMENTS (§15)
14. FUTURE CR — SUPPLIER DOCUMENT ATTACHMENTS (§15)
15. FUTURE CR — DOCUMENT FULL-TEXT SEARCH (§16)
16. FUTURE CR — DOCUMENT REPORTING (§17)
17. FUTURE CR — RETENTION POLICY (§18, blocked on external legal/policy input)
18. FUTURE CR — ORPHAN FILE SWEEP (§19, overlaps with #17)
19. FUTURE CR — PRODUCTION BACKUP INFRASTRUCTURE FOR FILE BINARIES (§20)
20. FUTURE CR — LEGACY DOCUMENT/ARCHIVE MIGRATION (§23)
21. DEFERRED — Customer Portal document access (§B11/§19 of this document)

---

## 25. Risks (ranked, carried forward and re-affirmed from Discovery)

1. **Reproducing legacy's public-static-file mistake** — mitigated by S1/S2 being locked as non-negotiable; the residual risk is a future engineer adding a convenience static mount under time pressure — flagged for Implementation/Hardening vigilance.
2. **Cross-zone/IDOR leakage** — mitigated by S9's mandatory per-request re-check; residual risk is a future Future-CR integration implementing its own zone check incorrectly — each Future CR must re-prove this independently, not inherit it silently.
3. **Storage-path convention drift** — mitigated by A2's single storage-abstraction seam; residual risk is a future contributor bypassing the abstraction directly, same discipline failure that created Discovery's original finding.
4. **Malicious upload** — partially mitigated by S4/S7; content-sniffing and virus scanning remain deferred (S5/S6) — a real, acknowledged residual risk, not eliminated, only reduced to the same level already accepted by the three existing V2 modules.
5. **Orphaned binaries / backup mismatch** — explicitly recorded (§19/§20), not solved; residual risk until Retention (§18) and Production Backup Infrastructure (§20) dependencies are resolved.
6. **Large-file performance** — low residual risk at the 15MB limit locked in §10; no premature optimization performed.
7. **Frozen-module integration risk** — fully mitigated for this stage by the zero-integration decision (§15); each Future CR carries this risk forward individually when authorized.
8. **Legacy migration risk** — not attempted in MVP (§23); risk deferred entirely with the decision itself.
9. **Production storage-backend dependency** — explicitly flagged (§5/§20) as blocking a full production rollout of this feature (and, implicitly, a permanent fix for the pre-existing Cashout/Complaint gap) until infrastructure is provisioned — not a Phase 5 blocker, since Phase 5 targets the current dev environment, but a known limitation of what "production-ready" means for this feature today.

---

## 26. Open Blockers

**None that block Decisions from completing.** Two items were identified as depending on inputs outside this engagement's current authority and are correctly deferred rather than resolved by invention:
- Retention policy (§18) — blocked on legal/organizational-policy input.
- Production object storage / backup infrastructure (§5/§20) — blocked on infrastructure provisioning that has not happened for this project at all (confirmed in Discovery: no object-storage credentials exist anywhere in this environment).

Neither blocks proceeding to an Implementation Specification for the MVP scope actually locked above — both are correctly scoped out as Future CRs with their dependency named, per this authorization's own instruction to stop and report rather than invent a rule when a decision cannot be made safely.

---

## 27. Git / Safety Verification

- HEAD confirmed unchanged: `9020fc617a4e2066d019848e39b0c1c02b9c18e2` (verified via `git log -1` immediately before this document was written)
- Branch: `main`
- Working tree: only `GURMAD_V2_Phase5_Document_File_Discovery_Report.md` (from the prior stage) was present as untracked before this stage; this Decisions document is the only file added during this stage
- Zero code changes, zero schema changes (no migration written or run), zero dependency changes (`package.json` untouched), zero production changes

---

## 28. Final Recommendation

Proceed to the Implementation Specification stage for exactly the MVP scope locked above: centralized `file_objects`/`documents`/`document_attachments` infrastructure, local-filesystem storage behind an abstraction, the RBAC/zone/security rules in §12-14, the API/frontend boundaries in §21-22, and zero integration into any existing module. Every deferred item in §24 remains explicitly out of scope until separately authorized.

---

## DECISIONS AMENDMENT — `documents.category` Taxonomy

**Amendment history:**
- Raised during Implementation Specification review, when the Specification was found to have silently invented six category values (`contract`/`certificate`/`report`/`photo`/`form`/`other`) that were never locked here. Those values were withdrawn and this amendment was opened as blocked, pending explicit business-owner input.
- **Resolved** by explicit Business-Owner decision (this update). The blocker is closed. This amendment addresses **only** the exact category value list — nothing else in this Decisions document is reopened by this update.

**1. Shape (already locked, restated for clarity):** `documents.category` is a `CHECK`-constrained enum column. This was and remains locked in §6 (Data Model Decision) and §21 (Frontend Boundary Decision) above.

**2. Exact approved values — LOCKED, exactly nine, in this order:**

| # | Value | Business meaning |
|---|---|---|
| 1 | `official` | Official/company/government documents |
| 2 | `contract` | Contracts and agreements |
| 3 | `certificate` | Certificates and credentials |
| 4 | `report` | Formal reports |
| 5 | `financial` | Financial / supporting financial documents |
| 6 | `hr` | HR / employee documents |
| 7 | `procurement` | Procurement / supplier / PO supporting documents |
| 8 | `operational` | Operational documents — fleet, collection, procedures, routes, etc. |
| 9 | `other` | Documents that genuinely do not fit the defined categories |

**3. LOCKED status:** **LOCKED.** These nine values, exactly as spelled above (lowercase, single-word-or-underscore-free as shown), are the complete `documents.category` enum for Phase 5 MVP. No tenth value, no synonym, no rename.

**4. Rejection of out-of-list values:** Enforced by the database `CHECK` constraint itself (not application-layer validation alone) — any value outside this exact nine-item list is rejected at the database level.

**5. Free-text category:** **Confirmed prohibited**, unconditionally — unchanged from the original block.

**6. Inclusion of `other`:** **Included** — value #9 above, explicitly reserved for documents that genuinely do not fit values 1-8. It is not a general-purpose default; it is a deliberate, named catch-all.

**7. Design principle — LOCKED, carried forward from the Business-Owner decision verbatim:** `category` describes the **business purpose/nature** of the document. It must **not** be used as a substitute for `entity_type`, `entity_id`, module ownership, or an attachment relationship. This does not reopen §4/§15 (zero module integration in MVP, `document_attachments` populated by nothing) — it reinforces that boundary: `category` classifies *what kind of document this is*, never *what it is attached to*, and MVP still attaches it to nothing.

**8. Investigation performed before the blocker was raised** (retained for the record — the business-owner decision supersedes this investigation's "no authoritative source" conclusion, it does not invalidate that the investigation was done first): legacy's own "Customer/Employee/Supplier/Fleet/Company" comment was confirmed unenforced in code; `Gurmad-Master-Proposal-v6.docx` and `Gurmad_V2_Master_Rebuild_Specification.docx` were inspected and contain no Document Management category taxonomy; `Gurmad_Business_Rules_Complete_Explained_v2.docx` was inspected and its only "category" content concerns unrelated Expense Categories. None of the nine locked values above match legacy's own unenforced comment set — this is a genuinely new, explicitly business-owner-authored taxonomy, not a rediscovery of an existing one.

**9. Future CR boundaries:** unchanged — every item in §24 of this document remains as previously locked; this amendment neither closes nor reopens any of them.

**10. Other Phase 5 decisions:** none reopened. Every other section of this document (Storage, Lifecycle, RBAC, Zone Isolation, Module Integration, etc.) stands exactly as previously locked.

**Resolution:** **RESOLVED.** The nine-value `documents.category` enum above is LOCKED and ready to be reflected in the Implementation Specification's schema, RBAC-adjacent metadata-edit validation, and frontend category selector.

---

## Final Status

**PHASE 5 — DOCUMENT & FILE MANAGEMENT — DECISIONS COMPLETE** — all sections locked, including the `documents.category` taxonomy per the amendment above. No open blockers remain in this document.

Production:
NOT AUTHORIZED — UNTOUCHED
