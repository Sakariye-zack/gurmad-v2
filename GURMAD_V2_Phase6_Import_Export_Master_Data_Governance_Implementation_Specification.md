# GURMAD V2 — Phase 6: Import/Export + Master Data Governance — Implementation Specification

## 1. Specification Status

SPECIFICATION ONLY. No code, schema, dependency, route, frontend, or production change was made during this stage.

## 2. Baseline

V2 HEAD `b648590c39bc10e0d65890a64dd44cf4bf18ab5e` (Phase 5 CLOSED/FROZEN). Built strictly on `GURMAD_V2_Phase6_Import_Export_Master_Data_Governance_Decisions.md`, which is authoritative — nothing here reinterprets, weakens, or expands any LOCKED decision. No conflict between a locked decision and an implementation-detail requirement was found during this pass; if one had been, this document would stop and report it rather than resolve it silently (per the authorization's own instruction) — none arose.

## 3. Scope

**Import (exactly 5 entities, create-only, CSV-only):** Zones, Customers, Trucks, Leave Types, Inventory Items.
**Export (11 entities):** the 5 import entities plus Suppliers, Inventory Stores, Employees, Groups, Routes, Asset Register.
No other entity becomes importable or exportable. No transactional entity is in scope. No canonical identifier is invented for any excluded entity.

---

## 4. Architecture

Two new, isolated modules, following the exact separation-of-concerns discipline already proven in every prior phase (e.g., Phase 4's `inventoryCalculations.js` vs. `routes/inventory.js`; Phase 5's `documentStorage.js` vs. `routes/documents.js`):

- **`server/lib/csvImportExport.js`** — shared, entity-agnostic mechanics: CSV parsing (RFC 4180-compliant), `toCsv`-compatible serialization reuse, the `csvFormulaSafe()` adaptation, generic row-batching helpers. Contains **no** entity-specific business logic and **no** entity allowlist by itself — it is the shared *mechanism*, never a generic "import anything" surface (Decisions §29).
- **`server/lib/masterDataEntities.js`** — the explicit per-entity registry: for each of the 5 import entities and 11 export entities, a plain object naming its table, canonical key, field maps (§17/§18), role list, zone behavior, and FK-check functions. This is the "explicit entity allowlist" Decisions §29 requires — new entities are added by extending this registry with their own explicit definition, never by a generic pass-through.
- **`server/routes/masterDataImportExport.js`** — the single new route file exposing the API surface (§8), consuming both lib files. One file, not one file per entity, since the request/response shape is uniform across entities even though the field maps are not.

No modification to any existing route file, table, or frontend file outside these new additions plus the two additive router-registration lines (`server/index.js`) and the additive frontend files (§19).

---

## 5. Import Architecture

```
Upload CSV → File validation → Parse → Structural validation
  → Per-row: field validation → canonical-key validation
  → Duplicate validation (within-file, against-DB)
  → FK validation → Zone authorization → Business-rule validation
  → [DRY-RUN STOPS HERE — returns report, writes nothing]
  → [COMMIT: same 9 layers re-run inside one transaction]
  → BEGIN → INSERT all rows → logAudit (1 summary entry) → COMMIT
  → ROLLBACK on any single-row failure at commit time
```

Every layer is entity-driven by the `masterDataEntities.js` registry entry for whichever entity the request targets — there is no cross-entity code path.

## 6. Export Architecture

```
Request (entity + filters) → Role/zone authorization (independent of any view permission)
  → Build SELECT restricted to that entity's export field allowlist (sensitive/server fields never fetched)
  → Apply zone filter (server-resolved for zone-scoped roles, requested-or-all for company-wide roles)
  → Apply entity-specific filters (§19)
  → csvFormulaSafe() every string cell → toCsv() → logAudit (1 summary entry) → stream response
```

In-memory construction (not true streaming) per Decisions §26 — explicitly not a scalability architecture, by design, for MVP.

---

## 7. API Contracts

Base path: `/api/v2/master-data` (new, does not collide with any existing mount).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/:entity/import/validate` | Dry-run. Parses + validates the uploaded CSV against all 9 layers. Writes nothing. Returns a validation report + an opaque, server-signed validation token. |
| `POST` | `/:entity/import/commit` | Commits. Requires the exact file (re-hashed) plus the validation token from a still-fresh, matching `/validate` call. Re-runs all 9 layers inside the commit transaction (never trusts the token alone as proof — see §13). |
| `GET` | `/:entity/export` | Streams a CSV of the requested entity, filtered/scoped per §16/§19. |

`:entity` is restricted to the registry's own key set (`zones`, `customers`, `trucks`, `leave-types`, `inventory-items` for import; those five plus `suppliers`, `inventory-stores`, `employees`, `groups`, `routes`, `asset-register` for export) — an unrecognized `:entity` value is a `404`, not a pass-through to a generic handler.

### 7.1 `POST /:entity/import/validate`

- **Auth**: `authenticateToken` + `requireRole(...)` per §15's import role matrix for that entity.
- **Request**: `multipart/form-data`, one field `file` (the CSV), one field `zone_id` (required for zone-scoped entities when the actor is Admin; ignored/overridden for Gudoomiye/Zone Accountant per §12) or `company_wide: true` where the entity supports it.
- **Response `200`**:
  ```json
  {
    "data": {
      "valid": true,
      "rowCount": 42,
      "validationToken": "<opaque, short-lived, server-signed>",
      "expiresAt": "<ISO timestamp>",
      "errors": []
    }
  }
  ```
  On validation failure (`valid: false`), `errors` is populated per §15 (the error model) and `validationToken` is omitted — an invalid file cannot produce a usable token.
- **Response `400`**: file-layer failure (wrong MIME/extension, over size/row limits, malformed CSV, missing/unexpected columns) — fails before any row-level processing, per §12's layer-1/2 fail-fast rule.
- **Response `403`**: role or zone authorization failure.
- **No DB write, no sequence advancement, no audit entry, no timestamp mutation of any kind** — confirmed as the literal contract, not merely a guideline (§13.4).

### 7.2 `POST /:entity/import/commit`

- **Auth**: identical role/zone check, re-run independently (never trusts the dry-run's own authorization result as still valid — the actor could have had their role changed between calls).
- **Request**: identical `multipart/form-data` shape (the **same file**, re-uploaded — not a "commit by token alone" flow) plus `validationToken`.
- **Server-side commit gate** (§13): the server (a) re-computes a SHA-256 hash of the freshly uploaded file and compares it to the hash embedded in the token's own signed payload — mismatch → `409 Conflict` ("file has changed since validation"); (b) re-checks the token's expiry and signature; (c) **regardless of (a)/(b) passing, re-runs the full 9-layer validation pipeline from scratch inside the commit transaction** — the token proves "this exact file was seen and passed as of time T," it is never trusted as a substitute for revalidation, closing exactly the "insecure `dryRun=true` flag" anti-pattern the authorization explicitly warns against.
- **Response `201`**:
  ```json
  { "data": { "entity": "customers", "created": 42, "auditId": 12345 } }
  ```
- **Response `409`**: token/file mismatch, expired token, OR any row fails re-validation at commit time (the whole transaction rolls back — §14).
- **Response `403`**: role/zone failure.

### 7.3 `GET /:entity/export`

- **Auth**: `authenticateToken` + `requireRole(...)` per §16's independent export matrix (never derived from any view-role list).
- **Query params**: entity-specific filters (§19), plus `zone_id` (ignored/forced for zone-scoped roles, optional filter for company-wide roles).
- **Response `200`**: `Content-Type: text/csv`, `Content-Disposition: attachment; filename="<entity>-<ISO-date>.csv"`.
- **Response `403`**: role/zone failure — including the case where the entity has zero export-permitted roles (Head of Cashiers/Cashier on entities where that right is deferred, §16) — those roles receive `403` on every call, not a partial/empty CSV.

---

## 8. Authentication/RBAC

Uses the existing `authenticateToken`/`requireRole` middleware unchanged (`server/middleware/auth.js`, CLOSED, not modified). Every role check happens before any file is even read into memory (mirrors Phase 5's own auth-before-multer-processing order).

### 8.1 Import Role Matrix (LOCKED, Decisions §15/§28 — verified against each entity's own live create-route role guard)

| Entity | Import roles | Verified against |
|---|---|---|
| Zones | `admin` | `routes/zones.js:121` |
| Customers | `admin`, `gudoomiye` | `routes/customers.js:364` |
| Trucks | `admin`, `gudoomiye` | `routes/trucks.js:217` (`WRITE_ROLES`) |
| Leave Types | `admin` | `routes/leaveTypes.js:20` |
| Inventory Items | `admin` | `routes/inventory.js:80` (`ADMIN_ONLY`) |

No other role may import any entity. `zone_accountant`, `head_of_cashiers`, `cashier`, `collector` are never granted import rights anywhere in this specification.

### 8.2 Export Role Matrix (LOCKED, Decisions §16)

| Role | Export rights |
|---|---|
| `admin` | All 11 export entities, company-wide |
| `gudoomiye` | Entities they already view in their own existing modules (Customers, Trucks), own-zone only. Company-wide entities without a zone concept (Leave Types, Suppliers) — export allowed, unscoped, since there is no zone to restrict |
| `zone_accountant` | Same as `gudoomiye` |
| `head_of_cashiers` | **No export rights in MVP** — deferred (Decisions §16); every export call from this role returns `403` |
| `cashier` | **No export rights in MVP** — same as above, deferred |
| `collector` | **No export rights** — zero access, consistent with every other module |

---

## 9. Zone Scoping

Reuses `resolveUserZoneId(user)` — the identical function signature already implemented independently in `routes/inventory.js`, `routes/procurement.js`, and `routes/documents.js` — re-implemented once more here (not imported cross-module, since none of those three exposes it as a shared library function; each phase has always locally defined its own copy, and this specification follows that same established precedent rather than introducing a new shared-module coupling between CLOSED files).

`ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant']` for both import and export.

**Import**:
- Gudoomiye/Zone Accountant (where they hold import rights at all — only Gudoomiye does, per §8.1): target zone is always `resolveUserZoneId(req.user)`; any `zone_id` field/column in the request or CSV is ignored.
- Admin: supplies exactly one `zone_id` (or `company_wide: true`, only for entities whose schema supports a nullable zone) as a **request-level** parameter, never a per-row CSV column — confirmed no entity's CSV contract (§17) includes a zone column at all, closing off any possibility of a mixed-zone file by construction, not merely by a validation rule that could be bypassed.

**Export**: zone-scoped roles always filtered to their own zone; company-wide roles may pass `zone_id` as an optional filter or omit it for all zones.

---

## 10. CSV Contract

- **Encoding**: UTF-8 only (with or without BOM — BOM is stripped if present, matching common spreadsheet-export behavior); any other encoding is a `400` at file-validation layer.
- **Delimiter**: comma only (`,`) — no configurable delimiter in MVP.
- **Header handling**: first row is always the header; header names must match the entity's registry-defined column set (§17) exactly (case-sensitive) — this is the "structural validation" layer.
- **Quoting**: RFC 4180 double-quote quoting supported (a quoted field may contain commas, newlines, and escaped `""` for a literal quote) — required for correct parsing of any field containing a comma (e.g., an address line), so a hand-rolled naive `split(',')` is explicitly insufficient and is not what this specification proposes (§21 names the actual parsing approach).
- **Line endings**: both `\r\n` and `\n` accepted.
- **Malformed CSV** (unbalanced quotes, ragged rows with a different column count than the header): file-validation-layer failure — the whole file is rejected, `400`, before any row reaches field-level validation.
- **Blank rows**: skipped silently (not counted as a validation failure, not counted as a data row) — a common, benign artifact of spreadsheet-exported CSVs.
- **Duplicate header column names**: file-validation-layer failure — ambiguous, rejected outright.
- **Unexpected columns**: structural-validation-layer failure — any header name not in that entity's registry-defined allowlist rejects the whole file (Decisions §18 — "an unrecognized column is rejected, not silently ignored").
- **Missing required columns**: same layer, same failure mode.

---

## 11. Import Validation Pipeline (9 layers, exact)

| # | Layer | Input | Output | Failure behavior | Runs on dry-run? | Re-run on commit? |
|---|---|---|---|---|---|---|
| 1 | File validation | Raw upload (multer buffer), size, row count (post-parse) | Pass/fail | `400`, whole file rejected, no further processing | Yes | Yes (full re-run) |
| 2 | Structural validation | Parsed header row | Pass/fail | `400`, whole file rejected | Yes | Yes |
| 3 | Field validation | Each parsed row | Per-row pass/fail + field-level error | Row marked invalid; file as a whole is still fully parsed and reported (dry-run reports every row's status) | Yes | Yes |
| 4 | Canonical-key validation | Each row's designated key column | Per-row pass/fail (present, non-empty, correctly formatted) | Row marked invalid | Yes | Yes |
| 5 | Duplicate validation | All rows' key values + one DB query per unique key | Per-row pass/fail (within-file collision or DB collision) | Row marked invalid | Yes | Yes — re-queries the DB fresh, since a duplicate could have been created by someone else between dry-run and commit |
| 6 | FK validation | Each row's referenced parent IDs/keys | Per-row pass/fail + existence/active-status check | Row marked invalid | Yes | Yes |
| 7 | Zone authorization | Request-level `zone_id`/`company_wide`, actor's resolved zone | Whole-file pass/fail (not per-row, since zone is request-level per §9) | `403`, whole file rejected | Yes | Yes |
| 8 | Business-rule validation | Each row, entity-specific rules mirroring that entity's own existing `POST` endpoint's own checks (e.g., Trucks' `validateEmployeeRole` driver/collector check) | Per-row pass/fail | Row marked invalid | Yes | Yes |
| 9 | DB constraint validation | The actual `INSERT` statement at commit time only | Pass/fail per Postgres | Any single failure → whole transaction `ROLLBACK` | **No** (dry-run never executes an INSERT) | Yes — this is the only layer that cannot run during dry-run by definition |

**Dry-run behavior**: layers 1-8 all execute; the response reports every row's per-layer result (a row can fail at multiple layers simultaneously — all applicable errors are reported for that row, not just the first). Layer 9 is inherently commit-only. If layers 1-8 all pass for every row, the dry-run response's `valid: true` is a strong (not absolute — see layer 9's own note) signal the commit will succeed.

**Commit behavior**: layers 1-8 are unconditionally re-executed from scratch (never trusts the dry-run's own stored result) before layer 9's actual `INSERT`s run inside the transaction. If layers 1-8 all still pass, `INSERT`s proceed; if any row now fails 1-8 that didn't before (e.g., someone else created a duplicate in the interim), or if the DB itself rejects a row at layer 9 (e.g., a race-condition duplicate not yet visible to layer 5's own read), the entire transaction rolls back and zero rows are written — per Decisions §9.

---

## 12. Dry-Run Contract

Restated as its own explicit section per the authorization's requirement, cross-referencing §7.1/§11:

- **Endpoint**: `POST /:entity/import/validate` (§7.1).
- **Authentication/authorization**: identical to commit (§8), checked independently each call.
- **Parsing**: server-side only (§21), full file parsed into rows before any validation layer runs.
- **Validation**: layers 1-8 (§11).
- **Response structure**: §7.1's JSON shape.
- **Audit behavior**: **none** — no `logAudit()` call of any kind on a dry-run, successful or failed. This is the literal, tested contract, not a soft guideline.
- **Non-mutation guarantee**: dry-run's implementation must never open a write transaction, never call any sequence-advancing function (e.g., must never call `generateCustomerNumber()` even speculatively — that function itself calls `nextval()`, which is NOT reversible by a rollback, so dry-run must not invoke it at all, not merely wrap it in an uncommitted transaction), never call `logAudit()`, and never touch `updated_at`/`created_at` on any existing row it inspects (FK-existence checks are pure `SELECT`s).
- **Commit-linkage mechanism** (the "how does commit know dry-run happened without trusting the client" requirement): a signed token (HMAC using the existing `JWT_SECRET` or a dedicated secret — an Implementation-stage detail, not decided here) whose payload contains `{entity, fileHash: sha256(fileBytes), zoneId, actorId, issuedAt, expiresAt}`. The commit endpoint independently recomputes `fileHash` from the freshly re-uploaded file and rejects any mismatch — this makes the token a *cryptographic binding to the exact bytes validated*, not a bare boolean flag, directly satisfying "do not invent an insecure `dryRun=true` flag as proof."

---

## 13. Atomic Commit Contract

```
authenticateToken → requireRole (§8.1) → validate commit-gate (token signature, expiry, file-hash match, §12)
  → BEGIN
    → re-run validation layers 1-8 (§11) fresh, inside the transaction
    → if any row fails → ROLLBACK → 409, per-row error report (same shape as dry-run's own error array)
    → for each valid row: INSERT (layer 9) — any single INSERT failure (a real DB-level constraint violation the pipeline didn't already catch) → ROLLBACK → 409
  → logAudit() — ONE summary entry (§20), inside the same transaction scope (or immediately after COMMIT — an Implementation-stage micro-decision; either is acceptable since the audit entry itself has no FK dependency on the imported rows beyond a row count)
  → COMMIT
```

No partial success at any point — confirmed as the literal control flow, matching every existing V2 multi-row transactional pattern (Phase 3's PO+items, Phase 4's ledger transfer pair) and explicitly not the legacy per-row-try/catch-continue model.

---

## 14. Error Model

```json
{
  "data": {
    "valid": false,
    "rowCount": 10,
    "errors": [
      { "row": 3, "field": "plate_number", "code": "DUPLICATE_IN_FILE", "message": "This plate_number appears more than once in the uploaded file (also row 7)." },
      { "row": 5, "field": "zone_id", "code": "INACTIVE_REFERENCE", "message": "The referenced zone is not active." },
      { "row": 8, "field": "driver_id", "code": "NOT_FOUND", "message": "No active employee with this ID exists." }
    ]
  }
}
```

`code` is a stable, enumerable string (`REQUIRED_FIELD_MISSING`, `INVALID_FORMAT`, `DUPLICATE_IN_FILE`, `DUPLICATE_IN_DATABASE`, `NOT_FOUND`, `INACTIVE_REFERENCE`, `ZONE_MISMATCH`, `UNRECOGNIZED_COLUMN`, `MISSING_COLUMN`, `FILE_TOO_LARGE`, `TOO_MANY_ROWS`, `MALFORMED_CSV`) — an explicit ADAPT of legacy's `{row, error}` shape (Decisions §10), extended with `field` and a stable `code` for programmatic handling, never a downloadable file (§21's own deferred item).

---

## 15. Audit Model

Reuses `logAudit()` exclusively — no second audit writer, no new table.

**Import** (one entry per successful commit only — a failed/rolled-back commit produces no audit row, since nothing happened; a failed dry-run likewise produces none, per §12):
```js
logAudit({
  actorId: req.user.id, actorUsername: req.user.username,
  action: 'master_data.import', entityType: '<entity>', entityId: null,
  before: null,
  after: { entity: '<entity>', zoneId, rowCount, filename: sanitizedOriginalFilename },
});
```
`filename` is the sanitized display name only (mirrors Phase 5's own `original_filename`-is-display-only-never-a-path principle) — never raw file bytes, never any row's actual data content, per the explicit "do not store sensitive file contents in audit" instruction.

**Export** (one entry per call, success or — per `reports.js`'s own precedent — recorded only on success, since a `403` never reaches the point of building a result set):
```js
logAudit({
  actorId: req.user.id, actorUsername: req.user.username,
  action: 'master_data.export', entityType: '<entity>', entityId: null,
  before: null,
  after: { entity: '<entity>', zoneId, filters: appliedFilters, rowCount },
});
```

Per-row audit entries are explicitly **not** created for either operation (Decisions §20/§28 deferred item).

---

## 16. Entity Import Field Maps

Every field list below is copied verbatim from that entity's own existing, unchanged `POST` create endpoint (§ evidence citations), not invented. "Importer-owned" columns are exactly the CSV's own columns; everything else is server-owned regardless of CSV content.

### 16.1 Zones (`routes/zones.js:121`)

| CSV column | DB field | Required | Owner | Validation | Canonical key? |
|---|---|---|---|---|---|
| `name` | `name` | Yes | Importer | Non-empty string | No |
| `zone_code` | `zone_code` | Yes | Importer | Non-empty, matches existing format rules; duplicate-checked | **Yes** |
| `sub_zone` | `sub_zone` | No | Importer | String | No |
| `area` | `area` | No | Importer | String | No |
| `collection_days` | `collection_days` | No | Importer | JSON-array-shaped string, parsed | No |
| — | `coordinates` | N/A | **Not importable in MVP** — no evidenced CSV-safe representation of a geo shape was found; omitted rather than guessed | — | — |
| — | `id`, `created_by`/equivalent, `created_at`, `status` | N/A | **Server-owned** — `status` always defaults exactly as `POST /zones` already defaults it (`'active'`) | — | — |

### 16.2 Customers (`routes/customers.js:364`)

| CSV column | DB field | Required | Owner | Validation | Canonical key? |
|---|---|---|---|---|---|
| `customer_type` | `customer_type` | Yes | Importer | Matches existing enum | No |
| `name` | `name` | Yes | Importer | Non-empty | No |
| `business_name` | `business_name` | No | Importer | String | No |
| `phone` | `phone` | Yes | Importer | Format-validated per existing rule | No |
| `alternate_phone` | `alternate_phone` | No | Importer | Same | No |
| `whatsapp` | `whatsapp` | No | Importer | Same | No |
| `email` | `email` | No | Importer | Format-validated | No |
| `address_line` | `address_line` | No | Importer | String | No |
| `sub_zone` | `sub_zone` | No | Importer | String | No |
| `lat`, `lng` | `lat`, `lng` | No | Importer | Numeric | No |
| `commercial_shift` | `commercial_shift` | No | Importer | Matches existing enum | No |
| `collection_frequency`, `collection_mode` | same | No | Importer | Match existing enums | No |
| `fee` | `fee` | No | Importer | Numeric ≥ 0 | No |
| `notes` | `notes` | No | Importer | String | No |
| `group_code` (mapped to `group_id` via existing-group lookup, not a raw DB ID — see note) | `group_id` | No | Importer (as a lookup key, not a raw ID) | Must resolve to an existing, active group in the target zone (layer 6) | No |
| `route_code` (same pattern) | `route_id` | No | Importer (as a lookup key) | Must resolve to an existing, active route under the resolved group | No |
| — | `zone_id` | Request-level, not a CSV column (§9) | Server-resolved (Gudoomiye) or request param (Admin) | — | — |
| — | `customer_number` | N/A | **Server-owned**, sequence-generated exactly as `generateCustomerNumber()` already does today | — | **Yes** (but never client-supplied — it's the canonical key precisely because it's always server-generated) |
| — | `id`, `registered_by`, timestamps, `payment_status`, `status` | N/A | **Server-owned** | — | — |

Note on `group_code`/`route_code`: Groups and Routes are themselves excluded from import (Decisions §23), but an *existing* group/route may still be *referenced* by an imported customer row, exactly as a manually-created customer already may. Since Groups/Routes were found to have no natural key (§23), this specification does **not** invent a `group_code` column on the `groups` table — instead, the CSV column for this reference uses the group's own existing `name` field (already required/likely-unique-in-practice per zone, though not DB-enforced-unique) as a lookup value, resolved via a `SELECT id FROM groups WHERE name = $1 AND zone_id = $2` at FK-validation layer (6); an ambiguous (non-unique name) match is itself a validation failure (`code: 'AMBIGUOUS_REFERENCE'`), not a silent pick-the-first-match. This is the narrowest possible resolution consistent with "do not invent a canonical key" — it uses an *existing* column for lookup purposes only, without adding anything to the Groups/Routes schema itself, and is flagged here explicitly as an implementation-affecting detail for confirmation before Implementation begins, not silently assumed.

### 16.3 Trucks (`routes/trucks.js:217`)

| CSV column | DB field | Required | Owner | Validation | Canonical key? |
|---|---|---|---|---|---|
| `plate_number` | `plate_number` | Yes | Importer | Non-empty, duplicate-checked | **Yes** |
| `model` | `model` | No | Importer | String | No |
| `capacity` | `capacity` | No | Importer | Numeric | No |
| `driver_employee_id` | `driver_id` | No | Importer (raw employee `id` — see note) | Must reference an existing, active employee with role `driver` (mirrors `validateEmployeeRole()`, layer 6) | No |
| `collector_employee_id` | `collector_id` | No | Importer (same) | Must reference an existing, active employee with role `collector` | No |
| `insurance_expiry`, `registration_expiry`, `road_tax_expiry` | same | No | Importer | Date format | No |
| `notes` | `notes` | No | Importer | String | No |
| — | `zone_id` | Request-level (§9) | Server-resolved/request param | — | — |
| — | `id`, `status`, timestamps | N/A | **Server-owned** | — | — |

Note: `driver_employee_id`/`collector_employee_id` use the raw `employees.id` (not a "human-facing" key), which the authorization's §8/Decisions §23 restriction is about *importing Employees themselves* via a surrogate ID as their own canonical key — it does not prohibit *referencing* an existing employee by ID from a different entity's import row, exactly as `POST /trucks` already accepts `driver_id`/`collector_id` as raw IDs today from its own existing frontend form. This is confirmed consistent, not a reinterpretation.

### 16.4 Leave Types (`routes/leaveTypes.js:20`)

| CSV column | DB field | Required | Owner | Validation | Canonical key? |
|---|---|---|---|---|---|
| `code` | `code` | Yes | Importer | Non-empty, lowercased exactly as `POST /leave-types` already does, duplicate-checked | **Yes** |
| `label` | `label` | Yes | Importer | Non-empty | No |
| `is_paid` | `is_paid` | No | Importer | Boolean, defaults `true` exactly as today | No |
| — | `id`, timestamps | N/A | **Server-owned** | — | — |

### 16.5 Inventory Items (`routes/inventory.js:80`)

| CSV column | DB field | Required | Owner | Validation | Canonical key? |
|---|---|---|---|---|---|
| `sku` | `sku` | **Yes for import** (nullable globally, unchanged — §22 of Decisions) | Importer | Non-empty for import purposes; duplicate-checked | **Yes** |
| `name` | `name` | Yes | Importer | Non-empty | No |
| `category` | `category` | No | Importer | String | No |
| `unit_of_measure` | `unit_of_measure` | Yes | Importer | Non-empty | No |
| `description` | `description` | No | Importer | String | No |
| `reorder_level` | `reorder_level` | No | Importer | Non-negative integer | No |
| — | `id`, `status`, timestamps | N/A | **Server-owned** | — | — |

---

## 17. Entity Export Field Maps

Sensitive/server-internal fields are explicitly excluded per row below; every other column of that table is exportable unless noted.

| Entity | Exported fields | Excluded (sensitive/internal) | Role visibility | Zone scope |
|---|---|---|---|---|
| Zones | `name`, `zone_code`, `sub_zone`, `area`, `collection_days`, `status`, `created_at` | `coordinates` (raw geo-JSON — excluded as not a meaningful flat CSV cell; not a security exclusion) | Per §8.2 | N/A (zones is the zone) |
| Customers | `customer_number`, `customer_type`, `name`, `business_name`, `phone`, `alternate_phone`, `whatsapp`, `email`, `address_line`, `sub_zone`, `lat`, `lng`, `commercial_shift`, `collection_frequency`, `collection_mode`, `fee`, `status`, `payment_status`, `zone_name` (joined, not raw `zone_id`), `group_name`, `route_name`, `created_at` | `notes` (treated as sensitive-by-analogy to Employees' own `notes` exclusion — flagged for Decisions confirmation before Implementation, since Customers' own `notes` field was not explicitly named in the Decisions document; conservatively excluded pending that confirmation rather than assumed exportable) | Per §8.2 | Own-zone for zone-scoped roles |
| Trucks | `plate_number`, `model`, `capacity`, `driver_name` (joined), `collector_name` (joined), `status`, `insurance_expiry`, `registration_expiry`, `road_tax_expiry`, `zone_name`, `created_at` | `notes` (same conservative treatment as Customers) | Per §8.2 | Own-zone |
| Leave Types | `code`, `label`, `is_paid`, `status`, `created_at` | none | Per §8.2 | N/A (company-wide) |
| Inventory Items | `sku`, `name`, `category`, `unit_of_measure`, `description`, `reorder_level`, `status`, `created_at` | none | Per §8.2 | N/A (company-wide) |
| Suppliers | `name`, contact fields already on the table, `status`, `created_at` | any internal notes field if present, same conservative default | Per §8.2 | N/A (company-wide) |
| Inventory Stores | `name`, `zone_name`, `status`, `created_at` | none | Per §8.2 | Own-zone |
| Employees | `name`, `job_role`, `employee_type`, `collector_type`, `commercial_shift`, `phone`, `zone_name`, `status`, `salary` (see note), `join_date`, `created_at` | **`photo`, `id_document`, `guarantor_name`, `guarantor_phone`, `notes`** — exact `SENSITIVE_FIELDS` list from `routes/employees.js:35`, reused verbatim | Per §8.2, **and** `salary` is flagged here as a field warranting its own explicit confirmation — it is not in the named `SENSITIVE_FIELDS` list but is financial/compensation data; included provisionally on the same basis as the rest of `BASE_FIELDS` since Decisions did not separately call it out, but explicitly flagged for Implementation-stage confirmation rather than silently assumed safe | Own-zone |
| Groups | `name`, `zone_name`, `status`, `created_at` | none | Per §8.2 | Own-zone (via zone) |
| Routes | `name`, `group_name`, `status`, `created_at` | none | Per §8.2 | Own-zone (via group→zone) |
| Asset Register | `asset_tag`, `name`, `category`, `serial_number`, `acquisition_date`, `acquisition_cost`, `condition`, `status`, `zone_name`, `store_location_name`, `assigned_employee_name`, `created_at` | `purchase_order_id` (raw internal FK — excluded, joined/omitted entirely rather than exposing a transactional-table ID) | Per §8.2 | Own-zone |

**Two fields are flagged above, not silently resolved** (Customers'/Trucks' `notes`, Employees' `salary`) — per the authorization's own instruction to stop and report rather than assume when a specification-level ambiguity touches a locked decision's boundary. Neither is in the explicitly-named `SENSITIVE_FIELDS` list, but neither was explicitly confirmed exportable either. This specification's own default (exclude `notes` fields conservatively; include `salary` provisionally but flagged) is a specification-stage judgment call, presented for confirmation, not a silent decision.

---

## 18. UI Specification

Two new pages, following the exact "no Sidebar/nav change, direct-URL-only" precedent from Phases 4/5 (Decisions §26 of this phase implicitly carries that forward — no contrary instruction was given, and §26 of the authorization explicitly says "do not touch the frozen Sidebar/navigation module now").

- **`client/src/pages/masterData/MasterDataImportPage.jsx`** — entity selector (from the 5 import-permitted entities the current user's role allows, per §8.1), zone selector (Admin only, per §9), CSV file input, "Validate" button → displays the dry-run report (row count, per-row errors in a table) → "Commit" button (disabled until a successful, still-fresh dry-run exists) → success summary (rows created, link back to that entity's own existing list page).
- **`client/src/pages/masterData/MasterDataExportPage.jsx`** — entity selector (from the 11 export-permitted entities the current user's role allows, per §8.2), entity-specific filter controls (§19), zone selector (company-wide roles only), "Export" button triggering an authenticated-fetch-and-download (reusing `apiClient.downloadAuthorizedFile`, the exact existing helper from Phase 5 — no new download mechanism invented).
- Loading/error/empty states reuse the existing shared `LoadingState`/`ErrorState`/`EmptyState` components, identical convention to every prior phase.
- **Router**: 2 new additive routes (`/master-data/import`, `/master-data/export`) in `client/src/routes/router.jsx` — additive only, no Sidebar/AppShell/MobileNavDrawer/MobileTabBar file touched.

---

## 19. Export Filters (per entity)

| Entity | Filters |
|---|---|
| Zones | `status` |
| Customers | `status`, `zone_id` (company-wide roles), `customer_type` |
| Trucks | `status`, `zone_id` |
| Leave Types | `status` |
| Inventory Items | `status`, `category` |
| Suppliers | `status` |
| Inventory Stores | `status`, `zone_id` |
| Employees | `status`, `zone_id`, `employee_type` |
| Groups | `status`, `zone_id` |
| Routes | `status`, `group_id` |
| Asset Register | `status`, `zone_id`, `category` |

Ordering: alphabetical by the entity's own primary display name field (matches every existing V2 list endpoint's own default order) unless that entity's list endpoint already establishes a different default (in which case this specification mirrors that existing default, not inventing a new one). No filter beyond what's listed above is introduced — no new business semantics (per the authorization's explicit instruction).

---

## 20. Database Impact

**No schema change is required.** Confirmed by design: import is create-only against 5 already-existing tables, using only their already-existing columns; export reads from already-existing tables. No `import_jobs`/`import_batches`/`import_provenance` table is created, per Decisions §11/§22's explicit deferral. The only "new persistent data" this specification produces is the standard `created_by`/`created_at` values every imported row already carries via its target table's own existing columns — nothing net-new to the schema.

**If Implementation later finds a genuine need for schema** (none identified here), that would itself be a deviation from this specification requiring its own explicit report before proceeding, not a default path.

---

## 21. Dependency Impact

**One new dependency is likely required for correct, safe CSV parsing**, documented here per the authorization's explicit instruction, **not installed during this stage**:

- **Candidate package**: `csv-parse` (the `csv` project's parser sub-package) — a widely-used, actively maintained, synchronous-or-streaming RFC 4180 CSV parser.
- **Version policy**: pin an exact version (matching this program's own established convention — see `package.json`'s existing exact-pin style for `multer`, `pg`, etc.), latest stable at Implementation time, re-confirmed for known CVEs before installing.
- **Reason existing dependencies cannot safely satisfy this**: none of V2's current dependencies (`bcrypt`, `cors`, `docx`, `dotenv`, `express`, `express-rate-limit`, `helmet`, `jsonwebtoken`, `multer`, `pg`) perform CSV parsing. A hand-rolled `split(',')`-based parser is explicitly insufficient and unsafe for this use case — it cannot correctly handle a quoted field containing an embedded comma, embedded newline, or escaped quote (§10), all of which are legitimate in real-world spreadsheet-exported CSVs (e.g., a customer address line containing a comma). Hand-rolling a fully RFC 4180-compliant parser from scratch would itself be a larger, less-audited surface than adopting a small, purpose-built, widely-used library.
- **Security implications**: `csv-parse` performs no code execution, no formula evaluation, and no file-system access — it is a pure string-to-array-of-arrays transform, making its risk surface narrow and well-understood (unlike an XLSX parser, which is exactly why XLSX remains deferred per Decisions §17). Row/size limits (§18 below, enforced *before* the parser ever sees the file) bound the parser's own resource consumption regardless.

This dependency is **not** installed now — Implementation stage must obtain its own explicit authorization for the install, per the standing "no new dependency without justification, never installed speculatively" rule already followed in every prior phase (e.g., Phase 4's explicit choice of `crypto.randomUUID()` over adding a UUID package).

---

## 22. Security Controls

Consolidated checklist, each item cross-referenced to where it's specified above:

- [ ] Auth before file read (§8, mirrors Phase 5's auth-before-multer order)
- [ ] Role check independent per endpoint, re-checked on every call, never cached across dry-run→commit (§7.1/§7.2)
- [ ] Zone server-resolved for zone-scoped roles, never client-overridden (§9)
- [ ] No CSV row may set `id`, `created_by`, timestamps, sequence-generated numbers, or `status` (§16, every field map's "server-owned" column)
- [ ] File-hash-bound validation token, never a bare boolean flag (§12)
- [ ] Full 9-layer re-validation at commit time, never trusting the dry-run's stored result alone (§11)
- [ ] Whole-file atomic transaction, no partial success (§13)
- [ ] Export permission independently checked per entity, never inherited from view access (§8.2)
- [ ] Employees' `SENSITIVE_FIELDS` excluded from export verbatim (§17)
- [ ] `csvFormulaSafe()`-equivalent sanitization applied to every exported string cell, adapted fresh (not copied by modifying the CLOSED `audit.js`) — closes the exact gap left open in `reports.js` (§27 below)
- [ ] File-size (5MB) and row-count (5,000) limits enforced before parsing begins where feasible (size, via `multer`'s own `limits.fileSize`, identical mechanism to Phase 5) and immediately after parsing, before any row-level validation, for row count (§23)
- [ ] Malicious/oversized files rejected fast, `400`, no partial processing (§10/§23)
- [ ] Import audit records filename only, never file content (§15)
- [ ] No sensitive file content, no full row data, ever written to `v2_audit_log`

---

## 23. Performance/Resource Controls

- **File size**: enforced at the `multer` layer (`limits: { fileSize: 5 * 1024 * 1024 }`), identical mechanism to Phase 5's own 15MB document limit, just a different number per Decisions §18 — rejects before any bytes are fully buffered beyond the limit.
- **Row count**: enforced immediately after parsing (the parser must fully tokenize the file to know its row count, so this check is necessarily post-parse, not pre-parse) — if row count exceeds 5,000, the entire file is rejected (`400`) before any per-row validation layer (3-8) begins, avoiding wasted validation work on an already-doomed file.
- **Column count**: implicitly bounded by each entity's own fixed field map (§16) — an oversized/malformed header is caught at structural validation (layer 2), not a separate numeric column-count check.
- **Timeout**: no new timeout infrastructure — relies on the existing Express/Node request lifecycle exactly as every other synchronous endpoint in this codebase does. If 5,000 rows × the validation pipeline's own per-row DB queries (duplicate + FK checks) proves slow in practice, that is an Implementation/Hardening-stage finding to report, not something this specification pre-optimizes for (no premature optimization, matching every prior phase's own stated discipline).
- **Export result size**: unbounded in MVP (no `LIMIT` imposed beyond the entity's own filters) — explicitly accepted as a known characteristic (Decisions §26), not a gap to silently fix here; `Cache-Control`/streaming are the identified Future CR (§24) if this ever proves to be a real problem.

---

## 24. Deferred / Future CRs (all 17, preserved verbatim from Decisions)

1. FUTURE CR — Import update/upsert semantics
2. FUTURE CR — Downloadable import error reports
3. FUTURE CR — First-class import provenance
4. FUTURE CR — Whole-import undo
5. FUTURE CR — Mixed-zone import files
6. FUTURE CR — Asynchronous import processing
7. FUTURE CR — XLSX import/export
8. FUTURE CR — Head of Cashiers/Cashier master-data export rights
9. FUTURE CR — Sensitive employee field export
10. FUTURE CR — Supplier/Inventory Store canonical key + import
11. FUTURE CR — Employee/Group/Route canonical key + import
12. FUTURE CR — Asset Register import
13. FUTURE CR — Per-row import audit granularity
14. FUTURE CR — Streaming export
15. FUTURE CR — Reports CSV export formula injection hardening (against a frozen module — not touched here)
16. FUTURE CR — Import approval workflow
17. FUTURE CR — Bulk correction authority

None of these is implemented, scaffolded, or partially built by anything in this specification — confirmed by the explicit absence of any table, endpoint, or field mapping serving any of them above.

---

## 25. Frozen Module Protection

**Confirmed, nothing modified or proposed to be modified**: Zones, Customers, Employees, Trucks, Collection Operations, Financial Billing, Cashout, Reports, Dashboard, Customer Portal, Complaints, Group & Group-Based Collection, Offline/Sync, Field Collector Mobile, Staff Notifications, Operational Calendar, Route & GIS/Map, System Settings, Sidebar/Navigation UX, Production Readiness/Final Review, and Document & File Management (Phase 5) all remain untouched. Phase 6 reads each relevant module's existing route files only to ground field maps/role matrices in live evidence (§16, §8.1) — the same read-only-inspection discipline already used in Discovery and Decisions.

---

## 26. Testing Specification (acceptance criteria, to be executed at Implementation/Hardening/QA — not now)

At minimum: authorized import (each of the 5 entities, each of their permitted roles) · unauthorized import (wrong role, wrong zone) · zone isolation (Gudoomiye importing/exporting outside own zone blocked) · canonical-key validation (missing/malformed key rejected) · duplicate within file · duplicate against DB · inactive reference rejected · nonexistent reference rejected · malformed CSV rejected · missing required column rejected · unexpected column rejected · exactly-5MB accepted / 5MB+1byte rejected · exactly-5,000-row accepted / 5,001 rejected · dry-run produces zero DB/sequence/audit mutation (verified by row-count/sequence-value/audit-count snapshots before and after) · a forced mid-pipeline failure at commit rolls back fully (zero rows, zero audit entries) · a valid commit creates exactly the validated row count · sequence values advance correctly and only on real commit · exactly one audit entry per commit and per export · export permission separation (a role with view-but-not-export rights receives 403) · Employee sensitive-field exclusion confirmed absent from exported CSV · export zone isolation · CSV formula-injection protection (a cell value like `=cmd|calc!A1` is neutralized on export) · empty export (zero matching rows still returns a valid, header-only CSV, not an error) · large export behavior (a few thousand rows completes without error, confirming the accepted in-memory-construction tradeoff) · full regression sweep of the 11 frozen-module list (§25) confirming zero behavioral change.

---

## 27. Implementation File Plan

| File | Create/Modify | Purpose | Frozen-module risk |
|---|---|---|---|
| `server/lib/csvImportExport.js` | Create | Shared CSV parse/serialize/sanitize mechanics | None |
| `server/lib/masterDataEntities.js` | Create | Explicit per-entity registry (field maps, roles, zone rules, FK-check functions) | None (reads other modules' tables via SQL only, never imports their route files) |
| `server/routes/masterDataImportExport.js` | Create | The 3 API endpoints (§7) | None |
| `server/index.js` | Modify (additive only) | 2 lines: router require + mount | None — same pattern as every prior phase |
| `client/src/hooks/useMasterDataImportExport.js` | Create | React Query hooks for validate/commit/export | None |
| `client/src/pages/masterData/MasterDataImportPage.jsx` | Create | Import UI | None |
| `client/src/pages/masterData/MasterDataExportPage.jsx` | Create | Export UI | None |
| `client/src/routes/router.jsx` | Modify (additive only) | 2 new route entries | None |
| `server/package.json` | Modify (additive only, Implementation stage, own authorization) | Add `csv-parse` (§21) | None |

No unnecessary files. No generic abstraction without a concrete Phase 6 consumer — `masterDataEntities.js` is the one deliberate exception, and it is itself the explicit anti-genericity mechanism (§29 of Decisions), not a violation of it.

---

## 28. Acceptance Criteria

Implementation is acceptable when: all §26 tests pass; the exact 5/11 entity scope is enforced (no 6th importable entity reachable); every server-owned field is confirmed unwritable via CSV in every field map; the dry-run/commit split is confirmed non-bypassable (no code path exists that commits without a valid, file-hash-matched, freshly-re-validated token); zero schema change was made; the one new dependency (`csv-parse`) is the only dependency added, with its own separate installation authorization obtained at Implementation time; every frozen module is confirmed unmodified via `git diff`; production remains untouched.

---

## 29. Production Boundary

NOT AUTHORIZED — UNTOUCHED. No deployment, migration, or infrastructure action was taken or proposed during this stage.

---

## 30. Final Specification Gate

Two implementation-affecting ambiguities were surfaced rather than silently resolved (§16.2's Groups/Routes name-based reference-lookup mechanism; §17's Customers/Trucks `notes` and Employees `salary` export-inclusion judgment calls) — both are specification-stage defaults offered for confirmation, not gaps that block proceeding, since each has a stated, defensible, conservative resolution consistent with the locked Decisions. No other conflict between an implementation requirement and a LOCKED decision was found.

**PHASE 6 — IMPLEMENTATION SPECIFICATION PASS**

Production:
NOT AUTHORIZED — UNTOUCHED
