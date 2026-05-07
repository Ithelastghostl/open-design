import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STORAGE_KEY = 'open-design:config';
const FAKE_CODEX_DIR = path.join(tmpdir(), `open-design-playwright-fake-codex-${process.pid}`);
const FAKE_CODEX_BIN = path.join(FAKE_CODEX_DIR, 'codex-e2e.js');
const GENERATED_FILE = 'real-daemon-smoke.html';
const GENERATED_HEADING = 'Real Daemon Smoke';
const CHUNKED_FILE = 'chunked-daemon-smoke.html';
const CHUNKED_HEADING = 'Chunked Daemon Smoke';
const FOLLOW_UP_FILE = 'follow-up-daemon-smoke.html';

test.beforeAll(async () => {
  await mkdir(FAKE_CODEX_DIR, { recursive: true });
  await writeFile(
    FAKE_CODEX_BIN,
    `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('codex-e2e 0.0.0\\n');
  process.exit(0);
}
process.stdin.resume();
process.stdin.setEncoding('utf8');
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  if (prompt.includes('Return an intentional daemon smoke failure')) {
    process.stdout.write(JSON.stringify({ type: 'thread.started' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'intentional fake codex failure' } }) + '\\n');
    process.exit(0);
  }
  const isChunked = prompt.includes('Create a chunked deterministic smoke artifact');
  const isFollowUp = prompt.includes('Create a follow-up deterministic smoke artifact');
  const heading = isChunked ? '${CHUNKED_HEADING}' : isFollowUp ? 'Follow-up Daemon Smoke' : '${GENERATED_HEADING}';
  const fileText = isChunked ? 'Chunked through the daemon run path.' : isFollowUp ? 'Generated after an earlier daemon turn.' : 'Generated through the daemon run path.';
  const identifier = isChunked ? 'chunked-daemon-smoke' : isFollowUp ? 'follow-up-daemon-smoke' : 'real-daemon-smoke';
  const html = '<!doctype html><html><body><main><h1>' + heading + '</h1><p>' + fileText + '</p></main></body></html>';
  const artifact = '<artifact identifier="' + identifier + '" type="text/html" title="' + heading + '">' + html + '</artifact>';
  const events = [
    { type: 'thread.started' },
    { type: 'turn.started' },
    ...(isChunked
      ? [
          { type: 'item.completed', item: { type: 'agent_message', text: artifact.slice(0, Math.ceil(artifact.length / 2)) } },
          { type: 'item.completed', item: { type: 'agent_message', text: artifact.slice(Math.ceil(artifact.length / 2)) } },
        ]
      : [{ type: 'item.completed', item: { type: 'agent_message', text: artifact + '\\nPrompt included: ' + String(prompt.includes('Create a deterministic smoke artifact') || isFollowUp) } }]),
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
});
`,
    'utf8',
  );
  await chmod(FAKE_CODEX_BIN, 0o755);
});

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);

  await resetDaemonAppConfig(page);

  await page.addInitScript(({ key, codexBin }) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        mode: 'daemon',
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        agentId: 'codex',
        skillId: null,
        designSystemId: null,
        onboardingCompleted: true,
        agentModels: { codex: { model: 'default', reasoning: 'default' } },
        agentCliEnv: { codex: { CODEX_BIN: codexBin } },
      }),
    );
  }, { key: STORAGE_KEY, codexBin: FAKE_CODEX_BIN });

  const response = await page.request.put('/api/app-config', {
    data: {
      onboardingCompleted: true,
      agentId: 'codex',
      agentModels: { codex: { model: 'default', reasoning: 'default' } },
      agentCliEnv: { codex: { CODEX_BIN: FAKE_CODEX_BIN } },
      skillId: null,
      designSystemId: null,
    },
  });
  expect(response.ok()).toBeTruthy();
});

test.afterEach(async ({ page }) => {
  await resetDaemonAppConfig(page);
});

test('real daemon run streams, persists, and previews an artifact', async ({ page }) => {
  await page.goto('/');
  await createProject(page, 'Real daemon run smoke');
  await expectWorkspaceReady(page);

  await sendPrompt(page, 'Create a deterministic smoke artifact');

  await expect(page.getByText(GENERATED_FILE, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('artifact-preview-frame')).toBeVisible();
  const frame = page.frameLocator('[data-testid="artifact-preview-frame"]');
  await expect(frame.getByRole('heading', { name: GENERATED_HEADING })).toBeVisible();

  const { projectId } = currentProject(page);
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/projects/${projectId}/files/${GENERATED_FILE}`);
      if (!response.ok()) return '';
      return response.text();
    })
    .toContain(GENERATED_HEADING);
});

test('real daemon run persists an artifact streamed across multiple chunks', async ({ page }) => {
  await page.goto('/');
  await createProject(page, 'Chunked daemon run smoke');
  await expectWorkspaceReady(page);

  await sendPrompt(page, 'Create a chunked deterministic smoke artifact');

  await expect(page.getByText(CHUNKED_FILE, { exact: true })).toBeVisible({ timeout: 15_000 });
  const frame = page.frameLocator('[data-testid="artifact-preview-frame"]');
  await expect(frame.getByRole('heading', { name: CHUNKED_HEADING })).toBeVisible();

  const { projectId } = currentProject(page);
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/projects/${projectId}/files/${CHUNKED_FILE}`);
      if (!response.ok()) return '';
      return response.text();
    })
    .toContain(CHUNKED_HEADING);
});

test('real daemon run surfaces process/parser errors in chat', async ({ page }) => {
  await page.goto('/');
  await createProject(page, 'Daemon error smoke');
  await expectWorkspaceReady(page);

  await sendPrompt(page, 'Return an intentional daemon smoke failure');

  await expect(page.locator('.msg.error')).toContainText('intentional fake codex failure', { timeout: 15_000 });
  await expect(page.locator('.status-pill', { hasText: 'intentional fake codex failure' })).toBeVisible();
});

test('real daemon run supports a follow-up turn in the same project', async ({ page }) => {
  await page.goto('/');
  await createProject(page, 'Daemon follow-up smoke');
  await expectWorkspaceReady(page);

  await sendPrompt(page, 'Create a deterministic smoke artifact');
  await expect(page.getByText(GENERATED_FILE, { exact: true })).toBeVisible({ timeout: 15_000 });

  await sendPrompt(page, 'Create a follow-up deterministic smoke artifact');
  await expect(page.getByText(FOLLOW_UP_FILE, { exact: true })).toBeVisible({ timeout: 15_000 });

  const { projectId } = currentProject(page);
  const response = await page.request.get(`/api/projects/${projectId}/files`);
  expect(response.ok()).toBeTruthy();
  const { files } = (await response.json()) as { files: Array<{ name: string }> };
  expect(files.map((file) => file.name)).toEqual(expect.arrayContaining([GENERATED_FILE, FOLLOW_UP_FILE]));

  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/projects/${projectId}/files/${FOLLOW_UP_FILE}`);
      if (!response.ok()) return '';
      return response.text();
    })
    .toContain('Generated after an earlier daemon turn.');
});

async function createProject(page: Page, name: string) {
  await expect(page.getByTestId('new-project-panel')).toBeVisible();
  await page.getByTestId('new-project-tab-prototype').click();
  await page.getByTestId('new-project-name').fill(name);
  await page.getByTestId('create-project').click();
}

async function expectWorkspaceReady(page: Page) {
  await expect(page).toHaveURL(/\/projects\//);
  await expect(page.getByTestId('chat-composer')).toBeVisible();
  await expect(page.getByTestId('file-workspace')).toBeVisible();
  await expect(page.getByText('Start a conversation')).toBeVisible();
}

async function sendPrompt(page: Page, prompt: string) {
  const input = page.getByTestId('chat-composer-input');
  const sendButton = page.getByTestId('chat-send');
  await input.click();
  await input.fill(prompt);
  await expect(input).toHaveValue(prompt);
  await expect(sendButton).toBeEnabled();
  const chatResponse = page.waitForResponse(
    isCreateRunResponse,
  );
  await sendButton.click();
  const response = await chatResponse;
  expect(response.ok()).toBeTruthy();
}

async function resetDaemonAppConfig(page: Page) {
  const response = await page.request.put('/api/app-config', {
    data: {
      onboardingCompleted: true,
      agentId: 'mock',
      agentModels: {},
      agentCliEnv: {},
      skillId: null,
      designSystemId: null,
    },
  });
  expect(response.ok()).toBeTruthy();
}

function isCreateRunResponse(response: Response): boolean {
  const url = new URL(response.url());
  return url.pathname === '/api/runs' && response.request().method() === 'POST';
}

function currentProject(page: Page): { projectId: string } {
  const current = new URL(page.url());
  const [, projects, projectId] = current.pathname.split('/');
  if (projects !== 'projects' || !projectId) {
    throw new Error(`unexpected project route: ${current.pathname}`);
  }
  return { projectId };
}
