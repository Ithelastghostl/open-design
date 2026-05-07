import { describe, expect, it } from 'vitest';

import { shouldSyncMediaProvidersOnSave } from '../src/App';

describe('App config save media provider sync', () => {
  it('does not sync an empty media provider map to the daemon', () => {
    expect(shouldSyncMediaProvidersOnSave({})).toBe(false);
  });

  it('syncs media providers when a credential field is present', () => {
    expect(
      shouldSyncMediaProvidersOnSave({
        openai: { apiKey: 'media-key', baseUrl: '' },
      }),
    ).toBe(true);
  });
});
