@C6 @provenance
Feature: Provenance
  As a climate scientist
  I want every Dataset and Job outcome to have an immutable
  ProvenanceRecord that captures the full reproducibility tuple
  So that I can re-execute any operation, audit scientific results,
  and query provenance across Sessions.

  Background:
    Given a Session is active for User "cera_user" with SLURM username "cera_user"
    And an Environment with Modules "cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4" is loaded and verified conflict-free
    And an input Dataset "tas_historical_2000-2010" exists at Location "/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc"
    And Dataset "tas_historical_2000-2010" has Format NetCDF, Grid "r180x90" (lat-lon), and Variable "TAS" with units "K" and dimensions "time,lat,lon"

  # --- Record creation ---

  Scenario: ProvenanceRecord created before output Dataset is consumed
    When the Agent invokes CLI Tool "cdo" with operator "-timmean" on input Dataset "tas_historical_2000-2010" and output Location "/scratch/snx3000/cera_user/output/tas_timmean_2000-2010.nc"
    Then the ToolInvocation's Exit Code is 0
    And a ProvenanceRecord is created for output Dataset "tas_timmean_2000-2010"
    And the ProvenanceRecord is created BEFORE "tas_timmean_2000-2010" is registered as available for downstream consumption
    And "tas_timmean_2000-2010" is registered as available only after its ProvenanceRecord exists

  Scenario: ProvenanceRecord for a Job outcome (not just a Dataset)
    Given Case "bhist_f09_g17_001" is in state BUILT
    And an Environment with Modules "intel/2021.4 intel-mpi/2021.4 craype/2.7.10" is loaded
    When the Agent submits Case "bhist_f09_g17_001" via "case.submit"
    And the Scheduler assigns JobID "4827365"
    And Job "4827365" reaches COMPLETED
    Then a ProvenanceRecord is created for Job "4827365" with:
      | field       | value                                                                  |
      | tool        | cesm case.submit                                                       |
      | parameters  | compset=BHIST resolution=f09_g17 machine=daint runLength=5years       |
      | environment | intel/2021.4 intel-mpi/2021.4 craype/2.7.10                           |
      | inputs      | forcing Datasets (list)                                                |
      | output      | output tree at /scratch/snx3000/cera_user/cases/bhist_f09_g17_001/run/ |
      | timestamp   | ISO 8601 at submission and at completion                               |
      | exitOutcome | Exit Code 0                                                            |
      | jobID       | 4827365                                                                |
      | jobState    | COMPLETED                                                              |

  Scenario: ProvenanceRecord for a failed ToolInvocation
    When the Agent invokes CLI Tool "cdo" with operator "-timmean" on input Dataset "tas_historical_2000-2010" and output Location "/scratch/snx3000/cera_user/output/tas_failed.nc"
    And CDO exits with Signal SIGSEGV (signal 11)
    Then a ProvenanceRecord is created for the failed ToolInvocation with:
      | field       | value                                                |
      | tool        | cdo 2.0.5                                            |
      | parameters  | -timmean .../tas_historical_2000-2010.nc .../tas_failed.nc |
      | environment | cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4                  |
      | inputs      | tas_historical_2000-2010                            |
      | output      | null — no output produced                            |
      | timestamp   | ISO 8601                                             |
      | exitOutcome | Signal: SIGSEGV (11)                                 |
    And no output Dataset "tas_failed" is registered

  # --- Full reproducibility tuple (INV-P2) ---

  Scenario: ProvenanceRecord contains the full reproducibility tuple
    When the Agent invokes CLI Tool "cdo" with operator "-timmean" on input Dataset "tas_historical_2000-2010" and output Location "/scratch/snx3000/cera_user/output/tas_timmean_2000-2010.nc"
    Then the ProvenanceRecord for "tas_timmean_2000-2010" contains all of:
      | field       | value                                                                  |
      | tool        | cdo 2.0.5 (name + version)                                            |
      | parameters  | -timmean /scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc /scratch/snx3000/cera_user/output/tas_timmean_2000-2010.nc |
      | environment | cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4 (all Modules with versions)       |
      | inputs      | tas_historical_2000-2010 (Dataset identity)                           |
      | output      | tas_timmean_2000-2010 (Dataset identity)                              |
      | timestamp   | ISO 8601                                                              |
      | exitOutcome | Exit Code 0                                                           |
    And no field in the tuple is null

  Scenario: ProvenanceRecord with missing field is defective
    When a ProvenanceRecord is created for Dataset "tas_timmean_2000-2010" but the Environment field is null
    Then the ProvenanceRecord is flagged as defective
    And Dataset "tas_timmean_2000-2010" is NOT registered as available for downstream consumption
    And the User is notified that the ProvenanceRecord is missing the Environment field

  # --- Immutability (INV-P1) ---

  Scenario: ProvenanceRecord is immutable once written
    Given a ProvenanceRecord exists for Dataset "tas_timmean_2000-2010" with Tool "cdo 2.0.5"
    When the Agent attempts to modify the ProvenanceRecord's Tool field to "cdo 2.1.0"
    Then the modification is rejected
    And the ProvenanceRecord retains Tool "cdo 2.0.5"
    And a new ProvenanceRecord is created with Tool "cdo 2.1.0" — linked to the prior one — only if a new ToolInvocation produces a new Dataset

  Scenario: ProvenanceRecord correction creates a new record
    Given a ProvenanceRecord exists for Dataset "tas_timmean_2000-2010" with an error in the parameters field
    When the Agent corrects the parameters
    Then a new ProvenanceRecord is created with corrected parameters
    And the new ProvenanceRecord is linked to the original via a "corrects" relationship
    And the original ProvenanceRecord remains unchanged

  # --- Cross-session provenance query (INV-P4) ---

  Scenario: Query provenance for a Dataset produced in a previous Session
    Given a ProvenanceRecord for Dataset "tas_timmean_2000-2010" was written in Session "s1"
    And Session "s1" has ended
    When a new Session "s2" begins for User "cera_user"
    And the Agent queries ProvenanceRecords for Dataset "tas_timmean_2000-2010" in Session "s2"
    Then the ProvenanceRecord from Session "s1" is returned
    And the record contains the full reproducibility tuple from Session "s1"

  Scenario: Query full lineage of a Dataset across Sessions
    Given the following ProvenanceRecords were written across Sessions:
      | session | dataset                       | tool        | inputs                      |
      | s1      | tas_only_2000-2010           | cdo -selname | tas_historical_2000-2010   |
      | s1      | tas_annual_mean              | cdo -timmean | tas_only_2000-2010         |
      | s2      | tas_annual_mean_remapped     | cdo -remapcon2 | tas_annual_mean          |
    When the Agent queries the lineage of Dataset "tas_annual_mean_remapped" in Session "s2"
    Then the lineage includes:
      | dataset                       | tool           | inputs                      |
      | tas_annual_mean_remapped     | cdo -remapcon2 | tas_annual_mean            |
      | tas_annual_mean              | cdo -timmean   | tas_only_2000-2010         |
      | tas_only_2000-2010           | cdo -selname   | tas_historical_2000-2010   |
    And the full chain is traceable from "tas_annual_mean_remapped" back to the original input "tas_historical_2000-2010"

  Scenario: Query provenance for a Job from a previous Session
    Given a ProvenanceRecord for Job "4827365" was written in Session "s1"
    And Session "s1" has ended
    When a new Session "s2" begins for User "cera_user"
    And the Agent queries ProvenanceRecords for Job "4827365" in Session "s2"
    Then the ProvenanceRecord from Session "s1" is returned
    And the record contains the full reproducibility tuple including Case identity, ResourceRequest, and JobState

  # --- Failure paths ---

  Scenario: ProvenanceRecord write failure
    When the Agent invokes CLI Tool "cdo" with operator "-timmean" on input Dataset "tas_historical_2000-2010" and output Location "/scratch/snx3000/cera_user/output/tas_timmean_2000-2010.nc"
    And CDO exits with Exit Code 0
    But the ProvenanceRecord write fails due to a storage error
    Then Dataset "tas_timmean_2000-2010" is NOT registered as available for downstream consumption
    And the User is notified that the ProvenanceRecord could not be written
    And the Agent retries the ProvenanceRecord write with backoff

  Scenario: Corrupted ProvenanceRecord
    Given a ProvenanceRecord for Dataset "tas_timmean_2000-2010" exists but is corrupted (unparseable)
    When a WorkflowStep attempts to consume "tas_timmean_2000-2010" as input
    Then the WorkflowStep is blocked
    And the Agent reports that the ProvenanceRecord for "tas_timmean_2000-2010" is corrupted
    And the Agent attempts to reconstruct the ProvenanceRecord from available metadata
    And if reconstruction fails, the User is notified and the Dataset is quarantined

  Scenario: ProvenanceRecord missing — Dataset not consumable (INV-D3 / INV-P3)
    Given a Dataset "unprovenanced_data" exists at Location "/scratch/snx3000/cera_user/data/unprovenanced_data.nc" with Format NetCDF
    But no ProvenanceRecord exists for Dataset "unprovenanced_data"
    When a WorkflowStep attempts to consume "unprovenanced_data" as input
    Then the WorkflowStep is blocked — it may not start
    And the Agent reports that "unprovenanced_data" lacks a ProvenanceRecord
    And the Agent offers to create a ProvenanceRecord if the User can supply the origin information
