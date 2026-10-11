/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { useIfcLoader } from '@/hooks/useIfcLoader';
import { useIfcFederation } from '@/hooks/useIfcFederation';
import { useOptionalSourceHost } from '@/services/sources/SourceHostProvider';
import { toast } from '@/components/ui/toast';
import { SourceUploadDialog } from './SourceUploadDialog';

/** Lets the local resolver skip deliveries already being resolved against a source. */
export const sourceUploadLoads = new Set<string>();
interface UploadTarget { modelId: string; providerId: string; projectId: string }
export function SourceDropUpload() {
  const host = useOptionalSourceHost();
  const { loadFile } = useIfcLoader();
  const { addModel } = useIfcFederation(loadFile);
  const [pending, setPending] = useState<UploadTarget[]>([]);
  const queue = useRef(Promise.resolve());
  const mounted = useRef(true);
  const owned = useRef(new Set<string>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const id of owned.current) sourceUploadLoads.delete(id); }; }, []);
  useEffect(() => {
    const drop = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!detail || typeof detail !== 'object' || !('providerId' in detail) || !('projectId' in detail) || !('files' in detail)) return;
      const { providerId, projectId, files } = detail;
      if (typeof providerId !== 'string' || typeof projectId !== 'string' || !Array.isArray(files) || !host?.get(providerId)?.manifest.capabilities.commits?.write) return;
      queue.current = queue.current.then(async () => {
        for (const file of files) {
          if (!mounted.current) return;
          if (!(file instanceof File) || !/\.(ifc|ifczip|ifcx)$/i.test(file.name)) throw new Error('Drop IFC model deliveries on a source project');
          const modelId = crypto.randomUUID(); sourceUploadLoads.add(modelId); owned.current.add(modelId);
          try {
            const loaded = await addModel(file, { modelId });
            if (loaded && mounted.current) setPending(current => [...current, { modelId: loaded, providerId, projectId }]);
            else { sourceUploadLoads.delete(modelId); owned.current.delete(modelId); }
          } catch (error) { sourceUploadLoads.delete(modelId); owned.current.delete(modelId); throw error; }
        }
      }).catch(error => toast.error(error instanceof Error ? error.message : String(error)));
    };
    window.addEventListener('ifc-upload-to-project', drop);
    return () => window.removeEventListener('ifc-upload-to-project', drop);
  }, [host, addModel]);
  const target = pending[0];
  return target ? <SourceUploadDialog key={target.modelId} modelId={target.modelId} initialProviderId={target.providerId} initialProjectId={target.projectId} onClose={() => { sourceUploadLoads.delete(target.modelId); owned.current.delete(target.modelId); setPending(current => current.slice(1)); }} /> : null;
}
