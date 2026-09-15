# Ubiquitous Language — cera

> One term per concept. Where a legacy tool has an overloaded name
> (e.g. "operator" means different things in CDO vs. NCO vs. the agent),
> the agent's term is qualified and the legacy usage is cross-referenced.
>
> Status legend: **[CORE]** — load-bearing for the system.
> **[LEGACY]** — external term we must accommodate but do not own.
> **[CANDIDATE]** — introduced by the analyst, needs domain-expert
> confirmation.

---

## A

### Agent
The LLM-driven system (cera) that accepts scientific intent expressed
in natural language and translates it into sequences of Tool
invocations, Job submissions, and Dataset operations. The Agent is
not itself a Tool; it orchestrates Tools.

### Alps
The target HPC system at CSCS (Swiss National Supercomputing Centre),
part of the ETH domain. Uses SLURM for scheduling. Has login nodes,
service nodes, and compute nodes. Compute nodes typically lack
outbound network and graphical display. **[LEGACY]**

### Aggregation
An operation that reduces a Dataset along one or more dimensions
(typically time) to produce a smaller Dataset. Example: computing a
multi-year mean from daily data. Both CDO (`timmean`) and NCO
(`ncra`) provide aggregation operators. **[LEGACY]**

## C

### Case (CESM)
The configurable, self-contained directory tree that CESM uses to
manage a single experiment. Created via `create_newcase` or
`create_clone`, configured, built, and submitted via `case.submit`.
A Case has a name, a compset (component set), a resolution, a machine
target, and a run length. **[LEGACY]**

### CESM
Community Earth System Model. A coupled global climate model written
in Fortran and C, executed as an MPI-parallel application. CESM is
not a stateless CLI Tool — it has a multi-step lifecycle
(create → configure → build → submit → monitor → post-process).
Runs are long (hours to weeks) and consume large node allocations.
**[LEGACY]**

### Chunk (ZARR)
A fixed-size sub-array of a ZARR array, stored as a separate
compressed object. Chunks are the unit of parallel I/O for ZARR.
**[LEGACY]**

### CLI Tool
A Tool invoked as a command-line binary via a shell or subprocess.
CDO, NCO, and opengrads (if feasible) are CLI Tools. **[CORE]**

### Compiler Stack
A specific compiler and its associated runtime libraries (e.g.,
`gcc/11.2.0` with `openmpi/4.1.4`, or `intel/2021.4` with
`intel-mpi/2021.4`). CESM and some tools require a specific stack;
incompatible stacks cannot co-load. **[CORE]**

### Compset (CESM)
A predefined combination of model components (atmosphere, ocean, land,
ice, etc.) for a CESM Case. Example: `BHIST` (historical run with
CAM atmosphere). **[LEGACY]**

### CDO
Climate Data Operators. A CLI tool for processing climate data in
NetCDF, GRIB, and other formats. Provides operators for selection,
aggregation, remapping, and statistical transformation. Invoked as
`cdo <operator-chain> <input> <output>` or
`cdo <operator-chain> <input1> <input2> <output>`. **[LEGACY]**

## D

### Dataset
A scientific data artifact consisting of one or more files (or ZARR
stores) holding N-dimensional arrays with associated metadata
(variables, dimensions, units, grid). A Dataset is the primary input
to and output from Tools. A Dataset has exactly one Format, exactly
one Grid, and one or more Variables. **[CORE]**

### dsh
DeepSeek Harness. The TypeScript/Node agent framework cera is built
on. Provides plugin architecture via Cordis, with extension points
including `ctx.tools`, `ctx.shell`, `ctx.subprocess`, `ctx.sandbox`,
`ctx.fs`, and `ctx.jobs`. In developer preview with breaking-change
risk. **[LEGACY]**

## E

### Environment (Module Environment)
The set of loaded software Modules (compiler, MPI, libraries, tool
binaries) that makes a specific Tool executable. An Environment is
loaded before a Tool runs and may differ per Tool. Environments can
conflict — two Tools requiring incompatible compiler stacks cannot
share an Environment. **[CORE]**

### Exit Code
The integer return value of a CLI Tool or subprocess. 0 conventionally
indicates success; non-zero indicates failure. Some legacy tools use
non-standard exit codes (e.g., CDO returns 1 for some warnings).
Distinct from Signal. **[CORE]**

### Experiment
A scientific investigation consisting of one or more Workflows and
CESM Cases, tied together by a research question. First-class entity
above Workflow (R2, ADR-002). A Workflow belongs to exactly one
Experiment. A Case belongs to exactly one Experiment. **[CORE]**

## F

### Format
The on-disk encoding of a Dataset. Known formats: NetCDF (classic and
HDF5-backed), ZARR, GRIB2. A Dataset's Format determines which Tools
can read it directly. **[CORE]**

### Forward Model
A model run that simulates the climate forward in time from initial
conditions, as opposed to a post-processing operation. CESM is the
Forward Model in scope. **[CANDIDATE]**

## G

### GRIB2
GRIdded Binary, edition 2. A binary format for meteorological data
used operationally by weather centers. Supports multiple grids and
compression. Read by CDO and some Python libraries. **[LEGACY]**

### Grid
The spatial discretization of a Dataset: how points on the Earth's
surface (or in the atmosphere/ocean) are arranged. Known grid types
in scope: lat-lon (regular), ICON (unstructured), healpix
(hierarchical equal-area iso-latitude), GRIB2-native. A Grid is
convertible to another Grid via a Remapping operation. **[CORE]**

### Grid Conversion
The operation of transforming a Dataset from one Grid to another
(e.g., ICON → lat-lon). Involves interpolation weights and is
typically performed by CDO (`remapcon2`, `remapdis`, etc.) or Python
tooling. The result is a new Dataset in the target Grid; the original
is unchanged. **[CORE]**

## H

### healpix
Hierarchical Equal Area iso-Latitude Pixelization. A scheme for
subdividing a sphere into pixels of equal area, arranged in nested
rings. Used in astronomy and increasingly climate science. Python
tooling (`healpy`) is the primary interface. **[LEGACY]**

### HPC
High-Performance Computing. The class of computing infrastructure
comprising parallel filesystems, batch schedulers, MPI-parallel
compute nodes, and software module systems. Alps is the HPC
infrastructure in scope. **[LEGACY]**

## I

### ICON
Icosahedral Non-hydrostatic weather and climate model. Uses an
unstructured grid based on a subdivided icosahedron. ICON grid data
is typically handled by Python tools in this project's scope.
**[LEGACY]**

### Invariant
A property that must always hold within a bounded context. Violations
are defects, not error conditions. See `invariants.md`. **[CORE]**

## J

### Job
A unit of work submitted to the Scheduler for execution on compute
nodes. A Job has a Resource Request, a State, a Job ID (assigned by
the Scheduler), and output destinations (stdout/stderr files). CESM
submissions and parallel CDO/NCO runs produce Jobs. Short CLI Tool
invocations may execute synchronously without a Job. **[CORE]**

### Job ID
The scheduler-assigned identifier for a Job (on SLURM, a positive
integer). Used to query State and to cancel. **[CORE]**

## L

### lat-lon
A regular latitude-longitude grid. The most common interchange Grid.
Often the target of Grid Conversion from unstructured or
hierarchical grids. **[LEGACY]**

### Login Node
The interactive entry point to an HPC system. The Agent runs on login
or service nodes. Login nodes are shared and resource-limited — heavy
compute is prohibited. **[LEGACY]**

## M

### Module (Software Module)
A unit of software packaging managed by a module system (Lmod,
Environment Modules, or Spack). Loaded via `module load <name>/<ver>`.
A Module provides executables, libraries, and environment variables.
Tools depend on specific Modules being loaded. **[CORE]**

### MPI
Message Passing Interface. The parallel communication standard used
by CESM and some Tools. Requires an MPI runtime (OpenMPI, MPICH,
Cray MPICH) loaded as part of the Environment. **[LEGACY]**

## N

### NetCDF
Network Common Data Form. The primary legacy data Format for climate
science. Supports multidimensional arrays with metadata. Read and
written by CDO, NCO, and most Python climate libraries. Backed by
HDF5 in modern versions. **[LEGACY]**

### NCO
NetCDF Climate Operators. A suite of CLI operators for NetCDF files:
`ncks` (subsetting), `ncra` (record averaging), `ncecat`
(ensemble concatenation), `ncatted` (attribute editing), etc. Operates
at the file level; complements but does not duplicate CDO.
**[LEGACY]**

### Node (Compute)
A single machine in an HPC cluster, with many CPU cores and
significant memory. Allocated to Jobs by the Scheduler. Compute nodes
on Alps typically lack graphical display and outbound internet.
**[LEGACY]**

## O

### Operator (CDO)
A single transformation applied by CDO, specified as a flag
(e.g., `-selvar`, `-timmean`, `-remapcon2`). Operators can be chained
on the command line, evaluated right-to-left. **[LEGACY]**

### Operator (NCO)
A single NCO command-line program (e.g., `ncks`, `ncra`). Unlike CDO
operators, NCO operators are separate executables and cannot be
chained within a single invocation. **[LEGACY]**

### Action
A domain-level operation exposed to the LLM: "select variable",
"compute time mean", "remap grid". An Action may map to one or more
CLI operators or Python calls. Replaces "Operator (Agent)" which was
overloaded with CDO/NCO operators (R3). **[CORE]**

### opengrads
Open-source Grid Analysis and Display System. An interactive desktop
tool for accessing, manipulating, and visualizing earth-science data.
Has its own scripting language and dynamically linked plugins. Hosted
on SourceForge using CVS. Feasibility for HPC use is **UNKNOWN** and
under evaluation. **[LEGACY]**

## P

### Provenance
A record associating a Dataset (or Job output) with the exact Tool,
parameters, Environment, and input Datasets that produced it.
Provenance enables scientific reproducibility. Must exist before a
Dataset is consumed downstream. **[CORE]**

### Partition (SLURM)
A named queue of compute resources on an HPC system, with associated
limits (wall time, node count, QoS). Jobs are submitted to a specific
Partition. Alps has multiple Partitions (e.g., `normal`, `priority`,
`gpu`). **[LEGACY]**

### Python Tool
A Tool invoked via a Python interpreter, using Python libraries
(healpy, zarr, ICON grid tools). Distinct from CLI Tools in execution
model (in-process vs. subprocess) and error handling. **[CORE]**

## Q

### QoS (SLURM)
Quality of Service. A SLURM construct that sets resource limits and
scheduling priority for a Job within a Partition. **[LEGACY]**

## R

### Remapping
See Grid Conversion. **[LEGACY synonym]** — prefer "Grid Conversion"
in agent-facing language.

### Reproducibility
The ability to re-execute a Workflow and obtain equivalent results,
guaranteed by complete Provenance (Tool, parameters, Environment,
inputs). A first-class scientific requirement, not an optional
feature. **[CORE]**

### Resource Request
The compute resources a Job asks for: number of nodes, cores per
node, memory per node, wall-clock time, Partition, QoS. Validated by
the Scheduler at submission; may be rejected. **[CORE]**

## S

### Scheduler
The system that accepts Jobs, queues them, allocates compute
resources, launches them, and reports State. SLURM is the Scheduler on
Alps. The domain model treats the Scheduler as an abstraction; other
schedulers (PBS, LSF) may be supported later. **[CORE]**

### Service Node
A non-compute node on an HPC system used for non-interactive
workflows, data staging, or the Agent itself. Less resource-constrained
than a login node. **[LEGACY]**

### Session
A single interaction context between a User and the Agent. Has a
bounded lifetime (may end before long-running Jobs complete). Carries
state about the current Workflow, loaded Environments, and referenced
Datasets. **[CORE]**

### Signal
A POSIX signal delivered to a process (e.g., SIGSEGV, SIGKILL,
SIGTERM). Distinct from Exit Code: a process killed by a signal does
not produce a normal exit code. The Agent must distinguish
signal-termination from exit-code-termination. **[CORE]**

### SLURM
Simple Linux Utility for Resource Management. The batch scheduler and
workload manager used on Alps. Provides `sbatch`, `squeue`, `scancel`,
`sacct`, `sinfo`. **[LEGACY]**

### State (Job State)
The lifecycle status of a Job as reported by the Scheduler. SLURM
states include: PENDING, RUNNING, COMPLETED, FAILED, TIMEOUT,
CANCELLED, OUT_OF_MEMORY, NODE_FAIL. The Agent must handle each
distinctly. **[CORE]**

### State (Workflow State) — [CANDIDATE]
The lifecycle status of a Workflow: NOT_STARTED, IN_PROGRESS,
BLOCKED (waiting on Job), COMPLETE, FAILED. Flagged: needs
confirmation that Workflow is a first-class entity with state.
**[CANDIDATE]**

## T

### Tool
A legacy scientific capability, wrapped so the Agent can invoke it.
Tools have an Environment requirement, an input/output contract
(formats, grids), and an execution model (synchronous CLI, parallel
Job, Python call). Subtypes: CLI Tool, Python Tool, Model Run.
**[CORE]**

## U

### User
A climate scientist with an HPC account, SLURM access, and a
scientific goal expressible as a Workflow. **[CORE]**

## V

### Variable
A named physical quantity within a Dataset (e.g., `TAS` for
near-surface air temperature, `PR` for precipitation). Has units and
a dimension structure. Tools select, transform, and aggregate
Variables. **[CORE]**

## W

### Wall Time (Wall-clock Time)
The maximum elapsed time a Job may run, specified in the Resource
Request. Enforced by the Scheduler; exceeding it triggers SIGTERM
then SIGKILL (SLURM convention). **[LEGACY]**

### Workflow
An ordered sequence of Tool invocations that consumes input Datasets
and produces output Datasets, aimed at a scientific goal. Steps have
data dependencies (output of step N may be input to step N+1). May
include CESM Cases and Grid Conversions. **[CORE]**

## Z

### ZARR
A chunked, compressed, N-dimensional array storage Format backed by
a directory of objects or a key-value store. Python-native; an
alternative to NetCDF/HDF5. Supports parallel reads and writes at
the chunk level. **[LEGACY]**
