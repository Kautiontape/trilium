/**
 * Draws the day as terrain: one line whose height is meeting load, dots on the line for
 * meetings, labelled work bars under it, one clay focus bar, hour ticks and labels, a faint
 * divider where work ends, and a weather icon in the top-right corner. A port of the daily
 * brief's `bin/brief-terrain`.
 *
 * Trilium shows an SVG attachment as an <img>, which cannot see the app's theme, so the colours
 * are mid-tones that read on light and dark. All text is at least 11 px when shown 700 px wide.
 */

export interface TerrainEvent {
  start: string;
  end: string;
  title: string;
  overlap?: boolean;
}

export interface TerrainWork {
  start: string;
  end: string;
  label: string;
  focus?: boolean;
}

export interface TerrainInput {
  /** `HH:MM`, the left edge: standup. */
  start: string;
  /** `HH:MM`, the right edge: bedtime. */
  end: string;
  events: TerrainEvent[];
  work: TerrainWork[];
  /** `HH:MM`, where the divider between work and evening goes. Default `18:00`. */
  workEnd?: string;
  /** A WMO weather code as Open-Meteo returns it, and the label to show beside the icon. */
  weather?: { code: number; label: string };
}

export type WeatherIcon = 'sun' | 'cloud' | 'fog' | 'rain' | 'snow' | 'storm';

const INK = '#85837a';
const SOFT = '#a3a196';
const CLAY = '#d8764f';
const W = 640;
const PAD = 26;
const GROUND = 150;
const PEAK = 88;
const BAR_Y = 178;
const BAR_H = 30;
const LANES = 2;
const HEIGHT = BAR_Y + BAR_H + 22 * LANES + 28;
const DEFAULT_WORK_END = '18:00';

interface Item {
  s: number;
  e: number;
}
type Ev = TerrainEvent & Item;
type Wk = TerrainWork & Item;

export function renderDayTerrain(input: TerrainInput): string {
  const t0 = mins(input.start);
  let t1 = mins(input.end);
  // Nothing is drawn before start: items that end by then are dropped, the rest begin at start.
  const clipped = <T extends { start: string; end: string }>(item: T): (T & Item) | undefined => {
    const e = mins(item.end);
    return e > t0 ? { ...item, s: Math.max(mins(item.start), t0), e } : undefined;
  };
  const events: Ev[] = input.events.map(clipped).filter((e) => e !== undefined);
  const work: Wk[] = input.work.map(clipped).filter((w) => w !== undefined);
  // A late item stretches the end, on the hour.
  for (const item of [...events, ...work]) t1 = Math.max(t1, Math.ceil(item.e / 60) * 60);
  const x = (minute: number) => PAD + ((W - 2 * PAD) * (minute - t0)) / (t1 - t0);
  const overlaps = (ev: Ev) => events.some((o) => o !== ev && o.s < ev.e && ev.s < o.e);
  const height = (minute: number) => {
    let total = 0;
    for (const ev of events) {
      const dur = ev.e - ev.s;
      const half = Math.max(dur / 2 + 14, 22);
      const d = Math.abs(minute - (ev.s + ev.e) / 2);
      if (d < half) {
        const weight = 0.45 + (0.55 * Math.min(dur, 90)) / 90;
        total += (PEAK * 0.62 * weight * (1 + Math.cos((Math.PI * d) / half))) / 2;
      }
    }
    return Math.min(total, PEAK);
  };

  const step = Math.max(1, Math.floor((t1 - t0) / 400));
  const pts: [number, number][] = [];
  for (let m = t0; m <= t1; m += step) pts.push([x(m), GROUND - height(m)]);

  // Label layout. Labels rise in rows of 18 until they clear earlier labels, the dots and the
  // line, and slide left of the weather mark. When they rise above the canvas, `top` grows the
  // canvas upward (the viewBox starts above 0) so nothing is cut.
  const layout = (top: number) => {
    const weatherBox = input.weather ? weatherArea(input.weather.label, top) : undefined;
    const placed: Box[] = events.map((ev) => {
      const mid = (ev.s + ev.e) / 2;
      return { x0: x(mid) - 9, x1: x(mid) + 9, y0: GROUND - height(mid) - 9, y1: GROUND - height(mid) + 9 };
    });
    const onCurve = (box: Box) => pts.some(([px, py]) => px > box.x0 && px < box.x1 && py > box.y0 - 2 && py < box.y1 + 2);
    return events.map((ev) => {
      const mid = (ev.s + ev.e) / 2;
      const cx = x(mid);
      const cy = GROUND - height(mid);
      const half = 4.6 * ev.title.length + 6;
      // The dot stays on the line; the label shifts inward so it is never cut by the edge.
      const edge = 3.7 * ev.title.length + 4;
      let tx = Math.min(Math.max(cx, edge), W - edge);
      const boxAt = (at: number, rise: number): Box => ({ x0: at - half, x1: at + half, y0: cy - 16 - rise - 14, y1: cy - 16 - rise + 4 });
      let lift = 0;
      let box = boxAt(tx, lift);
      for (; lift < 400; lift += 18) {
        box = boxAt(tx, lift);
        if (weatherBox && hits(box, weatherBox)) {
          tx = Math.max(edge, weatherBox.x0 - half);
          box = boxAt(tx, lift);
        }
        if (!(placed.some((p) => hits(p, box)) || onCurve(box))) break;
      }
      placed.push(box);
      return { title: ev.title, overlap: !!ev.overlap || overlaps(ev), cx, cy, tx, baseline: cy - 16 - lift, box };
    });
  };
  let top = 0;
  let labels = layout(top);
  for (let pass = 0; pass < 3; pass++) {
    const need = Math.max(0, Math.ceil(2 - Math.min(...labels.map((l) => l.box.y0))));
    if (need <= top) break;
    top = need;
    labels = layout(top);
  }

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-top} ${W} ${HEIGHT + top}" width="${W}" height="${HEIGHT + top}" role="img" aria-label="${esc(describe(events, work))}">`,
  );

  const workEnd = mins(input.workEnd ?? DEFAULT_WORK_END);
  if (workEnd > t0 && workEnd < t1) {
    const wx = x(workEnd).toFixed(1);
    out.push(
      `<path data-part="work-end" d="M${wx},${GROUND + 8} L${wx},${BAR_Y + BAR_H}" stroke="${SOFT}" stroke-opacity="0.5" stroke-width="1.5" stroke-dasharray="3 5"/>`,
    );
  }

  out.push(
    `<path d="M${pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' L')}" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  );

  for (const l of labels) {
    out.push(
      l.overlap
        ? `<circle cx="${l.cx.toFixed(1)}" cy="${l.cy.toFixed(1)}" r="7.5" fill="none" stroke="${INK}" stroke-width="2.6"/>`
        : `<circle cx="${l.cx.toFixed(1)}" cy="${l.cy.toFixed(1)}" r="8" fill="${INK}"/>`,
    );
    out.push(
      `<text x="${l.tx.toFixed(1)}" y="${l.baseline.toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="600" fill="${INK}">${esc(l.title)}</text>`,
    );
  }

  for (let m = Math.ceil(t0 / 60) * 60; m <= t1; m += 60) {
    const hx = x(m).toFixed(1);
    out.push(`<path d="M${hx},${BAR_Y - 12} L${hx},${BAR_Y - 6}" stroke="${SOFT}" stroke-width="1.5"/>`);
    out.push(
      `<text x="${hx}" y="${HEIGHT - 6}" text-anchor="middle" font-family="sans-serif" font-size="13" fill="${SOFT}">${fmt12(m)}</text>`,
    );
  }

  const below: [number, number, number][] = [];
  for (const w of work) {
    const x0 = x(w.s);
    const x1 = x(w.e);
    const colour = w.focus ? CLAY : INK;
    out.push(
      `<rect x="${x0.toFixed(1)}" y="${BAR_Y}" width="${(x1 - x0).toFixed(1)}" height="${BAR_H}" rx="7" fill="${colour}" fill-opacity="${w.focus ? '0.9' : '0.28'}" stroke="${colour}" stroke-width="1.5"/>`,
    );
    const label = w.label ?? '';
    if (label && x1 - x0 > 7.8 * label.length + 6) {
      out.push(
        `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${BAR_Y + 20}" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="600" fill="${w.focus ? '#ffffff' : INK}">${esc(label)}</text>`,
      );
    } else if (label) {
      // Too narrow for its label: a leader drops to a row under the bars; rows stagger.
      const cx = (x0 + x1) / 2;
      const half = 3.9 * label.length + 6;
      let row = 0;
      while (
        row < LANES - 1 &&
        below.some(
          ([px, ph, pr]) =>
            (row === pr && Math.abs(cx - px) < half + ph) ||
            (pr < row && Math.abs(cx - px) < ph + 4) ||
            (pr > row && Math.abs(cx - px) < half + 4),
        )
      )
        row++;
      row = Math.min(row, LANES - 1);
      below.push([cx, half, row]);
      const ly = BAR_Y + BAR_H + 18 + 22 * row;
      out.push(`<path d="M${cx.toFixed(1)},${BAR_Y + BAR_H + 2} L${cx.toFixed(1)},${ly - 13}" stroke="${INK}" stroke-width="1.2"/>`);
      out.push(
        `<text x="${cx.toFixed(1)}" y="${ly}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="${INK}">${esc(label)}</text>`,
      );
    }
  }

  if (input.weather) out.push(weatherMark(input.weather.code, input.weather.label, top));
  out.push('</svg>');
  return out.join('\n') + '\n';
}

/** The icon for a WMO weather code; an unknown code reads as cloud. */
export function weatherIcon(code: number): WeatherIcon {
  if (code <= 1) return 'sun';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'storm';
  return 'cloud';
}

const CLOUD = 'M7,21 a5,5 0 0 1 1,-9.9 a6.5,6.5 0 0 1 12.4,1.4 a4.3,4.3 0 0 1 -0.4,8.5 Z';

const ICONS: Record<WeatherIcon, string> = {
  sun: '<circle cx="14" cy="14" r="5"/><path d="M14,2 V5 M14,23 V26 M2,14 H5 M23,14 H26 M5.5,5.5 L7.6,7.6 M20.4,20.4 L22.5,22.5 M5.5,22.5 L7.6,20.4 M20.4,7.6 L22.5,5.5"/>',
  cloud: `<path d="${CLOUD}" transform="translate(0,2)"/>`,
  fog: `<path d="${CLOUD}" transform="translate(0,-2)"/><path d="M5,22 H23 M8,26 H20"/>`,
  rain: `<path d="${CLOUD}" transform="translate(0,-3)"/><path d="M9,22 L7.5,26 M15,22 L13.5,26 M21,22 L19.5,26"/>`,
  snow: `<path d="${CLOUD}" transform="translate(0,-3)"/><path d="M9,23 V26 M15,23 V26 M21,23 V26 M7.5,24.5 H10.5 M13.5,24.5 H16.5 M19.5,24.5 H22.5"/>`,
  storm: `<path d="${CLOUD}" transform="translate(0,-3)"/><path d="M15,18 L11,24 H16 L13,28"/>`,
};

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const hits = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** The corner the weather mark takes: its icon, its label, and a margin. */
function weatherArea(label: string, top: number): Box {
  return { x0: W - PAD - 28 - 8 - 0.6 * 13 * label.length - 6, x1: W, y0: -top, y1: 36 - top };
}

/** The icon at the right edge and its label to the left of it, in the hour labels' style. */
function weatherMark(code: number, label: string, top: number): string {
  const icon = weatherIcon(code);
  const left = W - PAD - 28;
  return (
    `<g data-part="weather" data-icon="${icon}">` +
    `<g transform="translate(${left},${4 - top})" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</g>` +
    `<text x="${left - 8}" y="${24 - top}" text-anchor="end" font-family="sans-serif" font-size="13" fill="${SOFT}">${esc(label)}</text>` +
    '</g>'
  );
}

function mins(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

function fmt12(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = h % 24 < 12 ? 'a' : 'p';
  const h12 = h % 12 || 12;
  return mm === 0 ? `${h12}${suffix}` : `${h12}:${String(mm).padStart(2, '0')}${suffix}`;
}

function describe(events: Ev[], work: Wk[]): string {
  const meetings = events.map((e) => `${e.title || 'meeting'} ${fmt12(e.s)} to ${fmt12(e.e)}`);
  const planned = work.map((w) => `${w.label || 'work'} ${fmt12(w.s)} to ${fmt12(w.e)}`);
  return `Meetings: ${meetings.join('; ') || 'none'}. Planned work: ${planned.join('; ') || 'none'}.`;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
