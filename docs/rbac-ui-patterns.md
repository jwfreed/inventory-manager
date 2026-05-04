# RBAC UI Patterns

## Principle

**Backend RBAC is authoritative.** Route-level and action-level permission checks in the API are the enforcement point. Frontend guards are UX + defense-in-depth: they prevent confusion and reduce unnecessary API calls, but they do not replace backend enforcement.

---

## Required UI Mutation Pattern

Every mutation surface must follow this five-point pattern in order:

### 1. `canX` capability variable

Declare a composite boolean that combines the required permission with any relevant domain state:

```tsx
const canCloseWorkOrder =
  hasPermission('production:write') &&
  !!workOrderQuery.data &&
  actionPolicy.canClose
```

- Name it `canX` where X is the action (e.g. `canSaveLocation`, `canRunKpis`, `canCloseWorkOrder`).
- Include both the RBAC permission and any domain preconditions.
- Do **not** use raw `hasPermission(...)` directly in JSX. Assign it to a `canX` or a named helper variable first.

### 2. Named handler function

Wrap the mutation call in a named handler that guards on `canX`:

```tsx
const handleCloseWorkOrder = () => {
  if (!canCloseWorkOrder) return
  closeMutation.mutate()
}
```

- Do **not** use inline arrow functions that call `.mutate()` directly in JSX event props.

### 3. Execution-level guard

The guard in the handler (`if (!canX) return`) is the execution boundary. It must always be present even when disabled state is also set. This prevents a bypassed disabled state from triggering a mutation.

### 4. Declarative JSX with named handler

Use the named handler in JSX:

```tsx
<Button onClick={handleCloseWorkOrder} disabled={!canCloseWorkOrder || mutation.isPending}>
  Close Work Order
</Button>
```

Do **not** use `onClick={() => mutation.mutate()}` inline.

### 5. `disabled` mirrors `canX`

The `disabled` prop on mutation controls must use the corresponding `canX` variable, not a partial reimplementation:

```tsx
// BAD – missing permission check
disabled={!hasDescriptionChanges || mutation.isPending}

// GOOD – uses canX which already includes the permission
disabled={!canSaveWorkOrderDescription || mutation.isPending}
```

---

## Protected Action Entry Points

Any button, link, or control that opens a confirmation modal, drawer, dialog, popover, or form for a protected action is itself a protected entry point. Users without the required permission must not be able to trigger it.

### Opener handler must guard on `canX`

```tsx
// BAD – domain-only condition; user without permission can open the modal
const canClose = actionPolicy.canClose

const handleRequestClose = () => {
  setShowCloseConfirm(true) // no permission check
}

<Button onClick={handleRequestClose} disabled={!actionPolicy.canClose}>
  Close
</Button>

// GOOD – opener handler guards on permission-aware canX
const canCloseWorkOrder =
  hasPermission('production:write') &&
  !!workOrderQuery.data &&
  actionPolicy.canClose

const handleRequestClose = () => {
  if (!canCloseWorkOrder) return
  setShowCloseConfirm(true)
}

<Button onClick={handleRequestClose} disabled={!canCloseWorkOrder}>
  Close
</Button>
```

### Child component props must receive permission-aware capability

```tsx
// BAD – domain-only value passed to child; unauthorized users see the button
<Actions canCancel={actionPolicy.canCancel} onRequestCancel={handleRequestCancel} />

// GOOD – permission-aware capability passed to child
const canCancelWorkOrder =
  hasPermission('production:write') &&
  !!workOrder &&
  actionPolicy.canCancel

<Actions canCancel={canCancelWorkOrder} onRequestCancel={handleRequestCancel} />
```

### Summary rule

Every entry point to a protected action (button, menu item, link) must satisfy all three of:
1. `disabled` (or hidden) state uses permission-aware `canX`
2. Handler guards with `if (!canX) return` before opening UI
3. Child `canX` props receive the permission-aware variable, not a domain-only policy

---

## Modal Openers (legacy note)

The pattern above supersedes the simpler disabled-only example below. For new code, always use a named handler with an explicit guard.

```tsx
// Acceptable for read-only toggles (no protected mutation inside)
const canInitiateBomActivation = hasPermission('masterdata:write')
<Button onClick={() => setShowActivate(true)} disabled={!canInitiateBomActivation}>Activate</Button>
```

The confirm button inside the modal must use the full `canX` (including domain preconditions).

---

## Permission-Denied Helper Text

Where a user can see a disabled or unavailable action, provide a concise explanation:

```tsx
{!canRunKpis && (
  <p className="text-xs text-slate-500">
    You need planning write permission to run KPI calculations.
  </p>
)}
```

Guidelines:
- Add helper text only where the user may be confused about why an action is unavailable.
- Do not add noisy text to every disabled button.
- Use `ActionGuardMessage` for section-level lockouts; use a simple `<p>` for individual button helpers.
- Do not expose internal permission names (e.g. `planning:write`) to end users in production copy.

---

## Shared Hooks / Contexts / Services

Files in `hooks/`, `context/`, and `services/` directories are trust-boundary files. If they contain mutations, they require file-level guards (a `hasPermission` call at the top of the hook/function, not delegated to the caller). Route-level protection is not sufficient for shared mutation surfaces.

---

## What Not To Do

| Pattern | Why it's wrong |
|---|---|
| `onClick={() => mutation.mutate()}` inline in JSX | Bypasses named handler and execution guard |
| `hasPermission(...)` directly in JSX attribute | Violates canX convention; hard to test and audit |
| `disabled={mutation.isPending}` without canX | Allows unauthorized users to trigger mutation if they bypass the button |
| Relying on `disabled` alone as the security boundary | `disabled` can be bypassed; the handler guard is the enforcement point |
| Using a read permission for a write/mutation action | Incorrect permission scope; backend will reject |
| Hiding actions without any explanation | Harms usability for authorized users who may be confused |

---

## Running the Scanner

To check for unguarded mutations locally:

```sh
npm --prefix ui run check:mutation-guards
```

The scanner runs as a blocking CI check on every push. A non-zero `UNGUARDED` count fails CI.

Classifications returned by the scanner:
- `FILE_GUARDED` — file has a direct permission guard
- `ROUTE_PROTECTED` — file is protected by a route-level permission
- `SUB_COMPONENT` — file is a sub-component of a protected parent
- `UNCERTAIN` — file could not be resolved to a known protection; review manually
- `UNGUARDED` — file has mutations with no detectable guard; CI fails

---

## Example Reference Implementations

| File | Guard type | Permission |
|---|---|---|
| `ui/src/features/kpis/pages/DashboardPage.tsx` | `canRunKpis` | `planning:write` |
| `ui/src/features/locations/components/LocationForm.tsx` | `canSaveLocation` | `masterdata:write` |
| `ui/src/features/workOrders/pages/WorkOrderDetailPage.tsx` | `canCloseWorkOrder`, `canSaveWorkOrderDescription` | `production:write` |
| `ui/src/features/boms/components/BomCard.tsx` | `canInitiateBomActivation`, `canActivateBom` | `masterdata:write` |
| `ui/src/features/routings/pages/WorkCentersPage.tsx` | `canWriteWorkCenters` | `production:write` |
