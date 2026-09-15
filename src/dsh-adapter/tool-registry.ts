/**
 * ToolRegistry implementation.
 *
 * Wraps dsh's ctx.tools extension point. This is the ONLY code in cera
 * that calls ctx.tools directly. Domain modules use the ToolRegistry
 * interface instead.
 *
 * ToolCapability and DshRawToolCapability have the same shape — the
 * indirection ensures that if dsh's tool registration API changes,
 * only this module and context.ts need updating (ADR-005).
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1;
 * resolutions.md R3.
 */

import type { DshContext } from './context';
import { translateDshError } from './internal';
import type { ToolCapability, ToolRegistry } from './types';

export class ToolRegistryImpl implements ToolRegistry {
  #ctx: DshContext;
  constructor(ctx: DshContext) {
    this.#ctx = ctx;
  }

  async register(capability: ToolCapability): Promise<void> {
    try {
      await this.#ctx.tools.register({
        name: capability.name,
        description: capability.description,
        parameters: capability.parameters,
        handler: capability.handler,
      });
    } catch (error) {
      translateDshError(error, 'ctx.tools', 'register');
    }
  }

  async list(): Promise<ToolCapability[]> {
    try {
      const raw = await this.#ctx.tools.list();
      return raw.map((c) => ({
        name: c.name,
        description: c.description,
        parameters: c.parameters,
        handler: c.handler,
      }));
    } catch (error) {
      translateDshError(error, 'ctx.tools', 'list');
    }
  }
}
