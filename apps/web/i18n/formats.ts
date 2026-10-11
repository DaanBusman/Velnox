import type { Formats } from 'next-intl';

/**
 * Named formats, used as `format.dateTime(date, 'medium')`.
 *
 * Defined once for the server's request config and the client provider alike.
 * A name that is not defined here is not an error next-intl throws: it renders
 * the raw `Date` instead — in the machine's own zone, ignoring the viewer's —
 * which is how "Last read" once showed a JavaScript date string.
 */
export const FORMATS = {
  dateTime: {
    medium: { dateStyle: 'medium', timeStyle: 'medium' },
  },
} satisfies Formats;
