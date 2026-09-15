@C5 @C1 @opengrads @evaluation
Feature: opengrads Evaluation
  As a cera developer
  I want to systematically evaluate whether opengrads can be supported
  on Alps (HPC, SLURM, no display on compute nodes)
  So that the go/no-go decision is based on concrete, reproducible
  criteria rather than assumptions about a legacy interactive tool.

  "opengrads (Open-source Grid Analysis and Display System) is an
  interactive desktop tool for accessing, manipulating, and
  visualizing earth-science data. It has its own scripting language
  and dynamically linked plugins. Hosted on SourceForge using CVS.
  Feasibility for HPC use is UNKNOWN and under evaluation.
  See ubiquitous-language.md: opengrads [LEGACY].

  This feature file does NOT contain the go/no-go decision. It
  provides concrete criteria and questions the domain expert must
  answer. The final decision is deferred."

  Background:
    Given a Session is active for User "cera_user" with SLURM username "cera_user"
    And Alps is the target HPC system with SLURM scheduling
    And compute nodes on Alps lack graphical display and outbound network
    And login nodes are shared and resource-limited

  # --- Buildability ---

  Scenario Outline: Evaluate opengrads buildability on Alps
    "opengrads is hosted on SourceForge using CVS. It uses dynamically
    linked plugins and has its own scripting language. Can it be built
    on a modern HPC system (Alps) with the available compilers and
    libraries?"

    Given the build environment has <compiler> loaded
    When the Agent attempts to build opengrads from source at Location "/scratch/snx3000/cera_user/builds/opengrads-src/"
    Then the build <result>
    And the build log is captured at Location "/scratch/snx3000/cera_user/builds/opengrads-src/build.log"

    Examples:
      | compiler           | result                                                              |
      | gcc/11.2.0         | succeeds — executable produced at opengrads/bin/grads              |
      | gcc/11.2.0         | fails — missing dependency on libgx11 (X11 not available on compute) |
      | intel/2021.4       | succeeds — executable produced at opengrads/bin/grads              |
      | gcc/11.2.0         | fails — CVS checkout from SourceForge is stale or unreachable       |

  Scenario: opengrads dynamic plugin linking on Alps
    Given opengrads is built at Location "/scratch/snx3000/cera_user/builds/opengrads-src/"
    When the Agent runs "ldd /scratch/snx3000/cera_user/builds/opengrads-src/bin/grads"
    Then the dynamic library dependencies are listed
    And the Agent checks whether any required library is not available on login or service nodes
    And the Agent records which plugins can and cannot load — this is a criterion for the go/no-go decision

  # --- HPC suitability: display constraints ---

  Scenario Outline: Evaluate display constraints on HPC nodes
    "opengrads is an interactive desktop tool that expects a graphical
    display. Compute nodes on Alps have no display. Can opengrads run
    on login or service nodes? Is that useful to scientists?"

    Given the Agent is running on a <nodeType> node
    When the Agent attempts to run opengrads with <displayConfig>
    Then the result is <result>
    And the Agent records whether the <nodeType> node is suitable for opengrads <useful>

    Examples:
      | nodeType    | displayConfig             | result                                        | useful                       |
      | compute     | DISPLAY not set           | fails — cannot open display                   | not useful                   |
      | compute     | DISPLAY=:0 (no X server)  | fails — cannot connect to X server            | not useful                   |
      | login       | DISPLAY not set           | fails — cannot open display                   | not useful                   |
      | login       | Xvfb :99 running          | succeeds — but login nodes are shared and limited; heavy visualization is prohibited | potentially useful for quick plots, not for production |
      | service     | DISPLAY not set           | fails — cannot open display                   | not useful                   |
      | service     | Xvfb :99 running          | succeeds — service node is less constrained   | potentially useful           |

  # --- Interactivity constraints ---

  Scenario Outline: Evaluate scripting interfaces for non-interactive use
    "The Agent runs non-interactively. opengrads expects interactive
    use. It has Python, Perl, and TCL interfaces — assess whether any
    can be driven programmatically without a human at a terminal."

    Given opengrads is built at Location "/scratch/snx3000/cera_user/builds/opengrads-src/"
    And the <interface> interface is available
    When the Agent attempts to run a scripted opengrads workflow via <interface>
    Then the result is <result>
    And the Agent records whether <interface> is viable for non-interactive use

    Examples:
      | interface | command                                                              | result                                                        |
      | gs (native scripting) | echo "open data.nc\nq file" | grads -b -cl 0 script.gs      | succeeds — batch mode (-b) runs without display              |
      | Python     | python -c "import grads; g = grads.GrADS(); g.open('data.nc')"      | succeeds — if gradspy is installed and compatible             |
      | Python     | python -c "import grads; g = grads.GrADS(); g.open('data.nc')"      | fails — gradspy not available or incompatible with Python 3.11 |
      | Perl      | perl -e "use GrADS; my $g = new GrADS; $g->open('data.nc')"         | succeeds — if Perl interface is installed                     |
      | TCL       | tclsh script.tcl                                                     | succeeds — if TCL interface is installed                      |

  # --- Maintenance status ---

  Scenario: Check opengrads maintenance status
    When the Agent checks the opengrads SourceForge page at "https://sourceforge.net/projects/opengrads/"
    Then the Agent records:
      | criterion              | value                                              |
      | last release date      | from SourceForge project page                      |
      | last CVS commit date   | from CVS repository                                |
      | open bug reports       | count from SourceForge tracker                     |
      | active maintainers     | count from project page or commit history          |
    And the Agent flags whether opengrads is actively maintained or abandoned
    And this is a criterion for the go/no-go decision

  # --- Go/no-go decision framework ---

  Scenario Outline: opengrads go/no-go decision framework
    "The final go/no-go decision is the domain expert's responsibility.
    This scenario provides the criteria and the questions the domain
    expert must answer. Each criterion is pass/fail. The decision
    framework requires at minimum: buildability, non-interactive use,
    and scientific value that no other Tool provides."

    Given the following criteria are evaluated:
      | criterion              | question                                                                  |
      | buildability           | Can opengrads be built on Alps with gcc/11.2.0 or intel/2021.4?           |
      | display                | Can opengrads run without a display (batch mode, scripting interface)?    |
      | scripting              | Is at least one scripting interface (gs, Python, Perl, TCL) viable for   |
      |                        |   non-interactive use?                                                     |
      | maintenance            | Is opengrads actively maintained? Last release, open bugs, commit history |
      | uniqueValue            | Does opengrads provide a capability that CDO, NCO, and Python tools       |
      |                        |   (healpy, ICON tools) cannot?                                             |
      | nodeAvailability       | Can opengrads run on login or service nodes without violating shared-node |
      |                        |   resource limits?                                                         |
    When the domain expert evaluates each criterion
    Then the decision is recorded as:
      | criterion              | status     | notes                                                              |
      | buildability           | <build>    |                                                                    |
      | display                | <display>  |                                                                    |
      | scripting              | <script>   |                                                                    |
      | maintenance            | <maint>    |                                                                    |
      | uniqueValue            | <unique>   |                                                                    |
      | nodeAvailability       | <node>     |                                                                    |
    And the final go/no-go is <decision>
    And if <decision> is "go", opengrads is added to the Tool catalog with its Environment requirements
    And if <decision> is "no-go", opengrads is excluded and the rationale is recorded

    Examples:
      | build   | display   | script   | maint   | unique   | node     | decision |
      | pass    | pass      | pass     | pass    | pass     | pass      | go       |
      | pass    | pass      | pass     | fail    | pass     | pass      | go with risk — maintenance status is a concern |
      | pass    | pass      | fail     | pass    | pass     | pass      | no-go — no non-interactive interface |
      | pass    | fail      | pass     | pass    | pass     | pass      | no-go — cannot run without display |
      | fail    | pass      | pass     | pass    | pass     | pass      | no-go — cannot build on Alps |
      | pass    | pass      | pass     | pass    | fail     | pass      | no-go — no unique value over existing tools |
      | pass    | pass      | pass     | pass    | pass     | fail      | no-go — no suitable node to run on |
