'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { isLocale, LOCALE_COOKIE } from '@velnox/i18n';

/**
 * Persist the viewer's language choice.
 *
 * The value is validated against the supported locales before it is stored: it
 * arrives from the browser, and an unchecked value would end up in a filesystem
 * path when the catalogue is looked up.
 */
export async function setLocale(value: string): Promise<void> {
  if (!isLocale(value)) return;

  const store = await cookies();
  store.set(LOCALE_COOKIE, value, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    httpOnly: false, // read by the switcher itself; carries no authority
  });

  revalidatePath('/', 'layout');
}
