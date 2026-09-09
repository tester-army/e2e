import type { NextConfig } from 'next';

/** Next 16 for the same reason as the testbed's bench app: TypeScript 7 drives its build. */
const nextConfig: NextConfig = {
  // `next dev` would otherwise write an AGENTS.md and CLAUDE.md into this
  // directory; the repository keeps one AGENTS.md at the root.
  agentRules: false,
};

export default nextConfig;
