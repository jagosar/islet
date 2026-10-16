// SPDX-License-Identifier: GPL-2.0-or-later
// Regression test for the focus history's kept days around a time change. It must run with
// TZ=Europe/Berlin (npm run test:gjs does): at 00:30 on 2026-03-30, the day after the clocks
// went forward, subtracting 86,400 seconds per day skipped 2026-03-29 and the history pruning
// deleted that day's focus minutes.
import System from 'system';

import {keptDays} from '../../dist/services/focusController.js';

const kept = keptDays(Date.UTC(2026, 2, 29, 22, 30) / 1000); // 00:30 on the 30th, Berlin time.
const expected = ['2026-03-30', '2026-03-29', '2026-03-28', '2026-03-27', '2026-03-26', '2026-03-25', '2026-03-24'];

if (JSON.stringify(kept) === JSON.stringify(expected)) {
    print('ok   the kept days have no gap around the spring time change');
} else {
    printerr(`FAIL kept days: ${kept.join(' ')}`);
    System.exit(1);
}
