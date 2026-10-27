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
  const events: Ev[] = input.events.map((e) => ({ ...e, s: mins(e.start), e: mins(e.end) }));
  const work: Wk[] = input.work.map((w) => ({ ...w, s: mins(w.start), e: mins(w.end) }));
  let t0 = mins(input.start);
  let t1 = mins(input.end);
  // Stretch the window, on the hour, if anything falls outside it.
  for (const item of [...events, ...work]) {
    t0 = Math.min(t0, Math.floor(item.s / 60) * 60);
    t1 = Math.max(t1, Math.ceil(item.e / 60) * 60);
  }
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
  const pts: string[] = [];
  for (let m = t0; m <= t1; m += step) pts.push(`${(x(m)).toFixed(1)},${(GROUND - height(m)).toFixed(1)}`);

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${HEIGHT}" width="${W}" height="${HEIGHT}" role="img" aria-label="${esc(describe(events, work))}">`,
  );

  const workEnd = mins(input.workEnd ?? DEFAULT_WORK_END);
  if (workEnd > t0 && workEnd < t1) {
    const wx = x(workEnd).toFixed(1);
    out.push(
      `<path data-part="work-end" d="M${wx},44 L${wx},${BAR_Y + BAR_H}" stroke="${SOFT}" stroke-opacity="0.5" stroke-width="1.5" stroke-dasharray="3 5"/>`,
    );
  }

  out.push(
    `<path d="M${pts.join(' L')}" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  );

  const placed: [number, number, number][] = [];
  for (const ev of events) {
    const mid = (ev.s + ev.e) / 2;
    const cx = x(mid);
    const cy = GROUND - height(mid);
    out.push(
      ev.overlap || overlaps(ev)
        ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="7.5" fill="none" stroke="${INK}" stroke-width="2.6"/>`
        : `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="8" fill="${INK}"/>`,
    );
    const half = 4.6 * ev.title.length + 6;
    // The dot stays on the line; the label shifts inward so it is never cut by the edge.
    const edge = 3.7 * ev.title.length + 4;
    const tx = Math.min(Math.max(cx, edge), W - edge);
    let lift = 0;
    while (placed.some(([px, ph, pl]) => Math.abs(tx - px) < half + ph && lift === pl)) lift += 18;
    placed.push([tx, half, lift]);
    out.push(
      `<text x="${tx.toFixed(1)}" y="${(cy - 16 - lift).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="600" fill="${INK}">${esc(ev.title)}</text>`,
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

  if (input.weather) out.push(weatherMark(input.weather.code, input.weather.label));
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

/** The icon at the right edge and its label to the left of it, in the hour labels' style. */
function weatherMark(code: number, label: string): string {
  const icon = weatherIcon(code);
  const left = W - PAD - 28;
  return (
    `<g data-part="weather" data-icon="${icon}">` +
    `<g transform="translate(${left},4)" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</g>` +
    `<text x="${left - 8}" y="24" text-anchor="end" font-family="sans-serif" font-size="13" fill="${SOFT}">${esc(label)}</text>` +
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
  const suffix = h < 12 ? 'a' : 'p';
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
