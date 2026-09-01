import type { NextConfig } from 'next';

/**
 * Bench app config. Next 16, not 15: the workspace standardizes TypeScript 7
 * (tsgo), whose JS compiler API Next 15 cannot drive — its build hard-fails
 * on TS7 and points at >=16.2.11. The app is deliberately boring:
 * no images, no rewrites, no experiments — determinism is the whole point.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
