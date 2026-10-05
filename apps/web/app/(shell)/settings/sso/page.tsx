import { redirect } from 'next/navigation';

/**
 * Single sign-on moved into Security, as the owner asked. The old address stays
 * a working link to where it went.
 */
export default function SsoSettingsPage() {
  redirect('/settings/security#sso');
}
