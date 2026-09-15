/**
 * ToolCatalogService implementation (C1).
 *
 * A simple in-memory registry of Tools (CLITool, PythonTool,
 * ModelTool). Used by agent-interaction (Phase 5) to validate
 * LLM-generated Tool names (R12: refuse and ask if not in catalog).
 *
 * The catalog is the single source of truth for which Tools the
 * Agent can invoke. If the LLM generates a Tool name that is not
 * in the catalog, the Agent refuses and asks the User (R12, ADR-010).
 *
 * Spec: api-contracts.md §6 (ToolCatalogService);
 * module-graph.md §6; resolutions.md R12; failure-modes.md FM-A1.
 */

import type { Tool, ToolId } from '../types';
import type { ToolCatalogService } from './types';

/**
 * A simple in-memory Tool catalog.
 *
 * Tools are stored in a `Map<ToolId, Tool>`. Registration replaces
 * any existing Tool with the same id. The catalog returns frozen
 * arrays to prevent external mutation.
 *
 * Spec: api-contracts.md §6; resolutions.md R12.
 */
export class ToolCatalogServiceImpl implements ToolCatalogService {
  #tools: Map<string, Tool> = new Map();

  /**
   * Returns all registered Tools. The returned array is frozen to
   * prevent external mutation (the catalog is the single source of
   * truth).
   *
   * Spec: api-contracts.md §6; resolutions.md R12.
   */
  async getToolCatalog(): Promise<readonly Tool[]> {
    return Object.freeze(Array.from(this.#tools.values()));
  }

  /**
   * Registers a Tool in the catalog. If a Tool with the same id
   * already exists, it is replaced.
   *
   * Spec: api-contracts.md §6.
   */
  async registerTool(tool: Tool): Promise<void> {
    const idStr = tool.id as string;
    this.#tools.set(idStr, tool);
  }

  /**
   * Queries a single Tool by identity. Returns null if the Tool is
   * not in the catalog (FM-A1).
   *
   * Spec: api-contracts.md §6; failure-modes.md FM-A1; R12.
   */
  async getTool(toolId: ToolId): Promise<Tool | null> {
    const idStr = toolId as string;
    return this.#tools.get(idStr) ?? null;
  }
}
