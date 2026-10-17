import { parseArgs } from 'node:util';
import { controls, grade, prepare, summarize } from './experiment.ts';
import { encode } from './files.ts';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, settings: { type: 'string' }, experiment: { type: 'string' }, run: { type: 'string' }, submission: { type: 'string' }, controls: { type: 'boolean' }, fixture: { type: 'string' }, reviews: { type: 'string' } } });
  const required = (name: 'out' | 'settings' | 'experiment' | 'run' | 'submission') => {
    const value = values[name];
    if (!value) throw new Error(`Missing --${name}`);
    return value;
  };
  switch (positionals[0]) {
    case 'prepare': {
      const plan = await prepare(required('out'), required('settings'));
      process.stdout.write(`Prepared ${plan.runs.length} fresh sessions. No authoring model was run.\n`);
      break;
    }
    case 'grade': process.stdout.write(encode(values.controls ? controls(required('experiment'), values.fixture) : grade(required('experiment'), required('run'), required('submission')))); break;
    case 'summarize': process.stdout.write(summarize(required('experiment'), values.reviews).markdown); break;
    default: throw new Error('Use prepare --out --settings, grade --experiment --run --submission or --controls, or summarize --experiment [--reviews]');
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
