import assert from "node:assert/strict";
import { formatAgentError } from "../src/formatAgentError.ts";
const message =
  "Error code: 529 - {'type': 'error', 'error': {'type': 'overloaded_error', 'message': '当前服务繁忙'}, 'http_code': '529'}";
assert.equal(
  formatAgentError(message),
  "Error code: 529 -\n" +
    JSON.stringify(
      {
        type: "error",
        error: { type: "overloaded_error", message: "当前服务繁忙" },
        http_code: "529",
      },
      null,
      2,
    ),
);
assert.equal(
  formatAgentError('HTTP 500: {"message":"错误","retry":true}'),
  "HTTP 500:\n" + JSON.stringify({ message: "错误", retry: true }, null, 2),
);
assert.equal(
  formatAgentError("{'message': 'it\\'s busy', 'retry': True, 'detail': None}"),
  JSON.stringify({ message: "it's busy", retry: true, detail: null }, null, 2),
);
assert.equal(formatAgentError("plain failure"), "plain failure");
assert.equal(formatAgentError("invalid {payload"), "invalid {payload");
console.log("Agent error formatting checks passed.");
