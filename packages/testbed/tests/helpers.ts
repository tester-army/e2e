import type { Locator, Point } from 'e2e';

type Box = { x: number; y: number; width: number; height: number };

/** The error `act` threw or rejected with, undefined when it passed. */
export async function failure(act: () => unknown): Promise<unknown> {
  try {
    await act();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The box a node paints, for pointer maths; a node without one is a test bug, not a pointer case. */
export async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('node has no box');
  return box;
}

/** The center of a box, the point a finger would aim for. */
export function centerOf(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
