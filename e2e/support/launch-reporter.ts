import type { FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCase, type CasePolicy } from './case-policy';

// Set before workers are created so every project appends to the same owned log.
export function initializeLaunchLog(): void {
  if (process.env.TEST_WORKER_INDEX !== undefined) {
    if (!process.env.LISTENER_E2E_LAUNCH_LOG)
      throw new Error('Worker launch proof log was not inherited.');
    return;
  }
  process.env.LISTENER_E2E_LAUNCH_LOG = join(
    mkdtempSync(join(tmpdir(), 'listener-launch-proof-')),
    'events.jsonl',
  );
  writeFileSync(process.env.LISTENER_E2E_LAUNCH_LOG, '');
}

type CaseRow = CasePolicy & {
  id: string;
  file: string;
  title: string;
  status: string;
  required: boolean;
};
type Event = {
  event: 'launch' | 'reset-checked';
  group: string;
  kind?: 'planned shared' | 'planned fresh';
  pid: number;
  caseId: string;
  omittedReset?: boolean;
};

export default class LaunchReporter implements Reporter {
  private cases = new Map<string, CaseRow>();

  onBegin(_config: unknown, suite: Suite): void {
    for (const test of suite.allTests()) {
      const policy = classifyCase(test.location.file, test.title);
      this.cases.set(test.id, {
        ...policy,
        id: test.id,
        file: test.location.file,
        title: test.title,
        status: 'not-run',
        required: policy.group !== 'settings-shots' || !!process.env.LISTENER_E2E_SHOTS,
      });
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const row = this.cases.get(test.id);
    if (row) row.status = result.status;
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult['status'] }> {
    if (process.argv.includes('--list')) return { status: result.status };
    const errors: string[] = [];
    const rows = [...this.cases.values()];
    let events: Event[] = [];
    try {
      const log = process.env.LISTENER_E2E_LAUNCH_LOG;
      if (!log) throw new Error('Launch proof log was not initialized.');
      events = readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      errors.push(`Cannot read launch proof: ${String(error)}`);
    }
    const planned = new Set(
      rows
        .filter((row) => row.required)
        .map((row) => (row.kind === 'shared' ? `shared:${row.group}` : `fresh:${row.id}`)),
    );
    const counts = new Map<string, number>();
    const resets = new Map<string, number>();
    const launchedPids = new Map<string, number>();
    for (const event of events) {
      const row = this.cases.get(event.caseId);
      if (!row || row.group !== event.group || !Number.isInteger(event.pid) || event.pid <= 0) {
        errors.push(`Unexpected proof event: ${JSON.stringify(event)}`);
        continue;
      }
      if (event.event === 'launch') {
        if (event.kind !== `planned ${row.kind}`)
          errors.push(`Wrong launch classification: ${event.caseId}`);
        const key = row.kind === 'shared' ? `shared:${event.group}` : `fresh:${event.caseId}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        launchedPids.set(key, event.pid);
      } else if (event.event === 'reset-checked' && event.omittedReset === false) {
        const key = row.kind === 'shared' ? `shared:${row.group}` : `fresh:${row.id}`;
        if (launchedPids.get(key) !== event.pid)
          errors.push(`Reset process changed: ${event.caseId}`);
        resets.set(event.caseId, (resets.get(event.caseId) ?? 0) + 1);
      } else {
        errors.push(`Unsupported proof event: ${JSON.stringify(event)}`);
      }
    }
    for (const key of planned) {
      if (counts.get(key) !== 1)
        errors.push(`Expected one owned launch for ${key}; observed ${counts.get(key) ?? 0}.`);
    }
    for (const key of counts.keys()) {
      if (!planned.has(key)) errors.push(`Unplanned launch: ${key}`);
    }
    for (const row of rows) {
      if (row.kind === 'shared' && row.status === 'passed' && resets.get(row.id) !== 1)
        errors.push(`Missing or repeated verified reset for passed case: ${row.title}`);
    }
    const output = join(process.cwd(), 'test-results');
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(output, 'coverage.json'),
      JSON.stringify(
        rows.map((row) => ({
          ...row,
          resetChecked: resets.get(row.id) === 1,
        })),
        null,
        2,
      ),
    );
    writeFileSync(
      join(output, 'launch-summary.json'),
      JSON.stringify(
        {
          selectedCases: rows.length,
          plannedLaunches: planned.size,
          actualLaunches: [...counts.values()].reduce((sum, count) => sum + count, 0),
          launches: Object.fromEntries(counts),
          events,
          errors,
        },
        null,
        2,
      ),
    );
    if (errors.length) {
      console.error(`Electron launch proof failed:\n${errors.join('\n')}`);
      return { status: 'failed' };
    }
    return { status: result.status };
  }
}
