function nonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function candidateText(v) {
  if (typeof v === "string") return nonEmptyString(v);
  if (Array.isArray(v) && v.length > 0) {
    const joined = v
      .map((item) => candidateText(item))
      .filter(Boolean)
      .join("; ");
    return nonEmptyString(joined);
  }
  if (v && typeof v === "object") {
    if (typeof v.Code === "string" && typeof v.Message === "string") {
      return `${v.Code}: ${v.Message}`;
    }
    for (const key of ["message", "Message", "error_message", "detail"]) {
      const nested = candidateText(v[key]);
      if (nested) return nested;
    }
  }
  return null;
}

function firstFailureMessage(result) {
  return candidateText(result?.message)
    || candidateText(result?.error_message)
    || candidateText(result?.detail)
    || candidateText(result?.error)
    || candidateText(result?.provider_error)
    || candidateText(result?.raw_response?.error)
    || candidateText(result?.raw_response?.ResponseMetadata?.Error);
}

export function coerceCanvasMutationError(result) {
  if (result?.ok !== true || !result.canvas_mutation_error) return result;
  const err = result.canvas_mutation_error;
  return {
    ...result,
    ok: false,
    klass: nonEmptyString(err.klass) || "infra",
    message: candidateText(err.message) || "canvas mutation failed after provider generation",
  };
}

export function normalizeResultForRead(jobId, result) {
  if (!result || typeof result !== "object") return result;
  const normalized = coerceCanvasMutationError({
    ...result,
    job_id: nonEmptyString(result.job_id) || jobId,
  });
  if (normalized?.ok !== false) return normalized;
  const klass = nonEmptyString(normalized.klass) || "infra";
  return {
    ...normalized,
    klass,
    message:
      firstFailureMessage(normalized)
      || `Generation failed without provider error details (klass=${klass}). Inspect the result sidecar and viewer logs.`,
  };
}

export function normalizeResultForWrite(jobId, result, { completedAt = new Date().toISOString() } = {}) {
  if (!result || typeof result !== "object") return result;
  return normalizeResultForRead(jobId, {
    ...result,
    job_id: jobId,
    completed_at: result.completed_at || completedAt,
  });
}
