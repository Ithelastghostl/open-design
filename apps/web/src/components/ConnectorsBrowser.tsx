import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent,
} from 'react';
import type { ConnectorDetail, ConnectorStatusResponse } from '@open-design/contracts';
import { useT } from '../i18n';
import {
  connectConnector,
  disconnectConnector,
  fetchConnectorDiscovery,
  fetchConnectors,
  fetchConnectorStatuses,
} from '../providers/registry';
import {
  isTrustedConnectorCallbackOrigin,
  sortConnectorsForSearch,
} from './EntryView';
import { Icon } from './Icon';
import { CenteredLoader } from './Loading';

const CONNECTOR_CALLBACK_MESSAGE_TYPE = 'open-design:connector-connected';

function mergeConnectors(current: ConnectorDetail[], incoming: ConnectorDetail[]): ConnectorDetail[] {
  if (current.length === 0) return incoming;
  const incomingById = new Map(incoming.map((connector) => [connector.id, connector]));
  const merged = current.map((connector) => incomingById.get(connector.id) ?? connector);
  const currentIds = new Set(current.map((connector) => connector.id));
  for (const connector of incoming) {
    if (!currentIds.has(connector.id)) merged.push(connector);
  }
  return merged;
}

function applyConnectorStatuses(
  current: ConnectorDetail[],
  statuses: ConnectorStatusResponse['statuses'],
): ConnectorDetail[] {
  if (Object.keys(statuses).length === 0) return current;
  return current.map((connector) => {
    const next = statuses[connector.id];
    if (!next) return connector;
    const { accountLabel: _accountLabel, lastError: _lastError, ...base } = connector;
    return { ...base, ...next };
  });
}

interface ConnectorsBrowserProps {
  composioConfigured: boolean;
  /**
   * Scroll/focus the Composio API key field in the same Settings → Connectors
   * section. When the catalog is masked because no API key is configured,
   * the gate CTA invokes this so the user can paste their key without
   * navigating away from the connectors surface.
   */
  onFocusComposioCredentials: () => void;
}

/**
 * Connector cards + search, lifted out of the entry-view top tab so it can
 * live under Settings → Connectors. Owns its own data lifecycle: fetches the
 * catalog on mount, lazily enriches with Composio discovery when the user
 * actually opens the surface, and rehydrates statuses on window focus and
 * OAuth callback messages.
 */
/**
 * Provider tab definition. Today this is just Composio, but the surface is
 * structured as a list-of-tabs because the next provider integration (e.g.
 * a self-hosted MCP registry) is expected to drop in here without rework.
 *
 * `match` decides whether a given catalog entry belongs to this provider:
 * the entry's `auth.provider` is the source of truth, falling back to the
 * lowercased display `provider` for catalog rows that don't carry an auth
 * payload yet.
 */
const PROVIDER_TABS: ReadonlyArray<{
  id: string;
  label: string;
  match: (connector: ConnectorDetail) => boolean;
}> = [
  {
    id: 'composio',
    label: 'Composio',
    match: (connector) => {
      const provider = connector.auth?.provider ?? connector.provider.toLowerCase();
      return provider === 'composio';
    },
  },
];

const DEFAULT_PROVIDER_TAB_ID = 'composio';

export function ConnectorsBrowser({
  composioConfigured,
  onFocusComposioCredentials,
}: ConnectorsBrowserProps) {
  const t = useT();
  const [connectors, setConnectors] = useState<ConnectorDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsLoaded, setToolsLoaded] = useState(false);
  const [pendingConnectorAction, setPendingConnectorAction] = useState<{
    connectorId: string;
    action: 'connect' | 'disconnect';
  } | null>(null);
  const [detailConnectorId, setDetailConnectorId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<string>(DEFAULT_PROVIDER_TAB_ID);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const reloadConnectorStatuses = useCallback(async () => {
    const statuses = await fetchConnectorStatuses();
    setConnectors((curr) => applyConnectorStatuses(curr, statuses));
  }, []);

  // Initial catalog fetch — always loads the lightweight registry payload so
  // already-configured connectors render immediately.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const next = await fetchConnectors();
      if (cancelled) return;
      setConnectors(next);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Lazy Composio discovery — enriched toolkit metadata + auth configuration.
  // Heavier round trip; only worth it once this surface is actually mounted.
  useEffect(() => {
    if (toolsLoaded) return;
    let cancelled = false;
    setToolsLoading(true);
    (async () => {
      const next = await fetchConnectorDiscovery();
      if (cancelled) return;
      setConnectors((curr) => mergeConnectors(curr, next));
      setToolsLoaded(true);
      setToolsLoading(false);
    })();
    return () => {
      cancelled = true;
      setToolsLoading(false);
    };
  }, [toolsLoaded]);

  // OAuth callback: a popup or system-browser tab postMessages back when an
  // auth flow completes. Trust same-origin + localhost-loopback so packaged
  // dev URLs (different ports) keep working.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (
        !data ||
        typeof data !== 'object' ||
        (data as { type?: unknown }).type !== CONNECTOR_CALLBACK_MESSAGE_TYPE
      )
        return;
      if (!isTrustedConnectorCallbackOrigin(event.origin)) return;
      void reloadConnectorStatuses();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [reloadConnectorStatuses]);

  // System-browser auth flows have no opener to post back to; refresh
  // whenever the window regains focus so the UI catches up silently.
  useEffect(() => {
    function onFocus() {
      void reloadConnectorStatuses();
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reloadConnectorStatuses]);

  // The local Composio API-key state is authoritative for masking. Cached
  // connector auth can be stale immediately after the user clears the key.
  const needsComposioKey = !composioConfigured;

  // Filter and rank connectors by user-visible fields. Exact/prefix matches
  // on connector name/provider are strongest; broad description matches stay
  // searchable but are down-ranked. The provider tab restricts the catalog
  // to a single backing provider before search runs so result rankings stay
  // tab-local.
  const providerScopedConnectors = useMemo(() => {
    const tab =
      PROVIDER_TABS.find((p) => p.id === selectedProvider) ??
      PROVIDER_TABS.find((p) => p.id === DEFAULT_PROVIDER_TAB_ID);
    if (!tab) return connectors;
    return connectors.filter((connector) => tab.match(connector));
  }, [connectors, selectedProvider]);

  const filteredConnectors = useMemo(() => {
    return sortConnectorsForSearch(providerScopedConnectors, filter);
  }, [providerScopedConnectors, filter]);

  const hasQuery = filter.trim().length > 0;
  const hasNoResults = hasQuery && filteredConnectors.length === 0;

  function updateConnector(next: ConnectorDetail | null) {
    if (!next) return;
    setConnectors((curr) => curr.map((connector) => (connector.id === next.id ? next : connector)));
  }

  async function runConnectorAction(connectorId: string, action: 'connect' | 'disconnect') {
    if (pendingConnectorAction) return;
    setPendingConnectorAction({ connectorId, action });
    try {
      if (action === 'connect') {
        updateConnector(await connectConnector(connectorId));
      } else {
        updateConnector(await disconnectConnector(connectorId));
      }
    } finally {
      setPendingConnectorAction(null);
    }
  }

  const detailConnector = useMemo(
    () => (detailConnectorId ? connectors.find((c) => c.id === detailConnectorId) ?? null : null),
    [detailConnectorId, connectors],
  );

  return (
    <div className="tab-panel connectors-panel connectors-panel-embedded">
      <div className="tab-panel-toolbar">
        <div className="toolbar-left connectors-heading">
          <div>
            <h2>{t('connectors.title')}</h2>
            <p>{t('connectors.subtitle')}</p>
          </div>
        </div>
        <div className="toolbar-right">
          <div
            className="connectors-provider-tabs"
            role="tablist"
            aria-label="Connector provider"
          >
            {PROVIDER_TABS.map((provider) => {
              const active = provider.id === selectedProvider;
              return (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`connectors-provider-tab${active ? ' is-active' : ''}`}
                  onClick={() => setSelectedProvider(provider.id)}
                  data-testid={`connectors-provider-tab-${provider.id}`}
                >
                  {provider.label}
                </button>
              );
            })}
          </div>
          <div className="toolbar-search connectors-search">
            <span className="search-icon" aria-hidden>
              <Icon name="search" size={13} />
            </span>
            <input
              ref={searchInputRef}
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && filter) {
                  event.preventDefault();
                  event.stopPropagation();
                  setFilter('');
                }
              }}
              placeholder={t('connectors.searchPlaceholder')}
              aria-label={t('connectors.searchAriaLabel')}
              disabled={needsComposioKey}
              data-testid="connectors-search-input"
            />
            {hasQuery ? (
              <button
                type="button"
                className="toolbar-search-clear"
                aria-label={t('connectors.searchClear')}
                onClick={() => {
                  setFilter('');
                  searchInputRef.current?.focus();
                }}
                data-testid="connectors-search-clear"
              >
                <Icon name="close" size={12} />
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {loading ? (
        <CenteredLoader label={t('common.loading')} />
      ) : (
        <div
          className={`connector-grid-wrap${needsComposioKey ? ' is-masked' : ''}`}
          data-testid="connector-grid-wrap"
        >
          {hasNoResults && !needsComposioKey ? (
            <div
              className="tab-empty connectors-empty"
              role="status"
              aria-live="polite"
              data-testid="connectors-empty"
            >
              <p className="connectors-empty-title">
                {t('connectors.emptyNoMatchTitle', { query: filter.trim() })}
              </p>
              <p className="connectors-empty-body">{t('connectors.emptyNoMatchBody')}</p>
              <button
                type="button"
                className="ghost connectors-empty-action"
                onClick={() => {
                  setFilter('');
                  searchInputRef.current?.focus();
                }}
              >
                {t('connectors.emptyNoMatchAction')}
              </button>
            </div>
          ) : (
            <div
              className="connector-grid"
              aria-hidden={needsComposioKey || undefined}
            >
              {filteredConnectors.map((connector) => (
                <ConnectorCard
                  key={connector.id}
                  connector={connector}
                  disabled={needsComposioKey}
                  pendingAction={
                    pendingConnectorAction?.connectorId === connector.id
                      ? pendingConnectorAction.action
                      : null
                  }
                  toolsLoading={toolsLoading}
                  toolsLoaded={toolsLoaded}
                  onConnect={(connectorId) => runConnectorAction(connectorId, 'connect')}
                  onDisconnect={(connectorId) => runConnectorAction(connectorId, 'disconnect')}
                  onOpenDetails={(connectorId) => setDetailConnectorId(connectorId)}
                />
              ))}
            </div>
          )}
          {needsComposioKey ? (
            <div
              className="connector-gate"
              role="region"
              aria-label={t('connectors.gateTitle')}
              data-testid="connector-gate"
            >
              <div className="connector-gate-card">
                <div className="connector-gate-icon" aria-hidden>
                  <Icon name="settings" size={20} />
                </div>
                <h3 className="connector-gate-title">{t('connectors.gateTitle')}</h3>
                <p className="connector-gate-body">{t('connectors.gateBody')}</p>
                <button
                  type="button"
                  className="primary connector-gate-action"
                  onClick={onFocusComposioCredentials}
                  data-testid="connector-gate-action"
                >
                  {t('connectors.gateAction')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}
      {detailConnector ? (
        <ConnectorDetailDrawer
          connector={detailConnector}
          disabled={needsComposioKey}
          pendingAction={
            pendingConnectorAction?.connectorId === detailConnector.id
              ? pendingConnectorAction.action
              : null
          }
          toolsLoading={toolsLoading}
          toolsLoaded={toolsLoaded}
          onClose={() => setDetailConnectorId(null)}
          onConnect={(connectorId) => runConnectorAction(connectorId, 'connect')}
          onDisconnect={(connectorId) => runConnectorAction(connectorId, 'disconnect')}
        />
      ) : null}
    </div>
  );
}

function ConnectorCard({
  connector,
  disabled = false,
  pendingAction,
  toolsLoading: _toolsLoading,
  toolsLoaded,
  onConnect,
  onDisconnect,
  onOpenDetails,
}: {
  connector: ConnectorDetail;
  disabled?: boolean;
  pendingAction: 'connect' | 'disconnect' | null;
  toolsLoading: boolean;
  toolsLoaded: boolean;
  onConnect: (connectorId: string) => Promise<void> | void;
  onDisconnect: (connectorId: string) => Promise<void> | void;
  onOpenDetails: (connectorId: string) => void;
}) {
  const t = useT();
  const isConnecting = pendingAction === 'connect';
  const isDisconnecting = pendingAction === 'disconnect';
  const isPending = pendingAction !== null;
  const isConnected = connector.status === 'connected';
  const canConnect = !disabled && !isPending && connector.status === 'available';
  const canDisconnect = !disabled && !isPending && isConnected;
  const toolCount = connector.tools.length;
  const showToolsBadge = toolsLoaded;
  const toolsBadgeLabel = formatToolsBadge(toolCount, t);

  function openDetails() {
    if (disabled) return;
    onOpenDetails(connector.id);
  }

  function onKeyActivate(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    openDetails();
  }

  function stop(event: SyntheticEvent) {
    event.stopPropagation();
  }

  return (
    <article
      className={`connector-card status-${connector.status}${disabled ? ' is-locked' : ''}`}
      data-connector-id={connector.id}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={t('connectors.openDetailsAria', { name: connector.name })}
      onClick={openDetails}
      onKeyDown={onKeyActivate}
    >
      <div className="connector-card-top">
        <div className="connector-card-head">
          <h3 className="connector-card-title">{connector.name}</h3>
          <div className="connector-meta">
            <span className="connector-meta-item">{connector.category}</span>
            {showToolsBadge ? (
              <>
                <span className="connector-meta-dot" aria-hidden>·</span>
                <span className="connector-tools-badge is-ready" title={toolsBadgeLabel}>
                  <span>{toolsBadgeLabel}</span>
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="connector-card-actions">
          {isConnected ? (
            <span
              className={`connector-status-dot status-${connector.status}`}
              aria-label={statusLabel(connector.status, t)}
              title={statusLabel(connector.status, t)}
            />
          ) : null}
          {isConnected ? (
            <button
              type="button"
              className={`icon-only connector-action is-disconnect${isDisconnecting ? ' is-loading' : ''}`}
              disabled={!canDisconnect}
              aria-busy={isDisconnecting || undefined}
              aria-label={t('connectors.disconnect')}
              title={t('connectors.disconnect')}
              tabIndex={disabled ? -1 : undefined}
              onMouseDown={stop}
              onKeyDown={stop}
              onClick={(e) => {
                stop(e);
                onDisconnect(connector.id);
              }}
            >
              <Icon name={isDisconnecting ? 'spinner' : 'close'} size={12} />
            </button>
          ) : (
            <button
              type="button"
              className={`icon-only connector-action is-connect${isConnecting ? ' is-loading' : ''}`}
              disabled={!canConnect}
              aria-busy={isConnecting || undefined}
              aria-label={t('connectors.connect')}
              title={t('connectors.connect')}
              tabIndex={disabled ? -1 : undefined}
              onMouseDown={stop}
              onKeyDown={stop}
              onClick={(e) => {
                stop(e);
                onConnect(connector.id);
              }}
            >
              <Icon name={isConnecting ? 'spinner' : 'plus'} size={12} />
            </button>
          )}
          {connector.status === 'error' || connector.status === 'disabled' ? (
            <span className={`connector-status-pill status-${connector.status}`}>
              {statusLabel(connector.status, t)}
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function statusLabel(status: ConnectorDetail['status'], t: ReturnType<typeof useT>): string {
  switch (status) {
    case 'available':
      return t('connectors.statusAvailable');
    case 'connected':
      return t('connectors.statusConnected');
    case 'error':
      return t('connectors.statusError');
    case 'disabled':
      return t('connectors.statusDisabled');
  }
}

function formatToolsBadge(count: number, t: ReturnType<typeof useT>): string {
  if (count === 0) return t('connectors.toolsBadgeNone');
  if (count === 1) return t('connectors.toolsBadgeOne', { n: count });
  return t('connectors.toolsBadgeMany', { n: count });
}

function ConnectorDetailDrawer({
  connector,
  disabled,
  pendingAction,
  toolsLoading,
  toolsLoaded,
  onClose,
  onConnect,
  onDisconnect,
}: {
  connector: ConnectorDetail;
  disabled: boolean;
  pendingAction: 'connect' | 'disconnect' | null;
  toolsLoading: boolean;
  toolsLoaded: boolean;
  onClose: () => void;
  onConnect: (connectorId: string) => Promise<void> | void;
  onDisconnect: (connectorId: string) => Promise<void> | void;
}) {
  const t = useT();
  const isConnected = connector.status === 'connected';
  const isConnecting = pendingAction === 'connect';
  const isDisconnecting = pendingAction === 'disconnect';
  const isPending = pendingAction !== null;
  const canConnect = !disabled && !isPending && connector.status === 'available';
  const canDisconnect = !disabled && !isPending && isConnected;
  const accountLabel = getDisplayableConnectorAccountLabel(connector);
  const toolCount = connector.tools.length;
  const isLoadingTools = !toolsLoaded || (toolsLoading && toolCount === 0);
  const showToolsBadge = toolsLoaded;
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    closeBtnRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const statusTone = connector.status;

  return (
    <div
      className="connector-drawer-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        className="connector-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connector-drawer-title"
        data-testid="connector-drawer"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="connector-drawer-head">
          <div className="connector-drawer-titles">
            <div className="connector-drawer-eyebrow">
              <span>{connector.category}</span>
              <span className="connector-meta-dot" aria-hidden>·</span>
              <span>{connector.provider}</span>
            </div>
            <h2 id="connector-drawer-title">{connector.name}</h2>
            <div className="connector-drawer-status">
              <span className={`connector-status-pill status-${statusTone}`}>
                <span className="connector-status-dot" aria-hidden />
                {statusLabel(connector.status, t)}
              </span>
              {showToolsBadge ? (
                <span className="connector-tools-badge is-ready" title={formatToolsBadge(toolCount, t)}>
                  <Icon name="settings" size={10} />
                  <span>{formatToolsBadge(toolCount, t)}</span>
                </span>
              ) : null}
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="ghost connector-drawer-close"
            onClick={onClose}
            aria-label={t('common.close')}
            data-testid="connector-drawer-close"
          >
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="connector-drawer-body">
          {connector.description ? (
            <section className="connector-drawer-section">
              <h3 className="connector-drawer-section-title">{t('connectors.aboutLabel')}</h3>
              <p className="connector-drawer-description">{connector.description}</p>
            </section>
          ) : null}

          <section className="connector-drawer-section">
            <h3 className="connector-drawer-section-title">{t('connectors.detailsLabel')}</h3>
            <dl className="connector-drawer-details">
              <div>
                <dt>{t('connectors.statusLabel')}</dt>
                <dd>{statusLabel(connector.status, t)}</dd>
              </div>
              <div>
                <dt>{t('connectors.categoryLabel')}</dt>
                <dd>{connector.category}</dd>
              </div>
              <div>
                <dt>{t('connectors.providerLabel')}</dt>
                <dd>{connector.provider}</dd>
              </div>
              {accountLabel ? (
                <div>
                  <dt>{t('connectors.account')}</dt>
                  <dd>{accountLabel}</dd>
                </div>
              ) : null}
              {connector.lastError ? (
                <div className="connector-drawer-details-error">
                  <dt>{t('connectors.statusError')}</dt>
                  <dd>{connector.lastError}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section className="connector-drawer-section">
            <h3 className="connector-drawer-section-title">
              {t('connectors.toolsSection')} <span className="connector-drawer-count">{toolCount}</span>
            </h3>
            {isLoadingTools ? (
              <p className="connector-drawer-empty"><Icon name="spinner" size={12} /> {t('connectors.toolsLoading')}</p>
            ) : toolCount === 0 ? (
              <p className="connector-drawer-empty">{t('connectors.noToolsAvailable')}</p>
            ) : (
              <ul className="connector-drawer-tools">
                {connector.tools.map((tool) => (
                  <li key={tool.name} className="connector-drawer-tool">
                    <div className="connector-drawer-tool-head">
                      <span className="connector-drawer-tool-title">{tool.title || tool.name}</span>
                      <span
                        className={`connector-drawer-tool-badge side-${tool.safety.sideEffect}`}
                        title={tool.safety.reason}
                      >
                        {tool.safety.sideEffect}
                      </span>
                    </div>
                    {tool.description ? (
                      <p className="connector-drawer-tool-desc">{tool.description}</p>
                    ) : null}
                    <code className="connector-drawer-tool-name">{tool.name}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer className="connector-drawer-foot">
          {isConnected ? (
            <button
              type="button"
              className={`ghost connector-action is-disconnect${isDisconnecting ? ' is-loading' : ''}`}
              disabled={!canDisconnect}
              aria-busy={isDisconnecting || undefined}
              onClick={() => onDisconnect(connector.id)}
            >
              {isDisconnecting ? <Icon name="spinner" size={12} /> : null}
              <span>{t('connectors.disconnect')}</span>
            </button>
          ) : (
            <button
              type="button"
              className={`primary connector-action is-connect${isConnecting ? ' is-loading' : ''}`}
              disabled={!canConnect}
              aria-busy={isConnecting || undefined}
              onClick={() => onConnect(connector.id)}
            >
              {isConnecting ? <Icon name="spinner" size={12} /> : null}
              <span>{t('connectors.connect')}</span>
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}

function getDisplayableConnectorAccountLabel(connector: ConnectorDetail): string | undefined {
  if (!connector.accountLabel) return undefined;
  const provider = connector.auth?.provider ?? connector.provider.toLowerCase();
  if (provider === 'composio') return undefined;
  return connector.accountLabel;
}
