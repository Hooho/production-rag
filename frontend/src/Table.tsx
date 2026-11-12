import { useLayoutEffect, useRef, type ComponentProps } from "react";

type TableProps = ComponentProps<"table"> & {
  containerProps?: ComponentProps<"div">;
};

/** Public table with a shared scroll container and edge hints. */
export default function Table({
  className = "",
  children,
  containerProps = {},
  ...props
}: TableProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      element.style.setProperty(
        "--table-scroll-height",
        `${element.clientHeight}px`,
      );
      const left = Math.max(0, element.scrollLeft);
      element.style.setProperty("--table-shadow-left", left > 1 ? "1" : "0");
      element.style.setProperty(
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
  }, [children]);
  return (
    <div
      {...containerProps}
      ref={ref}
      className={`table-scroll ${containerProps.className ?? ""}`}
    >
      <table {...props} className={className}>
        {children}
      </table>
    </div>
  );
}
