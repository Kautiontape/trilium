# Views Caius can show, and a chat that keeps going in the background

Written 2026-11-03, after Shawn's first evening with the phone. Two asks:

- **Show, don't just say.** Caius said a day was "well above the target" and nothing on screen showed why, or let Shawn do anything about it. "I need a way to see why and how, and controls that both visualize what's happening on the day and let me toggle to move things." More widely: Caius should pick, from about a dozen ways to present, the one that fits what Shawn asked, and Shawn should be able to steer the day from it.
- **Keep going when hidden, and minimize.** A reply stops when the app is hidden: the server only streams it and the phone saves the transcript, so a paused WebView loses it. "Some way to make this work even when hidden or minimized is huge. Some way of minimizing it so I can see the updates and then jump back to talk to it."

## Decisions

### Views

1. **A catalogue of views the phone knows how to draw.** Caius picks one with a tool and passes the data; it never writes markup. Each view is designed once, works the same every time, and is tested. Rejected: building blocks Caius arranges (inconsistent), generated UI (slow, unsafe to wire taps back).
2. **Taps gather, then send.** As on the step cards: a move in a view goes into the answers pill ("ballot → Monday, garage shelf → the week"), the view shows the result straight away (its meters update), and Send gives the answers to Caius, who applies them in one call. Undo is before Send. Rejected: writing on each tap (Caius doesn't see the choice), writing and posting a line (noisy).
3. **The first views**, all four of Shawn's picks:
   - **Why it's over.** A day's load by area, the items that make each area up, and a fate control on each (keep, a block, next workday, a day, the week, drop). The meter shows what the day would be after the moves. For "this is well over target".
   - **The day board.** The day's timeline (meetings, Morning / Afternoon / Evening, the hills) with its tasks as rows that move between blocks, On deck, or another day.
   - **Ranges.** Two days side by side, or the week as a grid of days by area (minutes per cell, ▲ over), where a tap on a cell opens that day's items to move. For "what does my week look like".
   - **One item up close.** A task or ticket with its history: where it slipped from and how often, Jira status and the last comment, its estimate, its area, and its fate controls. For "what's going on with ZAP-2640?".
   More views come later (meetings vs open time, follow-ups, leftovers triage); each is a new entry in the catalogue, not a new mechanism.
4. **Caius chooses when to show.** When an answer is about three or more items, a load, or a choice between days, Caius shows the view that fits and writes one line around it; for a single fact it just says it. At most one view per reply. "Show me" always gets one. The skill sheet holds the guide: which view answers which kind of ask.
5. **One tool: `caius_show`.** `{ view: "over" | "board" | "range" | "item", … }` with the view's arguments (a date, a range, an item ref). The server reads the data the view needs (the same readers the steps use: `readPlan`, capacity, `workBlocks`, candidates, Jira) and returns it; the phone renders it from the tool result, as it renders step cards now. The tool reads only.
6. **Answers are words Caius already understands.** A view's taps become sentences in the pill, like the cards' ("Garage shelf goes to the week."), and Caius applies them with the tools it has (`caius_forward`, `caius_set_state`, `caius_set_area`, `caius_plan_apply`'s move). No new write path.

### Background and minimize

7. **The server owns a turn.** A turn runs on the server to the end whether or not the phone is watching, and the server saves the transcript to the chat note as it goes (today the phone saves it). The phone streams while it is open; when it comes back, it reads the saved turn and reattaches to the live stream if the turn is still running. Closing or killing the app loses nothing.
8. **While a turn runs, an ongoing notification.** "Caius is thinking…" with the latest line, kept up to date. It is an Android foreground service, so the app stays alive to stream while hidden; the server-owned turn is the safety net when it doesn't.
9. **Reply from the notification.** When the turn finishes, the notification turns into "Caius replied: <first line>" with Android's inline reply and an Open action. A reply sent there starts the next turn on the server like a message from the app.
10. **An in-app mini bar.** The chat can be minimized (a swipe down, or a button by Close) into a slim bar above the bottom tabs, showing whether Caius is working and its latest line. Shawn uses Today and Plan as normal and sees updates land; a tap opens the chat again. Answers gathered in the pill are kept while minimized. Rejected for now: a floating bubble over other apps (needs the overlay permission; most work).

## Where the code goes

- **Views.** A `caius_show` tool in `apps/server/src/services/caius/tools.ts` with a reader per view in a new `views.ts`, reusing the steps' readers (`daily.ts`, `plan-read.ts`, `blocks.ts`). The phone gets `screens/views/` with one component per view, picked by `stepOf`-style parsing of the tool result in `lib/chat.ts`, and answers in `lib/replies.ts` beside the cards'. The skill sheet's guide to which view fits which ask, and its register spec.
- **Server-owned turns.** `routes/api/caius_chat.ts` starts a turn as a job: the provider's chunks go to the client and, through `applyChunk`-equivalent assembly, to the chat note (`saveChatContent`), throttled. A `GET` returns a chat's saved turn and whether it is still running, and a reattach stream continues from an offset. The phone's `useChat` reads it on resume (`App` `resume` event).
- **Notification.** A Capacitor foreground-service plugin while a turn streams; `@capacitor/local-notifications` (already used) for the finished one with an input action; the reply posts to the chat route from the action handler.
- **Mini bar.** `app-state.ts` keeps the open chat when minimized; a `MiniChat` bar in `App.tsx` above the tabs.

## Order

1. Server-owned turns, then the mini bar and notifications on top (reliability first; the rest needs it).
2. `caius_show` with **Why it's over**, then the board, ranges and item views.

## Testing

- Server: a turn that runs to the end with the client gone saves the whole transcript; reattach returns the rest; each view's reader against the round-spec fixtures.
- Phone: view answers become the right sentences (`replies.spec`); the transcript survives a simulated pause; the mini bar keeps pill answers.
- Live on the rig: hide the app mid-turn and come back; reply from the notification; ask "why is Monday over?" and get the view.

## Not now

- A floating bubble over other apps.
- Writing on each tap in a view.
- Views on the desktop client.
