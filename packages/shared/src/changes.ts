/**
 * "Something changed": what lets an open screen refresh when its data moves
 * instead of on a timer.
 *
 * The worker publishes a {@link ChangeMessage} on {@link CHANGE_CHANNEL} after
 * it writes something a screen shows; the API turns those, and the job events
 * it already receives, into one server-sent stream per open screen, filtered to
 * what that viewer may read. The stream carries no data — only which kind of
 * thing changed and, for inventory, on which cluster — so the screen still
 * reads its data the way it always has, through the API and its checks.
 */
export const CHANGE_CHANNEL = 'velnox:changes';

/** What a screen can ask to hear about. Library items change through jobs. */
export const CHANGE_TOPICS = ['inventory', 'jobs'] as const;
export type ChangeTopic = (typeof CHANGE_TOPICS)[number];

/** Published inside Velnox, between worker and API. Never sent to a browser as is. */
export interface ChangeMessage {
  topic: ChangeTopic;
  tenantId: string;
  siteId: string | null;
  clusterId: string | null;
}

/** What a browser receives: no tenant, no site, nothing it did not already see. */
export interface ChangeEvent {
  topic: ChangeTopic;
  clusterId: string | null;
}

/**
 * How long one stream stays open before the API ends it and the browser
 * reconnects. Each connection is authenticated, and its permissions read, when
 * it opens; ending it on a schedule bounds how long a revoked session or a
 * withdrawn permission keeps receiving change signals.
 */
export const CHANGE_STREAM_MAX_SECONDS = 600;
