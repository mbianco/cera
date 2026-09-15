# Escalation 004: registerDataset references non-existent DataError.LocationNotResolved

**Status:** OPEN
**Raised by:** Implementer (Phase 3 — data-management)
**Date:** 2026-09-15
**Type:** Spec gap (api-contracts.md vs src/types/errors.ts)

## Description

The API contract in `api-contracts.md` §5 (data-management) contains
the following JSDoc for `registerDataset`:

```typescript
/**
 * @throws {DataError.LocationNotResolved} if the Location does
 *   not resolve to a valid path (INV-D4, FM-D3).
 */
registerDataset(input: RegisterDatasetInput): Promise<Dataset>;
```

However, `DataError.LocationNotResolved` does not exist in
`src/types/errors.ts`. The DataError hierarchy in errors.ts only
contains:

- `LocationNotReadable` (FM-D3, INV-D4) — constructor takes
  `{ path, cause: 'enoent' | 'eacces' | 'slow' }`
- `LocationNotWritable` (FM-D3, INV-D4) — constructor takes
  `{ path, cause: 'enoent' | 'eacces' | 'slow' }`
- `DataQuotaExceeded` (FM-D1)
- `ProvenanceMissing` (INV-D3, FM-P3)
- `DatasetCorrupted` (FM-D5)

The error-taxonomy.md also only lists `LocationNotReadable` and
`LocationNotWritable` under DataError — there is no
`LocationNotResolved`.

## Impact

`registerDataset()` needs to validate the Location before registering
a Dataset (INV-D4, FM-D3), but the error type named in the contract
does not exist. This is a naming inconsistency between the API
contract JSDoc and the actual error class hierarchy.

## Proposed resolution

Since `registerDataset()` validates that the Dataset's Location is
accessible (the file/store should already exist and be readable at
registration time, regardless of whether the Dataset is an input or
output), use `LocationNotReadable` — the closest existing error type.
This is consistent with the `validateLocation(location, 'read')`
enforcement point for INV-D4.

If the architect intends a distinct `LocationNotResolved` error type
(for cases where the Location cannot be classified as read or write),
it should be added to `src/types/errors.ts` and the error taxonomy.
Until then, `LocationNotReadable` is used for `registerDataset()`
Location validation failures.

## Workaround

Phase 3 implementation uses `LocationNotReadable` for
`registerDataset()` Location validation. All other Location validation
uses `LocationNotReadable` (read mode) and `LocationNotWritable`
(write mode) as specified.
