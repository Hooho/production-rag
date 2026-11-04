import { useEffect, useRef, useState, type ReactNode } from "react";

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
    <div
      ref={workspace}
      className={`graph-workspace${focused ? " is-focused" : ""}`}
    >
      {enabled && (
        <div className="graph-workspace-heading">
          <button
            ref={toggle}
            type="button"
            className="secondary-button"
            aria-pressed={focused}
            title={
              focused ? "恢复普通布局（也可按 Esc）" : "铺满窗口，专注查看图谱"
            }
            onClick={() => setFocused((value) => !value)}
          >
            {focused ? "解除专注模式" : "图专注模式"}
          </button>
        </div>
      )}
      {children}
    </div>
  );
}
