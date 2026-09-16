# cera — Makefile
#
# Three test tiers, cascading. Each higher tier MUST include the
# lower — the targets chain, not replace.
#
# Tier 1 (fast): fast unit tests + property tests. Between every
#   edit, pre-commit.
# Tier 2 (slow): Tier 1 + integration tests + coverage. Pre-PR.
# Tier 3 (full): Tier 2 + full e2e (real HPC services). Pre-merge,
#   nightly, pre-release.
#
# `make` with no target = fmt-check + lint + tier 1. Run before
# every commit.
#
# Spec: ~/.config/opencode/guidelines/ci.md

.PHONY: all test test-fast test-slow test-full lint typecheck build clean

# Default: lint + typecheck + Tier 1
all: lint typecheck test-fast

# Tier 1: fast unit + property tests
test: test-fast

test-fast:
	npx vitest run --exclude tests/integration/** --exclude tests/property/**

# Tier 2: Tier 1 + integration tests + coverage
test-slow: test-fast
	npx vitest run --exclude tests/integration/** --coverage
	npx vitest run tests/integration/** tests/property/**

# Tier 3: Tier 2 + full e2e (real HPC services)
# In CI, this runs on a self-hosted runner with SLURM access.
# Locally, this is the same as test-slow (no real HPC).
test-full: test-slow
	npx vitest run --coverage

lint:
	npx eslint src tests --max-warnings=0

typecheck:
	npx tsc --noEmit

build:
	npx tsdown

clean:
	rm -rf dist coverage .vitest
