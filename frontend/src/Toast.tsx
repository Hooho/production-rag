import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

// 操作反馈统一用 Toast（AGENTS.md「前端交互约束 · 操作反馈」）：成功、失败都从这里弹出，不在页面正文或弹窗里放错误横幅。
// 用法：组件里 const toast = useToast(); toast("error", errorText(reason))。老代码通过 onToast 属性传进来的是同一个函数。
export type ToastKind = "success" | "error";
export type ShowToast = (kind: ToastKind, message: string) => void;
type ToastMessage = { id: number; kind: ToastKind; message: string };

const ToastContext = createContext<ShowToast>(() => undefined);

export function useToast() {
  return useContext(ToastContext);
}

// 把接口抛出的错误转成文字：Error 取 message，其他值转成字符串，避免显示 [object Object]。
export function errorText(reason: unknown) {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

// 成功提示短暂展示，失败提示多停留一会儿，避免用户来不及读完错误原因。最多同时显示 3 条。
export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const nextId = useRef(0);
  const dismiss = useCallback(
    (id: number) =>
      setMessages((items) => items.filter((item) => item.id !== id)),
    [],
  );
  const show = useCallback<ShowToast>(
    (kind, message) => {
      nextId.current += 1;
      const id = nextId.current;
      setMessages((items) => [...items.slice(-2), { id, kind, message }]);
      window.setTimeout(() => dismiss(id), kind === "success" ? 3200 : 5200);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="app-toast-host" aria-live="polite" aria-atomic="false">
        {messages.map((toast) => (
          <div
            className={`app-toast is-${toast.kind}`}
            role={toast.kind === "error" ? "alert" : "status"}
            key={toast.id}
          >
            <span className="app-toast-icon" aria-hidden="true">
              {toast.kind === "success" ? "✓" : "!"}
            </span>
            <span className="app-toast-message">{toast.message}</span>
            <button
              className="app-toast-close"
              type="button"
              aria-label="关闭提示"
              onClick={() => dismiss(toast.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
