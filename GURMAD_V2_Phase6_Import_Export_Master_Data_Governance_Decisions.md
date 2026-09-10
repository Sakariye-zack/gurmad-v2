# GURMAD V2 — Phase 6: Import/Export + Master Data Governance — Decisions

**Status:** DECISIONS ONLY. No code, schema, dependency, or production changes were made during this stage.
**Baseline:** V2 HEAD `b648590c39bc10e0d65890a64dd44cf4bf18ab5e` (Phase 5 CLOSED/FROZEN), built directly on `GURMAD_V2_Phase6_Import_Export_Master_Data_Governance_Discovery_Report.md`.

---

## 1. Decision Summary

Phase 6 MVP is **export-first, CSV-only, create-only import for exactly four entities with a real existing canonical key** (`zones`, `customers`, `trucks`, `leave_types`) plus `inventory_items` with SKU made mandatory for import purposes only. Every entity lacking a genuine natural key (Suppliers, Inventory Stores, Employees, Groups, Routes, Asset Register) is **excluded from import MVP**, not assigned an invented key. Export MVP is broader — every non-transactional master-data entity Discovery identified, each behind its own explicit role/zone/sensitive-field rule, never inherited automatically from view permission. Import is a mandatory two-step dry-run-then-commit flow inside one atomic whole-file transaction — this single design choice resolves the transaction-boundary, partial-success, and error-reporting questions together, consistently. No upsert, no update-via-import, no whole-batch undo, no XLSX, no first-class provenance table, and no fix to Reports' own CSV-injection gap — all explicitly deferred as Future CRs, not silently dropped.

---

## 2. Business Owner Decisions — All 30, Classified

| # | Question | Classification |
|---|---|---|
| 1 | What data qualifies as master data? | **LOCKED** — §3 |
| 2 | Which entities are importable? | **LOCKED** — §3 |
| 3 | Which entities are exportable? | **LOCKED** — §3 |
| 4 | Who may import? | **LOCKED** — §15/§21 |
| 5 | Who may export? | **LOCKED** — §16 |
| 6 | Is export permission separate from view? | **LOCKED** — yes, §16 |
| 7 | Which fields may an importer provide? | **LOCKED** per entity — §15 |
| 8 | Canonical identifier for Suppliers/Inventory Stores | **DEFERRED / FUTURE CR** — §21, no key invented |
| 9 | How are duplicates detected? | **LOCKED** — §6 |
| 10 | What happens to a duplicate? | **LOCKED** — reject, §6 |
| 11 | Can import update existing records? | **LOCKED** — no, create-only, §7 |
| 12 | If updates allowed, which fields? | **NOT APPLICABLE** — §7 locks create-only |
| 13 | Are upserts allowed? | **LOCKED** — no, §7 |
| 14 | (duplicate of 12 in original numbering — protected fields under update) | **NOT APPLICABLE** — §7 |
| 15 | Is dry-run required? | **LOCKED** — yes, mandatory, §8 |
| 16 | Is partial success allowed? | **LOCKED** — no, whole-file atomic, §9 |
| 17 | What transaction boundary? | **LOCKED** — whole-file, §9 |
| 18 | How are import errors reported? | **LOCKED** — API response array, §10 |
| 19 | Is import provenance required? | **DEFERRED / FUTURE CR** for job-level provenance; **LOCKED** that row-level `created_by`/`created_at` already suffices as minimal provenance, §11 |
| 20 | Is rollback after commit needed? | **DEFERRED / FUTURE CR** — §12 |
| 21 | Is whole-import undo required? | **DEFERRED / FUTURE CR** — §12 |
| 22 | How are cross-zone rows handled? | **LOCKED** — one zone (or company-wide) per file, §13 |
| 23 | How are inactive references handled? | **LOCKED** — reject the row, §14 |
| 24 | Which records are immutable? | **LOCKED** — none newly immutable beyond existing per-entity rules, §15 |
| 25 | What must never be imported? | **LOCKED** — all transactional entities, all system-owned fields, §3/§15 |
| 26 | What sensitive fields must never be exported? | **LOCKED** — Employees' existing `SENSITIVE_FIELDS`, §16 |
| 27 | Which formats are required? | **LOCKED** — CSV only, §17 |
| 28 | What file-size/row limits are required? | **LOCKED** — §18 |
| 29 | What validation happens before DB writes? | **LOCKED** — 9-layer pipeline, §19 |
| 30 | What audit events are required? | **LOCKED** — §20 |
| — | Governance/ownership (organizational, not technical) | **DEFERRED** to Business Owner where no existing RBAC precedent answers it; **LOCKED** to mirror existing create-role RBAC where one already exists, §28 |

---

## 3. MVP Import Scope

**Importable (LOCKED):**

| Entity | Canonical key | Rationale |
|---|---|---|
| `zones` | `zone_code` (UNIQUE, existing) | Real key exists; root of dependency graph |
| `customers` | `customer_number` (UNIQUE, server-generated) | Real key exists — but see §15: `customer_number` itself is never client-supplied on import, exactly as it is never client-supplied on manual creation today |
| `trucks` | `plate_number` (UNIQUE, existing) | Real key exists |
| `leave_types` | `code` (UNIQUE, existing) | Real key exists |
| `inventory_items` | `sku` — **made mandatory for import only** (LOCKED, §22) | The column already exists and is already enforced unique when present; requiring it for import (not for manual creation, which is unchanged) is the narrowest possible use of an existing field, not an invented one |

**Excluded from import MVP (DEFERRED / FUTURE CR — no canonical key exists, none invented):**

| Entity | Reason |
|---|---|
| `suppliers` | No natural key at all (§21) |
| `inventory_stores` | No natural key at all (§21) |
| `employees` | No clean universal natural key (§23) — `user_id` is an account link, not a business identifier |
| `groups` | No natural key (§23) |
| `routes` | No natural key (§23) |
| `asset_register` | Depends on the above plus optionally `purchase_orders`; excluded entirely from import MVP (§24) |

**Excluded because transactional (confirmed, not reopened):** `invoices`, `payments`, `debts`, `cashouts`, `batches`, `tasks`, `inventory_movements`, `asset_transfers`, `attendance_records`, `payroll_periods`/`payroll_records`/`payroll_items`/`payroll_settlements`, `procurement_requests`, `purchase_orders`. **LOCKED** — none of these become importable master data under Phase 6.

## 4. MVP Export Scope

**Exportable (LOCKED)** — export carries a fundamentally lower risk profile than import (no duplicate-detection or identity question), so the scope is broader than import:

`zones`, `customers`, `employees`, `trucks`, `suppliers`, `inventory_items`, `inventory_stores`, `leave_types`, `groups`, `routes`. `asset_register` is **also exportable** (export doesn't require a canonical key the way import does) — LOCKED.

Transactional entities remain excluded from Phase 6 export scope (they are not master data; any future transactional export is a separate, differently-scoped effort, consistent with the existing `reports.js` module already covering that ground for financial data).

---

## 5. Canonical Identifier Rules

**LOCKED** (restating §3's table as the authoritative rule): a canonical identifier is a pre-existing, already-unique-constrained database column — never a newly invented one. Where none exists, the entity is excluded from import, not assigned a workaround key. This rule itself is the direct, explicit answer to Discovery's own flagged blocker — it resolves the ambiguity by exclusion, not invention.

---

## 6. Duplicate Rules

**LOCKED**:
- **Within-file duplicates**: two rows in the same import file sharing the same canonical-key value → the second (and any subsequent) occurrence is a validation failure for that row, reported at dry-run time, never silently deduplicated.
- **Existing-DB duplicates**: an imported row whose canonical-key value already exists in the database → **rejected** (validation failure), never overwritten, merged, or silently skipped-as-success.
- **No automatic merge** — confirmed explicitly prohibited per the authorization's own instruction; not implemented, not deferred as a maybe — permanently out of scope unless a future, explicit Business Owner decision authorizes it as its own CR.
- **"Skip" vs. "reject" for a whole file containing some duplicates**: a duplicate row is a **failed row**, not a file-level failure — per §9's whole-file-atomic model, this means **any duplicate row anywhere in the file blocks the entire commit** (dry-run would have already surfaced it before the user ever attempts to commit).

---

## 7. Create/Update/Upsert Rules

**LOCKED: create-only.** Import in Phase 6 MVP may only insert new rows. It may never update, upsert, or overwrite an existing record's fields. This directly satisfies Discovery's own recommendation and the authorization's explicit default. Update/upsert-via-import is **DEFERRED / FUTURE CR — IMPORT UPDATE/UPSERT SEMANTICS**, to be scoped only once a Business Owner explicitly defines per-field update permissions, canonical-key matching rules, and protected-field lists for whichever entity needs it.

---

## 8. Dry-Run Rules

**LOCKED: dry-run is mandatory, not optional.** Every import is a two-step flow: (1) `POST .../import/validate` (or equivalent) runs the full validation pipeline (§19) against the uploaded file and returns a per-row pass/fail report **without writing anything to the database** — no `INSERT`, no sequence advancement, no audit log entry, no side effect of any kind; (2) a separate, explicit commit step actually performs the import, and is only permitted if the file being committed is unchanged since its own successful dry-run (exact mechanism — e.g., a short-lived validation token — is an Implementation Specification detail, not decided here). This single design choice is what makes §9's "no partial success" rule safe in practice: by the time a user commits, they already know every row will succeed.

---

## 9. Transaction Rules

**LOCKED: whole-file atomic transaction, no partial success.** One `BEGIN`/`COMMIT`/`ROLLBACK` wraps the entire file's inserts. If any row fails at commit time (which should be rare, since dry-run already validated the file — but the database itself is the final authority, e.g. a race condition where a duplicate was created by someone else between dry-run and commit), the **entire transaction rolls back** and zero rows are written. This is a direct, explicit rejection of legacy's no-transaction approach and a direct, explicit rejection of the "some rows succeed, some fail" alternative — chosen because it is the simpler, safer default consistent with every other multi-row transactional pattern already proven in this program (Phase 3's PO+items, Phase 4's transfer pair), and because the mandatory dry-run (§8) already gives users the information a partial-success model would otherwise exist to provide.

---

## 10. Error Reporting

**LOCKED: API response only, not a downloadable CSV, for MVP.** Both the dry-run and (on failure) the commit endpoint return a JSON array of `{ row, field, error }` objects — an explicit ADAPT of legacy's own `{row, error}` shape, extended with a `field` key for more precise error targeting (a technical refinement, not a new business rule). A downloadable error-report CSV is **DEFERRED / FUTURE CR — DOWNLOADABLE IMPORT ERROR REPORTS**, not required for MVP since the mandatory dry-run keeps the relevant file small enough (bounded by §18's row limit) to review inline.

---

## 11. Provenance

**LOCKED (minimal, free)**: every imported row carries the same `created_by`/`created_at` columns every manually-created row already carries in every existing table — the importing user's ID and the commit timestamp. This is not new infrastructure; it is the existing universal convention, applied unchanged.

**DEFERRED / FUTURE CR — FIRST-CLASS IMPORT PROVENANCE**: a dedicated concept (source filename, an `import_jobs` table, a job ID linking every row it created, per-row-level provenance beyond the standard `created_by`) is explicitly not built in MVP, per Discovery's own recommendation against speculative new schema.

---

## 12. Rollback/Undo

**LOCKED**: only **row-level correction** is available post-commit — an imported row that needs correction is edited or archived exactly the same way any manually-created row of that entity already is today (via that entity's own existing, unchanged CRUD/status endpoints — Phase 6 adds no new correction mechanism).

**DEFERRED / FUTURE CR — WHOLE-IMPORT UNDO**: a "reverse this entire batch" capability is not built in MVP. No precedent exists in this codebase for it, and building it speculatively would be exactly the over-engineering this program's standing rules warn against.

---

## 13. Zone Rules

**LOCKED**:
- **Gudoomiye / Zone Accountant** (where the entity is zone-scoped and either role is otherwise permitted to import it, per §15's per-entity table): the import's target zone is **always server-resolved** from `resolveUserZoneId(req.user)`, identical to the mechanism proven in every prior phase. Any zone value present in the uploaded file for these roles is **ignored**, never trusted.
- **Admin**: an import file targets **exactly one zone, or is explicitly company-wide** (for entities that support a nullable/company-wide zone) — selected once, outside the file itself (e.g., a form field alongside the file upload), applied to every row in that file. A single file may **not** mix rows destined for different zones. This is the simplest, safest interpretation consistent with keeping MVP scope narrow — mixed-zone-per-row files are **DEFERRED / FUTURE CR — MIXED-ZONE IMPORT FILES**.
- **Export**: company-wide roles (Admin, Head of Cashiers, Cashier — per each entity's own existing view-role zone treatment) may export across all zones or filter to one; zone-scoped roles (Gudoomiye, Zone Accountant) may only ever export their own zone's data — mirrors `reports.js`'s own already-proven export-zone-filtering pattern exactly. **LOCKED**, no cross-zone leakage permitted under any circumstance.

---

## 14. Inactive Reference Rules

**LOCKED**: if an imported row references a parent record (e.g., a truck import naming a driver `employee_id`) that is `inactive`/non-`active`-status, archived, voided, or does not exist at all — the row **fails validation** (surfaced at dry-run) and is never inserted. Import never automatically reactivates, resurrects, or otherwise mutates the referenced parent record. This is the fail-safe default explicitly required by the authorization and consistent with every other module's own "never silently work around a data-quality signal" precedent.

---

## 15. Field Ownership

**LOCKED**, per the five MVP-importable entities. In every case, the following are always server-owned regardless of entity: `id`, `created_by`, `created_at`, `updated_at` (where present), any sequence-generated business number, `status` (always defaults to that entity's own existing default — never client-set to anything else via import), and — for zone-scoped roles — `zone_id`.

| Entity | Client-importable fields | Explicitly server-owned (never import-provided) |
|---|---|---|
| `zones` | `zone_code`, `name`, and any other non-system descriptive field already accepted by the existing `POST /zones` endpoint | `id`, `created_by`, `created_at` |
| `customers` | `name`, `phone`, address-shape fields, `category`, `group_id`/`route_id` (validated to exist), `zone` (admin only, per §13) | `id`, `customer_number` (sequence-generated, exactly as today), `created_by`, `created_at`, `status`, `payment_status`, `zone` for Gudoomiye (server-resolved) |
| `trucks` | `plate_number`, descriptive/spec fields already accepted by `POST /trucks`, `zone_id` (admin only) | `id`, `created_by`, `created_at`, `status`, `zone_id` for Gudoomiye |
| `leave_types` | `code`, `name`, descriptive fields already accepted by `POST /leave-types` | `id`, `created_by`, `created_at` |
| `inventory_items` | `sku` (mandatory for import, §22), `name`, `category`, `unit_of_measure`, `reorder_level` | `id`, `created_by`, `created_at`, `status` |

The exact full field list per entity (every column the existing create endpoint already accepts) is an Implementation Specification detail — this table locks the **ownership boundary principle** (system fields never client-set) and the **canonical-key/status/zone** specifics explicitly, which is what actually matters for security.

---

## 16. Export Permissions

**LOCKED — export is never inherited from view access; each entity gets its own explicit export rule**, mirroring `reports.js`'s own proven `EXPORTABLE[category].roles` pattern:

| Role | Export rights |
|---|---|
| Admin | May export any MVP-exportable entity (§4), company-wide |
| Gudoomiye | May export the same entities they may already **view** in their own existing modules (Customers, Trucks, etc.), own-zone only |
| Zone Accountant | Same as Gudoomiye — own-zone, view-parity entities only |
| Head of Cashiers | **DEFERRED / FUTURE CR** — no existing precedent in this codebase grants this role master-data view/export rights beyond financial reporting (`reports.js`'s own `FINANCIAL_ROLES`); extending it to master-data export requires its own Business Owner decision, not assumed here |
| Cashier | **DEFERRED / FUTURE CR** — same reasoning as Head of Cashiers |
| Collector | **LOCKED — zero export rights**, consistent with zero access to every other administrative module in this program |

**Sensitive fields (LOCKED)**: Employees export **excludes** `photo`, `id_document`, `guarantor_name`, `guarantor_phone`, `notes` by default — the exact, already-established `SENSITIVE_FIELDS` list from `employees.js`, reused verbatim, not reinvented. Whether any role may ever export the full sensitive set is **DEFERRED / FUTURE CR — SENSITIVE EMPLOYEE FIELD EXPORT**.

---

## 17. File Format

**LOCKED: CSV only for MVP.** XLSX (both import and export) is **DEFERRED / FUTURE CR — XLSX IMPORT/EXPORT**, explicitly because of the distinct formula-injection risk class Discovery identified (an actual formula cell, not just formula-looking text) that has no existing mitigation pattern in this codebase and would require a new parsing dependency this stage is not authorized to add.

---

## 18. Size/Resource Limits

**LOCKED** (not inherited from Phase 5's document-upload limit, per the explicit instruction):
- Maximum import file size: **5 MB** — a CSV of master-data rows is far denser per byte than a scanned document; 5MB comfortably covers many thousands of rows of typical master-data width.
- Maximum row count per import file: **5,000 rows**.
- Maximum columns: bounded by each entity's own locked field allowlist (§15) — any column in the uploaded file not on that allowlist is itself a validation failure (an unrecognized column is rejected, not silently ignored — prevents a client from attempting to smuggle a server-owned field name into the file).
- Resource/timeout policy: import validation and commit both run synchronously within the existing request/response cycle — no background job queue is introduced in MVP. If the 5,000-row cap combined with the validation pipeline (§19) is ever found to risk a request timeout in practice, background/async import processing is **DEFERRED / FUTURE CR — ASYNCHRONOUS IMPORT PROCESSING**, not built speculatively now.
- Exceeding any limit: the file is rejected outright (400) before any row-level processing begins — identical fail-fast principle to every existing upload validation in this program (Phase 5's MIME/size checks reject before any disk write).

---

## 19. Validation Rules

**LOCKED — all nine layers apply, in this order, for every import**, directly adopting Discovery's own proposed framework as the binding pipeline:

1. **File validation** — correct MIME/extension (`.csv`/`text/csv` only, §17), within size/row limits (§18).
2. **Structural validation** — header row present and matches the entity's expected column set exactly (§15/§18 — unrecognized or missing required columns reject the whole file before any row is evaluated).
3. **Field validation** — per-cell type/format/required checks (mirrors every existing single-record create endpoint's own validation for that entity — not a new rule set, the same one already enforced today, just applied per row).
4. **Canonical-key validation** — the row's canonical-key value is present, well-formed, and non-empty (§5).
5. **Duplicate validation** — within-file and against-DB (§6).
6. **Foreign-key validation** — every referenced parent record exists (§14).
7. **Zone authorization** — the resolved target zone is one the importing user is actually permitted to write to (§13).
8. **Business-rule validation** — any entity-specific rule already enforced by that entity's own existing create endpoint (e.g., whatever `POST /trucks` already validates today applies identically to an imported truck row).
9. **DB constraint validation** — the final authority; even after 1-8 pass, an actual `INSERT` at commit time is still subject to the real database CHECK/UNIQUE/FK constraints, and any constraint violation at that point fails the whole transaction (§9).

No row ever reaches the database merely because its CSV syntax parses — this is the explicit, direct answer to the authorization's own stated principle.

---

## 20. Audit Rules

**LOCKED**:
- **Import**: **one summary audit entry per commit** (not per-row) — `action: 'import.commit'` (or equivalent), recording actor, entity, filename, target zone, total row count, and success count (which, per §9's atomic model, equals total row count for any committed import — a partial count would only ever appear on a rejected/rolled-back attempt, which itself is not separately audited as a "commit," only the dry-run's own failure is visible to the user in the moment). Per-row audit entries are **DEFERRED / FUTURE CR — PER-ROW IMPORT AUDIT GRANULARITY** — mirrors `reports.js`'s own single-summary-entry precedent for a bulk action, not a new pattern.
- **Export**: **one audit entry per export**, mirroring `reports.js`'s own `report.export` action exactly — actor, entity, applied filters/zone scope, row count, timestamp. **LOCKED**.
- Both reuse the existing `logAudit()` infrastructure exclusively — no second audit system, no new audit table.

---

## 21. Entity-by-Entity Governance — Suppliers / Inventory Stores

**LOCKED: Option A — excluded from import MVP** (per §3), because no natural/business unique key exists for either entity and none is invented. This is the direct, explicit resolution required by the authorization's own §21 instruction. Manual creation of Suppliers and Inventory Stores continues exactly as today (Phase 3/Phase 4's own existing, unchanged create endpoints) — only bulk *import* is excluded, not the entities' existence or manual manageability. **DEFERRED / FUTURE CR — SUPPLIER/INVENTORY STORE CANONICAL KEY**, to be scoped only once a Business Owner names an actual business identifier for either (e.g., a supplier registration number, a store code) — Phase 6 does not propose one.

---

## 22. Entity-by-Entity Governance — Inventory Items

**LOCKED**: SKU is made **mandatory for import** (not for manual creation via the existing UI/API, which is unchanged) — an inventory-item row in an import file without a SKU value fails validation. Name is explicitly **not** treated as a canonical key on its own (per the authorization's own instruction not to assume this) — two items with the same name but different SKUs are two distinct, valid imports; two items with the same SKU are a duplicate (§6), regardless of name.

---

## 23. Entity-by-Entity Governance — Employees / Groups / Routes

**LOCKED: excluded from import MVP** (§3) — no clean universal natural key exists for any of the three, and per the authorization's explicit instruction, a surrogate database ID is **not** used as a human-facing import key. **DEFERRED / FUTURE CR — EMPLOYEE/GROUP/ROUTE IMPORT**, pending a Business Owner decision on what canonical identifier (if any) should be introduced for these entities — Phase 6 does not propose one (e.g., inventing an "employee code" column would itself be exactly the kind of unauthorized schema/business-rule invention this stage must not perform).

---

## 24. Entity-by-Entity Governance — Asset Register

**LOCKED: Asset Register import is excluded entirely from Phase 6 MVP** (§3) — it depends on `inventory_stores` and `suppliers` (both themselves excluded, §21) and `employees` (also excluded, §23), so even setting aside its own lack of a canonical key, its import would be blocked transitively by those exclusions regardless. Its optional `purchase_order_id` reference is moot for the same reason — no Asset import path exists in MVP for the question of whether to permit that field to even arise. **DEFERRED / FUTURE CR — ASSET REGISTER IMPORT**, to be scoped together with whichever of §21/§23's dependent-entity Future CRs are eventually authorized, not independently.

---

## 25. Import Dependency Order

**LOCKED, applied to the actual MVP-importable set** (not Discovery's full theoretical order, since several entities in that order are excluded per §3): because the 5 MVP-importable entities (`zones`, `customers`, `trucks`, `leave_types`, `inventory_items`) have the following real dependency relationships among themselves — `customers` → `zones`; `trucks` → `zones` (and → `employees`, which is not itself imported, but an imported truck may still *reference* an existing, manually-created employee, per §14's "must exist and be active" rule) — the enforced order for any environment importing multiple entities in sequence is:

1. `zones`
2. `leave_types`, `inventory_items` (independent of the above and of each other)
3. `trucks` (requires `zones` to exist; references existing `employees` rows, not imported ones)
4. `customers` (requires `zones` to exist; may reference existing `groups`/`routes` rows, not imported ones, since those are excluded from MVP import)

Each entity's import remains its own independent operation (its own file, its own dry-run/commit) — Phase 6 does not build a single combined multi-entity batch importer; the above order is guidance for an operator running multiple imports in sequence, not a technical requirement enforced by one unified job.

---

## 26. Export Design

**LOCKED**:
- **Reuse `toCsv()`** from `lib/reportsCalculations.js` verbatim (import it, do not modify the CLOSED Reports module).
- **Adapt `csvFormulaSafe()`** from `audit.js` — re-implement the identical sanitization logic inside Phase 6's own new file(s), since `audit.js` itself is CLOSED/FROZEN and must not be edited or exported-from as a shared module boundary was never established there.
- **Phase 6 export must apply this sanitization to every exported entity from its first version** — explicitly not repeating the gap already found in `reports.js` (§27).
- Filename convention: `<entity>-<ISO-date>.csv`, mirroring both existing precedents exactly.
- Zone filtering: applied before any row is serialized to CSV, per §13.
- Field allowlist: only the fields each entity's own export rule (§16) permits are ever serialized — sensitive fields are never fetched from the database in the first place for a role not permitted to see them, not merely filtered out after the fact (defense in depth, matching every existing SELECT-field-list discipline already used throughout this program).
- Large-result behavior: in-memory CSV construction (matching both existing precedents) is accepted for MVP; true streaming export is **DEFERRED / FUTURE CR — STREAMING EXPORT**, to be revisited only if a real scale problem is demonstrated.

---

## 27. Reports Module Gap

**LOCKED — explicitly not fixed in Phase 6.** `reports.js`'s own `/:category/export.csv` endpoint does not apply `csvFormulaSafe()`-equivalent sanitization. This is recorded, per the authorization's own explicit instruction, as:

**FUTURE CR — REPORTS CSV EXPORT FORMULA INJECTION HARDENING**

Reports is CLOSED/FROZEN; Phase 6 does not touch it under any circumstance. This entry exists purely so the finding is not lost, not as an invitation to act on it now.

---

## 28. Master Data Governance

**LOCKED where existing RBAC already answers the question — DEFERRED where it is purely organizational:**

- **Who may create each entity via import**: **LOCKED to mirror that entity's own existing, unchanged manual-creation role**, confirmed live from each module's own current `POST` route: `zones` → `admin` only; `customers` → `admin` + `gudoomiye`; `trucks` → `admin` + `gudoomiye`; `leave_types` → `admin` only; `inventory_items` → `admin` only (all four values independently re-verified against the live route files during this Decisions pass, not assumed from memory). Import introduces no role that could not already create that entity manually today.
- **Who may update/deactivate/archive**: **NOT APPLICABLE to import** (§7 — create-only); each entity's existing update/status endpoints are entirely unchanged by Phase 6.
- **Who may correct an imported row after the fact**: same as who may update that entity manually today — no new correction authority introduced (§12).
- **Who may perform bulk correction**: **DEFERRED / FUTURE CR** — no bulk-correction capability of any kind exists in this program today; Phase 6 does not introduce one.
- **Business Owner approval for individual imports (a review/approval workflow before commit)**: **DEFERRED / FUTURE CR — IMPORT APPROVAL WORKFLOW** — no precedent exists for a multi-party approval gate on any create action in this codebase (every existing create endpoint is single-actor); inventing one for import specifically would be new governance policy, explicitly out of this stage's authority to decide unilaterally.
- **Does governance differ by entity beyond the above**: not found to, beyond the already-locked per-entity role table — no further differentiation is invented.

---

## 29. No Generic Over-Engineering

**LOCKED**: Phase 6 does not build a universal "import anything / export anything" framework. Every entity's import/export is explicitly enumerated (§3/§4), with its own explicit field allowlist (§15), explicit role list (§16/§28), explicit zone rule (§13), explicit validation pipeline (§19, entity-specific at layer 3/8), and explicit audit event (§20). Any shared code (the validation-pipeline shape, the `toCsv()` reuse, the dry-run-then-commit flow) is a shared *mechanism*, not a shared *unconstrained surface* — adding a sixth importable entity in the future requires its own explicit field/role/zone/validation definition, not merely registering a new table name against a generic engine.

---

## Deferred / Future CR Items (consolidated)

1. FUTURE CR — IMPORT UPDATE/UPSERT SEMANTICS (§7)
2. FUTURE CR — DOWNLOADABLE IMPORT ERROR REPORTS (§10)
3. FUTURE CR — FIRST-CLASS IMPORT PROVENANCE (§11)
4. FUTURE CR — WHOLE-IMPORT UNDO (§12)
5. FUTURE CR — MIXED-ZONE IMPORT FILES (§13)
6. FUTURE CR — ASYNCHRONOUS IMPORT PROCESSING (§18, contingent on a demonstrated need)
7. FUTURE CR — XLSX IMPORT/EXPORT (§17)
8. FUTURE CR — HEAD OF CASHIERS / CASHIER MASTER-DATA EXPORT RIGHTS (§16)
9. FUTURE CR — SENSITIVE EMPLOYEE FIELD EXPORT (§16)
10. FUTURE CR — SUPPLIER/INVENTORY STORE CANONICAL KEY + IMPORT (§21)
11. FUTURE CR — EMPLOYEE/GROUP/ROUTE CANONICAL KEY + IMPORT (§23)
12. FUTURE CR — ASSET REGISTER IMPORT (§24)
13. FUTURE CR — PER-ROW IMPORT AUDIT GRANULARITY (§20)
14. FUTURE CR — STREAMING EXPORT (§26)
15. FUTURE CR — REPORTS CSV EXPORT FORMULA INJECTION HARDENING (§27) — against a frozen module, not Phase 6's own scope
16. FUTURE CR — IMPORT APPROVAL WORKFLOW (§28)
17. FUTURE CR — BULK CORRECTION AUTHORITY (§28)

---

## Frozen Module Protection

**LOCKED — confirmed, not reopened.** Zones, Customers, Employees, Trucks, Collection Operations, Financial Billing, Cashout, Reports, Dashboard, Customer Portal, Complaints, Groups/Routes, Offline/Sync, Field Collector Mobile, Staff Notifications, Operational Calendar, Route/GIS/Map, Search, System Settings, Sidebar/Navigation UX, and Document & File Management all remain CLOSED/FROZEN. This Decisions stage only read each module's own existing role-guard code (`routes/zones.js`, `routes/customers.js`, `routes/trucks.js`, `routes/leaveTypes.js`, `routes/inventory.js`) to ground §28's role table in live evidence — zero modification was made to any of them.

---

## Production Boundary

Production remains: **NOT AUTHORIZED — UNTOUCHED.** No deployment, migration, or infrastructure action was taken or proposed during this stage.

---

## Final Decision Status

**PHASE 6 — DECISIONS COMPLETE — READY FOR IMPLEMENTATION SPECIFICATION**

Production:
NOT AUTHORIZED — UNTOUCHED
