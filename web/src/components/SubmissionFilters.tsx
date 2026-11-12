import { App, Select } from 'antd';
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Options } from '../types';

export interface AttachmentFilters { major: string; studentGrade: string; courseGroup: string }

export default function SubmissionFilters({ value, onChange }: { value: AttachmentFilters; onChange: (patch: Partial<AttachmentFilters>) => void }) {
  const { message } = App.useApp();
  const [options, setOptions] = useState<Options | null>(null);
  useEffect(() => { api.get<Options>('/api/options').then(setOptions).catch((e) => message.error(e.message)); }, [message]);
  const groups = [...new Set((options?.outlineCourses ?? []).map((c) => c.course_group))].filter(Boolean);
  const majors = [...new Set([...(options?.majors ?? []), ...(options?.outlineCourses ?? []).map((c) => c.professional)])].filter(Boolean);
  return <>
    <Select aria-label="附件专业筛选" value={value.major} onChange={(major) => onChange({ major })} style={{ width: 220 }}
      showSearch optionFilterProp="label" options={[{ value: '', label: '全部专业' }, ...majors.map((m) => ({ value: m, label: m }))]} />
    <Select aria-label="附件年级筛选" value={value.studentGrade} onChange={(studentGrade) => onChange({ studentGrade })} style={{ width: 120 }}
      options={[{ value: '', label: '全部年级' }, ...(options?.studentGrades ?? []).map((g) => ({ value: String(g), label: `${g}级` }))]} />
    <Select aria-label="附件课程组筛选" value={value.courseGroup} onChange={(courseGroup) => onChange({ courseGroup })} style={{ width: 260 }}
      showSearch optionFilterProp="label" options={[{ value: '', label: '全部课程组' }, ...groups.map((g) => ({ value: g, label: g }))]} />
  </>;
}
