import { App, AutoComplete, Button, Form, Input, Modal } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import type { Options, SubStatus } from '../types';

export default function SubmissionCourseEditor({ id, ownerId, name, status, onSaved }: {
  id: number; ownerId: number; name: string; status: SubStatus; onSaved: () => Promise<unknown>;
}) {
  const { user } = useAuth();
  const { message } = App.useApp();
  const [form] = Form.useForm<{ name: string }>();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState<{ value: string }[]>([]);
  if (user?.role !== 'admin' && user?.college_role !== 'teaching' && user?.id !== ownerId) return null;

  const edit = async () => {
    setLoading(true);
    try {
      const result = await api.get<Options>('/api/options');
      setOptions([...new Map(result.outlineCourses.map((course) => [course.name.toLowerCase(), { value: course.name }])).values()]);
      form.setFieldsValue({ name });
      setOpen(true);
    } catch (e) { message.error((e as Error).message); }
    finally { setLoading(false); }
  };

  const save = async ({ name: next }: { name: string }) => {
    setSaving(true);
    try {
      const result = await api.put<{ outlineRequirementId: number | null }>(`/api/submissions/${id}`, { course_name: next });
      await onSaved();
      setOpen(false);
      if (result.outlineRequirementId) message.success('课程名称已修改，应交课程关联已保存');
      else message.warning('课程名称已修改，但未能唯一关联应交课程，请核对课程名称和专业');
    } catch (e) { message.error((e as Error).message); }
    finally { setSaving(false); }
  };

  return <>
    <Button type="link" size="small" icon={<EditOutlined />} loading={loading} disabled={status === 'queued' || status === 'running'} onClick={edit}>修改课程名称</Button>
    <Modal title="修改上传记录的课程名称" open={open} forceRender confirmLoading={saving} okText="保存" cancelText="取消"
      onOk={() => form.submit()} onCancel={() => { if (!saving) setOpen(false); }}>
      <p className="muted small">修正历史记录的课程名称，不修改原文件、AI 检查明细或提交状态。未关联的记录会按课程名称和专业重新匹配应交任务；无法唯一匹配时不自动关联，已有任务关联保持不变。</p>
      <Form form={form} layout="vertical" onFinish={save} disabled={saving}>
        <Form.Item name="name" label="课程名称" rules={[{ required: true, whitespace: true, message: '请填写或选择课程名称' }]}>
          <AutoComplete options={options} filterOption={(input, option) => String(option?.value).toLowerCase().includes(input.toLowerCase())}>
            <Input maxLength={100} placeholder="填写或从课程清单中选择" />
          </AutoComplete>
        </Form.Item>
      </Form>
    </Modal>
  </>;
}
