import { formatAgentError } from "./formatAgentError";
import "./AgentError.css";

export function AgentError({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <blockquote className="ag-error-quote" role="alert">
      <strong>{title}</strong>
      <pre>{formatAgentError(message)}</pre>
    </blockquote>
  );
}
