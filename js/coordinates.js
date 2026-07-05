export function mapLat(y, imageHeight, invertY) {
  return invertY ? imageHeight - y : y;
}

export function gameXYFromLatLng(latlng, { imageWidth, imageHeight, invertY, clamp }) {
  const x = clamp(Math.round(latlng.lng), 0, imageWidth);
  const yTop = clamp(Math.round(latlng.lat), 0, imageHeight);
  return [x, invertY ? imageHeight - yTop : yTop];
}

export function floorConfig(floors, floor) {
  return floors[floor] || floors.overworld;
}

export function floorForX(x, floorWidth) {
  return Number.isFinite(x) && x >= floorWidth ? 'underground' : 'overworld';
}

export function floorLabelForX(x, floorWidth) {
  return floorForX(x, floorWidth) === 'underground' ? 'UG' : 'OW';
}

export function floorLocalX(x, floor, floors) {
  return x - floorConfig(floors, floor).offset;
}

export function globalFloorX(localX, floor, floors) {
  return floorConfig(floors, floor).offset + localX;
}

export function clampFloorX(x, floor, floors, clamp) {
  const cfg = floorConfig(floors, floor);
  return clamp(x, cfg.minX, cfg.maxX - 1);
}

export function floorBounds(floor, floors, imageHeight, toFloorLL, latLngBounds) {
  const cfg = floorConfig(floors, floor);
  return latLngBounds(toFloorLL(floor, cfg.minX, 0), toFloorLL(floor, cfg.maxX, imageHeight));
}

export function floorViewportBounds(
  floor,
  floors,
  imageHeight,
  toFloorLL,
  latLngBounds,
  paddingX,
  paddingY
) {
  const cfg = floorConfig(floors, floor);
  return latLngBounds(
    toFloorLL(floor, cfg.minX - paddingX, -paddingY),
    toFloorLL(floor, cfg.maxX + paddingX, imageHeight + paddingY)
  );
}
