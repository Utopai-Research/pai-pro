import test from "node:test";
import assert from "node:assert/strict";

import { classifyTerminalStatus } from "../pai_client.js";

test("terminal client_input video failure classifies as bad_args", () => {
  const e = classifyTerminalStatus({
    status: "FAILED",
    error_category: "client_input",
    error_message: "JM raw submit HTTP 400 [InvalidParameter]: content field cannot be empty",
    raw_response: {
      error: {
        code: "InvalidParameter",
        param: "content",
        type: "BadRequest",
      },
    },
  });

  assert.equal(e.klass, "bad_args");
  assert.match(e.message, /client_input/);
  assert.match(e.message, /content field cannot be empty/);
});
