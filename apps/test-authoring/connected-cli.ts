import { parseArgs } from 'node:util';
import { gradeConnected, prepareConnected, sealBaseline, summarizeConnected, superviseConnectedCell, validateCalibration, verifyConnectedBank } from './connected-study.ts';
import { encode } from './files.ts';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, settings: { type: 'string' }, experiment: { type: 'string' }, run: { type: 'string' }, submission: { type: 'string' }, reviews: { type: 'string' }, 'ai-reviews': { type: 'string' }, 'design-review': { type: 'string' }, project: { type: 'string' }, 'deadline-ms': { type: 'string' } } });
  const accepted: Record<string, string[]> = { prepare: ['out', 'settings'], 'verify-bank': ['experiment'], 'validate-calibration': ['experiment', 'run', 'submission'], 'seal-baseline': ['experiment'], grade: ['experiment', 'run', 'submission'], summarize: ['experiment', 'reviews', 'ai-reviews', 'design-review'], 'supervise-cell': ['project', 'deadline-ms'] };
  const action = positionals[0];
  if (!action || positionals.length !== 1 || !accepted[action] || Object.keys(values).some(key => !accepted[action]!.includes(key))) throw new Error('Use connected prepare --out --settings, verify-bank --experiment, validate-calibration --experiment --run --submission, seal-baseline --experiment, grade --experiment --run [--submission], or summarize --experiment [--reviews] [--ai-reviews] [--design-review]');
  const required = (name: 'out' | 'settings' | 'experiment' | 'run' | 'submission' | 'project'): string => {
    const value = values[name];
    if (!value) throw new Error(`Missing --${name}`);
    return value;
  };
  switch (action) {
    case 'prepare': {
      const bank = await prepareConnected(required('out'), required('settings'));
      process.stdout.write(`Prepared connected v3 bank. ${bank.calibration.length} calibration identities and ${bank.prospectiveBaseline.length} prospective baseline slots. Verified ${bank.controlLaunches} control launches. No authoring model was run.\n`);
      break;
    }
    case 'verify-bank': process.stdout.write(encode(verifyConnectedBank(required('experiment')))); break;
    case 'validate-calibration': {
      const result = validateCalibration(required('experiment'), required('run'), required('submission'));
      process.stdout.write(encode(result));
      if (!result.valid) process.exitCode = 1;
      break;
    }
    case 'seal-baseline': process.stdout.write(encode(sealBaseline(required('experiment')))); break;
    case 'grade': process.stdout.write(encode(gradeConnected(required('experiment'), required('run'), values.submission))); break;
    case 'summarize': process.stdout.write(summarizeConnected(required('experiment'), values.reviews, values['ai-reviews'], values['design-review']).markdown); break;
    case 'supervise-cell': {
      const result = await superviseConnectedCell(required('project'), values['deadline-ms'] ? Number(values['deadline-ms']) : 240000);
      process.stdout.write(encode(result));
      process.exitCode = result.timedOut || result.error || result.cleanup.natural !== 'passed' || result.cleanup.finalizer !== 'passed' ? 2 : result.exitCode ?? 2;
      break;
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
