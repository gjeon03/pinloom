// Guard: every static t('…') / t("…") literal key used in the frontend must be
// defined in src/i18n/strings.ts. Catches the "renders a raw key" bug class.
// Dynamic keys built from template literals (t(`feature.${k}`)) are not checked
// statically — their fixed prefixes are whitelisted below. Run: `node scripts/check-i18n-keys.mjs`.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const strings = readFileSync(`${root}src/i18n/strings.ts`, 'utf8');
const defined = new Set([...strings.matchAll(/^\s*"([^"]+)":\s*\{/gm)].map((m) => m[1]));

// Prefixes resolved dynamically (template literals); their members are assumed
// covered by the static defs and exercised at runtime.
const DYNAMIC_PREFIXES = ['feature.', 'settings.group.', 'settings.preset.', 'settings.cat.'];

const files = execSync('grep -rl "i18n/t" src --include=*.tsx --include=*.ts', {
  cwd: root,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);

const missing = [];
for (const f of files) {
  const c = readFileSync(`${root}${f}`, 'utf8');
  for (const m of c.matchAll(/\bt\(\s*['"]([a-zA-Z][\w.]*)['"]/g)) {
    const key = m[1];
    if (!defined.has(key)) missing.push({ key, file: f });
  }
}

if (missing.length) {
  console.error(`✗ ${missing.length} i18n key(s) used but undefined in strings.ts:`);
  for (const { key, file } of missing) console.error(`  ${key}  (${file})`);
  process.exit(1);
}
console.log(`✓ all static t() literal keys are defined (${defined.size} keys, dynamic prefixes: ${DYNAMIC_PREFIXES.join(', ')})`);
