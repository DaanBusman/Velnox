'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ALTERNATIVE_MIRRORS,
  LINUX_KEYBOARDS,
  LINUX_LOCALES,
  RECOMMENDED_MIRRORS,
  WINDOWS_KEYBOARDS,
  WINDOWS_LANGUAGES,
  WINDOWS_TIME_ZONES,
  parseTenantSecretKey,
  perTenantAccount,
  type LibraryItemSummary,
  type TemplateOsFamily,
  type TemplateSummary,
} from '@velnox/shared';
import { apiPatch, apiPost, type ApiFailure } from '@/lib/client-api';
import { useApiError } from '@/lib/use-api-error';
import type { TenantSummary } from '@/lib/session-types';
import { Button, Field, FormError, TextInput } from '@/components/ui/form';
import { Card, Notice } from '@/components/ui/primitives';

/* eslint-disable @typescript-eslint/no-explicit-any -- the settings object is
   validated by the API against templateSettingsSchema; here it is a form. */

const select =
  'block h-9 w-full rounded border border-line bg-surface-2 px-2.5 text-sm text-ink focus:border-accent focus:outline-none';

function Check({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {(props) => (
        <select
          {...props}
          className={select}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function NumberField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: ReactNode;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      {(props) => (
        <TextInput
          {...props}
          type="number"
          value={String(value)}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      )}
    </Field>
  );
}

/** A password or key a template holds: write-only, shown as "stored". */
function Secret({
  label,
  kind,
  value,
  isStored,
  editable,
  onChange,
  onClear,
}: {
  keyName: string;
  label: ReactNode;
  kind: 'password' | 'key';
  value: string | null | undefined;
  isStored: boolean;
  editable: boolean;
  onChange: (value: string | undefined) => void;
  onClear: () => void;
}) {
  const t = useTranslations();
  return (
    <Field
      label={label}
      hint={kind === 'password' ? t('autoconfig.passwordRule') : t('autoconfig.productKeyHint')}
    >
      {(props) => (
        <div className="flex items-center gap-2">
          <TextInput
            {...props}
            type={kind === 'password' ? 'password' : 'text'}
            autoComplete="new-password"
            placeholder={isStored ? t('autoconfig.secretStored') : ''}
            value={value ?? ''}
            disabled={!editable}
            onChange={(event) => onChange(event.target.value || undefined)}
          />
          {isStored && editable && (
            <Button variant="quiet" onClick={onClear}>
              {t('autoconfig.secretClear')}
            </Button>
          )}
        </div>
      )}
    </Field>
  );
}

type SecretFieldProps = Omit<Parameters<typeof Secret>[0], 'label' | 'kind'>;

/**
 * One password per tenant, for the account set per tenant. A tenant left empty
 * gets a password generated for each VM; the API says which are stored, and
 * only to whoever may edit the template.
 */
function TenantPasswords({
  account,
  tenants,
  secretPropsFor,
}: {
  account: 'administrator' | 'root';
  tenants: TenantSummary[];
  secretPropsFor: (key: string) => SecretFieldProps;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-2 rounded border border-line p-3 md:col-span-2">
      <p className="text-sm font-medium text-ink">{t('autoconfig.perTenantTitle')}</p>
      <p className="text-xs text-ink-muted">{t('autoconfig.perTenantHint')}</p>
      {tenants.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('autoconfig.noCustomers')}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {tenants.map((tenant) => (
            <Secret
              key={tenant.id}
              {...secretPropsFor(`tenant:${tenant.id}:${account}`)}
              label={tenant.kind === 'MSP_ROOT' ? t('autoconfig.ownerMsp') : tenant.name}
              kind="password"
            />
          ))}
        </div>
      )}
    </div>
  );
}

const defaults = (family: TemplateOsFamily): any =>
  family === 'WINDOWS'
    ? {
        family: 'WINDOWS',
        isoFilename: '',
        imageName: '',
        virtioIsoFilename: '',
        virtio: true,
        guestAgent: true,
        diskLayout: 'GPT',
        hasProductKey: false,
        locale: {
          uiLanguage: 'en-US',
          systemLocale: 'en-US',
          userLocale: 'en-US',
          inputLocale: '0409:00020409',
          timeZone: 'W. Europe Standard Time',
        },
        administratorPassword: 'GENERATE',
        accounts: [{ name: 'beheer', displayName: '', administrator: true, password: 'GENERATE' }],
        workgroup: 'WORKGROUP',
        rdp: false,
        powerPlan: 'HIGH_PERFORMANCE',
        hibernation: false,
        windowsUpdate: 'DEFERRED',
        hardware: {
          cores: 2,
          memoryMb: 4096,
          diskGb: 64,
          cpuType: 'x86-64-v2-AES',
          startAfterCreate: true,
        },
      }
    : {
        family: 'LINUX',
        distribution: 'UBUNTU',
        imageFilename: '',
        locale: 'en_US.UTF-8',
        keyboard: { layout: 'us', variant: 'intl' },
        timeZone: 'Europe/Amsterdam',
        mirror: null,
        aptProxy: null,
        users: [{ name: 'ops', sudo: true, sshKeys: [], password: 'NONE' }],
        root: { allowLogin: false, password: 'NONE' },
        ssh: { enabled: true, passwordAuthentication: false },
        guestAgent: true,
        unattendedUpgrades: true,
        packages: [],
        swapMb: 0,
        hardware: {
          cores: 2,
          memoryMb: 2048,
          diskGb: 20,
          cpuType: 'x86-64-v2-AES',
          startAfterCreate: true,
        },
      };

/**
 * One template, created or changed.
 *
 * **Secrets are write-only here.** A stored password or product key is shown
 * as "stored", with a field to replace it and a button to clear it; its value
 * is never on this page, because the API never sends it. What is sent is only
 * what was typed, keyed by what it is for.
 */
export function TemplateEditor({
  family,
  template,
  tenants,
  library,
}: {
  family: TemplateOsFamily;
  template: TemplateSummary | null;
  tenants: TenantSummary[];
  library: LibraryItemSummary[];
}) {
  const t = useTranslations();
  const router = useRouter();
  const describeError = useApiError();
  const editable = template ? template.canEdit : true;

  const [tenantId, setTenantId] = useState(
    template?.tenantId ?? tenants.find((tenant) => tenant.kind === 'MSP_ROOT')?.id ?? '',
  );
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [visibility, setVisibility] = useState(template?.visibility ?? 'SHARED');
  const [offered, setOffered] = useState<string[]>(template?.offeredTenantIds ?? []);
  const [delivery, setDelivery] = useState(template?.credentialDelivery ?? 'VELNOX_ONLY');
  const [pdfSource, setPdfSource] = useState(template?.pdfPasswordSource ?? 'SHOWN_ONCE');
  const [settings, setSettings] = useState<any>(() =>
    template ? structuredClone(template.settings) : defaults(family),
  );
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = (path: string, value: unknown) =>
    setSettings((current: any) => {
      const next = structuredClone(current);
      const keys = path.split('.');
      let node = next;
      for (const key of keys.slice(0, -1)) node = node[key];
      node[keys[keys.length - 1]!] = value;
      return next;
    });

  const isos = library.filter((item) => item.kind === 'ISO' && item.state === 'READY');
  const images = library.filter((item) => item.kind === 'DISK_IMAGE' && item.state === 'READY');
  const chosenIso = isos.find((item) => item.filename === settings.isoFilename);
  const editions = chosenIso?.windowsImages ?? null;

  // Offering by name and passwords per tenant are an MSP template's.
  const mspTenant = tenants.find((tenant) => tenant.kind === 'MSP_ROOT');
  const mspOwned = template ? template.ownedByMsp : tenantId === mspTenant?.id;
  const customers = tenants.filter(
    (tenant) => tenant.kind !== 'MSP_ROOT' && tenant.status !== 'ARCHIVED',
  );
  // Whose password can be set: the MSP's own, and the customers it reaches.
  const passwordTenants = [
    ...(mspTenant ? [mspTenant] : []),
    ...(visibility === 'SELECTED'
      ? customers.filter((tenant) => offered.includes(tenant.id))
      : customers),
  ];

  const stored = (key: string) =>
    Boolean(template?.secretsSet[key as keyof typeof template.secretsSet]);

  const secretProps = (keyName: string) => ({
    keyName,
    value: secrets[keyName],
    isStored: stored(keyName) && secrets[keyName] !== null,
    editable,
    onChange: (value: string | undefined) =>
      setSecrets((current) => ({ ...current, [keyName]: value as string })),
    onClear: () => setSecrets((current) => ({ ...current, [keyName]: null })),
  });

  async function save() {
    setPending(true);
    setFailure(null);
    setSaved(false);
    const cleaned = structuredClone(settings);
    if (cleaned.family === 'WINDOWS' && !cleaned.virtioIsoFilename)
      cleaned.virtioIsoFilename = null;
    // A tenant's password typed before the account stopped being set per tenant
    // is not sent: the API would refuse it.
    const perTenant = perTenantAccount(cleaned);
    const secretChanges = Object.fromEntries(
      Object.entries(secrets).filter(
        ([key, value]) =>
          value !== undefined &&
          (!key.startsWith('tenant:') || parseTenantSecretKey(key)?.account === perTenant),
      ),
    );
    const common = {
      name: name.trim(),
      description,
      visibility,
      offeredTenantIds: visibility === 'SELECTED' ? offered : [],
      credentialDelivery: delivery,
      pdfPasswordSource: pdfSource,
      settings: cleaned,
      secrets: secretChanges,
    };
    const result = template
      ? await apiPatch<TemplateSummary>(`/autoconfig/templates/${template.id}`, common)
      : await apiPost<TemplateSummary>('/autoconfig/templates', { tenantId, ...common });
    setPending(false);
    if (!result.ok) return setFailure(result.error);
    setSecrets({});
    setSaved(true);
    if (!template) router.push(`/autoconfig/${result.data.id}`);
    else router.refresh();
  }

  const issues = useMemo(() => {
    const text = failure?.params?.issues;
    return typeof text === 'string'
      ? text.split('; ')
      : (failure?.details ?? []).map((d) => `${d.path}: ${d.message}`);
  }, [failure]);

  const w = settings.family === 'WINDOWS';

  return (
    <div className="space-y-4">
      {!editable && <Notice tone="neutral">{t('autoconfig.notYours')}</Notice>}
      {template && template.secretsMissing.length > 0 && (
        <Notice tone="warn" title={t('autoconfig.incomplete')}>
          {t('autoconfig.missingSecrets', { keys: template.secretsMissing.join(', ') })}
        </Notice>
      )}

      <Card title={t('autoconfig.general')}>
        <div className="grid gap-3 md:grid-cols-2">
          {!template && (
            <Choice
              label={t('autoconfig.owner')}
              hint={t('autoconfig.ownerHint')}
              value={tenantId}
              options={tenants
                .filter((tenant) => tenant.status === 'ACTIVE')
                .map((tenant) => ({
                  value: tenant.id,
                  label: tenant.kind === 'MSP_ROOT' ? t('autoconfig.ownerMsp') : tenant.name,
                }))}
              onChange={(id) => {
                setTenantId(id);
                // A customer's template is offered to nobody else and has no
                // passwords per tenant: what only an MSP template can do goes.
                if (id === mspTenant?.id) return;
                if (visibility === 'SELECTED') setVisibility('SHARED');
                if (settings.administratorPassword === 'PER_TENANT') {
                  set('administratorPassword', 'FIXED');
                }
                if (settings.root?.password === 'PER_TENANT') set('root.password', 'FIXED');
              }}
            />
          )}
          <Field label={t('autoconfig.name')}>
            {(props) => (
              <TextInput
                {...props}
                value={name}
                disabled={!editable}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('autoconfig.description')}>
            {(props) => (
              <TextInput
                {...props}
                value={description}
                disabled={!editable}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          <Choice
            label={t('autoconfig.visibility')}
            hint={t('autoconfig.visibilityHint')}
            value={visibility}
            disabled={!editable}
            options={[
              { value: 'SHARED', label: t('autoconfig.visibilityShared') },
              ...(mspOwned
                ? [{ value: 'SELECTED' as const, label: t('autoconfig.visibilitySelected') }]
                : []),
              { value: 'PRIVATE', label: t('autoconfig.visibilityPrivate') },
            ]}
            onChange={setVisibility}
          />
          <Choice
            label={t('autoconfig.delivery')}
            hint={
              delivery === 'VELNOX_ONLY'
                ? t('autoconfig.deliveryVelnoxHint')
                : t('autoconfig.deliveryPdfHint')
            }
            value={delivery}
            disabled={!editable}
            options={[
              { value: 'VELNOX_ONLY', label: t('autoconfig.deliveryVelnox') },
              { value: 'ENCRYPTED_PDF', label: t('autoconfig.deliveryPdf') },
            ]}
            onChange={setDelivery}
          />
          {delivery === 'ENCRYPTED_PDF' && (
            <Choice
              label={t('autoconfig.pdfSource')}
              value={pdfSource}
              disabled={!editable}
              options={[
                { value: 'SHOWN_ONCE', label: t('autoconfig.pdfShownOnce') },
                { value: 'TEMPLATE', label: t('autoconfig.pdfTemplate') },
              ]}
              onChange={setPdfSource}
            />
          )}
          {delivery === 'ENCRYPTED_PDF' && pdfSource === 'TEMPLATE' && (
            <Secret
              {...secretProps('pdfPassword')}
              label={t('autoconfig.pdfPassword')}
              kind="password"
            />
          )}
          {visibility === 'SELECTED' && mspOwned && (
            <div className="md:col-span-2">
              <p className="text-sm font-medium text-ink">{t('autoconfig.offeredTo')}</p>
              <p className="mb-2 text-xs text-ink-muted">{t('autoconfig.offeredToHint')}</p>
              {customers.length === 0 ? (
                <p className="text-sm text-ink-muted">{t('autoconfig.noCustomers')}</p>
              ) : (
                <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {customers.map((tenant) => (
                    <Check
                      key={tenant.id}
                      label={tenant.name}
                      checked={offered.includes(tenant.id)}
                      disabled={!editable}
                      onChange={(on) =>
                        setOffered((current) =>
                          on ? [...current, tenant.id] : current.filter((id) => id !== tenant.id),
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {w ? (
        <>
          <Card title={t('autoconfig.installer')}>
            <div className="grid gap-3 md:grid-cols-2">
              <Choice
                label={t('autoconfig.iso')}
                value={settings.isoFilename}
                disabled={!editable}
                options={[
                  { value: '', label: t('autoconfig.chooseFile') },
                  ...isos.map((item) => ({ value: item.filename, label: item.filename })),
                ]}
                onChange={(value) => set('isoFilename', value)}
              />
              {editions ? (
                <Choice
                  label={t('autoconfig.edition')}
                  hint={t('autoconfig.editionFromIso')}
                  value={settings.imageName}
                  disabled={!editable}
                  options={[
                    { value: '', label: t('autoconfig.chooseEdition') },
                    ...editions.map((image) => ({ value: image.name, label: image.name })),
                  ]}
                  onChange={(value) => set('imageName', value)}
                />
              ) : (
                <Field label={t('autoconfig.edition')} hint={t('autoconfig.editionTyped')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={settings.imageName}
                      disabled={!editable}
                      onChange={(e) => set('imageName', e.target.value)}
                    />
                  )}
                </Field>
              )}
              <Choice
                label={t('autoconfig.virtioIso')}
                value={settings.virtioIsoFilename ?? ''}
                disabled={!editable}
                options={[
                  { value: '', label: t('autoconfig.none') },
                  ...isos.map((item) => ({ value: item.filename, label: item.filename })),
                ]}
                onChange={(value) => set('virtioIsoFilename', value)}
              />
              <Choice
                label={t('autoconfig.diskLayout')}
                hint={t('autoconfig.diskLayoutHint')}
                value={settings.diskLayout}
                disabled={!editable}
                options={[
                  { value: 'GPT', label: t('autoconfig.gpt') },
                  { value: 'MBR', label: 'MBR' },
                ]}
                onChange={(value) => set('diskLayout', value)}
              />
              <Check
                label={t('autoconfig.virtio')}
                checked={settings.virtio}
                disabled={!editable}
                onChange={(v) => set('virtio', v)}
              />
              <Check
                label={t('autoconfig.guestAgent')}
                checked={settings.guestAgent}
                disabled={!editable}
                onChange={(v) => set('guestAgent', v)}
              />
              <Check
                label={t('autoconfig.hasProductKey')}
                checked={settings.hasProductKey}
                disabled={!editable}
                onChange={(v) => set('hasProductKey', v)}
              />
              {settings.hasProductKey && (
                <Secret
                  {...secretProps('productKey')}
                  label={t('autoconfig.productKey')}
                  kind="key"
                />
              )}
            </div>
            {!settings.hasProductKey && (
              <p className="mt-2 text-xs text-ink-muted">{t('autoconfig.noKeyHint')}</p>
            )}
          </Card>

          <Card title={t('autoconfig.region')} description={t('autoconfig.regionHint')}>
            <div className="grid gap-3 md:grid-cols-2">
              {(['uiLanguage', 'systemLocale', 'userLocale'] as const).map((field) => (
                <Choice
                  key={field}
                  label={t(`autoconfig.${field}`)}
                  value={settings.locale[field]}
                  disabled={!editable}
                  options={WINDOWS_LANGUAGES.map((tag) => ({ value: tag, label: tag }))}
                  onChange={(value) => set(`locale.${field}`, value)}
                />
              ))}
              <Choice
                label={t('autoconfig.keyboard')}
                value={settings.locale.inputLocale}
                disabled={!editable}
                options={WINDOWS_KEYBOARDS.map((k) => ({
                  value: k.id,
                  label: `${k.layout} (${k.id})`,
                }))}
                onChange={(value) => set('locale.inputLocale', value)}
              />
              <Choice
                label={t('autoconfig.timeZone')}
                value={settings.locale.timeZone}
                disabled={!editable}
                options={WINDOWS_TIME_ZONES.map((z) => ({
                  value: z.id,
                  label: `${z.id} (${z.iana})`,
                }))}
                onChange={(value) => set('locale.timeZone', value)}
              />
            </div>
          </Card>

          <Card title={t('autoconfig.accounts')} description={t('autoconfig.windowsAccountsHint')}>
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <Choice
                  label={t('autoconfig.administratorPassword')}
                  value={settings.administratorPassword}
                  disabled={!editable}
                  options={[
                    { value: 'GENERATE', label: t('autoconfig.passwordGenerate') },
                    { value: 'FIXED', label: t('autoconfig.passwordFixed') },
                    ...(mspOwned
                      ? [{ value: 'PER_TENANT', label: t('autoconfig.passwordPerTenant') }]
                      : []),
                  ]}
                  onChange={(value) => set('administratorPassword', value)}
                />
                {settings.administratorPassword === 'FIXED' && (
                  <Secret
                    {...secretProps('administrator')}
                    label={t('autoconfig.administratorPassword')}
                    kind="password"
                  />
                )}
                {settings.administratorPassword === 'PER_TENANT' && (
                  <TenantPasswords
                    account="administrator"
                    tenants={passwordTenants}
                    secretPropsFor={secretProps}
                  />
                )}
              </div>
              {settings.accounts.map((account: any, index: number) => (
                <div
                  key={index}
                  className="grid gap-3 rounded border border-line p-3 md:grid-cols-4"
                >
                  <Field label={t('autoconfig.accountName')}>
                    {(props) => (
                      <TextInput
                        {...props}
                        value={account.name}
                        disabled={!editable}
                        onChange={(e) => set(`accounts.${index}.name`, e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={t('autoconfig.displayName')}>
                    {(props) => (
                      <TextInput
                        {...props}
                        value={account.displayName}
                        disabled={!editable}
                        onChange={(e) => set(`accounts.${index}.displayName`, e.target.value)}
                      />
                    )}
                  </Field>
                  <Choice
                    label={t('autoconfig.password')}
                    value={account.password}
                    disabled={!editable}
                    options={[
                      { value: 'GENERATE', label: t('autoconfig.passwordGenerate') },
                      { value: 'FIXED', label: t('autoconfig.passwordFixed') },
                    ]}
                    onChange={(value) => set(`accounts.${index}.password`, value)}
                  />
                  <div className="flex flex-col justify-end gap-2">
                    <Check
                      label={t('autoconfig.administrator')}
                      checked={account.administrator}
                      disabled={!editable}
                      onChange={(v) => set(`accounts.${index}.administrator`, v)}
                    />
                    {editable && (
                      <Button
                        variant="quiet"
                        onClick={() =>
                          set(
                            'accounts',
                            settings.accounts.filter((_: any, i: number) => i !== index),
                          )
                        }
                      >
                        {t('autoconfig.removeAccount')}
                      </Button>
                    )}
                  </div>
                  {account.password === 'FIXED' && account.name && (
                    <div className="md:col-span-4">
                      <Secret
                        {...secretProps(`account:${account.name}`)}
                        label={t('autoconfig.passwordFor', { name: account.name })}
                        kind="password"
                      />
                    </div>
                  )}
                </div>
              ))}
              {editable && settings.accounts.length < 10 && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    set('accounts', [
                      ...settings.accounts,
                      { name: '', displayName: '', administrator: false, password: 'GENERATE' },
                    ])
                  }
                >
                  {t('autoconfig.addAccount')}
                </Button>
              )}
            </div>
          </Card>

          <Card title={t('autoconfig.system')}>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t('autoconfig.workgroup')}>
                {(props) => (
                  <TextInput
                    {...props}
                    value={settings.workgroup}
                    disabled={!editable}
                    onChange={(e) => set('workgroup', e.target.value)}
                  />
                )}
              </Field>
              <Choice
                label={t('autoconfig.powerPlan')}
                value={settings.powerPlan}
                disabled={!editable}
                options={[
                  { value: 'HIGH_PERFORMANCE', label: t('autoconfig.powerHigh') },
                  { value: 'BALANCED', label: t('autoconfig.powerBalanced') },
                ]}
                onChange={(value) => set('powerPlan', value)}
              />
              <Choice
                label={t('autoconfig.windowsUpdate')}
                value={settings.windowsUpdate}
                disabled={!editable}
                options={[
                  { value: 'DEFERRED', label: t('autoconfig.updateDeferred') },
                  { value: 'DURING_SETUP', label: t('autoconfig.updateDuringSetup') },
                ]}
                onChange={(value) => set('windowsUpdate', value)}
              />
              <div className="space-y-2">
                <Check
                  label={t('autoconfig.rdp')}
                  checked={settings.rdp}
                  disabled={!editable}
                  onChange={(v) => set('rdp', v)}
                />
                <Check
                  label={t('autoconfig.hibernation')}
                  checked={settings.hibernation}
                  disabled={!editable}
                  onChange={(v) => set('hibernation', v)}
                />
              </div>
            </div>
          </Card>
        </>
      ) : (
        <>
          <Card title={t('autoconfig.image')}>
            <div className="grid gap-3 md:grid-cols-2">
              <Choice
                label={t('autoconfig.distribution')}
                value={settings.distribution}
                disabled={!editable}
                options={[
                  { value: 'UBUNTU', label: 'Ubuntu' },
                  { value: 'DEBIAN', label: 'Debian' },
                ]}
                onChange={(value) => set('distribution', value)}
              />
              <Choice
                label={t('autoconfig.cloudImage')}
                value={settings.imageFilename}
                disabled={!editable}
                options={[
                  { value: '', label: t('autoconfig.chooseFile') },
                  ...images.map((item) => ({ value: item.filename, label: item.filename })),
                ]}
                onChange={(value) => set('imageFilename', value)}
              />
              <Choice
                label={t('autoconfig.mirror')}
                hint={t('autoconfig.mirrorHint')}
                value={settings.mirror ?? ''}
                disabled={!editable}
                options={[
                  {
                    value: '',
                    label: t('autoconfig.mirrorRecommended', {
                      mirror: RECOMMENDED_MIRRORS[settings.distribution as 'UBUNTU' | 'DEBIAN'],
                    }),
                  },
                  ...ALTERNATIVE_MIRRORS[settings.distribution as 'UBUNTU' | 'DEBIAN'].map((m) => ({
                    value: m,
                    label: m,
                  })),
                ]}
                onChange={(value) => set('mirror', value || null)}
              />
              <Field label={t('autoconfig.aptProxy')}>
                {(props) => (
                  <TextInput
                    {...props}
                    placeholder="http://proxy:3142"
                    value={settings.aptProxy ?? ''}
                    disabled={!editable}
                    onChange={(e) => set('aptProxy', e.target.value || null)}
                  />
                )}
              </Field>
            </div>
          </Card>

          <Card title={t('autoconfig.region')}>
            <div className="grid gap-3 md:grid-cols-3">
              <Choice
                label={t('autoconfig.locale')}
                value={settings.locale}
                disabled={!editable}
                options={LINUX_LOCALES.map((l) => ({ value: l, label: l }))}
                onChange={(value) => set('locale', value)}
              />
              <Choice
                label={t('autoconfig.keyboard')}
                value={`${settings.keyboard.layout}:${settings.keyboard.variant}`}
                disabled={!editable}
                options={LINUX_KEYBOARDS.map((k) => ({
                  value: `${k.layout}:${k.variant}`,
                  label: k.label,
                }))}
                onChange={(value) => {
                  const [layout, variant] = value.split(':');
                  set('keyboard', { layout, variant: variant ?? '' });
                }}
              />
              <Field label={t('autoconfig.timeZone')} hint={t('autoconfig.ianaHint')}>
                {(props) => (
                  <TextInput
                    {...props}
                    value={settings.timeZone}
                    disabled={!editable}
                    onChange={(e) => set('timeZone', e.target.value)}
                  />
                )}
              </Field>
            </div>
          </Card>

          <Card title={t('autoconfig.accounts')} description={t('autoconfig.linuxAccountsHint')}>
            <div className="space-y-4">
              {settings.users.map((user: any, index: number) => (
                <div
                  key={index}
                  className="grid gap-3 rounded border border-line p-3 md:grid-cols-3"
                >
                  <Field label={t('autoconfig.accountName')}>
                    {(props) => (
                      <TextInput
                        {...props}
                        value={user.name}
                        disabled={!editable}
                        onChange={(e) => set(`users.${index}.name`, e.target.value)}
                      />
                    )}
                  </Field>
                  <Choice
                    label={t('autoconfig.password')}
                    value={user.password}
                    disabled={!editable}
                    options={[
                      { value: 'NONE', label: t('autoconfig.passwordNone') },
                      { value: 'GENERATE', label: t('autoconfig.passwordGenerate') },
                      { value: 'FIXED', label: t('autoconfig.passwordFixed') },
                    ]}
                    onChange={(value) => set(`users.${index}.password`, value)}
                  />
                  <div className="flex flex-col justify-end gap-2">
                    <Check
                      label={t('autoconfig.sudo')}
                      checked={user.sudo}
                      disabled={!editable}
                      onChange={(v) => set(`users.${index}.sudo`, v)}
                    />
                    {editable && settings.users.length > 1 && (
                      <Button
                        variant="quiet"
                        onClick={() =>
                          set(
                            'users',
                            settings.users.filter((_: any, i: number) => i !== index),
                          )
                        }
                      >
                        {t('autoconfig.removeAccount')}
                      </Button>
                    )}
                  </div>
                  <div className="md:col-span-3">
                    <Field label={t('autoconfig.sshKeys')} hint={t('autoconfig.sshKeysHint')}>
                      {(props) => (
                        <textarea
                          {...props}
                          className="min-h-20 w-full rounded border border-line bg-surface px-2.5 py-2 font-mono text-xs text-ink"
                          value={user.sshKeys.join('\n')}
                          disabled={!editable}
                          onChange={(e) =>
                            set(
                              `users.${index}.sshKeys`,
                              e.target.value
                                .split('\n')
                                .map((line) => line.trim())
                                .filter(Boolean),
                            )
                          }
                        />
                      )}
                    </Field>
                  </div>
                  {user.password === 'FIXED' && user.name && (
                    <div className="md:col-span-3">
                      <Secret
                        {...secretProps(`account:${user.name}`)}
                        label={t('autoconfig.passwordFor', { name: user.name })}
                        kind="password"
                      />
                    </div>
                  )}
                </div>
              ))}
              {editable && settings.users.length < 10 && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    set('users', [
                      ...settings.users,
                      { name: '', sudo: true, sshKeys: [], password: 'NONE' },
                    ])
                  }
                >
                  {t('autoconfig.addAccount')}
                </Button>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                <Check
                  label={t('autoconfig.rootLogin')}
                  checked={settings.root.allowLogin}
                  disabled={!editable}
                  onChange={(v) => set('root.allowLogin', v)}
                />
                <Choice
                  label={t('autoconfig.rootPassword')}
                  value={settings.root.password}
                  disabled={!editable}
                  options={[
                    { value: 'NONE', label: t('autoconfig.passwordNone') },
                    { value: 'GENERATE', label: t('autoconfig.passwordGenerate') },
                    { value: 'FIXED', label: t('autoconfig.passwordFixed') },
                    ...(mspOwned
                      ? [{ value: 'PER_TENANT', label: t('autoconfig.passwordPerTenant') }]
                      : []),
                  ]}
                  onChange={(value) => set('root.password', value)}
                />
                {settings.root.password === 'FIXED' && (
                  <Secret
                    {...secretProps('root')}
                    label={t('autoconfig.rootPassword')}
                    kind="password"
                  />
                )}
                {settings.root.password === 'PER_TENANT' && (
                  <TenantPasswords
                    account="root"
                    tenants={passwordTenants}
                    secretPropsFor={secretProps}
                  />
                )}
              </div>
            </div>
          </Card>

          <Card title={t('autoconfig.system')}>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Check
                  label={t('autoconfig.sshEnabled')}
                  checked={settings.ssh.enabled}
                  disabled={!editable}
                  onChange={(v) => set('ssh.enabled', v)}
                />
                <Check
                  label={t('autoconfig.sshPasswords')}
                  checked={settings.ssh.passwordAuthentication}
                  disabled={!editable || !settings.ssh.enabled}
                  onChange={(v) => set('ssh.passwordAuthentication', v)}
                />
                <Check
                  label={t('autoconfig.guestAgent')}
                  checked={settings.guestAgent}
                  disabled={!editable}
                  onChange={(v) => set('guestAgent', v)}
                />
                <Check
                  label={t('autoconfig.unattendedUpgrades')}
                  checked={settings.unattendedUpgrades}
                  disabled={!editable}
                  onChange={(v) => set('unattendedUpgrades', v)}
                />
              </div>
              <div className="space-y-3">
                <Field label={t('autoconfig.packages')} hint={t('autoconfig.packagesHint')}>
                  {(props) => (
                    <TextInput
                      {...props}
                      value={settings.packages.join(' ')}
                      disabled={!editable}
                      onChange={(e) =>
                        set('packages', e.target.value.split(/[\s,]+/).filter(Boolean))
                      }
                    />
                  )}
                </Field>
                <NumberField
                  label={t('autoconfig.swapMb')}
                  value={settings.swapMb}
                  disabled={!editable}
                  onChange={(v) => set('swapMb', v)}
                />
              </div>
            </div>
          </Card>
        </>
      )}

      <Card title={t('autoconfig.hardware')}>
        <div className="grid gap-3 md:grid-cols-4">
          <NumberField
            label={t('autoconfig.cores')}
            value={settings.hardware.cores}
            disabled={!editable}
            onChange={(v) => set('hardware.cores', v)}
          />
          <NumberField
            label={t('autoconfig.memoryMb')}
            value={settings.hardware.memoryMb}
            disabled={!editable}
            onChange={(v) => set('hardware.memoryMb', v)}
          />
          <NumberField
            label={t('autoconfig.diskGb')}
            value={settings.hardware.diskGb}
            disabled={!editable}
            onChange={(v) => set('hardware.diskGb', v)}
          />
          <Choice
            label={t('autoconfig.cpuType')}
            hint={t('autoconfig.cpuTypeHint')}
            value={settings.hardware.cpuType}
            disabled={!editable}
            options={[
              { value: 'x86-64-v2-AES', label: 'x86-64-v2-AES' },
              { value: 'host', label: 'host' },
            ]}
            onChange={(value) => set('hardware.cpuType', value)}
          />
        </div>
      </Card>

      {failure && (
        <FormError>
          {describeError(failure)}
          {issues.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </FormError>
      )}
      {saved && <Notice tone="ok">{t('autoconfig.saved')}</Notice>}
      <div className="flex gap-2">
        {editable && (
          <Button
            onClick={() => void save()}
            pending={pending}
            disabled={!name.trim() || (!template && !tenantId)}
          >
            {template ? t('autoconfig.save') : t('autoconfig.create')}
          </Button>
        )}
        <Link href="/autoconfig">
          <Button variant="secondary">{t('autoconfig.back')}</Button>
        </Link>
      </div>
    </div>
  );
}
