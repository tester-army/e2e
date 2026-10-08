import { sway, swayDisplay, type SwayOptions } from '../../src/index.ts';
const options = { binaries: { sway: '/usr/bin/sway', swaymsg: '/usr/bin/swaymsg', tern: '/opt/tern/tern', grim: '/usr/bin/grim', input: '/opt/e2e/input' } } satisfies SwayOptions;
sway(options);
void swayDisplay;
// @ts-expect-error native input is explicit, never a host keyboard default
sway({ binaries: { sway: '/usr/bin/sway', swaymsg: '/usr/bin/swaymsg', tern: '/opt/tern/tern', grim: '/usr/bin/grim' } });
