import { Empty, Spin } from 'antd';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import ChecklistView from '../../components/ChecklistView';
import type { Checklist, SectionMeta } from '../../types';

export default function ChecklistPage() {
  const [data, setData] = useState<{ checklist: Checklist | null; sections: SectionMeta } | null>(null);
  useEffect(() => {
    api.get<typeof data>('/api/checklist').then(setData);
  }, []);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>检查清单</h1>
          <div className="sub">{data?.checklist?.name ?? '当前生效的教学大纲检查清单'}　AI 检查严格按本清单进行</div>
        </div>
      </div>
      {!data ? <Spin /> : data.checklist ? <ChecklistView checklist={data.checklist} sections={data.sections} /> : <Empty description="管理员尚未设置检查清单" />}
    </div>
  );
}
