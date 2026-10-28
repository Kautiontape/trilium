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

export const LATE_HEAVY_DAY: TerrainInput = {
  start: '10:00',
  end: '23:00',
  events: [
    { start: '10:00', end: '10:15', title: 'Standup' },
    { start: '17:00', end: '17:45', title: 'Sprint review' },
    { start: '17:30', end: '18:30', title: 'Customer call', overlap: true },
    { start: '18:00', end: '19:00', title: 'Board prep', overlap: true },
    { start: '18:30', end: '19:00', title: 'Wrap-up', overlap: true },
  ],
  work: [{ start: '13:00', end: '14:30', label: 'ZAP-9', focus: true }],
  weather: { code: 95, label: 'Thunderstorm' },
};

const rhythm = { start: '10:00', end: '23:00', workEnd: '18:00' };

/**
 * The days of the T13A simulation, from `runs/build-2026-10-27/T12/ical/work.ics` and
 * `personal.ics` in `daily-brief` as `caius_inputs` reads them, with the work the simulation drew
 * laid out by `layoutWork`: Tue 3 Nov, at 09:35 and after the Customer Call moved to 15:00; Thu 5
 * Nov with laundry in the evening; and Mon 9 Nov, four short tickets on an empty calendar.
 */
export const T13A_DAYS: { name: string; meetings: TerrainInput['events']; tasks: { label: string; minutes: number; evening?: boolean }[] }[] = [
  {
    name: 'Tue 3 Nov',
    meetings: [
      { start: '10:00', end: '10:30', title: 'Weekly Planning Sync' },
      { start: '11:00', end: '11:30', title: 'Customer Call' },
    ],
    tasks: [{ label: 'ZAP-105', minutes: 30 }, { label: 'ZAP-111', minutes: 30 }, { label: 'ZAP-110', minutes: 30 }],
  },
  {
    name: 'Tue 3 Nov, 11:05',
    meetings: [
      { start: '10:00', end: '10:30', title: 'Weekly Planning Sync' },
      { start: '15:00', end: '15:30', title: 'Customer Call' },
    ],
    tasks: [{ label: 'ZAP-105', minutes: 30 }, { label: 'ZAP-111', minutes: 30 }],
  },
  {
    name: 'Thu 5 Nov',
    meetings: [
      { start: '10:00', end: '10:15', title: 'Daily Standup' },
      { start: '10:30', end: '11:30', title: 'Incident Review' },
      { start: '11:00', end: '12:00', title: 'Vendor Onboarding' },
      { start: '13:00', end: '14:00', title: 'Roadmap Review' },
      { start: '14:00', end: '15:30', title: 'Design Workshop' },
      { start: '16:00', end: '16:30', title: 'Interview Panel' },
    ],
    tasks: [{ label: 'ZAP-110', minutes: 30 }, { label: 'ZAP-111', minutes: 30 }, { label: 'Laundry', minutes: 45, evening: true }],
  },
  {
    name: 'Mon 9 Nov',
    meetings: [],
    tasks: [{ label: 'ZAP-110', minutes: 30 }, { label: 'ZAP-101', minutes: 30 }, { label: 'ZAP-111', minutes: 30 }, { label: 'ZAP-105', minutes: 30 }],
  },
];

export const T13A_RHYTHM = rhythm;
