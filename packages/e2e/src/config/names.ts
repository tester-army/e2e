/** TypeScript config file names; two in one directory is ambiguous. */
export const TS_CONFIG_NAMES = ['e2e.config.ts', 'e2e.config.mts'] as const;

/**
 * JavaScript config file names; two in one directory is ambiguous. Discovery
 * reads them only where no TypeScript config exists, since an
 * `e2e.config.js` beside `e2e.config.ts` is usually `tsc` output.
 */
export const JS_CONFIG_NAMES = ['e2e.config.js', 'e2e.config.mjs'] as const;

/** Every config file name discovery reads. */
export const CONFIG_NAMES = [...TS_CONFIG_NAMES, ...JS_CONFIG_NAMES] as const;
