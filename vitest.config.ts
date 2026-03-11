import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['packages/**/*.test.ts', 'services/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['packages/*/src/**', 'services/*/src/**'],
            exclude: ['**/index.ts', '**/*.test.ts'],
        },
    },
});
