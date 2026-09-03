/** Never answers: the request a broken backend leaves open forever. */
export const dynamic = 'force-dynamic';

export async function POST() {
  await new Promise(() => undefined);
  return new Response(null);
}
