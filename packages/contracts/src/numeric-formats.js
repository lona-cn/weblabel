// Shared by the Node validator and build-time browser validator generation.
export const numericFormats = {
  uint8: { type: 'number', validate: (value) => Number.isInteger(value) && value >= 0 && value <= 255 },
  uint32: { type: 'number', validate: (value) => Number.isInteger(value) && value >= 0 && value <= 4_294_967_295 },
  uint64: { type: 'number', validate: (value) => Number.isSafeInteger(value) && value >= 0 },
  double: { type: 'number', validate: Number.isFinite },
};
