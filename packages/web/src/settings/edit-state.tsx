import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, ConfirmDialog, SettingsFooter } from '@dilla/ui';
import { requestNavigation, setNavigationGuard } from '../router.ts';
import { settingsEditing as copy } from '../strings/settingsEditing.ts';

export interface SettingsEditState {
  dirty: boolean;
  busy: boolean;
  canSave: boolean;
  save(): Promise<boolean>;
  reset(): void;
}

export interface SettingsWorkspace {
  edit: SettingsEditState | null;
  footer: ReactNode;
  confirmation: ReactNode;
  requestNavigation: typeof requestNavigation;
  clear(): void;
}

const WorkspaceContext = createContext<SettingsWorkspace | null>(null);
const EditRegistrationContext = createContext<(state: SettingsEditState | null) => void>(() => undefined);

/** Owns the shared footer, unsaved-change prompt and browser departure guard for one settings workspace. */
export function SettingsEditProvider({ children }: { children: ReactNode }) {
  const [edit, setEdit] = useState<SettingsEditState | null>(null);
  const editRef = useRef<SettingsEditState | null>(edit);
  editRef.current = edit;
  const [prompt, setPrompt] = useState<{ resolve: (allowed: boolean) => void } | null>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const [saveError, setSaveError] = useState(false);

  const register = useCallback((state: SettingsEditState | null) => {
    editRef.current = state;
    setEdit(state);
    if (state === null) setSaveError(false);
  }, []);

  const clear = useCallback(() => {
    const state = editRef.current;
    state?.reset();
    editRef.current = null;
    setEdit(null);
    setSaveError(false);
    promptRef.current?.resolve(false);
    promptRef.current = null;
    setPrompt(null);
  }, []);

  useEffect(() => {
    const guard = async (): Promise<boolean> => {
      const state = editRef.current;
      if (!state || (!state.dirty && !state.busy)) return true;
      if (promptRef.current) {
        return new Promise(resolve => {
          const prior = promptRef.current;
          if (prior) {
            const original = prior.resolve;
            prior.resolve = allowed => { original(allowed); resolve(allowed); };
          }
        });
      }
      return new Promise<boolean>(resolve => {
        const pending = { resolve };
        promptRef.current = pending;
        setPrompt(pending);
      });
    };
    const dispose = setNavigationGuard(guard);
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const state = editRef.current;
      if (!state || (!state.dirty && !state.busy)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      dispose();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  const finishPrompt = useCallback((allowed: boolean) => {
    const pending = promptRef.current;
    promptRef.current = null;
    setPrompt(null);
    if (allowed) {
      editRef.current?.reset();
      setSaveError(false);
    }
    pending?.resolve(allowed);
  }, []);

  const save = useCallback(async () => {
    const state = editRef.current;
    if (!state || state.busy || !state.canSave) return;
    setSaveError(false);
    let saved = false;
    try { saved = await state.save(); } catch { saved = false; }
    setSaveError(!saved);
  }, []);
  const reset = useCallback(() => {
    if (editRef.current?.busy) return;
    editRef.current?.reset();
    setSaveError(false);
  }, []);

  const dirtyOrBusy = Boolean(edit && (edit.dirty || edit.busy));
  const footer = dirtyOrBusy ? (
    <SettingsFooter status={saveError ? copy.saveFailed : copy.unsaved}>
      <Button type="button" disabled={edit?.busy} onClick={reset}>{copy.reset}</Button>
      <Button type="button" variant="accent" disabled={edit?.busy || !edit?.canSave} onClick={() => void save()}>{copy.save}</Button>
    </SettingsFooter>
  ) : null;
  const confirmation = (
    <ConfirmDialog open={prompt !== null} tone="accent" title={copy.leaveTitle}
      body={edit?.busy ? copy.leaveBusyBody : copy.leaveBody} confirmLabel={copy.discard}
      busyLabel={copy.discard} cancelLabel={copy.keepEditing} busy={false} error={null}
      onConfirm={() => finishPrompt(true)} onClose={() => finishPrompt(false)} />
  );
  const workspace = useMemo<SettingsWorkspace>(() => ({ edit, footer, confirmation, requestNavigation, clear }), [edit, footer, confirmation, clear]);
  return (
    <WorkspaceContext.Provider value={workspace}>
      <EditRegistrationContext.Provider value={register}>{children}</EditRegistrationContext.Provider>
    </WorkspaceContext.Provider>
  );
}

/** Register this section's state with the nearest workspace; returns false for standalone settings forms. */
export function useSettingsEdit(state: SettingsEditState): boolean {
  const register = useContext(EditRegistrationContext);
  useEffect(() => { register(state); return () => register(null); }, [register, state]);
  return useContext(WorkspaceContext) !== null;
}

/** Shared workspace surfaces and helpers. Returns null outside a SettingsEditProvider. */
export function useSettingsWorkspace(): SettingsWorkspace | null {
  return useContext(WorkspaceContext);
}
