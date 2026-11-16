import type { NestAnswer, NestData, StepAnswers } from "../lib/replies.js";

import { displayText } from "./TaskRow.js";
import { Chip } from "./ui.js";

/** Plan my day's groupings, one pick card each: the sentence, the items it would nest, and Yes / Skip. */
export function NestCards({ items, answers, update, disabled }: { items: NestData[]; answers: StepAnswers; update: (patch: Partial<StepAnswers>) => void; disabled: boolean }) {
    if (!items.length) {
        return null;
    }
    const set = (i: number, value: Exclude<NestAnswer, null>) => update({ nests: { ...answers.nests, [i]: answers.nests?.[i] === value ? null : value } });
    const labels: [Exclude<NestAnswer, null>, string][] = [ [ "yes", "Yes" ], [ "skip", "Skip" ] ];
    return (
        <div class="candidates nest-cards">
            <div class="label-caps">Group these?</div>
            {items.map((nest, i) => (
                <div key={nest.ref ?? i} class="candidate">
                    <p>{nest.because}</p>
                    <ul class="ink-2 nest-items">
                        {nest.items.map((item) => <li key={item.id}>{displayText(item.text).text}</li>)}
                    </ul>
                    <div class="chip-row">
                        {labels.map(([ value, label ]) => (
                            <Chip key={value} disabled={disabled} selected={answers.nests?.[i] === value} onClick={() => set(i, value)}>{label}</Chip>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}
