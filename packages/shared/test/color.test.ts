import { describe, expect, it } from 'vitest';
import {
  DARK_SURFACE_HEX,
  WCAG_AA_TEXT,
  brandTokens,
  contrastRatio,
  darkVariant,
  foregroundOn,
} from '../src';

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // #767676 on white is the well-known AA boundary (4.54:1).
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#ffffff', '#767676')).toBeCloseTo(4.54, 2);
  });
});

describe('foregroundOn', () => {
  it('picks white on dark and near-black on light colours', () => {
    expect(foregroundOn('#111827')).toBe('#ffffff');
    expect(foregroundOn('#FACC15')).toBe('#0a0a0a');
    expect(foregroundOn('#DC2626')).toBe('#ffffff');
  });
});

describe('darkVariant', () => {
  it('leaves a colour that is already readable on dark surfaces untouched', () => {
    expect(darkVariant('#60A5FA')).toBe('#60A5FA');
  });

  it('raises the lightness of dark colours until AA contrast is reached', () => {
    for (const brand of ['#111827', '#1E3A8A', '#7F1D1D', '#000000', '#3B0764']) {
      const v = darkVariant(brand);
      expect(contrastRatio(v, DARK_SURFACE_HEX), brand).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    }
  });

  it('keeps the hue (stays blue-ish) and is a valid hex colour', () => {
    const v = darkVariant('#1E3A8A');
    expect(v).toMatch(/^#[0-9A-F]{6}$/);
    const r = parseInt(v.slice(1, 3), 16);
    const b = parseInt(v.slice(5, 7), 16);
    expect(b).toBeGreaterThan(r);
  });

  it('is minimal: the result is not much lighter than needed', () => {
    const v = darkVariant('#1E3A8A');
    expect(contrastRatio(v, DARK_SURFACE_HEX)).toBeLessThan(5.5);
  });
});

describe('brandTokens', () => {
  it('computes both themes, readable button text and flags poor light contrast', () => {
    const t = brandTokens('#111827');
    expect(t.light.primary).toBe('#111827');
    expect(t.light.foreground).toBe('#ffffff');
    expect(t.lightTextOk).toBe(true);
    expect(t.darkComputed).toBe(true);
    expect(t.dark.textContrast).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    expect(brandTokens('#FACC15').lightTextOk).toBe(false);
  });

  it('uses an explicit dark override as is', () => {
    const t = brandTokens('#111827', '#93c5fd');
    expect(t.darkComputed).toBe(false);
    expect(t.dark.primary).toBe('#93C5FD');
    expect(t.dark.foreground).toBe('#0a0a0a');
  });

  it('falls back safely for garbage input', () => {
    expect(brandTokens('nope').light.primary).toBe('#111827');
  });
});
