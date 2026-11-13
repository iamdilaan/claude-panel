import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

// api.ts lee window/document (y quizá location/sessionStorage) al importarse
const g = globalThis as Record<string, unknown>;
g.window ??= g;
g.document ??= { querySelector: () => null };
g.location ??= { hash: '', pathname: '/', search: '' };
g.history ??= { replaceState() {} };
g.sessionStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

type CardMod = typeof import('../src/Card.tsx');
let Card: CardMod['Card'];
beforeAll(async () => {
  ({ Card } = await import('../src/Card.tsx'));
});

const session = (pr_links: string[]) => ({
  session_id: '11111111-2222-3333-4444-555555555555', title: 't', display_project: 'p', project_name: 'p',
  project_kind: 'git', cwd: '/tmp/p', cwd_display: '/tmp/p', launch_cwd_display: null, entrypoint: 'cli',
  status: 'closed', status_source: null, started_at: null, last_activity_at: null, message_count: 1,
  pr_links, summary: { kind: 'none' }, summary_error: null, user_note: null, first_prompt: null,
  last_prompt: null, pinned: 0, archived: 0, transcript_present: 1, resume_blocked: null, has_archive: false,
});
const act = { notify() {}, replace() {}, refresh() {} };

function render(links: string[]): string {
  return renderToStaticMarkup(createElement(Card, { s: session(links) as never, git: null, act: act as never, compact: false }));
}
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);

describe('Card: enlaces de PR', () => {
  it('enlaza un PR de github.com por https con su número', () => {
    const html = render(['https://github.com/o/app/pull/42']);
    expect(hrefs(html)).toEqual(['https://github.com/o/app/pull/42']);
    expect(html).toContain('PR #42');
  });

  // filas antiguas de la DB pueden traer enlaces guardados antes de validar
  for (const u of [
    'javascript:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'http://github.com/o/app/pull/7',
    'https://evil.example/x/pull/42',
    'https://user:pw@github.com/o/app/pull/7',
  ]) {
    it(`no enlaza ${u}`, () => {
      const html = render([u]);
      expect(hrefs(html)).toEqual([]);
      expect(html).not.toContain('PR #');
      expect(html).not.toContain('<script>');
    });
  }

  it('si el último enlace no vale, muestra el último válido', () => {
    const html = render(['https://github.com/o/app/pull/7', 'https://evil.example/x/pull/42']);
    expect(hrefs(html)).toEqual(['https://github.com/o/app/pull/7']);
  });
});
