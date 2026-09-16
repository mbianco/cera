@firecrest @backend
Feature: FirecREST Backend
  As a climate scientist working from my laptop
  I want cera to access Alps HPC resources via FirecREST
  So that I can submit Jobs, manage files, and run Tools remotely
  without SSH access to the login node — using only a REST API and
  my CSCS OIDC credentials.

  Background:
    Given cera is configured with backend "firecrest"
    And the FirecREST server is reachable at "https://firecrest.cscs.ch"
    And the target system is "daint"
    And a valid JWT token is available from the OIDC provider
    And the JWT token is set in the "Authorization" header as "Bearer <token>"

  # ==========================================================================
  # Authentication
  # ==========================================================================

  Scenario: Valid JWT token in Authorization header (F-INV-2)
    Given a valid JWT token with preferred_username "cera_user"
    When cera sends a request to GET /status/daint/healthchecks
    Then FirecREST returns 200
    And the request included the header "Authorization: Bearer <token>"
    And the response indicates the system is healthy

  Scenario: Expired JWT token — 401 (FM-F-2)
    Given the JWT token has expired
    When cera sends a request to GET /status/daint/healthchecks
    Then FirecREST returns 401
    And cera attempts to refresh the token via the OIDC provider
    And if refresh succeeds, cera retries the request with the new token
    And if refresh fails, the User is notified that authentication has expired

  Scenario: Invalid JWT token — 401 (FM-F-2)
    Given the JWT token is malformed or revoked
    When cera sends a request to GET /status/daint/healthchecks
    Then FirecREST returns 401
    And cera does NOT retry with the same token
    And the User is notified that the token is invalid

  Scenario: Forbidden — 403
    Given a valid JWT token for User "cera_user"
    And User "cera_user" does not have access to system "santis"
    When cera sends a request to GET /status/santis/healthchecks
    Then FirecREST returns 403
    And cera does NOT retry the request
    And the User is notified that they lack access to system "santis"

  # ==========================================================================
  # Job Submission (POST /compute/{system}/jobs)
  # ==========================================================================

  Scenario: Submit a Job via FirecREST
    Given a ToolInvocation requires parallel execution with ResourceRequest:
      | field        | value     |
      | nodes        | 4         |
      | coresPerNode | 36        |
      | memory       | 64GB      |
      | wallTime     | 24:00:00  |
      | partition    | normal    |
      | qos          | default   |
    And the Job script contains the command "cdo -timmean input.nc output.nc"
    When cera submits the Job via POST /compute/daint/jobs
    Then FirecREST returns 200 with a job_id
    And the job_id is a positive integer assigned by SLURM (INV-S3)
    And the ResourceRequest is immutable after submission (INV-S2)
    And the Job state is "PENDING"

  Scenario: Job submission rejected by SLURM — FirecREST returns error
    Given a ToolInvocation requires parallel execution with an invalid ResourceRequest:
      | field        | value     |
      | nodes        | 99999     |
      | coresPerNode | 36        |
      | memory       | 64GB      |
      | wallTime     | 24:00:00  |
      | partition    | normal    |
      | qos          | default   |
    When cera submits the Job via POST /compute/daint/jobs
    Then FirecREST returns a non-200 status with an error message
    And the error message indicates SLURM rejected the resource request (FM-S1)
    And no Job was created — no job_id is returned
    And the User is notified with the specific rejection reason

  Scenario: FirecREST 5-second timeout during Job submission (FM-F-1)
    Given the FirecREST server is slow to respond
    When cera submits a Job via POST /compute/daint/jobs
    And the request does not complete within 5 seconds
    Then cera aborts the request
    And cera retries with backoff (up to the configured maximum)
    And if all retries fail, the User is notified that FirecREST is unresponsive

  Scenario: FirecREST 503 during Job submission (FM-F-4)
    Given the FirecREST server is temporarily unavailable
    When cera submits a Job via POST /compute/daint/jobs
    Then FirecREST returns 503
    And cera retries with backoff
    And if all retries fail, the User is notified that FirecREST is unavailable

  # ==========================================================================
  # Job State Query (GET /compute/{system}/jobs/{job_id})
  # ==========================================================================

  Scenario: Query Job state via FirecREST
    Given Job "4827365" was submitted via FirecREST and is RUNNING
    When cera queries the Job via GET /compute/daint/jobs/4827365
    Then FirecREST returns 200 with Job state "RUNNING"
    And the state is taken directly from FirecREST (which queries SLURM) — not inferred from file existence (INV-S1)

  Scenario: Query completed Job state via FirecREST
    Given Job "4827365" has reached terminal state COMPLETED
    When cera queries the Job via GET /compute/daint/jobs/4827365
    Then FirecREST returns 200 with Job state "COMPLETED"
    And no subsequent query places Job "4827365" in PENDING or RUNNING (INV-S4)

  Scenario: Query non-existent Job via FirecREST — 404
    When cera queries the Job via GET /compute/daint/jobs/9999999
    Then FirecREST returns 404
    And the User is notified that Job "9999999" does not exist

  Scenario: Job state query during FirecREST outage — state marked UNKNOWN
    Given Job "4827365" is believed to be RUNNING
    And FirecREST returns 503 for all requests
    When cera queries the Job via GET /compute/daint/jobs/4827365
    Then cera marks Job "4827365" state as "UNKNOWN"
    And cera does NOT silently promote the Job to COMPLETED or RUNNING
    And the User is notified that the Job state is unknown due to FirecREST unavailability
    And cera retries the query with backoff

  # ==========================================================================
  # Job Cancellation (DELETE /compute/{system}/jobs/{job_id})
  # ==========================================================================

  Scenario: Cancel a running Job via FirecREST
    Given Job "4827366" is RUNNING
    When cera cancels the Job via DELETE /compute/daint/jobs/4827366
    Then FirecREST returns 200
    And the Job state transitions to "CANCELLED"
    And the Job does NOT transition to COMPLETED or RUNNING afterward (INV-S4)
    And the User is notified that Job "4827366" was cancelled

  Scenario: Cancel a non-existent Job via FirecREST — 404
    When cera cancels the Job via DELETE /compute/daint/jobs/9999999
    Then FirecREST returns 404
    And the User is notified that Job "9999999" does not exist

  # ==========================================================================
  # File Listing (GET /filesystem/{system}/path/{path})
  # ==========================================================================

  Scenario: List files in a directory via FirecREST
    Given the directory "/scratch/snx3000/cera_user/data" exists on system "daint"
    And the directory contains files "input.nc", "output.nc", and subdirectory "results"
    When cera lists files via GET /filesystem/daint/path//scratch/snx3000/cera_user/data
    Then FirecREST returns 200 with a directory listing
    And the listing includes "input.nc", "output.nc", and "results"
    And each entry indicates whether it is a file or directory

  Scenario: List files in a non-existent directory — 404
    When cera lists files via GET /filesystem/daint/path//scratch/snx3000/cera_user/nonexistent
    Then FirecREST returns 404
    And the User is notified that the directory does not exist

  # ==========================================================================
  # Small File Download (≤5MB)
  # ==========================================================================

  Scenario: Download a small file via FirecREST
    Given the file "/scratch/snx3000/cera_user/config.json" exists on system "daint"
    And the file size is 2.5MB (≤5MB)
    When cera downloads the file via GET /filesystem/daint/ops/download?path=/scratch/snx3000/cera_user/config.json
    Then FirecREST returns 200 with the file content
    And the file content matches the original file on the HPC

  Scenario: Download a file larger than 5MB — must use async transfer (FM-F-8)
    Given the file "/scratch/snx3000/cera_user/large_data.nc" exists on system "daint"
    And the file size is 500MB (>5MB)
    When cera attempts to download the file via the synchronous /ops/download endpoint
    Then FirecREST returns an error indicating the file exceeds the synchronous limit
    And cera falls back to the async /transfer/download endpoint
    And cera receives a transfer jobId for the large file

  # ==========================================================================
  # Small File Upload (≤5MB)
  # ==========================================================================

  Scenario: Upload a small file via FirecREST
    Given cera has a local file of size 1.2MB
    And the target path "/scratch/snx3000/cera_user/uploads/script.sh" is writable
    When cera uploads the file via POST /filesystem/daint/ops/upload
    Then FirecREST returns 200
    And the file exists at "/scratch/snx3000/cera_user/uploads/script.sh" on the HPC
    And a subsequent stat confirms the file size is 1.2MB

  Scenario: Upload a file larger than 5MB — must use async transfer
    Given cera has a local file of size 120MB
    When cera attempts to upload via the synchronous /ops/upload endpoint
    Then FirecREST returns an error indicating the file exceeds the synchronous limit
    And cera falls back to the async /transfer/upload endpoint
    And cera receives a transfer jobId for the large file

  # ==========================================================================
  # File Stat (GET /filesystem/{system}/stat/{path})
  # ==========================================================================

  Scenario: Stat a file via FirecREST
    Given the file "/scratch/snx3000/cera_user/data/input.nc" exists on system "daint"
    And the file size is 1073741824 bytes
    And the file was last modified at "2026-09-15T10:30:00Z"
    When cera stats the file via GET /filesystem/daint/stat//scratch/snx3000/cera_user/data/input.nc
    Then FirecREST returns 200 with stat data:
      | field      | value                  |
      | size       | 1073741824             |
      | isFile     | true                   |
      | isDirectory| false                  |
      | mtime      | 2026-09-15T10:30:00Z   |

  Scenario: Stat a directory via FirecREST
    Given the directory "/scratch/snx3000/cera_user/data" exists on system "daint"
    When cera stats the path via GET /filesystem/daint/stat//scratch/snx3000/cera_user/data
    Then FirecREST returns 200 with stat data:
      | field      | value  |
      | isFile     | false  |
      | isDirectory| true   |

  Scenario: Stat a non-existent file — 404
    When cera stats the path via GET /filesystem/daint/stat//scratch/snx3000/cera_user/nonexistent.nc
    Then FirecREST returns 404
    And the User is notified that the file does not exist

  # ==========================================================================
  # Create Directory (PUT /filesystem/{system}/path/{path})
  # ==========================================================================

  Scenario: Create a directory via FirecREST
    Given the parent directory "/scratch/snx3000/cera_user" exists on system "daint"
    And the directory "/scratch/snx3000/cera_user/new_results" does not exist
    When cera creates the directory via PUT /filesystem/daint/path//scratch/snx3000/cera_user/new_results
    Then FirecREST returns 200
    And a subsequent stat confirms the directory exists with isDirectory true

  Scenario: Create a directory with recursive parents
    Given the path "/scratch/snx3000/cera_user" exists
    And the path "/scratch/snx3000/cera_user/a/b/c" does not exist
    When cera creates the directory recursively via PUT /filesystem/daint/path//scratch/snx3000/cera_user/a/b/c
    Then FirecREST returns 200
    And a subsequent stat confirms "/scratch/snx3000/cera_user/a/b/c" exists with isDirectory true

  # ==========================================================================
  # All ToolInvocations become parallel (F-INV-6)
  # ==========================================================================

  Scenario: Synchronous CLI Tool becomes a Job under FirecREST
    Given cera is configured with backend "firecrest"
    And a ToolInvocation requests executionModel "synchronous" for Tool "cdo"
    When cera processes the ToolInvocation
    Then cera submits the command as a SLURM Job via POST /compute/daint/jobs
    And cera does NOT attempt to execute the command locally
    And cera polls the Job state via GET /compute/daint/jobs/{job_id} until a terminal state is reached
    And the ExitOutcome is derived from the Job's terminal state and exit code

  Scenario: Parallel ToolInvocation remains a Job under FirecREST
    Given cera is configured with backend "firecrest"
    And a ToolInvocation requests executionModel "parallel" for Tool "cesm" with ResourceRequest:
      | field        | value     |
      | nodes        | 128       |
      | coresPerNode | 36        |
      | memory       | 256GB     |
      | wallTime     | 168:00:00 |
      | partition    | normal    |
      | qos          | default   |
    When cera processes the ToolInvocation
    Then cera submits the command as a SLURM Job via POST /compute/daint/jobs
    And cera polls the Job state via GET /compute/daint/jobs/{job_id} until a terminal state is reached

  # ==========================================================================
  # uenv loaded in Job script, not by cera (F-INV-5, re-evaluates INV-E1)
  # ==========================================================================

  Scenario: uenv is loaded inside the Job script, not by cera directly
    Given a ToolInvocation requires uenv "cdo/2.0.5" with mountPath "/user-environment/env/cdo:2.0.5"
    And cera is configured with backend "firecrest"
    When cera prepares the Job script for submission
    Then the Job script contains "uenv start cdo:2.0.5 --" before the Tool command
    And cera does NOT call any uenv CLI command directly (no uenv mount, no uenv status)
    And cera does NOT call any FirecREST endpoint for uenv management (none exists)
    And the Environment is loaded within the SLURM Job on the HPC, not on the laptop

  Scenario: uenv not available — Job script fails (FM-F-9)
    Given a ToolInvocation requires uenv "nonexistent/9.9.9"
    And cera is configured with backend "firecrest"
    When cera prepares the Job script with "uenv start nonexistent:9.9.9 --" and submits it
    And the Job reaches FAILED state with stderr containing "uenv: not found"
    Then cera reports the failure to the User
    And cera suggests verifying the uenv name and version
    And the ProvenanceRecord records the FAILED state with the stderr

  # ==========================================================================
  # Provenance store on Alps, written via FirecREST (F-INV-7)
  # ==========================================================================

  Scenario: Provenance record written to Alps via FirecREST filesystem
    Given a ToolInvocation has completed successfully with exit code 0
    And the Provenance store is at "/scratch/snx3000/cera_user/provenance/" on system "daint"
    When cera writes the ProvenanceRecord
    Then cera serializes the ProvenanceRecord as JSON
    And cera uploads the JSON via POST /filesystem/daint/ops/upload (if ≤5MB)
    And the ProvenanceRecord is persisted on the HPC filesystem, not on the laptop
    And the ProvenanceRecord is queryable in future Sessions (INV-P4)

  Scenario: Provenance write fails due to FirecREST error
    Given a ToolInvocation has completed successfully
    And FirecREST returns 500 for the upload request
    When cera attempts to write the ProvenanceRecord
    Then cera retries the upload with backoff
    And if all retries fail, the output Dataset is NOT registered as consumable (INV-T3, FM-P1)
    And the User is notified that the Provenance write failed

  # ==========================================================================
  # Job completion notification: polling vs webhook
  # ==========================================================================

  Scenario: Job completion detected via polling
    Given Job "4827365" was submitted via FirecREST and is RUNNING
    When cera polls the Job state via GET /compute/daint/jobs/4827365
    Then FirecREST returns 200 with Job state "RUNNING"
    And cera polls again after a configurable interval
    And when the Job reaches COMPLETED, cera detects it via the next poll
    And cera reports the completion to the User

  Scenario: Job completion detected after FirecREST outage via reconciliation
    Given Job "4827365" was submitted via FirecREST and is RUNNING
    And FirecREST was unavailable for 20 minutes (returning 503)
    When FirecREST recovers and cera queries the Job via GET /compute/daint/jobs/4827365
    Then FirecREST returns 200 with Job state "COMPLETED"
    And cera reports that Job "4827365" completed during the outage
    And the Job's terminal state is final (INV-S4) — it does not revert to RUNNING

  # ==========================================================================
  # Error handling: comprehensive FirecREST HTTP error scenarios
  # ==========================================================================

  Scenario: FirecREST rate limit exceeded — 429 (FM-F-3)
    Given cera has made many requests in a short period
    When cera sends a request to GET /compute/daint/jobs
    Then FirecREST returns 429
    And cera retries with exponential backoff
    And cera does NOT flood FirecREST with immediate retries

  Scenario: FirecREST SSH to HPC failed — 500 (FM-F-5)
    Given the FirecREST server is running but cannot reach the HPC via SSH
    When cera sends a request to GET /compute/daint/jobs/4827365
    Then FirecREST returns 500 with an SSH-related error message
    And cera retries with backoff
    And if the error persists, the User is notified that FirecREST cannot reach the HPC system

  Scenario: FirecREST not configured for the target system — 404 (FM-F-7)
    Given the target system is set to "unknown_system"
    When cera sends a request to GET /compute/unknown_system/jobs
    Then FirecREST returns 404
    And the User is notified that system "unknown_system" is not configured in FirecREST
    And cera suggests checking available systems via GET /status/systems

  # ==========================================================================
  # Backend selection at startup
  # ==========================================================================

  Scenario: Backend "local" uses dsh-adapter (existing behavior)
    Given cera is configured with backend "local"
    When cera starts
    Then cera uses the dsh-adapter for ShellExecutor, SubprocessRunner, FilesystemGateway, and SchedulingService
    And cera executes CLI tools locally on the login node
    And the existing local behavior is unchanged

  Scenario: Backend "firecrest" uses firecrest-adapter
    Given cera is configured with backend "firecrest"
    When cera starts
    Then cera uses the firecrest-adapter for ShellExecutor, SubprocessRunner, FilesystemGateway, and SchedulingService
    And all HPC operations go through FirecREST (F-INV-1)
    And no direct SSH or local subprocess execution occurs for HPC operations
