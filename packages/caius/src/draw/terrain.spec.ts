import { describe, expect, it } from 'vitest';
import { HEAVY_DAY, LATE_HEAVY_DAY, NORMAL_DAY, OPEN_DAY } from './fixtures.js';
import { renderDayTerrain, type TerrainInput, weatherIcon } from './terrain.js';

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
      work: [{ start: '12:00', end: '12:20', label: '<x>&y' }],
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

  it('draws the end-of-work divider only inside the span, and nothing before start', () => {
    expect(renderDayTerrain(OPEN_DAY)).toContain('data-part="work-end"');
    expect(renderDayTerrain({ ...OPEN_DAY, workEnd: '23:30' })).not.toContain('data-part="work-end"');
    expect(renderDayTerrain({ ...OPEN_DAY, workEnd: '09:00' })).not.toContain('data-part="work-end"');
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
    const title = 'Quarterly planning offsite'; // 26 characters: clamp at 3.7 * 26 + 4 = 100.2
    const svg = renderDayTerrain({ ...OPEN_DAY, events: [{ start: '10:00', end: '10:15', title }] });
    expect(svg).toMatch(new RegExp(`<text x="100\\.2" [^>]*>${title}<`));
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
      work: [
        { start: '08:00', end: '10:00', label: 'Gone' },
        { start: '09:45', end: '11:00', label: 'Clipped' },
      ],
    });
    const left = 26; // x(start): the side padding
    expect(svg).not.toContain('Too early');
    expect(svg).not.toContain('Gone');
    expect(svg).toContain('Straddler');
    expect(svg).toContain('Clipped');
    expect(svg).toContain(`<rect x="${left}.0"`);
    for (const m of svg.matchAll(/<rect x="([\d.]+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(left);
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
