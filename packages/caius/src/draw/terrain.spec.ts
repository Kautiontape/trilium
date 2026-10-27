import { describe, expect, it } from 'vitest';
import { HEAVY_DAY, NORMAL_DAY, OPEN_DAY } from './fixtures.js';
import { renderDayTerrain, weatherIcon } from './terrain.js';

describe('renderDayTerrain', () => {
  it('draws the three fixture days', () => {
    expect(renderDayTerrain(NORMAL_DAY)).toMatchSnapshot();
    expect(renderDayTerrain(HEAVY_DAY)).toMatchSnapshot();
    expect(renderDayTerrain(OPEN_DAY)).toMatchSnapshot();
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

  it('sizes every font for at least 11 px when shown 700 px wide', () => {
    for (const day of [NORMAL_DAY, HEAVY_DAY, OPEN_DAY]) {
      const svg = renderDayTerrain(day);
      const sizes = [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
      expect(sizes.length).toBeGreaterThan(0);
      for (const size of sizes) expect(size * 700 / 640).toBeGreaterThanOrEqual(11);
    }
  });
});
