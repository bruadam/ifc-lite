/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { matchModels, DEFAULT_THRESHOLDS, type MatchThresholds } from '@ifc-lite/model-match';
import { historyArgs, historyInput } from './history-input.js';

export async function matchCommand(args: string[]): Promise<void> {
  const parsed = historyArgs(args, ['--exclude-types', '--threshold'], ['--geometry', '--json', '--no-content']);
  if (parsed.files.length < 2) throw new Error('Usage: ifc-lite match <file> <candidate>... [--geometry] [--json]');
  const thresholds: Partial<MatchThresholds> = {};
  for (const threshold of parsed.flags.get('--threshold') ?? []) {
    const [key, raw, extra] = threshold.split('=');
    if (!(key in DEFAULT_THRESHOLDS) || !raw || extra !== undefined || !Number.isFinite(Number(raw))) throw new Error(`Invalid threshold: ${threshold}`);
    thresholds[key as keyof MatchThresholds] = Number(raw);
  }
  const inputs = [];
  for (const file of parsed.files) inputs.push(await historyInput(file, parsed.has('--geometry')));
  const result = await matchModels(inputs[0].subject, inputs.slice(1).map(input => ({ ...input.subject, origin: 'loaded' as const })), { thresholds, contentMatch: !parsed.has('--no-content'), excludeTypes: parsed.value('--exclude-types')?.split(',') });
  process.stdout.write(parsed.has('--json') ? JSON.stringify(result, null, 2) + '\n' : result.results.map(r => `${r.verdict}\t${r.score.toFixed(3)}\t${r.candidateId}\t${r.reasons.join(', ')}`).join('\n') + '\n');
}
