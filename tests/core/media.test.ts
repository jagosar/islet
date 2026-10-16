import {describe, expect, it} from 'vitest';
import {activePlayer, readMetadata, readStatus, trackKey, trackLine, type MediaPlayer} from '../../src/core/media.js';

const player = (busName: string, status: MediaPlayer['status'], changedAt: number, title = 'Song'): MediaPlayer => ({
    busName, status, title, artist: 'Band', artUrl: '', canGoNext: true, canGoPrevious: true, canPlayPause: true, changedAt,
});

describe('readMetadata', () => {
    it('reads title, joined artists and a local cover', () => {
        expect(readMetadata({
            'xesam:title': ' Teardrop ',
            'xesam:artist': ['Massive Attack', 'Elizabeth Fraser'],
            'mpris:artUrl': 'file:///tmp/cover.jpg',
            'mpris:length': 123,
        })).toEqual({title: 'Teardrop', artist: 'Massive Attack, Elizabeth Fraser', artUrl: 'file:///tmp/cover.jpg'});
    });

    it('drops remote covers and tolerates missing or odd fields', () => {
        expect(readMetadata({'mpris:artUrl': 'https://i.scdn.co/image/x', 'xesam:artist': 'Solo', 'xesam:title': 3}))
            .toEqual({title: '', artist: 'Solo', artUrl: ''});
    });
});

describe('readStatus', () => {
    it.each([['Playing', 'Playing'], ['Paused', 'Paused'], ['Stopped', 'Stopped'], [undefined, 'Stopped'], ['weird', 'Stopped']])(
        '%s -> %s', (value, expected) => {
            expect(readStatus(value)).toBe(expected);
        });
});

describe('activePlayer', () => {
    it('prefers a playing player over a more recent paused one', () => {
        expect(activePlayer([player('a', 'Playing', 1), player('b', 'Paused', 9)])?.busName).toBe('a');
    });

    it('takes the most recent of several playing players', () => {
        expect(activePlayer([player('a', 'Playing', 1), player('b', 'Playing', 2)])?.busName).toBe('b');
    });

    it('falls back to the most recently changed player with a track', () => {
        expect(activePlayer([player('a', 'Paused', 5), player('b', 'Stopped', 7), player('c', 'Paused', 9, '')])?.busName).toBe('b');
    });

    it('is null without tracks', () => {
        expect(activePlayer([player('a', 'Playing', 1, '')])).toBeNull();
        expect(activePlayer([])).toBeNull();
    });
});

describe('trackLine and trackKey', () => {
    it('joins title and artist', () => {
        expect(trackLine(player('a', 'Playing', 1))).toBe('Song — Band');
        expect(trackLine({...player('a', 'Playing', 1), artist: ''})).toBe('Song');
    });

    it('changes the key only when the track changes', () => {
        const p = player('a', 'Playing', 1);
        expect(trackKey({...p, status: 'Paused', changedAt: 5})).toBe(trackKey(p));
        expect(trackKey({...p, title: 'Other'})).not.toBe(trackKey(p));
        expect(trackKey(null)).toBe('');
    });
});
