import { describe, expect, it } from 'vitest';
import { briefBodyHtml, headerHtml, includeNote, leadingInclude, readHeader, withInclude, withoutImages } from './brief-html.js';

const INCLUDE = '<section class="include-note" data-note-id="hdr" data-box-size="full">&nbsp;</section>';

describe('withInclude', () => {
  it('puts the include-note at the very top once, leaving every other byte', () => {
    const day = '<h3>Meetings</h3><ul><li>10:00 Standup</li></ul><h2>☑️ Tasks</h2>';
    expect(includeNote('hdr')).toBe(INCLUDE);
    const once = withInclude(day, 'hdr');
    expect(once).toBe(INCLUDE + day);
    expect(withInclude(once, 'hdr')).toBe(once);
  });

  it('leaves a note that already includes the header anywhere, and adds it above another include-note', () => {
    const moved = `<p>x</p>${INCLUDE.replace('full', 'expandable')}`;
    expect(withInclude(moved, 'hdr')).toBe(moved);
    const other = INCLUDE.replace('hdr', 'old');
    expect(withInclude(other, 'hdr')).toBe(INCLUDE + other);
  });
});

describe('withInclude replacing a stale header', () => {
  it('replaces a leading include-note the caller calls stale, and only a leading one', () => {
    const day = '<h3>Meetings</h3><ul><li>10:00 Standup</li></ul>';
    const stale = includeNote('gone');
    expect(leadingInclude(stale + day)).toBe('gone');
    expect(leadingInclude(day)).toBeNull();
    expect(withInclude(stale + day, 'hdr', (id) => id === 'gone')).toBe(INCLUDE + day);
    expect(withInclude(stale + day, 'hdr', () => false)).toBe(INCLUDE + stale + day);
    expect(withInclude(`<p>x</p>${stale}`, 'hdr', () => true)).toBe(`${INCLUDE}<p>x</p>${stale}`);
  });
});

describe('headerHtml', () => {
  it('writes the date line, the headline, the drawing at the full width and the acts as a 3-column table, escaped', () => {
    const html = headerHtml({
      dateLine: 'Monday · November 9 2026',
      headline: 'Ship <the> fix & review',
      image: { src: 'api/attachments/a1/image/terrain.svg', alt: 'The day' },
      acts: [
        { range: '10:00 to 12:00', text: 'Standup, then the fix.' },
        { range: '12:00 to 18:00', text: 'Review & tests.' },
        { range: 'Evening', text: 'A walk.' },
      ],
    });
    expect(html).toBe(
      '<p>Monday · November 9 2026</p><h2>Ship &lt;the&gt; fix &amp; review</h2>'
      + '<p><img class="image_resized" style="width:100%;" src="api/attachments/a1/image/terrain.svg" alt="The day"></p>'
      + '<figure class="table"><table><tbody><tr>'
      + '<td><p><strong>10:00 to 12:00</strong></p><p>Standup, then the fix.</p></td>'
      + '<td><p><strong>12:00 to 18:00</strong></p><p>Review &amp; tests.</p></td>'
      + '<td><p><strong>Evening</strong></p><p>A walk.</p></td>'
      + '</tr></tbody></table></figure>',
    );
  });
  it('reads back what it wrote, unescaped, and nothing from a note that is not a header', () => {
    const header = {
      dateLine: 'Monday · November 9 2026',
      headline: 'Ship <the> fix & review',
      acts: [{ range: '10:00 to 12:00', text: 'Standup, then the fix.' }, { range: '12:00 to 18:00', text: 'Review & tests.' }, { range: 'Evening', text: 'A walk.' }],
    };
    expect(readHeader(headerHtml({ ...header, image: { src: 'x.svg', alt: 'The day' } }))).toEqual(header);
    expect(readHeader('<p>Just a note</p>')).toBeNull();
  });
});

describe('briefBodyHtml', () => {
  it('puts the header include first, the picks as plain bullets, then each section in order', () => {
    const html = briefBodyHtml({
      headerNoteId: 'hdr',
      picksTitle: 'Get done today',
      picks: ['Get ZAP-1 done: because it waits (~30m)', 'a < b'],
      sections: [
        { title: 'Follow up', html: '<p>Ask Sam.</p>' },
        { title: 'Heads-up', html: '<p>Shipped.</p>' },
      ],
    });
    expect(html).toBe(
      INCLUDE + '<h2>Get done today</h2><ul><li>Get ZAP-1 done: because it waits (~30m)</li><li>a &lt; b</li></ul>'
      + '<h2>Follow up</h2><p>Ask Sam.</p><h2>Heads-up</h2><p>Shipped.</p>',
    );
  });
});

describe('withoutImages', () => {
  it('takes out images and image figures and leaves the rest', () => {
    expect(withoutImages('<p>Seen <img src="https://tracker.example/p.png" alt=""> here.</p><figure class="image"><img src="x.png"><figcaption>c</figcaption></figure><p>End</p>'))
      .toBe('<p>Seen  here.</p><p>End</p>');
    expect(withoutImages('<p>No images</p>')).toBe('<p>No images</p>');
  });
});
