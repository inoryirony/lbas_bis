import { execFile } from 'node:child_process';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const cliPath = path.join(root, 'bin', 'lbas-bis.js');
const scenarioPath = path.join(root, 'examples', 'cli-static.json');
const customScenarioPath = path.join(root, 'examples', 'cli-custom-enemy.json');

describe('headless LBAS CLI', () => {
  test('validates a scenario and streams optimize events as JSON Lines', async () => {
    const validation = await runCli(['validate', '--scenario', scenarioPath]);
    const optimization = await runCli(['optimize', '--scenario', scenarioPath, '--jsonl']);
    const events = optimization.stdout.trim().split(/\r?\n/).map(JSON.parse);

    expect(validation.code).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true });
    expect(optimization.code).toBe(0);
    expect(events[0]).toMatchObject({ type: 'started' });
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      result: { search: { status: 'optimal', provenOptimal: true } },
    });
  });

  test('accepts a completely custom enemy ship and aircraft slot scenario', async () => {
    const validation = await runCli(['validate', '--scenario', customScenarioPath]);
    const optimization = await runCli(['optimize', '--scenario', customScenarioPath, '--jsonl']);
    const events = optimization.stdout.trim().split(/\r?\n/).map(JSON.parse);

    expect(validation.code).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true });
    expect(optimization.code).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      result: {
        results: [expect.objectContaining({ calculationMode: 'detailed' })],
        search: { provenOptimal: true },
      },
    });
  });
});

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { cwd: root }, (error, stdout, stderr) => {
      resolve({ code: error?.code || 0, stdout, stderr });
    });
  });
}
