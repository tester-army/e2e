import { ternEngine } from '@e2e-dev/tern';
import { hyprland, type HyprlandOptions } from '@e2e-dev/hyprland';
import type { SwayOptions } from '@e2e-dev/sway';

export function nativeEngine(
  host: HyprlandOptions['host'],
  binaries: SwayOptions['binaries'],
  protectedOutputs: readonly string[],
) {
  return ternEngine({
    provider: hyprland({
      host,
      protectedOutputs,
      protectedWorkspaces: [1, 2, 8],
      sway: { binaries, size: { width: 1280, height: 900 } },
    }),
  });
}
