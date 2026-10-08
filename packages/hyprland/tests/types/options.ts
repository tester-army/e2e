import { hyprland, type HyprlandOptions } from '@e2e-dev/hyprland';
const options: HyprlandOptions={host:{instance:'exact-instance',runtimeDir:'/owned/runtime',waylandDisplay:'wayland-1',hyprctl:'/usr/bin/hyprctl'},protectedOutputs:['human-a','human-b'],protectedWorkspaces:[1,2,8],sway:{binaries:{sway:'/usr/bin/sway',swaymsg:'/usr/bin/swaymsg',grim:'/usr/bin/grim',tern:'/owned/bin/tern',input:'/owned/bin/input'}}};
hyprland(options);
// @ts-expect-error An explicit parent and protected policy are mandatory.
hyprland({sway:options.sway});
