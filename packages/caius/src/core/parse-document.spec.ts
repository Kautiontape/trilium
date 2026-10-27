import { describe, expect, test } from 'vitest';
import { parseDocument } from './parse-document.js';

describe('parseDocument — flat tasks', () => {
  test('sequential top-level tasks get line numbers and null parent', () => {
    const tasks = parseDocument('- [ ] one\n- [/] two');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ text: 'one', line: 0, indent: 0, parentLine: null });
    expect(tasks[1]).toMatchObject({ text: 'two', line: 1, parentLine: null });
  });

  test('non-task lines between tasks are ignored at top level', () => {
    const tasks = parseDocument('# Heading\n- [ ] one\n\nsome prose\n- [ ] two');
    expect(tasks.map((t) => t.text)).toEqual(['one', 'two']);
    expect(tasks[1]!.line).toBe(4);
  });
});

describe('parseDocument — nesting (§3.6)', () => {
  const doc = [
    '- [ ] Build the SQLite watcher  ^watch',
    '    - [ ] Decide on FS-event library',
    '    - [ ] Handle rename events',
    '    - this is just a note, freeform context',
    '    > see the parser notes before starting',
  ].join('\n');

  test('checkbox children are subtasks parented to the enclosing task', () => {
    const tasks = parseDocument(doc);
    expect(tasks.map((t) => t.text)).toEqual([
      'Build the SQLite watcher',
      'Decide on FS-event library',
      'Handle rename events',
    ]);
    expect(tasks[0]).toMatchObject({ blockId: 'watch', parentLine: null });
    expect(tasks[1]!.parentLine).toBe(0);
    expect(tasks[2]!.parentLine).toBe(0);
  });

  test('non-checkbox children attach as notes on the enclosing task', () => {
    const tasks = parseDocument(doc);
    expect(tasks[0]!.notes).toEqual([
      '- this is just a note, freeform context',
      '> see the parser notes before starting',
    ]);
    expect(tasks[1]!.notes).toEqual([]);
  });

  test('a nested non-5-set glyph is a note, not a task (D1)', () => {
    const tasks = parseDocument(['- [ ] parent ^p', '    - [!] not a task', '    - [ ] real sub'].join('\n'));
    expect(tasks.map((t) => t.text)).toEqual(['parent', 'real sub']);
    expect(tasks[0]!.notes).toEqual(['- [!] not a task']);
    expect(tasks[1]!.parentLine).toBe(0);
  });

  test('a tab-indented child (tab_width=4) parents correctly', () => {
    const tasks = parseDocument('- [ ] parent ^p\n\t- [ ] tabbed child');
    expect(tasks[1]).toMatchObject({ text: 'tabbed child', parentLine: 0 });
  });

  test('dedent closes children: a shallower task re-parents to top level', () => {
    const tasks = parseDocument(['- [ ] a ^a', '    - [ ] a1', '- [ ] b ^b'].join('\n'));
    expect(tasks.find((t) => t.text === 'a1')!.parentLine).toBe(0);
    expect(tasks.find((t) => t.text === 'b')!.parentLine).toBeNull();
  });

  test('a blank line inside a block does not break nesting', () => {
    const tasks = parseDocument('- [ ] a ^a\n\n    - [ ] a1');
    expect(tasks.find((t) => t.text === 'a1')!.parentLine).toBe(0);
  });

  test('a deeper note attaches to the nearest enclosing task, not a sibling', () => {
    const tasks = parseDocument(
      ['- [ ] a ^a', '    - [ ] a1', '        deep note under a1'].join('\n'),
    );
    expect(tasks.find((t) => t.text === 'a1')!.notes).toEqual(['deep note under a1']);
    expect(tasks.find((t) => t.text === 'a')!.notes).toEqual([]);
  });
});
