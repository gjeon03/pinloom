import { describe, it, expect } from 'vitest';
import { detectSystemLocale } from './uiConfig.js';

describe('detectSystemLocale (first-run system-language default)', () => {
  it('Korean system → ko', () => {
    expect(detectSystemLocale('ko')).toBe('ko');
    expect(detectSystemLocale('ko-KR')).toBe('ko');
    expect(detectSystemLocale('KO-kr')).toBe('ko');
  });

  it('any other language → en', () => {
    expect(detectSystemLocale('en-US')).toBe('en');
    expect(detectSystemLocale('ja')).toBe('en');
    expect(detectSystemLocale('fr-FR')).toBe('en');
  });

  it('missing/undefined → en', () => {
    expect(detectSystemLocale(undefined)).toBe('en');
    expect(detectSystemLocale('')).toBe('en');
  });
});
