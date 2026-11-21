# Cloudflare Staging / Production Verification & Deployment Checklist

Cloudflare Workers (`files-api` + OpenNext `files-web`) へ Staging / Production 環境をデプロイ・検証するための実務チェックリストです。

---

## 1. D1 マイグレーション (`0001`–`0032`)

`apps/api/migrations/` に `0001_initial_schema.sql` 〜 `0032_visual_branding.sql` が揃っていることを確認し、リモート D1 へ適用します。

```bash
# 1. マイグレーション一覧と適用状況の確認 (Staging)
pnpm --filter @files/api exec wrangler d1 migrations list files-staging --env staging --remote

# 2. リモート D1 へ未適用マイグレーションを適用 (Staging)
pnpm --filter @files/api exec wrangler d1 migrations apply files-staging --env staging --remote

# 3. Production 環境の場合 (--env production / 対象 DB 名を指定)
pnpm --filter @files/api exec wrangler d1 migrations apply files-production --env production --remote
```

確認ポイント:
- `0025_user_favorites_and_recents.sql` 〜 `0032_visual_branding.sql` までエラーなく適用済みであること。
- `files_fts`（FTS5 全文検索・`0030_files_fts_content_excerpt.sql`）および `visual_branding` カラムが作成されていること。

---

## 2. Wrangler バインディング & リソース確認 (`apps/api/wrangler.jsonc`)

| 種別 | Binding 名 | Staging 設定値 / クラス名 | 備考 |
|---|---|---|---|
| D1 Database | `DB` | `files-staging` (`database_id` 要設定) | プレースホルダ `<YOUR_STAGING_D1_ID>` を実 ID に置換 |
| R2 Bucket | `BUCKET` | `files-staging` | CORS 設定（`PUT`/`GET` 署名付き URL 用 `APP_ORIGIN` 許可）必須 |
| Workers AI | `AI` | `ai.binding = "AI"` | `LLM_PROVIDER=workers_ai` 時に使用 |
| Durable Object | `SYNC_HUB` | `TenantSyncHub` (SQLite migration `v1`) | リアルタイム同期 WebSocket (`/api/sync/ws`) |
| Durable Object | `FILE_LOCK_HUB` | `FileLockHub` (SQLite migration `v2`) | Web WOPI / Desktop 排他ロック管理 |
| Queue Producer | `JOBS_QUEUE` | `files-jobs-staging` | 非同期ジョブ投入 (`files-jobs` / `files-jobs-staging`) |
| Queue Consumer | `JOBS_QUEUE` | `files-jobs-staging` (DLQ: `files-jobs-staging-dlq`) | `max_batch_size: 2` (Free 枠) / Paid 枠は `10` まで引き上げ可 |
| Cron Trigger | — | `0 3 * * *` | ゴミ箱自動削除・期限切れゲスト/ロック保守 |

---

## 3. 環境変数 (`vars`) & シークレット (`wrangler secret`)

### 3.1 `vars` (`apps/api/wrangler.jsonc`)

- `ENVIRONMENT`: `"staging"` または `"production"`（`local` 以外は dev auth 自動無効）
- `APP_ORIGIN`: `"https://files.example.com"`（CSRF Origin 検証・CORS・メールリンク生成に使用）
- `DEFAULT_TENANT_ID`: テナント ID（例: `"tenant-example"`）
- `STORAGE_MODE`: `"s3_presigned"`（R2 署名付き URL 直接アップロード/ダウンロード）
- `LLM_PROVIDER`: `"workers_ai"`
- `WORKERS_AI_MODEL`: `"@cf/meta/llama-3.1-8b-instruct-fast"`
- `MIN_SUGGESTION_CONFIDENCE`: `"0.70"`
- `TURNSTILE_SITE_KEY`: 公開ファイルリクエスト (`/fr/:token`) 用 Turnstile サイトキー（設定時のみウィジェット有効化）

### 3.2 `wrangler secret put` 一覧

```bash
# R2 S3-compatible Presigned URL 用クレデンシャル (STORAGE_MODE=s3_presigned で必須)
pnpm --filter @files/api exec wrangler secret put R2_ACCOUNT_ID --env staging
pnpm --filter @files/api exec wrangler secret put R2_BUCKET_NAME --env staging
pnpm --filter @files/api exec wrangler secret put R2_ACCESS_KEY_ID --env staging
pnpm --filter @files/api exec wrangler secret put R2_SECRET_ACCESS_KEY --env staging

# トランザクションメール配信 (Staging / Production で MAIL_WEBHOOK_URL 必須)
pnpm --filter @files/api exec wrangler secret put MAIL_WEBHOOK_URL --env staging
pnpm --filter @files/api exec wrangler secret put MAIL_API_KEY --env staging
pnpm --filter @files/api exec wrangler secret put MAIL_FROM --env staging

# Cloudflare Turnstile (公開ファイルリクエストボット対策)
pnpm --filter @files/api exec wrangler secret put TURNSTILE_SECRET_KEY --env staging

# セッション / OIDC / SIEM / WOPI 暗号鍵
pnpm --filter @files/api exec wrangler secret put OIDC_STATE_COOKIE_KEY --env staging
pnpm --filter @files/api exec wrangler secret put SIEM_WEBHOOK_SECRET_KEY --env staging
pnpm --filter @files/api exec wrangler secret put WOPI_TOKEN_SECRET --env staging

# IdP クライアントシークレット (利用するプロバイダのみ)
pnpm --filter @files/api exec wrangler secret put OKTA_CLIENT_SECRET --env staging
pnpm --filter @files/api exec wrangler secret put ENTRA_CLIENT_SECRET --env staging
```

シークレット登録確認:
```bash
pnpm --filter @files/api exec wrangler secret list --env staging
```

---

## 4. デプロイ & Post-Deploy スモークチェック

### 4.1 デプロイコマンド

```bash
# API Worker デプロイ
pnpm --filter @files/api exec wrangler deploy --env staging

# Web (OpenNext / Cloudflare) デプロイ
pnpm --filter @files/web run deploy:staging
```

### 4.2 スモークテスト・マトリクス

| チェック項目 | 確認手順 / コマンド | 期待結果 |
|---|---|---|
| ヘルスチェック | `curl -fsS https://files.example.com/api/health` | `200 OK` (`{"ok":true,...}`) |
| Dev Auth 無効化 | `curl -i https://files.example.com/auth/dev-accounts` | `enabled: false` または `403`/`404` |
| OIDC サインイン | ブラウザで `/workspace` → Okta / Entra ID ログイン | `/api/auth/me` が `200` を返しワークスペース表示 |
| R2 Presigned Upload/Download | ワークスペースから小サイズファイル・`.docx` をアップロード＆プレビュー | CORS エラーなし、Queue 経由で `.docx` 本文が FTS インデックス化 |
| Durable Objects 同期 & ロック | 2 タブで同一フォルダを開きファイル作成・ロック/解除を実行 | `wss://.../api/sync/ws` (`TenantSyncHub`) と `FileLockHub` が即時反映 |
| 公開共有リンク & サブフォルダ | フォルダ共有リンク `/s/:token` をシークレットウィンドウで開く | Branding 表示、サブフォルダ遷移、一括 ZIP ダウンロード成功 |
| 公開ファイルリクエスト + Turnstile | `/fr/:token` を開き Turnstile 通過後にファイル提出 | `200 OK`、未認証/不正トークン時は `403 TURNSTILE_FAILED` |
| メール通知 Webhook | コメント `@mention` またはタスク割当を実行 | `MAIL_WEBHOOK_URL` へ通知ペイロードが送信される |
| Admin Console | `/admin/content?tab=metadata-templates` と `/admin/settings?tab=compliance` | テンプレート作成とロゴ/アクセントカラー保存が反映される |
