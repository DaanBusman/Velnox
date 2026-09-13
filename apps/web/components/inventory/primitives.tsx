'use client';

import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/primitives';
import type { ConnectionState, HealthState, NodeState } from '@/lib/session-types';

/**
 * The pieces every inventory screen repeats.
 *
 * Health, bytes and "how long ago" show up on six pages, and a second
 * implementation of any of them is a second place for the same number to be
 * rendered differently.
 */

const HEALTH_TONE: Record<HealthState, StatusTone> = {
  OK: 'ok',
  WARNING: 'warn',
  CRITICAL: 'error',
  // Grey, not green. A thing Velnox knows nothing about must never read as fine.
  UNKNOWN: 'unknown',
};

export function HealthBadge({ health }: { health: HealthState }) {
  const t = useTranslations();
  return <StatusBadge tone={HEALTH_TONE[health]}>{t(`inventory.health${health}`)}</StatusBadge>;
}

const NODE_TONE: Record<NodeState, StatusTone> = {
  ONLINE: 'ok',
  OFFLINE: 'error',
  UNKNOWN: 'unknown',
};

export function NodeStateBadge({ state }: { state: NodeState }) {
  const t = useTranslations();
  return <StatusBadge tone={NODE_TONE[state]}>{t(`inventory.nodeState${state}`)}</StatusBadge>;
}

const CONNECTION_TONE: Record<ConnectionState, StatusTone> = {
  PENDING: 'neutral',
  CONNECTED: 'ok',
  FAILED: 'error',
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  const t = useTranslations();
  return (
    <StatusBadge tone={CONNECTION_TONE[state]}>{t(`inventory.connection${state}`)}</StatusBadge>
  );
}

/**
 * Bytes, in the units operators actually use.
 *
 * Binary prefixes, because that is what Proxmox reports and what a `df` on the
 * node will agree with. Showing 1.1 TB beside the node's own 1.0 TiB is the kind
 * of small disagreement that costs an hour during an incident.
 *
 * Null is a dash, never zero. "No figure" and "nothing" are different facts and
 * an inventory that renders both as 0 B is lying about one of them.
 */
export function formatBytes(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';

  const amount = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(amount)) return '—';
  if (amount === 0) return '0 B';

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const exponent = Math.min(
    Math.floor(Math.log(Math.abs(amount)) / Math.log(1024)),
    units.length - 1,
  );
  const scaled = amount / 1024 ** exponent;

  return `${scaled.toFixed(scaled >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/** A percentage, or a dash. Guards against a zero denominator reading as 0%. */
export function usedFraction(used: string | null, total: string | null): number | null {
  const usedNumber = used === null ? NaN : Number(used);
  const totalNumber = total === null ? NaN : Number(total);
  if (!Number.isFinite(usedNumber) || !Number.isFinite(totalNumber) || totalNumber <= 0)
    return null;
  return usedNumber / totalNumber;
}

/**
 * A usage bar.
 *
 * Deliberately coloured only at the thresholds that mean something: an operator
 * scanning forty nodes needs the one at 94% to stand out, and a gradient across
 * all of them would hide it.
 */
export function UsageBar({
  used,
  total,
  label,
}: {
  used: string | null;
  total: string | null;
  label?: ReactNode;
}) {
  const fraction = usedFraction(used, total);

  if (fraction === null) {
    return <span className="text-xs text-ink-muted">—</span>;
  }

  const percent = Math.round(fraction * 100);
  const tone = fraction >= 0.9 ? 'bg-error' : fraction >= 0.75 ? 'bg-warn' : 'bg-accent';

  return (
    <div className="min-w-32">
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-ink-muted">
        <span>{label ?? `${formatBytes(used)} / ${formatBytes(total)}`}</span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <div
        role="img"
        aria-label={`${percent}%`}
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3"
      >
        <div className={clsx('h-full rounded-full', tone)} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** Uptime as something readable. Proxmox reports seconds; nobody thinks in them. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * A fingerprint, broken so it can be read aloud.
 *
 * Sixty-four hex characters on one line is unreadable, and reading one aloud is
 * exactly what an operator does when confirming it against `pvenode cert info`.
 */
export function Fingerprint({ value }: { value: string }) {
  const groups = value.split(':');
  const half = Math.ceil(groups.length / 2);

  return (
    <code className="block break-all rounded border border-line bg-surface-2 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink">
      <span className="block">{groups.slice(0, half).join(':')}</span>
      <span className="block">{groups.slice(half).join(':')}</span>
    </code>
  );
}

/** A dimmed dash for anything absent, so an empty cell is never ambiguous. */
export function Absent() {
  return <span className="text-ink-muted">—</span>;
}
