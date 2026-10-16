import {describe, expect, it} from 'vitest';
import {HEATMAP_WEEKS, formatAgo, formatDuration, heatmapCells, sessionStateLabel} from '../../src/core/panel.js';

describe('formatAgo', () => {
    it.each([
        [0, 'just now'], [59, 'just now'], [60, '1 min ago'], [3599, '59 min ago'],
        [3600, '1 h ago'], [86399, '23 h ago'], [86400, '1 day ago'], [3 * 86400, '3 days ago'],
    ])('%d s -> %s', (seconds, expected) => {
        expect(formatAgo(seconds)).toBe(expected);
    });
});

describe('formatDuration', () => {
    it.each([[30, '<1 min'], [300, '5 min'], [3600, '1 h'], [3600 + 1200, '1 h 20 min']])('%d s -> %s', (seconds, expected) => {
        expect(formatDuration(seconds)).toBe(expected);
    });
});

describe('sessionStateLabel', () => {
    it('labels every state', () => {
        expect(['needs-permission', 'waiting', 'working', 'finished', 'idle'].map(s => sessionStateLabel(s as never)))
            .toEqual(['needs permission', 'waiting for you', 'working', 'finished', 'idle']);
    });
});

describe('heatmapCells', () => {
    // 2026-10-16 is a Friday.
    const today = '2026-10-16';

    it('has 26 weeks of Monday-to-Sunday columns ending with this week', () => {
        const columns = heatmapCells(null, today);
        expect(columns).toHaveLength(HEATMAP_WEEKS);
        expect(columns.every(column => column.length === 7)).toBe(true);
        const last = columns[HEATMAP_WEEKS - 1];
        expect(last[0].day).toBe('2026-10-12');
        expect(last[4]).toMatchObject({day: '2026-10-16', inRange: true});
        expect(last[5]).toMatchObject({day: '2026-10-17', inRange: false});
        expect(columns[0][0].day).toBe('2026-04-20');
    });

    it('splits days with usage into quartiles', () => {
        const history = [1, 2, 3, 4, 5, 6, 7, 8].map((fresh, i) => ({day: `2026-10-0${i + 1}`, fresh}));
        const levels = new Map(heatmapCells({today: null, history}, today).flat().map(cell => [cell.day, cell.level]));
        expect(['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-08', '2026-09-30'].map(day => levels.get(day)))
            .toEqual([1, 2, 3, 4, 0]);
    });

    it('gives a single day with usage a visible level', () => {
        const cells = heatmapCells({today: null, history: [{day: today, fresh: 5}]}, today).flat();
        expect(cells.find(cell => cell.day === today)?.level).toBeGreaterThan(0);
    });
});
