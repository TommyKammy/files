import { describe, expect, it } from 'vitest';
import {
  buildWopiSrc,
  clearWopiDiscoveryCacheForTests,
  getWopiDiscovery,
  parseWopiDiscoveryXml,
  resolveWopiActionUrl,
} from '../src/services/wopi-discovery';

const DISCOVERY_XML = `<?xml version="1.0" encoding="utf-8"?>
<wopi-discovery>
  <net-zone name="external-http">
    <app name="writer">
      <action name="view" ext="docx" urlsrc="https://collabora.example.com/browser/dist/cool.html?WOPISrc="/>
      <action name="edit" ext="docx" urlsrc="https://collabora.example.com/browser/dist/cool.html?WOPISrc="/>
    </app>
    <app name="calc">
      <action name="edit" ext="xlsx" urlsrc="https://collabora.example.com/browser/dist/cool.html?WOPISrc=&amp;lang=ja"/>
    </app>
  </net-zone>
</wopi-discovery>`;

describe('WOPI discovery parser and action URL resolution', () => {
  it('parses Collabora discovery actions and XML entities', () => {
    const actions = parseWopiDiscoveryXml(DISCOVERY_XML);
    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({
      appName: 'writer',
      name: 'view',
      extension: 'docx',
    });
    expect(actions[2].urlsrc).toContain('&lang=ja');
  });

  it('selects edit for writers and view for read-only sessions', () => {
    const actions = parseWopiDiscoveryXml(DISCOVERY_XML);
    const wopiSrc = 'https://files.example.com/wopi/files/file-1';

    expect(
      resolveWopiActionUrl(actions, {
        extension: '.docx',
        canWrite: true,
        wopiSrc,
      })
    ).toContain('https://collabora.example.com/browser/dist/cool.html');
    expect(
      resolveWopiActionUrl(actions, {
        extension: 'docx',
        canWrite: true,
        wopiSrc,
      })
    ).toBe(
      `https://collabora.example.com/browser/dist/cool.html?WOPISrc=${encodeURIComponent(wopiSrc)}`
    );
    expect(
      resolveWopiActionUrl(actions, {
        extension: 'docx',
        canWrite: false,
        wopiSrc,
      })
    ).toContain('WOPISrc=');
    expect(
      resolveWopiActionUrl(actions, {
        extension: 'pdf',
        canWrite: true,
        wopiSrc,
      })
    ).toBeNull();
  });

  it('caches discovery responses and builds an absolute WOPI source URL', async () => {
    clearWopiDiscoveryCacheForTests();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(DISCOVERY_XML, { status: 200 });
    }) as typeof fetch;

    const first = await getWopiDiscovery(
      { COLLABORA_URL: 'https://collabora.example.com/' },
      { fetchImpl }
    );
    const second = await getWopiDiscovery(
      { COLLABORA_URL: 'https://collabora.example.com/' },
      { fetchImpl }
    );
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    expect(calls).toBe(1);

    expect(
      buildWopiSrc(
        { WOPI_HOST_ORIGIN: 'https://files.example.com' },
        'file with spaces'
      )
    ).toBe('https://files.example.com/wopi/files/file%20with%20spaces');
  });
});
