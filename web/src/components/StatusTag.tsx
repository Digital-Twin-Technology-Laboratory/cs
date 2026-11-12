import { Tag } from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined, SyncOutlined } from '@ant-design/icons';
import type { SubStatus } from '../types';

/** 一次检查的状态：排队中/检查中/失败/通过/未通过（文字 + 图标，不只靠颜色区分） */
export function SubmissionTag({ status, verdict }: { status: SubStatus | null; verdict: 'passed' | 'failed' | null }) {
  if (!status) return <Tag>未检查</Tag>;
  if (status === 'queued') return <Tag icon={<ClockCircleOutlined />}>排队中</Tag>;
  if (status === 'running')
    return (
      <Tag icon={<SyncOutlined spin />} color="processing">
        检查中
      </Tag>
    );
  if (status === 'failed')
    return (
      <Tag icon={<ExclamationCircleOutlined />} color="warning">
        检查失败
      </Tag>
    );
  return verdict === 'passed' ? (
    <Tag icon={<CheckCircleOutlined />} color="success">
      已通过
    </Tag>
  ) : (
    <Tag icon={<CloseCircleOutlined />} color="error">
      未通过
    </Tag>
  );
}

export function ConfirmationTag({ confirmedAt, status, withdrawnAt }: { confirmedAt: string | null; status: SubStatus | null; withdrawnAt?: string | null }) {
  if (confirmedAt) return <Tag color="success">已提交</Tag>;
  if (withdrawnAt || !status) return <Tag>未上传</Tag>;
  if (status === 'done') return <Tag color="processing">待提交</Tag>;
  return <Tag>未提交</Tag>;
}

export function NatureTag({ nature }: { nature: string }) {
  const color = nature === '重大问题' ? 'red' : nature === '明确问题' ? 'orange' : 'blue';
  return (
    <Tag color={color} variant="outlined" style={{ marginInlineEnd: 0 }}>
      {nature}
    </Tag>
  );
}

export function ItemResultTag({ result }: { result: string }) {
  const map: Record<string, string> = { 未发现问题: 'success', 存在问题: 'error', 需核实: 'warning', 不适用: 'default' };
  return <Tag color={map[result] ?? 'default'}>{result}</Tag>;
}

export function UserStatusTag({ status }: { status: string }) {
  if (status === 'active') return <Tag color="success">正常</Tag>;
  if (status === 'pending') return <Tag color="warning">待审核</Tag>;
  return <Tag>已停用</Tag>;
}
