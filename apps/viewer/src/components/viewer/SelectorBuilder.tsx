/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SelectorBuilder — visual editor for a clash rule group selector.
 *
 * Combines two independent filters that are AND-combined at runtime:
 *  1. IFC class selector — typed pattern (IfcWall, IfcDuct*, IfcWall|IfcSlab,
 *     !IfcSpace) with live autocomplete from the loaded model's discovered types.
 *  2. Property conditions — zero or more (pset, property, op, value) rows.
 *     Pset and property names are populated lazily from discoveredLensData.
 *
 * The class selector is kept as a plain string so power users can type
 * patterns directly; the class autocomplete just accelerates common cases.
 * Property conditions are structured objects (PropertyCondition[]).
 */

import { useCallback, useMemo, useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ComboInput } from '@/components/ui/combo-input';
import { cn } from '@/lib/utils';
import { matchesSelector, type PropertyCondition, type PropertyConditionOp } from '@ifc-lite/clash';

const OPS: { value: PropertyConditionOp; label: string }[] = [
  { value: '=',        label: '= equals' },
  { value: '!=',       label: '≠ not equals' },
  { value: '>',        label: '> greater than' },
  { value: '<',        label: '< less than' },
  { value: '>=',       label: '≥ ≥ or equal' },
  { value: '<=',       label: '≤ ≤ or equal' },
  { value: 'contains', label: '∋ contains' },
  { value: 'exists',   label: '∃ exists' },
];

export interface SelectorBuilderProps {
  /** Current IFC type selector string. */
  selector: string;
  onSelectorChange: (v: string) => void;
  /** Current property conditions array. */
  conditions: PropertyCondition[];
  onConditionsChange: (v: PropertyCondition[]) => void;
  /** IFC class names discovered from the loaded model. */
  classes: string[] | null;
  /** Pset → property names discovered from the loaded model. Null = not yet loaded. */
  propertySets: Map<string, string[]> | null;
  /** Called when the user first opens the conditions panel — triggers lazy discovery. */
  onRequestPropertyDiscovery?: () => void;
  /** Placeholder text for the class selector input. */
  placeholder?: string;
  /** Label shown above the whole selector (e.g. "Group A"). */
  label?: string;
}

export function SelectorBuilder({
  selector,
  onSelectorChange,
  conditions,
  onConditionsChange,
  classes,
  propertySets,
  onRequestPropertyDiscovery,
  placeholder = 'IfcWall|IfcSlab*',
  label,
}: SelectorBuilderProps) {
  const [conditionsOpen, setConditionsOpen] = useState(conditions.length > 0);

  const classCount = useMemo(() => {
    if (!classes || !selector.trim()) return null;
    return classes.filter((c) => matchesSelector(c, selector)).length;
  }, [classes, selector]);

  const psetNames = useMemo(
    () => (propertySets ? Array.from(propertySets.keys()).sort() : []),
    [propertySets],
  );

  const addCondition = useCallback(() => {
    onConditionsChange([...conditions, { pset: '', property: '', op: '=', value: '' }]);
    setConditionsOpen(true);
  }, [conditions, onConditionsChange]);

  const updateCondition = useCallback(
    (index: number, patch: Partial<PropertyCondition>) => {
      const next = conditions.map((c, i) => (i === index ? { ...c, ...patch } : c));
      onConditionsChange(next);
    },
    [conditions, onConditionsChange],
  );

  const removeCondition = useCallback(
    (index: number) => {
      onConditionsChange(conditions.filter((_, i) => i !== index));
    },
    [conditions, onConditionsChange],
  );

  const toggleConditions = useCallback(() => {
    const next = !conditionsOpen;
    setConditionsOpen(next);
    if (next) onRequestPropertyDiscovery?.();
  }, [conditionsOpen, onRequestPropertyDiscovery]);

  return (
    <div className="space-y-1.5">
      {label && <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>}

      {/* ── Class / type selector ──────────────────────────────────── */}
      <div>
        <ComboInput
          value={selector}
          onChange={onSelectorChange}
          options={classes ?? []}
          placeholder={placeholder}
          className="h-8 w-full text-xs font-mono"
          aria-label="IFC class selector"
        />
        <div className="mt-0.5 h-3 text-[10px] text-muted-foreground truncate">
          {!classes
            ? 'load a model to preview'
            : classCount === null
              ? ' '
              : classCount > 0
                ? `✓ matches ${classCount} class${classCount === 1 ? '' : 'es'}`
                : '✗ matches no classes'}
          {conditions.length > 0 && classCount !== null && (
            <span className="ml-1.5 text-blue-400/80">+ {conditions.length} property condition{conditions.length > 1 ? 's' : ''}</span>
          )}
        </div>
      </div>

      {/* ── Property conditions ────────────────────────────────────── */}
      <div>
        <button
          type="button"
          onClick={toggleConditions}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {conditionsOpen
            ? <ChevronDown className="h-3 w-3" />
            : <ChevronRight className="h-3 w-3" />}
          Property conditions
          {conditions.length > 0 && (
            <span className="ml-1 rounded-full bg-blue-500/15 text-blue-400 px-1.5 py-px text-[9px] font-medium tabular-nums">
              {conditions.length}
            </span>
          )}
        </button>

        {conditionsOpen && (
          <div className="mt-1.5 space-y-1.5 pl-1">
            {conditions.map((cond, i) => (
              <ConditionRow
                key={i}
                condition={cond}
                psetNames={psetNames}
                propertyNames={cond.pset ? (propertySets?.get(cond.pset) ?? []) : []}
                onChange={(patch) => updateCondition(i, patch)}
                onRemove={() => removeCondition(i)}
              />
            ))}

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-muted-foreground"
              onClick={addCondition}
            >
              <Plus className="h-3 w-3 mr-1" /> Add condition
            </Button>

            {propertySets === null && (
              <p className="text-[10px] text-muted-foreground italic pl-0.5">
                Property sets not yet loaded — expand a pset field to trigger discovery.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Condition row ─────────────────────────────────────────────────────────────

interface ConditionRowProps {
  condition: PropertyCondition;
  psetNames: string[];
  propertyNames: string[];
  onChange: (patch: Partial<PropertyCondition>) => void;
  onRemove: () => void;
}

function ConditionRow({ condition, psetNames, propertyNames, onChange, onRemove }: ConditionRowProps) {
  const needsValue = condition.op !== 'exists';

  return (
    <div className="flex items-start gap-1">
      {/* Pset name */}
      <div className="flex-1 min-w-0">
        <ComboInput
          value={condition.pset}
          onChange={(v) => onChange({ pset: v, property: '' })}
          options={psetNames}
          placeholder="Pset_WallCommon"
          className={cn('h-7 text-[11px] font-mono', !condition.pset && 'border-orange-500/40')}
          aria-label="Property set name"
        />
      </div>

      {/* Property name */}
      <div className="flex-1 min-w-0">
        <ComboInput
          value={condition.property}
          onChange={(v) => onChange({ property: v })}
          options={propertyNames}
          placeholder="IsExternal"
          className={cn('h-7 text-[11px] font-mono', !condition.property && 'border-orange-500/40')}
          aria-label="Property name"
        />
      </div>

      {/* Operator */}
      <Select value={condition.op} onValueChange={(v) => onChange({ op: v as PropertyConditionOp, value: condition.op === 'exists' ? '' : condition.value })}>
        <SelectTrigger className="h-7 w-28 text-[11px] shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OPS.map((op) => (
            <SelectItem key={op.value} value={op.value} className="text-xs">
              {op.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Value */}
      {needsValue && (
        <input
          value={condition.value !== undefined && condition.value !== null ? String(condition.value) : ''}
          onChange={(e) => onChange({ value: coerceValue(e.target.value) })}
          placeholder="value"
          className="h-7 w-20 shrink-0 rounded-md border border-border bg-transparent px-2 text-[11px] font-mono"
          aria-label="Condition value"
        />
      )}

      <button
        type="button"
        onClick={onRemove}
        className="mt-0.5 shrink-0 text-muted-foreground hover:text-destructive transition-colors"
        title="Remove condition"
        aria-label="Remove condition"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Best-effort coercion: true/false → boolean, numeric strings → number, rest → string. */
function coerceValue(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  if (raw !== '' && Number.isFinite(n)) return n;
  return raw;
}
