# GURMAD V2 — Phase 6: Import/Export + Master Data Governance — Discovery Report

**Status:** DISCOVERY ONLY. No code, schema, dependency, or production changes were made during this stage.
**Baseline:** V2 HEAD `b648590c39bc10e0d65890a64dd44cf4bf18ab5e` (Phase 5 CLOSED/FROZEN).

---

## 1. Executive Summary

V2 has **real, proven export infrastructure** (two live CSV export endpoints, a shared `toCsv()` helper, and — critically — a documented, already-fixed CSV-formula-injection hardening pattern) but **zero import infrastructure** of any kind: no bulk-create endpoint, no file-parsing dependency, no CSV/XLSX library anywhere in the client or server. Legacy has exactly one bulk-import feature (Customers), and it is a cautionary tale, not a template: it accepts a pre-parsed JSON array with no file validation, no duplicate detection, no transaction boundary, and no audit logging. Several genuine master-data entities (Suppliers, Inventory Items, Inventory Stores) have **no natural business-key column at all** beyond their surrogate `id` — a concrete, evidence-based reason the "canonical identifier" question cannot be answered by Discovery and must go to a Business Owner. A real FK dependency graph was built directly from the live schema (not assumed from memory) and gives a verified, evidence-backed master-data import order. 30 business-owner decisions are identified; none are answered here.

---

## 2. Current V2 Findings

### 2.1 Existing export infrastructure (REUSE candidates)

| Endpoint | Purpose | Pattern |
|---|---|---|
| `GET /api/v2/audit/export` | Audit log CSV export | Uses shared `toCsv()` (from `lib/reportsCalculations.js`), plus its **own** `csvFormulaSafe()` sanitizer — a documented Hardening-stage fix (comment cites "H-A1", CWE-1236) for CSV formula injection, found live when `actor_username` (a user-supplied field) contained a leading `=`/`+`/`-`/`@` and round-tripped unescaped into the exported CSV |
| `GET /api/v2/reports/:category/export.csv` | Per-category financial/operational report export (collector-performance, zone-performance, invoices-summary, payments-summary, debts-summary) | Same shared `toCsv()`; per-category **role allowlist** (`EXPORTABLE[category].roles`), zone-scoped via `resolveUserZoneId()`, calls `logAudit()` with `action: 'report.export'` recording the category and row count |

**Real gap found in this same investigation**: `reports.js`'s own export endpoint does **not** call `csvFormulaSafe()` — only `audit.js` received that hardening fix. Reports is a CLOSED/FROZEN module; this Discovery does not touch it, but it is recorded here as a genuine, currently-live gap (transactional/financial export data, not master data, so out of Phase 6's own direct scope, but relevant precedent: if Phase 6 builds its own export, it must include this sanitization from day one rather than needing its own later hardening pass).

Shared helper: `toCsv(rows, columns)` in `server/lib/reportsCalculations.js` — quotes every cell, escapes embedded quotes, columns defined as `{key, label}` pairs. **REUSE** candidate, verbatim, for Phase 6 export.

### 2.2 Existing import infrastructure

**None found.** Grep across every route file for bulk-create/import patterns found only three `upload.single('file')` matches — all three are the already-known Phase 4/5 *file attachment* uploads (Documents, Cashout attachments, Complaint attachments), not data-record import. No CSV/XLSX parsing dependency exists in `server/package.json` or `client/package.json`. Confirmed by direct inspection, not assumed.

### 2.3 Existing RBAC/zone-scoping pattern (REUSE)

Identical across every phase already built: `ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant']`, `resolveUserZoneId(user)` resolving a role's zone via `zones.name = user.zone` lookup, and a nullable-`zone_id`-means-company-wide convention. This is the correct, already-proven mechanism to reuse for both import (server-resolved zone for zone-scoped roles, ignore client-supplied zone) and export (row-level zone filtering before data leaves the server).

### 2.4 Existing transaction/locking patterns (REUSE)

Every multi-row write in Phases 1-5 wraps in `BEGIN`/`COMMIT`/`ROLLBACK` via `pool.connect()` → `client.query()`, with `FOR UPDATE` row locks where concurrent access is possible (Phase 4's inventory ledger) or an atomic `WHERE ... AND status = '<expected>'` UPDATE for simpler single-row transitions (Phase 5 Hardening's own fix). A bulk import is a natural extension of this same discipline — no new pattern needs inventing, but the exact **transaction boundary for a multi-row import** (one transaction for the whole file vs. one per row vs. a hybrid) is a genuine open question (§15).

### 2.5 Existing sequence/numbering systems

Confirmed via direct `db.js` inspection: `customer_number_seq`, `batch_number_seq`, `invoice_number_seq`, `cashout_number_seq`, `procurement_request_number_seq`, `purchase_order_number_seq` — every business-facing numbered entity in V2 already uses a Postgres `SEQUENCE` for its human-readable number, generated server-side at insert time, never client-supplied. This is directly relevant to import provenance: if an imported row needs a business number, the existing sequence pattern is the correct mechanism, not a client-supplied value.

### 2.6 Existing soft-delete/archive/immutable-history patterns (REUSE)

Confirmed present and consistent across every phase: `status` CHECK columns (`active`/`inactive`, or module-specific enums), never a hard `DELETE` for anything with downstream references; Phase 5's own `voided_at`/`voided_by`/`voided_reason` soft-void triple is the most recent and most complete example. Relevant to import: an imported row that later needs correction should follow this same non-destructive pattern, not a hard overwrite — but whether import itself may **update** existing records (vs. create-only) is a genuine open question (§15, Q12-14).

---

## 3. Legacy Findings

### 3.1 `POST /api/customers/bulk-import` — the one legacy import feature found

Read directly (`gurmad system/server/index.js:2121`). Findings:

| Aspect | Legacy behavior | Risk |
|---|---|---|
| Input | `req.body.customers` — an already-parsed JSON array | The actual CSV/XLSX parsing happens **client-side** before the request is ever sent; the server never validates file type, size, or content — it only ever sees whatever JSON array the client chose to send. A malicious or buggy client could send anything. |
| Duplicate detection | **None** | No check against existing `customers` rows by name/phone before insert. Re-running the same file twice creates duplicate customers every time. No within-file duplicate check either. |
| Transaction boundary | **None** — one `INSERT` per row, no `BEGIN`/`COMMIT` | A mid-batch server crash or DB error leaves a partially-imported, uncommitted-as-a-unit state with no atomicity guarantee. |
| Partial success | Allowed, per-row try/catch, errors collected and returned as `{row, error}` — an **adoptable design element** despite the surrounding flaws | ADAPT |
| Zone handling | Gudoomiye: correctly server-resolved (`isGudoomiye ? req.user.zone : ...`) — matches V2's own established pattern | REUSE (the *rule*, already proven, not this code) |
| Admin zone handling | Trusts client-supplied `b.zone` with **zero validation** that the zone exists | REJECT |
| Data-quality silent coercion | `parseFloat(b.fee) \|\| 10` — an invalid/unparseable fee silently becomes the default 10, rather than being rejected as a row-level error | REJECT |
| Audit | **No `logAudit()` call anywhere in this endpoint** | REJECT — this exact gap must not be repeated |
| Dry-run/preview | None | Not present to REUSE |
| File-size limit | None (bounded only by whatever global JSON body-parser limit exists, if any) | REJECT as a starting point; needs a real limit |

**No other legacy bulk-import endpoint exists** — confirmed by grep; Employees, Trucks, Suppliers, and Inventory have never had an import feature in either system.

### 3.2 Legacy master-data tables of note

Legacy's own `documents`/`archives` split (already covered exhaustively in Phase 5 Discovery) is not re-litigated here. No other legacy-only master-data table was found that V2 lacks — legacy's `zones`, `customers`, `employees`, `trucks` tables are the direct ancestors of V2's own already-migrated tables.

---

## 4. Existing Import Infrastructure

**Summary: none in V2.** Legacy's one example (§3.1) is the only prior art in either system, and it is classified **REJECT** as an implementation template, with exactly one **ADAPT** element (the per-row partial-success/error-array reporting shape).

---

## 5. Existing Export Infrastructure

**Summary: two real, working endpoints in V2** (§2.1), both built on a shared, reusable `toCsv()` helper. The `csvFormulaSafe()` sanitizer from `audit.js` is a **REUSE** candidate — it should be extracted or duplicated (not modified in place, since `audit.js` is CLOSED/FROZEN) into any Phase 6 export code from day one, given the exact vulnerability it fixes is generically applicable to any CSV export of user-supplied string data.

---

## 6. Master Data Inventory

Based on direct schema inspection, the tables that plausibly qualify as **master data** (long-lived, low-churn, referenced by many other tables, administratively maintained rather than transactionally generated) are:

| Table | Zone-scoped? | Natural/business unique key | Notes |
|---|---|---|---|
| `zones` | N/A (is the zone) | `zone_code` (UNIQUE) | Root of the dependency graph |
| `customers` | Yes (`zone` — legacy-named column, references `zones` via FK found live) | `customer_number` (UNIQUE, server-generated via sequence) | Also references `groups`, `routes` |
| `employees` | Yes (`zone_id`) | none found beyond `id`; `user_id` is UNIQUE but is an account link, not a business key | |
| `trucks` | Yes (`zone_id`) | `plate_number` (UNIQUE) | References `employees` (driver, twice — likely primary/secondary) |
| `suppliers` | No (company-wide, confirmed — no `zone_id` FK found) | **none** — only `id` | Real gap, see §15 |
| `inventory_items` | No (company-wide, by Phase 4 design) | `sku`, but **nullable and only enforced when present** (partial unique index) | An item with no SKU has zero duplicate protection today |
| `inventory_stores` | Yes (`zone_id`, nullable = company-wide) | **none** — only `id` | Real gap |
| `asset_register` | Yes (`zone_id`) | `asset_tag`, nullable partial-unique (same shape as `inventory_items.sku`) | Most complex dependency (references stores, zones, POs, employees, suppliers) |
| `leave_types` | No | `code` (UNIQUE) | |
| `groups` | Yes (`zone_id`) | none found beyond `id` | |
| `routes` | No direct zone FK; references `groups` | none found beyond `id` | |

**Explicitly evaluated and excluded as master data** (transactional/generated, not administratively maintained reference data): `invoices`, `payments`, `debts`, `cashouts`, `batches`, `tasks`, `inventory_movements`, `asset_transfers`, `attendance_records`, `payroll_*`, `procurement_requests`/`purchase_orders` (these are business transactions, not master records, even though they reference master data).

**Genuinely ambiguous, flagged for Business Owner input, not decided here**: `procurement_request_items`'s free-text `item_name` (Phase 3, closed) vs. `inventory_items` — whether Suppliers should be considered master data importable independent of any PO is itself confirmed yes by this inventory (Suppliers has no transactional-only shape), but whether Procurement's own request/PO records should ever be import-eligible is out of scope (they are transactions).

---

## 7. Entity Dependency Map

Built directly from live `pg_constraint` FK data (§ Bash evidence above), not assumed:

```
zones (root — no dependencies)
  ├─→ groups
  │     └─→ routes
  ├─→ employees
  │     └─→ trucks (also → employees, twice)
  ├─→ customers (also → groups, → routes)
  └─→ inventory_stores

suppliers (root — no zone dependency)
inventory_items (root — no zone dependency)
leave_types (root — no dependency)

asset_register → inventory_stores, zones, employees, suppliers, purchase_orders (transactional — asset_register cannot be imported before at least one purchase_orders row exists if purchase_order_id is ever populated on import, though that FK is nullable)
```

**Verified dependency-aware import order** (a strict topological sort of the above, evidence-based, not the "old dependency chain" assumed without re-validation):

1. `zones`
2. `leave_types`, `suppliers`, `inventory_items` (independent roots, any order)
3. `groups`, `employees` (both depend only on `zones`)
4. `routes` (depends on `groups`), `trucks` (depends on `employees` + `zones`), `inventory_stores` (depends on `zones`)
5. `customers` (depends on `zones`, `groups`, `routes` — must be last among the "core" entities)
6. `asset_register` (depends on `inventory_stores`, `employees`, `suppliers`, optionally `purchase_orders` — last, and only fully importable once its dependencies exist; the `purchase_order_id` FK should likely be excluded from MVP import scope since `purchase_orders` are transactional, not master data)

This order differs from what a naive/legacy-derived assumption might produce (e.g., assuming Customers could be imported early) — it was derived and verified against the actual current schema, not carried over from any prior document.

---

## 8. RBAC Findings

No new role is warranted by anything found. The existing per-module RBAC shape (`VIEW_ROLES`, an operate/write role subset, `ADMIN_ONLY` for destructive/administrative actions) is directly reusable. Specific to Phase 6:

- **Import** is inherently a write/create action — by every existing module's own precedent (Phase 3 Procurement, Phase 4 Inventory), this would be `admin` + `gudoomiye` (own-zone) at most, never a view-only role. This is a *pattern-consistency observation*, not a decision — the exact list is a Business Owner call (§15, Q4).
- **Export is not automatically implied by view access.** Both existing V2 export endpoints (`audit.js`, `reports.js`) already gate export by role independently of the underlying list/detail view permission — `reports.js`'s `EXPORTABLE[category].roles` is its own explicit allowlist per category, not inherited from the view endpoint's own role check. This is direct, already-proven evidence that "can view" and "can export" are already treated as separate concerns in this codebase — Phase 6 should preserve that distinction, but which specific roles get export rights for which entity is a Business Owner decision (§15, Q5-6).

---

## 9. Zone-Scoping Findings

`resolveUserZoneId()` is the single, uniform mechanism across every phase — confirmed to correctly apply to `customers`, `employees`, `trucks`, `groups`, and (via nullable `zone_id`) `inventory_stores`/`asset_register`. For a bulk import: a zone-scoped importer (e.g., Gudoomiye) should have their own zone server-resolved and enforced on every imported row, exactly as every existing single-record create endpoint already does — client-supplied per-row zone data from a zone-scoped importer must be ignored, mirroring the exact pattern already proven in Procurement/Inventory/Documents. For Admin, whether a bulk import file may contain **mixed zones across different rows** (vs. requiring one zone per import job) is a genuine open question (§15, Q21).

---

## 10. Import Risks

Directly evidenced by the legacy example (§3.1) plus general secure-coding analysis, each explicitly separated from any proposed fix (none are implemented here):

- **Malformed/missing-field rows**: legacy's own per-row try/catch with a collected error array is a reasonable *reporting* shape to adapt, but legacy does zero field-type validation beyond a bare presence check on 2 fields.
- **Invalid foreign keys**: legacy's admin-path zone handling trusts an unvalidated client zone string — confirmed live gap, not hypothetical.
- **Duplicate detection** (within-file and against-DB): entirely absent in the one legacy precedent found. For several V2 tables (Suppliers, Inventory Stores) there isn't even a natural business key to detect duplicates *by* (§6) — this is a blocking gap for any real duplicate-prevention design until a Business Owner names the intended canonical key for these entities.
- **Inactive referenced records**: no V2 or legacy precedent addresses whether an import may reference an `inactive`-status parent record (e.g., importing a truck assigned to an inactive employee) — open question.
- **Unauthorized zone data**: covered in §9.
- **Mass assignment / system-owned fields**: every phase in this program has independently proven and re-tested this exact class of defense (`created_by`, `zone_id` for non-admin, status fields, sequence-generated numbers) — the same discipline applies directly to import: an import row must never be allowed to set `id`, `created_by`, a sequence-generated number, or any other server-owned field.
- **Financial/historical records**: excluded from master-data import scope entirely per §6 — transactions are not master data and are not evaluated for import here.
- **Partial imports / transaction boundary / rollback**: genuinely unresolved (§15, Q15-17) — legacy's no-transaction-at-all approach is REJECTed, but the correct alternative (all-or-nothing vs. partial-success-with-report) is a real design choice with real tradeoffs, not obvious from precedent alone.
- **Dry-run/preview**: no precedent in either system. A real, demonstrated need (avoiding legacy's own "just try it and see the error list after the fact" experience) but not something to assume is in scope without a Decisions-stage lock.
- **Import idempotency / retry**: unaddressed by legacy; genuinely open.
- **File-size limits**: Phase 5's own 15MB document-upload limit is the closest existing precedent for *a* limit, but a master-data import file's appropriate size is a different question (row count matters more than byte size for a CSV) — open.
- **Malicious files / CSV injection on the *read* side**: distinct from the already-solved *write* side (`csvFormulaSafe()` protects export). A malicious CSV *upload* containing a formula-leading cell is not a formula-injection risk to the importing server (Postgres doesn't execute spreadsheet formulas), but if that same imported value is later re-exported unsanitized, the injection risk resurfaces downstream — meaning any Phase 6 export path must apply `csvFormulaSafe()`-equivalent sanitization to *all* string output, including imported data, not just directly-typed data.
- **Spreadsheet formula injection specifically on formats other than CSV** (XLSX can carry actual formula cells, not just formula-looking text) is a distinct, XLSX-specific risk category not covered by the CSV-focused `csvFormulaSafe()` pattern at all — if XLSX import/export is ever in scope, this needs its own explicit handling, likely requiring a dedicated XLSX-parsing library evaluated for known CVEs.

---

## 11. Export Risks

- **View ≠ export permission**: already established as a real, separately-enforced distinction in existing code (§8) — Phase 6 must not assume "if you can see it in a list, you can export it," and must make the export permission an explicit, independently-checked decision per entity.
- **Sensitive fields**: Employees carries fields already flagged `SENSITIVE_FIELDS` in `employees.js` (`photo`, `id_document`, `guarantor_name`, `guarantor_phone`, `notes`) — any Employees export must respect this existing, already-proven sensitivity classification, not invent a new one.
- **PII**: Customers carries phone/address/location fields; Employees carries the above. Both are real PII categories present in this schema today.
- **Financial data**: excluded from master-data export scope (§6) — but if reporting/financial export is ever touched by a future CR, the existing `reports.js` precedent (and its missing `csvFormulaSafe()` fix, §2.1) is directly relevant, not Phase 6's own problem to fix.
- **Export size / streaming vs. memory-based**: both existing V2 export endpoints (`audit.js`, `reports.js`) build the full CSV string in memory before sending (`res.send(csv)`), not streamed. This is a real, evidenced limitation of the existing pattern that Phase 6 would inherit if it reuses `toCsv()` as-is — fine at current data volumes (confirmed no complaint or incident found in either file's own comments), but a scaling risk if master-data export volumes ever grow large. Not assumed to be a blocker; flagged as a real, evidenced characteristic of the reusable pattern.
- **CSV injection on export**: solved once (`audit.js`), not yet applied everywhere (`reports.js` gap, §2.1) — Phase 6's own export must include this from its first version, not as a later hardening fix.
- **Export history/audit**: `reports.js`'s `report.export` audit action (recording category + row count) is a direct, reusable precedent — `logAudit()` on every export, recording entity/filter/row-count, mirrors this exactly.
- **Filename conventions**: both existing endpoints use `<entity>-<ISO-date>.csv` — a reusable, already-established convention.
- **Filtering / date ranges / pagination for large datasets**: `reports.js`'s export reuses the same period/zone filter logic as its own list endpoint — a reasonable pattern to mirror (export accepts the same filters as list, not a separate unfiltered dump) but the exact filter set per master-data entity is a design detail, not a business decision requiring Discovery-stage resolution.

---

## 12. Security Findings

Consolidated cross-reference of §10/§11's individual items against the standing security-review categories requested:

| Category | Finding |
|---|---|
| IDOR | No import/export endpoint exists yet to have this defect; the *pattern* to prevent it (re-check zone/role on every request, never trust a client-supplied ID for cross-entity assumptions) is already proven everywhere else in this program and directly reusable. |
| Zone leakage (export) | Real risk if a company-wide role's export omits the same zone-filtering their own list view already applies — `reports.js` gets this right (filters by `resolveUserZoneId()`), a directly reusable pattern. |
| Cross-zone import | A zone-scoped importer submitting rows tagged for a different zone must be rejected or forcibly corrected server-side (mirroring upload's own zone-force pattern from Phase 4/5) — not yet decided which (reject-the-row vs. force-correct), Business Owner question. |
| Mass assignment | Directly addressed pattern exists (server-owned field list per entity) — reusable. |
| Client-controlled IDs | No existing V2 create endpoint anywhere accepts a client-supplied primary key; import must not be the first exception. |
| System-owned fields | Same as mass-assignment — sequence numbers, `created_by`, timestamps are never client-supplied anywhere in this program. |
| Password/auth fields | Not applicable — none of the master-data candidate entities (§6) carry authentication credentials. `v2_users`/`customer_portal_accounts` are explicitly *not* included in the master-data inventory for this reason. |
| Financial history | Excluded from scope (§6). |
| Immutable records | No master-data candidate entity has an immutability rule as strict as Phase 4's ledger or Phase 5's void-only-never-delete pattern — but the general "no hard delete, status-flag instead" convention (§2.6) applies to any import-created row same as any manually-created one. |
| Audit bypass | Legacy's own bulk-import has zero audit call — the single most concrete, evidenced risk in this whole report; must not be repeated. |
| CSV/XLSX formula injection | Solved once for CSV-on-export (`csvFormulaSafe()`); not yet solved for XLSX in either direction, and not yet applied to a future Phase 6 export at all — both are real, unaddressed gaps to carry into Decisions. |
| Malicious upload files | Phase 5's MIME+extension-allowlist pattern (`documentStorage.js`) is directly adaptable to a CSV/XLSX import upload, though the allowed-type list would obviously differ (CSV/XLSX only, not PDF/images). |
| Resource exhaustion | No file-size or row-count limit exists to reuse from any prior phase for *this* shape of risk (byte-size limits exist for Phase 5 documents, but a 500,000-row CSV under 15MB is a different resource-exhaustion vector entirely) — open question. |
| Oversized imports/exports | Same as above — genuinely novel to this program, no existing precedent to reuse. |

---

## 13. Data Governance Findings

- **Canonical records / unique identifiers**: strong per-entity, evidenced in §6 — some entities have a clear natural key (zone_code, customer_number, plate_number, leave_types.code), others (Suppliers, Inventory Stores) have none at all today. This asymmetry is real, not assumed, and is the single largest blocker to designing a generic duplicate-detection mechanism without Business Owner input.
- **Active/inactive state, archival behavior**: already-proven `status` CHECK pattern across every entity; no governance gap found here — it's simply a matter of Phase 6 using the existing pattern, not inventing a new one.
- **Reference-data ownership** (who owns/maintains Zones vs. who owns Customers, etc.): no explicit ownership model exists in code beyond the RBAC role list itself — this is a genuine organizational/business question, not a technical one, and not answerable from code alone.
- **Correction procedures / bulk correction**: no precedent anywhere in V2 or legacy for a "bulk update via import" flow (legacy's own bulk-import is create-only, despite covering a scenario — "already-existing customers" — that might have benefited from update semantics). Whether import may ever update existing records is unresolved (§15, Q12-14).
- **Import provenance**: no V2 or legacy table records "this row was created via import, from file X, by user Y, at time Z" — this would be a new, additive concept if the Business Owner wants it; no existing table/column captures this today.
- **Company-wide vs. zone-scoped data**: already well-modeled in the existing schema (nullable `zone_id` convention) — directly reusable, not a gap.
- **History preservation**: consistent with §2.6 — no entity in this program has ever supported a true hard delete; import-created data should be expected to follow the same rule, though whether an import-created row is *itself* voidable/reversible as a batch (i.e., "undo this entire import") is a novel question with no precedent (§15, Q20).

---

## 14. Reuse / Adapt / Redesign / Reject / Defer Matrix

| Existing asset | Verdict | Why |
|---|---|---|
| `toCsv()` (`lib/reportsCalculations.js`) | **REUSE** | Proven, simple, correctly escapes quotes; CLOSED module, so Phase 6 would import/reuse it, never modify it in place |
| `csvFormulaSafe()` (`routes/audit.js`) | **ADAPT** (re-implement equivalently in Phase 6's own file — `audit.js` is CLOSED) | Correct, narrow, already-proven fix for a real found vulnerability |
| `reports.js`'s per-category `EXPORTABLE` role-allowlist pattern | **ADAPT** | Good shape (view ≠ export permission, explicit per-entity role list) to mirror for master-data export |
| `resolveUserZoneId()` / `ZONE_SCOPED_ROLES` pattern | **REUSE** | Identical mechanism already proven in every phase |
| Sequence-based numbering (`*_number_seq`) | **REUSE** (where an entity needs a business number) | Already the universal pattern; no reason to invent a different one for imported rows |
| Transaction/`FOR UPDATE` patterns | **REUSE** (shape), transaction-boundary specifics for bulk import | **DEFER** to Decisions — the *mechanism* is proven, the *scope* (per-row vs. whole-file transaction) is not decided |
| Legacy `POST /api/customers/bulk-import` overall implementation | **REJECT** | No duplicate detection, no transaction, no audit, no file validation, silent data coercion |
| Legacy's per-row partial-success + error-array reporting shape | **ADAPT** | The one genuinely reusable design element from an otherwise-rejected endpoint |
| Legacy's client-side-parses-the-file-then-POSTs-JSON approach | **REJECT** | Means the server never actually validates the uploaded file itself; any Phase 6 import should parse (and validate) the file server-side, mirroring Phase 5's own server-authoritative validation principle |
| Phase 5's MIME/extension-allowlist upload pattern | **ADAPT** | Directly applicable to a CSV/XLSX import upload, different allowed-type list |
| A generic polymorphic import/export module spanning every entity in one file | Evaluated, **not recommended** without a locked scope | Mirrors the exact "don't build unconstrained generic infrastructure speculatively" lesson already applied in Phase 5's own `document_attachments` design — better to scope MVP to specific entities a Business Owner actually names, not "all of them" |

---

## 15. Business Owner Decisions Required

Every item below cannot be answered from existing V2/legacy evidence and is explicitly not decided here.

1. What data qualifies as master data — does the §6 inventory match business intent, or should some (e.g., Groups, Routes) be excluded/included differently?
2. Which entities are importable in MVP — all of §6's list, or a narrower starting set?
3. Which entities are exportable in MVP — same question, independently.
4. Who may import — which roles, and is it uniform across entities or per-entity like `reports.js`'s export allowlist?
5. Who may export — same question.
6. Is export permission per-entity distinct from view permission (the codebase already treats them as separate technically — but *which* roles get which export rights is a business call, not a technical one)?
7. Which fields may an importer provide vs. which are always server-owned (needs a per-entity list, not a generic rule)?
8. What is the canonical identifier for Suppliers, Inventory Stores (currently none exist — a real blocker until named)?
9. How are duplicates detected — by canonical identifier where one exists, by name+phone (legacy's implicit approach for Customers), or something else per entity?
10. What happens to a detected duplicate row — reject it, skip it silently, merge it, or flag it for manual review?
11. Can existing records be updated through import, or is import strictly create-only (legacy precedent is create-only despite its own comment describing an update-shaped scenario)?
12. If updates are allowed, which fields may be updated, and does that reopen the "system-owned field" question per field, not just per entity?
13. Are upserts (create-or-update based on the canonical key) allowed, and if so, on what basis?
14. Is a dry-run/preview step required before a real import commits?
15. Is partial success allowed (some rows succeed, some fail, report both) or must the whole file succeed or fail atomically?
16. What transaction boundary applies — one transaction per file, one per row, or a batched hybrid?
17. How are import errors reported — inline in an API response (legacy's shape), a downloadable error report, or something else?
18. How is import provenance recorded — is a new "imported from file X by user Y at time Z" concept wanted, and if so, does it live on each row or in a separate import-job table?
19. How is rollback handled if an import needs to be reversed after commit — and does Phase 5's own soft-void pattern apply (an import-created row is voided, not deleted) or is a stronger "undo this whole import" concept needed?
20. Related — is "undo an entire import batch" itself a required capability, or only per-row correction after the fact?
21. How are cross-zone rows within a single import file handled — rejected, split into per-zone results, or is one file always scoped to exactly one zone?
22. How are references to inactive parent records handled during import (e.g., a truck row naming an inactive employee as driver)?
23. Which fields/records are immutable once imported (does anything import-created ever become as strictly immutable as Phase 4's ledger)?
24. What data must never be imported at all (passwords, financial transactions, anything already excluded from §6's inventory — likely a "confirm the exclusion list" question more than a new one)?
25. What sensitive fields must never be exported (Employees' already-flagged `SENSITIVE_FIELDS` is a starting point — does export follow that exact list, or a stricter/looser one)?
26. Which file formats are actually required — CSV only, or CSV+XLSX (which reopens the XLSX-specific formula-injection question from §10/§12)?
27. What file-size and/or row-count limits are required for import (byte-size alone, per Phase 5's precedent, is likely insufficient for a row-oriented risk — §12)?
28. What validation must happen before any DB write (this report identifies the *categories* of validation needed — §10 — but the exact per-entity rule set is a business/data-quality question)?
29. What audit events are required beyond the obvious import-completed/export-completed actions — per-row audit entries, or one summary entry per batch (mirrors `reports.js`'s own single-summary-entry precedent)?
30. Which governance policies (ownership, correction authority, bulk-correction authority) require a named Business Owner role, separate from the technical RBAC role list?

---

## 16. Recommended Scope

Not decided here — recorded as this Discovery's own recommendation for the Decisions stage to accept, modify, or reject:

- Start export before import (lower risk, real precedent already exists to extend, and delivers value — e.g., a Zones/Customers/Employees export — without any of the open duplicate-detection/upsert/transaction-boundary questions import requires).
- If import is included in the same MVP, scope it to entities that already have a genuine canonical identifier today (`zones`, `customers`, `trucks`, `leave_types` — all have a real UNIQUE business key) and explicitly exclude Suppliers/Inventory Stores from import MVP until Q8 is answered, rather than inventing a key for them unilaterally.
- Reuse `toCsv()` and an adapted `csvFormulaSafe()` from day one for any export capability — not a later hardening pass.
- Server-side file parsing and validation for any import (reject legacy's client-parses-then-POSTs-JSON shape) — consistent with Phase 5's own "server-authoritative validation" principle already proven.

## 17. Explicitly Deferred Scope

- XLSX support (both directions) — CSV-only is the safer, better-precedented starting format; XLSX reopens a distinct formula-injection risk class (§10/§12) with no existing mitigation pattern in this codebase.
- Any import/export touching a transactional entity (invoices, payments, debts, cashouts, procurement requests/POs, inventory movements, asset transfers) — these are excluded from the master-data inventory (§6) entirely, not merely deferred within it.
- Update/upsert-via-import — until Q11-13 are answered, MVP import (if authorized at all) should be assumed create-only, mirroring the one legacy precedent's own (otherwise-rejected) shape on this one specific point.
- Whole-import-batch undo (Q20) — a real, non-trivial feature with no existing precedent to build from.
- Import provenance tracking as a first-class, queryable concept (Q18) — genuinely new schema territory, not to be added speculatively.

## 18. Frozen-Module Impact Assessment

No modification to any frozen module was made or is proposed in this report. Every module named in the standing frozen list (Zones, Customers, Employees, Trucks, Collection Operations, Financial Billing, Cashout, Reports, Dashboard, Customer Portal, Complaints, Groups/Routes, Offline/Sync, Field Collector Mobile, Staff Notifications, Operational Calendar, Route/GIS/Map, Search, System Settings, Sidebar/Navigation UX, Document & File Management) was read-only inspected where relevant (Zones/Customers/Employees/Trucks/Groups/Routes for their schema; Reports and Audit for their export patterns; Documents for its upload-validation pattern) and none was written to. The one identified gap in a frozen module (`reports.js` missing `csvFormulaSafe()`, §2.1) is recorded as a **potential Future CR against Reports**, not implemented here and not assumed to be in Phase 6's own scope, since Reports itself is a different module's problem to fix under its own authorization.

## 19. Dependency Impact Assessment

The verified import order (§7) is the primary technical dependency this report establishes. No circular dependency was found among the master-data candidate tables. The one non-obvious dependency is `asset_register`'s optional reference to `purchase_orders` (a transactional table) — if Phase 6 import ever covers Assets, this single nullable FK is the one place a master-data import would need to reference a non-master-data table, and the simplest resolution (leave `purchase_order_id` unset on import, matching how the Inventory & Assets phase itself designed it as fully optional) requires no special handling — recorded as an observation, not a decision.

## 20. Proposed Next-Stage Boundary

Decisions should resolve, at minimum: the entity list for MVP export and (if included) import; the canonical-identifier question for Suppliers/Inventory Stores or their explicit exclusion; the transaction-boundary and partial-success model for import; the RBAC/zone rule for both import and export, per entity; the file-format decision (CSV-only vs. CSV+XLSX); and which of the 30 questions in §15 are locked now vs. explicitly deferred as Future CRs, following the exact same LOCKED/DEFERRED discipline already used in every prior phase's own Decisions document.

## 21. Discovery Conclusion

Sufficient, code-verified evidence exists to proceed to Decisions. No blocker was found that prevents Decisions from being written — every open item is a legitimate Business Owner question, not a missing technical fact Discovery failed to establish.

---

## Git / Safety Verification

- Starting HEAD: `b648590c39bc10e0d65890a64dd44cf4bf18ab5e` (confirmed via `git log -1` before this stage began)
- Working tree: clean at start; this report is the only file created during this stage
- Files inspected (read-only): `server/routes/audit.js`, `server/routes/reports.js`, `server/lib/reportsCalculations.js`, `server/routes/documents.js`, `server/routes/cashouts.js`, `server/routes/complaints.js`, `server/routes/employees.js`, `server/routes/customers.js` (indirectly, via schema query), `server/db.js` (schema/sequence definitions), `server/package.json`, `client/package.json`, `gurmad system/server/index.js` (legacy), live V2 PostgreSQL schema (tables, FKs, unique constraints, indexes) via direct query
- Files created: this report only
- Zero code changes, zero schema changes, zero dependency changes, zero production changes

---

## Final Status

**PHASE 6 — DISCOVERY PASS**

Production:
NOT AUTHORIZED — UNTOUCHED
