import { Tag } from 'antd';
import { Link } from 'react-router-dom';
import Table from './ResponsiveTable';
import { ConfirmationTag, SubmissionTag } from './StatusTag';
import type { RequiredCourseProgress } from '../types';

export default function CourseProgressTable({ courses }: { courses: RequiredCourseProgress[] }) {
  return <Table<RequiredCourseProgress>
    rowKey="id"
    size="small"
    dataSource={courses}
    pagination={false}
    columns={[
      { title: '应交课程', render: (_, r) => <div>{r.course_name}<div className="muted small">{r.course_group} / {r.professional}</div></div> },
      { title: '最新检查', width: 120, render: (_, r) => r.latest_id === null ? <Tag>未上传</Tag> : <SubmissionTag status={r.status} verdict={r.verdict} /> },
      { title: '最终确认', width: 150, render: (_, r) => <div><ConfirmationTag status={r.status} confirmedAt={r.confirmed_at} />{r.confirmed_by && <div className="muted small">{r.confirmed_by}</div>}</div> },
      { title: '最近上传', dataIndex: 'created_at', width: 170, render: (v) => v ?? '-' },
      { title: '查看结果', width: 100, render: (_, r) => r.latest_id === null ? '-' : <Link to={`/submissions/${r.latest_id}`}>查看结果</Link> },
    ]}
  />;
}
