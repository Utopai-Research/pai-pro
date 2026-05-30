# API Service

[PAI Pro Developer Platform](https://pai-pro.utopaistudios.com/) is the account
console for the media API used by PAI-Pro. Sign in there to create and manage
API keys, view submitted tasks and generated outputs, monitor balance and usage,
top up credits, and review billing history. The local PAI-Pro app reads the key
from `PAI_KEY` and sends media requests through the API contract below.

Use PAI-Pro's API service when you want:

- One `PAI_KEY` for image, image pro, video, voice, and video reference uploads.
- Less restrictive video-generation moderation than many other vendors, while
  still keeping provider safety failures in one consistent error model.

## API Contract and JSON Payloads

This page documents the API contract PAI-Pro expects from the media service.
The README keeps the product overview and pricing summary; this file is for
request payloads, return shapes, and bring-your-own-key guidance.

All media calls use the PAI media API envelope:

```http
Authorization: Bearer PAI_<key>
Content-Type: application/json
```

Default base URL: `https://api.pai-pro.utopaistudios.com`

Override for compatible gateways: `PAI_API_BASE=https://your-service.example.com`

Synchronous calls use:

```json
{
  "model": "<raw-model-id>",
  "payload": {},
  "query_params": {}
}
```

`query_params` is only used by `video-generation-assets`. The service returns
the upstream model response body; PAI-Pro's CLIs then decode the media, mirror it
into `projects/<id>/assets/`, and print their own one-line CLI result.

### Standard Image

Endpoint: `POST /api/v1/generate`

Model: `image-generation`

Request body:

```json
{
  "model": "image-generation",
  "payload": {
    "contents": [
      {
        "role": "user",
        "parts": [
          {
            "fileData": {
              "fileUri": "https://example.com/reference.png"
            }
          },
          {
            "text": "Wide cinematic frame of a rain-slick street at night."
          }
        ]
      }
    ],
    "generationConfig": {
      "responseModalities": ["IMAGE"],
      "imageConfig": {
        "aspectRatio": "16:9",
        "imageSize": "2K"
      }
    },
    "safetySettings": [
      {
        "category": "HARM_CATEGORY_HARASSMENT",
        "threshold": "BLOCK_ONLY_HIGH"
      },
      {
        "category": "HARM_CATEGORY_HATE_SPEECH",
        "threshold": "BLOCK_ONLY_HIGH"
      },
      {
        "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "threshold": "BLOCK_ONLY_HIGH"
      },
      {
        "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
        "threshold": "BLOCK_ONLY_HIGH"
      }
    ]
  }
}
```

Expected success shape:

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "inlineData": {
              "mimeType": "image/png",
              "data": "<base64 image bytes>"
            }
          }
        ]
      },
      "finishReason": "STOP"
    }
  ]
}
```

If the provider blocks the request, the response can still be `200` with
`promptFeedback.blockReason`, `candidates[0].finishReason` such as `SAFETY`, or
no inline image.

### Pro Image

Endpoint: `POST /api/v1/generate`

Model without image references: `image-generation-pro`

Model with image references: `image-edit-pro`

Request body without references:

```json
{
  "model": "image-generation-pro",
  "payload": {
    "prompt": "Studio product shot of a translucent blue cassette player.",
    "size": "2560x1440",
    "quality": "high",
    "n": 1,
    "output_format": "png"
  }
}
```

Request body with references:

```json
{
  "model": "image-edit-pro",
  "payload": {
    "prompt": "Keep the same character, change the setting to a moonlit train platform.",
    "size": "2560x1440",
    "quality": "high",
    "n": 1,
    "output_format": "png",
    "image": [
      "https://example.com/character.png",
      "https://example.com/costume.png"
    ]
  }
}
```

Expected success shape:

```json
{
  "outcome": {
    "media_urls": [
      {
        "url": "https://provider.example.com/generated-image.png"
      }
    ]
  }
}
```

PAI-Pro also accepts `output_url` or `outcome.output_url` as fallback response
fields. It downloads the returned URL and stores the image locally.

### Voice

Endpoint: `POST /api/v1/generate`

Model: `tts`

Request body:

```json
{
  "model": "tts",
  "payload": {
    "model": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    "input": "I thought we had more time.",
    "task_type": "VoiceDesign",
    "instructions": "Warm, tired alto voice with a quiet tremble.",
    "response_format": "mp3"
  }
}
```

Expected success shape:

```json
{
  "content_type": "audio/mpeg",
  "body_base64": "<base64 mp3 bytes>"
}
```

PAI-Pro decodes `body_base64` and stores the MP3 locally.

### Video Reference Assets

Video references must be uploaded before video generation. The media service
fetches each URL server-side, so reference URLs must be publicly fetchable.
PAI-Pro rewrites local viewer URLs through the local Cloudflare tunnel before
calling these endpoints.

Endpoint: `POST /api/v1/generate`

Model: `video-generation-assets`

Create or reuse the process-level asset group:

```json
{
  "model": "video-generation-assets",
  "query_params": {
    "Action": "CreateAssetGroup"
  },
  "payload": {
    "Name": "pai-pro",
    "Description": "pai-pro",
    "GroupType": "AIGC",
    "ProjectName": "default"
  }
}
```

Expected success shape:

```json
{
  "Result": {
    "Id": "<asset-group-id>"
  }
}
```

Create an asset:

```json
{
  "model": "video-generation-assets",
  "query_params": {
    "Action": "CreateAsset"
  },
  "payload": {
    "GroupId": "<asset-group-id>",
    "URL": "https://example.com/reference.png",
    "AssetType": "Image",
    "Name": "reference.png",
    "ProjectName": "default"
  }
}
```

`AssetType` is `Image`, `Audio`, or `Video`.

Expected success shape:

```json
{
  "Result": {
    "Id": "<asset-id>"
  }
}
```

Poll the asset until it is active:

```json
{
  "model": "video-generation-assets",
  "query_params": {
    "Action": "GetAsset"
  },
  "payload": {
    "Id": "<asset-id>"
  }
}
```

Expected active shape:

```json
{
  "Result": {
    "Id": "<asset-id>",
    "Status": "Active",
    "URL": "https://example.com/reference.png"
  }
}
```

`Status` can also be `Pending` or `Failed`. PAI-Pro uses the asset id as
`asset://<asset-id>` in the video payload once the status is `Active`.

### Video

Endpoint: `POST /api/v1/submit`

Model: `video-generation`

Request body:

```json
{
  "model": "video-generation",
  "payload": {
    "model": "pai-pro-video-endpoint-01",
    "content": [
      {
        "type": "text",
        "text": "Slow dolly through a foggy greenhouse at sunrise."
      },
      {
        "type": "image_url",
        "image_url": {
          "url": "asset://<image-asset-id>"
        },
        "role": "reference_image"
      },
      {
        "type": "audio_url",
        "audio_url": {
          "url": "asset://<audio-asset-id>"
        },
        "role": "reference_audio"
      },
      {
        "type": "video_url",
        "video_url": {
          "url": "asset://<video-asset-id>"
        },
        "role": "reference_video"
      }
    ],
    "generate_audio": true,
    "ratio": "16:9",
    "duration": 15,
    "resolution": "1080p",
    "watermark": false
  }
}
```

Expected submit shape:

```json
{
  "code": 0,
  "message": "submitted",
  "job_id": "<job-id>",
  "model": "video-generation",
  "status": "QUEUED",
  "queued": true,
  "queue_position": 0
}
```

Poll for completion:

```http
GET /api/v1/task/status/<job-id>
```

Expected in-progress shape:

```json
{
  "job_id": "<job-id>",
  "status": "PROCESSING"
}
```

Expected success shape:

```json
{
  "job_id": "<job-id>",
  "status": "SUCCESS",
  "output_url": "https://provider.example.com/generated-video.mp4",
  "output_type": "video",
  "raw_response": {}
}
```

Expected failure shape:

```json
{
  "job_id": "<job-id>",
  "status": "FAILED",
  "error_category": "content",
  "message": "The request was blocked by content moderation."
}
```

`error_category` maps to PAI-Pro failure classes: `client_input` becomes
`bad_args`, `content` becomes `content_filtered`, and `provider`, `timeout`, or
`auth` become `infra`.

### Error Responses

HTTP failures usually use one of these shapes:

```json
{
  "detail": "validation or provider error"
}
```

```json
{
  "code": 2001,
  "message": "insufficient balance",
  "retry_after": 30
}
```

PAI-Pro classifies errors before returning CLI output: `bad_args`, `infra`,
`content_filtered`, `rate_limited`, `transient`, or `transient_exhausted`.

## Bring Your Own Key

The best BYOK boundary is a PAI-compatible gateway, not provider-specific keys
inside PAI-Pro.

PAI-Pro's media code is intentionally built around one server-side service:
`PAI_KEY`, `PAI_API_BASE`, and the envelope shown above. If a user wants to use
their own upstream provider accounts, keep that complexity in a small gateway
that implements the same three media API routes:

```text
POST /api/v1/generate
POST /api/v1/submit
GET  /api/v1/task/status/<job-id>
```

Then configure PAI-Pro with:

```env
PAI_API_BASE=https://your-compatible-gateway.example.com
PAI_KEY=<token accepted by your gateway>
```

The gateway can hold provider credentials such as image, video, voice, or asset
upload keys in its own server environment and translate the PAI-Pro payloads to
those providers. PAI-Pro should not need to know about `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, or any other media-provider key directly.

This choice keeps the local app simple:

- The browser never receives provider credentials.
- Project files and generated `AGENTS.md` files never store provider keys.
- The CLIs keep one error model, one draft gate, and one cost-preview path.
- Alternative providers can be tested without changing canvas, node, or CLI
  contracts.

Direct provider-key support inside PAI-Pro should only be added if a provider
cannot be adapted behind the compatible gateway contract. If that happens, keep
the provider-specific code behind the existing `pai_client.js` boundary so the
rest of the app still sees the same request and response shapes.
