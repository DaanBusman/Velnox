'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  hostnameProblem,
  type JobDetail,
  type ProvisioningSummary,
  type TemplateSummary,
} from '@velnox/shared';
import { apiGet, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import type { ClusterSummary, InterfaceRow, NodeSummary, StorageRow } from '@/lib/session-types';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Mono, Notice } from '@/components/ui/primitives';

const select =
  'block h-9 w-full rounded border border-line bg-surface-2 px-2.5 text-sm text-ink focus:border-accent focus:outline-none';

/**
 * Asking for a VM.
 *
 * The choices narrow as they are made: a cluster, then the templates offered
 * to its tenant, then a node, and on that node only the storage and bridges
 * that can work. The API checks every one of them again before it queues
 * anything; this is so the form offers only what can succeed.
 *
 * When the template sends an encrypted record whose password is shown once,
 * the password is shown here, after the request, and nowhere else ever.
 */
export function ProvisionForm({ initialTemplateId }: { initialTemplateId: string | null }) {
  const t = useTranslations();
  const describeError = useApiError();
  const [clusters, setClusters] = useState<ClusterSummary[] | null>(null);
  const [clusterId, setClusterId] = useState('');
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [templateId, setTemplateId] = useState(initialTemplateId ?? '');
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [storages, setStorages] = useState<StorageRow[]>([]);
  const [interfaces, setInterfaces] = useState<InterfaceRow[]>([]);
  const [node, setNode] = useState('');
  const [diskStorage, setDiskStorage] = useState('');
  const [mediaStorage, setMediaStorage] = useState('');
  const [bridge, setBridge] = useState('');
  const [vlan, setVlan] = useState('');
  const [hostname, setHostname] = useState('');
  const [networkMode, setNetworkMode] = useState<'DHCP' | 'STATIC'>('DHCP');
  const [address, setAddress] = useState('');
  const [gateway, setGateway] = useState('');
  const [dns, setDns] = useState('');
  const [notify, setNotify] = useState(true);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<{
    provisioning: ProvisioningSummary;
    job: JobDetail;
    documentPassword: string | null;
  } | null>(null);

  useEffect(() => {
    void apiGet<{ clusters: ClusterSummary[] }>('/clusters').then((result) => {
      if (result.ok)
        setClusters(result.data.clusters.filter((c) => c.connectionState === 'CONNECTED'));
      else setFailure(result.error);
    });
  }, []);

  const cluster = clusters?.find((c) => c.id === clusterId) ?? null;

  useEffect(() => {
    setTemplates(null);
    setNodes([]);
    setStorages([]);
    setInterfaces([]);
    setNode('');
    if (!cluster) return;
    const id = encodeURIComponent(cluster.id);
    void Promise.all([
      apiGet<TemplateSummary[]>(
        `/autoconfig/templates?offeredTo=${encodeURIComponent(cluster.tenantId)}`,
      ),
      apiGet<{ nodes: NodeSummary[] }>(`/nodes?clusterId=${id}`),
      apiGet<{ storages: StorageRow[] }>(`/storage?clusterId=${id}`),
      apiGet<{ interfaces: InterfaceRow[] }>(`/networks?clusterId=${id}`),
    ]).then(([tpl, nds, sts, ifs]) => {
      if (tpl.ok) setTemplates(tpl.data.filter((x) => x.secretsMissing.length === 0));
      if (nds.ok) setNodes(nds.data.nodes.filter((n) => n.state === 'ONLINE'));
      if (sts.ok) setStorages(sts.data.storages);
      if (ifs.ok) setInterfaces(ifs.data.interfaces);
      const firstFailure = [tpl, nds, sts, ifs].find((r) => !r.ok);
      if (firstFailure && !firstFailure.ok) setFailure(firstFailure.error);
    });
  }, [cluster]);

  const template = templates?.find((x) => x.id === templateId) ?? null;
  const family = template?.family ?? 'WINDOWS';
  const onNode = (rows: { nodeName?: string }[]) => rows.filter((row) => row.nodeName === node);

  const diskChoices = useMemo(
    () =>
      onNode(storages).filter(
        (s) => (s as StorageRow).active && (s as StorageRow).content.includes('images'),
      ) as StorageRow[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storages, node],
  );
  const mediaChoices = useMemo(
    () =>
      (onNode(storages) as StorageRow[]).filter(
        (s) =>
          s.active &&
          s.content.includes('iso') &&
          (family === 'WINDOWS' || s.content.includes('import')),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storages, node, family],
  );
  const bridgeChoices = useMemo(
    () => (onNode(interfaces) as InterfaceRow[]).filter((i) => /bridge/i.test(i.type)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [interfaces, node],
  );

  const hostProblem = hostname ? hostnameProblem(hostname.trim(), family) : null;

  async function submit() {
    setPending(true);
    setFailure(null);
    const result = await apiPost<{
      provisioning: ProvisioningSummary;
      job: JobDetail;
      documentPassword: string | null;
    }>('/provisionings', {
      templateId,
      clusterId,
      node,
      diskStorage,
      mediaStorage,
      bridge,
      vlan: vlan ? Number(vlan) : null,
      hostname: hostname.trim(),
      network:
        networkMode === 'DHCP'
          ? { mode: 'DHCP' }
          : {
              mode: 'STATIC',
              address: address.trim(),
              gateway: gateway.trim(),
              dns: dns.split(/[\s,]+/).filter(Boolean),
            },
      notify,
    });
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    setDone(result.data);
  }

  if (done) {
    return (
      <Card title={t('provisioning.queuedTitle', { hostname: done.provisioning.hostname })}>
        <div className="space-y-3">
          {done.documentPassword && (
            <Notice tone="warn" title={t('provisioning.documentPasswordTitle')}>
              <p className="mb-2">{t('provisioning.documentPasswordBody')}</p>
              <Mono>{done.documentPassword}</Mono>
            </Notice>
          )}
          <p className="text-sm text-ink-muted">{t('provisioning.queuedBody')}</p>
          <div className="flex gap-2">
            <Link href={`/provisioning/${done.provisioning.id}`}>
              <Button>{t('provisioning.openRecord')}</Button>
            </Link>
            <Link href={`/jobs/${done.job.id}`}>
              <Button variant="secondary">{t('provisioning.followJob')}</Button>
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card title={t('provisioning.newTitle')} description={t('provisioning.newDescription')}>
      <div className="space-y-3">
        {failure && <FormError>{describeError(failure)}</FormError>}
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('provisioning.cluster')}>
            {(props) => (
              <select
                {...props}
                className={select}
                value={clusterId}
                onChange={(e) => setClusterId(e.target.value)}
              >
                <option value="">
                  {clusters === null ? t('common.loading') : t('provisioning.chooseCluster')}
                </option>
                {(clusters ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.tenantName})
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label={t('provisioning.template')}
            hint={templates && templates.length === 0 ? t('provisioning.noTemplates') : undefined}
          >
            {(props) => (
              <select
                {...props}
                className={select}
                value={templateId}
                disabled={!cluster}
                onChange={(e) => setTemplateId(e.target.value)}
              >
                <option value="">{t('provisioning.chooseTemplate')}</option>
                {(templates ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} · {x.family === 'WINDOWS' ? 'Windows' : 'Linux'}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('provisioning.node')}>
            {(props) => (
              <select
                {...props}
                className={select}
                value={node}
                disabled={!cluster}
                onChange={(e) => setNode(e.target.value)}
              >
                <option value="">{t('provisioning.chooseNode')}</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.name}>
                    {n.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label={t('provisioning.hostname')}
            hint={t('provisioning.hostnameHint', { max: family === 'WINDOWS' ? 15 : 63 })}
            error={hostProblem ? t(`provisioning.hostnameProblem.${hostProblem}`) : undefined}
          >
            {(props) => (
              <TextInput
                {...props}
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('provisioning.diskStorage')}>
            {(props) => (
              <select
                {...props}
                className={select}
                value={diskStorage}
                disabled={!node}
                onChange={(e) => setDiskStorage(e.target.value)}
              >
                <option value="">{t('provisioning.chooseStorage')}</option>
                {diskChoices.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label={t('provisioning.mediaStorage')}
            hint={
              family === 'WINDOWS'
                ? t('provisioning.mediaHintWindows')
                : t('provisioning.mediaHintLinux')
            }
          >
            {(props) => (
              <select
                {...props}
                className={select}
                value={mediaStorage}
                disabled={!node}
                onChange={(e) => setMediaStorage(e.target.value)}
              >
                <option value="">{t('provisioning.chooseStorage')}</option>
                {mediaChoices.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('provisioning.bridge')}>
            {(props) => (
              <select
                {...props}
                className={select}
                value={bridge}
                disabled={!node}
                onChange={(e) => setBridge(e.target.value)}
              >
                <option value="">{t('provisioning.chooseBridge')}</option>
                {bridgeChoices.map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('provisioning.vlan')} hint={t('provisioning.vlanHint')}>
            {(props) => (
              <TextInput
                {...props}
                inputMode="numeric"
                value={vlan}
                onChange={(e) => setVlan(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('provisioning.network')}>
            {(props) => (
              <select
                {...props}
                className={select}
                value={networkMode}
                onChange={(e) => setNetworkMode(e.target.value as 'DHCP' | 'STATIC')}
              >
                <option value="DHCP">{t('provisioning.dhcp')}</option>
                <option value="STATIC">{t('provisioning.static')}</option>
              </select>
            )}
          </Field>
          {networkMode === 'STATIC' && (
            <>
              <Field label={t('provisioning.address')} hint="192.0.2.10/24">
                {(props) => (
                  <TextInput
                    {...props}
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t('provisioning.gateway')}>
                {(props) => (
                  <TextInput
                    {...props}
                    value={gateway}
                    onChange={(e) => setGateway(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t('provisioning.dns')} hint={t('provisioning.dnsHint')}>
                {(props) => (
                  <TextInput {...props} value={dns} onChange={(e) => setDns(e.target.value)} />
                )}
              </Field>
            </>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          {t('provisioning.notify')}
        </label>
        <Button
          onClick={() => void submit()}
          pending={pending}
          disabled={
            !templateId ||
            !clusterId ||
            !node ||
            !diskStorage ||
            !mediaStorage ||
            !bridge ||
            !hostname ||
            Boolean(hostProblem)
          }
        >
          {t('provisioning.build')}
        </Button>
      </div>
    </Card>
  );
}
