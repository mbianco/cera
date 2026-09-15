@C3 @data-management @C1 @tool-invocation @zarr
Feature: ZARR I/O
  As a climate scientist
  I want to read and write Datasets in ZARR format
  So that I can use Python-native chunked storage for large
  N-dimensional arrays, with parallel I/O at the chunk level
  and integration with Python tools (healpy, ICON tools).

  Background:
    Given a Session is active for User "cera_user" with SLURM username "cera_user"
    And an Environment with Modules "python/3.11.6 zarr/2.18.3 healpy/1.16.6" is loaded and verified conflict-free

  # --- Happy paths: reading ---

  Scenario: Read a ZARR Dataset
    Given a ZARR Dataset "tas_zarr_2000-2010" exists at Location "/scratch/snx3000/cera_user/data/tas_zarr_2000-2010.zarr"
    And Dataset "tas_zarr_2000-2010" has Format ZARR, Grid "r180x90" (lat-lon), and Variable "TAS" with units "K" and dimensions "time,lat,lon"
    And a ProvenanceRecord exists for Dataset "tas_zarr_2000-2010"
    When the Agent opens Dataset "tas_zarr_2000-2010" for reading
    Then the Dataset is accessible as a ZARR array with shape (3650, 90, 180)
    And the chunk shape is (365, 90, 180) — 10 chunks along the time axis

  Scenario: Chunk-level access for parallel I/O
    Given a ZARR Dataset "tas_zarr_2000-2010" exists at Location "/scratch/snx3000/cera_user/data/tas_zarr_2000-2010.zarr" with chunk shape (365, 90, 180)
    And a ProvenanceRecord exists for Dataset "tas_zarr_2000-2010"
    When the Agent reads chunks [0:5, :, :] — the first 5 time chunks (1825 days)
    Then only chunks 0 through 4 are read from the ZARR store
    And the read returns an array with shape (1825, 90, 180)
    And the remaining chunks [5:10, :, :] are NOT read

  Scenario: Read ZARR Dataset with a Python Tool
    Given a ZARR Dataset "healpix_data_nside1024" exists at Location "/scratch/snx3000/cera_user/data/healpix_data_nside1024.zarr"
    And Dataset "healpix_data_nside1024" has Format ZARR, Grid healpix (nside=1024, nest=True), and Variable "TAS" with dimensions "time,pixel"
    And a ProvenanceRecord exists for Dataset "healpix_data_nside1024"
    When the Agent invokes Python Tool "healpy_analysis" with parameters:
      | field        | value                                                              |
      | inputDataset | healpix_data_nside1024                                             |
      | operation    | angular_power_spectrum                                             |
      | lmax         | 2048                                                               |
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "healpix_aps_2048" is registered at Location "/scratch/snx3000/cera_user/output/healpix_aps_2048.zarr"
    And the new Dataset has Format ZARR and Variable "Cl" with dimensions "l"
    And a ProvenanceRecord is created for "healpix_aps_2048" with Tool "healpy 1.16.6", parameters "angular_power_spectrum lmax=2048", and input "healpix_data_nside1024"

  # --- Happy paths: writing ---

  Scenario: Write a ZARR Dataset from a NetCDF input
    Given a NetCDF Dataset "tas_historical_2000-2010" exists at Location "/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc"
    And Dataset "tas_historical_2000-2010" has Format NetCDF, Grid "r180x90", and Variable "TAS"
    And a ProvenanceRecord exists for Dataset "tas_historical_2000-2010"
    When the Agent invokes Python Tool "netcdf_to_zarr" with parameters:
      | field        | value                                                              |
      | inputDataset | tas_historical_2000-2010                                           |
      | outputPath   | /scratch/snx3000/cera_user/output/tas_zarr_2000-2010_converted.zarr |
      | chunks       | (365, 90, 180)                                                     |
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "tas_zarr_2000-2010_converted" is registered at Location "/scratch/snx3000/cera_user/output/tas_zarr_2000-2010_converted.zarr"
    And the new Dataset has Format ZARR (converted from NetCDF), Grid "r180x90", and Variable "TAS"
    And the original Dataset "tas_historical_2000-2010" remains at Location "/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc" with Format NetCDF — unchanged

  Scenario: ZARR write with custom chunk shape for parallel access
    Given a NetCDF Dataset "pr_historical_2000-2010" exists at Location "/scratch/snx3000/cera_user/data/pr_historical_2000-2010.nc"
    And a ProvenanceRecord exists for Dataset "pr_historical_2000-2010"
    When the Agent invokes Python Tool "netcdf_to_zarr" with parameters:
      | field        | value                                                              |
      | inputDataset | pr_historical_2000-2010                                           |
      | outputPath   | /scratch/snx3000/cera_user/output/pr_zarr_2000-2010_chunked.zarr  |
      | chunks       | (365, 90, 180)                                                     |
    Then the ToolInvocation's Exit Code is 0
    And the new Dataset "pr_zarr_2000-2010_chunked" is registered at Location "/scratch/snx3000/cera_user/output/pr_zarr_2000-2010_chunked.zarr"
    And the ZARR store contains 10 chunk objects along the time axis
    And each chunk object is stored as a separate compressed file under "/scratch/snx3000/cera_user/output/pr_zarr_2000-2010_chunked.zarr/TAS/0.X.Y"

  # --- Immutability ---

  Scenario: Original Dataset unchanged after ZARR conversion (INV-D1)
    Given a NetCDF Dataset "tas_historical_2000-2010" exists at Location "/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc" with Format NetCDF
    And a ProvenanceRecord exists for Dataset "tas_historical_2000-2010"
    When the Agent invokes Python Tool "netcdf_to_zarr" to convert "tas_historical_2000-2010" to ZARR
    Then the original Dataset "tas_historical_2000-2010" remains at Location "/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc" with Format NetCDF
    And the Agent opened the input Dataset for reading only — never for writing

  # --- Failure paths ---

  Scenario: Corrupted ZARR store — read failure
    Given a ZARR Dataset "corrupted_data" exists at Location "/scratch/snx3000/cera_user/data/corrupted_data.zarr"
    And the ZARR store at Location "/scratch/snx3000/cera_user/data/corrupted_data.zarr" is missing the ".zarray" metadata file
    And a ProvenanceRecord exists for Dataset "corrupted_data"
    When the Agent attempts to open Dataset "corrupted_data" for reading
    Then the read fails with a ZARR metadata error
    And the User is notified that the ZARR store at "/scratch/snx3000/cera_user/data/corrupted_data.zarr" is corrupted

  Scenario: Write to a read-only Location
    Given a NetCDF Dataset "tas_historical_2000-2010" exists at Location "/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc"
    And a ProvenanceRecord exists for Dataset "tas_historical_2000-2010"
    And the output Location "/scratch/snx3000/cera_user/readonly/output.zarr" has permissions "read-only"
    When the Agent invokes Python Tool "netcdf_to_zarr" with parameters:
      | field        | value                                                              |
      | inputDataset | tas_historical_2000-2010                                           |
      | outputPath   | /scratch/snx3000/cera_user/readonly/output.zarr                    |
    Then the ToolInvocation fails with a permission error
    And no output Dataset is registered
    And the User is notified that the output Location is not writable

  Scenario: ImportError — healpy module not loaded
    Given the Environment with Modules "python/3.11.6 zarr/2.18.3 healpy/1.16.6" is NOT loaded
    When the Agent attempts to invoke Python Tool "healpy_analysis" on Dataset "healpix_data_nside1024"
    Then the ToolInvocation is rejected before execution begins
    And the Agent reports that the required Environment is not loaded — "healpy/1.16.6" is missing

  Scenario: MemoryError on large array
    Given an Environment with Modules "python/3.11.6 zarr/2.18.3" is loaded
    And a ZARR Dataset "very_large_data" exists at Location "/scratch/snx3000/cera_user/data/very_large_data.zarr" with Variable "TAS" and shape (36500, 360, 720)
    And a ProvenanceRecord exists for Dataset "very_large_data"
    When the Agent invokes Python Tool "zarr_process" on Dataset "very_large_data" and the process runs out of memory (SIGKILL)
    Then the ToolInvocation's ExitOutcome is "Signal: SIGKILL (9)"
    And no output Dataset is registered
    And the User is notified of an out-of-memory condition and advised to process in chunks or request more memory
