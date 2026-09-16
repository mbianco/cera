# Architecture Decision Records

ADRs document significant architectural decisions in cera. Each
record includes context, decision, consequences, and alternatives.
ADRs are append-only — superseded decisions are marked but not
deleted.

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](https://github.com/mbianco/cera/blob/main/specs/architecture/adr/ADR-001.md) | CESM as a complex Tool (not peer entity) | Accepted |
| [ADR-002](https://github.com/mbianco/cera/blob/main/specs/architecture/adr/ADR-002.md) | Experiment as a first-class entity | Accepted |
| [ADR-003](https://github.com/mbianco/cera/blob/main/specs/architecture/adr/ADR-003.md) | uenv-based Environment Management (not Lmod) | Accepted |
| [ADR-004](https://github.com/mbianco/cera/blob/main/specs/architecture/adr/ADR-004.md) | SLURM-only, defer scheduler abstraction | Accepted |
| [ADR-005](https://github.com/mbianco/cera/blob/main/specs/architecture/adr/ADR-005.md) | dsh isolation layer | Accepted |
| [ADR-006](https://github.com/mbianco/cera/blob/main/specs/architecture/adr/ADR-006.md) | Workflow persistence model | Accepted |
| [ADR-007](https://github.com/mbianco/cera/blob/main/specs/architecture/adr/ADR-007.md) | Proactive Job reporting on Session start | Accepted |
| [ADR-008](https://github.com/mbianco/cera/blob/main/specs/architecture/adr/ADR-008.md) | Strict exit code policy | Accepted |
| [ADR-009](https://github.com/mbianco/cera/blob/main/specs/architecture/adr/ADR-009.md) | Provenance store design (local corruption) | Accepted |
| [ADR-010](https://github.com/mbianco/cera/blob/main/specs/architecture/adr/ADR-010.md) | LLM hallucination policy (refuse and ask) | Accepted |
| [ADR-011](https://github.com/mbianco/cera/blob/main/specs/architecture/adr/ADR-011.md) | FirecREST as second backend | Accepted |

## Key decisions

### ADR-001: CESM is a complex Tool, not a peer entity
CESM has a multi-step lifecycle (create → configure → build →
submit → monitor → post-process), but it is modeled as a ModelTool
subtype in C1 (Tool Invocation), not a separate bounded context.
This keeps the tool-invocation invariants (INV-T1–T9) unified.

### ADR-003: uenv, not Lmod
Alps uses "user environments" (uenv) — squashfs mounts at prescribed
paths. Conflict detection is at the filesystem path level, not the
soname level like Lmod. The `EnvironmentService` interface wraps
`uenv status`, `uenv mount`, `uenv umount`, `uenv list`.

### ADR-005: dsh isolation layer
dsh is in developer preview with breaking-change warnings. The
`dsh-adapter` module is the only one that imports dsh. All other
modules import stable cera-internal interfaces. When dsh is
upgraded, only `dsh-adapter` needs to change.

### ADR-008: Strict exit codes
Any non-zero exit code blocks output registration (INV-T3) by
default. Permissive mode is opt-in per ToolInvocation via
`permissiveExitCodes`. For climate science, wrong parameters may
produce plausible-looking but scientifically invalid output — worse
than a crash.

### ADR-010: LLM hallucination — refuse and ask
If the LLM generates a Tool name or parameters not in the catalog,
the Agent refuses and asks the User for clarification. No
best-effort substitution. This is because incorrect parameters may
produce plausible-looking but wrong output.

### ADR-011: FirecREST as second backend
Scientists can run cera on their laptops and access Alps HPC
resources via FirecREST's REST API. The FirecREST adapter
implements the same cera-internal interfaces as dsh-adapter. All
ToolInvocations become parallel (submitted as SLURM Jobs). uenv is
loaded in Job scripts, not by cera. OIDC replaces SSH keys.
