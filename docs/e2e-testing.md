# Playwright E2E テスト

TOM-62 / P7-7 で追加したブラウザ E2E 基盤です。`apps/web/tests` の Node ユニットテストとは完全に分離しており、`pnpm test`（turbo run test）には含まれません。

## 前提

- Node.js 20.9 以上 / pnpm 10
- Chromium（初回のみ `pnpm exec playwright install chromium`）
- E2E 用ポートが空いていること
  - API: `127.0.0.1:18787`（`E2E_API_PORT`）
  - Web: `localhost:13000`（`E2E_WEB_PORT`）
- 通常の開発スタック（`:3000`、`:8787`）や `apps/api/.wrangler/state` は使いません。既存プロセスを停止・再利用しません。
- `@collabora` タグのテストだけは `http://localhost:9980` の Collabora Online が必要です。通常の `pnpm test:e2e` は `@collabora` を除外するため不要です。
- E2E は起動時に `.playwright/wrangler-state` を初期化するため、複数の `pnpm test:e2e` を同時実行しないでください（`workers: 1` で直列実行します）。

## コマンド

```bash
# 依存と Chromium
pnpm install
pnpm exec playwright install chromium

# ベースライン E2E（@collabora を除外）
pnpm test:e2e

# E2E の型チェック
pnpm test:e2e:typecheck

# Collabora 連携（@collabora のみ）
docker compose -f docker-compose.collabora.yml up -d
pnpm test:e2e:collabora

# 既存の検証
pnpm typecheck
pnpm test
pnpm build

# :3000 の next dev を動かしたままビルドも確認する場合（.next を共有しない）
NEXT_DIST_DIR=.next-e2e pnpm build
```

## 隔離設計

| 対象 | 通常開発 | E2E | 実装 |
| --- | --- | --- | --- |
| API ポート | `:8787` | `:18787` | `playwright.config.ts` の `webServer` |
| API 永続化 | `apps/api/.wrangler/state` | `.playwright/wrangler-state` | `e2e/scripts/start-api.mjs` の `--persist-to` |
| Web ポート | `:3000` | `:13000` | `next dev --port 13000` |
| Next ビルドディレクトリ | `apps/web/.next` | `apps/web/.next-e2e` | `NEXT_DIST_DIR` → `next.config.ts` の `distDir` |
| Web → API | `LOCAL_API_ORIGIN` 既定 `127.0.0.1:8787` | `http://127.0.0.1:18787` | Next `rewrites()`（development のみ） |
| WebSocket | `ws://127.0.0.1:8787/api/sync/ws` | `ws://127.0.0.1:18787/api/sync/ws` | API が返す `wsUrl` |
| ダッシュボード状態 | 既存 D1 | 実行ごとに新規 D1 | 起動時に `--persist-to` 配下をリセット |

`e2e/scripts/start-api.mjs` は起動時に次を順番に実行します。

1. `E2E_API_PORT` / `E2E_INSPECTOR_PORT` の空き確認。使用中なら既存プロセスに触れず失敗。
2. `.playwright/wrangler-state` の削除と再作成。
3. `wrangler d1 migrations apply files-local --local --persist-to ...`（0001〜0005）。
4. `wrangler d1 execute files-local --local --persist-to ... --file scripts/seed-local.sql --yes`。
5. `wrangler dev` を分離ポートで起動。`--var` で `.dev.vars` や `wrangler.jsonc` より優先して次を固定。
   - `ENVIRONMENT=local`
   - `ALLOW_DEV_AUTH=true`
   - `APP_ORIGIN=http://localhost:13000`
   - `STORAGE_MODE=local_proxy`
   - `DEFAULT_TENANT_ID=tenant-default`
   - `WOPI_HOST_ORIGIN=http://127.0.0.1:18787`
   - `COLLABORA_URL=http://localhost:9980`
6. `/api/health` が 200 を返すまで Playwright が待機。

Web は `next dev`（`NODE_ENV=development`）で起動します。これは `apps/web/next.config.ts` の API rewrite が development 時のみ有効なためです。`NEXT_DIST_DIR=.next-e2e` により `apps/web/.next/dev/lock` と衝突しません。`apps/web/tsconfig.json` は `.next-e2e` を `exclude`、`.gitignore` は `.next-e2e/` / `.playwright/` / `e2e/.auth/` を無視します。

終了時は Playwright が webServer を `SIGTERM`（15 秒の猶予）で停止し、`start-api.mjs` が wrangler / workerd にシグナルを転送します。既存の `:3000` / `:8787` / `:9980` には触れません。

## 認証とフィクスチャ

`e2e/fixtures/index.ts` の `as(role)` が、ロールごとに独立した API セッションと BrowserContext を作ります。

```ts
import { test, expect } from './fixtures';
import { findRootFolder, createFolder } from './helpers/api';

test('例', async ({ as, cleanup }) => {
  const admin = await as('sys_admin');   // dev-admin-001
  const member = await as('member');     // dev-member-001
  const sec = await as('sec_admin');     // dev-sec-001

  const general = await findRootFolder(admin, '全社共有');
  const folder = await createFolder(admin, {
    parentId: general.id,
    name: 'phase-8-acceptance',
    classification: 'internal',
  });
  cleanup.registerFolder(folder.id); // テスト後に API でゴミ箱へ移動

  await admin.page.goto(`/workspace?folderId=${folder.id}`);
  // ...
});
```

- 認証は `POST /auth/dev-login`（`apps/api/src/routes/auth/dev.ts`）と `apps/api/scripts/seed-local.sql` の `dev-admin-001` / `dev-sec-001` / `dev-member-001` を使用。
- `as()` は同じテスト内で同じロールを再利用し、テスト終了時に context と API session を閉じます。
- `cleanup.registerFolder(id)` はテスト失敗時も `DELETE /api/folders/:id` を best-effort で実行します（E2E D1 は実行ごとに初期化されるため、次回実行へ持ち越しません）。
- `e2e/helpers/browser.ts`
  - `waitForRealtimeConnected(page)`: `TenantSyncHub` WebSocket が `OPEN` になるまで待機（固定 sleep 不使用）。
  - `resetIndexedDb(page, baseURL)`: 同期用 IndexedDB と scope hint を削除。ユーザー切替や「前回のキャッシュなしで再ログイン」を検証するときに、アプリが同期接続を張る前の `/` で呼びます。
  - `uniqueName(prefix)`: テストごとの一意名。
- `e2e/helpers/api.ts`
  - `waitForFileInFolder` / `waitForTrashFile` / `waitForRootFolder`: `expect.poll` による API 状態待機。
  - `uploadFile`: ブラウザと同じ `upload-init` → signed PUT → `upload-complete` を実行。
  - `searchFiles`: FTS5 検索の直接検証。
  - `listPermissions`: `GET /api/permissions?targetType=folder|file&targetId=...` で直接付与と継承を含む権限一覧を取得。
  - `grantPermission`: `POST /api/permissions` で user / group に `owner` / `co_owner` / `editor` / `viewer` / `previewer` を付与（既存時は更新、HTTP 200/201 の両方を許容）。
  - `revokePermission`: `DELETE /api/permissions/:id` で直接付与を剥奪し、レスポンスの `{ ok: true, id }` を検証。

## ベースライン Spec

`e2e/smoke-workspace.spec.ts` は次を実挙動に対して検証します（スキップ・リトライ・固定 sleep なし）。

1. ローカル開発クイックサインイン（`POST /auth/dev-login`）で `sys_admin` になり、「全社共有」「機密プロジェクト」が表示される。
2. 一意フォルダを UI で作成 → 小サイズ `.txt` を UI からアップロード → 一覧、サイズ、分類、API 検索、⌘K パレットを確認。
3. ファイルを選択してゴミ箱へ移動 → ゴミ箱 UI から復元 → 元フォルダに再表示。
4. `sys_admin` / `sec_admin` は `/admin` を表示でき、`member` は 403 画面と API 403 になる。`member` にはガバナンス導線が出ない。
5. `sys_admin` と `member` の 2 BrowserContext を同じフォルダに開き、member 側で WebSocket 接続を確認した後、admin の UI アップロードが member 側へリロードなしで反映される。

`e2e/collabora.spec.ts` は `@collabora` タグで `http://localhost:9980/hosting/discovery` の到達性と `docx` の `edit` / `view` アクションを検証します。

## TOM-38 / Phase 8〜10 での利用方法

- **TOM-38 などの受け入れ条件**: `as('sys_admin')` / `as('member')` で権限差を再現し、API で前提データを作ってから UI の実操作だけをアサートします。期待値は API の実レスポンス（サイズ・分類・`effectiveRole`）と UI 表示の両方で確認します。
- **Phase 8（ドキュメント・バージョン履歴・復元・ゴミ箱）**: `uploadThroughFileChooser` 相当の UI 操作、`waitForFileInFolder`、`waitForRealtimeConnected`、`waitForTrashFile` を再利用します。固定 sleep ではなく、API 状態・UI locator・WebSocket OPEN のいずれかを待ちます。
- **Phase 9（アクセス権設定の機能強化）**: `as('sec_admin')` を含む 3 ロールで `/admin` と API の 200/403 を比較します。権限の付与・剥奪・一覧は `grantPermission` / `revokePermission` / `listPermissions` を使い、`inherited` と `effectiveRole` を実レスポンスで確認します。新しい spec は `e2e/` 直下に置き、`apps/web/tests` には置かないでください（`run-unit-tests.mjs` の走査対象になるため）。
- **Phase 10（外部ゲストアカウント・コラボレーション）**: `as()` でゲスト相当のユーザーを含む複数 BrowserContext を同時に開き、`waitForRealtimeConnected` で WebSocket 接続を確認してから権限反映・同時編集を検証します。Collabora を使う検証は `@collabora` タグを付け、`pnpm test:e2e:collabora` で実行します。
- **Collabora を含む検証**: 新しいテスト名または `test.describe` に `@collabora` を含めます。通常の `pnpm test:e2e` では `--grep-invert @collabora` で除外され、Collabora 未起動でもベースラインは通ります。`pnpm test:e2e:collabora` は `--grep @collabora` で該当テストだけを実行します。
- **デバッグ**: 失敗時は `test-results/` に trace / screenshot / video、`playwright-report/` に HTML レポートが残ります。`pnpm exec playwright show-trace test-results/.../trace.zip` で確認できます。

## トラブルシューティング

- **`port 18787 is already in use`**: 前回の E2E が残っているか、別プロセスが使用しています。既存プロセスは自動停止しません。`lsof -nP -iTCP:18787 -sTCP:LISTEN` で確認し、E2E 由来のプロセスのみ停止するか `E2E_API_PORT` / `E2E_INSPECTOR_PORT` を変更してください。
- **`port 13000 is already in use`**: 同様に `E2E_WEB_PORT` を変更するか、E2E 由来のプロセスを停止してください。
- **`.next-e2e` 関連の型エラー**: `apps/web/tsconfig.json` の `exclude` に `.next-e2e` が入っていることを確認してください。`next dev` が `.next-e2e/types` を生成してもアプリの `pnpm typecheck` には含めません。
- **Collabora テストだけ失敗**: `curl -fsS http://localhost:9980/hosting/discovery` で到達性を確認し、`docker compose -f docker-compose.collabora.yml up -d` で起動してください。
