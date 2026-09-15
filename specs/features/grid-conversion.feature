@C3 @data-management @C1 @tool-invocation @grid-conversion
Feature: Grid Conversion
  As a climate scientist
  I want to convert Datasets between grid representations
  (ICON, healpix, GRIB2-native, lat-lon)
  So that I can use data from different models and tools on a common grid,
  preserving the original Dataset and producing a new one with full provenance.

  Background:
    Given a Session is active for User "cera_user" with SLURM username "cera_user"

  # --- Happy paths ---

  Scenario: Convert ICON grid to lat-lon using CDO
    Given an Environment with Modules "cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4" is loaded and verified conflict-free
    And an input Dataset "icon_data_R02B09" exists at Location "/scratch/snx3000/cera_user/data/icon_data_R02B09.nc"
    And Dataset "icon_data_R02B09" has Format NetCDF, Grid ICON, and Variable "TAS" with units "K" and dimensions "time,cell"
    And a target grid file "/scratch/snx3000/cera_user/grids/target_r180x90.txt" exists with content "gridtype = lonlat\nxsize = 180\nysize = 90"
    And a ProvenanceRecord exists for Dataset "icon_data_R02B09"
    When the Agent invokes CLI Tool "cdo" with operator chain "-remapcon2,/scratch/snx3000/cera_user/grids/target_r180x90.txt" on input Dataset "icon_data_R02B09" and output Location "/scratch/snx3000/cera_user/output/icon_to_latlon_R02B09.nc"
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "icon_to_latlon_R02B09" is registered at Location "/scratch/snx3000/cera_user/output/icon_to_latlon_R02B09.nc"
    And the new Dataset has Grid "r180x90" (lat-lon) — NOT ICON
    And the new Dataset has Variable "TAS" with dimensions "time,lat,lon" — NOT "time,cell"
    And the original Dataset "icon_data_R02B09" remains at Location "/scratch/snx3000/cera_user/data/icon_data_R02B09.nc" with Grid ICON — unchanged

  Scenario: Convert healpix to lat-lon using Python Tool (healpy)
    Given an Environment with Modules "python/3.11.6 healpy/1.16.6" is loaded and verified conflict-free
    And an input Dataset "healpix_data_nside1024" exists at Location "/scratch/snx3000/cera_user/data/healpix_data_nside1024.zarr"
    And Dataset "healpix_data_nside1024" has Format ZARR, Grid healpix (nside=1024, nest=True), and Variable "TAS" with dimensions "time,pixel"
    And a ProvenanceRecord exists for Dataset "healpix_data_nside1024"
    When the Agent invokes Python Tool "healpy_remap" with parameters:
      | field         | value                                                              |
      | inputDataset  | healpix_data_nside1024                                             |
      | outputPath    | /scratch/snx3000/cera_user/output/healpix_to_latlon_nside1024.nc  |
      | targetGrid    | r180x90                                                            |
      | nside         | 1024                                                               |
      | nest          | true                                                               |
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "healpix_to_latlon_nside1024" is registered at Location "/scratch/snx3000/cera_user/output/healpix_to_latlon_nside1024.nc"
    And the new Dataset has Format NetCDF, Grid "r180x90" (lat-lon), and Variable "TAS" with dimensions "time,lat,lon"
    And the original Dataset "healpix_data_nside1024" remains at Location "/scratch/snx3000/cera_user/data/healpix_data_nside1024.zarr" with Grid healpix — unchanged

  Scenario: Convert GRIB2-native to lat-lon using CDO
    Given an Environment with Modules "cdo/2.0.5 eccodes/2.31.0 gcc/11.2.0" is loaded and verified conflict-free
    And an input Dataset "grib2_data_T1279" exists at Location "/scratch/snx3000/cera_user/data/grib2_data_T1279.grib2"
    And Dataset "grib2_data_T1279" has Format GRIB2, Grid GRIB2-native (spectral T1279), and Variable "TAS" with units "K"
    And a target grid file "/scratch/snx3000/cera_user/grids/target_r180x90.txt" exists
    And a ProvenanceRecord exists for Dataset "grib2_data_T1279"
    When the Agent invokes CLI Tool "cdo" with operator chain "-remapcon2,/scratch/snx3000/cera_user/grids/target_r180x90.txt" on input Dataset "grib2_data_T1279" and output Location "/scratch/snx3000/cera_user/output/grib2_to_latlon_T1279.nc"
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "grib2_to_latlon_T1279" is registered at Location "/scratch/snx3000/cera_user/output/grib2_to_latlon_T1279.nc"
    And the new Dataset has Format NetCDF (converted from GRIB2), Grid "r180x90" (lat-lon), and Variable "TAS"
    And the original Dataset "grib2_data_T1279" remains at Location "/scratch/snx3000/cera_user/data/grib2_data_T1279.grib2" with Format GRIB2 — unchanged

  Scenario: Convert lat-lon to ICON grid using CDO
    Given an Environment with Modules "cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4" is loaded and verified conflict-free
    And an input Dataset "latlon_data_r180x90" exists at Location "/scratch/snx3000/cera_user/data/latlon_data_r180x90.nc"
    And Dataset "latlon_data_r180x90" has Format NetCDF, Grid "r180x90" (lat-lon), and Variable "TAS" with dimensions "time,lat,lon"
    And an ICON target grid file "/scratch/snx3000/cera_user/grids/icon_grid_R02B09.nc" exists
    And a ProvenanceRecord exists for Dataset "latlon_data_r180x90"
    When the Agent invokes CLI Tool "cdo" with operator chain "-remapcon2,/scratch/snx3000/cera_user/grids/icon_grid_R02B09.nc" on input Dataset "latlon_data_r180x90" and output Location "/scratch/snx3000/cera_user/output/latlon_to_icon_r180x90.nc"
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "latlon_to_icon_r180x90" is registered at Location "/scratch/snx3000/cera_user/output/latlon_to_icon_r180x90.nc"
    And the new Dataset has Grid ICON — NOT "r180x90" (lat-lon)
    And the new Dataset has Variable "TAS" with dimensions "time,cell" — NOT "time,lat,lon"
    And the original Dataset "latlon_data_r180x90" remains unchanged with Grid "r180x90"

  # --- Invariant enforcement ---

  Scenario: Original Dataset is immutable after grid conversion (INV-D1)
    Given an Environment with Modules "cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4" is loaded
    And an input Dataset "icon_data_R02B09" exists at Location "/scratch/snx3000/cera_user/data/icon_data_R02B09.nc" with Grid ICON
    And a ProvenanceRecord exists for Dataset "icon_data_R02B09"
    When the Agent invokes CLI Tool "cdo" with operator chain "-remapcon2,/scratch/snx3000/cera_user/grids/target_r180x90.txt" on input Dataset "icon_data_R02B09" and output Location "/scratch/snx3000/cera_user/output/icon_to_latlon_R02B09.nc"
    Then the ToolInvocation's Exit Code is 0
    And a new Dataset "icon_to_latlon_R02B09" is registered with Grid "r180x90"
    And the original Dataset "icon_data_R02B09" still has Grid ICON at the same Location
    And the original Dataset's bytes are not altered — the Agent opened the input for reading only

  Scenario: New Dataset has exactly one Grid, distinct from the original (INV-D2)
    Given a grid conversion from ICON to lat-lon is performed
    When the output Dataset "icon_to_latlon_R02B09" is registered
    Then "icon_to_latlon_R02B09" has exactly one Grid: "r180x90" (lat-lon)
    And "icon_to_latlon_R02B09" has exactly one Format: NetCDF
    And "icon_to_latlon_R02B09" is a distinct entity from "icon_data_R02B09" — different identity, different Location

  Scenario: Grid conversion output requires ProvenanceRecord before consumption (INV-D3)
    Given a grid conversion from ICON to lat-lon produces Dataset "icon_to_latlon_R02B09"
    And the ProvenanceRecord for "icon_to_latlon_R02B09" has NOT yet been written
    When a WorkflowStep attempts to consume "icon_to_latlon_R02B09" as input
    Then the WorkflowStep is blocked — it may not start
    And the Agent reports that "icon_to_latlon_R02B09" lacks a ProvenanceRecord

  # --- Failure paths ---

  Scenario: Invalid target grid file
    Given an Environment with Modules "cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4" is loaded
    And an input Dataset "icon_data_R02B09" exists at Location "/scratch/snx3000/cera_user/data/icon_data_R02B09.nc" with Grid ICON
    And a target grid file "/scratch/snx3000/cera_user/grids/invalid_grid.txt" exists with malformed content "this is not a grid"
    And a ProvenanceRecord exists for Dataset "icon_data_R02B09"
    When the Agent invokes CLI Tool "cdo" with operator chain "-remapcon2,/scratch/snx3000/cera_user/grids/invalid_grid.txt" on input Dataset "icon_data_R02B09" and output Location "/scratch/snx3000/cera_user/output/icon_invalid_grid.nc"
    Then the ToolInvocation's Exit Code is non-zero
    And CDO reports an error parsing the grid file
    And no output Dataset is registered
    And the User is notified of the invalid target grid

  Scenario: Missing interpolation weights for remapping
    Given an Environment with Modules "cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4" is loaded
    And an input Dataset "icon_data_R02B09" exists at Location "/scratch/snx3000/cera_user/data/icon_data_R02B09.nc" with Grid ICON
    And a target grid file "/scratch/snx3000/cera_user/grids/target_r180x90.txt" exists
    And CDO cannot compute interpolation weights for the ICON-to-lat-lon pair
    And a ProvenanceRecord exists for Dataset "icon_data_R02B09"
    When the Agent invokes CLI Tool "cdo" with operator chain "-remapcon2,/scratch/snx3000/cera_user/grids/target_r180x90.txt" on input Dataset "icon_data_R02B09" and output Location "/scratch/snx3000/cera_user/output/icon_no_weights.nc"
    Then the ToolInvocation's Exit Code is non-zero
    And CDO reports an error computing interpolation weights
    And no output Dataset is registered

  Scenario: healpix ring vs nest ordering mismatch
    Given an Environment with Modules "python/3.11.6 healpy/1.16.6" is loaded
    And an input Dataset "healpix_data_nside1024_ring" exists at Location "/scratch/snx3000/cera_user/data/healpix_data_nside1024_ring.zarr"
    And Dataset "healpix_data_nside1024_ring" has Grid healpix (nside=1024, nest=False — RING ordering)
    And a ProvenanceRecord exists for Dataset "healpix_data_nside1024_ring"
    When the Agent invokes Python Tool "healpy_remap" with parameter nest=True on input Dataset "healpix_data_nside1024_ring"
    Then the Python Tool detects that the input Dataset uses RING ordering but the parameter specifies nest=True
    And the ToolInvocation is flagged with a warning or fails with an ordering mismatch error
    And the User is notified of the ring/nest mismatch and asked to confirm the correct ordering
