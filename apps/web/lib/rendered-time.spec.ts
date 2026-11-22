import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '@velnox/i18n/locales/en.json';
import type { JobSummary } from '@velnox/shared';
import { ClusterAdmin } from '@/components/inventory/cluster-admin';
import { AlertTable, NodeTable } from '@/components/inventory/tables';
import { JobList } from '@/components/jobs/job-list';
import { durationSeconds } from '@/components/jobs/primitives';
import type { AlertRow, ClusterSummary, NodeSummary } from '@/lib/session-types';
import { useClock } from './use-clock';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock('next/link', async () => {
  const { createElement: element } = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      element('a', { href }, children),
  };
});
vi.mock('@/lib/use-auto-refresh', () => ({ useAutoRefresh: () => undefined }));

const RENDERED = Date.parse('2026-11-22T12:00:00.000Z');
const renderedAt = new Date(RENDERED).toISOString();
const seen = new Date(RENDERED - 21_000).toISOString();

const cluster = {
  id: 'c1',
  name: 'alpha',
  endpointHost: 'pve.example.invalid',
  endpointPort: 8006,
  tenantId: 't1',
  tenantName: 'Customer',
  health: 'OK',
  connectionState: 'CONNECTED',
  kind: 'CLUSTER',
  pveVersion: '9.0.3',
  pveVersions: ['9.0.3'],
  nodeCount: 1,
  workloadCount: 0,
  lastSeenAt: seen,
} as unknown as ClusterSummary;

const node = {
  id: 'n1',
  name: 'pve1',
  address: null,
  clusterId: 'c1',
  clusterName: 'alpha',
  state: 'OFFLINE',
  health: 'OK',
  pveVersion: '9.0.3',
  memoryUsedBytes: 1,
  memoryTotalBytes: 2,
  rootfsUsedBytes: 1,
  rootfsTotalBytes: 2,
  updatesAvailable: 0,
  uptimeSeconds: 0,
  lastSeenAt: seen,
} as unknown as NodeSummary;

const alert = {
  clusterId: 'c1',
  clusterName: 'alpha',
  tenantName: 'Customer',
  code: 'test.unknown',
  subject: null,
  severity: 'WARNING',
  params: {},
  since: seen,
} as unknown as AlertRow;

const job = {
  id: 'j1',
  type: 'selftest',
  status: 'RUNNING',
  progressPct: 10,
  tenantId: 't1',
  tenantName: 'Customer',
  cluster: null,
  concurrencyKey: null,
  createdBy: null,
  queuedAt: seen,
  startedAt: seen,
  finishedAt: null,
} as unknown as JobSummary;

const screens: [string, () => ReactElement][] = [
  [
    'the cluster list',
    () =>
      createElement(ClusterAdmin, {
        clusters: [cluster],
        tenants: [],
        sites: [],
        canManage: false,
        refreshSeconds: 0,
        renderedAt,
      }),
  ],
  ['the node table', () => createElement(NodeTable, { nodes: [node], renderedAt })],
  ['the alert table', () => createElement(AlertTable, { alerts: [alert], renderedAt })],
  [
    'the job list',
    () =>
      createElement(JobList, {
        jobs: [job],
        status: null,
        canSelftest: false,
        refreshSeconds: 0,
        renderedAt,
      }),
  ],
];

function renderAt(instant: number, element: ReactElement): string {
  vi.setSystemTime(instant);
  return renderToString(
    createElement(NextIntlClientProvider, {
      locale: 'en',
      messages,
      timeZone: 'UTC',
      children: element,
    }),
  );
}

describe('times rendered on the server and again while hydrating', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(screens)('%s reads the same whatever the clock says', (_name, screen) => {
    const server = renderAt(RENDERED + 150, screen());
    const browser = renderAt(RENDERED + 90_150, screen());

    expect(browser).toBe(server);
    expect(server).toContain('21 seconds ago');
  });

  it('counts a running job from the render time while hydrating', () => {
    function Duration() {
      return durationSeconds(seen, null, useClock(renderedAt));
    }

    expect(renderAt(RENDERED + 90_150, createElement(Duration))).toBe('21');
  });

  it('measures a finished job without the clock', () => {
    expect(durationSeconds(seen, renderedAt, RENDERED + 90_150)).toBe(21);
  });

  it('has no duration for a job that has not started', () => {
    expect(durationSeconds(null, null, RENDERED)).toBeNull();
  });
});
