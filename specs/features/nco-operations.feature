@C1 @tool-invocation @nco
Feature: NCO Operations
  As a climate scientist
  I want to invoke NCO (NetCDF Climate Operators) on NetCDF Datasets
  So that I can subset, average, concatenate, and edit attributes
  using separate CLI executables — one operator per invocation,
  no chaining.

  Background:
    Given a Session is active for User "cera_user" with SLURM username "cera_user"
    And an Environment with Modules "nco/5.1.6 gcc/11.2.0 openmpi/4.1.4" is loaded and verified conflict-free
    And an input Dataset "tas_historical_2000-2010" exists at Location "/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc"
    And Dataset "tas_historical_2000-2010" has Format NetCDF, Grid "r180x90" (lat-lon), and Variables "TAS" (units "K", dimensions "time,lat,lon") and "PR" (units "mm/day", dimensions "time,lat,lon")
    And a ProvenanceRecord exists for Dataset "tas_historical_2000-2010"

  # --- Happy paths ---

  Scenario: Select a single variable with ncks
    When the Agent invokes CLI Tool "ncks" with parameters "-v TAS /scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc /scratch/snx3000/cera_user/output/tas_only_2000-2010.nc"
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "tas_only_2000-2010" is registered at Location "/scratch/snx3000/cera_user/output/tas_only_2000-2010.nc"
    And the new Dataset has Format NetCDF, Grid "r180x90", and exactly one Variable "TAS"
    And a ProvenanceRecord is created for "tas_only_2000-2010" with Tool "nco 5.1.6", parameters "-v TAS", input "tas_historical_2000-2010", and ExitOutcome "Exit Code 0"

  Scenario: Average across time with ncra
    When the Agent invokes CLI Tool "ncra" with parameters "/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc /scratch/snx3000/cera_user/output/tas_time_avg_2000-2010.nc"
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "tas_time_avg_2000-2010" is registered at Location "/scratch/snx3000/cera_user/output/tas_time_avg_2000-2010.nc"
    And the new Dataset has Variable "TAS" with dimensions "lat,lon" (time dimension collapsed)
    And a ProvenanceRecord is created for "tas_time_avg_2000-2010" with Tool "nco 5.1.6", parameters "ncra", and input "tas_historical_2000-2010"

  Scenario: Edit an attribute with ncatted
    When the Agent invokes CLI Tool "ncatted" with parameters "-a units,TAS,o,c,Kelvin /scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc /scratch/snx3000/cera_user/output/tas_units_edited_2000-2010.nc"
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "tas_units_edited_2000-2010" is registered at Location "/scratch/snx3000/cera_user/output/tas_units_edited_2000-2010.nc"
    And the new Dataset's Variable "TAS" has attribute "units" with value "Kelvin"
    And the original Dataset "tas_historical_2000-2010" remains unchanged with Variable "TAS" units "K"
    And a ProvenanceRecord is created for "tas_units_edited_2000-2010" with Tool "nco 5.1.6", parameters "-a units,TAS,o,c,Kelvin"

  Scenario: Concatenate ensemble members with ncecat
    Given input Dataset "ens_member_01" exists at Location "/scratch/snx3000/cera_user/data/ens_member_01.nc" with Format NetCDF, Grid "r180x90", and Variable "TAS"
    And input Dataset "ens_member_02" exists at Location "/scratch/snx3000/cera_user/data/ens_member_02.nc" with Format NetCDF, Grid "r180x90", and Variable "TAS"
    And ProvenanceRecords exist for both "ens_member_01" and "ens_member_02"
    When the Agent invokes CLI Tool "ncecat" with parameters "/scratch/snx3000/cera_user/data/ens_member_01.nc /scratch/snx3000/cera_user/data/ens_member_02.nc /scratch/snx3000/cera_user/output/ens_concat.nc"
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "ens_concat" is registered at Location "/scratch/snx3000/cera_user/output/ens_concat.nc"
    And the ProvenanceRecord for "ens_concat" lists both "ens_member_01" and "ens_member_02" as inputs

  # --- No-chaining constraint ---

  Scenario: NCO operators are separate executables and cannot be chained
    "Unlike CDO, where multiple operators are passed in a single command
    (e.g., `cdo -timmean -remapcon2,... input output`), each NCO operator
    is its own executable. There is no mechanism to chain operators within
    a single invocation."
    When the User requests selecting Variable "TAS" and then averaging across time using NCO
    Then the Agent performs two separate ToolInvocations:
      | order | tool    | parameters                                                          | output                              |
      | 1     | ncks    | -v TAS /scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc /scratch/snx3000/cera_user/output/tas_only_2000-2010.nc | tas_only_2000-2010 |
      | 2     | ncra    | /scratch/snx3000/cera_user/output/tas_only_2000-2010.nc /scratch/snx3000/cera_user/output/tas_time_avg_2000-2010.nc       | tas_time_avg_2000-2010 |
    And the second ToolInvocation does not start until the first has Exit Code 0
    And the second ToolInvocation's input "tas_only_2000-2010" has a ProvenanceRecord
    And separate ProvenanceRecords are created for each ToolInvocation

  # --- Failure paths ---

  Scenario: ncks on a non-existent Variable
    When the Agent invokes CLI Tool "ncks" with parameters "-v NONEXISTENT /scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc /scratch/snx3000/cera_user/output/empty.nc"
    Then the ToolInvocation's Exit Code is non-zero
    And no output Dataset is registered as available
    And the User is notified that Variable "NONEXISTENT" does not exist in Dataset "tas_historical_2000-2010"

  Scenario: ncra on an empty input list
    When the Agent attempts to invoke CLI Tool "ncra" with no input Dataset
    Then the ToolInvocation is rejected before execution begins
    And the Agent reports that at least one input Dataset is required
    And no output Dataset is produced

  Scenario: NCO invocation refused — Environment not loaded
    Given the Environment with Modules "nco/5.1.6 gcc/11.2.0 openmpi/4.1.4" is NOT loaded
    When the Agent attempts to invoke CLI Tool "ncks" with parameters "-v TAS /scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc /scratch/snx3000/cera_user/output/tas_only.nc"
    Then the ToolInvocation is rejected before execution begins
    And the Agent reports that the required Environment is not loaded

  Scenario: NCO input Dataset has no ProvenanceRecord
    Given an input Dataset "no_provenance_data" exists at Location "/scratch/snx3000/cera_user/data/no_provenance_data.nc" with Format NetCDF
    But no ProvenanceRecord exists for Dataset "no_provenance_data"
    When the Agent attempts to invoke CLI Tool "ncks" on input Dataset "no_provenance_data"
    Then the ToolInvocation is rejected
    And the Agent reports that the input Dataset lacks a ProvenanceRecord and cannot be consumed

  Scenario: NCO produces a non-zero exit code — output not registered
    When the Agent invokes CLI Tool "ncra" with parameters "/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc /scratch/snx3000/cera_user/output/tas_avg_failed.nc"
    And ncra exits with Exit Code 2 due to a dimension mismatch
    Then the output Dataset "tas_avg_failed" is NOT registered as available
    And the ToolInvocation's ExitOutcome is "Exit Code 2"
    And the User is notified of the failure with the stderr output
