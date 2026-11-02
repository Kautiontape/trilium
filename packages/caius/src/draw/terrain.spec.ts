import { describe, expect, it } from 'vitest';
import { layoutGroups } from '../daily/blocks.js';
import { HEAVY_DAY, LATE_HEAVY_DAY, NORMAL_DAY, OPEN_DAY, T13A_DAYS, T13A_RHYTHM } from './fixtures.js';
import { renderDayTerrain, type TerrainInput, weatherIcon, weatherOfSvg } from './terrain.js';

describe('renderDayTerrain', () => {
  it('draws the three fixture days', () => {
    expect(renderDayTerrain(NORMAL_DAY)).toMatchSnapshot();
    expect(renderDayTerrain(HEAVY_DAY)).toMatchSnapshot();
    expect(renderDayTerrain(OPEN_DAY)).toMatchSnapshot();
    expect(renderDayTerrain(LATE_HEAVY_DAY)).toMatchSnapshot();
  });

  it('keeps width, height and viewBox, so it does not collapse as an image', () => {
    const svg = renderDayTerrain(NORMAL_DAY);
    expect(svg).toMatch(/<svg [^>]*viewBox="0 0 640 \d+"/);
    expect(svg).toMatch(/<svg [^>]*width="640"/);
    expect(svg).toMatch(/<svg [^>]*height="\d+"/);
  });

  it('escapes every text and the aria-label', () => {
    const svg = renderDayTerrain({
      ...OPEN_DAY,
      events: [{ start: '10:00', end: '11:00', title: 'A<b>&"c' }],
      groups: [{ start: '12:00', end: '12:20', name: '<x>&y', count: 1 }],
      weather: { code: 0, label: 'Sun & <wind>' },
    });
    expect(svg).not.toContain('<b>');
    expect(svg).not.toContain('<x>');
    expect(svg).not.toContain('<wind>');
    expect(svg).toContain('A&lt;b&gt;&amp;&quot;c</text>');
    expect(svg).toContain('&lt;x&gt;&amp;y</text>');
    expect(svg).toContain('Sun &amp; &lt;wind&gt;</text>');
    expect(svg).toContain('A&lt;b&gt;&amp;&quot;c');
  });

  it('draws a hill per group, higher the more tasks it holds up to six, with no bars and no end-of-work line', () => {
    const peakOf = (count: number) => {
      const svg = renderDayTerrain({ ...OPEN_DAY, events: [], groups: [{ start: '13:00', end: '15:00', name: 'Work', count }] });
      const hill = svg.match(/data-part="hill" d="([^"]+)"/)?.[1] ?? '';
      return 150 - Math.min(...[...hill.matchAll(/[\d.]+,([\d.]+)/g)].map((m) => Number(m[1])));
    };
    expect(peakOf(1)).toBeGreaterThan(20);
    expect(peakOf(3)).toBeGreaterThan(peakOf(1) + 10);
    expect(peakOf(6)).toBeGreaterThan(peakOf(3) + 10);
    expect(peakOf(12)).toBeCloseTo(peakOf(6), 0);
    const svg = renderDayTerrain(NORMAL_DAY);
    expect(svg.match(/data-part="hill"/g)).toHaveLength(3);
    expect(svg).not.toContain('<rect');
    expect(svg).not.toContain('work-end');
  });

  it('dips to the ground where two groups meet', () => {
    const svg = renderDayTerrain({
      ...OPEN_DAY,
      events: [],
      groups: [
        { start: '12:00', end: '14:00', name: 'Board', count: 6 },
        { start: '14:00', end: '16:00', name: 'ZAP bugs', count: 6 },
      ],
    });
    const x = 26 + ((640 - 52) * (14 * 60 - 10 * 60)) / (13 * 60);
    const line = [...(svg.match(/<path d="(M[^"]+)" fill="none"/)?.[1] ?? '').matchAll(/([\d.]+),([\d.]+)/g)].map(([, px, py]) => [Number(px), Number(py)]);
    const nearest = line.reduce((a, b) => (Math.abs(b[0]! - x) < Math.abs(a[0]! - x) ? b : a));
    expect(nearest[1]).toBeGreaterThan(146);
  });

  it('draws a group holding an Important task in clay, and only that one', () => {
    const svg = renderDayTerrain(NORMAL_DAY);
    expect(svg.match(/data-part="hill"[^>]*fill="#d8764f"/g)).toHaveLength(1);
    expect(svg).toContain('fill="#d8764f">ZAP-2617</text>');
    expect(svg).toContain('fill="#85837a">Reviews</text>');
    expect(renderDayTerrain(OPEN_DAY)).not.toContain('#d8764f');
  });

  it('reads back the weather it drew, whatever its label holds', () => {
    const weather = { code: 0, label: `Sun & <wind> "gusts" isn't` };
    expect(weatherOfSvg(renderDayTerrain({ ...OPEN_DAY, weather }))).toEqual(weather);
    const drawn = '<g data-part="weather" data-icon="sun"><g></g><text x="1">It&#39;s &quot;clear&quot; &amp; dry</text></g>';
    expect(weatherOfSvg(drawn)).toEqual({ code: 0, label: `It's "clear" & dry` });
  });

  it('draws a weather icon with its label, or none without weather', () => {
    expect(renderDayTerrain(OPEN_DAY)).not.toContain('data-part="weather"');
    const svg = renderDayTerrain({ ...OPEN_DAY, weather: { code: 95, label: 'Storm' } });
    expect(svg).toContain('data-part="weather"');
    expect(svg).toContain('>Storm</text>');
  });

  it('picks the icon from the WMO code', () => {
    const codes: [number, string][] = [
      [0, 'sun'], [1, 'sun'], [2, 'cloud'], [3, 'cloud'], [45, 'fog'], [48, 'fog'],
      [51, 'rain'], [63, 'rain'], [81, 'rain'], [71, 'snow'], [86, 'snow'],
      [95, 'storm'], [99, 'storm'], [999, 'cloud'],
    ];
    for (const [code, icon] of codes) expect(weatherIcon(code)).toBe(icon);
  });

  it('shifts a label that would be cut by the edge inward, keeping the dot on the line', () => {
    const title = 'Quarterly planning offsite'; // 26 characters at 14 px: clamp at 26 * 14 * 0.62 / 2 + 2 = 114.8
    const svg = renderDayTerrain({ ...OPEN_DAY, events: [{ start: '10:00', end: '10:15', title }] });
    expect(svg).toMatch(new RegExp(`<text x="114\\.8" [^>]*>${title}<`));
    expect(svg).toMatch(/<circle cx="31\.\d"/);
  });

  it('draws nothing before start: early items are dropped, straddlers clipped to start', () => {
    const svg = renderDayTerrain({
      ...OPEN_DAY,
      start: '10:00',
      events: [
        { start: '08:00', end: '09:00', title: 'Too early' },
        { start: '09:30', end: '10:30', title: 'Straddler' },
      ],
      groups: [
        { start: '08:00', end: '10:00', name: 'Gone', count: 1 },
        { start: '09:45', end: '11:00', name: 'Clipped', count: 1 },
      ],
    });
    const left = 26; // x(start): the side padding
    expect(svg).not.toContain('Too early');
    expect(svg).not.toContain('Gone');
    expect(svg).toContain('Straddler');
    expect(svg).toContain('Clipped');
    expect(svg).toContain(`data-part="hill" d="M${left}.0,`);
    for (const m of svg.matchAll(/data-part="hill" d="M([\d.]+),/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(left);
    for (const m of svg.matchAll(/<circle cx="([\d.]+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(left);
    expect(svg).toMatch(new RegExp(`<path d="M${left}\\.0,`));
    expect(svg).not.toMatch(/>9a</);
  });

  it('lets a late meeting extend the day past bedtime', () => {
    const svg = renderDayTerrain({ ...OPEN_DAY, events: [{ start: '23:00', end: '23:45', title: 'Late' }] });
    expect(svg).toContain('>12a<');
  });

  it('never overlaps two labels, or a label and the weather mark, and keeps text on the canvas', () => {
    const nightHeavy: TerrainInput = {
      ...OPEN_DAY,
      events: [
        { start: '20:30', end: '21:30', title: 'Planning review' },
        { start: '21:00', end: '22:00', title: 'Customer call' },
        { start: '21:30', end: '22:30', title: 'Incident' },
      ],
      weather: { code: 61, label: 'Heavy rain showers' },
    };
    for (const day of [NORMAL_DAY, HEAVY_DAY, OPEN_DAY, LATE_HEAVY_DAY, nightHeavy]) {
      const svg = renderDayTerrain(day);
      const boxes: Box[] = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="(\w+)"[^>]*font-size="([\d.]+)"[^>]*>([^<]*)<\/text>/g)].map(
        ([, x, y, anchor, size, raw]) => {
          const width = 0.6 * Number(size) * unescape(raw).length;
          const x0 = anchor === 'middle' ? Number(x) - width / 2 : anchor === 'end' ? Number(x) - width : Number(x);
          return { name: unescape(raw), x0, x1: x0 + width, y0: Number(y) - 0.8 * Number(size), y1: Number(y) + 0.2 * Number(size) };
        },
      );
      const viewTop = Number(svg.match(/viewBox="0 (-?[\d.]+) /)?.[1]);
      const icon = svg.match(/data-part="weather"[^>]*><g transform="translate\((-?[\d.]+),(-?[\d.]+)\)"/);
      if (icon) boxes.push({ name: 'weather icon', x0: Number(icon[1]), x1: Number(icon[1]) + 28, y0: Number(icon[2]), y1: Number(icon[2]) + 28 });
      const dots = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map(([, cx, cy, r]) => ({
        name: `dot at ${cx}`, x0: Number(cx) - Number(r), x1: Number(cx) + Number(r), y0: Number(cy) - Number(r), y1: Number(cy) + Number(r),
      }));
      const line = [...(svg.match(/<path d="(M[^"]+)" fill="none"/)?.[1] ?? '').matchAll(/([\d.]+),([\d.]+)/g)].map(([, px, py]) => [Number(px), Number(py)]);
      for (const text of boxes) {
        for (const dot of dots) expect(hitsBox(text, dot), `${text.name} overlaps ${dot.name}`).toBe(false);
        const through = line.find(([px, py]) => px > text.x0 && px < text.x1 && py > text.y0 && py < text.y1);
        expect(through, `${text.name} is crossed by the line`).toBeUndefined();
      }
      for (const b of boxes) {
        expect(b.y0, `${b.name} is cut by the top`).toBeGreaterThanOrEqual(viewTop);
        expect(b.x0, `${b.name} is cut by the left`).toBeGreaterThanOrEqual(0);
        expect(b.x1, `${b.name} is cut by the right`).toBeLessThanOrEqual(640);
      }
      for (const [i, a] of boxes.entries()) {
        for (const b of boxes.slice(i + 1)) {
          const hit = hitsBox(a, b);
          expect(hit, `${a.name} overlaps ${b.name}`).toBe(false);
        }
      }
    }
  });

  it('prints no label over another, a dot or the line on the T13A days, at a glyph width wider than the drawing assumes', () => {
    for (const day of T13A_DAYS) {
      const { groups } = layoutGroups(T13A_RHYTHM, day.meetings, day.tasks.map((task) => ({ name: task.label, tasks: [task] })));
      const svg = renderDayTerrain({ ...T13A_RHYTHM, events: day.meetings, groups, weather: { code: 0, label: 'Clear' } });
      // DejaVu Sans, the usual sans-serif on Linux, averages about 0.6 em, and 0.66 em in bold.
      const boxes: Box[] = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="(\w+)"[^>]*font-size="([\d.]+)"([^>]*)>([^<]*)<\/text>/g)].map(
        ([, x, y, anchor, size, rest, raw]) => {
          const width = (rest?.includes('font-weight="600"') ? 0.68 : 0.62) * Number(size) * unescape(raw ?? '').length;
          const x0 = anchor === 'middle' ? Number(x) - width / 2 : anchor === 'end' ? Number(x) - width : Number(x);
          return { name: unescape(raw ?? ''), x0, x1: x0 + width, y0: Number(y) - 0.8 * Number(size), y1: Number(y) + 0.25 * Number(size) };
        },
      );
      // The weather icon's own circle is drawn in the icon's coordinates, so it is left out of the dots.
      const dots = [...svg.replace(/<g data-part="weather".*?<\/text><\/g>/s, '').matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map(([, cx, cy, r]) => ({
        name: `dot at ${cx}`, x0: Number(cx) - Number(r), x1: Number(cx) + Number(r), y0: Number(cy) - Number(r), y1: Number(cy) + Number(r),
      }));
      const line = [...(svg.match(/<path d="(M[^"]+)" fill="none"/)?.[1] ?? '').matchAll(/([\d.]+),([\d.]+)/g)].map(([, px, py]) => [Number(px), Number(py)]);
      for (const text of boxes) {
        const where = `${day.name}: ${text.name}`;
        for (const dot of dots) expect.soft(hitsBox(text, dot), `${where} overlaps the ${dot.name}`).toBe(false);
        const through = line.find(([px, py]) => px > text.x0 && px < text.x1 && py > text.y0 && py < text.y1);
        expect.soft(through, `${where} is crossed by the line`).toBeUndefined();
        expect.soft(text.x0, `${where} is cut by the left`).toBeGreaterThanOrEqual(0);
        expect.soft(text.x1, `${where} is cut by the right`).toBeLessThanOrEqual(640);
      }
      for (const [i, a] of boxes.entries()) {
        for (const b of boxes.slice(i + 1)) expect.soft(hitsBox(a, b), `${day.name}: ${a.name} overlaps ${b.name}`).toBe(false);
      }
    }
  });

  it('draws an evening group as a hill after the end of work', () => {
    const thursday = T13A_DAYS.find((day) => day.name === 'Thu 5 Nov');
    if (!thursday) throw new Error('no Thursday');
    const { groups } = layoutGroups(T13A_RHYTHM, thursday.meetings, [
      { name: 'ZAP bugs', tasks: thursday.tasks.filter((task) => !task.evening) },
      { name: 'Laundry', tasks: thursday.tasks.filter((task) => task.evening) },
    ]);
    expect(groups.find((group) => group.name === 'Laundry')).toMatchObject({ start: '18:00', end: '18:45', count: 1 });
    const svg = renderDayTerrain({ ...T13A_RHYTHM, events: thursday.meetings, groups });
    const x = (26 + ((640 - 52) * (18 * 60 - 10 * 60)) / (13 * 60)).toFixed(1);
    expect(svg).toContain(`data-part="hill" d="M${x},`);
    expect(svg).toContain('>Laundry</text>');
  });

  it('names a group split around a meeting once, and draws evening calendar events as meeting dots', () => {
    // Round 2, Mon 2 Nov: ZAP-101 split around Sprint Planning read as two tasks; Call Mom is a calendar event.
    const meetings = [
      { start: '10:00', end: '10:15', title: 'Standup' },
      { start: '10:45', end: '12:00', title: 'Sprint Planning' },
      { start: '18:00', end: '18:30', title: 'Call Mom' },
      { start: '19:00', end: '21:00', title: 'Climbing gym' },
    ];
    const { groups, work } = layoutGroups(T13A_RHYTHM, meetings, [{ name: 'ZAP bugs', tasks: [{ label: 'ZAP-111', minutes: 15 }, { label: 'ZAP-101', minutes: 60 }] }]);
    expect(work.filter((block) => block.start >= '10:30' && block.end <= '13:00')).toHaveLength(2);
    expect(groups).toEqual([{ start: '10:15', end: '12:45', name: 'ZAP bugs', count: 2 }]);
    const svg = renderDayTerrain({ ...T13A_RHYTHM, events: meetings, groups });
    expect(svg.match(/>ZAP bugs<\/text>/g)).toHaveLength(1);
    expect(svg.match(/data-part="hill"/g)).toHaveLength(1);
    expect(svg.match(/<circle /g)).toHaveLength(4);
    for (const title of ['Call Mom', 'Climbing gym']) expect(svg).toContain(`font-weight="400" fill="#85837a">${title}</text>`);
  });

  it('sizes every font for at least 11 px when shown 700 px wide', () => {
    for (const day of [NORMAL_DAY, HEAVY_DAY, OPEN_DAY, LATE_HEAVY_DAY]) {
      const svg = renderDayTerrain(day);
      const width = Number(svg.match(/viewBox="0 -?[\d.]+ ([\d.]+) /)?.[1]);
      const sizes = [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
      expect(width).toBeGreaterThan(0);
      expect(sizes.length).toBeGreaterThan(0);
      for (const size of sizes) expect((size * 700) / width).toBeGreaterThanOrEqual(11);
    }
  });
});

interface Box {
  name: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function hitsBox(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function unescape(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
