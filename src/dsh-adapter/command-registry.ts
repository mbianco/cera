/**
 * CommandRegistry implementation.
 *
 * Wraps dsh's ctx.commands extension point. This is the ONLY code in
 * cera that calls ctx.commands directly. Domain modules use the
 * CommandRegistry interface instead.
 *
 * HumanCommand and DshRawHumanCommand have the same shape — the
 * indirection ensures that if dsh's command registration API changes,
 * only this module and context.ts need updating (ADR-005).
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */

import type { DshContext } from './context';
import { translateDshError } from './internal';
import type { CommandRegistry, HumanCommand } from './types';

export class CommandRegistryImpl implements CommandRegistry {
  #ctx: DshContext;
  constructor(ctx: DshContext) {
    this.#ctx = ctx;
  }

  async register(command: HumanCommand): Promise<void> {
    try {
      await this.#ctx.commands.register({
        name: command.name,
        description: command.description,
        usage: command.usage,
        handler: command.handler,
      });
    } catch (error) {
      translateDshError(error, 'ctx.commands', 'register');
    }
  }

  async list(): Promise<HumanCommand[]> {
    try {
      const raw = await this.#ctx.commands.list();
      return raw.map((c) => ({
        name: c.name,
        description: c.description,
        usage: c.usage,
        handler: c.handler,
      }));
    } catch (error) {
      translateDshError(error, 'ctx.commands', 'list');
    }
  }
}
