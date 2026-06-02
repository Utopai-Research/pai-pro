// Provider hard caps surfaced in CLI failure JSON (`limits` field).
// Agents compare against `sent` to recover.

import {
  IMAGE_PRO_MAX_IMAGE_REFS,
  IMAGE_PRO_SUPPORTED_SIZES,
} from "../image_pro_sizes.js";

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
};

export const IMAGE_LIMITS     = { max_image_refs: 16, min_ref_image_dimension: 300 };  // image-generation (standard tier)
export const IMAGE_PRO_LIMITS = {
  max_image_refs: IMAGE_PRO_MAX_IMAGE_REFS,
  min_ref_image_dimension: 300,
  supported_sizes: IMAGE_PRO_SUPPORTED_SIZES,
};
export const VOICE_LIMITS     = {};                      // tts — no documented caps
