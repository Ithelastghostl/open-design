import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  buildOrbitPrompt,
  OrbitService,
  renderOrbitTemplateSystemPrompt,
  type OrbitTemplateSelection,
} from '../src/orbit.js';

describe('buildOrbitPrompt', () => {
  it('embeds selected Orbit template instructions and staged side-file guidance', () => {
    const template: OrbitTemplateSelection = {
      id: 'orbit-general',
      name: 'orbit-general',
      examplePrompt: 'Render the editorial bento dashboard.',
      dir: path.join('/repo', 'skills', 'orbit-general'),
      body: 'Open and mirror the shipped `example.html` before writing output. Use exclusively the canvas tokens.',
      designSystemRequired: false,
    };

    const prompt = buildOrbitPrompt(new Date('2026-05-06T15:32:52.361Z'), template);

    expect(prompt).toContain('Skill id: orbit-general');
    expect(prompt).toContain('Staged root: .od-skills/orbit-general/');
    expect(prompt).toContain('read ".od-skills/orbit-general/SKILL.md"');
    expect(prompt).toContain('".od-skills/orbit-general/example.html"');
    expect(prompt).toContain('visual/domain guidance');
    expect(prompt).not.toContain('Selected template skill instructions:');
    expect(prompt).toContain('Selected template example prompt:');
    expect(prompt).toContain('Render the editorial bento dashboard.');
  });

  it('prioritizes curated daily digest connector discovery before fallback listing', () => {
    const prompt = buildOrbitPrompt(new Date('2026-05-06T15:32:52.361Z'));

    expect(prompt).toContain('DAILY DIGEST CONNECTOR CURATION IS REQUIRED WHEN SUPPORTED');
    expect(prompt).toContain('tools connectors list --use-case personal_daily_digest --format compact');
    expect(prompt).toContain('do not stop just because `--use-case` is unsupported');
  });

  it('renders the selected template skill body as authoritative run instructions', () => {
    const template: OrbitTemplateSelection = {
      id: 'orbit-general',
      name: 'orbit-general',
      examplePrompt: 'Render the editorial bento dashboard.',
      dir: path.join('/repo', 'skills', 'orbit-general'),
      body: 'Open and mirror the shipped `example.html` before writing output. Use exclusively the canvas tokens.',
      designSystemRequired: false,
    };

    const prompt = renderOrbitTemplateSystemPrompt(template);

    expect(prompt).toContain('Selected Orbit template skill — orbit-general');
    expect(prompt).toContain('Treat it as authoritative');
    expect(prompt).toContain('must not override the selected template');
    expect(prompt).toContain('opts out of external design-system injection');
    expect(prompt).toContain('Do not apply the workspace design system');
    expect(prompt).toContain('Open and mirror the shipped `example.html`');
    expect(prompt).toContain('Use exclusively the canvas tokens.');
  });
});

describe('OrbitService', () => {
  it('sets connectorsChecked to the summed connector outcomes', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'orbit-test-'));
    try {
      const service = new OrbitService(dataDir);
      service.setRunHandler(async () => ({
        projectId: 'project-1',
        agentRunId: 'agent-1',
        completion: Promise.resolve({
          agentRunId: 'agent-1',
          status: 'succeeded',
        }),
      }));

      await service.start('manual');
      let status = await service.status();
      for (let attempt = 0; attempt < 10 && !status.lastRun; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        status = await service.status();
      }

      expect(status.lastRun).not.toBeNull();
      expect(status.lastRun?.connectorsSucceeded).toBe(1);
      expect(status.lastRun?.connectorsFailed).toBe(0);
      expect(status.lastRun?.connectorsSkipped).toBe(0);
      expect(status.lastRun?.connectorsChecked).toBe(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
