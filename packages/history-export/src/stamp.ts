/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { PropertyValueType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { SourceCommit, StoredCommitDiff } from '@ifc-lite/plugin-api';
import type { ChangeSetOptions, ChangeSetReport, HistoryIndex, StampOptions, StampReport } from './types.js';

function psetName(name: string): string {
  if (!name.trim() || /^(?:pset_|qto_)/i.test(name)) throw new Error('Use a custom property-set name without the reserved Pset_ or Qto_ prefix');
  return name;
}
const DEFAULT_EXCLUDED = ['IFCOPENINGELEMENT', 'IFCVIRTUALELEMENT', 'IFCANNOTATION'];

export function stampHistory(store: IfcDataStore, view: MutablePropertyView, index: HistoryIndex, options: StampOptions = {}): StampReport {
  const pset = psetName(options.psetName ?? 'IfcLite_History');
  const excluded = new Set(options.excludeTypes?.map(t => t.toUpperCase()) ?? DEFAULT_EXCLUDED);
  let stamped = 0, skippedExcluded = 0, withoutHistory = 0;
  for (const id of store.entities.expressId) {
    const key = store.entities.getGlobalId(id);
    if (!key) continue;
    if (excluded.has(store.entities.getTypeName(id).toUpperCase())) { skippedExcluded++; continue; }
    const history = index.elements.get(key);
    if (!history) { withoutHistory++; continue; }
    const set = (name: string, value: string | number, type = PropertyValueType.Label, dataType?: string) => view.setProperty(id, pset, name, value, type, undefined, false, dataType);
    set('ExportedCommit', index.exportedCommit.id, PropertyValueType.Identifier);
    set('SourceModel', index.model.name);
    set('CreatedCommit', history.createdCommitId, PropertyValueType.Identifier);
    const dateType = store.schemaVersion === 'IFC2X3' ? 'IfcLabel' : 'IfcDateTime';
    set('CreatedAt', history.createdAt, PropertyValueType.String, dateType);
    set('LastChangedCommit', history.lastChangedCommitId, PropertyValueType.Identifier);
    set('LastChangedAt', history.lastChangedAt, PropertyValueType.String, dateType);
    if (!options.omitAuthors && history.lastChangedBy) set('LastChangedBy', history.lastChangedBy);
    else view.deleteProperty(id, pset, 'LastChangedBy');
    set('LastChangeKinds', history.lastChangeKinds.join(','));
    set('ChangeCount', history.changeCount, PropertyValueType.Integer);
    if (history.previousKeys.length) set('PreviousGlobalIds', history.previousKeys.join(','), PropertyValueType.Text);
    stamped++;
  }
  return { stamped, skippedExcluded, withoutHistory };
}

export function markChangeSet(store: IfcDataStore, view: MutablePropertyView, diff: StoredCommitDiff, base: SourceCommit, head: SourceCommit, options: ChangeSetOptions = {}): ChangeSetReport {
  if (diff.base.commitId !== base.id || diff.head.commitId !== head.id) throw new Error('Change-set commits do not match the diff');
  const pset = psetName(options.psetName ?? 'IfcLite_Change');
  const entries = new Map(diff.entries.map(e => [e.key, e]));
  const aliases = new Map(diff.appliedIdentity.map(e => [e.here, e.base]));
  const excluded = new Set(options.excludeTypes?.map(t => t.toUpperCase()) ?? DEFAULT_EXCLUDED);
  const counts = { added: 0, modified: 0, unchanged: 0, deleted: diff.entries.filter(e => e.state === 'deleted').length };
  for (const id of store.entities.expressId) {
    const key = store.entities.getGlobalId(id);
    if (!key || excluded.has(store.entities.getTypeName(id).toUpperCase())) continue;
    const entry = entries.get(key);
    if (entry?.state === 'deleted') continue;
    const state = entry?.state ?? 'unchanged';
    if (state === 'unchanged' && options.includeUnchanged === false) continue;
    counts[state]++;
    const set = (name: string, value: string, type = PropertyValueType.Label) => view.setProperty(id, pset, name, value, type);
    set('ChangeState', state[0].toUpperCase() + state.slice(1));
    set('BaseCommit', base.id, PropertyValueType.Identifier);
    set('HeadCommit', head.id, PropertyValueType.Identifier);
    if (entry?.changeKinds.length) set('ChangeKinds', entry.changeKinds.join(','));
    if (entry?.changedComponents?.length) set('ChangedComponents', entry.changedComponents.join(','), PropertyValueType.Text);
    const previous = entry?.baseKey ?? aliases.get(key);
    if (previous && previous !== key) set('PreviousGlobalId', previous, PropertyValueType.Identifier);
  }
  return counts;
}
