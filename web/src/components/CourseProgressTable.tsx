import { Tag } from 'antd';
import { Link } from 'react-router-dom';
import Table from './ResponsiveTable';
import { ConfirmationTag, SubmissionTag } from './StatusTag';
import type { RequiredCourseProgress } from '../types';

export default function CourseProgressTable({ courses, showPlan = false }: { courses: RequiredCourseProgress[]; showPlan?: boolean }) {
  return <Table<RequiredCourseProgress>
    rowKey="course_name"
    size="small"
    dataSource={courses}
    pagination={false}
    columns={[
      { title: '应交课程', render: (_, r) => <div>{r.course_name}<div className="muted small">{r.course_group}</div></div> },
      ...(showPlan ? [{ title: '磨课核对', width: 130, render: (_: unknown, r: RequiredCourseProgress) => <Tag>{r.in_plan ? '磨课表中已核对' : '课表应交课程'}</Tag> }] : []),
      { title: '最新检查', width: 120, render: (_, r) => r.latest_id === null ? <Tag>未上传</Tag> : <SubmissionTag status={r.status} verdict={r.verdict} /> },
      { title: '最终确认', width: 150, render: (_, r) => <div><ConfirmationTag status={r.status} confirmedAt={r.confirmed_at} />{r.confirmed_by && <div className="muted small">{r.confirmed_by}</div>}</div> },
      { title: '最近上传', dataIndex: 'created_at', width: 170, render: (v) => v ?? '-' },
      { title: '查看结果', width: 100, render: (_, r) => r.latest_id === null ? '-' : <Link to={`/submissions/${r.latest_id}`}>查看结果</Link> },
    ]}
  />;
}
