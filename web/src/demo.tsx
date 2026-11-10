import { InputNumber } from 'antd';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useAuth } from './auth';
import type { SubmissionRow } from './types';

export interface DemoRecord extends SubmissionRow { username: string; user_name: string }
export type DemoProgress = 'missing' | 'failed' | 'passed' | 'confirmed';
interface DemoState {
  editing: boolean;
  teacherName: string;
  numbers: Record<string, number>;
  records: Record<string, DemoRecord[]>;
  recordEdits: Record<number, Partial<DemoRecord>>;
  progress: Record<number, DemoProgress>;
}

function useDemoState() {
  const { user } = useAuth();
  const allowed = user?.demo_editor === 1;
  const [state, setState] = useState<DemoState | null>(null);
  const enabled = allowed && state !== null;
  const update = (patch: Partial<DemoState>) => setState((s) => ({ ...s!, ...patch }));
  return {
    allowed, enabled, editing: enabled && state.editing,
    teacherName: enabled ? state.teacherName : user?.name,
    numbers: enabled ? state.numbers : {},
    records: enabled ? state.records : {},
    recordEdits: enabled ? state.recordEdits : {},
    progress: enabled ? state.progress : {},
    start: () => setState({ editing: true, teacherName: user!.name, numbers: {}, records: {}, recordEdits: {}, progress: {} }),
    exit: () => setState(null),
    update,
    setNumber: (key: string, value: number) => setState((s) => ({ ...s!, numbers: { ...s!.numbers, [key]: value } })),
    setRecords: (scope: string, rows: DemoRecord[]) => setState((s) => ({ ...s!, records: { ...s!.records, [scope]: rows }, recordEdits: {} })),
    editRecord: (id: number, patch: Partial<DemoRecord>) => setState((s) => ({ ...s!, recordEdits: { ...s!.recordEdits, [id]: { ...s!.recordEdits[id], ...patch } } })),
    setProgress: (progress: Record<number, DemoProgress>) => setState((s) => ({ ...s!, progress: { ...s!.progress, ...progress } })),
  };
}

const Context = createContext<ReturnType<typeof useDemoState>>(null!);

export function DemoProvider({ children }: { children: ReactNode }) {
  const demo = useDemoState();
  return <Context.Provider value={demo}>{children}</Context.Provider>;
}

export const useDemo = () => useContext(Context);

export function DemoNumber({ name, value }: { name: string; value: number }) {
  const demo = useDemo();
  const shown = demo.numbers[name] ?? value;
  return demo.editing
    ? <InputNumber aria-label={name} min={0} precision={0} value={shown} style={{ width: 85 }} onChange={(n) => { if (n !== null) demo.setNumber(name, n); }} />
    : <>{shown}</>;
}
