import { describe, expect, test } from 'vitest';
import { parseTaskLine } from './parse-line.js';

describe('parseTaskLine — bare tasks', () => {
  test('parses a bare open task', () => {
    const t = parseTaskLine('- [ ] Buy milk');
    expect(t).not.toBeNull();
    expect(t!.state).toBe('open');
    expect(t!.live).toBe(true);
    expect(t!.text).toBe('Buy milk');
    expect(t!.tokens).toEqual([]);
    expect(t!.blockId).toBeNull();
  });
});

describe('parseTaskLine — states (D1, strict 5)', () => {
  test.each([
    ['- [ ] a', 'open', true],
    ['- [/] a', 'in_progress', true],
    ['- [x] a', 'done', false],
    ['- [X] a', 'done', false],
    ['- [-] a', 'cancelled', false],
    ['- [>] a', 'tombstone', false],
  ] as const)('%s -> %s (live=%s)', (line, state, live) => {
    const t = parseTaskLine(line);
    expect(t!.state).toBe(state);
    expect(t!.live).toBe(live);
  });

  test.each(['- [!] important', '- [?] question', '- [*] star', '- [p] x'])(
    'non-5-set glyph is not a task: %s',
    (line) => {
      expect(parseTaskLine(line)).toBeNull();
    },
  );

  test.each(['plain text', '- bullet, no checkbox', '> quote', '  - [ ]extra'])(
    'non-task line returns null: %s',
    (line) => {
      expect(parseTaskLine(line)).toBeNull();
    },
  );

  test('accepts *, + and indented markers', () => {
    expect(parseTaskLine('* [ ] star marker')!.text).toBe('star marker');
    expect(parseTaskLine('+ [ ] plus marker')!.text).toBe('plus marker');
    expect(parseTaskLine('\t- [x] indented')!.state).toBe('done');
  });
});

describe('parseTaskLine — block id (§3.2, D5)', () => {
  test('extracts a trailing block id and removes it from text', () => {
    const t = parseTaskLine('- [ ] Write doc ^iam');
    expect(t!.blockId).toBe('iam');
    expect(t!.text).toBe('Write doc');
  });

  test('allows hyphens and digits', () => {
    expect(parseTaskLine('- [ ] x ^standup-0616')!.blockId).toBe('standup-0616');
  });

  test('does NOT capture a #^id that sits inside [[ ]]', () => {
    const t = parseTaskLine('- [>] foo [[2026-06-16#^iam]] ^iam');
    expect(t!.blockId).toBe('iam');
    expect(t!.text).toBe('foo [[2026-06-16#^iam]]');
  });

  test('a caret mid-word is not a block id', () => {
    const t = parseTaskLine('- [ ] super^script stays prose');
    expect(t!.blockId).toBeNull();
    expect(t!.text).toBe('super^script stays prose');
  });
});

describe('parseTaskLine — importance (! / !! / !!!)', () => {
  test('a space-separated trailing ! is importance tier 1', () => {
    const t = parseTaskLine('- [ ] Renew passport !');
    expect(t!.text).toBe('Renew passport');
    expect(t!.tokens).toEqual([{ kind: 'importance', raw: '!', tier: 1 }]);
  });

  test('!! and !!! are tiers 2 and 3', () => {
    expect(parseTaskLine('- [ ] x !!')!.tokens[0]).toMatchObject({ kind: 'importance', tier: 2 });
    expect(parseTaskLine('- [ ] x !!!')!.tokens[0]).toMatchObject({ kind: 'importance', tier: 3 });
  });

  test('importance combines with block id and survives id stripping', () => {
    const t = parseTaskLine('- [/] Ship CouchDB container !!  ^cdb');
    expect(t!.blockId).toBe('cdb');
    expect(t!.text).toBe('Ship CouchDB container');
    expect(t!.tokens[0]).toMatchObject({ kind: 'importance', tier: 2 });
  });

  test('an ! attached to a word (no space) stays prose', () => {
    const t = parseTaskLine('- [ ] Call mom!');
    expect(t!.tokens).toEqual([]);
    expect(t!.text).toBe('Call mom!');
  });

  test('a mid-line ! stays prose', () => {
    const t = parseTaskLine('- [ ] Fix bug! then test');
    expect(t!.tokens).toEqual([]);
    expect(t!.text).toBe('Fix bug! then test');
  });
});

describe('parseTaskLine — estimate (~)', () => {
  test.each([
    ['- [ ] x ~2h', 120],
    ['- [ ] x ~30m', 30],
    ['- [ ] x ~1h30m', 90],
    ['- [ ] x ~45m', 45],
  ] as const)('%s -> %i minutes', (line, minutes) => {
    expect(parseTaskLine(line)!.tokens[0]).toMatchObject({ kind: 'estimate', minutes });
  });

  test('importance + estimate keep source order', () => {
    const t = parseTaskLine('- [ ] Write doc !! ~2h ^iam');
    expect(t!.blockId).toBe('iam');
    expect(t!.text).toBe('Write doc');
    expect(t!.tokens.map((x) => x.kind)).toEqual(['importance', 'estimate']);
    expect(t!.tokens[1]).toMatchObject({ minutes: 120 });
  });

  test('fractional ~1.5h is unsupported and stays prose', () => {
    const t = parseTaskLine('- [ ] x ~1.5h');
    expect(t!.tokens).toEqual([]);
    expect(t!.text).toBe('x ~1.5h');
  });
});

describe('parseTaskLine — dates', () => {
  test('due date *YYYY-MM-DD', () => {
    const t = parseTaskLine('- [ ] Renew passport *2026-06-20');
    expect(t!.text).toBe('Renew passport');
    expect(t!.tokens[0]).toMatchObject({ kind: 'due', date: '2026-06-20' });
  });

  test('done date done:YYYY-MM-DD', () => {
    const t = parseTaskLine('- [x] Pickup car done:2026-06-16');
    expect(t!.tokens[0]).toMatchObject({ kind: 'done', date: '2026-06-16' });
  });

  test('a [x] without done: is valid and tokenless (read-only, legacy)', () => {
    const t = parseTaskLine('- [x] legacy done task');
    expect(t!.state).toBe('done');
    expect(t!.tokens).toEqual([]);
    expect(t!.text).toBe('legacy done task');
  });
});

describe('parseTaskLine — wikilink tokens (project / from / moved)', () => {
  test('project override :[[X]]', () => {
    const t = parseTaskLine('- [ ] Fix thing :[[Network]]');
    expect(t!.text).toBe('Fix thing');
    expect(t!.tokens[0]).toMatchObject({ kind: 'project', project: 'Network' });
  });

  test('project name may contain spaces (bracket-aware scan)', () => {
    const t = parseTaskLine('- [ ] Doc :[[ZeroedIn Bedrock Migration]]');
    expect(t!.tokens[0]).toMatchObject({ kind: 'project', project: 'ZeroedIn Bedrock Migration' });
    expect(t!.text).toBe('Doc');
  });

  test('from backref, plain origin note', () => {
    const t = parseTaskLine('- [ ] x from:[[Personal]]');
    expect(t!.tokens[0]).toMatchObject({ kind: 'from', note: 'Personal', blockId: null });
  });

  test('from backref to a recurrence template carries #^id', () => {
    const t = parseTaskLine('- [ ] standup from:[[Recurring#^standup]] ^standup-0616');
    expect(t!.blockId).toBe('standup-0616');
    expect(t!.tokens[0]).toMatchObject({ kind: 'from', note: 'Recurring', blockId: 'standup' });
  });

  test('moved pointer keeps note+#^id, and the trailing block id is separate (D5)', () => {
    const t = parseTaskLine('- [>] Write doc moved:[[2026-06-16#^iam]] ^iam');
    expect(t!.blockId).toBe('iam');
    expect(t!.tokens[0]).toMatchObject({ kind: 'moved', note: '2026-06-16', blockId: 'iam' });
    expect(t!.text).toBe('Write doc');
  });

  test('full move-target line: importance + estimate + from + id in source order', () => {
    const t = parseTaskLine(
      '- [ ] Write Bedrock IAM policy doc !! ~2h  from:[[ZeroedIn Bedrock Migration]]  ^iam',
    );
    expect(t!.blockId).toBe('iam');
    expect(t!.text).toBe('Write Bedrock IAM policy doc');
    expect(t!.tokens.map((x) => x.kind)).toEqual(['importance', 'estimate', 'from']);
  });

  test('an inline [[wikilink]] in prose is NOT a project token', () => {
    const t = parseTaskLine('- [ ] Review [[ZI AI Digest 5]] before Monday');
    expect(t!.tokens).toEqual([]);
    expect(t!.text).toBe('Review [[ZI AI Digest 5]] before Monday');
  });

  test('a bare trailing [[wikilink]] (no colon) is prose, not a project', () => {
    const t = parseTaskLine('- [>] [[ZI AI Digest 5]]');
    expect(t!.tokens).toEqual([]);
    expect(t!.text).toBe('[[ZI AI Digest 5]]');
  });
});

describe('parseTaskLine — recurrence (&) and tags (#)', () => {
  test('recurrence &daily is parsed (inert)', () => {
    const t = parseTaskLine('- [ ] Daily standup notes &daily ^standup');
    expect(t!.blockId).toBe('standup');
    expect(t!.text).toBe('Daily standup notes');
    expect(t!.tokens[0]).toMatchObject({ kind: 'recurrence', rule: 'daily' });
  });

  test('&mon weekday recurrence', () => {
    expect(parseTaskLine('- [ ] gym &mon')!.tokens[0]).toMatchObject({ kind: 'recurrence', rule: 'mon' });
  });

  test('collects inline #tags and keeps them in prose', () => {
    const t = parseTaskLine('- [ ] Plan #work trip #travel');
    expect(t!.tags).toEqual(['work', 'travel']);
    expect(t!.text).toBe('Plan #work trip #travel');
  });

  test('no tags -> empty array', () => {
    expect(parseTaskLine('- [ ] nothing here')!.tags).toEqual([]);
  });
});
