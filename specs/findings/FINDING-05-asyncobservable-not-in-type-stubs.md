## Finding: AsyncObservable<T> is used in API contracts but not defined in type stubs
Severity: High
Category: Correctness > Specification compliance
Location: specs/architecture/api-contracts.md (lines 222, 226, 574, 577, 686, 953–970); src/types/ (value-objects.ts, entities.ts, events.ts, errors.ts, index.ts)
Spec reference: api-contracts.md §2 (scheduling), §6 (tool-invocation), "AsyncObservable Type" section

### Description

Three API contracts return `AsyncObservable<T>`:

1. `SchedulingService.JobMonitor.watch(jobId): AsyncObservable<JobEvent>`
2. `ToolInvocationService.monitorInvocation(invocationId): AsyncObservable<ToolInvocationEvent>`
3. `CaseService.monitorCase(caseId): AsyncObservable<CaseState>`

The type is defined inline in `api-contracts.md` (lines 960–969):

```typescript
interface AsyncObservable<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>;
  subscribe(callback: (event: T) => void): () => void;
  cancel(): void;
}
```

However, `AsyncObservable<T>` is **not defined** in any of the type
stub files (`src/types/value-objects.ts`, `entities.ts`, `events.ts`,
`errors.ts`, `index.ts`). An implementer following the contract
cannot `import type { AsyncObservable } from './types'` — it doesn't
exist.

The api-contracts.md import block (lines 18–36) lists all shared
types but does not include `AsyncObservable`. The type is defined
only in the prose section at the end of api-contracts.md.

### Evidence

1. `grep -rn "AsyncObservable" src/types/` → 0 matches.
2. `grep -n "AsyncObservable" specs/architecture/api-contracts.md`
   → 9 matches (3 in contract signatures, 1 in module-graph.md,
   5 in the inline definition section).

### Suggested resolution

Add `AsyncObservable<T>` to `src/types/value-objects.ts` (or a new
`src/types/async.ts`) and export it via `src/types/index.ts`.
