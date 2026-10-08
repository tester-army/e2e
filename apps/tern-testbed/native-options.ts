import type { SwayOptions } from '@e2e-dev/sway';
export function nativeOptions(): SwayOptions {
  const binary = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Native proof requires an explicit ${name}`);
    return value;
  };
  return { binaries: { sway: binary('E2E_SWAY_BINARY'), swaymsg: binary('E2E_SWAYMSG_BINARY'), grim: binary('E2E_GRIM_BINARY'), tern: binary('E2E_TERN_BINARY'), input: binary('E2E_INPUT_BINARY') } };
}
