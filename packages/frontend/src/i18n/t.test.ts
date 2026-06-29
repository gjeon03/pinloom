import { describe, it, expect } from 'vitest';
import { translate } from './t.js';

describe('translate', () => {
  it('returns the locale value for a known key', () => {
    expect(translate('ko', 'settings.title')).toBe('설정');
    expect(translate('en', 'settings.title')).toBe('Settings');
  });

  it('keeps proper nouns identical across locales', () => {
    expect(translate('ko', 'feature.teams')).toBe('Teams');
    expect(translate('en', 'feature.teams')).toBe('Teams');
  });

  it('falls back to the key itself when undefined (never blank)', () => {
    expect(translate('en', 'does.not.exist')).toBe('does.not.exist');
    expect(translate('ko', 'does.not.exist')).toBe('does.not.exist');
  });

  it('interpolates {vars}', () => {
    expect(translate('en', 'settings.fixed', { value: 'opus' })).toBe('Fixed: opus');
    expect(translate('ko', 'settings.fixed', { value: 'opus' })).toBe('고정: opus');
  });

  it('leaves an unprovided var as literal braces (visible, not crashing)', () => {
    expect(translate('en', 'settings.fixed', {})).toBe('Fixed: {value}');
  });
});
