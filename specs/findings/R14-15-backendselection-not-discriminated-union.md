## Finding: BackendSelection type is not a discriminated union — allows invalid configurations at type level
Severity: Medium
Category: Robustness > Error handling quality; Correctness > Missing negatives
Location: `src/startup.ts` lines 102–109; `specs/architecture/api-contracts-firecrest.md` lines 82–101
Spec reference: FP-INV-1 (--backend defaults to firecrest); FP-INV-2 (local backend not production); createCeraSystem()

### Description

The `BackendSelection` interface is defined as:

```typescript
export interface BackendSelection {
  readonly type: BackendType;
  readonly firecrestConfig?: FirecrestConfig;
  readonly dshConfig?: DshConfig;
}
```

This allows invalid configurations at the TypeScript type level:
1. `{ type: 'firecrest' }` — no `firecrestConfig`. Valid at compile
   time, fails at runtime (createFirecrestSystem throws).
2. `{ type: 'firecrest', dshConfig: {...} }` — dshConfig provided
   but ignored. Misleading.
3. `{ type: 'dev' }` — no `dshConfig`. Valid at compile time, fails
   at runtime (createDevSystem throws).
4. `{ type: 'dev', firecrestConfig: {...} }` — firecrestConfig
   provided but ignored. Misleading.

A **discriminated union** would catch all of these at compile time:

```typescript
export type BackendSelection =
  | { readonly type: 'firecrest'; readonly firecrestConfig: FirecrestConfig }
  | { readonly type: 'dev'; readonly dshConfig?: DshConfig };
```

The current interface also appears in `api-contracts-firecrest.md`
(lines 82–101) with the same non-discriminated structure. The spec
document and the source code are consistent with each other, but
both are type-unsafe.

**Impact:** An implementer following the spec could write
`createCeraSystem({ backend: { type: 'firecrest' } })` and not get a
compile-time error — only a runtime error with a message. The error
message (`startup.ts` lines 243–248) is clear, but a type error
would be caught earlier and more reliably.

### Evidence

1. `src/startup.ts` lines 102–109: `BackendSelection` interface with
   both `firecrestConfig?` and `dshConfig?`.
2. `specs/architecture/api-contracts-firecrest.md` lines 82–101: same
   structure.
3. `src/startup.ts` lines 242–248: runtime check for missing
   `firecrestConfig`.
4. `src/startup.ts` lines 298–303: runtime check for missing
   `dshConfig`.

### Suggested resolution

Change `BackendSelection` to a discriminated union (as shown above)
in both `src/startup.ts` and `api-contracts-firecrest.md`. This
eliminates the runtime checks in `createFirecrestSystem()` and
`createDevSystem()` for missing config, and catches invalid
combinations at compile time.
