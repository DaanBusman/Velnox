'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { isLocale, LOCALE_COOKIE } from '@velnox/i18n';
import { SELECTED_TENANT_COOKIE } from '@/lib/tenant-selection';

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

/**
 * The tenant filter in the top bar.
 *
 * Stored in a cookie rather than the URL so it survives moving between pages —
 * an engineer working through one customer's sites, then their users, should not
 * have to reselect. Empty means "everything I can reach".
 *
 * The value carries **no authority**. It is a query parameter the API is free to
 * ignore: every list is already scoped to the caller underneath, so selecting a
 * tenant id by editing the cookie narrows the result at most, and selecting one
 * the account cannot reach returns nothing rather than someone else's data. That
 * is why this needs no validation here — validating it would suggest the
 * validation is what makes it safe.
 */
export async function setSelectedTenant(value: string): Promise<void> {
  const store = await cookies();

  if (!value) {
    store.delete(SELECTED_TENANT_COOKIE);
  } else {
    store.set(SELECTED_TENANT_COOKIE, value, {
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
      sameSite: 'lax',
      httpOnly: false,
    });
  }

  revalidatePath('/', 'layout');
}
