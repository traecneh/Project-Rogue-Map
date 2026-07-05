export function normalizeMonsterFilterExclusive(next, levelValues) {
  return !!next && Array.isArray(levelValues) && levelValues.length > 0;
}

export function reconcileMonsterFilterState({ levelValues, min, max, exclusive }) {
  const values = Array.isArray(levelValues) ? levelValues : [];
  return {
    min: values.includes(min) ? min : null,
    max: values.includes(max) ? max : null,
    exclusive: normalizeMonsterFilterExclusive(exclusive, values)
  };
}

export function monsterFilterStatusText({ levelValues, min, max, exclusive, hints }) {
  const values = Array.isArray(levelValues) ? levelValues : [];
  if (!values.length) return hints.unavailable;

  const hasMin = Number.isFinite(min);
  const hasMax = Number.isFinite(max);
  if (!hasMin && !hasMax) {
    return exclusive ? hints.needRange : hints.default;
  }

  let text = '';
  if (hasMin && hasMax) {
    text = min === max ? `Filtering level ${min}` : `Filtering levels ${min} to ${max}`;
  } else if (hasMin) {
    text = `Filtering levels ${min}+`;
  } else if (hasMax) {
    text = `Filtering levels up to ${max}`;
  }

  return exclusive ? `${text} · Exclusive` : text;
}
