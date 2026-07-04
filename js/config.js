export const IMG_PATH = './img/Map_Combined.png';

export const DATA = {
  towns: './data/towns.json',
  portals: './data/portals.json',
  encounters: './data/encounters.json',
  caves: './data/caves.json',
  zones: './data/zones.json',
  pois: './data/poi.json',
  crim: './data/crim_spawns.json',
  monsterLvls: './data/monster_levels.json'
};

export const INVERT_Y = true;
export const ZOOM_OUT_EXTRA = 2;
export const MATCH_ZINDEX_OFFSET = 10000;
export const FLOOR_WIDTH = 4096;
export const FLOOR_VIEW_PADDING_X = 288;
export const FLOOR_VIEW_PADDING_Y = 224;

export const FLOORS = {
  overworld: { key: 'overworld', label: 'Overworld', minX: 0, maxX: FLOOR_WIDTH, offset: 0 },
  underground: { key: 'underground', label: 'Underground', minX: FLOOR_WIDTH, maxX: FLOOR_WIDTH * 2, offset: FLOOR_WIDTH }
};

export const MONSTER_FILTER_HINT_DEFAULT = 'Showing all levels. Set min/max to filter.';
export const MONSTER_FILTER_HINT_UNAVAILABLE = 'Monster level data unavailable.';
export const MONSTER_FILTER_HINT_NEED_RANGE = 'Set min/max to use Exclusive mode.';

export const CHUNK_SIZE = 16;
export const MIN_CHUNK_SCREEN_PX = 26;
export const SEARCH_LABEL_MIN_PX = MIN_CHUNK_SCREEN_PX + 6;
export const SEARCH_CLUSTER_RADIUS = 1;
export const SEARCH_SUGGESTION_LIMIT = 12;
export const SEARCH_TYPE_ORDER = { monster: 0, town: 1, poi: 2 };
