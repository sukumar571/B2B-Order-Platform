import { describe, it, expect } from 'vitest';
import { totalPages, pageSummary } from '../utils/pagination.js';

/**
 * The API meta carries only {page, limit, total}; the page count is derived
 * here. (Regression guard: reading meta.totalPages produced "Page 1 of NaN".)
 */
describe('pagination helpers', () => {
  it('derives the page count from total and limit', () => {
    expect(totalPages({ page: 1, limit: 12, total: 55 })).toBe(5);
    expect(totalPages({ page: 1, limit: 12, total: 12 })).toBe(1);
    expect(totalPages({ page: 1, limit: 20, total: 21 })).toBe(2);
  });

  it('never yields NaN/0 for empty or missing meta', () => {
    expect(totalPages(undefined)).toBe(1);
    expect(totalPages({ page: 1, limit: 12, total: 0 })).toBe(1);
    expect(totalPages({ page: 1, limit: 0, total: 5 })).toBe(1);
  });

  it('builds a human summary with correct singular/plural', () => {
    expect(pageSummary({ page: 2, limit: 12, total: 55 }, 'product', 'products')).toBe(
      'Page 2 of 5 · 55 products'
    );
    expect(pageSummary({ page: 1, limit: 12, total: 1 }, 'product', 'products')).toBe(
      'Page 1 of 1 · 1 product'
    );
    expect(pageSummary({ page: 1, limit: 12, total: 0 }, 'product', 'products')).toBe(
      'Page 1 of 1 · 0 products'
    );
  });
});
