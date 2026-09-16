/**
 * ActionService implementation (C7, R3, R12).
 *
 * Action is the LLM-facing concept that replaces the overloaded
 * "Operator (Agent)" (R3). An Action is a domain-level operation
 * (e.g., "select_variable", "compute_time_mean", "remap_grid")
 * that maps to a Tool in the catalog. The LLM generates
 * ActionRequests; the ActionService validates them BEFORE creating
 * a ToolInvocation.
 *
 * R12 / ADR-010 — refuse and ask:
 * - FM-A1 (hallucinated Tool name): if the Action is not registered
 *   or its Tool is not in the catalog, the Agent REFUSES and asks
 *   the User for clarification. No best-effort substitution.
 * - FM-A2 (hallucinated parameters): if the parameters do not match
 *   the Action's JSONSchema, or the input Datasets do not satisfy
 *   the Action's inputRequirements, the Agent REFUSES and asks.
 *
 * There is no best-effort code path: the Agent never substitutes a
 * "close" Tool name, infers missing parameters, or proceeds with
 * unvalidated parameters. For climate science, wrong parameters may
 * produce plausible-looking but scientifically invalid output — worse
 * than a crash (ADR-010).
 *
 * Spec: api-contracts.md §7 (ActionService, ActionRequest,
 * ActionResult); module-graph.md §7; resolutions.md R3, R12;
 * failure-modes.md FM-A1, FM-A2; ADR-010.
 */

import type { DataManagementService } from '../data-management/types';
import type {
  Action,
  DatasetId,
  JSONSchema,
  Location,
  ToolId,
} from '../types';
import type { ToolCatalogService, ToolInvocationRequest } from '../tool-invocation/types';
import type {
  ActionRequest,
  ActionResult,
  ActionServiceConfig,
} from './types';
import { DEFAULT_ACTION_SERVICE_CONFIG } from './types';

// ============================================================================
// ActionServiceImplProps
// ============================================================================

/**
 * Constructor parameters for ActionServiceImpl.
 *
 * `catalog` — used to look up the Tool that an Action maps to
 *   (FM-A1: refuse and ask if the Tool is not in the catalog).
 * `dataManagement` — used to fetch input Dataset metadata so the
 *   Agent can validate parameters against the Dataset's actual
 *   variables, formats, and grids (FM-A2).
 * `config` — optional partial override of the default Action
 *   configuration.
 */
export interface ActionServiceImplProps {
  readonly catalog: ToolCatalogService;
  readonly dataManagement: DataManagementService;
  readonly config?: Partial<ActionServiceConfig>;
}

// ============================================================================
// ActionServiceImpl
// ============================================================================

/**
 * ActionService implementation.
 *
 * R3: Action is the LLM-facing concept that maps to a Tool.
 * R12 / ADR-010: validate before invocation — refuse and ask if the
 *   Tool or parameters are hallucinated. No best-effort.
 *
 * Spec: api-contracts.md §7; resolutions.md R3, R12; ADR-010.
 */
export class ActionServiceImpl {
  #catalog: ToolCatalogService;
  #dataManagement: DataManagementService;
  #config: ActionServiceConfig;
  #actions: Map<string, Action> = new Map();

  constructor(props: ActionServiceImplProps) {
    this.#catalog = props.catalog;
    this.#dataManagement = props.dataManagement;
    this.#config = {
      ...DEFAULT_ACTION_SERVICE_CONFIG,
      ...props.config,
    };
  }

  // ========================================================================
  // registerAction (R3)
  // ========================================================================

  /**
   * Registers an Action so the LLM can discover and invoke it
   * (R3). If an Action with the same name is already registered,
   * it is replaced.
   *
   * The Action's referenced Tool (via `toolId`) must be registered
   * in the catalog separately (via `catalog.registerTool()`).
   * `validateAction()` checks the catalog before creating a
   * ToolInvocation.
   *
   * Spec: api-contracts.md §7 (registerAction).
   */
  async registerAction(action: Action): Promise<void> {
    this.#actions.set(action.name, action);
  }

  // ========================================================================
  // listActions (R3)
  // ========================================================================

  /**
   * Lists all registered Actions, ordered by registration order.
   *
   * Spec: api-contracts.md §7 (listActions).
   */
  async listActions(): Promise<readonly Action[]> {
    return Object.freeze(Array.from(this.#actions.values()));
  }

  // ========================================================================
  // validateAction (R12, ADR-010 — refuse and ask)
  // ========================================================================

  /**
   * Validates an Action request against the Tool catalog and the
   * input Datasets' metadata BEFORE creating a ToolInvocation
   * (R12, ADR-010).
   *
   * Validation order (each check is fail-fast):
   * 1. The Action must be registered (by `actionName`). If not,
   *    return `refuseAndAsk` with the available ToolIds (FM-A1).
   * 2. The Action's mapped Tool must exist in the catalog. If not,
   *    return `refuseAndAsk` with the available ToolIds (FM-A1).
   * 3. The requested parameters must match the Action's
   *    `parameterSchema` (required fields, additionalProperties,
   *    basic type checks). If not, return `invalid` with a reason
   *    and optional suggestion (FM-A2).
   * 4. The input Datasets must exist and satisfy the Action's
   *    `inputRequirements` (formats, grids, variables). If not,
   *    return `invalid` with a reason and optional suggestion
   *    (FM-A2).
   * 5. If all checks pass, return `valid` with a fully-formed
   *    `ToolInvocationRequest` that can be passed to
   *    `toolInvocation.invokeTool()`.
   *
   * There is NO best-effort code path: the Agent never substitutes
   * a Tool, infers parameters, or proceeds with unvalidated input
   * (ADR-010).
   *
   * Spec: api-contracts.md §7 (validateAction, ActionResult);
   * resolutions.md R12; failure-modes.md FM-A1, FM-A2; ADR-010.
   */
  async validateAction(request: ActionRequest): Promise<ActionResult> {
    // ------------------------------------------------------------------
    // 1. The Action must be registered (FM-A1)
    // ------------------------------------------------------------------
    const action = this.#actions.get(request.actionName);
    if (action === undefined) {
      const availableTools = await this.#listAvailableToolIds();
      return {
        refuseAndAsk: true,
        message: `Action '${request.actionName}' is not registered. The Agent refuses to guess (R12, ADR-010).`,
        availableTools,
      };
    }

    // ------------------------------------------------------------------
    // 2. The Action's mapped Tool must be in the catalog (FM-A1)
    // ------------------------------------------------------------------
    const tool = await this.#catalog.getTool(action.toolId);
    if (tool === null) {
      const availableTools = await this.#listAvailableToolIds();
      return {
        refuseAndAsk: true,
        message: `Tool '${action.toolId as string}' (mapped by Action '${action.name}') is not in the catalog. The Agent refuses to guess (R12, ADR-010).`,
        availableTools,
      };
    }

    // ------------------------------------------------------------------
    // 3. Validate parameters against the Action's schema (FM-A2)
    // ------------------------------------------------------------------
    const paramError = this.#validateParameters(
      request.parameters,
      action.parameterSchema,
    );
    if (paramError !== null) {
      return {
        valid: false,
        reason: paramError.reason,
        suggestion: paramError.suggestion,
      };
    }

    // ------------------------------------------------------------------
    // 4. Validate input Datasets against inputRequirements (FM-A2)
    // ------------------------------------------------------------------
    const inputError = await this.#validateInputDatasets(
      request.inputDatasetIds,
      action,
    );
    if (inputError !== null) {
      return {
        valid: false,
        reason: inputError.reason,
        suggestion: inputError.suggestion,
      };
    }

    // ------------------------------------------------------------------
    // 5. Build the ToolInvocationRequest
    // ------------------------------------------------------------------
    const toolInvocationRequest: ToolInvocationRequest = {
      toolId: action.toolId,
      parameters: request.parameters,
      inputDatasetIds: request.inputDatasetIds,
      outputLocation: this.#deriveOutputLocation(action.name),
      executionModel: tool.executionModel,
    };

    return { valid: true, toolInvocationRequest };
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /**
   * Lists the ToolIds of all Tools currently in the catalog. Used
   * for the `availableTools` field of a `refuseAndAsk` result so the
   * User can see what they can choose from (FM-A1).
   */
  async #listAvailableToolIds(): Promise<readonly ToolId[]> {
    const tools = await this.#catalog.getToolCatalog();
    return Object.freeze(tools.map((t) => t.id));
  }

  /**
   * Validates the requested parameters against the Action's JSON
   * Schema (FM-A2).
   *
   * Checks:
   * 1. All `required` fields are present.
   * 2. If `additionalProperties` is `false`, no unexpected
   *    parameters are present.
   * 3. Each provided parameter matches its declared type (string,
   *    number, boolean) where the schema specifies one.
   *
   * @returns `{ reason, suggestion? }` if invalid, `null` if valid.
   */
  #validateParameters(
    parameters: Record<string, unknown>,
    schema: JSONSchema,
  ): { reason: string; suggestion?: string } | null {
    // 1. Required fields
    if (schema.required !== undefined) {
      for (const field of schema.required) {
        if (!(field in parameters)) {
          return {
            reason: `Missing required parameter '${field}'.`,
            suggestion: `Provide a value for '${field}'.`,
          };
        }
      }
    }

    // 2. additionalProperties: false
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(parameters)) {
        if (!(key in schema.properties)) {
          return {
            reason: `Unexpected parameter '${key}' is not allowed (additionalProperties: false).`,
            suggestion: `Remove '${key}' or add it to the Action's parameterSchema.`,
          };
        }
      }
    }

    // 3. Type checks for provided parameters
    for (const [key, value] of Object.entries(parameters)) {
      if (!(key in schema.properties)) {
        // Already handled by the additionalProperties check above.
        // If additionalProperties is not false, skip unknown params.
        continue;
      }

      const propSchema = schema.properties[key] as
        | { readonly type?: string }
        | undefined;
      const expectedType = propSchema?.type;
      if (expectedType === undefined) {
        continue;
      }

      const actualType = typeof value;
      if (expectedType === 'string' && actualType !== 'string') {
        return {
          reason: `Parameter '${key}' must be a string, got ${actualType}.`,
          suggestion: `Provide a string value for '${key}'.`,
        };
      }
      if (expectedType === 'number' && actualType !== 'number') {
        return {
          reason: `Parameter '${key}' must be a number, got ${actualType}.`,
          suggestion: `Provide a number value for '${key}'.`,
        };
      }
      if (expectedType === 'boolean' && actualType !== 'boolean') {
        return {
          reason: `Parameter '${key}' must be a boolean, got ${actualType}.`,
          suggestion: `Provide a boolean value for '${key}'.`,
        };
      }
    }

    return null;
  }

  /**
   * Validates that each input Dataset exists and satisfies the
   * Action's `inputRequirements` (formats, grids, variables) —
   * FM-A2.
   *
   * @returns `{ reason, suggestion? }` if invalid, `null` if valid.
   */
  async #validateInputDatasets(
    inputDatasetIds: readonly DatasetId[],
    action: Action,
  ): Promise<{ reason: string; suggestion?: string } | null> {
    for (const datasetId of inputDatasetIds) {
      const dataset = await this.#dataManagement.queryDataset(datasetId);
      if (dataset === null) {
        return {
          reason: `Input Dataset '${datasetId as string}' does not exist.`,
          suggestion: 'Register the Dataset or use a different input.',
        };
      }

      // Format check
      if (!action.inputRequirements.formats.includes(dataset.format)) {
        return {
          reason: `Input Dataset '${dataset.name}' has format '${dataset.format}', but Action '${action.name}' requires one of: ${action.inputRequirements.formats.join(', ')}.`,
          suggestion:
            'Convert the Dataset to a supported format or use a different Action.',
        };
      }

      // Grid check (by kind)
      const allowedGridKinds = action.inputRequirements.grids.map(
        (g) => g.kind,
      );
      if (!allowedGridKinds.includes(dataset.grid.kind)) {
        return {
          reason: `Input Dataset '${dataset.name}' has grid kind '${dataset.grid.kind}', but Action '${action.name}' requires one of: ${allowedGridKinds.join(', ')}.`,
          suggestion:
            'Remap the Dataset to a supported grid or use a different Action.',
        };
      }

      // Variable check (if the Action requires specific variables)
      if (action.inputRequirements.variables !== undefined) {
        const datasetVarNames = dataset.variables.map((v) => v.name);
        for (const requiredVar of action.inputRequirements.variables) {
          if (!datasetVarNames.includes(requiredVar)) {
            return {
              reason: `Input Dataset '${dataset.name}' does not contain variable '${requiredVar}' (available: ${datasetVarNames.join(', ')}).`,
              suggestion: `Select a Dataset that contains '${requiredVar}'.`,
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Derives a default output Location for a ToolInvocation built
   * from an Action request. The output is placed under the
   * configured `outputBasePath` using the Action name.
   */
  #deriveOutputLocation(actionName: string): Location {
    const basePath = this.#config.outputBasePath.endsWith('/')
      ? this.#config.outputBasePath
      : `${this.#config.outputBasePath}/`;
    return Object.freeze({
      path: `${basePath}${actionName}.nc`,
      filesystem: 'scratch',
    });
  }
}
