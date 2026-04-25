Status: Archived. This document is not canonical.

## **Remediation implementation brief**

### **Goal**

Convert the accepted **Receiving → QC → Putaway** audit into a bounded implementation plan that keeps execution in scope, resolves the hold-path defect cleanly, and defines acceptance criteria before coding.

### **Recommended location**

`/docs/implementation/receiving-qc-putaway-remediation-plan.md`

---

# **Receiving → QC → Putaway Remediation Plan**

## **1\. Purpose**

This document converts the accepted audit of the **Receiving → QC → Putaway** workflow into an implementation-ready remediation plan.

It exists to:

* define the work required to close the audited defects  
* resolve policy decisions before code changes  
* sequence implementation safely  
* define acceptance criteria for each work package  
* support issue creation and agent execution

This is an **execution document**, not a canonical architecture reference.

---

## **2\. Governing inputs**

This plan is based on the accepted audit artifact for:

* **Receiving → QC → Putaway**

The audit established that the workflow is **INCOMPLETE** due primarily to:

* no implemented hold-release path within the audited workflow  
* QC completion semantics that count held quantity toward completion  
* putaway correctly blocking held inventory, but with no release path to unblock  
* insufficient test coverage for hold-path behavior

---

## **3\. Scope**

### **In scope**

* receipt-line QC hold lifecycle within **Receiving → QC → Putaway**  
* receipt lifecycle and state transitions affected by hold semantics  
* allocation transitions required to support hold resolution  
* putaway gating logic affected by hold semantics  
* tests required to prove corrected behavior

### **Out of scope**

* shipment allocation / pick-pack-ship  
* production reporting / QA warehouse receipt  
* cycle count / reconciliation  
* planning / MRP  
* any generalized inventory hold workflow outside the inbound receipt boundary, unless explicitly required by the chosen policy

---

## **4\. Required policy decisions**

These must be decided before implementation begins.

### **PD-1 — Meaning of `hold`**

Choose one:

| Option | Meaning | Consequence |
| ----- | ----- | ----- |
| A | hold \= temporary pending disposition within inbound QC | requires explicit release/reject path in this workflow |
| B | hold \= terminal diversion to another workflow | inbound workflow must explicitly hand off and stop claiming completeness |
| C | hold \= warehouse disposition state independent of receipt QC completion | requires explicit cross-workflow contract |

### **PD-2 — Can `QC_COMPLETED` occur while `holdQty > 0`?**

Choose one:

| Option | Meaning | Consequence |
| ----- | ----- | ----- |
| A | No | QC remains unresolved until hold is dispositioned |
| B | Yes, but only if downstream hold-resolution path exists | lifecycle must remain operable after completion |
| C | Yes, and inbound workflow ends there | requires explicit documented handoff out of scope |

### **PD-3 — Can partially accepted quantity be put away while some quantity remains on hold?**

Choose one:

| Option | Meaning | Consequence |
| ----- | ----- | ----- |
| A | No partial putaway while any hold remains | simpler invariants, stricter blocking |
| B | Yes, accepted quantity may proceed | more complex allocation and availability rules |

### **PD-4 — Where does hold release live?**

Choose one:

| Option | Meaning | Consequence |
| ----- | ----- | ----- |
| A | receipt QC action | keeps lifecycle local to audited boundary |
| B | warehouse disposition action | requires alignment between receipt-line and warehouse-level semantics |
| C | separate inventory workflow | requires explicit handoff contract |

## **Recommendation on policy**

Use this unless business constraints require otherwise:

| Decision | Recommendation | Why |
| ----- | ----- | ----- |
| PD-1 | A | hold is best treated as temporary pending inbound disposition |
| PD-2 | A | prevents false completeness and dead-end states |
| PD-3 | A | reduces complexity and preserves simple receipt-line invariants |
| PD-4 | A | keeps responsibility inside the audited workflow boundary |

This is the cleanest model operationally and architecturally. It minimizes ambiguity, keeps state transitions local, and aligns with the audit finding that the current workflow is internally inconsistent.

---

## **5\. Target end-state**

The workflow is considered remediated when all of the following are true:

1. A receipt-line placed on QC hold can be dispositioned through a supported path.  
2. No receipt lifecycle state claims completion while unresolved hold remains, unless that state has a documented, implemented resolution path.  
3. Putaway behavior matches the chosen policy for mixed accept/hold cases.  
4. Allocation transitions support the chosen hold lifecycle without invariant breaks.  
5. Contract, truth, and scenario/e2e coverage prove both happy path and hold path.  
6. The workflow can be re-audited and marked complete.

---

## **6\. Work packages**

## **WP1 — Finalize hold lifecycle policy**

### **Objective**

Resolve the domain ambiguity before modifying code.

### **Required outcome**

A written decision on:

* hold meaning  
* QC completion semantics  
* partial putaway semantics  
* ownership of hold release

### **Deliverables**

* short ADR or decision memo  
* explicit state transition table  
* updated terminology for `hold`, `reject`, `accept`

### **Acceptance criteria**

* one policy chosen for each PD-1 through PD-4  
* no contradictory language remains between receipt-line QC and warehouse disposition language  
* implementation can proceed without guessing semantics

### **Dependencies**

None

### **Recommended owner**

Human decision-maker first, with model assistance if needed

---

## **WP2 — Correct QC completion semantics**

### **Objective**

Ensure lifecycle completion logic matches the chosen hold policy.

### **Required outcome**

`evaluateQcCommand` and related lifecycle logic no longer allow semantically invalid completion states.

### **Candidate implementation**

Depending on policy:

* change completion condition so `holdQty > 0` prevents `QC_COMPLETED`  
* or allow completion only if a valid post-completion hold-resolution path exists and is fully implemented

### **Acceptance criteria**

* lifecycle behavior is explicitly aligned with policy  
* no receipt can enter a dead-end state inside the audited boundary  
* tests prove behavior for:  
  * full accept  
  * full hold  
  * partial accept \+ partial hold  
  * full reject

### **Dependencies**

WP1

---

## **WP3 — Implement hold disposition path**

### **Objective**

Add the missing operational path for held receipt quantity.

### **Required outcome**

Held receipt quantity can move through the chosen disposition path without violating allocation or lifecycle invariants.

### **Candidate implementation**

If hold remains an inbound QC concern:

* add hold-release command/service  
* add route or endpoint for hold release  
* support HOLD → AVAILABLE or HOLD → REJECTED/other resolved destination as policy requires

### **Acceptance criteria**

* supported disposition path exists in code  
* auditable movement is recorded  
* receipt allocations can transition from hold state per policy  
* lifecycle can progress after disposition  
* idempotency and transaction boundaries are preserved

### **Dependencies**

WP1, WP2

---

## **WP4 — Update allocation model and guards**

### **Objective**

Ensure allocation transitions support the corrected lifecycle.

### **Required outcome**

Allocation model accepts all policy-approved transitions and rejects all forbidden ones.

### **Candidate implementation**

* extend guarded transitions to support hold-source movement if policy requires it  
* preserve explicit erroring on unsupported status transitions  
* update rebuild/validation logic if needed

### **Acceptance criteria**

* allocation sums remain conserved  
* traceability remains intact  
* hold-related transitions are explicitly permitted or explicitly forbidden according to policy  
* no hidden mutation paths are introduced

### **Dependencies**

WP1, WP3

---

## **WP5 — Align putaway gating with chosen policy**

### **Objective**

Ensure putaway behavior matches the corrected hold model.

### **Required outcome**

Putaway create/post logic behaves correctly for:

* any remaining hold  
* mixed accepted/held quantities  
* resolved hold

### **Candidate implementation**

* preserve strict block when any hold remains, if PD-3 \= A  
* or permit partial accepted putaway with explicit limits, if PD-3 \= B

### **Acceptance criteria**

* create-time and post-time logic are aligned  
* availability/planning signals reflect corrected behavior  
* no mismatch exists between QC resolution state and putaway eligibility

### **Dependencies**

WP1, WP2, WP3, WP4

---

## **WP6 — Add contract and truth coverage**

### **Objective**

Prove the corrected behavior, not just implement it.

### **Required outcome**

Automated tests cover all key hold-path scenarios and invariants.

### **Minimum required tests**

* receipt → QC hold → putaway blocked  
* receipt → QC hold → hold release → putaway succeeds  
* partial accept \+ partial hold behavior per policy  
* full hold behavior per policy  
* lifecycle state correctness after each step  
* allocation conservation after each step  
* replay/idempotency on new hold-disposition operation  
* any CI-excluded QC integration tests either restored or intentionally replaced

### **Acceptance criteria**

* required tests exist and pass  
* hold-path behavior is proven, not inferred  
* excluded QC test coverage gap is resolved

### **Dependencies**

WP2, WP3, WP4, WP5

---

## **WP7 — Re-audit inbound boundary**

### **Objective**

Close the loop and confirm remediation actually resolved the audited defects.

### **Required outcome**

A targeted follow-up audit confirms:

* no remaining dead-end states in scope  
* lifecycle semantics are coherent  
* hold-path behavior is fully evidenced  
* workflow can be marked complete

### **Acceptance criteria**

* updated audit status for Receiving → QC → Putaway \= COMPLETE  
* any residual gaps are explicitly documented as out of scope

### **Dependencies**

WP6

---

## **7\. Dependency order**

WP1  
 ├─\> WP2  
 ├─\> WP3  
      └─\> WP4  
WP2 \+ WP3 \+ WP4  
 └─\> WP5  
WP2 \+ WP3 \+ WP4 \+ WP5  
 └─\> WP6  
WP6  
 └─\> WP7

### **Practical order**

1. WP1  
2. WP2  
3. WP3  
4. WP4  
5. WP5  
6. WP6  
7. WP7

---

## **8\. Implementation guardrails**

These constraints apply to all work packages.

### **Invariants that must remain true**

* ledger remains append-only  
* allocation totals remain conserved  
* idempotent command behavior is preserved  
* transaction boundaries remain explicit  
* no silent mutation path is introduced  
* putaway eligibility is explainable from explicit state

### **Anti-drift rules**

* do not expand into outbound or planning workflows  
* do not use cycle count or reconciliation concepts to paper over inbound defects  
* do not weaken existing guards to “make tests pass”  
* do not introduce ambiguous terminology between hold/reject/disposition states

---

## **9\. Issue-ready breakdown**

### **Issue 1**

**Title:** Decide inbound QC hold lifecycle policy  
**Maps to:** WP1

### **Issue 2**

**Title:** Correct receipt QC completion semantics for held quantity  
**Maps to:** WP2

### **Issue 3**

**Title:** Implement receipt-line QC hold disposition path  
**Maps to:** WP3

### **Issue 4**

**Title:** Update receipt allocation transitions for hold lifecycle  
**Maps to:** WP4

### **Issue 5**

**Title:** Align putaway gating with corrected hold policy  
**Maps to:** WP5

### **Issue 6**

**Title:** Add hold-path contract, truth, and scenario coverage  
**Maps to:** WP6

### **Issue 7**

**Title:** Re-audit Receiving → QC → Putaway after remediation  
**Maps to:** WP7

---

## **10\. Recommendation**

Do **not** start with WP3.

Start with **WP1** immediately. The audit has already narrowed the problem enough that implementation can move soon, but the hold semantics still need one explicit domain decision first.

Once WP1 is decided, the cleanest execution path is:

* fix completion semantics  
* implement hold disposition  
* align allocations and putaway  
* add coverage  
* re-audit

---

## **11\. Clear recommendation**

**Next step: yes, move into implementation planning now — not direct freeform coding.**  
Use this remediation brief as the control document, then execute **one work package at a time**.

If you want the most efficient next move, the next artifact should be:  
**a prompt for Sonnet or Codex to produce WP1: the policy decision memo \+ state transition table.**

