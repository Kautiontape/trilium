/**
 * Draws the day as terrain: one line that rises in a hill for each group of planned work, higher
 * the more tasks it holds, and in a bump for each meeting, which also has a dot on the line; each
 * hill's name over its top and each meeting's over its dot; a hill holding an Important task in
 * clay; hour ticks and labels; and a weather icon in the top-right corner.
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

export interface TerrainGroup {
  start: string;
  end: string;
  name: string;
  /** How many tasks it holds, which sets its height. */
  count: number;
  /** It holds a task of the Important block: drawn in clay. */
  important?: boolean;
}

export interface TerrainInput {
  /** `HH:MM`, the left edge: standup. */
  start: string;
  /** `HH:MM`, the right edge: bedtime. */
  end: string;
  events: TerrainEvent[];
  groups: TerrainGroup[];
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
/** The height of a hill of one task, and the count from which hills stop growing. */
const HILL_LOW = 26;
const HILL_COUNT = 6;
const HILL_HIGH = PEAK * 0.78;
/**
 * Glyph widths in em, used to keep labels apart. DejaVu Sans, the usual sans-serif on Linux,
 * averages about 0.6 em and 0.66 em in bold, so these err wide.
 */
const EM = 0.62;
const EM_BOLD = 0.68;

interface Item {
  s: number;
  e: number;
}
type Ev = TerrainEvent & Item;
type Gr = TerrainGroup & Item & { h: number };

export function renderDayTerrain(input: TerrainInput): string {
  const t0 = mins(input.start);
  let t1 = mins(input.end);
  // Nothing is drawn before start: items that end by then are dropped, the rest begin at start.
  const clipped = <T extends { start: string; end: string }>(item: T): (T & Item) | undefined => {
    const e = mins(item.end);
    return e > t0 ? { ...item, s: Math.max(mins(item.start), t0), e } : undefined;
  };
  const events: Ev[] = input.events.map(clipped).filter((e) => e !== undefined);
  const groups: Gr[] = input.groups
    .map(clipped)
    .filter((g) => g !== undefined && g.e > g.s)
    .map((g) => ({ ...g!, h: HILL_LOW + ((Math.min(Math.max(g!.count, 1), HILL_COUNT) - 1) / (HILL_COUNT - 1)) * (HILL_HIGH - HILL_LOW) }));
  // A late item stretches the end, on the hour.
  for (const item of [...events, ...groups]) t1 = Math.max(t1, Math.ceil(item.e / 60) * 60);
  const x = (minute: number) => PAD + ((W - 2 * PAD) * (minute - t0)) / (t1 - t0);
  const overlaps = (ev: Ev) => events.some((o) => o !== ev && o.s < ev.e && ev.s < o.e);
  // A hill rises from the ground at its start to its height in the middle and back down at its end,
  // so two groups side by side dip to the ground where they meet.
  const hill = (minute: number, g: Gr) => (minute <= g.s || minute >= g.e ? 0 : g.h * Math.pow(Math.sin((Math.PI * (minute - g.s)) / (g.e - g.s)), 0.8));
  const bump = (minute: number, ev: Ev) => {
    const dur = ev.e - ev.s;
    const half = Math.max(dur / 2 + 14, 22);
    const d = Math.abs(minute - (ev.s + ev.e) / 2);
    if (d >= half) return 0;
    const weight = 0.45 + (0.55 * Math.min(dur, 90)) / 90;
    return (PEAK * 0.62 * weight * (1 + Math.cos((Math.PI * d) / half))) / 2;
  };
  const height = (minute: number) =>
    Math.min(PEAK, groups.reduce((sum, g) => sum + hill(minute, g), 0) + events.reduce((sum, ev) => sum + bump(minute, ev), 0));

  const step = Math.max(1, Math.floor((t1 - t0) / 400));
  const pts: [number, number][] = [];
  for (let m = t0; m <= t1; m += step) pts.push([x(m), GROUND - height(m)]);
  const along = (from: number, to: number) => [[x(from), GROUND - height(from)], ...pts.filter(([px]) => px > x(from) && px < x(to)), [x(to), GROUND - height(to)]];
  const line = (points: number[][]) => points.map(([px, py]) => `${px!.toFixed(1)},${py!.toFixed(1)}`).join(' L');

  // Label layout. A hill's name goes over its top and a meeting's over its dot; a label rises in rows
  // of 18 until it clears earlier labels, the dots and the line, and slides left of the weather mark.
  // Hills are named first, so they stay close to their hills. When labels rise above the canvas,
  // `top` grows the canvas upward (the viewBox starts above 0) so nothing is cut.
  const anchors = [
    ...groups.map((g) => {
      const mid = (g.s + g.e) / 2;
      return { text: g.name, bold: true, colour: g.important ? CLAY : INK, cx: x(mid), base: GROUND - height(mid) - 8 };
    }),
    ...events.map((ev) => {
      const mid = (ev.s + ev.e) / 2;
      return { text: ev.title, bold: false, colour: INK, cx: x(mid), base: GROUND - height(mid) - 16 };
    }),
  ].filter((a) => a.text !== '');
  const layout = (top: number) => {
    const weatherBox = input.weather ? weatherArea(input.weather.label, top) : undefined;
    const placed: Box[] = events.map((ev) => {
      const mid = (ev.s + ev.e) / 2;
      return { x0: x(mid) - 9, x1: x(mid) + 9, y0: GROUND - height(mid) - 9, y1: GROUND - height(mid) + 9 };
    });
    const onCurve = (box: Box) => pts.some(([px, py]) => px > box.x0 && px < box.x1 && py > box.y0 - 2 && py < box.y1 + 2);
    return anchors.map((a) => {
      const width = textWidth(a.text, 14, a.bold);
      const half = width / 2 + 4;
      // The label shifts inward so it is never cut by the edge.
      const edge = width / 2 + 2;
      let tx = Math.min(Math.max(a.cx, edge), W - edge);
      const boxAt = (at: number, rise: number): Box => ({ x0: at - half, x1: at + half, y0: a.base - rise - 14, y1: a.base - rise + 4 });
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
      return { ...a, tx, baseline: a.base - lift, box };
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

  const canvasHeight = GROUND + 40;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-top} ${W} ${canvasHeight + top}" width="${W}" height="${canvasHeight + top}" role="img" aria-label="${esc(describe(events, groups))}">`,
  );

  // Each hill is shaded, a hill holding an Important task in clay.
  for (const g of groups) {
    const colour = g.important ? CLAY : INK;
    out.push(
      `<path data-part="hill" d="M${x(g.s).toFixed(1)},${GROUND} L${line(along(g.s, g.e))} L${x(g.e).toFixed(1)},${GROUND} Z" fill="${colour}" fill-opacity="${g.important ? '0.32' : '0.14'}"/>`,
    );
  }

  out.push(
    `<path d="M${line(pts)}" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  );
  for (const g of groups.filter((g) => g.important)) {
    out.push(`<path d="M${line(along(g.s, g.e))}" fill="none" stroke="${CLAY}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`);
  }

  for (const ev of events) {
    const mid = (ev.s + ev.e) / 2;
    const cx = x(mid).toFixed(1);
    const cy = (GROUND - height(mid)).toFixed(1);
    out.push(
      ev.overlap || overlaps(ev)
        ? `<circle cx="${cx}" cy="${cy}" r="7.5" fill="none" stroke="${INK}" stroke-width="2.6"/>`
        : `<circle cx="${cx}" cy="${cy}" r="8" fill="${INK}"/>`,
    );
  }
  for (const l of labels) {
    out.push(
      `<text x="${l.tx.toFixed(1)}" y="${l.baseline.toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="${l.bold ? '600' : '400'}" fill="${l.colour}">${esc(l.text)}</text>`,
    );
  }

  for (let m = Math.ceil(t0 / 60) * 60; m <= t1; m += 60) {
    const hx = x(m).toFixed(1);
    out.push(`<path d="M${hx},${GROUND + 8} L${hx},${GROUND + 14}" stroke="${SOFT}" stroke-width="1.5"/>`);
    out.push(
      `<text x="${hx}" y="${canvasHeight - 6}" text-anchor="middle" font-family="sans-serif" font-size="13" fill="${SOFT}">${fmt12(m)}</text>`,
    );
  }

  if (input.weather) out.push(weatherMark(input.weather.code, input.weather.label, top));
  out.push('</svg>');
  return out.join('\n') + '\n';
}

/** The estimated width of `text` at `size` px. */
function textWidth(text: string, size: number, bold = false): number {
  return text.length * size * (bold ? EM_BOLD : EM);
}

/** A WMO code that draws each icon, for redrawing a weather mark read back from a drawing. */
const ICON_CODES: Record<WeatherIcon, number> = { sun: 0, cloud: 3, fog: 45, rain: 61, snow: 71, storm: 95 };

/**
 * The weather a drawing shows, as `renderDayTerrain` takes it: a code that draws the same icon and
 * the label, or null when the drawing has no weather mark.
 */
export function weatherOfSvg(svg: string): { code: number; label: string } | null {
  const mark = /<g data-part="weather" data-icon="(\w+)">[\s\S]*?<text [^>]*>([^<]*)<\/text><\/g>/.exec(svg);
  const icon = mark?.[1] as WeatherIcon | undefined;
  if (!icon || !(icon in ICON_CODES) || mark?.[2] === undefined) return null;
  // Every entity `esc` writes, `&amp;` last so an escaped entity reads back as itself.
  const label = mark[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return { code: ICON_CODES[icon], label };
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
  return { x0: W - PAD - 28 - 8 - textWidth(label, 13) - 6, x1: W, y0: -top, y1: 36 - top };
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

function describe(events: Ev[], groups: Gr[]): string {
  const meetings = events.map((e) => `${e.title || 'meeting'} ${fmt12(e.s)} to ${fmt12(e.e)}`);
  const planned = groups.map((g) => `${g.name || 'work'} ${fmt12(g.s)} to ${fmt12(g.e)}, ${g.count} ${g.count === 1 ? 'task' : 'tasks'}${g.important ? ', important' : ''}`);
  return `Meetings: ${meetings.join('; ') || 'none'}. Planned work: ${planned.join('; ') || 'none'}.`;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
