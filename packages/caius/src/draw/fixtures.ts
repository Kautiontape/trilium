import type { TerrainInput } from './terrain.js';

export const NORMAL_DAY: TerrainInput = {
  start: '10:00',
  end: '23:00',
  events: [
    { start: '10:00', end: '10:15', title: 'Standup' },
    { start: '11:00', end: '12:00', title: 'Design review' },
    { start: '15:00', end: '15:30', title: 'Sync' },
  ],
  work: [
    { start: '10:30', end: '11:00', label: 'Inbox' },
    { start: '13:30', end: '15:00', label: 'ZAP-2617', focus: true },
    { start: '16:00', end: '17:00', label: 'Review' },
  ],
  weather: { code: 3, label: 'Overcast' },
};

export const HEAVY_DAY: TerrainInput = {
  start: '10:00',
  end: '23:00',
  events: [
    { start: '10:00', end: '10:15', title: 'Standup' },
    { start: '10:30', end: '11:30', title: 'Planning' },
    { start: '11:00', end: '12:00', title: 'Customer call', overlap: true },
    { start: '13:00', end: '14:30', title: 'Architecture' },
    { start: '15:00', end: '16:00', title: '1:1' },
    { start: '16:30', end: '17:30', title: 'Retro' },
  ],
  work: [
    { start: '12:15', end: '12:45', label: 'Triage' },
    { start: '14:30', end: '15:00', label: 'Notes' },
    { start: '17:30', end: '18:30', label: 'ZIS-88', focus: true },
  ],
  weather: { code: 61, label: 'Rain' },
};

export const OPEN_DAY: TerrainInput = {
  start: '10:00',
  end: '23:00',
  events: [{ start: '10:00', end: '10:15', title: 'Standup' }],
  work: [],
};
