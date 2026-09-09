/**
 * `@e2edev/testerarmy` public surface: the `testerarmy()` reporter factory.
 * The reporter uploads every finished run to TesterArmy — the report-1
 * document and the artifacts it names — through the `reporters` seam of
 * `@e2edev/e2e`, and prints the run's URL under the summary.
 */

export { testerarmy } from './reporter.ts';
export type { TesterArmyOptions } from './reporter.ts';
