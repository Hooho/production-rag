import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./DetailDialog.css";

const dialogTriggers = new WeakMap<HTMLDialogElement, HTMLElement>();

// 从弹窗内打开详情时，以点击入口为锚点，在其左侧显示固定宽度的浮窗。
export function DetailDialog({ open, title, onClose, children, className = "" }: { open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [host, setHost] = useState<HTMLDialogElement | null>(null);
  const instance = useRef(Symbol("companion"));
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;
  function close() {
    if (host) {
      dialog.current?.hidePopover();
      closeHandler.current();
    } else dialog.current?.close();
  }
  const [connector, setConnector] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element || !open) {
      if (element?.matches(":popover-open")) element.hidePopover();
      if (element?.open) element.close();
      return;
    }
    const parent = host ?? Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).filter((item) => item !== element).at(-1);
    const trigger = parent ? dialogTriggers.get(parent) : null;
    const companion = parent && trigger ? parent : null;
    if (companion && host !== companion) {
      setHost(companion);
      return;
    }
    if (companion) {
      element.classList.add("ag-dialog-companion");
      trigger?.classList.add("ag-dialog-anchor");
    }
    if (companion) {
      element.showPopover();
      document.dispatchEvent(new CustomEvent("detail-companion-open", { detail: instance.current }));
    } else if (!element.open) element.showModal();
    function dismissOther(event: Event) {
      if ((event as CustomEvent).detail !== instance.current) closeHandler.current();
    }
    function dismiss() { closeHandler.current(); }
    function outsidePointer(event: PointerEvent) {
      if (!event.composedPath().includes(element!)) closeHandler.current();
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeHandler.current();
      }
    }
    if (companion) {
      document.addEventListener("detail-companion-open", dismissOther);
      document.addEventListener("keydown", escape, true);
      document.addEventListener("pointerdown", outsidePointer, true);
      companion.addEventListener("close", dismiss);
    }
    function updateConnector() {
      if (!companion || !trigger || !element) return;
      const anchor = trigger.getBoundingClientRect();
      const container = companion.getBoundingClientRect();
      element.style.setProperty("--companion-max-height", `${Math.min(container.height * 0.8, window.innerHeight - 32)}px`);
      const { width, height } = element.getBoundingClientRect();
      const left = Math.max(16, Math.min(anchor.left - width - 16, window.innerWidth - width - 16));
      element.style.left = `${left}px`;
      const center = anchor.top + anchor.height / 2;
      const top = Math.max(16, Math.min(center - height / 2, window.innerHeight - height - 16));
      element.style.top = `${top}px`;
      const panel = element.getBoundingClientRect();
      const y = Math.max(panel.top + 20, Math.min(center, panel.bottom - 20));
      setConnector(anchor.bottom > container.top && anchor.top < container.bottom && panel.right < anchor.left
        ? { x: panel.right - 1, y: y - 10 } : null);
    }
    updateConnector();
    const observer = new ResizeObserver(updateConnector);
    observer.observe(element);
    if (companion) observer.observe(companion);
    window.addEventListener("resize", updateConnector);
    companion?.addEventListener("scroll", updateConnector, true);
    return () => {
      observer.disconnect();
      element.style.removeProperty("top");
      element.style.removeProperty("left");
      element.style.removeProperty("--companion-max-height");
      window.removeEventListener("resize", updateConnector);
      companion?.removeEventListener("scroll", updateConnector, true);
      if (companion) {
        document.removeEventListener("detail-companion-open", dismissOther);
        document.removeEventListener("keydown", escape, true);
        document.removeEventListener("pointerdown", outsidePointer, true);
        companion.removeEventListener("close", dismiss);
        if (element.matches(":popover-open")) element.hidePopover();
      }
      element.classList.remove("ag-dialog-companion");
      trigger?.classList.remove("ag-dialog-anchor");
      setConnector(null);
    };
  }, [open, host, title]);
  const content = <dialog popover={host ? "manual" : undefined} ref={dialog} onClickCapture={(event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button, a, summary") : null;
    if (target && target.closest("dialog") === event.currentTarget) dialogTriggers.set(event.currentTarget, target);
  }} className={`ag-delivery-dialog ${className}`} aria-label={title} onClose={(event) => { event.stopPropagation(); onClose(); }}
    onClick={(event) => { if (!host && event.target === event.currentTarget) close(); }}>
    {connector && <svg className="ag-dialog-connector" style={{ left: connector.x, top: connector.y }} viewBox="0 0 12 20" aria-hidden="true">
      <path d="M0 0 L11 10 L0 20" fill="white" stroke="#d9e5dc" strokeWidth="1.5" />
    </svg>}
    <div className="ag-delivery-dialog-head"><strong>{title}</strong>
      <button type="button" className="secondary-button" autoFocus onClick={close}>关闭</button></div>
    {children}
  </dialog>;
  return host ? createPortal(content, host) : content;
}

