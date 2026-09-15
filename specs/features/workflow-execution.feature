@C7 @agent-interaction @workflow
Feature: Workflow Execution
  As a climate scientist
  I want to execute multi-step Workflows with data dependencies
  So that each step's inputs are verified, failures halt downstream
  steps, and I can resume awareness of long-running Jobs across
  Sessions.

  Background:
    Given a Session is active for User "cera_user" with SLURM username "cera_user"
    And an Environment with Modules "cdo/2.0.5 gcc/11.2.0 openmpi/4.1.4" is loaded and verified conflict-free
    And an input Dataset "tas_historical_2000-2010" exists at Location "/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc"
    And Dataset "tas_historical_2000-2010" has Format NetCDF, Grid "r180x90" (lat-lon), and Variable "TAS" with dimensions "time,lat,lon"
    And a ProvenanceRecord exists for Dataset "tas_historical_2000-2010"

  # --- Happy path: multi-step workflow ---

  Scenario: Three-step Workflow with data dependencies
    Given a Workflow "annual_mean_workflow" with three WorkflowSteps:
      | order | name         | tool | parameters                                                                  | inputs                | outputs               |
      | 1     | select_tas  | cdo  | -selname,TAS /scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc /scratch/snx3000/cera_user/output/tas_only_2000-2010.nc | tas_historical_2000-2010 | tas_only_2000-2010   |
      | 2     | time_mean   | cdo  | -timmean /scratch/snx3000/cera_user/output/tas_only_2000-2010.nc /scratch/snx3000/cera_user/output/tas_annual_mean.nc | tas_only_2000-2010   | tas_annual_mean       |
      | 3     | remap       | cdo  | -remapcon2,/scratch/snx3000/cera_user/grids/target_r180x90.txt /scratch/snx3000/cera_user/output/tas_annual_mean.nc /scratch/snx3000/cera_user/output/tas_annual_mean_remapped.nc | tas_annual_mean | tas_annual_mean_remapped |
    When the Agent starts Workflow "annual_mean_workflow"
    Then WorkflowStep "select_tas" starts — its input "tas_historical_2000-2010" exists and has a ProvenanceRecord
    And WorkflowStep "select_tas" completes with Exit Code 0
    And a ProvenanceRecord is created for "tas_only_2000-2010"
    And WorkflowStep "time_mean" starts — its input "tas_only_2000-2010" exists and has a ProvenanceRecord
    And WorkflowStep "time_mean" completes with Exit Code 0
    And a ProvenanceRecord is created for "tas_annual_mean"
    And WorkflowStep "remap" starts — its input "tas_annual_mean" exists and has a ProvenanceRecord
    And WorkflowStep "remap" completes with Exit Code 0
    And a ProvenanceRecord is created for "tas_annual_mean_remapped"
    And the WorkflowState is COMPLETE

  Scenario: Workflow with a CESM Case as a step
    Given a Workflow "cesm_and_postproc" with two WorkflowSteps:
      | order | name           | tool         | inputs                    | outputs                    |
      | 1     | cesm_run       | cesm case.submit | tas_historical_2000-2010 (forcing data) | cesm_output_tree          |
      | 2     | post_process   | cdo -timmean | cesm_output_tree           | cesm_time_mean             |
    And Case "bhist_f09_g17_001" is in state BUILT
    When the Agent starts Workflow "cesm_and_postproc"
    Then WorkflowStep "cesm_run" submits Case "bhist_f09_g17_001" via SLURM
    And the Scheduler assigns JobID "4827365"
    And WorkflowStep "cesm_run" is in state IN_PROGRESS — waiting for Job "4827365"
    When Job "4827365" reaches COMPLETED
    Then WorkflowStep "cesm_run" completes
    And the output tree is registered as producing Dataset "cesm_output_tree"
    And a ProvenanceRecord is created for "cesm_output_tree" referencing Job "4827365"
    And WorkflowStep "post_process" starts — its input "cesm_output_tree" exists and has a ProvenanceRecord
    And WorkflowState is COMPLETE when "post_process" completes with Exit Code 0

  # --- Invariant enforcement ---

  Scenario: Step inputs must exist with Provenance (INV-W1)
    Given a Workflow "bad_workflow" with WorkflowStep "step1" whose declared input "nonexistent_dataset" does not exist
    When the Agent attempts to start WorkflowStep "step1"
    Then the WorkflowStep is blocked — it may not start
    And the Agent reports that input Dataset "nonexistent_dataset" does not exist
    And WorkflowState is BLOCKED

  Scenario: Step input exists but lacks ProvenanceRecord (INV-D3)
    Given a Dataset "no_provenance_data" exists at Location "/scratch/snx3000/cera_user/data/no_provenance_data.nc"
    But no ProvenanceRecord exists for Dataset "no_provenance_data"
    And a Workflow "bad_workflow" with WorkflowStep "step2" whose declared input is "no_provenance_data"
    When the Agent attempts to start WorkflowStep "step2"
    Then the WorkflowStep is blocked — it may not start
    And the Agent reports that "no_provenance_data" lacks a ProvenanceRecord
    And WorkflowState is BLOCKED

  Scenario: Failure halts downstream (INV-W2)
    Given a Workflow "failing_workflow" with three WorkflowSteps:
      | order | name         | inputs                | outputs               |
      | 1     | step1       | tas_historical_2000-2010 | step1_out        |
      | 2     | step2       | step1_out             | step2_out             |
      | 3     | step3       | step2_out             | step3_out             |
    When the Agent starts Workflow "failing_workflow"
    And WorkflowStep "step1" fails with Exit Code 2
    Then WorkflowStep "step1" has ExitOutcome "Exit Code 2"
    And no ProvenanceRecord is created for "step1_out"
    And WorkflowStep "step2" does NOT start automatically
    And WorkflowStep "step3" does NOT start automatically
    And WorkflowState is FAILED
    And the User is notified that "step1" failed and downstream steps are halted

  Scenario: Declared inputs match actual inputs (INV-W3)
    Given a Workflow "consistent_workflow" with WorkflowStep "select_tas" declaring input "tas_historical_2000-2010"
    When WorkflowStep "select_tas" runs CLI Tool "cdo" with operator "-selname,TAS" on input "tas_historical_2000-2010"
    Then the set of Datasets declared as inputs equals the set of Datasets the underlying ToolInvocation reads
    And the ProvenanceRecord for "select_tas" lists exactly "tas_historical_2000-2010" as input — no more, no less

  Scenario: Declared input not actually used — defect
    Given a Workflow "inconsistent_workflow" with WorkflowStep "step1" declaring inputs "tas_historical_2000-2010" and "pr_historical_2000-2010"
    But the underlying ToolInvocation only reads "tas_historical_2000-2010"
    When WorkflowStep "step1" runs
    Then the Agent detects a defect: "pr_historical_2000-2010" is declared as input but not consumed
    And the Agent notifies the User of the discrepancy
    And the ProvenanceRecord is flagged as defective

  # --- Session outlives Jobs ---

  Scenario: Session ends while Jobs are RUNNING — Jobs survive (INV-W4)
    Given a Workflow "cesm_and_postproc" is IN_PROGRESS
    And WorkflowStep "cesm_run" submitted Job "4827365" which is RUNNING
    When the Session ends
    Then Job "4827365" is NOT cancelled
    And WorkflowState is preserved — "cesm_run" remains IN_PROGRESS
    When a new Session begins for User "cera_user"
    And the Agent queries the Scheduler via "squeue -j 4827365"
    Then the Scheduler reports Job State "RUNNING"
    And the Agent resumes awareness of Workflow "cesm_and_postproc" and Job "4827365"
    And WorkflowStep "cesm_run" continues waiting for Job "4827365" to complete

  Scenario: Job completed in previous Session — resume and continue
    Given a Workflow "cesm_and_postproc" is IN_PROGRESS
    And WorkflowStep "cesm_run" submitted Job "4827365"
    And Session ends while Job "4827365" is RUNNING
    And Job "4827365" reaches COMPLETED after Session end
    When a new Session begins for User "cera_user"
    And the Agent queries the Scheduler via "sacct -j 4827365"
    Then the Scheduler reports Job State "COMPLETED"
    And the Agent identifies the output tree and registers Dataset "cesm_output_tree"
    And a ProvenanceRecord is created for "cesm_output_tree"
    And WorkflowStep "cesm_run" completes
    And WorkflowStep "post_process" starts — its input "cesm_output_tree" now exists with Provenance

  # --- Parallel step delegation ---

  Scenario: Parallel Tool invocation delegates to Scheduling
    Given a Workflow "parallel_workflow" with WorkflowStep "big_remap" that requires 64 nodes and 48 hours wall time
    When the Agent starts WorkflowStep "big_remap"
    Then the Agent submits a Job to the Scheduler via "sbatch" with ResourceRequest:
      | nodes   | coresPerNode | memory | wallTime  | partition | qos     |
      | 64      | 36           | 128GB  | 48:00:00  | normal    | default |
    And the Scheduler assigns a JobID
    And WorkflowStep "big_remap" is IN_PROGRESS — waiting for the Job
    And the ToolInvocation is NOT synchronous — it runs on compute nodes via SLURM

  Scenario: Synchronous Tool invocation does not delegate to Scheduling
    Given a Workflow "quick_workflow" with WorkflowStep "quick_select" that runs "ncks -v TAS" on a small Dataset
    When the Agent starts WorkflowStep "quick_select"
    Then the ToolInvocation runs synchronously on the login node — no Job is submitted
    And the ToolInvocation's Exit Code is available immediately after completion
    And a ProvenanceRecord is created for the output Dataset
