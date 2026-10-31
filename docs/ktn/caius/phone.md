# Caius for Android

`apps/caius-app` is a phone front-end to Caius: today's list one swipe from done, capture in two taps, Plan my day and Wind down as guided conversations, Ask, and Caius's nudges as real phone notifications. It is a Capacitor 8 app (Vite, TypeScript, Preact) that talks to your own Trilium server with an ETAPI token. Nothing in it names a server: you type the address at first run.

This is the alpha. What it does, what it leaves for later and why are in the design plan the run worked from; the build and development steps are in [`apps/caius-app/README.md`](../../../apps/caius-app/README.md).

## Setting it up on a phone

1. In Trilium, make a token for the phone: Options → ETAPI → Create new token. A token of its own (for example `caius-phone`) can be revoked without touching anything else.
2. If the server is only reachable over a private network (a tailnet, say), connect the phone to it first.
3. If the server's certificate comes from your own certificate authority, install that CA on the phone **once**: Settings → Security & privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate. The app trusts the system CAs and the ones you install; it ships no CA of its own.
4. Install the APK and open Caius. Type the server address and paste the token, then **Test and connect**. The test checks that the server takes the token, whether it has the Caius phone routes, that a Journal exists, and reads your Rhythm.
5. Allow notifications when it asks, or later from Reminders.

The token is kept in Android's Keystore-backed storage (`capacitor-secure-storage-plugin`), never in the WebView's storage, and is never shown again. **Settings → Sign out** forgets it.

## What it does

| Screen | |
|---|---|
| **Today** | The day as Caius draws it (the terrain), the one nudge that matters (the catch-up, No plan yet, or Wind down), **Now** (the next task in your order that fits before the next meeting), capacity against the day's focus target, Important, the list in Caius's order with the Top 3 numbered, On deck, Suggested, Meetings and Context. Each card shows only when it has something to say. Offline, the last Today is shown with its time and the actions are off. |
| **Task actions** | Swipe right for Done, left for Forward. A tap opens the task sheet: Done, Doing, Forward (the next workday first; Would like / Need to on a day), Remind me, Why is this here?, Open in Trilium, and Drop… with a reason. Done, Forward and Dismiss wait 4 seconds behind **Undo** before they are sent, because Caius can't reopen a task; going to the background sends them at once. On a Suggested row, right is Accept (through the heading list when the day has several) and left is Dismiss. |
| **Quick add** | The + button. The default is today's On deck, or the next workday's once today is wound down or past the end of work. A day in the text ("thu", "next week") is offered as a chip and never taken without a tap; `~20m` sets the estimate. A capture made offline waits on the phone and is sent when the server is back. |
| **Plan** | Day, week or month with ‹ › and Today, the period's list, and the Pull in lanes: Overdue, This week, This month, 20 rows at a time. ⋯ on a row pulls it in to the period you're viewing, or marks it Done or drops it. |
| **Plan my day / Wind down** | The server's Caius conversation, full screen, on a clay or dusk ground, with the screen kept awake. Caius runs the ritual's steps and asks once; each step's data shows as a card under its question, with the proposed fate on each item as a chip. Taps on the cards build your reply in the text box (edit it or type your own), and Caius does the judgment and the one write. The transcript is saved to the chat note, so the desktop sidebar can open it. |
| **Ask** | The same chat with an `Ask` opener and starter prompts ("What should I work on now?"). "Remind me at 3 to call the pharmacy" is read on the phone into a reminder chip; only a tap on **Set** schedules it, and it never goes to the server. |
| **Reminders** | Your own reminders, then Caius's nudges as switches with their times from the standing note's Rhythm (each can be overridden on the phone), then quiet hours. |

App shortcuts on a long-press of the icon: Add task, Plan my day, Wind down, Ask.

## Notifications

All of them are scheduled on the phone from the state it last read, and rebuilt every time Today is read, so a nudge that is no longer true (you planned on the desktop) is cancelled when the app next opens. The plugin keeps the schedule across a reboot.

| Notification | When | Channel |
|---|---|---|
| Plan my day, or the catch-up in its place | 20 minutes before standup on a workday, while the day isn't planned (with the nudge state) or has a catch-up | Rituals |
| Wind down | At the end of work on a workday, unless the day is wound down | Rituals |
| Over capacity | At standup, once, when the day's planned work passes its focus target | Warnings |
| Your reminders | The exact time you set, with Done (on a task), Snooze 15 min and Tomorrow | Reminders |

The nudges' buttons act like the app's own: Move all to today, Skip, Plan my day, In 30 min / In 1 h (it comes back once).

## Against an older server

The app needs only `/mcp` and the token for Today, Plan, the task actions and Quick add. The rituals, Ask and the nudge state need the phone routes ([README](README.md#the-phone-routes)). Against a server without them the app says so ("Needs the Caius server update") on those screens, nudges Plan my day only for a catch-up, and nudges Wind down at the end of work.

## How it talks to the server

- **Reads and task actions** go over `/mcp`: one stateless JSON-RPC `tools/call` per action, `Accept: application/json, text/event-stream`, the tool's JSON read out of `result.content[0].text`.
- **Every request but the chat stream** goes through Capacitor's native HTTP (`CapacitorHttp.request`), not the WebView's `fetch`. A native request needs no CORS preflight, so `/mcp` works against a server that answers none, and a debug build's plain-HTTP test server isn't blocked as mixed content.
- **The chat stream** (`POST /etapi/llm-chat/stream`) is the one `fetch`, because the native plugin hands back a body only when it is complete. The server's token CORS allows the app's origin for it.
- **Today** is the server's: the key `caius_plan` answers for the current day, and its dev clock when it runs one. The app never works out the day from the phone's clock.
- Shared code comes from the monorepo by subpath: the planner's pure helpers from `packages/caius` (`renderDayTerrain`, `layoutWork`, `readRhythm`, `formatEstimate`, `nextWorkday`), and the transcript types and openers from `packages/commons`.

## Network security

The release build allows no cleartext at all and trusts the system CAs plus the ones installed on the phone. A debug build adds cleartext to `10.0.2.2` and `localhost` only (`android/app/src/debug/res/xml/network_security_config.xml`), so the emulator reaches a test server on the development machine, and allows mixed content in its WebView for the chat stream to it.
