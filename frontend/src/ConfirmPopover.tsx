import {
  cloneElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

// 二次确认（AGENTS.md「前端交互约束 · 二次确认」）：点按钮后在按钮旁边弹出小气泡，确认后才执行，不用 window.confirm、不挡整个页面。
// 用法：<ConfirmPopover message="……" confirmText="删除" danger onConfirm={remove}><button …>删除</button></ConfirmPopover>
// 气泡用 popover 放到最上层，在 DetailDialog 抽屉里也不会被遮住；DOM 仍在原位置，抽屉的「点外面关闭」不会误判。
const GAP = 10;
const EDGE = 8;

export function ConfirmPopover({
  message,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  disabled = false,
  when = true,
  onConfirm,
  children,
}: {
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  disabled?: boolean;
  // false 时不弹气泡，直接执行（例如没有可丢失的内容时不必确认）。
  when?: boolean;
  onConfirm: () => unknown;
  children: ReactElement<{
    onClick?: (event: MouseEvent<HTMLElement>) => void;
    disabled?: boolean;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [place, setPlace] = useState<{
    top: number;
    left: number;
    side: "top" | "bottom";
    arrow: number;
  } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

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
    cancel.current?.focus();
    function outside(event: PointerEvent) {
      const path = event.composedPath();
      if (
        !path.includes(element!) &&
        !(anchor.current && path.includes(anchor.current))
      )
        setOpen(false);
    }
    // Esc 只关气泡，不让外层抽屉跟着关。
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      anchor.current?.focus();
    }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      if (element.matches(":popover-open")) element.hidePopover();
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 同一时间只开一个：别的气泡打开时关掉自己。
  useEffect(() => {
    if (!open) return;
    const self = bubble.current;
    document.dispatchEvent(
      new CustomEvent("confirm-popover-open", { detail: self }),
    );
    function other(event: Event) {
      if ((event as CustomEvent).detail !== self) setOpen(false);
    }
    document.addEventListener("confirm-popover-open", other);
    return () => document.removeEventListener("confirm-popover-open", other);
  }, [open]);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      anchor.current = node;
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      // 按钮常在可点击的行里（点行会展开 / 跳转），这里不往外冒泡。
      event.stopPropagation();
      if (disabled || children.props.disabled) return;
      if (!when) void onConfirm();
      else setOpen((value) => !value);
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
          role="alertdialog"
          aria-modal="false"
          className={`confirm-popover is-${place?.side ?? "top"}`}
          onClick={(event) => event.stopPropagation()}
          style={
            place
              ? { top: place.top, left: place.left, visibility: "visible" }
              : { visibility: "hidden" }
          }
        >
          <p className="confirm-popover-message">
            <span
              className={`confirm-popover-icon ${danger ? "is-danger" : ""}`}
            >
              !
            </span>
            <span>{message}</span>
          </p>
          <div className="confirm-popover-actions">
            <button
              ref={cancel}
              type="button"
              className="secondary-button button-sm"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {cancelText}
            </button>
            <button
              type="button"
              className={`${danger ? "delete-button" : "primary-button"} button-sm`}
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? "处理中…" : confirmText}
            </button>
          </div>
          <span
            className="confirm-popover-arrow"
            style={{ left: place?.arrow ?? 0 }}
            aria-hidden="true"
          />
        </div>
      )}
    </>
  );
}
