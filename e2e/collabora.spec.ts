import { expect, test, type APIResponse } from '@playwright/test';

const collaboraOrigin =
  process.env.E2E_COLLABORA_URL ?? 'http://localhost:9980';

test.describe('@collabora Collabora Online integration', () => {
  test('@collabora WOPI discovery が到達可能で docx edit アクションを公開する', async ({
    request,
  }) => {
    let response: APIResponse;
    try {
      response = await request.get(
        `${collaboraOrigin}/hosting/discovery`,
        { timeout: 10_000 }
      );
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error))
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) ?? 'unknown connection error';
      throw new Error(
        `Collabora Online に接続できませんでした: ${collaboraOrigin}/hosting/discovery (${reason}). ` +
          'Collabora コンテナを起動してから再実行してください: ' +
          'docker compose -f docker-compose.collabora.yml up -d'
      );
    }

    expect(
      response.ok(),
      `GET ${collaboraOrigin}/hosting/discovery failed with HTTP ${response.status()}. ` +
        'Collabora コンテナが起動しているか確認してください: ' +
        'docker compose -f docker-compose.collabora.yml up -d'
    ).toBe(true);

    const xml = await response.text();
    expect(xml).toContain('<wopi-discovery');
    expect(xml).toContain('<net-zone');

    const actionTags = [...xml.matchAll(/<action\b[^>]*>/gi)].map(
      (match) => match[0]
    );
    expect(actionTags.length).toBeGreaterThan(0);
    expect(
      actionTags.some(
        (tag) => /name="edit"/i.test(tag) && /ext="docx"/i.test(tag)
      ),
      'Collabora discovery must advertise an editable docx action'
    ).toBe(true);
    expect(
      actionTags.some(
        (tag) => /name="view"/i.test(tag) && /ext="docx"/i.test(tag)
      ),
      'Collabora discovery must advertise a viewable docx action'
    ).toBe(true);
  });
});
