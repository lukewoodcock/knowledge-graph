import { expect } from 'vitest';
import type { Response } from 'supertest';
import request from './http';
import { Express } from 'express';

// Under vitest's 5s test timeout, so a stuck run fails with its last status
// instead of a bare "timed out".
const RUN_DEADLINE_MS = 3000;

/** Polls a run's status URL until it finishes, failing after RUN_DEADLINE_MS. */
export async function waitForRun(app: Express, statusUrl: string): Promise<Response> {
  const deadline = Date.now() + RUN_DEADLINE_MS;
  for (;;) {
    const run = await request(app).get(statusUrl);
    if (run.body.status !== 'running') return run;
    if (Date.now() > deadline) {
      throw new Error(`Run still running after ${RUN_DEADLINE_MS}ms: ${JSON.stringify(run.body)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Triggers a run, checks it was accepted, then waits for it to finish. */
export async function triggerAndWait(app: Express, payload: object): Promise<Response> {
  const accepted = await request(app).post('/webhook/knowledge-graph/trigger').send(payload);
  expect(accepted.status).toBe(202);
  return waitForRun(app, accepted.body.status_url);
}
