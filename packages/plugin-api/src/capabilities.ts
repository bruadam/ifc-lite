/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CommitCapabilities } from './commits.js';

export interface ProviderCapabilities {
  /** Filename filters the host should use. An empty array lists all resource
   * kinds; generated proposals/exchanges need not have a file extension. */
  readonly sourceNamePatterns?: readonly string[];
  /**
   * `direct-children` — `listContainers` returns only the direct children of
   * `parentId`. The host browses one level at a time. Correct for any API with
   * a real per-folder endpoint, and mandatory for stores large enough that
   * enumerating a whole tree is not viable.
   *
   * `flat-subtree` — `listContainers` returns every descendant of `parentId`
   * in one call, flattened, with `parentId` links intact. For APIs that cannot
   * filter by folder server-side and would otherwise need one full sweep per
   * level. The host nests the result client-side.
   */
  readonly containerListing: 'direct-children' | 'flat-subtree';
  /**
   * Whether `listFiles` on a container also returns files in its descendant
   * containers. Providers that can only sweep a whole file area report `true`;
   * the host then avoids re-querying per folder.
   */
  readonly listFilesIsRecursive: boolean;
  /** Provider implements `listRevisions`. */
  readonly revisionHistory: boolean;
  /**
   * Whether `download` can honour a `revisionId` other than the file's current
   * one. Being able to *list* history does not imply being able to *fetch* it:
   * Microsoft Graph serves historical versions only through a redirect that a
   * browser cannot follow while authenticating, so a browser-only provider can
   * offer full history in the UI and still be unable to retrieve those bytes.
   * Hosts must not offer "load this older revision" when this is false.
   */
  readonly downloadHistoricalRevisions: boolean;
  /** Provider implements `watchRevisions` for change detection. */
  readonly changeDetection: boolean;
  /** Provider implements `searchFiles`; the host shows a search box. */
  readonly search: boolean;
  /**
   * Projects cannot be enumerated — delegated Microsoft Graph, for one, has no
   * "list every site I can see". The host must offer search and/or a
   * paste-a-URL affordance instead of presenting a list as complete.
   */
  readonly projectsAreDiscoverableOnly?: boolean;
  /**
   * Whether the host should eagerly drain every page of a container's file
   * listing up front, rather than loading one page at a time with an
   * explicit "load more" (the same incremental pattern already used for
   * folders — see `containerListing`).
   *
   * Defaults to `false` (off) when omitted, so a provider that does not set
   * this gets ordinary incremental file paging. Set `true` only when the
   * provider's own UI has no per-folder "load more files" concept — Dalux is
   * the reference case: its UI always shows a folder's files as one complete
   * set, with no paginated affordance to partially match, so partial paging
   * in the host would be inventing UX the provider itself doesn't have.
   *
   * A provider with a genuine per-folder file endpoint (the expected case for
   * anything landing after Dalux — Graph-backed stores included) should leave
   * this off: incremental paging avoids blocking a folder's first render on a
   * full drain, and avoids the sweep's bounded-but-real cap on very large
   * folders (`MAX_FILE_SWEEP_ITEMS` / `MAX_FILE_SWEEP_PAGES` in
   * `apps/viewer/src/components/sources/sourceCatalogPaging.ts`).
   */
  readonly eagerFileSweep?: boolean;
  /**
   * Present ONLY on commit-aware providers (contract 2.1.0). Its presence is
   * the feature detection: see `commits.ts`, which owns the flags.
   */
  readonly commits?: CommitCapabilities;
}
