import * as React from 'react';
import { cn } from '@/lib/utils';
import { EmptyState } from './empty-state';
import { Skeleton } from './skeleton';

export interface Column<T> {
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Right-align numeric columns so digits line up. */
  align?: 'left' | 'right';
  width?: string;
  /** Hidden below the md breakpoint, for columns that are useful but not essential. */
  secondary?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  /** Rows to draw while loading, so the layout does not jump. */
  skeletonRows?: number;
  className?: string;
  caption?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  onRowClick,
  empty,
  skeletonRows = 6,
  className,
  caption,
}: DataTableProps<T>) {
  if (!loading && rows.length === 0) {
    return <>{empty ?? <EmptyState title="Nothing to show" />}</>;
  }

  return (
    <div className={cn('scrollbar-thin overflow-x-auto', className)}>
      <table className="w-full border-collapse text-chrome">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-zinc-950/[0.07] dark:border-white/[0.07]">
            {columns.map((col) => (
              <th
                key={col.id}
                scope="col"
                style={col.width ? { width: col.width } : undefined}
                className={cn(
                  'px-3 py-2 text-[12px] font-medium text-zinc-500 dark:text-zinc-400',
                  col.align === 'right' ? 'text-right' : 'text-left',
                  col.secondary && 'hidden md:table-cell',
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: skeletonRows }, (_, i) => (
                <tr key={i} className="border-b border-zinc-950/[0.05] dark:border-white/[0.05]">
                  {columns.map((col) => (
                    <td
                      key={col.id}
                      className={cn('px-3 py-2.5', col.secondary && 'hidden md:table-cell')}
                    >
                      <Skeleton className="h-3.5 w-full max-w-[10rem]" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    'border-b border-zinc-950/[0.05] last:border-0 dark:border-white/[0.05]',
                    onRowClick &&
                      'cursor-pointer transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/70 dark:hover:bg-white/[0.03]',
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.id}
                      className={cn(
                        'px-3 py-2.5 text-zinc-700 dark:text-zinc-300',
                        col.align === 'right' && 'text-right tabular',
                        col.secondary && 'hidden md:table-cell',
                      )}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
