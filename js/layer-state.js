const SEARCH_LABEL_LAYER_KEYS = Object.freeze({
  town: 'towns',
  poi: 'pois'
});

export function labelLayerKeyForSearchType(type) {
  return SEARCH_LABEL_LAYER_KEYS[type] || null;
}

export function searchLabelMarkerState({ labelText, searchRegex, activeSearchType }) {
  if (!searchRegex || activeSearchType === 'monster') {
    return { matches: false, hidden: false };
  }
  const matches = searchRegex.test(labelText || '');
  return { matches, hidden: !matches };
}
