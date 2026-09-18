# cera

AI agent for climate scientists, built on DeepSeek Harness (dsh).

cera wraps legacy scientific tools — CDO, NCO, CESM, Python tools for
ICON/healpix/zarr — so climate scientists can use them natively through
an LLM-driven agent. dsh runs on the scientist's laptop; all HPC
operations go through [FirecREST](https://firecrest.cscs.ch/), CSCS's
REST API for HPC resources. No SSH, no VPN — just an OIDC token.

---

*Documentation last updated: {{BUILD_DATE}}*

[Getting Started](getting-started.md) · [Architecture](architecture/index.md) · [API Reference](api-reference/index.md) · [ADRs](adrs/index.md)
