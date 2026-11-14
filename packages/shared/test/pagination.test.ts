import { describe, expect, it } from 'vitest';
import { buildQuery, pageCount, parsePage, parsePageSize } from '../src/pagination';

describe('buildQuery', () => {
  it('returns the bare path without parameters', () => {
    expect(buildQuery('/admin/orders', {})).toBe('/admin/orders');
  });

  it('drops empty values and keeps the rest', () => {
    expect(buildQuery('/x', { q: 'abc', status: undefined, m: '', n: null, f: false })).toBe(
      '/x?q=abc',
    );
  });

  it('applies overrides and lets them remove keys', () => {
    expect(buildQuery('/x', { q: 'a', page: '3' }, { page: undefined })).toBe('/x?q=a');
    expect(buildQuery('/x', { q: 'a' }, { page: 2 })).toBe('/x?q=a&page=2');
    expect(buildQuery('/x', { q: 'a' }, { q: 'b' })).toBe('/x?q=b');
  });

  it('encodes values and writes booleans as 1', () => {
    expect(buildQuery('/x', { q: 'a b&c', overdue: true })).toBe('/x?q=a+b%26c&overdue=1');
  });
});

describe('parsePage / parsePageSize / pageCount', () => {
  it('falls back to page 1', () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage('0')).toBe(1);
    expect(parsePage('-4')).toBe(1);
    expect(parsePage('abc')).toBe(1);
    expect(parsePage('7')).toBe(7);
  });

  it('only accepts allowed page sizes', () => {
    expect(parsePageSize('50')).toBe(50);
    expect(parsePageSize('7')).toBe(25);
    expect(parsePageSize(undefined)).toBe(25);
    expect(parsePageSize('5', [5, 10], 10)).toBe(5);
  });

  it('counts at least one page', () => {
    expect(pageCount(0, 25)).toBe(1);
    expect(pageCount(25, 25)).toBe(1);
    expect(pageCount(26, 25)).toBe(2);
  });
});
