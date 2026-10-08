import { attachedTern, ternEngine } from "@e2e-dev/tern";
export const engine = ternEngine({ provider: attachedTern({
  id: "isolated-controls", mode: "native", binary: "/path/to/tern",
  control: "/private/run/control.sock", pane: "1", env: { PATH: "/usr/bin:/bin" },
}) });
