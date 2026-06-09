/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash settings dialog — opened from the gear in the clash panel header.
 *
 * Two tabs:
 *  - Detection: the global knobs (mode, tolerance, clearance, cluster radius,
 *    report-touch, default grouping), each persisted on change.
 *  - Rules: the discipline-matrix preset set. Toggle / edit / reset the built-ins
 *    and add your own custom rules (type-selector A × B + severity + optional
 *    property conditions), with a live "matches N classes" preview against the
 *    loaded model. Persisted to localStorage; shareable via export / import.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Settings2, Plus, Pencil, Trash2, RotateCcw, Upload, Download, Check, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { type ClashSeverity, type PropertyCondition } from '@ifc-lite/clash';
import { discoverDataSources } from '@ifc-lite/lens';
import { exportPresets, importPresets, type ClashPreset } from '@/lib/clash/persistence';
import { createLensDataProvider } from '@/lib/lens';
import { SelectorBuilder } from './SelectorBuilder';

const SEVERITY: Record<ClashSeverity, { label: string; color: string }> = {
  critical: { label: 'Critical', color: '#f7768e' },
  major: { label: 'Major', color: '#ff9e64' },
  minor: { label: 'Minor', color: '#e0af68' },
  info: { label: 'Info', color: '#7aa2f7' },
};
const SEVERITIES: ClashSeverity[] = ['critical', 'major', 'minor', 'info'];

interface Draft {
  id: string | null; // null = new custom rule
  name: string;
  selectorA: string;
  selectorB: string;
  whereA: PropertyCondition[];
  whereB: PropertyCondition[];
  severity: ClashSeverity;
}

interface ClashSettingsDialogProps {
  trigger?: React.ReactNode;
}

export function ClashSettingsDialog({ trigger }: ClashSettingsDialogProps) {
  const mode = useViewerStore((s) => s.clashMode);
  const tolerance = useViewerStore((s) => s.clashTolerance);
  const clearance = useViewerStore((s) => s.clashClearance);
  const clusterEpsilon = useViewerStore((s) => s.clashClusterEpsilon);
  const reportTouch = useViewerStore((s) => s.clashReportTouch);
  const groupBy = useViewerStore((s) => s.clashGroupBy);
  const presets = useViewerStore((s) => s.clashPresets);
  const classes = useViewerStore((s) => s.discoveredLensData?.classes ?? null);
  const propertySets = useViewerStore((s) => s.discoveredLensData?.propertySets ?? null);
  const mergeDiscoveredData = useViewerStore((s) => s.mergeDiscoveredData);

  const setMode = useViewerStore((s) => s.setClashMode);
  const setTolerance = useViewerStore((s) => s.setClashTolerance);
  const setClearance = useViewerStore((s) => s.setClashClearance);
  const setClusterEpsilon = useViewerStore((s) => s.setClashClusterEpsilon);
  const setReportTouch = useViewerStore((s) => s.setClashReportTouch);
  const setGroupBy = useViewerStore((s) => s.setClashGroupBy);
  const resetSettings = useViewerStore((s) => s.resetClashSettings);
  const createPreset = useViewerStore((s) => s.createClashPreset);
  const updatePreset = useViewerStore((s) => s.updateClashPreset);
  const deletePreset = useViewerStore((s) => s.deleteClashPreset);
  const setPresetEnabled = useViewerStore((s) => s.setClashPresetEnabled);
  const resetPresets = useViewerStore((s) => s.resetClashPresets);
  const importClashPresets = useViewerStore((s) => s.importClashPresets);

  const [draft, setDraft] = useState<Draft | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const discoveringRef = useRef(new Set<string>());

  const handleRequestPropertyDiscovery = useCallback(() => {
    const current = useViewerStore.getState().discoveredLensData;
    if (!current || current.propertySets || discoveringRef.current.has('properties')) return;
    discoveringRef.current.add('properties');
    setTimeout(() => {
      const { models, ifcDataStore } = useViewerStore.getState();
      if (models.size === 0 && !ifcDataStore) return;
      const provider = createLensDataProvider(models, ifcDataStore);
      const result = discoverDataSources(provider, { properties: true });
      mergeDiscoveredData(result);
    }, 0);
  }, [mergeDiscoveredData]);

  const startAdd = () =>
    setDraft({ id: null, name: '', selectorA: '', selectorB: '', whereA: [], whereB: [], severity: 'major' });
  const startEdit = (p: ClashPreset) =>
    setDraft({
      id: p.id,
      name: p.name,
      selectorA: p.selectorA,
      selectorB: p.selectorB,
      whereA: p.whereA ?? [],
      whereB: p.whereB ?? [],
      severity: p.severity,
    });

  const saveDraft = useCallback(() => {
    if (!draft) return;
    const result = draft.id
      ? updatePreset(draft.id, {
          name: draft.name,
          selectorA: draft.selectorA,
          selectorB: draft.selectorB,
          severity: draft.severity,
          ...(draft.whereA.length ? { whereA: draft.whereA } : { whereA: undefined }),
          ...(draft.whereB.length ? { whereB: draft.whereB } : { whereB: undefined }),
        })
      : createPreset({
          name: draft.name,
          severity: draft.severity,
          selectorA: draft.selectorA,
          selectorB: draft.selectorB,
          whereA: draft.whereA,
          whereB: draft.whereB,
        });
    if (result.ok) {
      setDraft(null);
    } else {
      toast.error(result.message);
    }
  }, [draft, createPreset, updatePreset]);

  const conditionsValid = useCallback((conds: PropertyCondition[]) =>
    conds.every((c) => c.pset.trim().length > 0 && c.property.trim().length > 0),
  []);

  const draftValid =
    !!draft &&
    draft.name.trim().length > 0 &&
    draft.selectorA.trim().length > 0 &&
    draft.selectorB.trim().length > 0 &&
    conditionsValid(draft.whereA) &&
    conditionsValid(draft.whereB);

  const onImport = useCallback(
    async (file: File) => {
      try {
        const imported = await importPresets(file);
        if (imported.length === 0) {
          toast.error('No valid rules found in that file.');
          return;
        }
        const result = importClashPresets(imported);
        if (result.ok) toast.success(`Imported ${imported.length} rule${imported.length === 1 ? '' : 's'}`);
        else toast.error(result.message);
      } catch {
        toast.error('Could not read that file as clash rules.');
      }
    },
    [importClashPresets],
  );

  const enabledCount = useMemo(() => presets.filter((p) => p.enabled).length, [presets]);

  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="icon" className="h-7 w-7" title="Clash settings">
            <Settings2 className="h-4 w-4" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[560px] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-[#f7768e]" />
            Clash settings
          </DialogTitle>
          <DialogDescription>
            Tune detection and curate the rule set. {enabledCount} of {presets.length} rules enabled.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="detection" className="mt-1">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger
              value="detection"
              className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm data-[state=active]:font-semibold"
            >
              Detection
            </TabsTrigger>
            <TabsTrigger
              value="rules"
              className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm data-[state=active]:font-semibold"
            >
              Rules
            </TabsTrigger>
          </TabsList>

          {/* ---- Detection ---------------------------------------------------- */}
          <TabsContent value="detection" className="space-y-3 max-h-[58vh] overflow-y-auto pr-1">
            <SettingRow label="Default mode" hint="Hard finds interpenetrations; clearance finds gaps smaller than the required distance.">
              <Select value={mode} onValueChange={(v) => setMode(v as 'hard' | 'clearance')}>
                <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hard">Hard</SelectItem>
                  <SelectItem value="clearance">Clearance</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow label="Tolerance" hint="Touching band (m). Surfaces within this distance count as contact, not penetration.">
              <NumberField value={tolerance} step={0.001} min={0} onCommit={setTolerance} suffix="m" />
            </SettingRow>

            <SettingRow label="Clearance gap" hint="Required gap (m) in clearance mode. Anything closer than this is a violation.">
              <NumberField value={clearance} step={0.01} min={0} onCommit={setClearance} suffix="m" />
            </SettingRow>

            <SettingRow label="Cluster radius" hint="How far apart clashes can be and still merge into one BCF topic (m).">
              <NumberField value={clusterEpsilon} step={0.1} min={0.01} onCommit={setClusterEpsilon} suffix="m" />
            </SettingRow>

            <SettingRow label="Report grazing contacts" hint="Include touch-classified results (surfaces that just graze) in detection.">
              <Switch checked={reportTouch} onCheckedChange={setReportTouch} />
            </SettingRow>

            <SettingRow label="Default grouping" hint="How the results list is organized in the panel.">
              <Select value={groupBy} onValueChange={(v) => setGroupBy(v as typeof groupBy)}>
                <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="severity">By severity</SelectItem>
                  <SelectItem value="rule">By rule</SelectItem>
                  <SelectItem value="typePair">By type pair</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <div className="pt-1">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={resetSettings}>
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Reset detection settings
              </Button>
            </div>
          </TabsContent>

          {/* ---- Rules -------------------------------------------------------- */}
          <TabsContent value="rules" className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Button size="sm" className="h-7 px-2 text-xs" onClick={startAdd}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add rule
              </Button>
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Reset to the built-in rules" onClick={resetPresets}>
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Export rules" onClick={() => exportPresets(presets)}>
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Import rules" onClick={() => fileRef.current?.click()}>
                  <Upload className="h-3.5 w-3.5" />
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,.clash-presets.json,application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onImport(f);
                    e.target.value = '';
                  }}
                />
              </div>
            </div>

            <ScrollArea className="max-h-[36vh] pr-1">
              <div className="space-y-1">
                {presets.map((p) => (
                  <div
                    key={p.id}
                    className={cn(
                      'flex items-center gap-2 rounded-md border border-border px-2 py-1.5',
                      !p.enabled && 'opacity-55',
                    )}
                  >
                    <Switch checked={p.enabled} onCheckedChange={(v) => setPresetEnabled(p.id, v)} />
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SEVERITY[p.severity].color }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">
                        {p.name}
                        {!p.builtin && <span className="ml-1.5 text-[10px] text-muted-foreground">custom</span>}
                        {((p.whereA?.length ?? 0) + (p.whereB?.length ?? 0)) > 0 && (
                          <span className="ml-1.5 rounded-full bg-blue-500/15 text-blue-400 px-1.5 py-px text-[9px] font-medium tabular-nums">
                            {(p.whereA?.length ?? 0) + (p.whereB?.length ?? 0)} filter{((p.whereA?.length ?? 0) + (p.whereB?.length ?? 0)) > 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {p.selectorA} <span className="opacity-60">×</span> {p.selectorB}
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" className="h-6 w-6" title="Edit" onClick={() => startEdit(p)}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    {p.builtin ? (
                      <span className="w-6" />
                    ) : (
                      <Button variant="ghost" size="icon" className="h-6 w-6" title="Delete" onClick={() => deletePreset(p.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>

            {draft && (
              <div className="rounded-md border border-[#f7768e]/40 bg-muted/30 p-2.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{draft.id ? 'Edit rule' : 'New rule'}</span>
                  <button onClick={() => setDraft(null)} className="text-muted-foreground hover:text-foreground" title="Cancel">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Rule name (e.g. Ducts vs Beams)"
                  className="h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-sm"
                />

                {/* ── Group A selector ─────────────────────────────────────── */}
                <div className="rounded-md border border-border/60 bg-background/40 p-2">
                  <SelectorBuilder
                    selector={draft.selectorA}
                    onSelectorChange={(v) => setDraft((d) => d ? { ...d, selectorA: v } : d)}
                    conditions={draft.whereA}
                    onConditionsChange={(v) => setDraft((d) => d ? { ...d, whereA: v } : d)}
                    classes={classes}
                    propertySets={propertySets}
                    onRequestPropertyDiscovery={handleRequestPropertyDiscovery}
                    label="Group A"
                    placeholder="IfcDuct*|IfcPipe*"
                  />
                </div>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <div className="h-px flex-1 bg-border" />
                  <span>×</span>
                  <div className="h-px flex-1 bg-border" />
                </div>

                {/* ── Group B selector ─────────────────────────────────────── */}
                <div className="rounded-md border border-border/60 bg-background/40 p-2">
                  <SelectorBuilder
                    selector={draft.selectorB}
                    onSelectorChange={(v) => setDraft((d) => d ? { ...d, selectorB: v } : d)}
                    conditions={draft.whereB}
                    onConditionsChange={(v) => setDraft((d) => d ? { ...d, whereB: v } : d)}
                    classes={classes}
                    propertySets={propertySets}
                    onRequestPropertyDiscovery={handleRequestPropertyDiscovery}
                    label="Group B"
                    placeholder="IfcWall*|IfcSlab"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Select value={draft.severity} onValueChange={(v) => setDraft({ ...draft, severity: v as ClashSeverity })}>
                    <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SEVERITIES.map((s) => (
                        <SelectItem key={s} value={s}>{SEVERITY[s].label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" className="ml-auto h-8" disabled={!draftValid} onClick={saveDraft}>
                    <Check className="h-3.5 w-3.5 mr-1" /> {draft.id ? 'Save' : 'Add'}
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5">
      <div className="min-w-0">
        <Label className="text-sm">{label}</Label>
        <p className="mt-0.5 text-xs text-muted-foreground leading-snug">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Numeric input that commits on change, clamped by the store setter. */
function NumberField({
  value, step, min, suffix, onCommit,
}: { value: number; step: number; min: number; suffix?: string; onCommit: (v: number) => void }) {
  return (
    <div className="inline-flex items-center gap-1">
      <input
        type="number"
        step={step}
        min={min}
        value={value}
        onChange={(e) => onCommit(Number(e.target.value))}
        className="h-8 w-24 rounded-md border border-border bg-transparent px-2 text-sm tabular-nums text-right"
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}
