'use client';

import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';
import { PwaProvider } from '@/components/pwa';
import { ChangesProvider } from '@/lib/changes';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <PwaProvider>
        <ChangesProvider>{children}</ChangesProvider>
      </PwaProvider>
    </ThemeProvider>
  );
}
