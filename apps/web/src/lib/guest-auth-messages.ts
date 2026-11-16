import { ApiClientError } from './files-api/core';

const CODE_MESSAGES: Record<string, string> = {
  EXTERNAL_COLLABORATORS_DISABLED:
    'このテナントでは外部コラボレーターが無効になっています。管理者にお問い合わせください。',
  EXTERNAL_DOMAIN_NOT_ALLOWED:
    'このメールドメインは外部ゲストの許可リストに含まれていません。',
  GUEST_ACCOUNT_NOT_FOUND:
    'このメールアドレスの外部ゲストアカウントが見つかりません。',
  GUEST_ACCOUNT_INACTIVE:
    'ゲストアカウントは停止されています。管理者にお問い合わせください。',
  GUEST_ACCOUNT_EXPIRED:
    'ゲストアカウントの有効期限が切れています。管理者にお問い合わせください。',
  INVITATION_NOT_ACCEPTED:
    '招待の承諾が完了していません。招待メールの URL から承諾してください。',
  INVITATION_NOT_FOUND: '招待リンクが無効です。URL を確認してください。',
  INVITATION_ALREADY_USED:
    'この招待は使用済みです。招待 URL は 1 回だけ有効です。',
  INVITATION_REVOKED: 'この招待は管理者によって取り消されています。',
  INVITATION_EXPIRED: 'この招待は有効期限が切れています。',
  INVITATION_NOT_PENDING: 'この招待は再送できない状態です。',
  OTP_NOT_FOUND: '有効な認証コードがありません。コードを再送してください。',
  OTP_EXPIRED: '認証コードの有効期限が切れています。コードを再送してください。',
  OTP_ALREADY_USED: 'この認証コードは使用済みです。コードを再送してください。',
  INVALID_OTP: '認証コードが正しくありません。',
  INVALID_OTP_INPUT: '6 桁の認証コードを入力してください。',
  GUEST_AUTH_RATE_LIMITED:
    '試行回数が上限に達しました。しばらく待ってからコードを再送してください。',
  INVALID_EMAIL: '有効なメールアドレスを入力してください。',
  MAIL_PROVIDER_NOT_CONFIGURED:
    'メール送信が構成されていません。管理者にお問い合わせください。',
  MAIL_DELIVERY_FAILED:
    '認証メールの送信に失敗しました。しばらく待ってから再試行してください。',
  GUEST_FORBIDDEN: '外部ゲストはこの操作を実行できません。',
  COMPANY_ONLY_MEMBER_REQUIRED:
    'この共有リンクは社内メンバー専用です。外部ゲストはアクセスできません。',
};

export function guestAuthErrorMessage(
  err: unknown,
  fallback: string
): string {
  if (err instanceof ApiClientError) {
    const code = err.code;
    if (code && CODE_MESSAGES[code]) {
      if (code === 'GUEST_AUTH_RATE_LIMITED') {
        const retryAfter = err.details?.retryAfterSeconds;
        if (typeof retryAfter === 'number' && retryAfter > 0) {
          const minutes = Math.max(1, Math.ceil(retryAfter / 60));
          return `${CODE_MESSAGES[code]}（約 ${minutes} 分後に再試行できます）`;
        }
      }
      if (code === 'INVALID_OTP') {
        const remaining = err.details?.attemptsRemaining;
        if (typeof remaining === 'number') {
          return `${CODE_MESSAGES[code]}残り ${remaining} 回です。`;
        }
      }
      return CODE_MESSAGES[code];
    }
    return err.message || fallback;
  }
  return fallback;
}
