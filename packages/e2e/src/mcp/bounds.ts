/**
 * How many sessions `e2e mcp --max-sessions` allows at once, each a browser or
 * a device. Apart from the server so the CLI defines the flag without loading it.
 */
export const SESSION_BOUNDS = { min: 1, max: 16, default: 4 } as const;
