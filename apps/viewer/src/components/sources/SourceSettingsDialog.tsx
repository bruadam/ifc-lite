/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useCallback, useEffect } from 'react';
import type { PluginManifest, PluginPreference, ConnectionTestResult } from '@ifc-lite/plugin-api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { connectOAuth, disconnectOAuth, isOAuthConnected } from '@/services/sources/oauth-connection';

interface SourceSettingsDialogProps {
  manifest: PluginManifest;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (values: Record<string, string>) => void;
  onTestConnection?: (values: Record<string, string>) => Promise<ConnectionTestResult>;
  initialValues?: Record<string, string>;
}

export function SourceSettingsDialog({
  manifest,
  open,
  onOpenChange,
  onSave,
  onTestConnection,
  initialValues = {},
}: SourceSettingsDialogProps) {
  const isOAuth = manifest.auth === 'oauth';
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [connected, setConnected] = useState(() => isOAuth && isOAuthConnected(manifest.name));
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (open) {
      setValues(initialValues);
      setTestResult(null);
      if (isOAuth) setConnected(isOAuthConnected(manifest.name));
    }
  }, [open, initialValues, isOAuth, manifest.name]);

  const updateValue = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setTestResult(null);
  }, []);

  const handleTest = useCallback(async () => {
    if (!onTestConnection) return;
    setTesting(true);
    try {
      const result = await onTestConnection(values);
      setTestResult(result);
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }, [onTestConnection, values]);

  const handleSave = useCallback(() => {
    onSave(values);
    onOpenChange(false);
  }, [onSave, onOpenChange, values]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setTestResult(null);
    try {
      await connectOAuth(manifest.name);
      setConnected(true);
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setConnecting(false);
    }
  }, [manifest.name]);

  const handleDisconnect = useCallback(async () => {
    await disconnectOAuth(manifest.name);
    setConnected(false);
    setTestResult(null);
  }, [manifest.name]);

  const requiredMissing = isOAuth
    ? !connected
    : manifest.preferences.filter((p) => p.required).some((p) => !values[p.name]?.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{manifest.title} Settings</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {isOAuth ? (
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <span className="flex items-center gap-2 text-sm">
                {connected ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                {connected ? 'Connected' : 'Not connected'}
              </span>
              <Button
                variant={connected ? 'outline' : 'default'}
                size="sm"
                onClick={() => void (connected ? handleDisconnect() : handleConnect())}
                disabled={connecting}
              >
                {connecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {connected ? 'Disconnect' : 'Connect'}
              </Button>
            </div>
          ) : (
            manifest.preferences.map((pref) => (
              <PreferenceField
                key={pref.name}
                pref={pref}
                value={values[pref.name] ?? pref.default ?? ''}
                onChange={(v) => updateValue(pref.name, v)}
              />
            ))
          )}

          {testResult && (
            <div
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                testResult.ok
                  ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                  : 'bg-red-500/10 text-red-700 dark:text-red-400'
              }`}
            >
              {testResult.ok ? (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 shrink-0" />
              )}
              <span>{testResult.message}</span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {onTestConnection && (
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testing || requiredMissing}
            >
              {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Test connection
            </Button>
          )}
          {!isOAuth && (
            <Button onClick={handleSave} disabled={requiredMissing}>
              Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreferenceField({
  pref,
  value,
  onChange,
}: {
  pref: PluginPreference;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`pref-${pref.name}`}>
        {pref.title}
        {pref.required && <span className="ml-1 text-red-500">*</span>}
      </Label>
      {pref.description && (
        <p className="text-xs text-muted-foreground">{pref.description}</p>
      )}
      <Input
        id={`pref-${pref.name}`}
        type={pref.type === 'password' ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={pref.type === 'password' ? '••••••••' : undefined}
      />
    </div>
  );
}
