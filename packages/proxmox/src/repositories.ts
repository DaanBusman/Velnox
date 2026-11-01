import type { RepositoryInfo, SubscriptionInfo } from './client';

/**
 * A node without a subscription gets the no-subscription repositories (ADR-056).
 *
 * Proxmox's enterprise repository needs a subscription key: without one,
 * `apt-get update` fails with a 401 and nothing on the node can be updated or
 * upgraded. The owner asked Velnox to switch such a node by itself — on
 * Proxmox VE 8 and 9 alike — so every update, rolling update and major upgrade
 * first disables the enterprise repositories of a node without an active
 * subscription and makes sure the matching no-subscription ones are there.
 *
 * Done through Proxmox's own repository API (`/nodes/{node}/apt/repositories`),
 * which reads and writes both one-line `.list` files (PVE 8) and deb822
 * `.sources` files (PVE 9): Velnox edits no file itself, and a node with a
 * subscription is never touched. This is the pure half — what to change — so
 * it can be tested without a node.
 */

const ENTERPRISE_HOST = 'enterprise.proxmox.com';

/** Which product a Proxmox repository is for: `pve`, or Ceph of one release. */
type Product = { kind: 'pve' } | { kind: 'ceph'; release: string };

function productOf(uri: string): Product | null {
  const match = /\/debian\/(pve|ceph-([a-z]+))\/?$/.exec(uri.replace(/^\w+:\/\/[^/]+/, ''));
  if (!match) return null;
  return match[1] === 'pve' ? { kind: 'pve' } : { kind: 'ceph', release: match[2]! };
}

/** Proxmox's handle for a product's no-subscription repository. */
const noSubscriptionHandle = (p: Product) =>
  p.kind === 'pve' ? 'no-subscription' : `ceph-${p.release}-no-subscription`;

const isNoSubscription = (p: Product, components: readonly string[]) =>
  p.kind === 'pve'
    ? components.includes('pve-no-subscription')
    : components.includes('no-subscription');

export interface RepositoryChange {
  /** Turn a repository off or on: its file and its place in that file. */
  toggle: { path: string; index: number; enabled: boolean; describe: string }[];
  /** Add a standard repository Proxmox knows by its handle. */
  add: { handle: string; describe: string }[];
}

export const subscriptionActive = (subscription: SubscriptionInfo | null | undefined) =>
  subscription?.status === 'active';

/**
 * What to change so a node without an active subscription can update: every
 * enabled enterprise repository off, and for each product one was for, its
 * no-subscription repository on — enabled if it is there and off, added if it
 * is not there at all. Nothing for a node with an active subscription, or one
 * that has no enterprise repository enabled.
 */
export function planNoSubscription(
  info: RepositoryInfo,
  subscription: SubscriptionInfo | null | undefined,
): RepositoryChange {
  const change: RepositoryChange = { toggle: [], add: [] };
  if (subscriptionActive(subscription)) return change;

  const needed = new Map<string, Product>();
  const present = new Map<string, { path: string; index: number; enabled: boolean }>();

  for (const file of info.files ?? []) {
    (file.repositories ?? []).forEach((repo, index) => {
      for (const uri of repo.URIs ?? []) {
        const product = productOf(uri);
        if (!product) continue;
        const handle = noSubscriptionHandle(product);
        if (uri.includes(ENTERPRISE_HOST)) {
          if (repo.Enabled === 1) {
            change.toggle.push({
              path: file.path,
              index,
              enabled: false,
              describe: `${file.path}: ${uri} (enterprise) disabled`,
            });
            needed.set(handle, product);
          }
        } else if (isNoSubscription(product, repo.Components ?? []) && !present.has(handle)) {
          present.set(handle, { path: file.path, index, enabled: repo.Enabled === 1 });
        }
      }
    });
  }

  for (const [handle] of needed) {
    const found = present.get(handle);
    if (found?.enabled) continue;
    if (found) {
      change.toggle.push({
        path: found.path,
        index: found.index,
        enabled: true,
        describe: `${found.path}: ${handle} enabled`,
      });
    } else {
      change.add.push({ handle, describe: `${handle} added` });
    }
  }
  return change;
}

/**
 * The channel a node's enabled Ceph repositories are on now: enterprise when
 * one is on Proxmox's enterprise host, no-subscription when one is that
 * channel, null when the node has neither (none at all, or only `test`).
 */
export function cephChannelOf(info: RepositoryInfo): 'enterprise' | 'no-subscription' | null {
  let channel: 'enterprise' | 'no-subscription' | null = null;
  for (const file of info.files ?? []) {
    for (const repo of file.repositories ?? []) {
      if (repo.Enabled !== 1) continue;
      for (const uri of repo.URIs ?? []) {
        if (productOf(uri)?.kind !== 'ceph') continue;
        if (uri.includes(ENTERPRISE_HOST)) return 'enterprise';
        if ((repo.Components ?? []).includes('no-subscription')) channel = 'no-subscription';
      }
    }
  }
  return channel;
}

export const isEmptyChange = (change: RepositoryChange) =>
  change.toggle.length === 0 && change.add.length === 0;
