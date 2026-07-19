// Everything-style order-independent token matching, shared by the search modal (path search ON)
// and the Drive panel's index search. Non-letter/number chars are stripped before matching, so
// punctuation and separators (`/`, `-`, `_`, `.`, `(`, `)`, space, ...) are treated as equivalent
// ignorable boundaries. The query is split on whitespace into tokens and EACH token must be a
// substring of the stripped haystack; matching is therefore ORDER-INDEPENDENT (".jpg mount" hits
// "mount-….jpg"), unlike an in-order fuzzy subsequence match.
const PATH_SEARCH_SEPARATORS = /[^\p{L}\p{N}]+/gu;

export function normalizePathSearchText(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(PATH_SEARCH_SEPARATORS, "");
}

export function tokenizePathSearchQuery(query: string): string[] {
  return query
    .split(/\s+/)
    .map((token) => normalizePathSearchText(token))
    .filter((token) => token.length > 0);
}

export function matchesAllSearchTokens(tokens: string[], text: string): boolean {
  const haystack = normalizePathSearchText(text);
  return tokens.every((token) => haystack.includes(token));
}
