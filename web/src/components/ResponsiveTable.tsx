import { Table, type TableProps } from 'antd';

export default function ResponsiveTable<T extends object>({ columns = [], ...props }: Omit<TableProps<T>, 'scroll'>) {
  const totalWidth = columns.reduce((total, column) => total + (typeof column.width === 'number' ? column.width : 180), 0);
  return (
    <div className={`responsive-table${columns.length > 7 ? ' table-dense' : ''}`}>
      <Table<T>
        {...props}
        tableLayout="fixed"
        columns={columns.map((column) => ({
          ...column,
          width: `${(typeof column.width === 'number' ? column.width : 180) / totalWidth * 100}%`,
          fixed: undefined,
          ellipsis: false,
          onCell: (record, index) => ({
            ...column.onCell?.(record, index),
            'data-label': typeof column.title === 'string' ? column.title : '',
          }),
        }))}
      />
    </div>
  );
}
