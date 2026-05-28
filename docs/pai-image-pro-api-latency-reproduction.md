# PAI image-generation-pro API latency reproduction

**Status:** observed
**Date:** 2026-05-28
**Scope:** PAI API `/api/v1/generate` response latency after internal image job success

## Problem

For `image-generation-pro`, the client calls the synchronous raw API:

```text
POST https://api.pai-pro.utopaistudios.com/api/v1/generate
```

The PAI dashboard can show the internal image job as `SUCCESS` well before the
client receives the final `/api/v1/generate` HTTP response containing the image
URL.

The gap to investigate is:

```text
internal image job SUCCESS -> /api/v1/generate response reaches client
```

This appears to be an API/service-side latency or response-delivery issue. The
client cannot display or download the image until `/api/v1/generate` returns a
body with `outcome.media_urls[0].url`.

## Observed case 1: delayed successful response

Dashboard job id shown in the PAI dashboard:

```text
3352ab76-34ae-45f2-8349-b943b9e4df82
```

Dashboard details:

```text
model: image-generation-pro
status: SUCCESS
duration: 165.75s
cost: $0.45
```

Client-observed completion:

```json
{
  "ok": true,
  "model": "image-generation-pro",
  "size": "2560x1440",
  "duration_seconds": 455.023,
  "completed_at": "2026-05-28T19:49:40.120Z"
}
```

Interpretation:

- Internal dashboard job finished in about `165.75s`.
- The client did not receive the usable API response until about `455.023s`.
- The extra delay is roughly `289s`.

## Observed case 2: dashboard success but client failure

Dashboard job id shown in the same PAI dashboard screenshot:

```text
347d79cf-5b8e-4b7a-a110-e288a85129b9
```

Dashboard details:

```text
model: image-generation-pro
status: SUCCESS
duration: 228.14s
cost: $0.26
prompt: A beautiful cat sitting elegantly...
```

Client-observed result:

```json
{
  "ok": false,
  "klass": "transient_exhausted",
  "message": "Network error calling PAI generate: fetch failed (after 2 attempts)",
  "model": "image-generation-pro",
  "image_size": "1K",
  "cost_usd": 0.26,
  "completed_at": "2026-05-28T19:46:43.551Z"
}
```

Interpretation:

- The internal PAI job appears to have reached `SUCCESS`.
- The client never received a usable `/api/v1/generate` response.
- This may share the same root cause as case 1: internal completion is not
  reliably or quickly delivered to the synchronous client request.

## Direct API reproduction

Set a real PAI key:

```bash
export PAI_KEY='PAI_...'
```

Create the request payload:

```bash
cat >/tmp/pai-image-pro-payload.json <<'JSON'
{
  "model": "image-generation-pro",
  "payload": {
    "prompt": "Cinematic storyboard sheet, 2x2 grid layout, thin black panel borders, panel number labels in corner. 4 sequential ad shots. Panel 1: wide establishing shot, scorching summer day, heat haze rising from sun-baked city street, sweaty pedestrians wilting in the heat, golden hour sunlight. Panel 2: close-up, a hand pulls an ice-cold glass Coca-Cola bottle from a cooler full of ice, water droplets cascading off the bottle, vivid red Coca-Cola label, macro detail, glistening condensation. Panel 3: medium shot, young woman tips the Coca-Cola bottle to her lips, eyes closed in refreshing relief, bubbles rising inside the bottle, cold mist around her face, warm backlight. Panel 4: hero product shot, classic Coca-Cola bottle centered on red background, ice and water splashing dynamically around it, tagline space below, studio lighting, vibrant red.",
    "size": "2560x1440",
    "quality": "high",
    "n": 1,
    "output_format": "png"
  }
}
JSON
```

Run the API call and measure HTTP timing:

```bash
date -u +"client_start=%Y-%m-%dT%H:%M:%SZ"
curl -sS \
  -o /tmp/pai-image-pro-response.json \
  -w 'http_code=%{http_code}\ntime_total=%{time_total}\ntime_starttransfer=%{time_starttransfer}\n' \
  -H "Authorization: Bearer ${PAI_KEY}" \
  -H "Content-Type: application/json" \
  --data @/tmp/pai-image-pro-payload.json \
  https://api.pai-pro.utopaistudios.com/api/v1/generate
date -u +"client_end=%Y-%m-%dT%H:%M:%SZ"
```

Expected successful response shape:

```json
{
  "outcome": {
    "media_urls": [
      { "url": "https://..." }
    ]
  }
}
```

While the curl is running, watch the PAI dashboard and record:

- Client request start time.
- Dashboard job id.
- Dashboard job creation time.
- Dashboard internal `SUCCESS` time.
- Client `time_starttransfer`.
- Client `time_total`.
- Whether `/tmp/pai-image-pro-response.json` contains
  `outcome.media_urls[0].url`.

The issue reproduces if:

- Dashboard `SUCCESS` happens substantially before the curl receives the final
  JSON response, or
- Dashboard shows `SUCCESS` but curl fails, times out, or receives no media URL.

## API-side data to inspect

For each affected dashboard job id, inspect:

- Time when `/api/v1/generate` received the client request.
- Time when the internal provider task was created.
- Time when the internal provider task became `SUCCESS`.
- Time when the output media URL became available to the API service.
- Time when response serialization began.
- Time when the first response byte was written to the client.
- Time when the response completed or the client connection closed.
- Any retry/backoff after internal `SUCCESS`.
- Any storage copy, signed URL creation, media validation, moderation, or CDN
  propagation step after internal `SUCCESS`.
- Any proxy, gateway, server timeout, connection reset, or buffering behavior
  that could cause the client request to fail while the internal job succeeds.

## Desired behavior

For synchronous `/api/v1/generate`:

- Once the internal image job is `SUCCESS`, the HTTP response should return
  `outcome.media_urls[0].url` quickly, ideally within a few seconds.
- If response delivery fails after internal success, the client should receive a
  stable correlation id or recoverable job id so it can fetch the finished
  result later.

Recommended API improvements:

- Include the dashboard/internal job id in successful `/generate` responses.
- Include the same id in error bodies and/or a response header, for example
  `x-pai-request-id`.
- Consider exposing an async image-generation-pro API, equivalent to
  `submit` plus `task/status/{id}`, so clients can recover from connection
  failure and observe progress after job creation.

## Acceptance criteria

Run the direct curl reproduction at least three times with `size: 2560x1440`.

Pass criteria:

- Difference between dashboard `SUCCESS` time and client `time_total` is less
  than 10 seconds.
- No case where dashboard shows `SUCCESS` while the client receives a network
  failure or an empty/non-recoverable response.
- Response body contains both a media URL and a correlation id that PAI support
  can use to find the internal job.

