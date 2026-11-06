/** Fuzzy subsequence matching for the command palette and pickers. */

export interface FuzzyMatch {
  score: number;
  /** Indexes in the target that matched, for highlighting. */
  indices: number[];
}

/**
 * Score a subsequence match. Higher is better; null when the query does not
 * match at all. Bonuses reward word starts, camelCase humps and consecutive
 * characters, which is what makes `/mem` find "memory" before "message".
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q === t) return { score: 1000, indices: [...Array(target.length).keys()] };
  if (t.startsWith(q)) return { score: 800 - target.length, indices: [...Array(query.length).keys()] };
  const substring = t.indexOf(q);
  if (substring !== -1) {
    return { score: 600 - substring + (substring === 0 ? 50 : 0), indices: Array.from({ length: query.length }, (_, i) => substring + i) };
  }

  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let consecutive = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found === -1) return null;
    const prevChar = found > 0 ? target[found - 1]! : "";
    const isWordStart = found === 0 || /[\s_\-/.:]/.test(prevChar) || /[a-z]/.test(prevChar) && /[A-Z]/.test(target[found]!);
    if (isWordStart) score += 12;
    if (found === ti) consecutive++;
    else consecutive = 0;
    score += 4 + consecutive * 3;
    indices.push(found);
    ti = found + 1;
  }
  // Prefer shorter targets: they match more tightly.
  score -= Math.max(0, target.length - q.length) * 0.4;
  return { score, indices };
}

export interface Scored<T> {
  item: T;
  score: number;
  indices: number[];
}

/** Filter + rank a list by fuzzy match against a key function. */
export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string, secondary?: (item: T) => string): Scored<T>[] {
  if (!query.trim()) return items.map((item, i) => ({ item, score: -i, indices: [] }));
  const out: Scored<T>[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const primary = fuzzyMatch(query, key(item));
    if (primary) {
      out.push({ item, score: primary.score - i * 0.01, indices: primary.indices });
      continue;
    }
    if (secondary) {
      const second = fuzzyMatch(query, secondary(item));
      if (second) out.push({ item, score: second.score - 300 - i * 0.01, indices: [] });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
