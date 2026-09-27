import { permanentRedirect } from 'next/navigation';

/**
 * Where About used to be.
 *
 * The build facts moved into Server management and the sidebar entry became a
 * real settings page. This redirect stays because the footer of every screen
 * linked here for several releases, so it is in bookmarks and in the
 * documentation of anyone who wrote it down.
 */
export default function AboutRedirect() {
  permanentRedirect('/settings');
}
