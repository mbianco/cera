# Escalation 005: LocationNotReadable/LocationNotWritable do not store 'cause' as a public field

**Status:** RESOLVED
**Raised by:** Implementer (Phase 3 — data-management)
**Date:** 2026-09-15
**Type:** Bug in `src/types/errors.ts`

## Description

`LocationNotReadable` and `LocationNotWritable` accept a `cause`
parameter in their constructors but do not store it as a public
readonly field. The `cause` is only embedded in `userMessage` and
`internalDetails` strings.

```typescript
export class LocationNotReadable extends DataError {
  readonly kind = 'location_not_readable';
  readonly severity = 'HIGH' as const;
  // cause is NOT stored as a field

  constructor(props: { path: string; cause: 'enoent' | 'eacces' | 'slow' }) {
    super({
      userMessage: `Dataset location '${props.path}' could not be read: ${props.cause}.`,
      internalDetails: `Location ${props.path}: ${props.cause}`,
      recoveryHint: 'Verify the path or select a different Dataset.',
      specRef: 'invariants.md INV-D4; failure-modes.md FM-D3',
      // cause: props.cause  -- NOT passed to CeraError
    });
  }
}
```

## Impact

The `cause` discriminator ('enoent', 'eacces', 'slow') is listed in
`error-taxonomy.md` as part of the error discriminator:

> Discriminator: `{ kind: 'location_not_readable' | 'location_not_writable'; path: string; cause: 'enoent' | 'eacces' | 'slow' }`

But callers cannot access `cause` after the error is thrown. This is
needed by `DataManagementServiceImpl.validateLocation()` to emit
`DatasetEvent.location_invalid` events, which require a `cause`
field:

```typescript
export interface DatasetLocationInvalid {
  readonly kind: 'dataset_location_invalid';
  readonly datasetId: DatasetId;
  readonly path: string;
  readonly cause: 'enoent' | 'eacces' | 'slow';
  readonly timestamp: Date;
}
```

## Resolution

Added `readonly cause` as a public field on `LocationNotReadable` and
`LocationNotWritable`, assigned in the constructor from `props.cause`.
This is compatible with `Error.cause?: unknown` (narrower type is a
subtype) and does not affect any existing tests (these error classes
are new to Phase 3 — no prior tests reference them).

The fix is minimal: two fields added, two assignments in constructors.
All existing tests continue to pass.
