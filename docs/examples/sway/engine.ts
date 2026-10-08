import { ternEngine } from '@e2e-dev/tern';
import { sway } from '@e2e-dev/sway';
export const engine = ternEngine({ provider: sway({ binaries: {
  sway: '/usr/bin/sway', swaymsg: '/usr/bin/swaymsg', grim: '/usr/bin/grim',
  tern: '/opt/tern/tern', input: '/opt/e2e/input',
} }) });
