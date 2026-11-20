import {
  cloneElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";

// 跟随按钮的小气泡（AGENTS.md「前端交互约束 · 弹窗」第三层）：放到最上层（popover），在按钮上方或下方，带箭头指向按钮。
// 点气泡外面或按 Esc 关闭；同一时间只开一个（二次确认气泡也算）。DOM 留在按钮旁边，所以在 DetailDialog 浮窗里点气泡不会把浮窗关掉。
const GAP = 10;
const EDGE = 8;
const OPEN_EVENT = "anchored-popover-open";

type Place = {
  top: number;
  left: number;
  side: "top" | "bottom";
  arrow: number;
};

export function useAnchoredBubble(
  open: boolean,
  setOpen: (value: boolean) => void,
  focus?: RefObject<HTMLElement | null>,
) {
  const [place, setPlace] = useState<Place | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  function position() {
    const target = anchor.current;
    const element = bubble.current;
    if (!target || !element) return;
    const rect = target.getBoundingClientRect();
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const side = rect.top - height - GAP >= EDGE ? "top" : "bottom";
    const center = rect.left + rect.width / 2;
    const left = Math.max(
      EDGE,
      Math.min(center - width / 2, window.innerWidth - width - EDGE),
    );
    setPlace({
      top: side === "top" ? rect.top - height - GAP : rect.bottom + GAP,
      left,
      side,
      arrow: Math.max(12, Math.min(center - left, width - 12)),
    });
  }

  useLayoutEffect(() => {
    const element = bubble.current;
    if (!open || !element) return;
    if (!element.matches(":popover-open")) element.showPopover();
    position();
    focus?.current?.focus();
    function outside(event: PointerEvent) {
      const path = event.composedPath();
      if (
        !path.includes(element!) &&
        !(anchor.current && path.includes(anchor.current))
      )
        setOpen(false);
    }
    // Esc 只关气泡，不让外层抽屉、浮窗跟着关。
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      anchor.current?.focus();
    }
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      if (element.matches(":popover-open")) element.hidePopover();
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 同一时间只开一个：别的气泡打开时关掉自己。
  useEffect(() => {
    if (!open) return;
    const self = bubble.current;
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: self }));
    function other(event: Event) {
      if ((event as CustomEvent).detail !== self) setOpen(false);
    }
    document.addEventListener(OPEN_EVENT, other);
    return () => document.removeEventListener(OPEN_EVENT, other);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const style = place
    ? { top: place.top, left: place.left, visibility: "visible" as const }
    : { visibility: "hidden" as const };
  return { anchor, bubble, place, style };
}

// 点按钮在旁边显示一段内容（例如浮窗里卡片的「原文」）。只读内容用它；要确认的操作用 ConfirmPopover。
export function InfoPopover({
  title,
  children,
  content,
}: {
  title?: ReactNode;
  // 气泡里的内容，打开时才渲染。
  content: () => ReactNode;
  children: ReactElement<{
    onClick?: (event: MouseEvent<HTMLElement>) => void;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const { anchor, bubble, place, style } = useAnchoredBubble(open, setOpen);
  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      anchor.current = node;
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setOpen(!open);
    },
    "aria-haspopup": "dialog",
    "aria-expanded": open,
  } as never);
  return (
    <>
      {trigger}
      {open && (
        <div
          ref={bubble}
          popover="manual"
          role="dialog"
          aria-modal="false"
          className={`anchored-popover info-popover is-${place?.side ?? "top"}`}
          onClick={(event) => event.stopPropagation()}
          style={style}
        >
          <div className="info-popover-head">
            {title && <strong>{title}</strong>}
            <button
              type="button"
              className="link-button button-sm"
              onClick={() => setOpen(false)}
            >
              关闭
            </button>
          </div>
          <div className="info-popover-body">{content()}</div>
          <span
            className="anchored-popover-arrow"
            style={{ left: place?.arrow ?? 0 }}
            aria-hidden="true"
          />
        </div>
      )}
    </>
  );
}
