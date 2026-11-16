import { expect, test as base } from '@playwright/test';
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
} from '@playwright/test';
import { deleteFolderQuietly } from '../helpers/api';
import { installRealtimeProbe } from '../helpers/browser';

export type Role = 'sys_admin' | 'sec_admin' | 'member';

export const DEV_USERS = {
  sys_admin: {
    id: 'dev-admin-001',
    tenantId: 'tenant-default',
    email: 'dev-admin@example.com',
    displayName: 'Dev Admin',
    role: 'sys_admin',
  },
  sec_admin: {
    id: 'dev-sec-001',
    tenantId: 'tenant-default',
    email: 'dev-sec@example.com',
    displayName: 'Security Officer',
    role: 'sec_admin',
  },
  member: {
    id: 'dev-member-001',
    tenantId: 'tenant-default',
    email: 'dev-member@example.com',
    displayName: 'Dev Member',
    role: 'member',
  },
} as const satisfies Record<
  Role,
  {
    id: string;
    tenantId: string;
    email: string;
    displayName: string;
    role: Role;
  }
>;

export interface RoleSession {
  role: Role;
  user: (typeof DEV_USERS)[Role];
  api: APIRequestContext;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export interface CleanupControls {
  /** Registers an API/UI-created folder tree for best-effort teardown. */
  registerFolder: (folderId: string) => void;
}

type Fixtures = {
  /** Lazily creates an isolated browser context + API session per role. */
  as: (role: Role) => Promise<RoleSession>;
  cleanup: CleanupControls;
};

async function createRoleSession(
  newRequestContext: (options: {
    baseURL: string;
    extraHTTPHeaders: Record<string, string>;
  }) => Promise<APIRequestContext>,
  browser: Browser,
  baseURL: string,
  role: Role
): Promise<RoleSession> {
  const user = DEV_USERS[role];
  const api = await newRequestContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL },
  });
  let context: BrowserContext | null = null;

  try {
    const login = await api.post('/auth/dev-login', {
      data: { userId: user.id },
    });
    expect(
      login.status(),
      `POST /auth/dev-login should issue a session for ${user.id}`
    ).toBe(200);
    const loginBody = (await login.json()) as {
      ok: boolean;
      user: { id: string; role: string; tenantId: string };
    };
    expect(loginBody.user).toMatchObject({
      id: user.id,
      role,
      tenantId: user.tenantId,
    });

    const storageState = await api.storageState();
    const browserContext = await browser.newContext({
      baseURL,
      storageState,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      viewport: { width: 1440, height: 900 },
    });
    context = browserContext;
    await installRealtimeProbe(browserContext);
    const page = await browserContext.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);

    return {
      role,
      user,
      api,
      context: browserContext,
      page,
      close: async () => {
        await browserContext.close();
        await api.dispose();
      },
    };
  } catch (err) {
    await context?.close().catch(() => undefined);
    await api.dispose();
    throw err;
  }
}

export const test = base.extend<Fixtures>({
  as: async ({ browser, baseURL, playwright }, use) => {
    if (!baseURL) throw new Error('playwright config must define use.baseURL');
    const sessions = new Map<Role, RoleSession>();

    const factory = async (role: Role): Promise<RoleSession> => {
      const existing = sessions.get(role);
      if (existing) return existing;
      const session = await createRoleSession(
        (options) => playwright.request.newContext(options),
        browser,
        baseURL,
        role
      );
      sessions.set(role, session);
      return session;
    };

    await use(factory);

    for (const session of [...sessions.values()].reverse()) {
      await session.close();
    }
  },

  cleanup: async ({ as }, use) => {
    const folderIds = new Set<string>();
    await use({
      registerFolder: (folderId) => folderIds.add(folderId),
    });

    if (folderIds.size === 0) return;
    const admin = await as('sys_admin');
    for (const folderId of folderIds) {
      await deleteFolderQuietly(admin, folderId);
    }
  },
});

export { expect };
