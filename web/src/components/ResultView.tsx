import { Alert, App, Button, Card, Descriptions, Empty, Space, Table, Typography } from 'antd';
import { CopyOutlined, DownloadOutlined, FileWordOutlined, PrinterOutlined } from '@ant-design/icons';
import { api, download } from '../api';
import type { CheckResult, ChecklistItem, SectionMeta, SubmissionDetail } from '../types';
import { ItemResultTag, NatureTag, SubmissionTag } from './StatusTag';

interface Props {
  sub: SubmissionDetail;
  items: ChecklistItem[];
  sections: SectionMeta;
}

function IssueCard({ n, label, issue }: { n: number; label: string; issue: CheckResult['issues'][number] }) {
  return (
    <div className="issue">
      <div className="issue-title">
        <span>
          {label}
          {n}
        </span>
        <NatureTag nature={issue.nature} />
        <span>{issue.title}</span>
      </div>
      <dl>
        <dt>所在位置</dt>
        <dd>{issue.location}</dd>
        <dt>当前问题</dt>
        <dd>{issue.problem}</dd>
        <dt>整改意见</dt>
        <dd>{issue.advice}</dd>
      </dl>
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
    message.success('修改清单已复制');
  };

  const evidenceOf = (code: string) => r.issues.filter((i) => i.itemCodes.includes(code));
  const verifyOf = (code: string) => r.toVerify.filter((v) => v.itemCodes.includes(code));

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <Space size={12} wrap>
            <SubmissionTag status={sub.status} verdict={sub.verdict} />
            <span>
              明确问题及重大问题 <b>{major.length}</b> 项，建议修改 <b>{suggest.length}</b> 项，需核实事项 <b>{r.toVerify.length}</b> 项
            </span>
          </Space>
          <Space wrap className="no-print">
            <Button type="primary" icon={<FileWordOutlined />} onClick={() => download(`/api/submissions/${sub.id}/report.docx`)}>
              下载修改清单（Word）
            </Button>
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
          <Alert style={{ marginTop: 16 }} type="success" showIcon title="检查通过" description="未发现明确问题或重大问题。如有建议修改和需核实事项，可结合实际情况完善。" />
        ) : (
          <Alert style={{ marginTop: 16 }} type="error" showIcon title="未通过" description="请按下方“明确问题及重大问题”修改后，重新上传大纲进行检查。每次上传都会独立检查。" />
        )}
        {r.summary && (
          <div className="note-box" style={{ marginTop: 12 }}>
            {r.summary}
          </div>
        )}
      </Card>

      <Card title="修改清单">
        <div className="section-title">一、明确问题及重大问题（共{major.length}项）</div>
        {major.length ? major.map((i, n) => <IssueCard key={n} n={n + 1} label="问题" issue={i} />) : <div className="muted">无。</div>}

        <div className="section-title">二、建议修改（共{suggest.length}项）</div>
        {suggest.length ? suggest.map((i, n) => <IssueCard key={n} n={n + 1} label="建议" issue={i} />) : <div className="muted">无。</div>}

        {r.toVerify.length > 0 && (
          <>
            <div className="section-title">附：需核实事项</div>
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
                scroll={{ x: 640 }}
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
