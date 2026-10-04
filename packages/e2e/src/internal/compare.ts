/** String ordering, kept free of imports so `e2e init` can use it without loading globs. */

/** Sorts strings by Unicode code point, the order collection is defined in. */
export function compareCodePoints(a: string, b: string): number {
  const aPoints = [...a];
  const bPoints = [...b];
  const length = Math.min(aPoints.length, bPoints.length);
  for (let i = 0; i < length; i += 1) {
    const diff = aPoints[i]!.codePointAt(0)! - bPoints[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return aPoints.length - bPoints.length;
}
