@C2 @model-execution @cesm @scheduling
Feature: CESM Submission
  As a climate scientist
  I want to create, configure, build, submit, and monitor a CESM Case
  So that I can run multi-day to multi-week climate simulations on Alps
  via SLURM, with the full lifecycle tracked and recoverable.

  Background:
    Given a Session is active for User "cera_user" with SLURM username "cera_user"
    And an Environment with Modules "intel/2021.4 intel-mpi/2021.4 craype/2.7.10" is loaded and verified conflict-free
    And the User's HPC account is "s1234"

  # --- Happy path: full lifecycle ---

  Scenario: Create a new CESM Case
    When the Agent creates a new Case with:
      | field      | value                    |
      | name       | bhist_f09_g17_001        |
      | compset    | BHIST                    |
      | resolution | f09_g17                  |
      | machine    | daint                    |
      | runLength  | 5 years (43800 hours)    |
    Then the Case "bhist_f09_g17_001" is created at Location "/scratch/snx3000/cera_user/cases/bhist_f09_g17_001/"
    And the Case state is CREATED

  Scenario: Configure the Case
    Given Case "bhist_f09_g17_001" is in state CREATED
    When the Agent configures the Case with run length 5 years, calendar "noleap", and stop option "nyears"
    Then the Case state is CONFIGURED

  Scenario: Build the Case
    Given Case "bhist_f09_g17_001" is in state CONFIGURED
    When the Agent builds the Case via "case.build"
    Then the Case state is BUILT
    And the build artifact (executable) is present at Location "/scratch/snx3000/cera_user/cases/bhist_f09_g17_001/bld/cesm.exe"

  Scenario: Submit the Case via SLURM
    Given Case "bhist_f09_g17_001" is in state BUILT
    And the output tree Location is set to "/scratch/snx3000/cera_user/cases/bhist_f09_g17_001/run/"
    And the output tree Location "/scratch/snx3000/cera_user/cases/bhist_f09_g17_001/run/" is writable
    And a ResourceRequest is defined with:
      | field          | value          |
      | nodes          | 128            |
      | coresPerNode   | 36             |
      | memory         | 128GB          |
      | wallTime       | 168:00:00      |
      | partition      | normal         |
      | qos            | default        |
    When the Agent submits the Case via "case.submit"
    Then the SLURM Scheduler assigns a JobID
    And the Job is created with the assigned JobID and the ResourceRequest from above
    And the Case state is SUBMITTED
    And a ProvenanceRecord is created for the Job with Tool "cesm case.submit", the ResourceRequest, Environment "intel/2021.4 intel-mpi/2021.4 craype/2.7.10", and output Location "/scratch/snx3000/cera_user/cases/bhist_f09_g17_001/run/"

  Scenario: Monitor Job until COMPLETED
    Given Case "bhist_f09_g17_001" is in state SUBMITTED
    And Job "4827365" is associated with Case "bhist_f09_g17_001"
    When the Agent queries the Scheduler via "squeue -j 4827365"
    Then the Scheduler reports Job State "PENDING"
    When the Agent queries the Scheduler again
    Then the Scheduler reports Job State "RUNNING"
    When the Agent queries the Scheduler via "sacct -j 4827365"
    Then the Scheduler reports Job State "COMPLETED"
    And the Case state is COMPLETED
    And the output tree at Location "/scratch/snx3000/cera_user/cases/bhist_f09_g17_001/run/" is registered as producing Datasets

  Scenario: CESM output tree produces Datasets
    Given Job "4827365" associated with Case "bhist_f09_g17_001" has reached COMPLETED
    And the output tree at Location "/scratch/snx3000/cera_user/cases/bhist_f09_g17_001/run/" contains files:
      | file                              | format | grid    | variable |
      | tas_h0_0001-0005.nc              | NetCDF | lat-lon | TAS      |
      | pr_h0_0001-0005.nc               | NetCDF | lat-lon | PR       |
      | cas.h0_0001-01.nc                | NetCDF | lat-lon | TS       |
    When the Agent registers the output tree as Datasets
    Then three Datasets are registered:
      | name              | location                                                        | format | grid    |
      | tas_h0_0001-0005  | /scratch/snx3000/cera_user/cases/bhist_f09_g17_001/run/tas_h0_0001-0005.nc    | NetCDF | lat-lon |
      | pr_h0_0001-0005   | /scratch/snx3000/cera_user/cases/bhist_f09_g17_001/run/pr_h0_0001-0005.nc     | NetCDF | lat-lon |
      | cas_h0_0001_01    | /scratch/snx3000/cera_user/cases/bhist_f09_g17_001/run/cas.h0_0001-01.nc      | NetCDF | lat-lon |
    And a ProvenanceRecord is created for each Dataset, all referencing Job "4827365" and Case "bhist_f09_g17_001"

  # --- Wall time and resubmission ---

  Scenario: Job exceeds wall time — TIMEOUT state
    Given Job "4827366" is associated with Case "bhist_f09_g17_002"
    And Job "4827366" has ResourceRequest with wallTime "24:00:00"
    When the Agent queries the Scheduler via "sacct -j 4827366"
    Then the Scheduler reports Job State "TIMEOUT"
    And the Job does NOT transition to COMPLETED
    And the User is notified that Job "4827366" exceeded its wall time of 24:00:00
    And the Case state is FAILED

  Scenario: Resubmission after terminal state
    Given Job "4827366" associated with Case "bhist_f09_g17_002" has reached terminal state TIMEOUT
    When the Agent resubmits Case "bhist_f09_g17_002" via "case.submit"
    Then the SLURM Scheduler assigns a new JobID "4827390"
    And a new Job is created with JobID "4827390" associated with Case "bhist_f09_g17_002"
    And the Case state is SUBMITTED

  Scenario: Resubmission while Job is still RUNNING — rejected
    Given Job "4827365" is associated with Case "bhist_f09_g17_001"
    And the Scheduler reports Job "4827365" is RUNNING
    When the Agent attempts to resubmit Case "bhist_f09_g17_001"
    Then the resubmission is rejected
    And the Agent reports that Case "bhist_f09_g17_001" already has a RUNNING Job

  # --- Invariant enforcement ---

  Scenario: Submit an unbuilt Case — rejected (INV-M1)
    Given Case "bhist_f09_g17_003" is in state CONFIGURED
    When the Agent attempts to submit Case "bhist_f09_g17_003" via "case.submit"
    Then the submission is rejected
    And the Agent reports that the Case must be in BUILT state, not CONFIGURED
    And no Job is created

  Scenario: Run length exceeds wall time — caught at submission (INV-M3)
    Given Case "bhist_f09_g17_004" is in state BUILT
    And the Case's requested run length is 5 years (43800 hours)
    And the ResourceRequest has wallTime "168:00:00"
    When the Agent attempts to submit Case "bhist_f09_g17_004"
    Then the submission is rejected
    And the Agent reports that the run length (43800 hours) exceeds the wall time (168 hours)
    And the User is advised to increase the wall time or use restart files

  Scenario: Output tree Location not set before submission (INV-M4)
    Given Case "bhist_f09_g17_005" is in state BUILT
    And the output tree Location is not set
    When the Agent attempts to submit Case "bhist_f09_g17_005"
    Then the submission is rejected
    And the Agent reports that the output tree Location must be determined and recorded before submission

  # --- CESM build and configure failures ---

  Scenario: Build failure
    Given Case "bhist_f09_g17_006" is in state CONFIGURED
    When the Agent builds the Case via "case.build"
    And "case.build" exits with Exit Code 2 due to a missing dependency
    Then the Case state remains CONFIGURED — NOT BUILT
    And the User is notified of the build failure with the build log excerpt

  Scenario: Configure failure
    Given Case "bhist_f09_g17_007" is in state CREATED
    When the Agent configures the Case with an invalid compset "INVALID_COMPSET"
    Then the configuration is rejected
    And the Case state remains CREATED — NOT CONFIGURED
    And the User is notified that compset "INVALID_COMPSET" is not recognized

  Scenario: SLURM rejection at submission
    Given Case "bhist_f09_g17_008" is in state BUILT
    And the output tree Location is set and writable
    When the Agent submits the Case via "case.submit"
    And SLURM rejects the submission with error "Batch job submission failed: Invalid qos specification"
    Then no Job is created
    And the User is notified of the SLURM rejection with the full error message
    And the Agent does NOT retry the submission automatically

  # --- Cross-session recovery ---

  Scenario: Session ends while Job is RUNNING — Job survives
    Given Job "4827365" is associated with Case "bhist_f09_g17_001"
    And the Scheduler reports Job "4827365" is RUNNING
    When the Session ends
    Then Job "4827365" is NOT cancelled
    And Job "4827365" remains discoverable in a future Session by JobID "4827365"
