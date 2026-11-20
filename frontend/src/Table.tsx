import {
  Children,
  isValidElement,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type ComponentProps,
} from "react";

import { LoadingSkeleton, SkeletonBlock } from "./LoadingSkeleton";

export type TablePaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
};

export function TablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  disabled = false,
}: TablePaginationProps) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  return (
    <nav className="table-pagination" aria-label="表格分页">
      <span>
        共 {total} 条 · 第 {page} / {pages} 页
      </span>
      <button
        type="button"
        className="secondary-button button-sm"
        disabled={disabled || page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        上一页
      </button>
      <button
        type="button"
        className="secondary-button button-sm"
        disabled={disabled || page >= pages}
        onClick={() => onPageChange(page + 1)}
      >
        下一页
      </button>
    </nav>
  );
}

export type TableProps = ComponentProps<"table"> & {
  scrollable?: boolean;
  scrollShadow?: boolean;
  stickyHeader?: boolean;
  maxHeight?: CSSProperties["maxHeight"];
  size?: "default" | "compact";
  bordered?: boolean;
  hoverable?: boolean;
  loading?: boolean;
  skeletonRows?: number;
  columnCount?: number;
  empty?: boolean;
  emptyContent?: ReactNode;
  pagination?: TablePaginationProps;
  containerProps?: ComponentProps<"div">;
};

/** Public table with a shared scroll container and edge hints. */
export default function Table({
  className = "",
  children,
  containerProps = {},
  scrollable = true,
  scrollShadow = true,
  stickyHeader = false,
  maxHeight,
  size = "default",
  bordered = true,
  hoverable = true,
  loading = false,
  skeletonRows = 5,
  columnCount = 1,
  empty = false,
  emptyContent = "暂无数据",
  pagination,
  ...props
}: TableProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const left = Math.max(0, element.scrollLeft);
      element.parentElement?.style.setProperty(
        "--table-shadow-left",
        left > 1 ? "1" : "0",
      );
      element.parentElement?.style.setProperty(
        "--table-shadow-right",
        element.scrollWidth - element.clientWidth - left > 1 ? "1" : "0",
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    element.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, [children, loading, empty, skeletonRows, columnCount]);
  const body = loading ? (
    <tbody>
      {Array.from({ length: skeletonRows }, (_, row) => (
        <tr key={row} aria-hidden="true">
          {Array.from({ length: columnCount }, (_, column) => (
            <td key={column}>
              <LoadingSkeleton>
                <SkeletonBlock
                  style={{
                    display: "block",
                    height: 16,
                    width: `${[76, 92, 64][(row + column) % 3]}%`,
                    margin: "4px 0",
                  }}
                />
              </LoadingSkeleton>
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  ) : empty ? (
    <tbody>
      <tr>
        <td colSpan={columnCount}>{emptyContent}</td>
      </tr>
    </tbody>
  ) : null;
  return (
    <>
      <div className="table-frame" data-shadow={scrollable && scrollShadow}>
        <div
          {...containerProps}
          ref={ref}
          style={{
            ...containerProps.style,
            maxHeight: maxHeight ?? containerProps.style?.maxHeight,
            overflowX: scrollable ? "auto" : "visible",
            overflowY: maxHeight ? "auto" : undefined,
          }}
          className={`table-scroll ${containerProps.className ?? ""}`}
        >
          <table
            {...props}
            aria-busy={loading || undefined}
            aria-label={
              props["aria-label"] ?? (loading ? "正在加载表格" : undefined)
            }
            className={`shared-table shared-table-${size} ${stickyHeader ? "shared-table-sticky" : ""} ${bordered ? "shared-table-bordered" : ""} ${hoverable ? "shared-table-hover" : ""} ${className}`}
          >
            {body
              ? Children.map(children, (child) =>
                  isValidElement(child) && child.type === "tbody"
                    ? null
                    : child,
                )
              : children}
            {body}
          </table>
        </div>
      </div>
      {pagination && (
        <TablePagination
          {...pagination}
          disabled={loading || pagination.disabled}
        />
      )}
    </>
  );
}
