import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

const FocusContext = createContext<{
  focused: boolean;
  toggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
} | null>(null);

export function GraphFocusButton() {
  const focus = useContext(FocusContext);
  if (!focus) return null;
  return (
    <button
      ref={focus.buttonRef}
      type="button"
      className="secondary-button"
      aria-pressed={focus.focused}
      title={
        focus.focused ? "恢复普通布局（也可按 Esc）" : "铺满窗口，专注查看图谱"
      }
      onClick={focus.toggle}
    >
      {focus.focused ? "解除专注模式" : "图专注模式"}
    </button>
  );
}

// Both graph pages keep the same controls and canvas mounted while focusing.
export function GraphWorkspace({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = workspace.current;
    if (!host || focused || !enabled) return;
    let pinned: HTMLElement | null = null;
    let offset = 0;
    function update() {
      const body = host!.querySelector<HTMLElement>(".graph-workspace-body");
      if (
        !body ||
        !body.querySelector(".graph-view") ||
        window.innerWidth <= 1100
      ) {
        release();
        return;
      }
      if (!pinned)
        offset =
          body.getBoundingClientRect().top - host!.getBoundingClientRect().top;
      const rect = host!.getBoundingClientRect();
      if (rect.top + offset <= 12) {
        pinned = body;
        host!.style.paddingBottom = `${body.getBoundingClientRect().height}px`;
        Object.assign(body.style, {
          position: "fixed",
          top: "12px",
          left: `${rect.left}px`,
          width: `${rect.width}px`,
          zIndex: "10",
        });
      } else release();
    }
    function release() {
      if (pinned) {
        for (const key of ["position", "top", "left", "width", "z-index"])
          pinned.style.removeProperty(key);
        pinned = null;
      }
      host!.style.removeProperty("padding-bottom");
    }
    const observer = new MutationObserver(update);
    observer.observe(host, { childList: true, subtree: true });
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      release();
    };
  }, [enabled, focused]);
  useEffect(() => {
    if (!enabled) setFocused(false);
  }, [enabled]);
  useEffect(() => {
    if (!focused) return;
    const locked: [HTMLElement, string][] = [];
    for (
      let parent = workspace.current?.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      if (
        parent === document.body ||
        /auto|scroll/.test(getComputedStyle(parent).overflowY)
      ) {
        locked.push([parent, parent.style.overflow]);
        parent.style.overflow = "hidden";
      }
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
        setFocused(false);
        toggle.current?.focus();
      }
    }
    document.addEventListener("keydown", escape);
    return () => {
      for (const [element, overflow] of locked)
        element.style.overflow = overflow;
      document.removeEventListener("keydown", escape);
    };
  }, [focused]);
  return (
    <FocusContext.Provider
      value={
        enabled
          ? {
              focused,
              toggle: () => setFocused((value) => !value),
              buttonRef: toggle,
            }
          : null
      }
    >
      <div
        ref={workspace}
        className={`graph-workspace${focused ? " is-focused" : ""}`}
      >
        {children}
      </div>
    </FocusContext.Provider>
  );
}
