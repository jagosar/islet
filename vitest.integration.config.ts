// SPDX-License-Identifier: GPL-2.0-or-later
import {defineConfig} from 'vitest/config';

// Integration and package tests: real gjs processes on a private D-Bus session. They use the
// built output, so run `npm run build` first (`npm run test:integration` does).
export default defineConfig({
    test: {
        include: ['tests/integration/**/*.test.ts', 'tests/package/**/*.test.ts'],
        testTimeout: 60_000,
        hookTimeout: 60_000,
        fileParallelism: false,
        retry: 0,
    },
});
