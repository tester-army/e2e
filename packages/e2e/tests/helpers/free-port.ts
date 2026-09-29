import { createServer } from 'node:net';

/** A loopback port nothing listens on right now, for an app command's readiness endpoint. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return address.port;
}
