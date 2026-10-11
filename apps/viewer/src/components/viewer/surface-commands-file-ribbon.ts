/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** File controls whose actions depend on the mounted ribbon file host. */
import { History, RefreshCcw, Share2 } from 'lucide-react';
import { useViewerStore } from '@/store';
import type { SurfaceCommandContext, SurfaceCommandDefinition, SurfaceCommandState } from './surface-commands';

const ribbonOnly = ['ribbon'] as const;
const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;

export const RIBBON_FILE_SURFACE_COMMANDS = [
  {
    id: 'file:history-package', labelKey: 'history.export.package',
    keywords: 'export model commit revision offline history package zip', category: 'File', icon: History,
    surfaces: ['palette'], enabled: alwaysEnabled,
    run: () => {
      useViewerStore.getState().showWorkspacePanel('history', 'palette');
      window.dispatchEvent(new Event('ifc-export-history-package'));
    },
  },
  {
    id: 'file:refresh', labelKey: 'ribbon.file.refresh',
    keywords: 'reload refresh model from disk', category: 'File', icon: RefreshCcw,
    surfaces: ribbonOnly, enabled: alwaysEnabled,
    run: ({ refreshModels }: SurfaceCommandContext) => {
      if (!refreshModels) throw new Error('Refresh requires the ribbon file host');
      void refreshModels();
    },
  },
  {
    id: 'file:share', labelKey: 'ribbon.file.share', ribbonTooltipKey: 'ribbon.file.shareTooltip',
    keywords: 'share collaboration link room', category: 'File', icon: Share2,
    surfaces: ribbonOnly, enabled: alwaysEnabled,
    run: ({ openShareDialog }: SurfaceCommandContext) => {
      if (!openShareDialog) throw new Error('Share requires the ribbon file host');
      openShareDialog();
    },
  },
] as const satisfies readonly SurfaceCommandDefinition[];
