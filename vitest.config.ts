// SPDX-License-Identifier: GPL-2.0-or-later
import {defineConfig} from 'vitest/config';

// Unit tests of the pure core (Node, no GNOME needed). Coverage gates apply to src/core only:
// the daemon, services and UI run in GJS and are covered by the integration tests.
export default defineConfig({
    test: {
        include: ['tests/core/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/core/**/*.ts'],
            exclude: ['src/core/dbus.ts'], // Constants and an XML string.
            reporter: ['text-summary', 'json-summary', 'lcov'],
            thresholds: {lines: 95, statements: 95, functions: 95, branches: 90},
        },
    },
});
