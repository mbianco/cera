@C4 @scheduling @slurm
Feature: Job Management
  As a climate scientist
  I want to query, monitor, and cancel SLURM Jobs
  So that I can track the progress of my submissions and intervene
  when needed, trusting the Scheduler — not file existence —
  for authoritative Job State.

  Background:
    Given a Session is active for User "cera_user" with SLURM username "cera_user"

  # --- Querying job state ---

  Scenario: Query running Job state with squeue
    Given Job "4827365" was submitted with ResourceRequest:
      | field        | value     |
      | nodes        | 128       |
      | coresPerNode | 36        |
      | memory       | 128GB     |
      | wallTime     | 168:00:00 |
      | partition    | normal    |
      | qos          | default   |
    When the Agent queries the Scheduler via "squeue -j 4827365"
    Then the Scheduler reports Job State "RUNNING"
    And the reported state is taken directly from squeue output — not inferred from file existence or elapsed time

  Scenario: Query completed Job state with sacct
    Given Job "4827365" has reached terminal state
    When the Agent queries the Scheduler via "sacct -j 4827365 --format=JobID,State,Elapsed,ExitCode"
    Then the Scheduler reports Job State "COMPLETED"
    And the reported state is taken directly from sacct output
    And the Job's ResourceRequest is unchanged from submission:
      | nodes | coresPerNode | memory | wallTime  | partition | qos     |
      | 128   | 36           | 128GB  | 168:00:00 | normal    | default |

  Scenario: Query multiple Jobs for a User
    Given Jobs "4827365", "4827366", and "4827367" are submitted by User "cera_user"
    When the Agent queries the Scheduler via "squeue -u cera_user"
    Then the Scheduler reports states for all three Jobs:
      | jobID   | state    |
      | 4827365 | RUNNING  |
      | 4827366 | PENDING  |
      | 4827367 | COMPLETED |

  # --- Cancelling a Job ---

  Scenario: Cancel a running Job
    Given Job "4827366" is RUNNING
    When the Agent cancels Job "4827366" via "scancel 4827366"
    Then the Scheduler reports Job State "CANCELLED"
    And Job "4827366" does NOT transition to COMPLETED or RUNNING afterward
    And the User is notified that Job "4827366" was cancelled

  Scenario: Cancel a pending Job
    Given Job "4827367" is PENDING
    When the Agent cancels Job "4827367" via "scancel 4827367"
    Then the Scheduler reports Job State "CANCELLED"
    And Job "4827367" does NOT transition to RUNNING afterward

  # --- Invariant enforcement ---

  Scenario: Scheduler is authoritative for Job State — no inference from files (INV-S1)
    Given Job "4827365" is RUNNING
    And an output file "/scratch/snx3000/cera_user/cases/bhist_f09_g17_001/run/tas_h0_0001-01.nc" exists
    When the Agent checks the state of Job "4827365"
    Then the Agent queries the Scheduler via "squeue -j 4827365"
    And the Agent reports the state from squeue — "RUNNING"
    And the Agent does NOT promote Job "4827365" to COMPLETED based on the existence of the output file

  Scenario: Terminal state is final — no transition back (INV-S4)
    Given Job "4827365" has reached terminal state COMPLETED
    When the Agent queries the Scheduler via "sacct -j 4827365"
    Then the Scheduler reports Job State "COMPLETED"
    And no subsequent observation places Job "4827365" in PENDING or RUNNING
    And the Agent does not treat the Job as still running

  Scenario: Resource Request is immutable after submission (INV-S2)
    Given Job "4827365" was submitted with ResourceRequest wallTime "168:00:00" and nodes "128"
    When the Agent queries the Job's ResourceRequest after submission
    Then the ResourceRequest is wallTime "168:00:00" and nodes "128" — unchanged
    And the Agent does not offer to modify the ResourceRequest in place
    And the Agent advises that changing resources requires cancelling and resubmitting

  Scenario: Unique JobID assigned by Scheduler (INV-S3)
    When the Agent submits a Job via "sbatch"
    Then the Scheduler assigns exactly one JobID — a positive integer
    And the Agent does not generate the JobID
    And no two Jobs share the same JobID

  # --- Scheduler unavailability ---

  Scenario: Scheduler daemon unavailable — Job State marked UNKNOWN
    Given Job "4827365" was submitted and is believed to be RUNNING
    When the Agent queries the Scheduler via "squeue -j 4827365"
    And squeue returns an error "slurm_load_jobs error: Unable to contact slurm controller"
    Then the Agent marks Job "4827365" state as "UNKNOWN"
    And the Agent does NOT silently promote Job "4827365" to COMPLETED or RUNNING
    And the Agent does NOT silently demote Job "4827365" to FAILED
    And the User is notified that the Scheduler is unreachable and the Job state is unknown
    And the Agent retries the query after a configurable interval

  Scenario: Scheduler returns stale data
    Given Job "4827365" is RUNNING
    And the squeue output is from 30 minutes ago and shows state PENDING
    When the Agent queries the Scheduler via "squeue -j 4827365"
    Then the Agent reports the state from the current squeue output
    And the Agent does not reconcile stale data with file existence or elapsed time
    And if the current query also fails, the state is marked "UNKNOWN"

  # --- Cross-session job discovery ---

  Scenario: Job submitted in previous Session is discoverable by JobID (INV-W4)
    Given Job "4827365" was submitted in Session "s1" and is RUNNING
    And Session "s1" has ended
    When a new Session "s2" begins for User "cera_user"
    And the Agent queries the Scheduler via "squeue -j 4827365" in Session "s2"
    Then the Scheduler reports Job State "RUNNING" for Job "4827365"
    And Job "4827365" is discoverable in Session "s2" by its JobID — it was not cancelled when Session "s1" ended

  Scenario: Job completed before new Session — query via sacct
    Given Job "4827365" was submitted in Session "s1"
    And Job "4827365" has reached terminal state COMPLETED
    And Session "s1" has ended
    When a new Session "s2" begins for User "cera_user"
    And the Agent queries the Scheduler via "sacct -j 4827365" in Session "s2"
    Then the Scheduler reports Job State "COMPLETED" for Job "4827365"
    And the Case associated with Job "4827365" is identifiable in Session "s2"

  # --- Failure paths ---

  Scenario: Cancel a non-existent Job
    When the Agent cancels Job "9999999" via "scancel 9999999"
    Then scancel returns an error "Job ID 9999999 not found"
    And the User is notified that Job "9999999" does not exist

  Scenario: Wall time exceeded — TIMEOUT state
    Given Job "4827366" has ResourceRequest with wallTime "24:00:00"
    When the Agent queries the Scheduler via "sacct -j 4827366"
    Then the Scheduler reports Job State "TIMEOUT"
    And the Job's Elapsed time exceeds 24:00:00
    And the Agent reports that the Job exceeded its wall time

  Scenario: Out of memory — OUT_OF_MEMORY state
    Given Job "4827368" has ResourceRequest with memory "64GB" per node
    When the Agent queries the Scheduler via "sacct -j 4827368"
    Then the Scheduler reports Job State "OUT_OF_MEMORY"
    And the Agent reports that the Job ran out of memory and suggests increasing the memory request

  Scenario: Node failure mid-run — NODE_FAIL state
    Given Job "4827369" is RUNNING on 128 nodes
    When one of the 128 nodes fails
    And the Agent queries the Scheduler via "sacct -j 4827369"
    Then the Scheduler reports Job State "NODE_FAIL"
    And the Agent reports that the Job failed due to a node failure
    And the Agent advises the User to resubmit with a node exclusion list
