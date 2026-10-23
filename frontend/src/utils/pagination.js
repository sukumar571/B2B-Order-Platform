/**
 * Pagination helpers. The API contract only returns `meta.page`, `meta.limit`
 * and `meta.total` (see docs/api-specification.md), so the page count is
 * derived here rather than duplicated on the server.
 */
export function totalPages(meta) {
  if (!meta) return 1;
  const pages = Math.ceil(Number(meta.total) / Number(meta.limit));
  return Number.isFinite(pages) && pages > 0 ? pages : 1;
}

/** "Page 2 of 5 · 12 products" — one text node, stable for tests/axe. */
export function pageSummary(meta, nounSingular, nounPlural) {
  const count = Number(meta?.total ?? 0);
  const noun = count === 1 ? nounSingular : nounPlural;
  return `Page ${meta?.page ?? 1} of ${totalPages(meta)} · ${count} ${noun}`;
}
