# cera

AI agent for climate scientists on the Alps supercomputer.

cera wraps legacy scientific tools — CDO, NCO, CESM, Python tools for
ICON/healpix/zarr — so climate scientists can use them natively through
an LLM-driven agent. The agent runs either on the Alps login node
(local backend) or on a laptop (FirecREST backend), and dispatches
compute jobs via SLURM.

[Getting Started](getting-started.md) · [Architecture](architecture/index.md) · [API Reference](api-reference/index.md) · [ADRs](adrs/index.md)
