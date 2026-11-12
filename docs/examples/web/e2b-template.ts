import { Template, defaultBuildLogger } from 'e2b';

const template = Template().fromImage('mcr.microsoft.com/playwright:v1.65.0-noble');
await Template.build(template, 'e2e-chromium', {
  cpuCount: 4,
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
});
