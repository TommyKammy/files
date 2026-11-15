import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Files — Enterprise Secure Workspace',
  description:
    'Cloudflare edge-native enterprise file sharing and governance platform',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className="antialiased">{children}</body>
    </html>
  );
}
