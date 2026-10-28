import { describe, expect, it } from 'vitest';
import { layoutWork } from './blocks.js';

const day = { start: '10:00', end: '23:00', workEnd: '18:00' };

describe('layoutWork', () => {
  it('lays the tasks out in order in the gaps between meetings, the first one as the focus block, labelling a split task once', () => {
    const { work, unplaced } = layoutWork(day, [{ start: '10:00', end: '10:15' }, { start: '12:00', end: '13:00' }], [
      { label: 'ZAP-1', minutes: 60 },
      { label: 'Review', minutes: 90 },
      { label: 'Tests', minutes: 30 },
    ]);
    expect(work).toEqual([
      { start: '10:15', end: '11:15', label: 'ZAP-1', focus: true },
      { start: '11:15', end: '12:00', label: 'Review' },
      { start: '13:00', end: '13:45', label: '' },
      { start: '13:45', end: '14:15', label: 'Tests' },
    ]);
    expect(unplaced).toEqual([]);
  });

  it('starts evening tasks at the end of work, makes the first work task the focus, never draws past bedtime, and names what did not fit', () => {
    const { work, unplaced } = layoutWork({ ...day, end: '19:00' }, [{ start: '09:00', end: '10:30' }], [
      { label: 'Walk', minutes: 45, evening: true },
      { label: 'Spec', minutes: 30 },
      { label: 'Big', minutes: 600 },
    ]);
    expect(work).toEqual([
      { start: '18:00', end: '18:45', label: 'Walk' },
      { start: '10:30', end: '11:00', label: 'Spec', focus: true },
      { start: '11:00', end: '18:00', label: 'Big' },
      { start: '18:45', end: '19:00', label: '' },
    ]);
    expect(unplaced).toEqual([{ label: 'Big', minutes: 600 - 420 - 15 }]);
  });

  it('starts no block before notBefore, and no evening task before it either, and never makes an evening task the focus', () => {
    const { work } = layoutWork({ ...day, notBefore: '11:15' }, [{ start: '10:00', end: '10:30' }, { start: '15:00', end: '15:30' }], [
      { label: 'ZAP-105', minutes: 30 },
      { label: 'Laundry', minutes: 30, evening: true },
    ]);
    expect(work).toEqual([
      { start: '11:15', end: '11:45', label: 'ZAP-105', focus: true },
      { start: '18:00', end: '18:30', label: 'Laundry' },
    ]);
    expect(layoutWork({ ...day, notBefore: '19:00' }, [], [{ label: 'Laundry', minutes: 30, evening: true }]).work)
      .toEqual([{ start: '19:00', end: '19:30', label: 'Laundry' }]);
  });
});
