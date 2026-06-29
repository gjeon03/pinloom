import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

// Guards the "renders a raw i18n key" bug class in CI: every static t('…')
// literal used in the app must be defined in strings.ts. Reuses the standalone
// script so there is one source of truth for the check.
describe('i18n key coverage', () => {
  it('every static t() literal key is defined in strings.ts', () => {
    expect(() =>
      execSync('node scripts/check-i18n-keys.mjs', { cwd: process.cwd(), stdio: 'pipe' }),
    ).not.toThrow();
  });
});
