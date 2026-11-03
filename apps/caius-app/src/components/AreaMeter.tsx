import "./area_meter.css";

import { duration } from "../lib/day.js";

/**
 * One area's meter: its minutes against its target, and a note when they run past it. Foundation
 * alone turns ochre. `ghost` is the minutes after the pending taps, drawn as a lighter fill and a
 * tick, with the figure beside the minutes.
 */
export function AreaMeter({ name, minutes, target, summary, tone, ghost }: {
    name: string;
    minutes: number;
    target: { min: number; max: number } | null;
    summary?: string;
    tone?: boolean;
    ghost?: number;
}) {
    const over = target ? minutes - target.max : 0;
    const range = target ? `${duration(target.min).replace(/ h$/, "")}–${duration(target.max)}` : null;
    const moved = ghost !== undefined && ghost !== minutes ? ghost : undefined;
    return (
        <div class={`capacity-row${tone ? "" : " thin"}`}>
            <div class="capacity-line">
                <span class="capacity-name">{name}</span>
                <span>
                    {summary ?? <><strong>{duration(minutes)}</strong>{moved !== undefined && <span class="capacity-ghost-figure"> → {duration(moved)}</span>}{range && ` of ${range}`}</>}
                </span>
                {over > 0 && (tone ? <span class="capacity-over mono">▲ {duration(over)} over</span> : <span class="capacity-note ink-2">{duration(over)} over</span>)}
            </div>
            {target && <MeterBar planned={minutes} min={target.min} max={target.max} warn={tone} ghost={moved} />}
        </div>
    );
}

function MeterBar({ planned, min, max, warn, ghost }: { planned: number; min: number; max: number; warn?: boolean; ghost?: number }) {
    const scale = Math.max(planned, max, ghost ?? 0) * 1.1;
    const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
    return (
        <div class="capacity-bar" aria-hidden="true">
            <div class="capacity-target" style={{ left: pct(min), width: `calc(${pct(max)} - ${pct(min)})` }} />
            {ghost !== undefined && <div class="capacity-ghost" style={{ width: pct(ghost) }} />}
            <div class={`capacity-fill${warn && planned > max ? " over" : ""}`} style={{ width: pct(planned) }} />
            {ghost !== undefined && <div class="capacity-ghost-mark" style={{ left: pct(ghost) }} />}
        </div>
    );
}
