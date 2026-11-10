import { App, Input, Select } from 'antd';
import { useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../auth';

export default function EditableText({ value, name, children, options, disabled = false, onSave }: {
  value: string; name: string; children: ReactNode; disabled?: boolean;
  options?: { value: string; label: string }[];
  onSave: (value: string) => Promise<void>;
}) {
  const { user } = useAuth();
  const canEdit = user?.role === 'admin' || user?.college_role === 'teaching';
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const finished = useRef(false);
  const save = async (next: string) => {
    if (finished.current) return;
    if (next === value) { setEditing(false); return; }
    finished.current = true;
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch (e) { finished.current = false; message.error((e as Error).message); }
    finally { setSaving(false); }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { finished.current = true; setEditing(false); }
  };
  if (editing && canEdit) {
    if (options) return <Select autoFocus defaultOpen aria-label={name} value={draft} options={options} disabled={saving}
      style={{ width: '100%', minWidth: 80 }} onKeyDown={onKeyDown} onChange={(next) => { setDraft(next); save(next); }}
      onBlur={() => { if (!finished.current) setEditing(false); }} />;
    return <Input autoFocus aria-label={name} value={draft} disabled={saving} onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown} onPressEnter={(e) => (e.target as HTMLInputElement).blur()} onBlur={() => save(draft)} />;
  }
  return <span onDoubleClick={canEdit && !disabled ? () => { finished.current = false; setDraft(value); setEditing(true); } : undefined}>{children}</span>;
}
