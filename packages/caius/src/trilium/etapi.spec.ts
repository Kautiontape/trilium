import { describe, it, expect, afterEach, vi } from 'vitest';
import { etapiClient, normalizeBaseUrl } from './etapi.js';

afterEach(() => vi.unstubAllGlobals());

describe('base URL', () => {
  it('keeps plain http and https URLs, trims slashes, and defaults a bare host to https', () => {
    expect(normalizeBaseUrl('http://localhost:37840/')).toBe('http://localhost:37840');
    expect(normalizeBaseUrl('https://t.example')).toBe('https://t.example');
    expect(normalizeBaseUrl('t.example')).toBe('https://t.example');
  });

  it('calls the given http URL with the token in the Authorization header only', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ noteId: 'n', attributes: [] }), { status: 200 });
    });
    const api = etapiClient('http://localhost:37840', 'secret');
    await api.note('abc');
    await api.addLabel('abc', 'caiusDismissed', 'ZAP-1');
    await api.calendarWeek('2026-W44');
    expect(calls.map((c) => c.url)).toEqual([
      'http://localhost:37840/etapi/notes/abc',
      'http://localhost:37840/etapi/attributes',
      'http://localhost:37840/etapi/calendar/weeks/2026-W44',
    ]);
    expect(calls.every((c) => (c.init?.headers as Record<string, string>).Authorization === 'Bearer secret')).toBe(true);
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ noteId: 'abc', type: 'label', name: 'caiusDismissed', value: 'ZAP-1', isInheritable: false });
    expect(calls.some((c) => c.url.includes('secret'))).toBe(false);
  });

  it('puts content with an expected value only while the note still holds it', async () => {
    const calls: string[] = [];
    let stored = '<p>now</p>';
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'PUT') stored = init.body as string;
      return new Response(init?.method === 'PUT' ? null : stored, { status: init?.method === 'PUT' ? 204 : 200 });
    });
    const api = etapiClient('http://h', 't');
    expect(await api.putContent('n', '<p>new</p>', '<p>was</p>')).toBe(false);
    expect(stored).toBe('<p>now</p>');
    expect(await api.putContent('n', '<p>new</p>', '<p>now</p>')).toBe(true);
    expect(stored).toBe('<p>new</p>');
    expect(calls).toEqual(['GET http://h/etapi/notes/n/content', 'GET http://h/etapi/notes/n/content', 'PUT http://h/etapi/notes/n/content']);
  });
});

describe('write headers against a server that mimics express.text() and express.json()', () => {
  it('PUT content is text/plain and arrives intact; labels are JSON; wrong types are rejected', async () => {
    const { createServer } = await import('node:http');
    const seen: { method?: string; url?: string; type?: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const type = (req.headers['content-type'] ?? '').split(';')[0];
        seen.push({ method: req.method, url: req.url, type, body });
        const isPut = req.method === 'PUT';
        const ok = isPut ? type === 'text/plain' : type === 'application/json';
        res.statusCode = ok ? (isPut ? 204 : 201) : 500; // express.text/json leave a null body otherwise
        res.end(ok ? undefined : 'Cannot set null content');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
      const api = etapiClient(`http://127.0.0.1:${port}`, 'tok');
      await api.putContent('n1', '<p>é</p>');
      await api.addLabel('n1', 'caiusDismissed', 'ZAP-1');
      expect(seen.map((s) => [s.method, s.url, s.type])).toEqual([
        ['PUT', '/etapi/notes/n1/content', 'text/plain'],
        ['POST', '/etapi/attributes', 'application/json'],
      ]);
      expect(seen[0]!.body).toBe('<p>é</p>');
    } finally {
      server.close();
    }
  });
});
