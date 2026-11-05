# Degmo / Group / Sub Zone / Albaab: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hierarchy read **Degmo → Group → Sub Zone → Albaab (door #)**, with one collector per Sub Zone. Existing data stays as it is; this is relabelling plus two new columns.

**Architecture:** The existing tables stay and only get new labels:
- `zones` becomes **Degmo**.
- `groups` stays **Group**.
- `routes` becomes **Sub Zone**.

Two columns are added:
- `customers.door_number`: unique across the whole system, optional.
- `routes.collector_user_id`: the Sub Zone's collector.

Test Groups and Routes rows are deleted once, by a one-off script, not by the migration.

**Tech Stack:** Express + pg (`server/db.js` additive migrations), React + Vite, i18n dictionaries in `client/src/i18n/`, node:test integration suite (`npm test` in `server/`).

**Spec:** `docs/superpowers/specs/2026-10-19-degmo-billing-slsh-design.md` (Part 1 only)

## Global Constraints
- Do not rename tables or API paths. `/api/v2/zones`, `/api/v2/groups` and `/api/v2/routes` stay as they are; only UI labels change.
- `door_number` is optional (NULL allowed) and unique system-wide when set. It is trimmed and stored as digits/text up to 20 chars.
- The two Degmo are the existing zones **Farah Omar** and **Sheekh Bashiir**. Do not create new zones.
- UI labels are English, with Somali in the dictionaries:
  - Zone → **District** / so: "Degmo"
  - Route → **Sub Zone** / so: "Sub Zone"
  - door → **Door # (Route)** / so: "Albaab (Route)"
- Every migration is additive and idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`).

## Review Focus
1. **Two customers given the same door number at the same moment.** The DB unique index must win, and the API must return 409 rather than 500 (Task 1 test).
2. **Door number entered with spaces, or left as an empty string.** Store NULL for empty and trim otherwise; `"  "` must not take up the unique slot (Task 1 test).
3. **A customer edited without sending `door_number`.** The existing value must be kept, not wiped (Task 1 test).
4. **A Sub Zone whose collector is deactivated.** The Sub Zone list must still load and show the name with "(inactive)" (Task 2 test).
5. **Deleting test Groups and Routes while customers reference them.** The cleanup script nulls `customers.group_id` and `customers.route_id` first, and refuses if any batch references the group (Task 4).

---

### Task 1: Door number on customers (backend)

**Files:**
- Modify: `server/db.js`, after the `customers.route_id` block (~line 1022)
- Modify: `server/routes/customers.js`: POST `/`, PUT `/:id`, GET `/` search
- Modify: `server/lib/masterDataEntities.js`: customers CSV column `door_number`
- Test: `server/test/customers.test.js` (extend)

**Interfaces:**
- Produces:
  - Column `customers.door_number VARCHAR(20)` with unique partial index `idx_customers_door_number ... WHERE door_number IS NOT NULL`.
  - The API accepts and returns `door_number`.
  - GET `/customers?search=572` matches `door_number`.

- [ ] **Step 1: Write the failing tests** in `server/test/customers.test.js`:
  - `door number: saved trimmed` — POST `door_number: ' 572 '` → 201, `data.door_number === '572'`.
  - `door number: blank stored as null` — POST `door_number: '  '` → 201, `data.door_number === null`; two such customers both succeed.
  - `door number: duplicate rejected with 409` — second POST `'573'` → 409, `error.code === 'DUPLICATE'`.
  - `door number: PUT without the field keeps it` — create with `'574'`, PUT `{ name: 'x' }`, then GET → `'574'`.
  - `door number: searchable` — GET `/customers?search=575` returns that customer.
- [ ] **Step 2:** Run `cd server && npm test`. Expected: the 5 new tests FAIL.
- [ ] **Step 3: Implement.**
  - Migration in `db.js`.
  - In `customers.js`, add `normaliseDoor(v) -> string|null` (trim; `''` → null; length > 20 → 400 VALIDATION).
  - Use it in POST and PUT. In PUT, only touch the column when `'door_number' in req.body`.
  - Map unique violation 23505 on `idx_customers_door_number` to 409 "That door number is already used by another customer."
  - Add `c.door_number ILIKE` to the search OR clause.
  - Add the CSV column to `masterDataEntities.js`.
- [ ] **Step 4:** Run `npm test`. Expected: all pass (41 + 5).
- [ ] **Step 5:** Commit: `feat(customers): door number (route #), unique system-wide`.

### Task 2: Collector per Sub Zone (backend)

**Files:**
- Modify: `server/db.js`: `ALTER TABLE routes ADD COLUMN IF NOT EXISTS collector_user_id INTEGER REFERENCES v2_users(id) ON DELETE SET NULL`
- Modify: `server/routes/routesEntity.js`: POST/PUT accept `collector_user_id`; GET list/detail return `collector_user_id`, `collector_name`, `collector_active`
- Test: `server/test/subzones.test.js` (new)

**Interfaces:**
- Produces: Route JSON gains `collector_user_id: number|null`, `collector_name: string|null`, `collector_active: boolean|null`.

- [ ] **Step 1: Write failing tests:**
  - `sub zone: assign collector` — PUT `/routes/:id { collector_user_id: <collector> }` → 200, then GET shows `collector_name`.
  - `sub zone: non-collector user rejected` — PUT with the admin's id → 400.
  - `sub zone: deactivated collector still listed` — deactivate the user, GET `/routes?group_id=` → 200, `collector_active === false`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Validate that `collector_user_id` references a `v2_users` row with `role = 'collector'`; otherwise return 400 VALIDATION.
  - Use a LEFT JOIN to `v2_users` in the reads.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(routes): one collector per sub zone`.

### Task 3: Relabel UI + door/collector fields (frontend)

**Files:**
- Modify: `client/src/i18n/common.js` (and `phase2*.js` where the keys live): every user-facing "Zone" → "District", every "Route" → "Sub Zone", plus the Somali equivalents. Includes `nav.zones`.
- Modify: `client/src/layout/Sidebar.jsx`, `MobileNavDrawer.jsx`: the nav label now comes from `nav.zones`, which reads "Districts".
- Modify: `client/src/pages/zones/*`: titles and the subtitle "Gurmad's two districts — Farah Omar and Sheekh Bashiir."
- Modify: `client/src/pages/groups/GroupDetailPage.jsx`:
  - The "Routes" section becomes "Sub Zones".
  - Add a collector `<select>` (active collectors from the existing users hook) in the route create/edit form.
  - Show the collector name, or "Unassigned".
- Modify: `client/src/pages/customers/CustomerFormModal.jsx`:
  - Relabel the zone/group/route selects as District / Group / Sub Zone.
  - Add a `door_number` input (`placeholder="572"`) after Sub Zone. It is sent on create and edit.
  - Show the server's 409 message inline.
- Modify: the customer list page (`client/src/pages/customers/CustomersListPage.jsx` or equivalent):
  - Rename the "Zone" column to "District".
  - Add a "Door #" column.
  - Show the breadcrumb `District › Group › Sub Zone` on the customer detail page.
- Modify: `client/src/pages/map/MapPage.jsx` and `BatchesListPage.jsx`: filter labels only.

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** Run `cd client && npx eslint src --rule 'no-undef: error'`, then `npm run build`. Expected: 0 undefined, built.
- [ ] **Step 3: Browser check** (demo backend `DB_NAME=gurmad_v2_manual` on :5001, vite preview):
  - The sidebar shows "Districts", and the list shows Farah Omar / Sheekh Bashiir.
  - Create Group 2 (Baarsiigo) under Farah Omar.
  - Add Sub Zone 1 with a collector.
  - Create Caasha with door 572.
  - The detail page shows `Farah Omar › Group 2 › Sub Zone 1`.
  - A second customer with 572 shows the 409 message.
  - Screenshot.
- [ ] **Step 4:** Commit: `feat(ui): District › Group › Sub Zone › Door labels and fields`.

### Task 4: Production cleanup + example data (run after deploy, with user approval)

**Files:**
- Create: `server/scripts/reset_test_groups.js`
  - Runs in a single transaction.
  - If any `batches.group_id IS NOT NULL`, it aborts and prints the count.
  - Otherwise it runs `UPDATE customers SET group_id=NULL, route_id=NULL`, `DELETE FROM routes`, `DELETE FROM groups`, then prints the counts.
  - It supports `--dry-run`.

- [ ] **Step 1:** Write the script and run it with `--dry-run` against the local `gurmad_v2_manual` database. Expected: it prints counts and changes nothing.
- [ ] **Step 2:** Commit.
- [ ] **Step 3: Deploy, after the user approves.**
  - scp the server files and restart pm2.
  - Upload the client via `dist.tgz`.
  - `curl` should return 200 for the site and 401 for the API.
- [ ] **Step 4: Clean up production test data, after the user approves.**
  - Run the script on prod with `--dry-run` and show the counts to the user.
  - Run it for real only on their yes.
- [ ] **Step 5: Create the example data on prod through the UI or API.**
  - Ask the user for Caasha's phone number first.
  - Create Group 2 (Baarsiigo, Farah Omar), Sub Zone 1, and Caasha with door 572.

---

## Update 2026-11-05: Customer # = C- + door (spec section "CUSBOONAYSIIN")

The hierarchy is Degmo → Group → Sub Zone → Customer. The door is a customer field, not a level.

### Task 5: Door required; Customer # derived from door

**Files:**
- Modify: `server/routes/customers.js`, POST `/`:
  - Door is required and must match `/^\d+$/`.
  - `customer_number = 'C-' + door.padStart(2, '0')`.
  - If that number already exists, return 409 and roll back.
  - Remove the manual `customer_number` input from POST.
- Modify: `server/lib/masterDataEntities.js`: on CSV import, apply the same door rules (pending the [GO'AAN] in the spec).
- Modify: `client/src/pages/customers/CustomerFormModal.jsx`:
  - Remove the Customer # field from create.
  - Make the door field required and digits-only, with a live preview "Customer #: C-572".
- Test: `server/test/customers.test.js`, `server/test/helpers.js` (mkCustomer passes a door).

**Tests (written, uncommitted, currently red → green after the code):**
- `customer number is C- plus the door number` (door ' 9572 ' → C-9572)
- `single-digit door is padded to two digits` (7 → C-07)
- `door number is required on create` (missing / '' / '   ' → 400)
- `door number must be digits` ('57A', '5-7', 'abc' → 400)
- `door whose C- number is already taken is rejected with 409, nothing created` (9301 then 09301)
- `changing the door later does not change the customer number`

**Prod data step (needs user approval):** rename Caasha C-04 → C-572 via the existing Edit Number endpoint.

### Task 6: Zone level between Group and Sub Zone; collector max 10 Sub Zones

**Files:**
- Modify: `server/db.js`
  - `CREATE TABLE IF NOT EXISTS group_zones (id SERIAL PK, group_id INT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT, code VARCHAR(30) NOT NULL, name VARCHAR(100), status VARCHAR(20) NOT NULL DEFAULT 'active', created_by INT, created_at, updated_at, UNIQUE (group_id, code))`
  - `ALTER TABLE routes ADD COLUMN IF NOT EXISTS group_zone_id INTEGER REFERENCES group_zones(id) ON DELETE SET NULL`
- Create: `server/routes/groupZones.js`, mounted at `/api/v2/group-zones`. Endpoints: GET `?group_id=`, GET `/:id` (with its Sub Zones), POST, PUT. Roles and zone-access checks are the same as `groups.js`.
- Modify: `server/routes/routesEntity.js`
  - POST/PUT accept `group_zone_id`, which must belong to the same group.
  - Collector cap: if the collector already has 10 routes (excluding this one), return 400 "A collector can have at most 10 Sub Zones."
- Modify: `server/routes/customers.js`: GET returns `group_zone_name`, via a join `routes → group_zones`.
- Client:
  - `useGroupZones` hook.
  - GroupDetailPage: list Zones, and Sub Zones grouped under their Zone.
  - Sub Zone form: Zone select.
  - CustomerFormModal: District › Group › Zone › Sub Zone cascade.
  - Customer breadcrumb `Group › District › Zone › Sub Zone`.
  - i18n: en "Zone" / so "Zone".

**Tests:**
- `group zone: create under group, code unique per group` (same code in another group OK; duplicate in same group → 409)
- `sub zone: group_zone_id from another group rejected` (400)
- `collector: 11th sub zone rejected` (10 OK, 11th → 400)
- `customer detail returns group_zone_name`

**Display order (all pages):** `Group 2 › Farah Omar (Baarsiigo) › Zone A › Sub Zone 1 › Caasha (C-572)`

### Task 7: Door / Customer # change needs admin approval; invoices snapshot the number

Follows the existing request→approve pattern of `inventory_adjustment_requests`.

**Files:**
- Modify: `server/db.js`
  - Create `customer_number_change_requests`:
    - id, customer_id FK
    - old_door, new_door, old_number, new_number
    - status ('pending','approved','rejected')
    - requested_by, decided_by, decided_at, reason, created_at
  - Add a partial unique index allowing one pending request per customer.
  - Add `invoices.customer_number_snapshot VARCHAR(20)`. Backfill it once from the current `customers.customer_number`, with `WHERE customer_number_snapshot IS NULL`.
- Modify: `server/routes/customers.js`
  - PUT with a changed `door_number` no longer writes it. It creates a pending request instead (409 if one is already pending, or if the new C-number or door is taken), and returns 202 with the request.
  - The existing Edit Number endpoint also becomes a request.
  - New endpoints:
    - `GET /customers/number-requests?status=pending` (admin, gudoomiye)
    - `POST /customers/number-requests/:id/approve` (admin only)
    - `POST /customers/number-requests/:id/reject` (admin only)
  - Approve re-checks uniqueness, then updates door and number in one transaction. Approve and reject are both written to the audit log.
- Modify: invoice creation (`server/routes/invoices.js`, batch invoice creation in `batches.js`): write `customer_number_snapshot`. Invoice reads and PDFs show the snapshot.
- Client:
  - Customer detail shows the pending request with Approve / Reject for admin.
  - Add an "Approvals" list (number requests) to the existing approvals area, or to the customer list as a filter.
  - The door field on edit shows "Change needs admin approval".

**Tests:**
- `door change creates pending request, customer unchanged`
- `second pending request for same customer → 409`
- `gudoomiye cannot approve (403); admin approves → door and C-number updated`
- `reject leaves customer unchanged`
- `approve fails 409 if new number got taken meanwhile`
- `invoice created before approval keeps old number; invoice after shows new number`

**Ruling (default, user may change):** CSV import rejects rows without a door number. The admin is the approver.
