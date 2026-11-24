import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { decodeZ, merge, parseLapTime, toRaceState, toSession } from './live.ts';

test('parseLapTime handles minutes, seconds and junk', () => {
  assert.equal(parseLapTime('1:36.182'), 96.182);
  assert.equal(parseLapTime('27.995'), 27.995);
  assert.equal(parseLapTime(''), null);
  assert.equal(parseLapTime(undefined), null);
  assert.equal(parseLapTime('+1 LAP'), null);
});

test('merge patches nested objects and index-keyed arrays', () => {
  const state = { Lines: { '1': { Position: '2', Sectors: [{ Value: '28.1' }, { Value: '32.0' }] } } };
  const out = merge(state, { Lines: { '1': { Position: '1', Sectors: { '1': { Value: '31.5' } } } } });
  assert.equal(out.Lines['1'].Position, '1');
  assert.deepEqual(out.Lines['1'].Sectors, [{ Value: '28.1' }, { Value: '31.5' }]);
  // The original is left untouched.
  assert.equal(state.Lines['1'].Position, '2');
});

test('decodeZ inflates the compressed .z topics', () => {
  const payload = { Position: [{ Timestamp: '2026-11-22T04:00:00Z', Entries: { '1': { X: 10, Y: 20, Z: 0 } } }] };
  const encoded = deflateRawSync(Buffer.from(JSON.stringify(payload))).toString('base64');
  assert.deepEqual(decodeZ(encoded), payload);
});

test('toSession converts local start times to UTC', () => {
  const s = toSession({
    Key: 11420,
    Type: 'Race',
    Name: 'Race',
    StartDate: '2026-11-21T20:00:00',
    EndDate: '2026-11-21T22:00:00',
    GmtOffset: '-08:00:00',
    Meeting: { Name: 'Las Vegas Grand Prix', Circuit: { Key: 152, ShortName: 'Las Vegas' }, Country: { Name: 'United States', Code: 'USA' } },
  });
  assert.equal(s?.dateStart, '2026-11-22T04:00:00.000Z');
  assert.equal(s?.circuitKey, 152);
});

test('toRaceState builds sorted rows, tyres, flags and yellow sectors', () => {
  const st = {
    SessionInfo: { Type: 'Race' },
    LapCount: { CurrentLap: 12, TotalLaps: 50 },
    TrackStatus: { Status: '6' },
    TimingData: {
      Lines: {
        '1': { Position: '2', GapToLeader: '+1.200', IntervalToPositionAhead: { Value: '+1.200' }, NumberOfLaps: 12, LastLapTime: { Value: '1:36.500' }, BestLapTime: { Value: '1:36.100' }, NumberOfPitStops: 0 },
        '3': { Position: '1', GapToLeader: 'LAP 12', IntervalToPositionAhead: { Value: '' }, NumberOfLaps: 12, LastLapTime: { Value: '1:36.000' }, BestLapTime: { Value: '1:35.900' }, NumberOfPitStops: 1, InPit: false },
      },
    },
    TimingAppData: {
      Lines: {
        '3': { GridPos: '4', Stints: [{ Compound: 'SOFT', TotalLaps: 8, StartLaps: 0, New: 'true' }, { Compound: 'HARD', TotalLaps: 4, StartLaps: 0, New: 'true' }] },
      },
    },
    RaceControlMessages: {
      Messages: [
        { Utc: '2026-11-22T04:10:00', Category: 'Flag', Flag: 'YELLOW', Scope: 'Sector', Sector: 7, Message: 'YELLOW IN TRACK SECTOR 7' },
        { Utc: '2026-11-22T04:10:05', Category: 'Flag', Flag: 'YELLOW', Scope: 'Sector', Sector: 8, Message: 'YELLOW IN TRACK SECTOR 8' },
        { Utc: '2026-11-22T04:11:00', Category: 'Flag', Flag: 'CLEAR', Scope: 'Sector', Sector: 7, Message: 'CLEAR IN TRACK SECTOR 7' },
      ],
    },
  };
  const rs = toRaceState(st, 0);
  assert.deepEqual(rs.rows.map((r) => r.num), ['3', '1']);
  assert.equal(rs.rows[0].gap, 'LEADER');
  assert.equal(rs.rows[1].interval, '+1.200');
  assert.equal(rs.rows[0].compound, 'HARD');
  assert.equal(rs.rows[0].tyreAge, 4);
  assert.equal(rs.stints['3'][1].lapStart, 9);
  assert.equal(rs.trackStatus, 'VSC');
  assert.deepEqual(rs.yellowSectors, [8]);
  assert.deepEqual(rs.fastest, { num: '3', time: 95.9 });
  assert.equal(rs.raceControl[0].message, 'CLEAR IN TRACK SECTOR 7'); // newest first
});
