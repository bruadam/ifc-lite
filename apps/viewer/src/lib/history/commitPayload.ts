/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CommitPayload, SourceCommit } from '@ifc-lite/plugin-api';
import { artifactDigest } from '@ifc-lite/history-export';

export async function verifyCommitPayload(payload: CommitPayload, commit: SourceCommit): Promise<void> {
  if (payload.artifactDigest !== commit.artifact.digest ||
      (commit.artifact.digest.startsWith('sha256:') && await artifactDigest(payload.bytes) !== commit.artifact.digest)) {
    throw new Error('The commit service returned bytes that do not match this version.');
  }
}
