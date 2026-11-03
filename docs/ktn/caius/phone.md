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
| **Plan my day / Wind down** | The server's Caius conversation, full screen, on a clay or dusk ground, with the screen kept awake. Caius runs the ritual's steps and asks once; each step's data shows as a card under its question, with the proposed fate on each item as a chip. Taps on the cards build your reply in the text box (edit it or type your own), and Caius does the judgment and the one write. The server saves the transcript to the chat note as the turn runs, so the desktop sidebar can open it. The open ritual is stored on the phone, and a restart of the app reopens it. **Minimize** (by Close), or a swipe down on the header, folds the chat into a bar above the tabs that shows whether Caius is working and his latest line, while you use Today and Plan; a tap on the bar opens it again, with your answers on the cards kept (the chat stays mounted while it is minimized). Back minimizes it while Caius is working and closes it otherwise. |
| **Ask** | The same chat with an `Ask` opener and starter prompts ("What should I work on now?"). "Remind me at 3 to call the pharmacy" is read on the phone into a reminder chip; only a tap on **Set** schedules it, and it never goes to the server. Ask stays mounted when you switch tabs, and on another tab it shows in the same bar while Caius works on it or has a reply you haven't seen. The chat is stored on the phone and reopened after a restart. A new day starts Ask fresh once it is out of sight with Caius finished and his reply seen, so a turn that runs past midnight keeps its reply. |
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
| Caius is thinking… | Ongoing, while a chat turn runs, with the chat's title and Caius's latest line (updated at most once a second); it shows even when the chat is on screen, and a tap opens the working chat (the ritual first) | Caius thinking (`caius-working`, low importance) |
| Caius replied | When a turn ends while the app is hidden or its chat is off screen, with the reply's first line (or "Open the chat to see it." for a reply with only tool calls), **Reply** (typed in the notification) and **Open** | Caius's replies (`caius`) |

The two chat notifications are posted from the app's chat state, not scheduled: they have fixed ids (21 for the ongoing one, 22 for the reply), and "Caius replied" is cancelled once its chat shows with the app in front. "Caius is thinking…" comes from an Android foreground service (`@capawesome-team/capacitor-android-foreground-service`, type `dataSync`, with the `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_DATA_SYNC` permissions) that keeps the app alive to read the turn while it is hidden, and stops when no chat is working. Open shows the chat, reopening the ritual from its stored chat after a cold start. Reply does the same and sends the text as the next message once the chat has loaded; it is held for the stored chat note, so it reaches no other chat. A chat that can't take it (Ask from an earlier day, or a chat that couldn't be reopened) puts the text in its box to send by hand, and a reply to a ritual that has since been closed shows "Your reply wasn't sent: that chat is closed."

The nudges' buttons act like the app's own: Move all to today, Skip, Plan my day, In 30 min / In 1 h (it comes back once).

## Against an older server

The app needs only `/mcp` and the token for Today, Plan, the task actions and Quick add. The rituals, Ask and the nudge state need the phone routes ([README](README.md#the-phone-routes)). Against a server without them the app says so ("Needs the Caius server update") on those screens, nudges Plan my day only for a catch-up, and nudges Wind down at the end of work.

## How it talks to the server

- **Reads and task actions** go over `/mcp`: one stateless JSON-RPC `tools/call` per action, `Accept: application/json, text/event-stream`, the tool's JSON read out of `result.content[0].text`.
- **Every request but the chat stream** goes through Capacitor's native HTTP (`CapacitorHttp.request`), not the WebView's `fetch`. A native request needs no CORS preflight, so `/mcp` works against a server that answers none, and a debug build's plain-HTTP test server isn't blocked as mixed content.
- **The chat stream** (`POST /etapi/llm-chat/stream`) is the one `fetch`, because the native plugin hands back a body only when it is complete. The server's token CORS allows the app's origin for it. The body carries `turn: { replyId, transcript }`: the server owns the turn and saves `transcript` plus the reply to the chat note (see [internals.md](internals.md)). The phone `PUT`s the transcript (`/etapi/llm-chat/:noteId/content`) only for a turn the server refused with a status (`429 too_many_turns`, any other error status, or no phone routes), with the error as the reply and the words back in the box.
- **Following a turn.** When the stream breaks or the app resumes, the phone asks `GET /etapi/llm-chat/:noteId/turn` and, if the turn still runs, rejoins it from chunk 0 (`followTurn` in `src/lib/chats.ts`); if it has ended, it takes the saved reply. A reply still marked `partial` is dropped as lost.
- **Reading the chat back.** After a `409` (another turn runs for the note), a stream that couldn't reach the server, or a turn it could not follow, the phone saves nothing: the server might hold the turn and save its reply later. It marks the chat stale and reads it back from the server (`resync` and `afterStreamError` in `src/lib/chats.ts`) at once, or, while the server can't be reached, on the next resume and before the next message, with an error line under the chat meanwhile. The transcript then is the server's, and a turn still running there is followed. Your words go back in the box only when the server never got the message, or when its turn ended without a reply, with the error line saying so; they go after anything typed since. A chat read back that ends on a message no turn answered, as after a server restart, says so the same way, with that message's words back in the box (`unansweredTail`); when that message is the conversation's opener, it stays in the chat for the next turn and only the error line shows. A message sent while the chat is stale waits for that read-back: it is sent once the chat is in step with the server, after a turn still running there has ended. Otherwise it stays in the box, after the earlier message's words when those came back. So the transcript sent with a turn always starts from what the server saved, and never writes over a reply.
- **Today** is the server's: the key `caius_plan` answers for the current day, and its dev clock when it runs one. The app never works out the day from the phone's clock.
- Shared code comes from the monorepo by subpath: the planner's pure helpers from `packages/caius` (`renderDayTerrain`, `layoutWork`, `readRhythm`, `formatEstimate`, `nextWorkday`), and the transcript types and openers from `packages/commons`.

## Network security

The release build allows no cleartext at all and trusts the system CAs plus the ones installed on the phone. A debug build adds cleartext to `10.0.2.2` and `localhost` only (`android/app/src/debug/res/xml/network_security_config.xml`), so the emulator reaches a test server on the development machine, and allows mixed content in its WebView for the chat stream to it.
