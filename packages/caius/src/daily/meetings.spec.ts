import { describe, expect, it } from 'vitest';
import { meetingLines, overlapPairs, type MeetingEvent } from './meetings.js';

const event = (start: string, end: string, title: string, o: Partial<MeetingEvent> = {}): MeetingEvent => ({
  start, end, title, attendees: [], allDay: false, declined: false, ...o,
});

describe('meetingLines', () => {
  it('writes HH:MM Title with up to four first names, in start order', () => {
    const lines = meetingLines([
      event('14:00', '15:00', 'Review', { attendees: ['Riley Sample'] }),
      event('10:00', '10:15', 'Standup', { attendees: ['Sam Example', 'Riley Sample', 'Jordan Placeholder', 'Alex Doe', 'Casey Roe'] }),
      event('12:00', '12:30', 'Focus'),
    ]);
    expect(lines).toEqual(['10:00 Standup (Sam, Riley, Jordan, Alex)', '12:00 Focus', '14:00 Review (Riley)']);
  });

  it('leaves out declined and all-day events, de-duplicates lines and names, and marks overlaps', () => {
    const lines = meetingLines([
      event('10:00', '10:15', 'Standup', { attendees: ['Sam Example', 'Sam Other'] }),
      event('10:00', '10:15', 'Standup', { attendees: ['Sam Example', 'Sam Other'] }),
      event('11:00', '12:00', 'Declined thing', { declined: true }),
      event('00:00', '24:00', 'Holiday', { allDay: true }),
      event('12:00', '13:00', 'Release call', { overlap: true }),
      event('12:30', '13:00', 'Review', { overlap: true }),
    ]);
    expect(lines).toEqual(['10:00 Standup (Sam)', '12:00 Release call (overlaps)', '12:30 Review (overlaps)']);
  });
});

describe('overlapPairs', () => {
  it('pairs overlapping timed meetings at the later start, leaving back-to-back and declined ones out', () => {
    const pairs = overlapPairs([
      event('12:00', '13:00', 'Release call', { overlap: true }),
      event('12:30', '13:00', 'Review', { overlap: true }),
      event('13:00', '14:00', 'Back to back'),
      event('12:15', '12:45', 'Declined', { declined: true }),
    ]);
    expect(pairs).toEqual([{ first: 'Release call', second: 'Review', at: '12:30' }]);
  });
});
