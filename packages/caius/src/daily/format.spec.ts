import { describe, expect, it } from 'vitest';
import { formatEstimate, formatHours } from './format.js';

describe('formatEstimate', () => {
  it('writes minutes as an estimate token', () => {
    expect([30, 60, 90, 125, 0].map(formatEstimate)).toEqual(['30m', '1h', '1h30m', '2h5m', '0m']);
  });
});

describe('formatHours', () => {
  it('writes minutes as hours and minutes', () => {
    expect([200, 210, 60, 45, 0].map(formatHours)).toEqual(['3 h 20 m', '3 h 30 m', '1 h', '45 m', '0 m']);
  });
});
