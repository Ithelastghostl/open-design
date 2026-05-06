import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentRefreshOptionsForConfig,
  isValidApiBaseUrl,
  persistConfigAndRunOrbit,
  switchApiProtocolConfig,
  updateAgentCliEnvValue,
  updateCurrentApiProtocolConfig,
} from '../../src/components/SettingsDialog';
import type { AppConfig } from '../../src/types';

const originalFetch = globalThis.fetch;

const baseConfig: AppConfig = {
  mode: 'api',
  apiKey: 'sk-test',
  apiProtocol: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  agentId: null,
  skillId: null,
  designSystemId: null,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SettingsDialog API protocol switching', () => {
  it('stores the current custom protocol config while preserving custom endpoint details', () => {
    const config: AppConfig = {
      ...baseConfig,
      apiKey: 'anthropic-key',
      apiProviderBaseUrl: null,
      baseUrl: 'https://my-proxy.example.com',
      model: 'my-model',
    };

    const next = switchApiProtocolConfig(config, 'openai');

    expect(next).toMatchObject({
      mode: 'api',
      apiProtocol: 'openai',
      apiKey: '',
      baseUrl: 'https://my-proxy.example.com',
      model: 'my-model',
      apiProviderBaseUrl: null,
    });
    expect(next.apiProtocolConfigs?.anthropic).toMatchObject({
      apiKey: 'anthropic-key',
      baseUrl: 'https://my-proxy.example.com',
      model: 'my-model',
      apiProviderBaseUrl: null,
    });
  });

  it('restores each protocol draft instead of leaking shared field values', () => {
    const openai = switchApiProtocolConfig(baseConfig, 'openai');
    const openaiEdited = updateCurrentApiProtocolConfig(openai, {
      apiKey: 'openai-key',
      baseUrl: 'https://openai-proxy.example.com',
      model: 'openai-model',
      apiProviderBaseUrl: null,
    });
    const google = switchApiProtocolConfig(openaiEdited, 'google');
    const googleEdited = updateCurrentApiProtocolConfig(google, {
      apiKey: 'google-key',
      baseUrl: 'https://google-proxy.example.com',
      model: 'google-model',
      apiProviderBaseUrl: null,
    });

    const restoredOpenai = switchApiProtocolConfig(googleEdited, 'openai');

    expect(restoredOpenai).toMatchObject({
      mode: 'api',
      apiProtocol: 'openai',
      apiKey: 'openai-key',
      baseUrl: 'https://openai-proxy.example.com',
      model: 'openai-model',
      apiProviderBaseUrl: null,
    });
    expect(restoredOpenai.apiProtocolConfigs?.google).toMatchObject({
      apiKey: 'google-key',
      baseUrl: 'https://google-proxy.example.com',
      model: 'google-model',
      apiProviderBaseUrl: null,
    });
  });

  it('loads the new protocol default on first visit', () => {
    expect(switchApiProtocolConfig(baseConfig, 'openai')).toMatchObject({
      mode: 'api',
      apiProtocol: 'openai',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiProviderBaseUrl: 'https://api.openai.com/v1',
    });
  });

  it('auto-fills Google defaults when switching from a selected known provider', () => {
    expect(switchApiProtocolConfig(baseConfig, 'google')).toMatchObject({
      mode: 'api',
      apiProtocol: 'google',
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.0-flash',
      apiProviderBaseUrl: 'https://generativelanguage.googleapis.com',
    });
  });

  it('keeps Azure API version in the Azure draft only', () => {
    const config: AppConfig = {
      ...baseConfig,
      apiProtocol: 'azure',
      apiKey: 'azure-key',
      model: 'deployment-one',
      apiVersion: '2024-10-21',
    };

    const next = switchApiProtocolConfig(config, 'openai');

    expect(next).toMatchObject({
      apiProtocol: 'openai',
      apiKey: '',
      apiVersion: '',
    });
    expect(next.apiProtocolConfigs?.azure).toMatchObject({
      apiKey: 'azure-key',
      model: 'deployment-one',
      apiVersion: '2024-10-21',
    });
  });
});

describe('SettingsDialog API Base URL validation', () => {
  it('accepts public http/https URLs and loopback local providers', () => {
    expect(isValidApiBaseUrl('https://api.openai.com/v1')).toBe(true);
    expect(isValidApiBaseUrl('http://localhost:11434/v1')).toBe(true);
    expect(isValidApiBaseUrl('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isValidApiBaseUrl('http://[::1]:11434/v1')).toBe(true);
    expect(isValidApiBaseUrl('  https://resource.openai.azure.com  ')).toBe(true);

    expect(isValidApiBaseUrl('ddddd')).toBe(false);
    expect(isValidApiBaseUrl('api.openai.com/v1')).toBe(false);
    expect(isValidApiBaseUrl('ftp://api.example.com')).toBe(false);
    expect(isValidApiBaseUrl('http:api.example.com')).toBe(false);
    expect(isValidApiBaseUrl('https://')).toBe(false);
    expect(isValidApiBaseUrl('http://10.0.0.5:11434/v1')).toBe(false);
    expect(isValidApiBaseUrl('http://169.254.1.5:11434/v1')).toBe(false);
    expect(isValidApiBaseUrl('http://172.16.0.5:11434/v1')).toBe(false);
    expect(isValidApiBaseUrl('http://192.168.1.5:11434/v1')).toBe(false);
  });
});

describe('SettingsDialog agent CLI env settings', () => {
  it('updates supported per-agent CLI env values without dropping sibling agents', () => {
    const config: AppConfig = {
      ...baseConfig,
      mode: 'daemon',
      agentCliEnv: {
        codex: { CODEX_HOME: '~/.codex-alt' },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'claude',
      'CLAUDE_CONFIG_DIR',
      '  ~/.claude-2  ',
    );

    expect(next.agentCliEnv).toEqual({
      claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
      codex: { CODEX_HOME: '~/.codex-alt' },
    });
  });

  it('removes empty per-agent CLI env entries', () => {
    const config: AppConfig = {
      ...baseConfig,
      mode: 'daemon',
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-2' },
        codex: { CODEX_HOME: '~/.codex-alt' },
      },
    };

    const next = updateAgentCliEnvValue(
      config,
      'claude',
      'CLAUDE_CONFIG_DIR',
      '',
    );

    expect(next.agentCliEnv).toEqual({
      codex: { CODEX_HOME: '~/.codex-alt' },
    });
  });

  it('passes pending CLI env prefs through agent rescan options', () => {
    const config: AppConfig = {
      ...baseConfig,
      mode: 'daemon',
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-pending' },
      },
    };

    expect(agentRefreshOptionsForConfig(config)).toEqual({
      throwOnError: true,
      agentCliEnv: {
        claude: { CLAUDE_CONFIG_DIR: '~/.claude-pending' },
      },
    });
  });

  it('passes an empty CLI env object through agent rescan after fields are cleared', () => {
    const config: AppConfig = {
      ...baseConfig,
      mode: 'daemon',
      agentCliEnv: {},
    };

    expect(agentRefreshOptionsForConfig(config)).toEqual({
      throwOnError: true,
      agentCliEnv: {},
    });
  });
});

describe('SettingsDialog Orbit run behavior', () => {
  it('persists the current orbit template config before starting the run', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url, method, body });

      if (url === '/api/app-config') {
        return new Response(null, { status: 204 });
      }
      if (url === '/api/orbit/run') {
        return new Response(JSON.stringify({ projectId: 'orbit-project', agentRunId: 'run-1' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(
      persistConfigAndRunOrbit({
        ...baseConfig,
        orbit: {
          enabled: true,
          time: '09:30',
          templateSkillId: 'orbit-template-1',
        },
      }),
    ).resolves.toEqual({ projectId: 'orbit-project', agentRunId: 'run-1' });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: '/api/app-config',
      method: 'PUT',
    });
    expect(JSON.parse(calls[0]!.body ?? '{}')).toMatchObject({
      orbit: {
        enabled: true,
        time: '09:30',
        templateSkillId: 'orbit-template-1',
      },
    });
    expect(calls[1]).toMatchObject({
      url: '/api/orbit/run',
      method: 'POST',
    });
  });
});
