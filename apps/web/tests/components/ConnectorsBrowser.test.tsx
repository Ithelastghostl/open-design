// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorDetail } from '@open-design/contracts';

import { ConnectorsBrowser } from '../../src/components/ConnectorsBrowser';
import {
  fetchConnectorDiscovery,
  fetchConnectors,
  fetchConnectorStatuses,
} from '../../src/providers/registry';

vi.mock('../../src/providers/registry', () => ({
  connectConnector: vi.fn(),
  disconnectConnector: vi.fn(),
  fetchConnectorDiscovery: vi.fn(),
  fetchConnectors: vi.fn(),
  fetchConnectorStatuses: vi.fn(),
}));

const configuredComposioConnector: ConnectorDetail = {
  id: 'github',
  name: 'GitHub',
  provider: 'Composio',
  category: 'Code',
  status: 'connected',
  auth: { provider: 'composio', configured: true },
  tools: [],
};

describe('ConnectorsBrowser', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(fetchConnectors).mockReset();
    vi.mocked(fetchConnectorDiscovery).mockReset();
    vi.mocked(fetchConnectorStatuses).mockReset();
  });

  it('masks the grid immediately when the Composio key is cleared locally', async () => {
    vi.mocked(fetchConnectors).mockResolvedValue([configuredComposioConnector]);
    vi.mocked(fetchConnectorDiscovery).mockResolvedValue([configuredComposioConnector]);
    vi.mocked(fetchConnectorStatuses).mockResolvedValue({});

    render(
      <ConnectorsBrowser
        composioConfigured={false}
        onFocusComposioCredentials={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('connector-gate')).toBeTruthy());
    expect(screen.getByTestId('connector-grid-wrap').className).toContain('is-masked');
  });
});
