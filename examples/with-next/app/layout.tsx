import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DM_Mono, Inter, Stack_Sans_Notch } from 'next/font/google';
import './globals.css';

const display = Stack_Sans_Notch({ subsets: ['latin'], weight: '400', variable: '--font-display' });
const sans = Inter({ subsets: ['latin'], weight: '400', variable: '--font-sans' });
const mono = DM_Mono({ subsets: ['latin'], weight: '400', variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'e2e - with-next',
  icons: { icon: '/favicon.png' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
