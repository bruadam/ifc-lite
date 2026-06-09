/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite clash <file.ifc> [<file2.ifc> ...] [options]
 *
 * Detect geometric clashes between elements in one or more IFC models. When
 * multiple files are given every model's elements are pooled into a single
 * federated set so intra-model and cross-model clashes are found together.
 *
 * Use --file-a / --file-b to restrict results to clashes between two specific
 * models (cross-file coordination check).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadIfcFile } from '../loader.js';
import { getAllFlags, getFlag, hasFlag, fatal, printJson } from '../output.js';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  createClashEngine,
  disciplineMatrixRules,
  groupClashes,
  makeExclusionSet,
  type Clash,
  type ClashMode,
  type ClashResult,
  type ClashRule,
  type ClashSeverity,
  type ClashSummary,
  type ExclusionSet,
} from '@ifc-lite/clash';
import { elementsFromStep } from '@ifc-lite/clash/step';
import { createBCFFromClashResult } from '@ifc-lite/clash/bcf';
import { writeBCF } from '@ifc-lite/bcf';

/** Maximum number of clashes embedded in --json output before truncation. */
const JSON_CLASH_CAP = 1000;
/** Maximum number of clash rows shown in the human summary. */
const HUMAN_CLASH_CAP = 20;

/**
 * Mesh a model once and cache the meshes by model id so repeated clash runs
 * within a single process never re-mesh the same file.
 */
const meshCache = new Map<string, MeshData[]>();

let sharedProcessor: GeometryProcessor | undefined;

async function getProcessor(): Promise<GeometryProcessor> {
  if (!sharedProcessor) {
    const processor = new GeometryProcessor();
    await processor.init();
    sharedProcessor = processor;
  }
  return sharedProcessor;
}

/**
 * Mesh the whole model. Prefers the parsed `store.source` bytes; falls back to
 * reading the file path from disk when the store did not retain its source.
 */
async function meshModel(store: IfcDataStore, modelId: string, filePath: string): Promise<MeshData[]> {
  const cached = meshCache.get(modelId);
  if (cached) return cached;

  let bytes: Uint8Array | undefined = store.source;
  if (!bytes || bytes.byteLength === 0) {
    const buffer = await readFile(filePath);
    bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  const processor = await getProcessor();
  const result = await processor.process(bytes);
  meshCache.set(modelId, result.meshes);
  return result.meshes;
}

function parseMode(raw: string | undefined): ClashMode {
  const mode = raw ?? 'hard';
  if (mode !== 'hard' && mode !== 'clearance') {
    fatal(`Invalid --mode "${mode}". Supported modes: hard, clearance`);
  }
  return mode;
}

function parseNumberFlag(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    fatal(`Invalid ${flag} value "${raw}" (must be a number)`);
  }
  return value;
}

type ClashGroupByCli = 'cluster' | 'rule' | 'typePair' | 'element';

function parseGroupBy(raw: string | undefined): ClashGroupByCli {
  const g = raw ?? 'cluster';
  if (g !== 'cluster' && g !== 'rule' && g !== 'typePair' && g !== 'element') {
    fatal(`Invalid --group "${g}". Supported: cluster, rule, typePair, element`);
  }
  return g as ClashGroupByCli;
}

function buildRules(args: string[], mode: ClashMode, tolerance: number | undefined, clearance: number | undefined): ClashRule[] {
  if (hasFlag(args, '--matrix')) {
    return disciplineMatrixRules(mode, clearance);
  }

  const a = getFlag(args, '--a') ?? '*';
  const b = getFlag(args, '--b');
  const rule: ClashRule = {
    id: 'cli-rule',
    name: b ? `${a} vs ${b}` : `${a} self-clash`,
    a,
    mode,
  };
  if (b !== undefined) rule.b = b;
  if (tolerance !== undefined) rule.tolerance = tolerance;
  if (clearance !== undefined) rule.clearance = clearance;
  return [rule];
}

/** Merge multiple ExclusionSets into one. */
function mergeExclusionSets(sets: ExclusionSet[]): ExclusionSet {
  if (sets.length === 1) return sets[0];
  const merged = makeExclusionSet();
  for (const s of sets) {
    for (const v of s) merged.add(v);
  }
  return merged;
}

/**
 * Collect file paths from positional CLI arguments, skipping known flags and
 * their values.
 */
function parseFilePaths(args: string[]): string[] {
  const VALUE_FLAGS = new Set([
    '--mode', '--tolerance', '--clearance', '--bcf', '--group',
    '--bcf-status', '--max-topics', '--a', '--b', '--file-a', '--file-b',
  ]);
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (VALUE_FLAGS.has(args[i])) i++;
      continue;
    }
    files.push(args[i]);
  }
  return files;
}

function rebuildSummary(clashes: Clash[]): ClashSummary {
  const byRule: Record<string, number> = {};
  const byTypePair: Record<string, number> = {};
  const bySeverity: Record<ClashSeverity, number> = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const c of clashes) {
    byRule[c.rule] = (byRule[c.rule] ?? 0) + 1;
    const pair = [c.a.tag, c.b.tag].sort().join(' vs ');
    byTypePair[pair] = (byTypePair[pair] ?? 0) + 1;
    bySeverity[c.severity] += 1;
  }
  return { total: clashes.length, byRule, byTypePair, bySeverity };
}

function formatClashRow(clash: Clash, multiFile: boolean): string {
  const aName = clash.a.name ? `${clash.a.tag} "${clash.a.name}"` : clash.a.tag;
  const bName = clash.b.name ? `${clash.b.tag} "${clash.b.name}"` : clash.b.tag;
  const distance = clash.distance < 0
    ? `penetration ${Math.abs(clash.distance).toFixed(3)}m`
    : `gap ${clash.distance.toFixed(3)}m`;
  const modelInfo = multiFile && clash.a.model !== clash.b.model
    ? ` [${clash.a.model} ↔ ${clash.b.model}]`
    : '';
  return `  [${clash.severity}] ${aName} x ${bName} (${clash.status}, ${distance})${modelInfo}`;
}

function printHumanSummary(result: ClashResult, modelIds: string[]): void {
  const { summary } = result;
  const multiFile = modelIds.length > 1;
  process.stdout.write(`\n  Clash Detection Results\n`);
  process.stdout.write(`  -----------------------\n`);
  if (multiFile) {
    process.stdout.write(`  Models:        ${modelIds.join(', ')}\n`);
  }
  process.stdout.write(`  Total clashes: ${summary.total}\n`);
  process.stdout.write(`  By severity:   critical ${summary.bySeverity.critical}, major ${summary.bySeverity.major}, minor ${summary.bySeverity.minor}, info ${summary.bySeverity.info}\n`);

  if (result.truncated) {
    process.stdout.write(`  Truncated:     ${result.truncated.reason} (${result.truncated.droppedPairs} pairs dropped)\n`);
  }

  if (multiFile && summary.total > 0) {
    const byModel: Record<string, number> = {};
    for (const c of result.clashes) {
      const key = c.a.model === c.b.model
        ? `${c.a.model} (intra-model)`
        : `${c.a.model} ↔ ${c.b.model}`;
      byModel[key] = (byModel[key] ?? 0) + 1;
    }
    process.stdout.write(`  By model pair:\n`);
    for (const [k, n] of Object.entries(byModel)) {
      process.stdout.write(`    ${k}: ${n}\n`);
    }
  }

  if (summary.total > 0) {
    const shown = result.clashes.slice(0, HUMAN_CLASH_CAP);
    process.stdout.write(`\n  Top ${shown.length} of ${summary.total} clashes:\n`);
    for (const clash of shown) {
      process.stdout.write(`${formatClashRow(clash, multiFile)}\n`);
    }
    const dropped = summary.total - shown.length;
    if (dropped > 0) {
      process.stdout.write(`\n  ... ${dropped} more clash(es) not shown (use --json for the full list).\n`);
    }
  }
  process.stdout.write('\n');
}

export async function clashCommand(args: string[]): Promise<void> {
  // Support both positional file list and --file <path> repeated flag.
  const positionalFiles = parseFilePaths(args);
  const repeatedFiles = getAllFlags(args, '--file');
  const filePaths = repeatedFiles.length > 0 ? repeatedFiles : positionalFiles;

  if (filePaths.length === 0) {
    fatal(
      'Usage: ifc-lite clash <file.ifc> [<file2.ifc> ...] ' +
      '[--a <selector>] [--b <selector>] ' +
      '[--mode hard|clearance] [--tolerance N] [--clearance N] ' +
      '[--matrix] ' +
      '[--file-a <filename>] [--file-b <filename>] ' +
      '[--bcf <out.bcfzip>] [--group cluster|rule|typePair|element] ' +
      '[--bcf-status <status>] [--max-topics N] [--json]',
    );
  }

  const jsonOutput = hasFlag(args, '--json');
  const mode = parseMode(getFlag(args, '--mode'));
  const tolerance = parseNumberFlag(getFlag(args, '--tolerance'), '--tolerance');
  const clearance = parseNumberFlag(getFlag(args, '--clearance'), '--clearance');
  const bcfPath = getFlag(args, '--bcf');
  const bcfGroupBy = parseGroupBy(getFlag(args, '--group'));
  const bcfStatus = getFlag(args, '--bcf-status');
  const maxTopics = parseNumberFlag(getFlag(args, '--max-topics'), '--max-topics');

  // --file-a / --file-b restrict results to clashes between two specific models.
  const fileAArg = getFlag(args, '--file-a');
  const fileBArg = getFlag(args, '--file-b');
  const fileAId = fileAArg ? basename(fileAArg) : undefined;
  const fileBId = fileBArg ? basename(fileBArg) : undefined;

  if ((fileAId && !fileBId) || (!fileAId && fileBId)) {
    fatal('--file-a and --file-b must be used together');
  }

  // Load every model, mesh it, convert to ClashElements.
  const allElements: ReturnType<typeof elementsFromStep>['elements'] = [];
  const allExclusionSets: ExclusionSet[] = [];
  const modelIds: string[] = [];

  for (const filePath of filePaths) {
    const modelId = basename(filePath);
    if (!jsonOutput) process.stderr.write(`  Loading ${modelId}...\n`);

    const store = await loadIfcFile(filePath);
    const meshes = await meshModel(store, modelId, filePath);
    const { elements, exclusions } = elementsFromStep({ store, meshes, modelId });

    allElements.push(...elements);
    allExclusionSets.push(exclusions);
    modelIds.push(modelId);

    if (!jsonOutput) process.stderr.write(`  ${modelId}: ${elements.length} elements\n`);
  }

  if (fileAId && !modelIds.includes(fileAId)) {
    fatal(`--file-a "${fileAId}" is not one of the loaded models (loaded: ${modelIds.join(', ')})`);
  }
  if (fileBId && !modelIds.includes(fileBId)) {
    fatal(`--file-b "${fileBId}" is not one of the loaded models (loaded: ${modelIds.join(', ')})`);
  }

  const mergedExclusions = mergeExclusionSets(allExclusionSets);
  const rules = buildRules(args, mode, tolerance, clearance);

  if (!jsonOutput) {
    process.stderr.write(`  Running clash engine on ${allElements.length} elements across ${modelIds.length} model(s)...\n`);
  }

  const engine = createClashEngine({ backend: 'ts' });
  const result = await engine.run(allElements, rules, {
    exclusions: mergedExclusions,
    tolerance,
    onProgress: (p) => {
      if (!jsonOutput) {
        process.stderr.write(`\r  Clashing: ${p.phase} ${p.rule} (${p.done}/${p.total})`);
      }
    },
  });
  if (!jsonOutput) process.stderr.write('\n');

  // Apply model-pair filter when --file-a / --file-b are given.
  if (fileAId && fileBId) {
    result.clashes = result.clashes.filter(
      (c) =>
        (c.a.model === fileAId && c.b.model === fileBId) ||
        (c.a.model === fileBId && c.b.model === fileAId),
    );
    result.summary = rebuildSummary(result.clashes);
    if (!jsonOutput) {
      process.stderr.write(`  Filtered to ${fileAId} ↔ ${fileBId}: ${result.clashes.length} cross-model clash(es)\n`);
    }
  }

  if (bcfPath) {
    const groups = groupClashes(result, { by: bcfGroupBy });
    const project = await createBCFFromClashResult(result, groups, {
      author: 'ifc-lite clash',
      projectName: 'Clash report',
      ...(bcfStatus ? { status: bcfStatus } : {}),
      ...(maxTopics != null ? { maxTopics } : {}),
    });
    const blob = await writeBCF(project);
    const buffer = Buffer.from(await blob.arrayBuffer());
    await writeFile(bcfPath, buffer);
    process.stderr.write(`  BCF report written to ${bcfPath} (${groups.length} topic group(s), grouped by ${bcfGroupBy})\n`);
  }

  if (jsonOutput) {
    const total = result.clashes.length;
    const clashes = result.clashes.slice(0, JSON_CLASH_CAP);
    const truncated = total > clashes.length
      ? { reason: `capped at ${JSON_CLASH_CAP} clashes for display`, dropped: total - clashes.length }
      : null;
    printJson({
      models: modelIds,
      summary: result.summary,
      truncated,
      clashes,
    });
    return;
  }

  printHumanSummary(result, modelIds);
}
