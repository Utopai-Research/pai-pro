// Guard: reject prompts that NAME refs they didn't WIRE.
//
// @ImageN / @VideoN / @AudioN in a prompt are positional labels for the refs
// passed via flags (--ref-source-id for image+video sources,
// --ref-audio-source-id for audio) — "positional by flag order", per
// skills/video-compose/SKILL.md. They are NOT parsed into refs: an agent can
// write "@Image1" and forget the flag, and nothing stops the model from
// improvising the environment, the face identity, and the voice. (That is
// exactly what produced a broken clip once: the prompt named
// @Image1/@Image2/@Audio1 but passed zero flags, so none of the canvas refs
// reached the model. curl/ffprobe/AI-judges all "passed" it; only the node
// metadata + a human ear caught it.)
//
// This guard is called by every generate CLI BEFORE staging and BEFORE any
// paid call, so a single implementation covers all agents (Claude, Codex,
// future /goal runs) and manual/script CLI use.
//
// IMPORTANT — it checks MAX INDEX per kind, never mention COUNT. One ref may be
// referenced many times in a prompt: "@Image1 ... @Image1 ... @Image1" with a
// single image ref is legitimate. The invariant is that the highest ordinal
// referenced for a kind has a matching ref; repeated mentions of the same
// ordinal must pass.

// Case-sensitive — mirrors the renderer (`@image1` is not a token; it
// lowercases only AFTER matching `Image|Video|Audio`). The trailing `(?![\w])`
// is load-bearing: it stops prose from being mis-read as a ref —
// `@Image2K` (that is literally the --image-size vocabulary), `@Audio48khz`,
// `@Image1Studios` (a handle in dialogue) must NOT match. Ordinal is 1-based.
const REF_MENTION_RE = /@(Image|Video|Audio)([1-9]\d*)(?![\w])/g;

// Highest ordinal referenced per kind: { Image, Video, Audio } (0 = none).
function maxMentionedOrdinals(prompt) {
  const max = { Image: 0, Video: 0, Audio: 0 };
  for (const m of String(prompt ?? "").matchAll(REF_MENTION_RE)) {
    const n = Number(m[2]);
    if (n > max[m[1]]) max[m[1]] = n;
  }
  return max;
}

// Validate that a prompt's @-mentions have matching ref flags. Returns a
// bad_args message string on violation, or null when wired correctly.
//
//   tier "image"  — generate_image[_pro]: only --ref-source-id image refs
//     exist. @Image must be backed by a ref; @Video/@Audio are category errors
//     (no flag on this tier could ever satisfy them).
//   tier "video"  — generate_video: --ref-source-id carries image AND video
//     refs (not yet split by node type at the pre-stage guard point), and
//     --ref-audio-source-id carries audio. @Audio is checked exactly against
//     the audio count. @Image and @Video are distinct slots both drawn from
//     --ref-source-id, so the minimum source refs required is
//     (max @Image) + (max @Video), checked against the COMBINED count. This is
//     an approximation: it catches "named N, passed fewer" (the real bug) but
//     a fine image-vs-video split can slip (e.g. @Video1 with only image refs
//     and >=1 ref). Resolving per-kind here would mean hoisting an async
//     workflow.json read into the pre-stage hot path + every replay, which the
//     CLIs deliberately defer; not worth it for the rare fine case.
export function checkPromptRefsWired({ prompt, refSourceCount = 0, audioRefCount = 0, tier }) {
  const max = maxMentionedOrdinals(prompt);

  if (tier === "image") {
    if (max.Video > 0 || max.Audio > 0) {
      const bad = max.Video > 0 ? `@Video${max.Video}` : `@Audio${max.Audio}`;
      return `prompt references ${bad}, but the image tier supports only image refs (--ref-source-id). Remove the mention, or use generate_video.js for video/audio refs.`;
    }
    if (max.Image > refSourceCount) {
      return `prompt references @Image${max.Image} but only ${refSourceCount} image ref(s) passed via --ref-source-id. Pass the missing ref(s), or fix the mention. (Mentioning the same @ImageN repeatedly is fine — only the highest index needs a matching ref.)`;
    }
    return null;
  }

  if (tier === "video") {
    if (max.Audio > audioRefCount) {
      return `prompt references @Audio${max.Audio} but only ${audioRefCount} audio ref(s) passed via --ref-audio-source-id. Pass the missing ref(s), or remove the mention.`;
    }
    const sourceNeeded = max.Image + max.Video;
    if (sourceNeeded > refSourceCount) {
      const parts = [];
      if (max.Image) parts.push(`@Image${max.Image}`);
      if (max.Video) parts.push(`@Video${max.Video}`);
      return `prompt references ${parts.join(" + ")} (needs ${sourceNeeded} source ref(s)) but only ${refSourceCount} passed via --ref-source-id. Pass the missing ref(s), or fix the mention.`;
    }
    return null;
  }

  return null;
}
