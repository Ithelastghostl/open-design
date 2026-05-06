import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

import type { OrbitConfigPrefs } from './app-config.js';

export interface OrbitConnectorRunResult {
  connectorId: string;
  connectorName: string;
  accountLabel?: string;
  toolName?: string;
  toolTitle?: string;
  status: 'succeeded' | 'skipped' | 'failed';
  summary: string;
  error?: string;
}

export interface OrbitActivitySummary {
  id: string;
  startedAt: string;
  completedAt: string;
  trigger: 'manual' | 'scheduled';
  connectorsChecked: number;
  connectorsSucceeded: number;
  connectorsFailed: number;
  connectorsSkipped: number;
  artifactId?: string;
  artifactProjectId?: string;
  agentRunId?: string;
  markdown: string;
  results: OrbitConnectorRunResult[];
}

export interface OrbitAgentRunResult {
  agentRunId: string;
  status: 'succeeded' | 'failed' | 'canceled';
  artifactId?: string;
  artifactProjectId?: string;
  summary?: string;
}

export type OrbitRunHandler = (request: {
  runId: string;
  trigger: 'manual' | 'scheduled';
  startedAt: string;
  prompt: string;
}) => Promise<OrbitAgentRunResult>;

export interface OrbitStatus {
  config: OrbitConfigPrefs;
  running: boolean;
  nextRunAt: string | null;
  lastRun: OrbitActivitySummary | null;
}

export const DEFAULT_ORBIT_CONFIG: OrbitConfigPrefs = {
  enabled: false,
  time: '08:00',
};

const SUMMARY_FILE = 'activity-summary.json';
export const ORBIT_PROJECT_ID = 'orbit';

function normalizeOrbitConfig(config: Partial<OrbitConfigPrefs> | undefined): OrbitConfigPrefs {
  const time = typeof config?.time === 'string' && /^\d{2}:\d{2}$/.test(config.time)
    ? config.time
    : DEFAULT_ORBIT_CONFIG.time;
  return {
    enabled: Boolean(config?.enabled),
    time,
  };
}

function orbitDir(dataDir: string): string {
  return path.join(dataDir, 'orbit');
}

function summaryFile(dataDir: string): string {
  return path.join(orbitDir(dataDir), SUMMARY_FILE);
}

async function readLastSummary(dataDir: string): Promise<OrbitActivitySummary | null> {
  try {
    const raw = await readFile(summaryFile(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as OrbitActivitySummary;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeLastSummary(dataDir: string, summary: OrbitActivitySummary): Promise<void> {
  const dir = orbitDir(dataDir);
  await mkdir(dir, { recursive: true });
  const target = summaryFile(dataDir);
  const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
}

function nextDailyRunAt(time: string, now = new Date()): Date {
  const [hoursRaw, minutesRaw] = time.split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  const next = new Date(now);
  next.setHours(Number.isFinite(hours) ? hours : 8, Number.isFinite(minutes) ? minutes : 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function renderMarkdown(summary: Omit<OrbitActivitySummary, 'markdown'>): string {
  const lines = [
    `# Daily Orbit Activity Summary`,
    '',
    `Generated: ${summary.completedAt}`,
    `Trigger: ${summary.trigger}`,
    '',
    `Checked ${summary.connectorsChecked} connector(s): ${summary.connectorsSucceeded} succeeded, ${summary.connectorsSkipped} skipped, ${summary.connectorsFailed} failed.`,
    '',
  ];
  for (const result of summary.results) {
    const title = result.accountLabel ? `${result.connectorName} (${result.accountLabel})` : result.connectorName;
    lines.push(`## ${title}`);
    lines.push(`- Status: ${result.status}`);
    if (result.toolTitle || result.toolName) lines.push(`- Tool: ${result.toolTitle ?? result.toolName}`);
    lines.push(`- Summary: ${result.summary}`);
    if (result.error) lines.push(`- Error: ${result.error}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function buildOrbitPrompt(now = new Date()): string {
  const end = now.toISOString();
  const start = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  return [
    'Create a Live Artifact for Orbit: a concise, useful activity digest for the past 24 hours.',
    '',
    `Time window: ${start} through ${end}.`,
    '',
    'This is an autonomous scheduled/manual Orbit job. Do not ask follow-up questions, do not emit a question form, and do not wait for user input. Use sensible defaults and proceed.',
    '',
    'Use the live-artifact skill to author and register the artifact. Use the Open Design CLI wrappers to discover and call connectors:',
    '- List available connected connector tools with `"$OD_NODE_BIN" "$OD_BIN" tools connectors list`.',
    '- Decide which read-only connector tools are appropriate for the 24h activity window; do not rely on daemon-provided tool choices.',
    '- Execute only the connector tools needed for a useful digest with `"$OD_NODE_BIN" "$OD_BIN" tools connectors execute --connector <id> --tool <name> --input input.json` after writing a small JSON input file.',
    '- Prefer search/list/activity-style tools. Avoid provider metadata, api_root, schema, health, status, broad fetch_all, or block-content dump tools unless they are truly necessary.',
    '',
    'The artifact should include:',
    '- Executive summary: 3-5 bullets of the most important changes/activity.',
    '- GitHub section when available: recently pushed repositories, meaningful issues/PRs, or other notable activity. Example inputs to consider: repository search with pushed/updated filters, issue/PR tools if available and relevant.',
    '- Notion section when available: recently relevant pages/databases/tasks. Example inputs to consider: Notion search with date/time keywords or edited/updated page/database tools if available.',
    '- Connector coverage: which connectors/tools were used, skipped, or unavailable, with short reasons.',
    '- Links or identifiers when connector output provides them.',
    '',
    'Few-shot examples of good synthesis:',
    '- GitHub: “open-design had 4 repositories updated in the window; the most notable activity was a push to apps/daemon touching connector execution and a PR discussing Orbit automation.”',
    '- Notion: “Product Notes and Launch Checklist were the only matching pages; Launch Checklist changed around connector onboarding and should be reviewed before release.”',
    '',
    'If connector data is sparse, still create the Live Artifact and clearly say what was checked and what was missing. Do not invent activity. Keep the visual design polished but lightweight.',
  ].join('\n');
}

export class OrbitService {
  private config: OrbitConfigPrefs = DEFAULT_ORBIT_CONFIG;
  private timer: NodeJS.Timeout | null = null;
  private nextRunAtValue: Date | null = null;
  private runningPromise: Promise<OrbitActivitySummary> | null = null;
  private runHandler: OrbitRunHandler | null = null;

  constructor(private readonly dataDir: string) {}

  setRunHandler(handler: OrbitRunHandler): void {
    this.runHandler = handler;
  }

  configure(config: Partial<OrbitConfigPrefs> | undefined): void {
    this.config = normalizeOrbitConfig(config);
    this.reschedule();
  }

  async status(): Promise<OrbitStatus> {
    return {
      config: this.config,
      running: this.runningPromise !== null,
      nextRunAt: this.nextRunAtValue?.toISOString() ?? null,
      lastRun: await readLastSummary(this.dataDir),
    };
  }

  async run(trigger: 'manual' | 'scheduled'): Promise<OrbitActivitySummary> {
    if (this.runningPromise) return this.runningPromise;
    this.runningPromise = this.runOnce(trigger).finally(() => {
      this.runningPromise = null;
      this.reschedule();
    });
    return this.runningPromise;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAtValue = null;
  }

  private reschedule(): void {
    this.stop();
    if (!this.config.enabled) return;
    const next = nextDailyRunAt(this.config.time);
    this.nextRunAtValue = next;
    this.timer = setTimeout(() => {
      void this.run('scheduled').catch((error) => {
        console.warn('[orbit] Scheduled run failed:', error);
      });
    }, Math.max(0, next.getTime() - Date.now()));
  }

  private async runOnce(trigger: 'manual' | 'scheduled'): Promise<OrbitActivitySummary> {
    const startedAt = new Date().toISOString();
    const runId = `orbit-${randomUUID()}`;
    const prompt = buildOrbitPrompt(new Date(startedAt));
    if (!this.runHandler) throw new Error('Orbit agent runner is not configured');
    const agentResult = await this.runHandler({ runId, trigger, startedAt, prompt });

    const completedAt = new Date().toISOString();
    const base = {
      id: runId,
      startedAt,
      completedAt,
      trigger,
      connectorsChecked: 0,
      connectorsSucceeded: agentResult.status === 'succeeded' ? 1 : 0,
      connectorsFailed: agentResult.status === 'failed' ? 1 : 0,
      connectorsSkipped: agentResult.status === 'canceled' ? 1 : 0,
      agentRunId: agentResult.agentRunId,
      ...(agentResult.artifactId === undefined ? {} : { artifactId: agentResult.artifactId }),
      ...(agentResult.artifactProjectId === undefined ? {} : { artifactProjectId: agentResult.artifactProjectId }),
      results: [{
        connectorId: 'agent-runtime',
        connectorName: 'Orbit Agent',
        status: agentResult.status === 'succeeded' ? 'succeeded' : agentResult.status === 'failed' ? 'failed' : 'skipped',
        summary: agentResult.summary ?? `Agent run ${agentResult.status}.`,
      } satisfies OrbitConnectorRunResult],
    };
    const summary: OrbitActivitySummary = {
      ...base,
      markdown: renderMarkdown(base),
    };
    await writeLastSummary(this.dataDir, summary);
    return summary;
  }
}
