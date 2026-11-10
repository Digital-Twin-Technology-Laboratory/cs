import { App, InputNumber } from 'antd';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

interface Override { scope: string; name: string; value: number }
const numberKey = (scope: string, name: string) => JSON.stringify([scope, name]);
const Context = createContext<{
  values: Record<string, number>;
  save: (scope: string, name: string, value: number | null) => Promise<void>;
}>(null!);

export function NumberOverridesProvider({ children }: { children: ReactNode }) {
  const { message } = App.useApp();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [values, setValues] = useState<Record<string, number>>({});
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await api.get<{ rows: Override[] }>('/api/statistic-overrides');
        if (active) setValues(Object.fromEntries(result.rows.map((r) => [numberKey(r.scope, r.name), r.value])));
      } catch (e) { if (active) message.error((e as Error).message); }
    };
    load();
    const timer = setInterval(load, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [pathname, user?.role, user?.college_role, message]);
  const save = useCallback(async (scope: string, name: string, value: number | null) => {
    await api.put('/api/statistic-overrides', { scope, name, value });
    setValues((previous) => {
      const next = { ...previous };
      if (value === null) delete next[numberKey(scope, name)];
      else next[numberKey(scope, name)] = value;
      return next;
    });
  }, []);
  return <Context.Provider value={{ values, save }}>{children}</Context.Provider>;
}

export function useStoredNumber() {
  const { values } = useContext(Context);
  return (scope: string, name: string, fallback: number) => values[numberKey(scope, name)] ?? fallback;
}

export function EditableNumber({ value, name, min = 0, onSave, format = String, editable }: {
  value: number; name: string; min?: number; editable?: boolean;
  onSave: (value: number | null) => Promise<void>;
  format?: (value: number) => ReactNode;
}) {
  const { user } = useAuth();
  const canEdit = editable ?? user?.role === 'admin';
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number | null>(value);
  const [saving, setSaving] = useState(false);
  const cancelled = useRef(false);
  const save = async () => {
    if (cancelled.current) return;
    if (draft === value) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (e) { message.error((e as Error).message); }
    finally { setSaving(false); }
  };
  if (editing && canEdit) return <InputNumber autoFocus aria-label={name} min={min} precision={0}
    value={draft} disabled={saving} style={{ width: 85 }} onChange={setDraft}
    onPressEnter={(e) => (e.target as HTMLInputElement).blur()} onBlur={save}
    onKeyDown={(e) => { if (e.key === 'Escape') { cancelled.current = true; setEditing(false); } }} />;
  return <span onDoubleClick={canEdit ? () => { cancelled.current = false; setDraft(value); setEditing(true); } : undefined}>{format(value)}</span>;
}

export default function StoredNumber({ scope, name, value }: Override) {
  const { save } = useContext(Context);
  const stored = useStoredNumber();
  return <EditableNumber name={name} value={stored(scope, name, value)} onSave={(next) => save(scope, name, next)} />;
}
