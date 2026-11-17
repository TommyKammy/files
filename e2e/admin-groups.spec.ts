import { expect, test } from './fixtures';

interface ScimGroupResponse {
  id: string;
  displayName: string;
}

interface ScimTokenListResponse {
  tokens: Array<{
    id: string;
    name: string;
    status: 'active' | 'revoked';
  }>;
}

test.describe('グループ管理 & SCIM トークン管理 (P11-3 / TOM-69)', () => {
  test('sys_admin がグループ CRUD・メンバー管理・SCIM 保護・トークン発行/ローテーション/失効を実行する', async ({
    as,
  }) => {
    test.setTimeout(240_000);
    const admin = await as('sys_admin');
    const page = admin.page;
    const suffix = crypto.randomUUID().slice(0, 8);
    const groupName = `E2E グループ ${suffix}`;
    const scimGroupName = `E2E SCIM グループ ${suffix}`;
    const tokenName = `E2E SCIM トークン ${suffix}`;
    const issuer = `https://idp-${suffix}.example.com`;

    await page.goto('/admin/users');
    await expect(page.getByTestId('admin-tab-members')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.getByTestId('admin-members-section')).toBeVisible();
    await expect(page.getByTestId('admin-guests-section')).toHaveCount(0);
    await expect(page.getByTestId('admin-scim-tokens-section')).toHaveCount(0);

    await page.getByTestId('admin-tab-groups').click();
    await expect(page.getByTestId('admin-tabpanel-groups')).toBeVisible();

    const groups = page.getByTestId('admin-groups-section');
    const tokens = page.getByTestId('admin-scim-tokens-section');
    await expect(groups).toBeVisible();
    await expect(tokens).toHaveCount(0);
    await expect(groups.getByTestId('group-rbac-notice')).toContainText(
      'SCIM 同期グループ'
    );

    // The group console links straight to the Integrations tab where SCIM
    // token management now lives.
    const integrationLink = groups.getByTestId('group-scim-integration-link');
    await expect(integrationLink).toBeVisible();
    await expect(integrationLink).toHaveAttribute(
      'href',
      '/admin/settings?tab=integrations'
    );

    // Manual group creation.
    await groups.getByTestId('group-open-create').click();
    const createModal = page.getByTestId('group-create-modal');
    await expect(createModal).toBeVisible();
    await createModal.getByTestId('group-create-name').fill(groupName);
    await createModal.getByTestId('group-create-submit').click();
    await expect(createModal.getByTestId('group-create-result')).toContainText(
      '作成しました'
    );
    await createModal.getByTestId('group-create-close').click();

    // Search + filter + detail.
    await groups.getByTestId('group-filter-query').fill(groupName);
    await groups.getByTestId('group-filter-apply').click();
    const row = groups
      .locator('[data-testid="admin-group-row"]')
      .filter({ hasText: groupName });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('group-source-badge')).toHaveText('手動');
    await expect(row).toContainText('0 人');
    await expect(row).toContainText('0 件');

    await row.getByTestId('group-open-detail').click();
    const detail = page.getByTestId('group-detail-modal');
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId('group-detail-members-empty')).toContainText(
      '所属メンバーはいません'
    );
    await expect(
      detail.getByTestId('group-detail-permissions-empty')
    ).toBeVisible();

    // Add + remove an internal member.
    const memberSelect = detail.getByTestId('group-member-add-select');
    await expect(
      memberSelect.locator('option[value="dev-member-001"]')
    ).toHaveCount(1);
    await memberSelect.selectOption('dev-member-001');
    await detail.getByTestId('group-member-add-submit').click();
    const memberRow = detail
      .locator('[data-testid="group-detail-member-row"]')
      .filter({ hasText: 'dev-member@example.com' });
    await expect(memberRow).toHaveCount(1);
    await expect(memberRow).toContainText('Dev Member');
    await memberRow.getByTestId('group-member-remove').click();
    await expect(detail.getByTestId('group-detail-members-empty')).toContainText(
      '所属メンバーはいません'
    );
    await detail.getByTestId('group-detail-close').click();

    // Follow the group console shortcut to the Integrations tab.
    await integrationLink.click();
    await expect(page).toHaveURL(/\/admin\/settings\?tab=integrations$/);
    await expect(page.getByTestId('admin-tabpanel-integrations')).toBeVisible();
    await expect(tokens).toBeVisible();
    await expect(tokens.getByTestId('scim-token-rbac-notice')).toContainText(
      '1 回だけ'
    );
    await expect(tokens.getByTestId('scim-endpoint-base-url')).toContainText(
      '/scim/v2'
    );

    // Issue a SCIM token and verify the one-time plaintext.
    await tokens.getByTestId('scim-token-open-create').click();
    const tokenCreate = page.getByTestId('scim-token-create-modal');
    await expect(tokenCreate).toBeVisible();
    await tokenCreate.getByTestId('scim-token-create-name').fill(tokenName);
    await tokenCreate.getByTestId('scim-token-create-issuer').fill(issuer);
    await tokenCreate.getByTestId('scim-token-create-submit').click();

    const oneTime = page.getByTestId('scim-token-onetime-dialog');
    await expect(oneTime).toBeVisible();
    const firstToken = await oneTime
      .getByTestId('scim-token-onetime-value')
      .inputValue();
    expect(firstToken).toMatch(/^scim_/);
    await oneTime.getByTestId('scim-token-onetime-close').click();
    await expect(oneTime).toHaveCount(0);

    const tokenRow = tokens
      .locator('[data-testid="scim-token-row"]')
      .filter({ hasText: tokenName });
    await expect(tokenRow).toHaveCount(1);
    await expect(tokenRow.getByTestId('scim-token-status')).toHaveText('有効');
    await expect(tokenRow.getByTestId('scim-token-last-used')).toHaveText(
      '未使用'
    );

    const firstAuth = await admin.api.get('/scim/v2/Users', {
      headers: { Authorization: `Bearer ${firstToken}` },
    });
    expect(firstAuth.status()).toBe(200);
    await tokens.getByTestId('scim-token-refresh').click();
    await expect(tokenRow.getByTestId('scim-token-last-used')).not.toHaveText(
      '未使用'
    );

    // SCIM-provisioned groups are read-only in the console.
    const scimGroupResponse = await admin.api.post('/scim/v2/Groups', {
      headers: { Authorization: `Bearer ${firstToken}` },
      data: {
        displayName: scimGroupName,
        externalId: `scim-ext-${suffix}`,
      },
    });
    expect(scimGroupResponse.status()).toBe(201);
    const scimGroup = (await scimGroupResponse.json()) as ScimGroupResponse;

    await page.goto('/admin/users?tab=groups');
    await expect(groups).toBeVisible();
    await groups.getByTestId('group-filter-query').fill(scimGroupName);
    await groups.getByTestId('group-filter-apply').click();
    const scimRow = groups
      .locator('[data-testid="admin-group-row"]')
      .filter({ hasText: scimGroupName });
    await expect(scimRow).toHaveCount(1);
    await expect(scimRow.getByTestId('group-source-badge')).toHaveText(
      'SCIM 同期'
    );
    await scimRow.getByTestId('group-open-detail').click();
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId('group-detail-scim-notice')).toContainText(
      'IdP 側で行ってください'
    );
    await expect(detail.getByTestId('group-rename-submit')).toBeDisabled();
    await expect(detail.getByTestId('group-delete-open')).toBeDisabled();
    await expect(detail.getByTestId('group-member-add-submit')).toBeDisabled();
    await detail.getByTestId('group-detail-close').click();

    const scimDelete = await admin.api.delete(`/scim/v2/Groups/${scimGroup.id}`, {
      headers: { Authorization: `Bearer ${firstToken}` },
    });
    expect(scimDelete.status()).toBe(204);

    // Back to the Integrations tab for token rotation/revocation.
    await page.goto('/admin/settings?tab=integrations');
    await expect(tokens).toBeVisible();

    // Rotate: old token must be rejected, new token accepted.
    await tokenRow.getByTestId('scim-token-rotate-action').click();
    const confirm = page.getByTestId('scim-token-confirm-modal');
    await expect(confirm.getByTestId('scim-token-confirm-title')).toContainText(
      'ローテーションしますか'
    );
    await confirm.getByTestId('scim-token-confirm-execute').click();
    await expect(oneTime).toBeVisible();
    const rotatedToken = await oneTime
      .getByTestId('scim-token-onetime-value')
      .inputValue();
    expect(rotatedToken).toMatch(/^scim_/);
    expect(rotatedToken).not.toBe(firstToken);
    await oneTime.getByTestId('scim-token-onetime-close').click();

    const oldAuth = await admin.api.get('/scim/v2/Users', {
      headers: { Authorization: `Bearer ${firstToken}` },
    });
    expect(oldAuth.status()).toBe(401);
    const newAuth = await admin.api.get('/scim/v2/Users', {
      headers: { Authorization: `Bearer ${rotatedToken}` },
    });
    expect(newAuth.status()).toBe(200);

    const tokenListResponse = await admin.api.get('/api/admin/scim-tokens');
    expect(tokenListResponse.status()).toBe(200);
    const tokenList = (await tokenListResponse.json()) as ScimTokenListResponse;
    const activeToken = tokenList.tokens.find(
      (token) => token.name === tokenName && token.status === 'active'
    );
    expect(activeToken).toBeTruthy();

    await tokens.getByTestId('scim-token-refresh').click();
    const activeRow = tokens.locator(
      `[data-testid="scim-token-row"][data-token-id="${activeToken?.id}"]`
    );
    await expect(activeRow).toHaveCount(1);
    await activeRow.getByTestId('scim-token-revoke-action').click();
    await expect(confirm.getByTestId('scim-token-confirm-title')).toContainText(
      '失効しますか'
    );
    await confirm.getByTestId('scim-token-confirm-execute').click();
    await expect(tokens.getByTestId('scim-token-notice')).toContainText(
      '失効させました'
    );
    await expect(activeRow.getByTestId('scim-token-status')).toHaveText(
      '失効済み'
    );
    const revokedAuth = await admin.api.get('/scim/v2/Users', {
      headers: { Authorization: `Bearer ${rotatedToken}` },
    });
    expect(revokedAuth.status()).toBe(401);

    // Delete the manual group through the console.
    await page.goto('/admin/users?tab=groups');
    await expect(groups).toBeVisible();
    await groups.getByTestId('group-filter-query').fill(groupName);
    await groups.getByTestId('group-filter-apply').click();
    const reloadedRow = groups
      .locator('[data-testid="admin-group-row"]')
      .filter({ hasText: groupName });
    await expect(reloadedRow).toHaveCount(1);
    await reloadedRow.getByTestId('group-open-detail').click();
    await detail.getByTestId('group-delete-open').click();
    const deleteModal = page.getByTestId('group-delete-modal');
    await expect(deleteModal).toBeVisible();
    await deleteModal.getByTestId('group-delete-confirm').click();
    await expect(groups.getByTestId('group-notice')).toContainText(
      '削除しました'
    );
    await expect(reloadedRow).toHaveCount(0);
  });

  test('sec_admin はグループと SCIM トークンを閲覧できるが変更操作は無効', async ({
    as,
  }) => {
    const sec = await as('sec_admin');
    const page = sec.page;

    await page.goto('/admin/users');
    const groups = page.getByTestId('admin-groups-section');
    await expect(page.getByTestId('admin-tab-members')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.getByTestId('admin-members-section')).toBeVisible();
    await expect(page.getByTestId('admin-guests-section')).toHaveCount(0);

    await page.getByTestId('admin-tab-groups').click();
    await expect(groups).toBeVisible();
    await expect(page.getByTestId('admin-scim-tokens-section')).toHaveCount(0);

    await expect(groups.getByTestId('group-rbac-notice')).toContainText(
      'sys_admin 専用'
    );
    await expect(groups.getByTestId('group-open-create')).toBeDisabled();

    const integrationLink = groups.getByTestId('group-scim-integration-link');
    await expect(integrationLink).toHaveAttribute(
      'href',
      '/admin/settings?tab=integrations'
    );

    // Seeded manual group detail is read-only for sec_admin.
    await groups.getByTestId('group-filter-query').fill('E2E Collaborators');
    await groups.getByTestId('group-filter-apply').click();
    const groupRow = groups
      .locator('[data-testid="admin-group-row"]')
      .filter({ hasText: 'E2E Collaborators' });
    await expect(groupRow).toHaveCount(1);
    await groupRow.getByTestId('group-open-detail').click();
    const detail = page.getByTestId('group-detail-modal');
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId('group-detail-readonly')).toContainText(
      '閲覧のみ'
    );
    await expect(detail.getByTestId('group-rename-name')).toBeDisabled();
    await expect(detail.getByTestId('group-rename-submit')).toBeDisabled();
    await expect(detail.getByTestId('group-delete-open')).toBeDisabled();
    await expect(detail.getByTestId('group-member-add-submit')).toBeDisabled();
    await detail.getByTestId('group-detail-close').click();

    // SCIM tokens are read-only for sec_admin on the Integrations tab.
    await integrationLink.click();
    await expect(page).toHaveURL(/\/admin\/settings\?tab=integrations$/);
    const tokens = page.getByTestId('admin-scim-tokens-section');
    await expect(tokens).toBeVisible();
    await expect(tokens.getByTestId('scim-token-rbac-notice')).toContainText(
      'sys_admin 専用'
    );
    await expect(tokens.getByTestId('scim-token-open-create')).toBeDisabled();

    // Seeded SCIM token row is visible but its actions are disabled.
    const tokenRow = tokens
      .locator('[data-testid="scim-token-row"]')
      .first();
    await expect(tokenRow).toBeVisible();
    await expect(tokenRow.getByTestId('scim-token-rotate-action')).toBeDisabled();
    await expect(tokenRow.getByTestId('scim-token-revoke-action')).toBeDisabled();
    await expect(tokenRow.getByTestId('scim-token-status')).toHaveText(/有効|失効済み/);
  });
});
