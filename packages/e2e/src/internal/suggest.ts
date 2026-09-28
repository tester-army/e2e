/**
 * "Did you mean" for diagnostics. A misspelled key, target, file, or fixture
 * is the most common shape of a configuration error, and naming the nearest
 * valid choice turns a dead end into a one-word fix.
 */

/**
 * The candidate closest to `word` by edit distance, when one is close enough
 * to be a plausible typo: within one edit for short words, and within a third
 * of the word's length otherwise. Comparison ignores case; ties keep candidate
 * order. Returns undefined when nothing is close, or when the word already
 * matches a candidate exactly.
 */
export function suggest(word: string, candidates: readonly string[]): string | undefined {
  if (candidates.includes(word)) return undefined;
  const needle = word.toLowerCase();
  const budget = typoBudget(word);
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    // A case-only difference is distance 0 here and still a fix worth naming.
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance > budget) continue;
    if (best === undefined || distance < best.distance) best = { candidate, distance };
  }
  return best?.candidate;
}

/** Whether `candidate` is close enough to `word` to be a typo of it, by the budget `suggest` uses. Ignores case. */
export function isTypoOf(word: string, candidate: string): boolean {
  return editDistance(word.toLowerCase(), candidate.toLowerCase()) <= typoBudget(word);
}

/** The edits a typo may take: one for short words, a third of the length otherwise. */
function typoBudget(word: string): number {
  return Math.max(1, Math.floor(word.length / 3));
}

/** `; did you mean "x"?` for a message tail, or the empty string. */
export function didYouMean(word: string, candidates: readonly string[]): string {
  const match = suggest(word, candidates);
  return match === undefined ? '' : `; did you mean "${match}"?`;
}

/** ` (did you mean x?)` for a note right after the word in a list, or the empty string. */
export function suggestionNote(word: string, candidates: readonly string[]): string {
  const match = suggest(word, candidates);
  return match === undefined ? '' : ` (did you mean ${match}?)`;
}

/** Damerau-Levenshtein distance with adjacent transpositions, the edits typos are made of. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) {
    rows.push(Array.from({ length: b.length + 1 }, () => 0));
    rows[i]![0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      }
      rows[i]![j] = value;
    }
  }
  return rows[a.length]![b.length]!;
}
