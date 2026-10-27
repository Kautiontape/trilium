import { describe, expect, it } from 'vitest';
import { layoutWork } from './blocks.js';

const day = { start: '10:00', end: '23:00', workEnd: '18:00' };

describe('layoutWork', () => {
  it('lays the tasks out in order in the gaps between meetings, the first one as the focus block', () => {
    const { work, unplaced } = layoutWork(day, [{ start: '10:00', end: '10:15' }, { start: '12:00', end: '13:00' }], [
      { label: 'ZAP-1', minutes: 60 },
      { label: 'Review', minutes: 90 },
      { label: 'Tests', minutes: 30 },
    ]);
    expect(work).toEqual([
      { start: '10:15', end: '11:15', label: 'ZAP-1', focus: true },
      { start: '11:15', end: '12:00', label: 'Review' },
      { start: '13:00', end: '13:45', label: 'Review' },
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
      { start: '18:45', end: '19:00', label: 'Big' },
    ]);
    expect(unplaced).toEqual([{ label: 'Big', minutes: 600 - 420 - 15 }]);
  });
});
