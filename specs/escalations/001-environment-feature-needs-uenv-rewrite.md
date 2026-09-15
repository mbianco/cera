# Escalation 001: environment-management.feature needs uenv rewrite

**From:** Architect
**To:** Analyst
**Date:** 2026-09-14
**Severity:** HIGH
**Status:** ESCALATED — needs spec update before implementation

## Context

The `features/environment-management.feature` file (produced by the
analyst) references Lmod commands: `module load`, `module avail`,
`module spider`. It also has an `@lmod` tag.

The domain expert has since clarified (resolutions.md R9, ADR-003)
that Alps uses **uenv (user environments)** — squashfs mounts in a
prescribed place with required dependencies — **not Lmod**.

## Impact

The feature file's scenarios are invalid as written. They describe
Lmod-based module loading, which does not match the target
infrastructure. The implementer cannot use these scenarios as
acceptance criteria.

## What needs to change

The analyst must rewrite `features/environment-management.feature`
to reflect uenv semantics:

1. Replace `module load` with uenv mount operations.
2. Replace `module avail` / `module spider` with uenv registry
   queries.
3. Replace `module purge` with uenv unmount.
4. Replace conflict detection (soname-level) with filesystem
   path-level conflict detection.
5. Update the `@lmod` tag to `@uenv`.
6. Add scenarios for:
   - Successful uenv mount and verification
   - uenv not found in registry (FM-E1)
   - Conflicting uenvs at the filesystem path level (FM-E2)
   - Partial uenv mount (FM-E3)
   - Re-verification before ToolInvocation (X1 "out-of-order" case)
   - Multiple uenvs mounted simultaneously (if supported by squashfs)

## Blocking?

**Yes for the environment-management module (Phase 2).** The
architect has designed the contracts (api-contracts.md §3) for
uenv, and the type stubs (value-objects.ts UenvSpec, entities.ts
Environment) are already uenv-based. But the BDD scenarios that
serve as acceptance criteria are stale.

Non-blocking for Phase 1 (dsh-adapter) and Phase 3+ modules that
do not depend on environment-management.
