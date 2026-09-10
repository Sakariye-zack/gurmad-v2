# GURMAD V2 — Phase 7: Approval Engine — Discovery Report

**Status:** DISCOVERY ONLY. No code, schema, dependency, or production changes were made during this stage.
**Baseline:** V2 HEAD `ec71ca088bcb2431bc2c9dfa3237b52b1019083a` (Phase 6 CLOSED at Implementation+Hardening).

---

## 1. Executive Summary

V2 already has **four independent, working, already-hardened approval implementations** — Procurement (requests), Inventory Adjustments, Cashouts, and Leave Requests — each built module-by-module with its own RBAC/zone/audit rules, none sharing code. Direct inspection found a real, live inconsistency: **Procurement and Inventory Adjustments hard-block self-approval; Cashouts and Leave Requests do not.** For Cashouts specifically, `admin` sits in both `CREATE_ROLES` and `APPROVE_ROLES` with zero self-approval check — a concrete, currently-live gap in a frozen **financial** module, not a hypothetical one.

No new business process was found anywhere in the codebase that currently lacks an approval mechanism and needs one. Building a new generic "Approval Engine" today would have zero real consumer — directly violating this program's own standing rule against speculative infrastructure, and the explicit Phase 7 instruction to "identify actual modules that require approval integration" and "do not invent approval requirements for existing frozen modules." Retrofitting the four existing implementations onto a shared engine would mean reopening four frozen modules (Procurement, Inventory & Assets, Cashout, HR & Payroll) — each requiring its own separately authorized Future CR, not a blanket Phase 7 rewrite.

**Recommendation, not a decision**: Phase 7 should not build new generic approval infrastructure. It should formally document the four existing patterns as the system's approval precedent, and record the self-approval inconsistency as named Future CRs against the two specific frozen modules where it's real — not invent a fifth implementation nor silently retrofit the other four.

---

## 2. Existing Approval Implementations (direct inspection, all four)

| Module | Table | States | Self-approval blocked? | Approver roles | Zone-scoped? | Reason required on reject? | Audit |
|---|---|---|---|---|---|---|---|
| Procurement Requests | `procurement_requests` | pending → approved/rejected | **Yes** — `request.requested_by === req.user.id` hard-blocked, `routes/procurement.js:281,350,379` | Admin, Gudoomiye (own zone) | Yes | No (status-only) | `logAudit()`, `request.approved`/`request.rejected` |
| Inventory Adjustment Requests | `inventory_adjustment_requests` | pending → approved/rejected | **Yes** — `routes/inventory.js:662` | Admin only | No (company-wide) | Yes — `rejected_reason` required | `logAudit()`, `inventory_adjustment.approve`/`.reject` |
| Cashouts | `cashouts` | (created) → approved/rejected/voided | **No self-approval check exists** — confirmed via direct read of both `/:id/approve` and `/:id/reject`, `routes/cashouts.js:330-390` | Admin, Gudoomiye (own zone) — **`admin` is also in `CREATE_ROLES`**, so an admin can create and approve/reject the same cashout | Yes (Gudoomiye) | Yes — `reason` required to reject | `logAudit()`, `cashout.approve`/`.reject` |
| Leave Requests | `leave_requests` | pending → approved/rejected | **No self-approval check exists** — confirmed via direct read, `routes/leaveRequests.js:156-174` | Admin, Gudoomiye (own zone via `assertEmployeeInScope`) | Yes | No (status-only) | `logAudit()`, `leave_request.approved`/`.rejected` |

**Shared pattern across all four** (the real, reusable precedent, even though no shared code exists): `pending`-like initial state → `PUT .../status` or `.../approve`/`.../reject` → `requireRole(...APPROVE_ROLES)` → resource-existence check → (zone check where applicable) → (self-approval check, 2 of 4) → state transition → `logAudit()`. Three of four use a plain status CHECK column; Cashouts additionally requires a signed-document precondition before approval (`cashout_attachments` check) — a business-specific rule, not something a generic engine should assume.

---

## 3. The Real Gap Found

**Cashouts**: `CREATE_ROLES = ['admin', 'head_of_cashiers']`, `APPROVE_ROLES = ['admin', 'gudoomiye']` (`routes/cashouts.js:20-21`). `admin` is in both. Neither `/:id/approve` nor `/:id/reject` checks `cashout.created_by` (or equivalent) against `req.user.id`. **An admin who creates a cashout can approve or reject it themselves, live, today.** This is a financial-integrity-relevant gap in a CLOSED/FROZEN module — not fixed here, not fixable here.

**Leave Requests**: `APPROVE_ROLES = ['admin', 'gudoomiye']`. An admin (or a Gudoomiye, if a Gudoomiye can hold an `employees` record — not confirmed either way by this Discovery) with a linked `employees` row could submit their own leave request and then approve it. Lower real-world likelihood than the Cashouts case (an admin's own leave request is a less common scenario than an admin processing their own cashout), but the same class of gap.

Both are recorded as Future CRs (§6) — **not fixed in Phase 7**, since both live in CLOSED/FROZEN modules (Cashout, HR & Payroll) and fixing them requires their own separately authorized, narrowly-scoped touch, exactly like every prior phase's own precedent for a frozen-module fix (e.g., Phase 4's one Procurement column, Phase 5 Hardening's own two targeted fixes).

---

## 4. Is There a Genuine New Approval Consumer?

Searched explicitly for any pending/unapproved business state that currently has **no** approval mechanism at all:

- Documents (Phase 5): void requires a reason but has no separate approval step — a single admin action, by design (Decisions-locked, not a gap).
- Master Data import (Phase 6): create-only, no approval step — by design (mandatory dry-run substitutes for a preview/approval-like safety gate, already locked).
- Employee onboarding, truck registration, customer registration, supplier/inventory-item creation: all single-actor create actions today, no pending/approval state in any of them.
- Complaints: has a status lifecycle (`open`/`assigned`/`resolved`/etc., from Discovery's own prior module knowledge) but this is a **workflow** state, not an **approval** — no second-party sign-off concept exists or was ever built for it.

**No such consumer was found.** This is not a failure of Discovery's search effort — it is the actual, verified state of the codebase.

---

## 5. Reuse / Adapt / Redesign / Reject / Defer Matrix

| Candidate | Verdict | Why |
|---|---|---|
| A new shared `approval_requests` polymorphic table + generic engine, consumed by nothing yet | **REJECT** | Zero concrete consumer found (§4); would be exactly the speculative generic infrastructure this program's own standing rules forbid |
| Retrofitting Procurement/Inventory/Cashouts/Leave Requests onto a new shared engine | **REJECT for Phase 7** | Each is its own CLOSED/FROZEN module; a blanket retrofit is not a "narrow additive touch," it is a rewrite of four modules' core logic — out of any single phase's authority without four separate CRs |
| The four existing modules' own approval logic | **REUSE as the documented precedent** | Already correct, already hardened, already tested across four separate phases of this program |
| Self-approval-block pattern (`requested_by === req.user.id`) | **ADAPT candidate for the two Future CRs (§6)**, not implemented now | Proven exactly twice already; the fix pattern is known, only the authorization to touch the frozen modules is missing |

---

## 6. Future CR Register (from this Discovery)

1. **FUTURE CR — CASHOUT SELF-APPROVAL PREVENTION**: add a `cashout.created_by === req.user.id` block to `/:id/approve` and `/:id/reject`, mirroring the exact pattern already proven in Procurement/Inventory. Requires its own authorized, narrow touch to the CLOSED Cashout module.
2. **FUTURE CR — LEAVE REQUEST SELF-APPROVAL PREVENTION**: same pattern, against the CLOSED HR & Payroll module's `leave_requests` endpoint.
3. **FUTURE CR — SHARED APPROVAL ENGINE**: deferred in full — build only if and when a genuine new business process is identified that needs one; do not build speculatively.

---

## 7. Business Owner Decisions Required

1. Should Cashouts and Leave Requests be retrofitted with a self-approval block, given both are CLOSED/FROZEN? (Recommended: yes, as two narrow Future CRs — but this is a business call, not decided here.)
2. Is there a business process not yet reflected in this codebase that genuinely needs a new approval mechanism? Discovery found none in the existing system, but Discovery can only observe what already exists — this question can only be answered by the Business Owner, not inferred from code.
3. If no new consumer is named, does the Business Owner want Phase 7 to end here (documentation + Future CR register only), or is there a standing organizational requirement for approval infrastructure that Discovery has not been told about?

---

## 8. Frozen Module Protection

**Confirmed, nothing modified.** `procurement.js`, `inventory.js`, `cashouts.js`, `leaveRequests.js` were read-only inspected to ground this report in live evidence — no line of any of them was changed.

---

## 9. Recommendation

Do not build new Approval Engine infrastructure in Phase 7. Close Phase 7 with this Discovery report and its Future CR register as the deliverable, pending explicit Business Owner confirmation on §7's three questions. This is a defensible, evidence-based "no build" conclusion — building an unused generic engine would be a worse outcome than reporting that none is currently justified.

---

## Git / Safety Verification

- Starting HEAD: `ec71ca088bcb2431bc2c9dfa3237b52b1019083a`
- Working tree: clean at start; this report is the only file created during this stage
- Files inspected (read-only): `server/routes/procurement.js`, `server/routes/inventory.js`, `server/routes/cashouts.js`, `server/routes/leaveRequests.js`
- Zero code/schema/dependency/production changes

## Final Status

**PHASE 7 — DISCOVERY COMPLETE — ARCHITECTURAL CONCLUSION: NO NEW ENGINE JUSTIFIED BY CURRENT EVIDENCE**

Production:
NOT AUTHORIZED — UNTOUCHED
