---
name: add-note
description: Appends a note node to the filmmaking canvas and links it to the previous note. Use when the user says "take a note", "annotate", "jot down", "save this", "remember that", or any phrasing that asks the agent to capture a short piece of text on the canvas.
---

## Recipe

Notes are persisted through the canvas mutator. The agent does NOT
`Write` or `Edit` `workflow.json` directly — a PreToolUse hook blocks
that path. Use `scripts/canvas_mutate.js` instead.

1. **Read `./workflow.json`** to find the most recent `note_*` id (largest
   `note_<N>`). This is read-only; the hook only blocks writes.

2. **Build the mutation payload** — one note + an edge from the previous
   note if there is one:
   ```json
   {
     "nodes": [{
       "type": "note",
       "data": {
         "label": "<≤30 char title derived from the first sentence>",
         "body": "<full user text>",
         "metadata": { "author": "agent", "timestamp": "<ISO 8601 now>" }
       }
     }],
     "edges": [
       { "from": "<previous note id, omit this edge if none>", "to": "$0" }
     ]
   }
   ```
   `$0` is the placeholder for the (yet-to-be-assigned) new note id; the
   mutator resolves it after assigning the real id.

3. **Call the mutator:**
   ```
   node "$PAI_REPO_ROOT/server/cli/canvas_mutate.js" \
     --op addBatch \
     --payload-json '<the JSON above as one line>'
   ```
   Stdout is one JSON line. Read `assigned.node_ids[0]` to learn the new
   note's id.

4. **Confirm in ONE short sentence.** Do NOT paste the JSON. Do NOT
   narrate the call. Do NOT set `x` or `y` — the renderer positions
   nodes automatically.
