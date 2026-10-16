// SPDX-License-Identifier: GPL-2.0-or-later
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {ignores: ['dist/', 'node_modules/', 'coverage/']},
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        // The product code gets the strict, type-aware rules: it runs inside GNOME Shell, where
        // an unnoticed undefined or a swallowed promise can take the session down.
        files: ['src/**/*.ts'],
        extends: [...tseslint.configs.strictTypeChecked],
        languageOptions: {parserOptions: {projectService: true, tsconfigRootDir: import.meta.dirname}},
        rules: {
            // Numbers and booleans in template strings are fine; null, undefined and objects are not.
            '@typescript-eslint/restrict-template-expressions': ['error', {allowNumber: true, allowBoolean: true}],
            // Callbacks like `() => this.refresh()` are idiomatic in GJS signal handlers.
            '@typescript-eslint/no-confusing-void-expression': ['error', {ignoreArrowShorthand: true}],
        },
    },
    {
        // GNOME Shell 50 still calls fillPreferencesWindow with an Adw.PreferencesWindow.
        files: ['src/prefs.ts'],
        rules: {'@typescript-eslint/no-deprecated': 'off'},
    },
    {
        // Development tools run under Node, not GJS.
        files: ['scripts/**/*.mjs'],
        languageOptions: {globals: {console: 'readonly', process: 'readonly'}},
    },
    {
        files: ['tests/gjs/**/*.js', 'tests/integration/client.js'],
        languageOptions: {globals: {print: 'readonly', printerr: 'readonly'}},
    },
);
