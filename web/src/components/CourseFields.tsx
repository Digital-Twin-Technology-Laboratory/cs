import { AutoComplete, Col, Form, Input, InputNumber, Row, Select } from 'antd';
import type { Options } from '../types';

const thisYear = new Date().getFullYear();
const gradeOptions = Array.from({ length: thisYear - 2018 + 2 }, (_, i) => thisYear + 1 - i).map((y) => ({ value: y, label: `${y}级` }));

/** 课程信息表单项：学生年级与对照方案年级分开填写，对照方案默认2025级 */
export default function CourseFields({ options }: { options: Options | null }) {
  const form = Form.useFormInstance();
  const planGrade = Form.useWatch('planGrade', form);
  return (
    <>
      <Form.Item label="课程名称" name="name" rules={[{ required: true, message: '请填写课程名称' }]}>
        <Input placeholder="如：数据库原理与设计" maxLength={100} />
      </Form.Item>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item label="专业" name="major" rules={[{ required: true, message: '请填写专业' }]} extra="请使用培养方案中的专业全称">
            <AutoComplete
              options={(options?.majors ?? []).map((m) => ({ value: m }))}
              placeholder="选择或输入专业"
              filterOption={(input, opt) => String(opt?.value ?? '').includes(input)}
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
            <Select options={gradeOptions} placeholder="授课对象所属年级" showSearch />
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
      <Form.Item
        label="对照方案调整说明"
        name="adjustNote"
        rules={[{ required: planGrade !== undefined && planGrade !== 2025, message: '对照方案年级不是2025级时，请说明原因' }]}
        extra={planGrade !== 2025 ? '对照方案年级已调整，请说明原因' : '对照方案为2025级时可不填'}
      >
        <Input.TextArea rows={2} maxLength={500} placeholder="如：该课程仅面向2024级学生开设，按2024级方案核对" />
      </Form.Item>
    </>
  );
}
