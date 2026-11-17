import "../launch_bar/CalendarWidget.css";
import "./caius_forward.css";

import { dayjs, type Dayjs } from "@triliumnext/commons";
import { useRef, useState } from "preact/hooks";

import { caiusNow } from "../../services/caius";
import { t } from "../../services/i18n";
import Calendar from "../launch_bar/Calendar";
import { AdjustDateButton, MONTHS } from "../launch_bar/CalendarWidget";
import Button from "../react/Button";
import FormGroup from "../react/FormGroup";
import FormTextBox from "../react/FormTextBox";
import { useTriliumEvent } from "../react/hooks";
import Modal from "../react/Modal";
import SegmentedChoice from "../react/SegmentedChoice";

/** Where a task forwarded to a day goes on it. */
export type CaiusForwardPlacement = "onDeck" | "list" | "critical";

/** What the dialog answers: the day, ISO week or month, and for a day where on it the task goes. */
export interface CaiusForwardPick extends ForwardPlacing {
    to: string;
}

/** Where on a day the forwarded copy goes, as `caiusApi.forward()` takes it. */
export interface ForwardPlacing {
    onDeck?: boolean;
    critical?: boolean;
}

export interface CaiusForwardDialogOptions {
    /** Receives the pick, or `null` when the dialog was closed without one. */
    callback: (pick: CaiusForwardPick | null) => void;
}

/**
 * The Task menu's "Pick a date…": a month grid in which a day, a week number or the month's title
 * fills the text box with that day, week or month, which can also be typed. For a day, a choice of
 * On deck, the list or the Important block follows.
 */
export default function CaiusForwardDialog() {
    const options = useRef<CaiusForwardDialogOptions | undefined>(undefined);
    const picked = useRef<CaiusForwardPick | null>(null);
    const [ shown, setShown ] = useState(false);
    const [ value, setValue ] = useState("");
    const [ placement, setPlacement ] = useState<CaiusForwardPlacement>("list");
    const [ month, setMonth ] = useState(() => today().startOf("month"));

    useTriliumEvent("showCaiusForwardDialog", (newOptions) => {
        options.current = newOptions;
        picked.current = null;
        setValue("");
        setPlacement("list");
        setMonth(today().startOf("month"));
        setShown(true);
    });

    const key = value.trim();
    const valid = isForwardKey(key);
    const day = valid && DAY_KEY.test(key) ? dayjs(`${key}T00:00:00`) : null;

    function pick(newValue: string) {
        setValue(newValue);
        if (DAY_KEY.test(newValue) || MONTH_KEY.test(newValue)) {
            setMonth(dayjs(`${newValue.slice(0, 7)}-01T00:00:00`));
        }
    }

    return (
        <Modal
            className="caius-forward-dialog"
            title={t("caius.forward_pick_title")}
            size="md"
            show={shown}
            stackable
            onSubmit={() => {
                if (!valid) return;
                picked.current = { to: key, ...(day ? PLACEMENTS[placement].fields : {}) };
                setShown(false);
            }}
            onHidden={() => {
                setShown(false);
                options.current?.callback(picked.current);
                options.current = undefined;
                picked.current = null;
            }}
            footer={<>
                <Button text={t("modal.cancel")} onClick={() => setShown(false)} />
                <Button text={t("caius.forward_pick_submit")} kind="primary" disabled={!valid} />
            </>}
        >
            <div className="calendar-dropdown-widget caius-forward-calendar">
                <div className="calendar-header">
                    <AdjustDateButton
                        date={month} setDate={setMonth} direction="prev" unit="month"
                    />
                    <Button
                        className="caius-forward-month" kind="lowProfile"
                        text={`${MONTHS[month.month()]} ${month.year()}`}
                        title={t("caius.forward_pick_month")}
                        onClick={() => pick(month.format("YYYY-MM"))}
                    />
                    <AdjustDateButton
                        date={month} setDate={setMonth} direction="next" unit="month"
                    />
                </div>
                <Calendar
                    date={month}
                    todaysDate={today()}
                    activeDate={day}
                    weekNotes={[]}
                    markDayNotes={false}
                    onDateClicked={(date, e) => {
                        e.preventDefault();
                        pick(date);
                    }}
                    onWeekClicked={(week, e) => {
                        e.preventDefault();
                        pick(week);
                    }}
                />
            </div>
            <FormGroup
                name="caius-forward-to"
                label={t("caius.forward_pick_to")}
                description={key && !valid
                    ? t("caius.forward_pick_invalid", { value: key })
                    : t("caius.forward_pick_message")}
            >
                <FormTextBox currentValue={value} onChange={setValue} />
            </FormGroup>
            {day && (
                <FormGroup name="caius-forward-placement" label={t("caius.forward_pick_placement")}>
                    <SegmentedChoice
                        options={PLACEMENT_ORDER.map((option) => ({
                            value: option, label: t(PLACEMENTS[option].label)
                        }))}
                        currentValue={placement}
                        onChange={setPlacement}
                    />
                </FormGroup>
            )}
        </Modal>
    );
}

/** Whether `value` is a day (`YYYY-MM-DD`), an ISO week (`YYYY-Www`) or a month (`YYYY-MM`). */
export function isForwardKey(value: string) {
    return [ DAY_KEY, WEEK_KEY, MONTH_KEY ].some((pattern) => pattern.test(value));
}

const DAY_KEY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const WEEK_KEY = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

const PLACEMENT_ORDER: CaiusForwardPlacement[] = [ "onDeck", "list", "critical" ];

const PLACEMENTS: Record<CaiusForwardPlacement, { label: string; fields: ForwardPlacing }> = {
    onDeck: { label: "caius.forward_pick_on_deck", fields: { onDeck: true } },
    list: { label: "caius.forward_pick_list", fields: { onDeck: false } },
    critical: { label: "caius.forward_pick_critical", fields: { critical: true } }
};

function today(): Dayjs {
    return dayjs(caiusNow()).startOf("day");
}
