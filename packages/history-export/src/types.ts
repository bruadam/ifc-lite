/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SourceCommit, StoredCommitDiff, CommitPayload, IdentityRecordSet } from '@ifc-lite/plugin-api';
import type { LineageSidecar } from '@ifc-lite/diff';
export interface ElementHistorySummary {
  readonly key: string;
  readonly createdCommitId: string;
  readonly createdAt: string;
  readonly lastChangedCommitId: string;
  readonly lastChangedAt: string;
  readonly lastChangedBy?: string;
  readonly lastChangeKinds: readonly ('data' | 'geometry' | 'container')[];
  readonly changeCount: number;
  readonly previousKeys: readonly string[];
}
export interface HistoryIndex {
  readonly model: { readonly projectId: string; readonly modelId: string; readonly name: string };
  readonly exportedCommit: SourceCommit;
  readonly chain: readonly SourceCommit[];
  readonly elements: ReadonlyMap<string, ElementHistorySummary>;
  readonly partial: boolean;
}
export interface StampOptions { readonly psetName?: string; readonly excludeTypes?: readonly string[]; readonly omitAuthors?: boolean }
export interface ChangeSetOptions { readonly psetName?: string; readonly includeUnchanged?: boolean; readonly excludeTypes?: readonly string[] }
export interface StampReport { readonly stamped: number; readonly skippedExcluded: number; readonly withoutHistory: number }
export interface ChangeSetReport { readonly added: number; readonly modified: number; readonly unchanged: number; readonly deleted: number }
export interface HistoryPackageManifest {
  readonly format: 'ifc-lite/history-package'; readonly version: 1;
  readonly createdAt: string; readonly createdWith: string;
  readonly model: { readonly name: string; readonly sourceProvider?: string; readonly projectId?: string; readonly modelId?: string };
  readonly exportedCommitId: string;
  readonly modelFile: { readonly path: string; readonly digest: string; readonly stamped: boolean };
  readonly commitCount: number;
  readonly artifacts: 'none' | 'exported' | 'all';
  readonly files: readonly { readonly path: string; readonly digest: string; readonly sizeBytes: number }[];
  readonly partial: boolean;
}
export interface HistoryPackageInput {
  readonly model: HistoryPackageManifest['model'];
  readonly chain: readonly SourceCommit[];
  readonly diffs: readonly StoredCommitDiff[];
  readonly modelFile: CommitPayload;
  readonly stamped?: boolean;
  readonly artifacts?: ReadonlyMap<string, CommitPayload>;
  /** Loaded and compressed one at a time, without retaining prior delivery bytes. */
  readonly pastArtifacts?: AsyncIterable<readonly [string, CommitPayload]>;
  readonly identity?: readonly IdentityRecordSet[];
  readonly lineage?: readonly LineageSidecar[];
  readonly partial?: boolean;
  readonly omitAuthors?: boolean;
}
export interface HistoryPackage extends HistoryPackageInput { readonly manifest: HistoryPackageManifest }
