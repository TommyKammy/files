import { randomUUID } from 'node:crypto';
import { expect, test, DEV_USERS, type RoleSession } from './fixtures';
import { uniqueName } from './helpers/browser';

type FolderStructureMode = 'open' | 'closed';

interface AdminRootFolderLike {
  id: string;
  name: string;
  deletedAt: string | null;
  owners: Array<{
    granteeId: string;
    name: string;
    status: 'active' | 'suspended';
  }>;
  coOwners: Array<{
    granteeType: 'user' | 'group';
    granteeId: string;
    name: string;
  }>;
}

interface AdminRootFolderListLike {
  roots: AdminRootFolderLike[];
  summary: {
    folderStructureMode: FolderStructureMode;
    missingOwnerCount: number;
    suspendedOwnerCount: number;
  };
}

function token(): string {
  return `fsm${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

async function setFolderStructureMode(
  session: RoleSession,
  mode: FolderStructureMode
): Promise<void> {
  const response = await session.api.patch('/api/admin/policies', {
    data: { folderStructureMode: mode },
  });
  expect(
    response.status(),
    `PATCH folderStructureMode=${mode} should succeed`
  ).toBe(200);
}

async function createAdminRoot(
  session: RoleSession,
  name: string,
  options: { coOwnerGroupIds?: string[]; classification?: string } = {}
): Promise<AdminRootFolderLike> {
  const response = await session.api.post('/api/admin/root-folders', {
    data: {
      name,
      classification: options.classification ?? 'internal',
      ownerUserId: DEV_USERS.member.id,
      coOwnerGroupIds: options.coOwnerGroupIds ?? [],
    },
  });
  expect(response.status(), `POST /api/admin/root-folders ${name}`).toBe(201);
  const body = (await response.json()) as { root: AdminRootFolderLike };
  return body.root;
}

async function findAdminRoot(
  session: RoleSession,
  name: string
): Promise<AdminRootFolderLike | undefined> {
  const response = await session.api.get(
    `/api/admin/root-folders?search=${encodeURIComponent(name)}`
  );
  expect(response.status()).toBe(200);
  const body = (await response.json()) as AdminRootFolderListLike;
  return body.roots.find((root) => root.name === name);
}

async function waitForAdminRoot(
  session: RoleSession,
  name: string
): Promise<AdminRootFolderLike> {
  let found: AdminRootFolderLike | undefined;
  await expect
    .poll(
      async () => {
        found = await findAdminRoot(session, name);
        return Boolean(found);
      },
      { timeout: 15_000, message: `root folder "${name}" should exist` }
    )
    .toBe(true);
  return found!;
}

/**
 * Restores an archived root (if needed), hands ownership to sys_admin and lets
 * the shared cleanup fixture soft-delete the isolated root through real ACLs.
 */
async function handoffRootToSysAdmin(
  session: RoleSession,
  folderId: string | null
): Promise<void> {
  if (!folderId) return;
  await session.api
    .post(`/api/admin/root-folders/${encodeURIComponent(folderId)}/restore`)
    .catch(() => undefined);
  await session.api
    .post(
      `/api/admin/root-folders/${encodeURIComponent(folderId)}/transfer-owner`,
      { data: { newOwnerUserId: DEV_USERS.sys_admin.id } }
    )
    .catch(() => undefined);
}

async function choosePrincipal(
  page: RoleSession['page'],
  dialogLabel: string,
  inputId: string,
  listLabel: string,
  query: string,
  optionText: string
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: dialogLabel });
  await expect(dialog).toBeVisible();
  await dialog.locator(`#${inputId}`).fill(query);
  const listbox = dialog.getByRole('listbox', { name: listLabel });
  await expect(listbox).toBeVisible();
  await listbox
    .getByRole('option')
    .filter({ hasText: optionText })
    .first()
    .click();
}

test.describe('フォルダ構成モード & ルートフォルダ管理 (TOM-53)', () => {
  test('Flow A: sys_admin creates a root in /admin with member owner + SCIM group co-owner, switches to closed, and persists after reload', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const name = uniqueName('T53 Root UI');
    let rootId: string | null = null;

    try {
      await setFolderStructureMode(admin, 'open');
      await admin.page.goto('/admin');
      await expect(
        admin.page.getByRole('heading', {
          name: 'ガバナンス & セキュリティ統合ダッシュボード',
        })
      ).toBeVisible();
      await admin.page.getByTestId('admin-tab-settings').click();
      await expect(
        admin.page.getByTestId('admin-tabpanel-settings')
      ).toBeVisible();
      await admin.page.getByTestId('enterprise-topic-folder-structure').click();

      const accessSection = admin.page.getByTestId(
        'enterprise-topic-card-folder-structure'
      );
      await expect(accessSection).toBeVisible();
      await expect(
        accessSection.getByRole('heading', {
          name: 'フォルダ構成モード (Open / Closed)',
        })
      ).toBeVisible();
      await expect(
        accessSection.locator('input[name="folderStructureMode"][value="open"]')
      ).toBeChecked();

      await admin.page.getByTestId('admin-tab-content').click();
      await expect(
        admin.page.getByTestId('admin-tabpanel-content')
      ).toBeVisible();
      await admin.page
        .getByRole('button', { name: '新規ルートフォルダ作成', exact: true })
        .click();
      const createDialog = admin.page.getByRole('dialog', {
        name: '新規ルートフォルダを作成',
      });
      await expect(createDialog).toBeVisible();
      await createDialog.locator('#root-folder-name').fill(name);
      await choosePrincipal(
        admin.page,
        '新規ルートフォルダを作成',
        'root-folder-owner-search',
        '所有者 (Owner)の検索候補',
        DEV_USERS.member.email,
        DEV_USERS.member.email
      );
      await expect(
        createDialog
          .getByRole('list', { name: '所有者 (Owner)の選択済み' })
          .getByText(DEV_USERS.member.displayName)
      ).toBeVisible();
      await choosePrincipal(
        admin.page,
        '新規ルートフォルダを作成',
        'root-folder-coowner-search',
        '共同所有者 (Co-Owner)の検索候補',
        'E2E Collaborators',
        'E2E Collaborators'
      );
      await expect(
        createDialog
          .getByRole('list', { name: '共同所有者 (Co-Owner)の選択済み' })
          .getByText('E2E Collaborators')
      ).toBeVisible();
      await createDialog
        .getByRole('button', { name: '作成する', exact: true })
        .click();
      await expect(createDialog).toHaveCount(0);

      const created = await waitForAdminRoot(admin, name);
      rootId = created.id;
      cleanup.registerFolder(created.id);
      expect(created.owners).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            granteeId: DEV_USERS.member.id,
            status: 'active',
          }),
        ])
      );
      expect(created.coOwners).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            granteeType: 'group',
            name: 'E2E Collaborators',
          }),
        ])
      );

      await admin.page.getByTestId('admin-tab-settings').click();
      await expect(
        admin.page.getByTestId('admin-tabpanel-settings')
      ).toBeVisible();
      await admin.page.getByTestId('enterprise-topic-folder-structure').click();
      await accessSection
        .locator('input[name="folderStructureMode"][value="closed"]')
        .check();
      await accessSection
        .getByRole('button', { name: '構成モードを保存', exact: true })
        .click();
      await expect(
        accessSection.getByRole('status').filter({
          hasText: 'フォルダ構成モードを Closed に変更しました',
        })
      ).toBeVisible();

      await expect(
        accessSection.getByRole('heading', {
          name: '既存ルート所有者レポート',
        })
      ).toBeVisible();
      await expect(
        accessSection.getByText('所有者不在', { exact: true })
      ).toBeVisible();
      await expect(
        accessSection.getByText('停止ユーザー所有', { exact: true })
      ).toBeVisible();

      await admin.page.reload();
      await expect(
        admin.page
          .getByTestId('enterprise-topic-card-folder-structure')
          .locator('input[name="folderStructureMode"][value="closed"]')
      ).toBeChecked();
      await admin.page.getByTestId('admin-tab-content').click();
      await expect(
        admin.page.getByTestId('admin-tabpanel-content')
      ).toBeVisible();
      await expect(
        admin.page
          .getByTestId('admin-root-folder-row')
          .filter({ hasText: name })
      ).toBeVisible();
    } finally {
      await setFolderStructureMode(admin, 'open').catch(() => undefined);
      await handoffRootToSysAdmin(admin, rootId);
    }
  });

  test('Flow B: member cannot create at workspace root in closed mode but can create inside an assigned root', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const member = await as('member');
    const name = uniqueName('T53 Member Root');
    let rootId: string | null = null;

    try {
      await setFolderStructureMode(admin, 'closed');
      const root = await createAdminRoot(admin, name);
      rootId = root.id;
      cleanup.registerFolder(root.id);

      await member.page.goto('/workspace');
      await expect(
        member.page.getByText(
          '現在 Closed 構成のため、ルート直下の作成・移動は sys_admin のみ可能です'
        )
      ).toBeVisible();
      await expect(
        member.page
          .getByRole('main')
          .getByRole('button', { name: '新規フォルダ', exact: true })
      ).toHaveCount(0);

      const denied = await member.api.post('/api/folders', {
        data: { parentId: null, name: uniqueName('T53 Root Denied') },
      });
      expect(denied.status()).toBe(403);
      const deniedBody = (await denied.json()) as {
        code?: string;
        error?: string;
      };
      expect(deniedBody.code).toBe('ROOT_CREATION_ADMIN_ONLY');
      expect(deniedBody.error).toContain('sys_admin');

      await member.page
        .getByRole('main')
        .getByRole('button', { name, exact: true })
        .dblclick();
      await expect
        .poll(() => new URL(member.page.url()).searchParams.get('folderId'))
        .toBe(root.id);
      await expect(
        member.page
          .getByRole('main')
          .getByRole('button', { name: '新規フォルダ', exact: true })
      ).toBeVisible();

      const childName = uniqueName('T53 Child');
      await member.page
        .getByRole('main')
        .getByRole('button', { name: '新規フォルダ', exact: true })
        .click();
      const createDialog = member.page.getByRole('dialog', {
        name: '新規フォルダを作成',
      });
      await expect(createDialog).toBeVisible();
      await createDialog.locator('#workspace-modal-name').fill(childName);
      await createDialog
        .getByRole('button', { name: '保存', exact: true })
        .click();
      await expect(createDialog).toHaveCount(0);
      await expect(
        member.page
          .getByRole('main')
          .getByRole('button', { name: childName, exact: true })
      ).toBeVisible();
    } finally {
      await setFolderStructureMode(admin, 'open').catch(() => undefined);
      await handoffRootToSysAdmin(admin, rootId);
    }
  });

  test('Flow C: sec_admin sees read-only folder structure cards, root list and audit link without mutation actions', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const sec = await as('sec_admin');
    const name = uniqueName('T53 Read Only Root');
    let rootId: string | null = null;

    try {
      await setFolderStructureMode(admin, 'closed');
      const root = await createAdminRoot(admin, name);
      rootId = root.id;
      cleanup.registerFolder(root.id);

      await sec.page.goto('/admin');
      await sec.page.getByTestId('admin-tab-settings').click();
      await expect(
        sec.page.getByTestId('admin-tabpanel-settings')
      ).toBeVisible();
      await sec.page.getByTestId('enterprise-topic-folder-structure').click();
      const accessSection = sec.page.getByTestId(
        'enterprise-topic-card-folder-structure'
      );
      await expect(
        accessSection.locator('input[name="folderStructureMode"][value="closed"]')
      ).toBeChecked();
      await expect(
        accessSection.locator('input[name="folderStructureMode"][value="closed"]')
      ).toBeDisabled();
      await expect(
        accessSection.getByText(/sys_admin のみです/)
      ).toBeVisible();
      await expect(
        accessSection.getByRole('button', {
          name: '構成モードを保存',
          exact: true,
        })
      ).toHaveCount(0);

      await sec.page.getByTestId('admin-tab-content').click();
      await expect(
        sec.page.getByTestId('admin-tabpanel-content')
      ).toBeVisible();
      await expect(
        sec.page.getByRole('heading', { name: 'ルートフォルダ管理' })
      ).toBeVisible();
      await expect(
        sec.page
          .getByTestId('admin-root-folder-row')
          .filter({ hasText: name })
      ).toBeVisible();
      await expect(
        sec.page.getByRole('button', { name: '監査ログを表示', exact: true })
      ).toBeVisible();
      await expect(
        sec.page.getByRole('button', {
          name: '新規ルートフォルダ作成',
          exact: true,
        })
      ).toHaveCount(0);
      await expect(
        sec.page.getByRole('button', { name: '所有者移管', exact: true })
      ).toHaveCount(0);
      await expect(
        sec.page.getByRole('button', {
          name: 'グループ/共同所有者',
          exact: true,
        })
      ).toHaveCount(0);
    } finally {
      await setFolderStructureMode(admin, 'open').catch(() => undefined);
      await handoffRootToSysAdmin(admin, rootId);
    }
  });

  test('Flow D: sys_admin transfers ownership, filters the audit log, then archives and restores the root', async ({
    as,
    cleanup,
  }) => {
    const admin = await as('sys_admin');
    const name = uniqueName('T53 Lifecycle Root');
    let rootId: string | null = null;

    try {
      await setFolderStructureMode(admin, 'closed');
      const root = await createAdminRoot(admin, name, {
        coOwnerGroupIds: ['group-e2e-collaborators'],
      });
      rootId = root.id;
      cleanup.registerFolder(root.id);

      await admin.page.goto('/admin');
      await admin.page.getByTestId('admin-tab-content').click();
      await expect(
        admin.page.getByTestId('admin-tabpanel-content')
      ).toBeVisible();
      const row = admin.page
        .getByTestId('admin-root-folder-row')
        .filter({ hasText: name });
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: '所有者移管', exact: true }).click();

      const transferDialog = admin.page.getByRole('dialog', {
        name: `ルートフォルダの所有者を移管: ${name}`,
      });
      await expect(transferDialog).toBeVisible();
      await transferDialog
        .locator('#root-folder-transfer-owner-search')
        .fill(DEV_USERS.sec_admin.email);
      await transferDialog
        .getByRole('listbox', { name: '新しい所有者の検索候補' })
        .getByRole('option')
        .filter({ hasText: DEV_USERS.sec_admin.email })
        .first()
        .click();
      await transferDialog
        .getByRole('button', { name: '所有者を移管する', exact: true })
        .click();
      await expect(transferDialog).toHaveCount(0);
      await expect(
        admin.page.getByRole('status').filter({
          hasText: `${DEV_USERS.sec_admin.displayName} へ移管しました`,
        })
      ).toBeVisible();

      await admin.page
        .getByRole('button', { name: '監査ログを表示', exact: true })
        .click();
      const auditSection = admin.page.locator('#admin-audit-logs');
      await expect(
        auditSection.getByText('ルートフォルダ監査のみ')
      ).toBeVisible();
      await expect(
        auditSection.getByText('admin.root_folder.owner_transfer').first()
      ).toBeVisible();
      await expect(
        auditSection.getByText('所有者移管').first()
      ).toBeVisible();

      await admin.page.getByTestId('admin-tab-content').click();
      await expect(
        admin.page.getByTestId('admin-tabpanel-content')
      ).toBeVisible();
      const refreshedRow = admin.page
        .getByTestId('admin-root-folder-row')
        .filter({ hasText: name });
      await refreshedRow
        .getByRole('button', { name: 'アーカイブ', exact: true })
        .click();
      const archiveDialog = admin.page.getByRole('dialog', {
        name: `ルートフォルダをアーカイブ: ${name}`,
      });
      await expect(archiveDialog).toBeVisible();
      await archiveDialog
        .getByRole('button', { name: 'アーカイブする', exact: true })
        .click();
      await expect(archiveDialog).toHaveCount(0);
      await expect(
        admin.page
          .getByTestId('admin-root-folder-row')
          .filter({ hasText: name })
          .getByText('アーカイブ済み')
      ).toBeVisible();

      const archivedRow = admin.page
        .getByTestId('admin-root-folder-row')
        .filter({ hasText: name });
      await archivedRow
        .getByRole('button', { name: '復元', exact: true })
        .click();
      const restoreDialog = admin.page.getByRole('dialog', {
        name: `ルートフォルダを復元: ${name}`,
      });
      await expect(restoreDialog).toBeVisible();
      await restoreDialog
        .getByRole('button', { name: '復元する', exact: true })
        .click();
      await expect(restoreDialog).toHaveCount(0);
      await expect(
        admin.page
          .getByTestId('admin-root-folder-row')
          .filter({ hasText: name })
          .getByText('有効')
      ).toBeVisible();

      await expect
        .poll(async () => {
          const current = await findAdminRoot(admin, name);
          return current ? current.deletedAt : 'missing';
        })
        .toBeNull();

      await admin.page
        .getByRole('button', { name: '監査ログを表示', exact: true })
        .click();
      await expect(
        admin.page
          .locator('#admin-audit-logs')
          .getByText('admin.root_folder.restore')
          .first()
      ).toBeVisible();
    } finally {
      await setFolderStructureMode(admin, 'open').catch(() => undefined);
      await handoffRootToSysAdmin(admin, rootId);
    }
  });
});
