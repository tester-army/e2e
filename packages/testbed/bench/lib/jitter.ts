/**
 * Optional response jitter for the bench API. `BENCH_JITTER_MS=2500` makes
 * every mutation answer after a random 200 ms to 2.5 s delay — the shape of a
 * real backend under load, and the one thing a deterministic app cannot
 * teach an agent about: an action whose effect has not arrived yet.
 */
export async function jitter(): Promise<void> {
  const max = Number(process.env['BENCH_JITTER_MS'] ?? 0);
  if (!Number.isFinite(max) || max <= 0) return;
  const delay = 200 + Math.floor(Math.random() * Math.max(0, max - 200));
  await new Promise((resolve) => setTimeout(resolve, delay));
}
