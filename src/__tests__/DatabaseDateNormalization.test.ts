import { normalizeDatabaseDate } from '../database/DatabaseService';

describe('normalizeDatabaseDate', () => {
  it('accepts Date values and rejects invalid dates', () => {
    const value = new Date('2026-10-07T15:34:07.003Z');
    expect(normalizeDatabaseDate(value)).toEqual(value);
    expect(normalizeDatabaseDate(new Date('invalid'))).toBeNull();
  });

  it('normalizes Unix timestamps in seconds and milliseconds', () => {
    const expected = new Date('2026-10-07T15:34:07.000Z');
    expect(normalizeDatabaseDate(Math.floor(expected.getTime() / 1000))).toEqual(expected);
    expect(normalizeDatabaseDate(expected.getTime())).toEqual(expected);
    expect(normalizeDatabaseDate(String(Math.floor(expected.getTime() / 1000)))).toEqual(expected);
  });

  it('accepts ISO strings and rejects unsupported values', () => {
    expect(normalizeDatabaseDate('2026-10-07T15:34:07.003Z')).toEqual(new Date('2026-10-07T15:34:07.003Z'));
    expect(normalizeDatabaseDate('')).toBeNull();
    expect(normalizeDatabaseDate(null)).toBeNull();
    expect(normalizeDatabaseDate({})).toBeNull();
  });
});
