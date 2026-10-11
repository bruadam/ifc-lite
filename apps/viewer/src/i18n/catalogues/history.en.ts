/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Model version history (commit-history spec 02): the History panel, its
 * timeline rows and compare bar, and the element-history card in the
 * properties panel.
 *
 * Commit MESSAGES, author display names, model names, file names, IFC type
 * names and property-set names are all runtime data from the source or the
 * model and stay out of the catalogue — only the chrome around them is here.
 */
export const historyEn = {
  'history.panel.title': 'Model history',
  'history.panel.close': 'Close history',
  'history.panel.modelLabel': 'Model',
  'history.panel.sourceLabel': 'Source',

  // Empty / unavailable states
  'history.state.noModel': 'Open a model to see its history.',
  'history.state.noSource': 'History is available for models opened from a source.',
  'history.state.noProviderHistory': 'This source does not keep version history for its files.',
  'history.state.empty': 'This model has no commits yet.',
  'history.state.loading': 'Loading history…',
  'history.state.forbidden': "You do not have access to this model's history.",
  'history.state.retry': 'Retry',

  // Timeline
  'history.timeline.label': 'Version history',
  'history.timeline.loadMore': 'Load more',
  'history.timeline.mergeCommit': 'Merge commit',
  'history.badge.head': 'HEAD',
  'history.badge.loaded': 'LOADED',
  'history.badge.pending': 'Pending',
  'history.badge.rejected': 'Rejected',
  'history.badge.historical': 'Past version',
  'history.row.stats': '{added} added, {modified} modified, {deleted} deleted',

  // Row actions
  'history.action.menu': 'Version actions',
  'history.action.open': 'Open (replace)',
  'history.action.openAlongside': 'Open alongside',
  'history.action.setA': 'Set as A',
  'history.action.setB': 'Set as B',
  'history.action.compareWithLoaded': 'Compare with loaded',
  'history.action.copyId': 'Copy commit id',
  'history.action.copied': 'Commit id copied',
  'history.action.backToLatest': 'Back to latest version',
  'history.action.showHistory': 'Show history',
  'history.action.openDisabled': 'This source can list older versions but cannot download them.',

  // Compare
  'history.compare.label': 'Compare',
  'history.compare.slotA': 'A',
  'history.compare.slotB': 'B',
  'history.compare.none': 'none',
  'history.compare.showIn3D': 'Show in 3D',
  'history.compare.calculating': 'Calculating changes…',
  'history.compare.unsupported': 'This source cannot pre-compute changes; open both versions to compare them.',
  'history.compare.counts': '{added} added · {modified} modified · {deleted} deleted',
  'history.compare.more': '…and {count} more',
  'history.compare.groupAdded': 'Added',
  'history.compare.groupModified': 'Modified',
  'history.compare.groupDeleted': 'Deleted',

  // New head
  'history.newHead.available': 'New version available',
  'history.newHead.open': 'Open it',

  // Read-only historical models
  'history.readOnly.tooltip': 'This is a past version and cannot be edited.',

  // Element history card
  'history.element.title': 'History',
  'history.element.unsupported': 'Element history is not available for this source.',
  'history.element.empty': 'No recorded changes for this element.',
  'history.element.showAll': 'Show all',
  'history.element.state.added': 'Added',
  'history.element.state.modified': 'Modified',
  'history.element.state.deleted': 'Deleted',
  'history.element.state.renamed': 'Renamed from {from}',
  'history.element.state.split': 'Split',
  'history.element.state.merged': 'Merged',
  'history.element.state.replaced': 'Replaced',
  'history.element.changeKind.data': 'data',
  'history.element.changeKind.geometry': 'geometry',
  'history.element.changeKind.container': 'container',
  "history.resolver.title": "Is this a new version of an existing model?",
  "history.resolver.description": "Review the evidence and choose how these files relate.",
  "history.resolver.choose": "Choose\u2026",
  "history.resolver.new": "This is a different model",
  "history.resolver.hide": "Hide the previous version",
  "history.resolver.compare": "Show what changed",
  "history.resolver.duplicate": "Two files cannot revise the same model in one batch.",
  "history.resolver.later": "Decide later",
  "history.resolver.confirm": "Confirm",
  "history.resolver.identical": "This file is identical to an existing model.",
  "history.resolver.closeCopy": "Close the new copy",
  "history.resolver.resolve": "Resolve model versions\u2026",
  "history.resolver.ask": "Ask when an opened file may be a new version",
  "history.export.deletedBcf": "Deleted elements as BCF",
  "history.export.deletedCsv": "Deleted elements as CSV",
  "history.evidence.keys": "{percent} GlobalId overlap: {shared} shared elements ({subject} in this file, {candidate} in the candidate)",
  "history.evidence.content": "{percent} of elements match by content",
  "history.export.historyPset": "IfcLite_History",
  "history.export.changePset": "IfcLite_Change",
  "history.source.empty": "No models in this project",
  "history.source.more": "Load more models",
  "history.export.title": "Export history",
  "history.export.stamp": "Add history properties",
  "history.export.package": "Export history package",
  "history.export.changes": "Mark changes since",
  "history.export.privacy": "Includes commit messages and author names from history.",
  "history.export.omit": "Leave out author names",
  "history.export.artifacts": "Include all past deliveries",
  "history.export.run": "Export",
  "history.export.pset": "Property set name",
  "history.upload.title": "Upload to source\u2026",
  "history.upload.project": "Project",
  "history.upload.source": "Source",
  "history.upload.message": "Commit message",
  "history.upload.submit": "Upload",
  "history.upload.new": "Create a new model",
  "history.upload.loading": "Finding revision candidates\u2026",
  "history.upload.conflict": "The source changed. Review the updated evidence before uploading again.",
  "history.reason.digest-equal": "Identical file bytes",
  "history.reason.name-stem-equal": "Same file name after removing delivery suffixes",
  "history.reason.name-similar": "Similar file names",
  "history.reason.iso19650-same-container": "Same ISO 19650 container",
  "history.reason.project-guid-equal": "Same IFC project",
  "history.reason.site-or-building-guid-equal": "Same site or building",
  "history.reason.same-authoring-tool": "Exported from the same application",
  "history.reason.guid-overlap-high": "High element GlobalId overlap",
  "history.reason.guid-overlap-partial": "Some elements share GlobalIds",
  "history.reason.content-match-high": "High element content match",
  "history.reason.content-match-partial": "Some elements match by content",
  "history.reason.reguid-suspected": "The exporting tool may have reassigned GlobalIds",
  "history.reason.schema-changed": "The IFC schema changed",
  "history.reason.same-project-other-model": "Same project, but content looks like another model",
  "history.reason.evidence-partial": "Some evidence is unavailable",
  'modelChanges.undoRefused.historical-version': 'Historical versions are read-only.',
  'history.upload.derived': 'A derived history export cannot become a revision. Use the original delivery.',
  'history.export.cancel': 'Cancel export',
  'history.package.unavailable': 'Artifact not included in this package',
  'history.local.title': 'Local versions',
  'history.local.focus': 'Show this version',
  'history.resolver.pending': 'Resolve version',
  'history.export.size': 'Listed original artifacts: {bytes} bytes (more versions may be available)',
  'history.export.allowPartial': 'Allow incomplete history (affected elements will have no history properties)',
  'history.export.partial': 'Some history is unavailable. Elements without history receive no history properties.',
  'history.local.versionOf': 'New version of {name}',
} as const satisfies Record<string, TranslationValue>;
