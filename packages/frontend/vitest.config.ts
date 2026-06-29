import { defineConfig } from 'vitest/config';

// Frontend unit tests run in a node environment — current coverage is pure
// logic (i18n translate + key coverage), no DOM. Add jsdom + @testing-library
// here if/when component-render tests are introduced.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
