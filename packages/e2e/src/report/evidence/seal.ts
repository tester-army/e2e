/**
 * Seals a live `.evidence` directory into its zip and validates the zip,
 * through `@testmuai/evidence-cli`: the format's own library decides what a
 * valid pack is, so the reporter never re-implements its rules.
 */


/** One validator finding, as the library reports it. */
export interface PackDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly location: string;
  readonly message: string;
}

export interface SealOutcome {
  /** The zip, at the directory's path. */
  readonly sealedPath: string;
  readonly totals: { readonly tests: number; readonly passed: number; readonly failed: number; readonly broken: number; readonly skipped: number };
  readonly valid: boolean;
  readonly diagnostics: readonly PackDiagnostic[];
}

/** Finalizes and seals `dir` (status, totals, definition hashes, failure index), then validates the zip at `profile`. */
export async function sealPack(dir: string, endedAt: string, profile: 'L0' | 'L1'): Promise<SealOutcome> {
  // Loaded on first use: every other CLI command (mcp, login, init) never pays for the zip and schema libraries.
  const { finalize, validate } = await import('@testmuai/evidence-cli');
  const { totals, sealedPath } = await finalize(dir, { endedAt });
  const report = await validate(sealedPath, { profile });
  return {
    sealedPath,
    totals,
    valid: report.valid,
    diagnostics: report.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity === 'error' ? 'error' : 'warning',
      location: diagnostic.location,
      message: diagnostic.message,
    })),
  };
}
