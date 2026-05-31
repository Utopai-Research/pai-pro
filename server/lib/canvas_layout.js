const FRAME_ID_RE = /^frame_[A-Za-z0-9_-]{1,128}$/;
const MAX_TITLE_LENGTH = 80;

export class CanvasLayoutError extends Error {
  constructor(message) {
    super(message);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertKnownNodeId(id, knownIds, label) {
  if (typeof id !== "string" || id === "") {
    throw new CanvasLayoutError(`${label} must be a non-empty string`);
  }
  if (!knownIds.has(id)) {
    throw new CanvasLayoutError(`unknown node id: ${id}`);
  }
}

function assertFrameId(frameId) {
  if (typeof frameId !== "string" || !FRAME_ID_RE.test(frameId)) {
    throw new CanvasLayoutError(`invalid frame id: ${frameId}`);
  }
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CanvasLayoutError(`${label} must be a finite number`);
  }
  return value;
}

function normalizePosition(pos, label) {
  if (!isPlainObject(pos)) {
    throw new CanvasLayoutError(`${label} must be {x,y}`);
  }
  return {
    x: finiteNumber(pos.x, `${label}.x`),
    y: finiteNumber(pos.y, `${label}.y`),
  };
}

function normalizeFrame(frameId, frame, knownIds, claimedMembers) {
  assertFrameId(frameId);
  if (!isPlainObject(frame)) {
    throw new CanvasLayoutError(`frame ${frameId} must be an object`);
  }
  const allowed = new Set(["memberIds", "x", "y", "width", "height", "hue", "title"]);
  for (const key of Object.keys(frame)) {
    if (!allowed.has(key)) {
      throw new CanvasLayoutError(`frame ${frameId} has unknown field: ${key}`);
    }
  }
  if (!Array.isArray(frame.memberIds)) {
    throw new CanvasLayoutError(`frame ${frameId}.memberIds must be an array`);
  }
  const memberIds = [];
  const seen = new Set();
  for (const memberId of frame.memberIds) {
    assertKnownNodeId(memberId, knownIds, `frame ${frameId}.memberIds[]`);
    if (seen.has(memberId)) {
      throw new CanvasLayoutError(`frame ${frameId} repeats member id: ${memberId}`);
    }
    if (claimedMembers.has(memberId)) {
      throw new CanvasLayoutError(`member ${memberId} appears in multiple upserted frames`);
    }
    seen.add(memberId);
    claimedMembers.add(memberId);
    memberIds.push(memberId);
  }
  if (memberIds.length < 2) {
    throw new CanvasLayoutError(`frame ${frameId} needs at least two members`);
  }
  const title = String(frame.title ?? "").trim();
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw new CanvasLayoutError(`frame ${frameId}.title must be 1-${MAX_TITLE_LENGTH} characters`);
  }
  const width = finiteNumber(frame.width, `frame ${frameId}.width`);
  const height = finiteNumber(frame.height, `frame ${frameId}.height`);
  if (width <= 0 || height <= 0) {
    throw new CanvasLayoutError(`frame ${frameId}.width/height must be positive`);
  }
  const hue = finiteNumber(frame.hue, `frame ${frameId}.hue`);
  if (hue < 0 || hue > 360) {
    throw new CanvasLayoutError(`frame ${frameId}.hue must be between 0 and 360`);
  }
  return {
    memberIds,
    x: finiteNumber(frame.x, `frame ${frameId}.x`),
    y: finiteNumber(frame.y, `frame ${frameId}.y`),
    width,
    height,
    hue,
    title,
  };
}

export function applyCanvasLayoutPatch(project, patch) {
  if (!isPlainObject(patch)) {
    throw new CanvasLayoutError("layout body must be an object");
  }
  const allowed = new Set(["positions", "groupFrames"]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) {
      throw new CanvasLayoutError(`layout body has unknown field: ${key}`);
    }
  }
  const knownIds = new Set(
    Array.isArray(project.canvasState?.nodes)
      ? project.canvasState.nodes.map((node) => node.id)
      : [],
  );
  const nextPositions = { ...(project.canvasPositions?.positions ?? {}) };
  const nextFrames = { ...(project.canvasPositions?.groupFrames ?? {}) };

  if (patch.positions !== undefined) {
    if (!isPlainObject(patch.positions)) {
      throw new CanvasLayoutError("positions must be { nodeId: {x,y} | null }");
    }
    for (const [nodeId, pos] of Object.entries(patch.positions)) {
      if (pos === null) {
        if (typeof nodeId !== "string" || nodeId === "") {
          throw new CanvasLayoutError("positions key must be a non-empty string");
        }
        delete nextPositions[nodeId];
      } else {
        assertKnownNodeId(nodeId, knownIds, "positions key");
        nextPositions[nodeId] = normalizePosition(pos, `positions.${nodeId}`);
      }
    }
  }

  const groupPatch = patch.groupFrames;
  if (groupPatch !== undefined) {
    if (!isPlainObject(groupPatch)) {
      throw new CanvasLayoutError("groupFrames must be an object");
    }
    const allowedGroupKeys = new Set(["upsert", "delete"]);
    for (const key of Object.keys(groupPatch)) {
      if (!allowedGroupKeys.has(key)) {
        throw new CanvasLayoutError(`groupFrames has unknown field: ${key}`);
      }
    }

    const deleteIds = [];
    if (groupPatch.delete !== undefined) {
      if (!Array.isArray(groupPatch.delete)) {
        throw new CanvasLayoutError("groupFrames.delete must be an array");
      }
      for (const frameId of groupPatch.delete) {
        assertFrameId(frameId);
        deleteIds.push(frameId);
      }
    }

    const claimedMembers = new Set();
    const upserts = new Map();
    if (groupPatch.upsert !== undefined) {
      if (!isPlainObject(groupPatch.upsert)) {
        throw new CanvasLayoutError("groupFrames.upsert must be { frameId: frame }");
      }
      for (const [frameId, frame] of Object.entries(groupPatch.upsert)) {
        upserts.set(frameId, normalizeFrame(frameId, frame, knownIds, claimedMembers));
      }
    }

    for (const frameId of deleteIds) {
      delete nextFrames[frameId];
    }

    const upsertIds = new Set(upserts.keys());
    if (claimedMembers.size > 0) {
      for (const [frameId, frame] of Object.entries(nextFrames)) {
        if (upsertIds.has(frameId)) continue;
        if (!isPlainObject(frame) || !Array.isArray(frame.memberIds)) continue;
        const memberIds = frame.memberIds.filter((memberId) => !claimedMembers.has(memberId));
        if (memberIds.length < 2) {
          delete nextFrames[frameId];
        } else if (memberIds.length !== frame.memberIds.length) {
          nextFrames[frameId] = { ...frame, memberIds };
        }
      }
    }

    for (const [frameId, frame] of upserts) {
      nextFrames[frameId] = frame;
    }
  }

  return {
    positions: nextPositions,
    groupFrames: nextFrames,
  };
}
