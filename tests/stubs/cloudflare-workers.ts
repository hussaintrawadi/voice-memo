/** Stand-in for the Workers runtime module, so route and pipeline code can be imported in tests. */
export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
  // Params is part of the real signature; keep it referenced for type parity.
  declare protected __params?: Params;
}
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}
