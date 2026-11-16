import { loadStateSymbols } from './journal.js';
import { failed, loadNote, skip, validItem } from './plan.js';
import type { Done, PlanOptions, PlanSkip } from './plan.js';
import { rewordTask } from './reword-html.js';
import type { RewordProblem } from './reword-html.js';
import type { NoteStore } from './store.js';

/** A task to give new words: the words only, without the marker or the estimate. */
export interface RewordRequest {
  noteId: string;
  listItemId: string;
  text: string;
}

/**
 * Replace the words of each task, keeping what `rewordTask` keeps. The tasks of one note are
 * changed together and written once, as `setAreas` writes them; if the note changed meanwhile,
 * none of them is written and each reports `edited`. An updated task carries `dropped` and
 * `droppedKeys` when the new words lost a link or a ticket key.
 */
export async function rewordTasks(api: NoteStore, reqs: RewordRequest[], opts: PlanOptions = {}): Promise<Done<RewordRequest>[]> {
  const states = opts.states ?? (await loadStateSymbols(api));
  const out = new Map<RewordRequest, Done<RewordRequest>>();
  const byNote = new Map<string, RewordRequest[]>();
  for (const req of reqs) {
    if (!validItem(req) || !req.text?.trim()) out.set(req, skip(req, 'bad_request', 'need noteId, listItemId and text'));
    else byNote.set(req.noteId, [...(byNote.get(req.noteId) ?? []), req]);
  }
  for (const [noteId, group] of byNote) {
    try {
      const loaded = await loadNote(api, noteId);
      if ('problem' in loaded) {
        for (const req of group) out.set(req, skip(req, 'unreadable', loaded.problem));
        continue;
      }
      const before = await api.content(noteId);
      let after = before;
      const changed: Done<RewordRequest>[] = [];
      const requests: RewordRequest[] = [];
      for (const req of group) {
        const r = rewordTask(after, req.listItemId, req.text, states);
        if (!r.ok) out.set(req, skipped(req, r.reason));
        else if (r.unchanged) out.set(req, { ...req, status: 'unchanged' });
        else {
          after = r.html;
          requests.push(req);
          changed.push({ ...req, status: 'updated', ...(r.dropped.length ? { dropped: r.dropped } : {}), ...(r.droppedKeys.length ? { droppedKeys: r.droppedKeys } : {}) } as Done<RewordRequest>);
        }
      }
      if (!requests.length) continue;
      if (opts.dryRun) {
        for (const [i, req] of requests.entries()) {
          out.set(req, { ...changed[i], dryRun: true, changes: i ? undefined : [{ noteId, role: 'target', before, after }] } as Done<RewordRequest>);
        }
      } else if (!(await api.putContent(noteId, after, before))) {
        for (const req of requests) out.set(req, skip(req, 'edited', 'note changed meanwhile; nothing written'));
      } else for (const [i, req] of requests.entries()) out.set(req, changed[i] as Done<RewordRequest>);
    } catch (e) {
      for (const req of group) if (!out.has(req)) out.set(req, failed(req, e));
    }
  }
  return reqs.map((req) => out.get(req) ?? failed(req, 'no result'));
}

const DETAILS: Record<Exclude<RewordProblem, 'not_found' | 'empty'>, string> = {
  not_live: 'only a task on a list can be reworded',
  moved: 'a moved copy is history: reword the copy it was moved to',
  cancelled: 'a cancelled task is history',
  suggested: 'a Suggested item keeps its "Get X done" shape: accept it first',
};

function skipped(req: RewordRequest, reason: RewordProblem): Done<RewordRequest> {
  if (reason === 'empty') return skip(req, 'bad_request', 'no words left once the marker and estimate are taken off');
  return skip(req, reason as PlanSkip, reason === 'not_found' ? undefined : DETAILS[reason]);
}
