// Deprecated compatibility shim.
//
// Browser-fired generation result delivery no longer types a synthetic
// task turn into the live Claude/Codex PTY. Use
// continuation_events.js + generation_continuations.js for the durable,
// non-chat continuation path.

export {
  AGENT_RESULT_CONSUMER_HEADER,
  WAITING_CLI_RESULT_CONSUMER,
} from "./continuation_events.js";

export function configureAgentResultNotifications() {}

export async function enqueueGenerationResultNotification() {
  return { ok: false, reason: "retired" };
}

export async function readAgentResultNotifications() {
  return [];
}

export function formatGenerationResultNotification() {
  return "";
}

export function flushProjectNotifications() {
  return Promise.resolve({ ok: false, reason: "retired" });
}

export function scheduleFlush() {
  return false;
}

export function resetAgentResultNotificationStateForTests() {}
