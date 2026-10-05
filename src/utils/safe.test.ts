import { asFiniteNumber, errorMessage, isRecord } from './safe';

describe('safe helpers',()=>{
  test('recognizes records without accepting arrays or null',()=>{
    expect(isRecord({a:1})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });
  test('normalizes finite numbers and unknown errors',()=>{
    expect(asFiniteNumber('12.5')).toBe(12.5);
    expect(asFiniteNumber('nope')).toBeNull();
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('boom')).toBe('boom');
  });
});
