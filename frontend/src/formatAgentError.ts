// SDK 错误可能把 Python 字典拼在状态码后；仅解析字面量，不执行返回内容。
export function formatAgentError(message: string): string {
  const start = message.indexOf("{");
  if (start < 0) return message;
  const prefix = message.slice(0, start).trimEnd();
  const raw = message.slice(start);
  try {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      const json = raw.replace(
        /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b(?:None|True|False)\b/g,
        (token) => {
          if (token.startsWith("'")) {
            const inner = token
              .slice(1, -1)
              .replace(/\\'|"/g, (part) => (part === "\\'" ? "'" : '\\"'));
            return JSON.stringify(JSON.parse(`"${inner}"`));
          }
          return (
            (
              { None: "null", True: "true", False: "false" } as Record<
                string,
                string
              >
            )[token] ?? token
          );
        },
      );
      value = JSON.parse(json);
    }
    return [prefix, JSON.stringify(value, null, 2)].filter(Boolean).join("\n");
  } catch {
    return message;
  }
}
