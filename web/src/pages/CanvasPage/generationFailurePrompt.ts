export interface GenerationFailurePromptInput {
  jobId: string
  kind: 'image' | 'video' | 'audio'
  klass?: string
  message?: string
  sent?: unknown
}

export function buildGenerationFailureAgentPrompt({
  jobId,
  kind,
  klass,
  message,
  sent,
}: GenerationFailurePromptInput): string {
  const lines = [
    'A browser-fired generation failed.',
    '',
    `Job: ${jobId}`,
    `Kind: ${kind}`,
    'Status: failed',
  ]
  if (klass) lines.push(`Class: ${klass}`)
  if (message) lines.push(`Message: ${message}`)
  const sentSummary = summarizeSent(sent)
  if (sentSummary) lines.push(`Request summary: ${sentSummary}`)
  lines.push(
    '',
    'Please inspect this result with:',
    `node "$PAI_REPO_ROOT/server/cli/list_generation_results.js" --job-id ${jobId}`,
    '',
    'Then explain the cause and stage a corrected generation if appropriate.',
  )
  return lines.join('\n')
}

function summarizeSent(sent: unknown): string | null {
  if (!sent || typeof sent !== 'object') return null
  const rec = sent as Record<string, unknown>
  const parts: string[] = []
  const refIds = rec.ref_source_ids
  if (Array.isArray(refIds) && refIds.length > 0) {
    parts.push(`ref_source_ids=${refIds.filter((v) => typeof v === 'string').join(',')}`)
  }
  for (const key of ['aspect_ratio', 'image_size', 'resolution', 'duration']) {
    const value = rec[key]
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(`${key}=${String(value)}`)
    }
  }
  return parts.length > 0 ? parts.join('; ') : null
}
