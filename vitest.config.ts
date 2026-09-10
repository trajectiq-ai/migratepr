import { defineConfig } from 'vitest/config';

// The demo repo under examples/ runs jest with its own config — keep vitest scoped
// to this tool's unit tests so the two never collide.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
