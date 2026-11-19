// Page search: does an item match what was typed in the top bar? Every word typed must appear in one of
// the item's texts (any case, any order): "kavin box" matches "Kavin Raj · Packaging boxes order".

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/** True when `q` is empty, or every word of it is in one of `texts`. */
export function matchesQuery(q: string, ...texts: (string | null | undefined | false)[]): boolean {
  const ws = words(q);
  if (!ws.length) return true;
  const hay = texts.filter(Boolean).join(" \u0000 ").toLowerCase();
  return ws.every((w) => hay.includes(w));
}

/** True when something was typed (the page is showing matches only). */
export const searching = (q: string) => words(q).length > 0;
