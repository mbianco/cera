## Finding: Provenance write during FirecREST outage creates unresolvable limbo
Severity: Critical
Category: Correctness > Failure cascades; Robustness > error handling
Location: `specs/firecrest/invariants.md` F-INV-7; `specs/firecrest/failure-modes.md` FM-F-4; `specs/firecrest/features/firecrest-backend.feature` lines 311–317
Spec reference: F-INV-7 (Provenance via FirecREST filesystem); FM-F-4 (FirecREST unavailable, 503); INV-T3, INV-P1 (existing)

### Description

F-INV-7 states that ProvenanceRecords are written via FirecREST filesystem endpoints (`POST /filesystem/{system}/ops/upload` for ≤5MB, `POST /filesystem/{system}/transfer/upload` for >5MB). The Provenance store remains on the HPC filesystem (INV-P4).

FM-F-4 states that when FirecREST returns 503:
- Running Jobs on the HPC are NOT affected (they execute on compute nodes independently).
- cera marks all Job states as UNKNOWN.
- cera retries with backoff (30s → 5 min).

**The cascade:** A Job submitted via FirecREST completes on the HPC during a FirecREST outage. The Job has reached COMPLETED (terminal state, INV-S4). cera detects this only after FirecREST recovers (via reconciliation). At that point, cera must:

1. Write the ProvenanceRecord — but F-INV-7 requires writing via FirecREST filesystem endpoints. If FirecREST is still down at the moment the Job is detected as complete, the write cannot proceed.
2. Register the output Dataset as available (INV-T3, INV-P1) — but FM-P1 says this is gated on ProvenanceRecord write success.

Under the **local (dsh) backend**, if the HPC filesystem is slow but reachable, the ProvenanceRecord can be retried. Under **FirecREST**, if FirecREST is down, there is **no alternative path** to write the ProvenanceRecord — the entire Provenance store is behind FirecREST. The output Dataset is held in an unregistered state indefinitely.

**What is missing from the spec:**

1. The interaction between F-INV-7 (Provenance via FirecREST) and FM-F-4 (FirecREST outage) is not documented. The feature file (lines 311–317) only covers a `500` error on a single Provenance upload — not a full 503 outage that persists across the Job's completion and the reconciliation attempt.

2. There is no **local fallback** for ProvenanceRecords. Under the local backend, ProvenanceRecords are written to the HPC filesystem directly (no FirecREST dependency). Under FirecREST, if FirecREST is down, there is no way to write ProvenanceRecords at all — not even locally on the laptop (F-INV-7: "No ProvenanceRecord is written to local disk").

3. There is no **maximum retry window** for ProvenanceRecord writes during a FirecREST outage. FM-F-1 specifies "up to 5 retries" for synchronous calls, but FM-F-4's outage can last minutes to hours. After 5 retries, the ProvenanceRecord write fails permanently. The Job completed, the output exists on the HPC, but the Dataset is permanently unregistered. The spec doesn't address whether cera retries ProvenanceRecord writes indefinitely (with the FM-F-4 outage polling cadence) or gives up after FM-F-1's 5 retries.

4. There is no **reconciliation of ProvenanceRecords** after a FirecREST outage. The existing `reconcileViaSacct` (scheduling) reconciles Job states, but there is no equivalent for ProvenanceRecords that failed to write during the outage. If cera detects Job completion via reconciliation but the ProvenanceRecord write had already permanently failed (5 retries exhausted), the Dataset is permanently lost from the registry with no recovery path.

### Evidence

1. `specs/firecrest/invariants.md` F-INV-7: "every ProvenanceRecord write is an HTTP request to a FirecREST filesystem endpoint... No ProvenanceRecord is written to local disk."
2. `specs/firecrest/failure-modes.md` FM-F-4: "All requests return 503... cera marks all Job states as UNKNOWN... cera retries with backoff (starting at 30s, max 5 min)."
3. `specs/firecrest/failure-modes.md` FM-F-1: "retries with exponential backoff (starting at e.g., 1s, max 30s, up to 5 retries). If all retries fail, cera notifies the User."
4. `specs/firecrest/features/firecrest-backend.feature` lines 311–317: Only covers `500` for Provenance upload, not `503` (full outage).
5. `specs/failure-modes.md` FM-P1: "If all retries fail, the User is notified and the output Dataset is held in an unregistered state — it is NOT available for downstream consumption." (No recovery path specified.)

### Suggested resolution

The architect must specify:
1. A **ProvenanceRecord retry policy during FirecREST outage** that is distinct from FM-F-1's 5-retry limit for synchronous calls. ProvenanceRecord writes during a 503 outage should follow the FM-F-4 outage cadence (30s → 5 min), not FM-F-1's 5-retry limit.
2. Whether a **local ProvenanceRecord buffer** is permitted during FirecREST outages (relaxing F-INV-7's "No ProvenanceRecord is written to local disk" to allow a temporary buffer that is flushed to the HPC when FirecREST recovers). If not, the spec must document that ProvenanceRecords are at risk of permanent loss during prolonged outages.
3. A **ProvenanceRecord reconciliation mechanism** analogous to `reconcileViaSacct` — after a FirecREST outage, cera must identify Jobs that completed during the outage and ensure their ProvenanceRecords are written, even if the original write attempt permanently failed.
4. A Gherkin scenario covering: Job completes during FirecREST outage → ProvenanceRecord cannot be written → FirecREST recovers → ProvenanceRecord is written → Dataset is registered.
