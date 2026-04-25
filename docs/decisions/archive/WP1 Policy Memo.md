Status: Archived. This document is not canonical.

## WP1 Policy Memo — Receiving → QC → Putaway

**Status:** Approved business policy
**Scope:** Inbound receipt QC only
**Applies to:** Chocolate factory operations for finished goods / relevant inbound stock
**Purpose:** Define the simple, low-friction business rules the system must implement for receipt QC hold handling.

---

### 1. Policy intent

This policy exists to support a small-to-mid scale chocolate factory that values:

* simple operations
* low admin overhead
* fast flow of good stock
* clear handling of questionable stock
* no dead-end or forgotten “held” inventory

The system should prevent obvious mistakes without introducing heavy process.

---

### 2. Business definitions

#### Accepted

Stock is good and may move forward into normal storage / availability.

#### Hold

Stock is **temporarily set aside pending decision**.
It is **not yet accepted** and **not yet finally rejected**.

Hold means:

> “Do not use or sell this yet. Decide soon.”

#### Rework

Held stock is routed out of normal flow for remake / reuse according to factory practice.

#### Discard

Held stock is finally removed from usable inventory.

---

### 3. Agreed business rules

#### Rule 1 — Meaning of hold

A **hold** is a temporary set-aside state for questionable stock.

Examples:

* packaging issue
* labeling uncertainty
* texture or appearance concern
* suspected quality problem needing a quick decision

Hold is reversible.
Hold is not a final state.

---

#### Rule 2 — When QC is complete

QC is **not complete** while any quantity remains on hold.

QC is complete only when all inspected quantity has been fully resolved into one of:

* accepted
* rework
* discard

This prevents “finished but still unresolved” stock states.

---

#### Rule 3 — Partial flow is allowed

If part of a receipt/batch is clearly good and another part is questionable:

* the **good quantity may move forward**
* the **held quantity remains blocked**

Example:

* 100 bars received/produced
* 95 accepted
* 5 held

Result:

* 95 can proceed to putaway / available stock
* 5 remain isolated until resolved

This is the approved business rule because it keeps operations moving with minimal friction.

---

#### Rule 4 — Allowed outcomes for held stock

Held stock may later be resolved as one of:

1. **Release**
   The stock is judged acceptable and may re-enter normal flow.

2. **Rework**
   The stock is routed to remake / reuse flow.

3. **Discard**
   The stock is removed as unusable.

No additional hold outcomes are part of the approved baseline workflow.

---

#### Rule 5 — Hold resolution owner

The **factory lead / inbound QC authority** is responsible for deciding the final disposition of held stock.

This decision should not require committee review or multi-step approval in the normal case.

One clear owner keeps the process fast and reduces ambiguity.

---

#### Rule 6 — Hold vs reject/discard

The business distinction is:

* **Hold** = temporary and reversible
* **Discard / reject** = final and irreversible within the normal flow

The system should preserve this distinction clearly.

---

### 4. Operational rules

#### Physical handling

Held stock must be:

* visibly separated from usable stock
* not mixed with accepted inventory
* easy for staff to identify

A simple dedicated hold area / shelf / bin is sufficient.

---

#### Resolution timing

Held stock should be resolved quickly.

Target:

* same day where practical
* next working day at the latest in normal operations

The goal is to avoid forgotten hold inventory.

---

#### Simplicity rule

The workflow should remain lightweight:

* no complex scoring model
* no multi-stage QC workflow
* no heavy approval chain
* no unnecessary blocking of good stock because a small amount is questionable

---

### 5. Required system behavior derived from policy

The software must support all of the following:

1. accepted and held quantities may coexist from the same original receipt line or batch
2. accepted quantity may proceed while held quantity remains blocked
3. QC remains incomplete while unresolved hold exists
4. held quantity can later transition to:

   * released/accepted
   * rework
   * discard
5. held quantity must not silently become available
6. held quantity must remain visible and explainable until resolved

---

### 6. State transition table

| State                 | Meaning                                         | Allowed next states                  |
| --------------------- | ----------------------------------------------- | ------------------------------------ |
| Received / QA Pending | stock received and awaiting QC resolution       | Accepted, Hold, Discard              |
| Accepted              | stock approved for normal flow                  | Putaway / Available                  |
| Hold                  | temporarily blocked pending decision            | Release to Accepted, Rework, Discard |
| Rework                | removed from normal stock flow for remake/reuse | external rework process              |
| Discard               | final unusable outcome                          | none                                 |

---

### 7. Implementation implications

This policy means the system must support **split disposition** on one receipt/batch:

* accepted quantity moves forward immediately
* held quantity remains blocked
* later hold resolution operates only on the held quantity

This also means the current behavior is invalid if it:

* marks QC complete while hold remains unresolved
* blocks the accepted quantity from moving forward solely because another quantity is on hold
* lacks a hold-resolution path

---

### 8. Decision summary

| Question                                           | Approved answer                            |
| -------------------------------------------------- | ------------------------------------------ |
| What does hold mean?                               | temporary set-aside pending decision       |
| When is QC complete?                               | only when no unresolved hold remains       |
| Can good stock move forward while some is on hold? | yes                                        |
| What can happen to held stock?                     | release, rework, discard                   |
| Who decides?                                       | factory lead / inbound QC authority        |
| Is hold different from reject/discard?             | yes — hold is reversible, discard is final |

---

### 9. Approval note

This memo is the authoritative business-policy input for:

* WP2 — QC completion semantics
* WP3 — hold disposition implementation
* WP4 — allocation/state handling
* WP5 — putaway behavior
* WP6 — hold-path test coverage

## Clear next step

The next implementation task is:

> **WP2 — update QC completion semantics to match this policy**
