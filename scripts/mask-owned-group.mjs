/** Exact detached POSIX groups; never signal a cached PGID after its anchor exited. */
import { setTimeout as delay } from 'node:timers/promises';

export function groupAbsent(pgid) {
  try { process.kill(-pgid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}

/** Kill while the actual returned ChildProcess still anchors the owned group,
 * then confirm absence even after its leader exited. An uncertain/reused group
 * is a failure; it is never an excuse to signal the old number again. */
export async function closeAnchoredGroup(owner, milliseconds = 1_000) {
  if (!owner?.pid || owner.pid <= 1 || owner.pid === process.pid) throw new Error('invalid owned group anchor');
  const anchorWasAlive = owner.exitCode === null && owner.signalCode === null;
  let killedWhileAnchored = false;
  if (anchorWasAlive) {
    try { process.kill(-owner.pid, 'SIGKILL'); killedWhileAnchored = true; }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + milliseconds;
  while (!groupAbsent(owner.pid)) {
    if (Date.now() >= deadline) throw new Error('owned group absence was not confirmed');
    await delay(20);
  }
  return { anchorWasAlive, killedWhileAnchored, groupAbsent: true };
}
