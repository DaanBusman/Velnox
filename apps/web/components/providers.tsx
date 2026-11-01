'use client';

import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';
import { PwaProvider } from '@/components/pwa';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <PwaProvider>{children}</PwaProvider>
    </ThemeProvider>
  );
}
