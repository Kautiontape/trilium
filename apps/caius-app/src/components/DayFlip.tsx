import { flipOffer } from "../lib/day.js";
import { api, runWrite, type TodayData } from "../lib/store.js";
import { Button } from "./ui.js";

/** Between midnight and the rollover: the button that starts the new day early, or takes it back. */
export function DayFlip({ data, now }: { data: TodayData; now: Date }) {
    const offer = flipOffer(now, data.rhythm, data.started);
    if (!offer) {
        return null;
    }
    const back = offer.kind === "back";
    return (
        <div class="nudge-quiet rituals-row">
            <Button disabled={data.offline} onClick={() => void runWrite(() => api().startDay(back))}>
                {back ? `Back to ${offer.day}` : `Start ${offer.day} now`}
            </Button>
        </div>
    );
}
