/** Stand-in for the Workers runtime module, so route and pipeline code can be imported in tests. */
export class NonRetryableError extends Error {}
