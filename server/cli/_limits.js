// Provider hard caps surfaced in CLI failure JSON (`limits` field).
// Agents compare against `sent` to recover.

import {
  IMAGE_PRO_MAX_IMAGE_REFS,
  IMAGE_PRO_SUPPORTED_SIZES,
} from "../image_pro_sizes.js";
import { VIDEO_25_MAX_BILLED_SEC, VIDEO_25_MODEL_ID } from "../model_registry.js";

// Output duration bounds (seconds), per model id — floor as well as cap now.
// 2.5's floor is 5, not the 4 the 2.0 route allows: the vendor documents no
// range at all for the field, and 5..30 is the range that was settled on
// deliberately (5 because nothing public offers less, 30 because a longer
// request is most likely truncated in silence). NOT the dispatcher's
// 4..15: those
// constants belong to a different task type on the provider side.
export const VIDEO_OUTPUT_DURATION_MIN_SEC = 4;
export const VIDEO_OUTPUT_DURATION_MIN_SEC_BY_MODEL = {
  "video-generation": 4,
  [VIDEO_25_MODEL_ID]: 5,
};
export const VIDEO_OUTPUT_DURATION_MAX_SEC_BY_MODEL = {
  "video-generation": 15,
  [VIDEO_25_MODEL_ID]: 30,
};

// Unknown model ids fall back to the most restrictive cap. The FLOOR stays at
// the global 4 rather than the highest per-model minimum: an unknown id here
// is a stale sidecar, and raising its floor would reject a duration that was
// legal when it was staged. Too low a floor costs nobody anything; too high a
// ceiling costs a paid render.
export function videoOutputDurationBounds(modelId) {
  const caps = Object.values(VIDEO_OUTPUT_DURATION_MAX_SEC_BY_MODEL);
  const max = VIDEO_OUTPUT_DURATION_MAX_SEC_BY_MODEL[modelId] ?? Math.min(...caps);
  const min = VIDEO_OUTPUT_DURATION_MIN_SEC_BY_MODEL[modelId] ?? VIDEO_OUTPUT_DURATION_MIN_SEC;
  return { min, max };
}

export const VIDEO_LIMITS = {
  // video-generation. Duration caps are asymmetric across audio / video:
  //  - Each audio / video ref must be 1.8s-15.2s per file (the asset-upload
  //    step rejects with DurationTooLong / DurationTooShort if outside).
  //  - Audio refs: NO aggregate cap (verified: 3 audios totaling 37.84s succeed).
  //  - Video refs: aggregate <=15s total (verified: 3 videos totaling 35.41s
  //    fail at gen with `bad_args` "invalid video duration, exceeds 15s").
  //  - Audio refs also require a visual anchor — `bad_args`
  //    "reference_audio cannot be the only reference input" otherwise.
  max_image_refs: 9,
  max_audio_refs: 3,
  max_video_refs: 3,
  min_audio_sec: 1.8,
  max_audio_sec: 15.2,
  min_video_sec: 1.8,
  max_video_sec: 15.2,
  max_total_video_sec: 15,
  // Output clip duration (--duration), distinct from the ref caps above.
  // These two are 2.0's; videoLimitsFor() below overrides them per model.
  min_output_sec: VIDEO_OUTPUT_DURATION_MIN_SEC,
  max_output_sec: VIDEO_OUTPUT_DURATION_MAX_SEC_BY_MODEL["video-generation"],
};

export const VIDEO_REF_CAPS_BY_MODEL = {
  "video-generation": { max_image_refs: 9, max_audio_refs: 3, max_video_refs: 3 },
  // 2.5's own caps, transcribed from the limits the backend enforced
  // pre-freeze before this model moved to its current route. Nothing on that
  // route enforces them now, so the CLI is the only gate left; keeping 2.0's
  // 9/3/3 would refuse jobs the vendor and
  // the backend both accept.
  [VIDEO_25_MODEL_ID]: { max_image_refs: 30, max_audio_refs: 10, max_video_refs: 10 },
};

/**
 * VIDEO_LIMITS for one model id.
 *
 * generate_video.js attaches this to every failure it prints, and the static
 * blob above is 2.0's — so a 2.5 failure used to hand the agent 4..15 as its
 * recovery bounds when the real range is 5..30, i.e. advice that produces a
 * second failure.
 *
 * min_audio_sec / max_audio_sec / min_video_sec / max_video_sec are shared on
 * purpose: 1.8s-15.2s per file is the video-generation-assets upload gate,
 * which both versions still go through. Widening it to the vendor's 2-30s is a
 * separate, unverified claim.
 */
export function videoLimitsFor(modelId) {
  const { min, max } = videoOutputDurationBounds(modelId);
  const caps = VIDEO_REF_CAPS_BY_MODEL[modelId] ?? VIDEO_REF_CAPS_BY_MODEL["video-generation"];
  return {
    ...VIDEO_LIMITS,
    ...caps,
    min_output_sec: min,
    max_output_sec: max,
    ...(modelId === VIDEO_25_MODEL_ID
      ? {
          // A PRICING cap (no tier row exists past it), not a provider one.
          max_billed_sec: VIDEO_25_MAX_BILLED_SEC,
          // Vendor-documented reference-video aggregate for 2.5: 2-30s per
          // clip, <=30s total. NOT VIDEO_25_MAX_BILLED_SEC minus the output
          // floor — that would be pricing headroom wearing a provider-limit
          // name, and it reads 25s too permissive. Nothing on the server side
          // checks this, so a ref set over it is frozen and then FAILED upstream.
          max_total_video_sec: 30,
        }
      : {}),
  };
}

export const IMAGE_LIMITS     = { max_image_refs: 16, min_ref_image_dimension: 300 };  // image-generation (standard tier)
export const IMAGE_PRO_LIMITS = {
  max_image_refs: IMAGE_PRO_MAX_IMAGE_REFS,
  min_ref_image_dimension: 300,
  supported_sizes: IMAGE_PRO_SUPPORTED_SIZES,
};
export const VOICE_LIMITS     = {};                      // tts — no documented caps
