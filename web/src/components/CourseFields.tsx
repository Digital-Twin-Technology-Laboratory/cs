import { Col, Form, Input, InputNumber, Row, Select } from 'antd';
import type { Options } from '../types';

const thisYear = new Date().getFullYear();

/** 课程信息表单项：学生年级与对照方案年级分开填写，对照方案默认2025级 */
export default function CourseFields({ options }: { options: Options | null }) {
  return (
    <>
      <Form.Item label="课程名称" name="name" rules={[{ required: true, message: '请填写课程名称' }]}>
        <Input placeholder="如：数据库原理与设计" maxLength={100} />
      </Form.Item>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item label="专业" name="major" rules={[{ required: true, message: '请选择专业' }]}>
            <Select
              options={(options?.majors ?? []).map((m) => ({ value: m, label: m }))}
              placeholder="请选择专业"
            />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label="培养类型" name="trainingType" rules={[{ required: true, message: '请选择培养类型' }]}>
            <Select options={(options?.trainingTypes ?? []).map((t) => ({ value: t, label: t }))} placeholder="请选择" />
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item label="学生年级" name="studentGrade" rules={[{ required: true, message: '请选择学生年级' }]}>
            <Select options={(options?.studentGrades ?? []).map((y) => ({ value: y, label: `${String(y).slice(-2)}级` }))} placeholder="请选择年级" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            label="对照方案年级"
            name="planGrade"
            rules={[{ required: true, message: '请填写对照方案年级' }]}
            extra="本轮统一以2025级人才培养方案为对照起点"
          >
            <InputNumber min={2000} max={thisYear + 5} suffix="级" style={{ width: '100%' }} />
          </Form.Item>
        </Col>
      </Row>
    </>
  );
}
