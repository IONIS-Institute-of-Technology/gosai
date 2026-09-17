import { useState } from 'react';
import type { DriverInfo, DriverRuntimeInfo, DriverSchema } from '@gosai/shared';
import { useServerResource } from '../../../lib/use-server-resource.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorText } from '../../components/ErrorText.js';
import { Panel } from '../../components/Panel.js';
import { SchemaTree } from './SchemaTree.js';

/**
 * Every driver the server knows, including drivers no installed app uses, with
 * the events, actions and config its schema declares.
 */
export function DriversPanel(): React.ReactElement {
  const drivers = useServerResource(
    { command: 'drivers:list', select: (r) => r.drivers },
    { 'drivers:list-changed': (p) => p.drivers },
  );
  const list = drivers.data ?? [];
  // A new schema version, or a new driver, loads the schemas again.
  const versions = list.map((d) => `${d.name}@${d.schemaVersion ?? ''}`).join(',');
  const schemas = useServerResource({
    command: 'drivers:schema',
    payload: {},
    select: (r) => r.schemas,
    enabled: versions !== '',
    key: versions,
  });

  return (
    <div className="space-y-6 p-6">
      <Panel title={`Drivers (${list.length})`}>
        <ErrorText error={drivers.error ?? schemas.error} />
        {list.length === 0 ? (
          <EmptyState message={drivers.data ? 'No drivers registered' : 'Loading…'} />
        ) : (
          <ul className="divide-y divide-neutral-800 overflow-hidden rounded border border-neutral-800">
            {list.map((driver) => (
              <DriverRow
                key={driver.name}
                driver={driver}
                schema={schemas.data?.[driver.name]?.schema ?? null}
                schemaLoading={schemas.loading}
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function DriverRow({
  driver,
  schema,
  schemaLoading,
}: {
  readonly driver: DriverInfo;
  readonly schema: DriverSchema | null;
  readonly schemaLoading: boolean;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const events = schema ? Object.keys(schema.events) : driver.events;
  const actions = schema ? Object.keys(schema.actions) : driver.actions;

  return (
    <li className="bg-neutral-900/40">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-neutral-900/60"
      >
        <span
          className={`shrink-0 text-neutral-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
          aria-hidden
        >
          ▸
        </span>
        <span className="w-48 shrink-0 truncate font-mono text-sm text-neutral-100">
          {driver.name}
        </span>
        <StatePill state={driver.state} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-500">
          {events.length} events · {actions.length} actions ·{' '}
          {driver.shared ? 'shared' : 'one instance per app'}
          {driver.subscribers.length > 0 ? ` · ${driver.subscribers.length} subscribers` : ''}
        </span>
        <span className="shrink-0 font-mono text-[11px]">
          <HardwareLabel runtime={driver.runtime} />
        </span>
      </button>

      {expanded ? (
        <div className="space-y-4 border-t border-neutral-800 bg-neutral-950/40 px-4 py-3 pl-10">
          {driver.description ? (
            <p className="text-xs text-neutral-400">{driver.description}</p>
          ) : null}
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
            <dt className="text-neutral-500">dependencies</dt>
            <dd className="text-neutral-300">{driver.dependencies.join(', ') || '—'}</dd>
            <dt className="text-neutral-500">instances</dt>
            <dd className="text-neutral-300">
              {driver.instances?.length
                ? driver.instances.map((i) => `${i.instance} (${i.state})`).join(', ')
                : '—'}
            </dd>
            <dt className="text-neutral-500">schema</dt>
            <dd className="text-neutral-300">{driver.schemaVersion ?? 'none'}</dd>
          </dl>

          {schema ? (
            <DriverSchemaView schema={schema} />
          ) : (
            <p className="font-mono text-[11px] text-neutral-500">
              {schemaLoading ? 'Loading the schema…' : 'This driver publishes no schema.'}
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function DriverSchemaView({ schema }: { readonly schema: DriverSchema }): React.ReactElement {
  const events = Object.entries(schema.events);
  const actions = Object.entries(schema.actions);
  return (
    <div className="space-y-4">
      <Section title="Config">
        {schema.config ? (
          <SchemaTree schema={schema.config} root={schema} />
        ) : (
          <p className="font-mono text-[11px] text-neutral-500">No options.</p>
        )}
      </Section>

      <Section title={`Events (${events.length})`}>
        {events.length === 0 ? (
          <p className="font-mono text-[11px] text-neutral-500">None.</p>
        ) : (
          events.map(([name, event]) => (
            <Entry
              key={name}
              name={name}
              tags={[
                event.delivery === 'buffered' && event.queue_size
                  ? `buffered, ${event.queue_size} queued`
                  : event.delivery,
              ]}
              description={event.description}
            >
              <Labeled label="payload">
                <SchemaTree schema={event.payload} root={schema} />
              </Labeled>
            </Entry>
          ))
        )}
      </Section>

      <Section title={`Actions (${actions.length})`}>
        {actions.length === 0 ? (
          <p className="font-mono text-[11px] text-neutral-500">None.</p>
        ) : (
          actions.map(([name, action]) => (
            <Entry
              key={name}
              name={name}
              tags={[
                action.requires_instance ? 'needs a running instance' : 'runs without an instance',
              ]}
              description={action.description}
            >
              <Labeled label="params">
                {action.params ? (
                  <SchemaTree schema={action.params} root={schema} />
                ) : (
                  <span className="font-mono text-[11px] text-neutral-500">none</span>
                )}
              </Labeled>
              <Labeled label="result">
                <SchemaTree schema={action.result} root={schema} />
              </Labeled>
            </Entry>
          ))
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="space-y-2">
      <h3 className="font-mono text-[10px] tracking-wider text-neutral-400 uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Entry({
  name,
  tags,
  description,
  children,
}: {
  readonly name: string;
  readonly tags: readonly string[];
  readonly description: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-1.5 rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-xs text-neutral-100">{name}</span>
        {tags.map((tag) => (
          <span
            key={tag}
            className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
          >
            {tag}
          </span>
        ))}
        {description ? <span className="text-[11px] text-neutral-400">{description}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Labeled({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[4rem_1fr] gap-2">
      <span className="font-mono text-[10px] tracking-wider text-neutral-500 uppercase">
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function HardwareLabel({ runtime }: { runtime?: DriverRuntimeInfo }): React.ReactElement {
  if (!runtime) return <span className="text-neutral-600">—</span>;
  const device = runtime.device ?? (runtime.accelerated ? 'accelerated' : 'cpu');
  const provider = runtime.provider ? ` via ${runtime.provider}` : '';
  const model = runtime.model ? ` (${runtime.model})` : '';
  const title = [runtime.backend, runtime.reason].filter(Boolean).join(' · ');
  return (
    <span
      className={runtime.accelerated ? 'text-green-300' : 'text-yellow-300'}
      title={title || undefined}
    >
      {device}
      {provider}
      {model}
    </span>
  );
}

const STATE_COLORS: Record<string, string> = {
  available: 'bg-neutral-800 text-neutral-400',
  starting: 'bg-yellow-950 text-yellow-300',
  running: 'bg-green-950 text-green-300',
  paused: 'bg-blue-950 text-blue-300',
  stopping: 'bg-yellow-950 text-yellow-300',
  stopped: 'bg-neutral-800 text-neutral-400',
  errored: 'bg-red-950 text-red-300',
};

function StatePill({ state }: { state: string }): React.ReactElement {
  return (
    <span
      className={`shrink-0 rounded px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase ${STATE_COLORS[state] ?? STATE_COLORS.available}`}
    >
      {state}
    </span>
  );
}
