export function normalizeTaskTag(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || /[,\p{Cc}]/u.test(value))
    throw new Error('Use text tags without commas or control characters.');
  const normalized = value.trim().normalize('NFC').toLowerCase().normalize('NFC').trim();
  if (!normalized || normalized.length > 32) throw new Error('Tag must be 1–32 characters.');
  return normalized;
}

export function normalizeTaskTags(value) {
  if (!Array.isArray(value)) throw new Error('Tags must be a list.');
  const distinct = new Set();
  for (const entry of value) {
    distinct.add(normalizeTaskTag(entry));
    if (distinct.size > 8) throw new Error('Use up to eight tags.');
  }
  return [...distinct];
}

export function parseWorkflowTagsText(value) {
  if (value === undefined) return [];
  if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value) > 256)
    throw new Error('Use up to 256 bytes of comma-separated tags.');
  return value.trim() ? normalizeTaskTags(value.split(',')) : [];
}

export function validOpenMatchInput(projectId, exactTitle) {
  return typeof projectId === 'string' && projectId.length > 0 && projectId.length <= 128 && projectId.isWellFormed()
    && typeof exactTitle === 'string' && exactTitle.length > 0 && exactTitle.length <= 120 && exactTitle.isWellFormed();
}

export function normalizeWorkflowTitle(value) {
  const title = typeof value === 'string' && value.isWellFormed() ? value.trim() : '';
  // SQLite measures the stored title only up to its first NUL.
  if (!title || title.length > 120 || title.startsWith('\0')) throw new Error('Task title must be 1–120 characters.');
  return title;
}
