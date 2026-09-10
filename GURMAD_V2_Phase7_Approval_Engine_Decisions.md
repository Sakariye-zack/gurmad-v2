# GURMAD V2 — Phase 7: Approval Engine — Decisions

**Baseline:** V2 HEAD `ec71ca088bcb2431bc2c9dfa3237b52b1019083a`, built on `GURMAD_V2_Phase7_Approval_Engine_Discovery_Report.md`.
**Business Owner decision, given directly in conversation**: combine the two viable options Discovery raised — fix the two identified self-approval gaps, and close Phase 7 without building new generic infrastructure (no new approval-needing process was identified).

## Locked Decisions

1. **No new Approval Engine is built.** Discovery §4 found zero business process currently lacking an approval mechanism. Confirmed by the Business Owner — no such process was named. **LOCKED.**
2. **FUTURE CR — CASHOUT SELF-APPROVAL PREVENTION: PROMOTED TO IN-SCOPE.** A narrow, additive fix to the CLOSED Cashout module: `PUT /:id/approve` and `PUT /:id/reject` must reject when `cashout.created_by === req.user.id`, mirroring the exact pattern already proven in Procurement (`routes/procurement.js:281,350,379`) and Inventory Adjustments (`routes/inventory.js:662`). **LOCKED.**
3. **FUTURE CR — LEAVE REQUEST SELF-APPROVAL PREVENTION: PROMOTED TO IN-SCOPE.** Same pattern, against the CLOSED HR & Payroll module's `PUT /leave-requests/:id/status` — reject when `leave_request` was created for an employee record linked to the approving user's own account (i.e., `req.user.id` resolves to the same employee the request belongs to), mirroring the existing `resolveEmployeeIdForRequestUser`/`assertEmployeeInScope` helpers already in that file. **LOCKED.**
4. **Scope boundary**: both fixes are self-approval-block only — no other business rule, field, role, or endpoint in either module is touched. This is the same "narrow, disclosed, explicitly authorized exception to a frozen module" pattern already used in Phase 4 (one Procurement column) and Phase 5 Hardening (two targeted fixes).
5. Discovery's Future CR #3 (shared Approval Engine) remains deferred — not promoted.

## Final Status

**PHASE 7 — DECISIONS COMPLETE — READY FOR IMPLEMENTATION (2 narrow frozen-module fixes only)**

Production: NOT AUTHORIZED — UNTOUCHED
