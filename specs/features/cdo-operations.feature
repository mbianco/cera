@C1 @tool-invocation @cdo
Feature: CDO Operations
  As a climate scientist
  I want to invoke CDO (Climate Data Operators) on NetCDF and GRIB2 Datasets
  So that I can aggregate, subset, remap, and transform climate data
  using a single CLI Tool with chainable operators.

  Background:
    Given a Session is active for User "cera_user" with SLURM username "cera_user"
    And an Environment with Modules "cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4" is loaded and verified conflict-free
    And an input Dataset "tas_historical_2000-2010" exists at Location "/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc"
    And Dataset "tas_historical_2000-2010" has Format NetCDF, Grid "r180x90" (lat-lon), and Variable "TAS" with units "K" and dimensions "time,lat,lon"
    And a ProvenanceRecord exists for Dataset "tas_historical_2000-2010"

  # --- Happy paths ---

  Scenario: Compute time mean with a single CDO operator
    When the Agent invokes CLI Tool "cdo" with operator chain "-timmean" on input Dataset "tas_historical_2000-2010" and output Location "/scratch/snx3000/cera_user/output/tas_timmean_2000-2010.nc"
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "tas_timmean_2000-2010" is registered at Location "/scratch/snx3000/cera_user/output/tas_timmean_2000-2010.nc"
    And the new Dataset has Format NetCDF, Grid "r180x90", and Variable "TAS" with dimensions "lat,lon"
    And a ProvenanceRecord is created for the new Dataset with:
      | field       | value                                                           |
      | tool        | cdo 2.0.5                                                       |
      | parameters  | -timmean /scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc /scratch/snx3000/cera_user/output/tas_timmean_2000-2010.nc |
      | environment | cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4                             |
      | inputs      | tas_historical_2000-2010                                        |
      | output      | tas_timmean_2000-2010                                           |
      | exitOutcome | Exit Code 0                                                    |

  Scenario: Chain two CDO operators evaluated right-to-left
    Given a target grid file "/scratch/snx3000/cera_user/grids/target_r180x90.txt" exists
    When the Agent invokes CLI Tool "cdo" with operator chain "-timmean -remapcon2,/scratch/snx3000/cera_user/grids/target_r180x90.txt" on input Dataset "tas_historical_2000-2010" and output Location "/scratch/snx3000/cera_user/output/tas_timmean_remap_2000-2010.nc"
    Then the ToolInvocation's Exit Code is 0
    And the operator chain is evaluated right-to-left: first "-remapcon2" on the input Dataset, then "-timmean" on the remapped intermediate data
    And a new Dataset "tas_timmean_remap_2000-2010" is registered at Location "/scratch/snx3000/cera_user/output/tas_timmean_remap_2000-2010.nc"
    And the new Dataset has Format NetCDF, Grid "r180x90" (lat-lon), and Variable "TAS"
    And a single ProvenanceRecord is created for the new Dataset recording the full operator chain "-timmean -remapcon2,target_r180x90.txt"

  Scenario: Two-input operator — field addition
    Given a second input Dataset "pr_historical_2000-2010" exists at Location "/scratch/snx3000/cera_user/data/pr_historical_2000-2010.nc" with Format NetCDF, Grid "r180x90", and Variable "PR"
    And a ProvenanceRecord exists for Dataset "pr_historical_2000-2010"
    When the Agent invokes CLI Tool "cdo" with operator chain "-add" on input Datasets "tas_historical_2000-2010" and "pr_historical_2000-2010" and output Location "/scratch/snx3000/cera_user/output/tas_plus_pr_2000-2010.nc"
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "tas_plus_pr_2000-2010" is registered at Location "/scratch/snx3000/cera_user/output/tas_plus_pr_2000-2010.nc"
    And the ProvenanceRecord for the new Dataset lists both "tas_historical_2000-2010" and "pr_historical_2000-2010" as inputs

  Scenario: Remap ICON grid to lat-lon using CDO
    Given an input Dataset "icon_data_R02B09" exists at Location "/scratch/snx3000/cera_user/data/icon_data_R02B09.nc" with Format NetCDF, Grid ICON, and Variable "TAS"
    And a target grid file "/scratch/snx3000/cera_user/grids/target_r180x90.txt" exists
    And a ProvenanceRecord exists for Dataset "icon_data_R02B09"
    When the Agent invokes CLI Tool "cdo" with operator chain "-remapcon2,/scratch/snx3000/cera_user/grids/target_r180x90.txt" on input Dataset "icon_data_R02B09" and output Location "/scratch/snx3000/cera_user/output/icon_to_latlon_R02B09.nc"
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "icon_to_latlon_R02B09" is registered at Location "/scratch/snx3000/cera_user/output/icon_to_latlon_R02B09.nc" with Grid "r180x90" (lat-lon)
    And the original Dataset "icon_data_R02B09" remains at Location "/scratch/snx3000/cera_user/data/icon_data_R02B09.nc" with Grid ICON — unchanged

  # --- Exit code and signal handling ---

  Scenario: CDO exits with code 0 — output registered as valid
    When the Agent invokes CLI Tool "cdo" with operator chain "-timmean" on input Dataset "tas_historical_2000-2010" and output Location "/scratch/snx3000/cera_user/output/tas_timmean_ok.nc"
    Then the ToolInvocation's Exit Code is 0
    And the output Dataset "tas_timmean_ok" is registered as available for downstream consumption
    And a ProvenanceRecord is created for "tas_timmean_ok" with ExitOutcome "Exit Code 0"

  Scenario: CDO exits with code 1 for a warning — output NOT registered (strict interpretation)
    "CDO returns exit code 1 for some warnings. If exit code 1 is NOT documented
    as a non-error code for this Tool, INV-T3 requires that the output Dataset is
    not registered as available."
    When the Agent invokes CLI Tool "cdo" with operator chain "-timmean" on input Dataset "tas_historical_2000-2010" and output Location "/scratch/snx3000/cera_user/output/tas_timmean_warn.nc"
    And CDO exits with Exit Code 1 and writes a warning to stderr
    Then the output Dataset "tas_timmean_warn" is NOT registered as available for downstream consumption
    And the ToolInvocation's ExitOutcome is "Exit Code 1"
    And the ProvenanceRecord for the ToolInvocation records Exit Code 1 as a non-success outcome
    And the User is notified that CDO returned a non-zero exit code

  Scenario: CDO exits with code 1 for a warning — output registered (permissive interpretation, requires per-Tool success definition)
    "If the domain expert confirms that exit code 1 is a documented non-error
    code for CDO (meaning 'warning, output is usable'), then INV-T3 permits
    registration. This scenario requires a per-Tool success definition to be
    documented in advance. FLAGGED AS UNKNOWN — see assumptions.md."
    Given a per-Tool success definition for CDO documents that Exit Code 1 indicates a warning with usable output
    When the Agent invokes CLI Tool "cdo" with operator chain "-timmean" on input Dataset "tas_historical_2000-2010" and output Location "/scratch/snx3000/cera_user/output/tas_timmean_warn_ok.nc"
    And CDO exits with Exit Code 1 and writes a warning to stderr
    Then the output Dataset "tas_timmean_warn_ok" is registered as available for downstream consumption
    And the ProvenanceRecord records Exit Code 1 with a flag indicating "warning, not failure"
    And the User is notified of the warning

  Scenario: CDO segfaults — reported as Signal, not Exit Code
    When the Agent invokes CLI Tool "cdo" with operator chain "-timmean" on input Dataset "tas_historical_2000-2010" and output Location "/scratch/snx3000/cera_user/output/tas_timmean_crash.nc"
    And CDO is terminated by Signal SIGSEGV (signal 11)
    Then the ToolInvocation's ExitOutcome is "Signal: SIGSEGV (11)"
    And the Exit Code is null — not a synthetic exit code
    And the output Dataset "tas_timmean_crash" is NOT registered as available
    And the User is notified that CDO crashed with signal SIGSEGV

  Scenario: CDO killed by SLURM SIGKILL on compute node
    When the Agent invokes CLI Tool "cdo" with operator chain "-timmean" on input Dataset "tas_historical_2000-2010" and output Location "/scratch/snx3000/cera_user/output/tas_timmean_killed.nc"
    And CDO is terminated by Signal SIGKILL (signal 9) due to out-of-memory on the node
    Then the ToolInvocation's ExitOutcome is "Signal: SIGKILL (9)"
    And the output Dataset "tas_timmean_killed" is NOT registered as available
    And the User is notified that CDO was killed by signal SIGKILL (likely out-of-memory)

  # --- Failure paths ---

  Scenario: CDO invocation refused — Environment not loaded
    Given the Environment with Modules "cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4" is NOT loaded
    When the Agent attempts to invoke CLI Tool "cdo" with operator chain "-timmean" on input Dataset "tas_historical_2000-2010"
    Then the ToolInvocation is rejected before execution begins
    And the Agent reports that the required Environment is not loaded
    And no output Dataset is produced

  Scenario: CDO invocation refused — missing input Dataset
    Given no Dataset exists at Location "/scratch/snx3000/cera_user/data/nonexistent.nc"
    When the Agent attempts to invoke CLI Tool "cdo" with operator chain "-timmean" on input Dataset at Location "/scratch/snx3000/cera_user/data/nonexistent.nc"
    Then the ToolInvocation is rejected before execution begins
    And the Agent reports that the input Dataset's Location does not resolve to an existing, readable path
    And no output Dataset is produced

  Scenario: CDO writes to a location with insufficient disk space
    When the Agent invokes CLI Tool "cdo" with operator chain "-timmean" on input Dataset "tas_historical_2000-2010" and output Location "/scratch/snx3000/cera_user/output/tas_timmean_full.nc"
    And the output filesystem is full — CDO writes a partial file and exits with Exit Code 1
    Then the output Dataset "tas_timmean_full" is NOT registered as available
    And the User is notified that the output filesystem has insufficient space
    And the partial output file is identified as non-authoritative

  Scenario: CDO produces output but a second ToolInvocation modifies the input concurrently
    Given a ToolInvocation with operator chain "-timmean" on input Dataset "tas_historical_2000-2010" is RUNNING
    When another process modifies the file at Location "/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc"
    Then the Agent does not recommend modifying an input Dataset while a consuming ToolInvocation is RUNNING
    And the Agent does not open the input Dataset for writing at any point
    And the running ToolInvocation's result is flagged as potentially compromised
