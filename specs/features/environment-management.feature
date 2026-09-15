@C5 @environment-management @uenv
Feature: Environment Management
  As a climate scientist
  I want to mount, verify, and switch uenv (user environments)
  So that each Tool invocation runs under a correct, conflict-free
  software stack — with conflicts detected before execution,
  not at runtime via a segfault or linker error.

  Background:
    Given a Session is active for User "cera_user" with SLURM username "cera_user"
    And the host uses uenv (user environments) — squashfs mounts in a prescribed place with required dependencies
    And the uenv registry is accessible at "/user-environment/env/"

  # --- Happy paths: mounting uenvs ---

  Scenario: Mount uenv for a CDO Environment
    When the Agent mounts uenv "cdo/2.0.5" at its prescribed path via "uenv mount cdo/2.0.5"
    Then the Environment is active with uenv "cdo/2.0.5" mounted
    And the Compiler Stack includes "gcc/11.2.0" with MPI runtime "openmpi/4.1.4"
    And the Environment is verified conflict-free — no two uenvs provide conflicting library paths
    And the binary "cdo" is available in PATH

  Scenario: Mount uenv for an Intel/CESM Environment
    When the Agent mounts uenv "cesm-intel/2.3.0" at its prescribed path via "uenv mount cesm-intel/2.3.0"
    Then the Environment is active with uenv "cesm-intel/2.3.0" mounted
    And the Compiler Stack is "intel/2021.4" with MPI runtime "intel-mpi/2021.4"
    And the Environment is verified conflict-free
    And the binary "case.setup" is available in PATH

  Scenario: Mount uenv for a Python Environment
    When the Agent mounts uenv "python-science/3.11.6" at its prescribed path via "uenv mount python-science/3.11.6"
    Then the Environment is active with uenv "python-science/3.11.6" mounted
    And the binaries "python3", "zarr", "healpy" are available in PATH
    And the Environment is verified conflict-free

  # --- uenv availability ---

  Scenario: Verify uenv availability before mount (INV-E3)
    When the Agent checks availability of uenv "cdo/2.0.5" via "uenv status cdo/2.0.5"
    Then the uenv registry confirms uenv "cdo/2.0.5" is available
    And the Agent proceeds to mount uenv "cdo/2.0.5"

  Scenario: uenv not found — mount refused before execution (FM-E1)
    When the Agent checks availability of uenv "nonexistent/1.0.0" via "uenv status nonexistent/1.0.0"
    Then the uenv registry reports no matching uenv
    And the Agent does NOT attempt to mount uenv "nonexistent/1.0.0"
    And the User is notified that uenv "nonexistent/1.0.0" is not available on the host
    And the EnvironmentError.UenvNotFound is raised

  # --- Conflict detection (filesystem path level, not soname) ---

  Scenario: Detect conflicting compiler stacks before execution (INV-E2)
    Given an Environment with uenv "cdo-gcc/2.0.5" is mounted — providing gcc/11.2.0 at /user-environment/env/cdo-gcc/2.0.5/usr
    When the Agent attempts to mount uenv "cesm-intel/2.3.0" — providing intel/2021.4 at /user-environment/env/cesm-intel/2.3.0/usr
    Then the Agent detects a filesystem path conflict: both uenvs provide "lib/libimf.so" at different versions
    And the mount is rejected before any Tool invocation begins under the conflicting stack
    And the User is notified of the conflict and advised to unmount the current Environment first
    And the EnvironmentError.ConflictDetected is raised

  Scenario: Detect conflicting MPI runtimes via library paths
    Given an Environment with uenv "openmpi-env/4.1.4" is mounted — providing libmpi.so.40 at /user-environment/env/openmpi-env/4.1.4/usr/lib
    When the Agent attempts to mount uenv "intel-mpi-env/2021.4" — providing libmpi.so.20 at /user-environment/env/intel-mpi-env/2021.4/usr/lib
    Then the Agent detects a filesystem path conflict: both uenvs provide a libmpi.so at different versions
    And the mount is rejected before any Tool invocation begins
    And the User is notified of the MPI library path conflict

  Scenario: Detect conflicting library paths (same library, different versions)
    Given an Environment with uenv "netcdf-env/4.9.2" is mounted — providing libnetcdf.so.4 at /user-environment/env/netcdf-env/4.9.2/usr/lib
    When the Agent attempts to mount uenv "netcdf-env/4.8.1" — providing libnetcdf.so.4 at /user-environment/env/netcdf-env/4.8.1/usr/lib
    Then the Agent detects a filesystem path conflict: both uenvs provide "libnetcdf.so.4" at paths that would both appear in LD_LIBRARY_PATH
    And the mount is rejected before any Tool invocation begins

  # --- One active Environment (INV-E1, re-evaluated for uenv) ---

  Scenario: Mounting a new Environment replaces the prior one
    Given an Environment with uenv "cdo-gcc/2.0.5" is active in the current execution context
    When the Agent unmounts uenv "cdo-gcc/2.0.5" via "uenv umount cdo-gcc/2.0.5"
    And the Agent mounts uenv "cesm-intel/2.3.0" via "uenv mount cesm-intel/2.3.0"
    Then the active Environment has uenv "cesm-intel/2.3.0" mounted — NOT "cdo-gcc/2.0.5"
    And the prior uenv's paths are no longer in PATH or LD_LIBRARY_PATH
    And the new Environment is verified conflict-free

  Scenario: Complementary uenvs may be mounted simultaneously
    Given an Environment with uenv "cdo-gcc/2.0.5" is active — providing cdo at /user-environment/env/cdo-gcc/2.0.5/usr/bin
    When the Agent attempts to mount uenv "python-science/3.11.6" — providing python3 at /user-environment/env/python-science/3.11.6/usr/bin
    Then the Agent detects NO filesystem path conflict — the uenvs provide different binaries at different paths
    And both uenvs are mounted simultaneously in the same execution context
    And the Environment includes both uenvs and is verified conflict-free

  Scenario: Two Environments with conflicting paths cannot coexist
    Given an Environment with uenv "cdo-gcc/2.0.5" is active in the current execution context
    And uenv "cdo-intel/2.0.5" provides the same binary "cdo" at a different path with incompatible libraries
    When the Agent attempts to activate uenv "cdo-intel/2.0.5"
    Then the Agent rejects the second activation
    And the Agent reports that the conflicting uenv cannot be mounted alongside "cdo-gcc/2.0.5"
    And the Agent offers to unmount the current Environment and mount the new one instead

  # --- Switching environments ---

  Scenario: Switch from CDO Environment to CESM Environment
    Given an Environment with uenv "cdo-gcc/2.0.5" is active
    When the Agent switches to an Environment with uenv "cesm-intel/2.3.0"
    Then the prior uenv is unmounted via "uenv umount cdo-gcc/2.0.5"
    And the new uenv is mounted via "uenv mount cesm-intel/2.3.0"
    And the new Environment is verified conflict-free
    And the Agent records the Environment switch in the current Session

  # --- Re-verification before invocation (X1 "out-of-order" case) ---

  Scenario: Environment purged between load and invocation
    Given an Environment with uenv "cdo-gcc/2.0.5" was loaded at T0
    And the Environment was purged by another process at T1
    When the Agent re-verifies the Environment immediately before invoking Tool "cdo" at T2
    Then the re-verification fails — the uenv is no longer mounted
    And the ToolInvocation is rejected (INV-T1)
    And the EnvironmentError.NotActive is raised
    And the Agent offers to reload the required uenv

  # --- Failure paths ---

  Scenario: Partial uenv mount — some paths mounted, others failed (FM-E3)
    When the Agent mounts uenv "broken-env/1.0.0" via "uenv mount broken-env/1.0.0"
    Then the mount partially succeeds — some squashfs paths are mounted but others fail with I/O error
    And the Agent detects the partial mount
    And the Agent unmounts all paths from this mount attempt
    And the Environment is marked as NOT active
    And the EnvironmentError.PartialLoad is raised
    And the User is notified of the partial failure with the specific paths that failed

  Scenario: Environment required by Tool not verified before invocation
    Given Tool "cdo" requires Environment with uenv "cdo-gcc/2.0.5"
    And no Environment is loaded in the current execution context
    When the Agent attempts to invoke Tool "cdo" with Action "compute_time_mean"
    Then the ToolInvocation is rejected before execution begins (INV-T1)
    And the Agent reports that the required Environment is not loaded
    And the ToolInvocationError.EnvironmentNotLoaded is raised
    And the Agent offers to mount the required uenv
