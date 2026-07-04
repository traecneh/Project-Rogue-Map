import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const appPath = path.join(root, 'js', 'app.js');

class FakeClassList {
  constructor(initial = []) {
    this.classes = new Set(initial);
  }

  add(...names) {
    names.forEach(name => this.classes.add(name));
  }

  remove(...names) {
    names.forEach(name => this.classes.delete(name));
  }

  contains(name) {
    return this.classes.has(name);
  }

  toggle(name, force) {
    const next = force === undefined ? !this.classes.has(name) : !!force;
    if (next) this.classes.add(name);
    else this.classes.delete(name);
    return next;
  }
}

function makeElement(id = '') {
  return {
    id,
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    value: '',
    textContent: '',
    innerHTML: '',
    parentElement: null,
    classList: new FakeClassList(),
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name];
    },
    addEventListener() {},
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
    },
    querySelector(selector) {
      if (selector === 'span.n') return this._span || null;
      if (selector === '.lbl-inner') return this._inner || null;
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, right: 80, top: 0, bottom: 20, width: 80, height: 20 };
    }
  };
}

function makeSpan(name, kind) {
  return {
    textContent: name,
    classList: new FakeClassList(['n', kind])
  };
}

function makeMarker(name, kind) {
  const el = makeElement(`${kind}-${name}`);
  el._span = makeSpan(name, kind);
  el._inner = makeElement(`${kind}-${name}-inner`);
  return {
    el,
    getElement() {
      return el;
    },
    getLatLng() {
      return { lat: 0, lng: kind === 'poi' ? 120 : 80 };
    },
    setZIndexOffset(value) {
      this.zIndexOffset = value;
    }
  };
}

function makeLayerGroup() {
  return {
    _layers: [],
    addTo(map) {
      map.addLayer(this);
      return this;
    },
    addLayer(layer) {
      this._layers.push(layer);
      return this;
    },
    removeLayer(layer) {
      this._layers = this._layers.filter(item => item !== layer);
      return this;
    },
    clearLayers() {
      this._layers = [];
    },
    eachLayer(callback) {
      this._layers.slice().forEach(callback);
    }
  };
}

function createHarness() {
  const elements = new Map();
  const visibleLayers = new Set();

  function elementForSelector(selector) {
    if (!selector.startsWith('#')) return makeElement(selector);
    const id = selector.slice(1);
    if (!elements.has(id)) {
      const el = makeElement(id);
      if (['pillTowns', 'pillPois', 'pillPortals', 'pillCaves'].includes(id)) {
        el.classList.add('on');
      }
      elements.set(id, el);
    }
    return elements.get(id);
  }

  const map = {
    createPane() {
      return { style: {} };
    },
    getPane() {
      return { style: {} };
    },
    addLayer(layer) {
      visibleLayers.add(layer);
      return this;
    },
    removeLayer(layer) {
      visibleLayers.delete(layer);
      return this;
    },
    hasLayer(layer) {
      return visibleLayers.has(layer);
    },
    getSize() {
      return { x: 1024, y: 768 };
    },
    latLngToLayerPoint() {
      return { x: 100, y: 100 };
    },
    getContainer() {
      return makeElement('map');
    },
    getZoom() {
      return 0;
    },
    getMaxZoom() {
      return 6;
    },
    getMinZoom() {
      return -2;
    },
    on() {},
    once() {},
    stop() {},
    setZoom() {},
    setView() {},
    flyTo() {},
    setMaxBounds() {},
    setMinZoom() {},
    fitBounds() {},
    getBoundsZoom() {
      return 0;
    },
    getBounds() {
      return {
        getNorthWest: () => ({ lat: 0, lng: 0 }),
        getSouthEast: () => ({ lat: 0, lng: 0 })
      };
    },
    project() {
      return { x: 0, y: 0 };
    },
    getScaleZoom() {
      return 1;
    }
  };

  const document = {
    documentElement: makeElement('html'),
    querySelector: elementForSelector,
    createElement: () => makeElement('created'),
    createDocumentFragment: () => makeElement('fragment'),
    addEventListener() {}
  };

  const window = {
    document,
    location: { pathname: '/', search: '', hash: '' },
    history: { replaceState() {} },
    addEventListener() {}
  };

  class FakeImage {
    constructor() {
      this.naturalWidth = 8192;
      this.naturalHeight = 4096;
    }
  }

  const L = {
    CRS: { Simple: {} },
    map: () => map,
    layerGroup: makeLayerGroup,
    featureGroup: makeLayerGroup,
    icon: options => options,
    divIcon: options => options,
    marker: (latlng, options = {}) => ({
      latlng,
      options,
      addTo(group) {
        group.addLayer(this);
        return this;
      },
      getElement() {
        return makeElement('leaflet-marker');
      },
      getLatLng() {
        return latlng;
      },
      setZIndexOffset() {},
      setIcon() {},
      setLatLng(next) {
        this.latlng = next;
      }
    }),
    latLng: (lat, lng) => ({ lat, lng }),
    latLngBounds: () => ({
      contains: () => true,
      getNorthWest: () => ({ lat: 0, lng: 0 }),
      getNorthEast: () => ({ lat: 0, lng: 0 }),
      getSouthEast: () => ({ lat: 0, lng: 0 }),
      getSouthWest: () => ({ lat: 0, lng: 0 })
    }),
    imageOverlay: () => ({ addTo: () => ({ once() {}, getElement: () => null }) }),
    rectangle: () => ({ addTo: () => null }),
    polygon: () => ({ addTo: () => null }),
    polyline: () => ({ addTo: () => null, setLatLngs() {}, setStyle() {} })
  };

  return {
    context: {
      console,
      assert,
      document,
      window,
      L,
      Image: FakeImage,
      URLSearchParams,
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      setTimeout: (callback) => {
        callback();
        return 1;
      },
      clearTimeout() {},
      requestAnimationFrame: callback => callback()
    }
  };
}

const harness = createHarness();
Object.assign(globalThis, harness.context);
globalThis.window.__PROJECT_ROGUE_TEST_HOOKS__ = {};

await import(pathToFileURL(appPath).href);

const api = globalThis.window.__PROJECT_ROGUE_TEST_HOOKS__.api;
assert.ok(api, 'app test API was not exposed');
const townMarker = makeMarker('Farmtown', 'town');
const poiMarker = makeMarker('Ancient Ruins', 'poi');
api.groups.towns.addLayer(townMarker);
api.groups.poisFG.addLayer(poiMarker);

api.commitSearch({ name: 'Death Tyrant', type: 'monster', level: 45 }, { focus: false, exact: true });

assert.strictEqual(api.elements.pillTowns.classList.contains('on'), true);
assert.strictEqual(api.elements.pillPois.classList.contains('on'), true);
assert.notStrictEqual(townMarker.el.style.display, 'none', 'monster search should not hide enabled town labels');
assert.notStrictEqual(poiMarker.el.style.display, 'none', 'monster search should not hide enabled POI labels');
