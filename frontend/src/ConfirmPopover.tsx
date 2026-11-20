import {
  cloneElement,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useAnchoredBubble } from "./Popover";

// 二次确认（AGENTS.md「前端交互约束 · 二次确认」）：点按钮后在按钮旁边弹出小气泡，确认后才执行，不用 window.confirm、不挡整个页面。
// 用法：<ConfirmPopover message="……" confirmText="删除" danger onConfirm={remove}><button …>删除</button></ConfirmPopover>
// 气泡用 popover 放到最上层，在 DetailDialog 抽屉里也不会被遮住；DOM 仍在原位置，抽屉的「点外面关闭」不会误判。

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
  const cancel = useRef<HTMLButtonElement>(null);
  const { anchor, bubble, place, style } = useAnchoredBubble(
    open,
    setOpen,
    cancel,
  );

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
          className={`anchored-popover confirm-popover is-${place?.side ?? "top"}`}
          onClick={(event) => event.stopPropagation()}
          style={style}
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
              className={`${danger ? "delete-button" : "primary-button"} button-sm${busy ? " is-loading" : ""}`}
              disabled={busy}
              aria-busy={busy}
              onClick={() => void confirm()}
            >
              {confirmText}
            </button>
          </div>
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
