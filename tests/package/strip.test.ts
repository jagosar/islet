// SPDX-License-Identifier: GPL-2.0-or-later
import {describe, expect, it} from 'vitest';
// @ts-expect-error The script is plain JavaScript.
import {stripDevOnly} from '../../scripts/strip-dev.mjs';

const strip = stripDevOnly as (source: string, name?: string) => string;

describe('stripDevOnly', () => {
    it('removes marked regions, markers included, and keeps everything else', () => {
        const source = ['a();', '// DEV-ONLY-BEGIN', 'secret();', '// DEV-ONLY-END', 'b();'].join('\n');
        expect(strip(source)).toBe('a();\nb();');
    });

    it('handles several regions and indented markers', () => {
        const source = ['class A {', '    // DEV-ONLY-BEGIN (why)', '    x = 1;', '    // DEV-ONLY-END', '    y = 2;', '    // DEV-ONLY-BEGIN', '    z();', '    // DEV-ONLY-END', '}'].join('\n');
        expect(strip(source)).toBe('class A {\n    y = 2;\n}');
    });

    it('leaves a file without markers byte for byte', () => {
        const source = 'const a = 1;\n// DEV-ONLY is only a word here\n';
        expect(strip(source)).toBe(source);
    });

    it.each([
        ['an unterminated region', '// DEV-ONLY-BEGIN\nx();', /without DEV-ONLY-END/],
        ['an end without a begin', 'x();\n// DEV-ONLY-END', /without DEV-ONLY-BEGIN/],
        ['nested regions', '// DEV-ONLY-BEGIN\n// DEV-ONLY-BEGIN\n// DEV-ONLY-END', /inside another/],
    ])('refuses %s, so a damaged marker cannot ship half a hook', (_name, source, message) => {
        expect(() => strip(source, 'file.js')).toThrow(message);
    });
});
