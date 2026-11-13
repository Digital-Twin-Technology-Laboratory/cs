import { Alert, App, Button, Card, Descriptions, Empty, Space, Typography } from 'antd';
import Table from './ResponsiveTable';
import { CopyOutlined, DownloadOutlined, FileWordOutlined, PrinterOutlined } from '@ant-design/icons';
import { api, download } from '../api';
import type { CheckResult, ChecklistItem, SectionMeta, SubmissionDetail } from '../types';
import { ItemResultTag, NatureTag, SubmissionTag } from './StatusTag';
import { AI_RESULT_NOTICE, MATERIALS_REMINDER } from '../checkNotices';

interface Props {
  sub: SubmissionDetail;
  items: ChecklistItem[];
  sections: SectionMeta;
}

function IssueCard({ n, label, issue }: { n: number; label: string; issue: CheckResult['issues'][number] }) {
  return (
    <div className="issue">
      <h3 className="issue-title">{label}{String(n).padStart(2, '0')} {issue.title}</h3>
      <p className="issue-location"><b>位置：</b>{issue.location}</p>
      <p><b>问题：</b>{issue.problem}</p>
      <p className="issue-advice"><b>整改意见：</b>{issue.advice}</p>
    </div>
  );
}

export function SubmissionMeta({ sub }: { sub: SubmissionDetail }) {
  const c = sub.course;
  const plan = sub.plan_name || `${c.planGrade}级${c.major}（${c.trainingType}）人才培养方案（未预置）`;
  return (
    <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} bordered>
      <Descriptions.Item label="课程名称">{c.name}</Descriptions.Item>
      <Descriptions.Item label="专业">{c.major}</Descriptions.Item>
      <Descriptions.Item label="培养类型">{c.trainingType}</Descriptions.Item>
      <Descriptions.Item label="学生年级">{c.studentGrade}级</Descriptions.Item>
      <Descriptions.Item label="对照方案" span={2}>
        {plan}
        {c.adjustNote && <div className="muted small">调整说明：{c.adjustNote}</div>}
      </Descriptions.Item>
      <Descriptions.Item label="上传文件">{sub.file_name}</Descriptions.Item>
      <Descriptions.Item label="检查次数">第{sub.seq}次</Descriptions.Item>
      <Descriptions.Item label="提交时间">{sub.created_at}</Descriptions.Item>
    </Descriptions>
  );
}

export default function ResultView({ sub, items, sections }: Props) {
  const { message } = App.useApp();
  const r = sub.result!;
  const major = r.issues.filter((i) => i.nature !== '建议修改');
  const suggest = r.issues.filter((i) => i.nature === '建议修改');
  const itemMap = new Map(items.map((i) => [i.code, i]));
  const verdictEditNote = sub.verdict_edited_at ? `检查结论由${sub.verdict_edited_by}于${sub.verdict_edited_at}手工修改；以下保留原 AI 检查意见。` : '';

  const copy = async () => {
    const { text } = await api.get<{ text: string }>(`/api/submissions/${sub.id}/report.txt`);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 非安全上下文（局域网 http）下的降级复制
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    message.success('检查结果已复制');
  };

  const evidenceOf = (code: string) => r.issues.filter((i) => i.itemCodes.includes(code));
  const verifyOf = (code: string) => r.toVerify.filter((v) => v.itemCodes.includes(code));

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Alert className="no-print" type="info" showIcon title="AI 检查结果使用提示" description={AI_RESULT_NOTICE} />
      <Card className="result-download no-print">
        <div className="result-download-head">
          <div>
            <h2>检查结果</h2>
            <p>在这里下载完整检查结果，Word 文件可直接保存、编辑或打印。</p>
          </div>
          <Button size="large" type="primary" icon={<FileWordOutlined />} onClick={() => download(`/api/submissions/${sub.id}/report.docx`)}>
            下载检查结果（Word）
          </Button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <Space size={12} wrap>
            <SubmissionTag status={sub.status} verdict={sub.verdict} />
            <span>
              明确问题及重大问题 <b>{major.length}</b> 项，建议修改 <b>{suggest.length}</b> 项，需核实事项 <b>{r.toVerify.length}</b> 项
            </span>
          </Space>
          <Space wrap className="no-print">
            <Button icon={<CopyOutlined />} onClick={copy}>
              复制文本
            </Button>
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
              打印
            </Button>
            <Button icon={<DownloadOutlined />} onClick={() => download(`/api/submissions/${sub.id}/file`)}>
              原文件
            </Button>
          </Space>
        </div>
        {sub.verdict === 'passed' ? (
          <Alert style={{ marginTop: 16 }} type="success" showIcon title="检查通过" description={verdictEditNote || '未发现明确问题或重大问题。如有建议修改和需核实事项，可结合实际情况完善。'} />
        ) : (
          <Alert style={{ marginTop: 16 }} type="error" showIcon title="未通过" description={verdictEditNote || '请按下方“明确问题及重大问题”修改后，重新上传大纲进行检查。每次上传都会独立检查。'} />
        )}
        {r.summary && (
          <div className="note-box" style={{ marginTop: 12 }}>
            {r.summary}
          </div>
        )}
      </Card>

      <Card className="report-paper">
        <h2 className="report-title">《{sub.course.name}》教学大纲检查结果</h2>
        <p><b>使用提示：</b>{AI_RESULT_NOTICE}</p>
        <p className="report-scope">检查对象：{sub.course.studentGrade}级《{sub.course.name}》教学大纲。对照方案：{sub.plan_name || `${sub.course.planGrade}级${sub.course.major}（${sub.course.trainingType}）人才培养方案（未预置，相关内容需核实）`}。</p>
        <p className="report-meta">专业：{sub.course.major}　培养类型：{sub.course.trainingType}　检查次数：第{sub.seq}次　检查时间：{sub.finished_at}</p>
        {sub.course.adjustNote && <p className="report-meta">对照方案调整说明：{sub.course.adjustNote}</p>}
        <p className="report-meta"><b>检查结论：</b>{sub.verdict === 'passed' ? '检查通过' : '未通过，需修改后重新提交'}</p>
        {verdictEditNote && <p className="report-meta">{verdictEditNote}</p>}
        <h3 className="report-section">一 明确问题及重大问题</h3>
        {major.length ? major.map((i, n) => <IssueCard key={n} n={n + 1} label="A" issue={i} />) : <p>无。</p>}

        <h3 className="report-section">二 建议完善项</h3>
        <p><b>相关材料一致性提醒：</b>{MATERIALS_REMINDER}</p>
        {suggest.length ? suggest.map((i, n) => <IssueCard key={n} n={n + 1} label="B" issue={i} />) : <p>无其他建议修改项。</p>}

        {r.toVerify.length > 0 && (
          <>
            <h3 className="report-section">附 需核实事项</h3>
            <div className="muted small" style={{ marginBottom: 8 }}>
              以下事项仅凭本次提交的大纲无法确认，不属于已确认问题，请结合相关材料核实。
            </div>
            <ol style={{ paddingLeft: 20, margin: 0, lineHeight: 1.9 }}>
              {r.toVerify.map((v, n) => (
                <li key={n}>
                  {v.location && <b>{v.location}：</b>}
                  {v.content}
                </li>
              ))}
            </ol>
          </>
        )}
        <div className="muted small" style={{ marginTop: 20 }}>
          注：问题编号仅用于识别和引用，不代表整改顺序。本结果由 AI 依据检查清单生成，供修改参考。
        </div>
      </Card>

      <Card title="逐项检查结果" className="no-print" extra={<span className="muted small">供检查人核对，含 AI 判断理由和原文依据</span>}>
        {(['main', 'matrix', 'suggest'] as const).map((sec) => {
          const rows = r.itemResults.filter((it) => itemMap.get(it.code)?.section === sec);
          if (!rows.length) return null;
          return (
            <div key={sec} style={{ marginBottom: 16 }}>
              <Typography.Text strong>{sections[sec].title}</Typography.Text>
              <Table
                style={{ marginTop: 8 }}
                size="small"
                rowKey="code"
                pagination={false}
                dataSource={rows}
                expandable={{
                  rowExpandable: (row) => evidenceOf(row.code).length + verifyOf(row.code).length > 0,
                  expandedRowRender: (row) => (
                    <div className="small" style={{ lineHeight: 1.8 }}>
                      {evidenceOf(row.code).map((i, k) => (
                        <div key={k} style={{ marginBottom: 6 }}>
                          <NatureTag nature={i.nature} /> {i.title}
                          {i.evidence && <div className="note-box" style={{ marginTop: 4 }}>原文依据：{i.evidence}</div>}
                        </div>
                      ))}
                      {verifyOf(row.code).map((v, k) => (
                        <div key={`v${k}`}>
                          <ItemResultTag result="需核实" /> {v.location ? `${v.location}：` : ''}
                          {v.content}
                        </div>
                      ))}
                    </div>
                  ),
                }}
                columns={[
                  { title: '编号', dataIndex: 'code', width: 70, render: (v) => <span className="code-cell">{v}</span> },
                  { title: '检查项目', width: 170, render: (_, row) => itemMap.get(row.code)?.title },
                  { title: '结果', dataIndex: 'result', width: 110, render: (v) => <ItemResultTag result={v} /> },
                  { title: '说明', dataIndex: 'note' },
                ]}
              />
            </div>
          );
        })}
        {!r.itemResults.length && <Empty />}
        <div className="muted small">检查模型：{sub.ai_model || '—'}　完成时间：{sub.finished_at || '—'}</div>
      </Card>
    </Space>
  );
}
