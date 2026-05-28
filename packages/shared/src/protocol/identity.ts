// Tier B presence palette (8 distinct hues; room capacity is bounded by the
// palette size so each connected client gets a unique color).
export const PALETTE = [
  '#FF4136', '#FF851B', '#FFDC00', '#2ECC40',
  '#39CCCC', '#0074D9', '#B10DC9', '#F012BE',
] as const;
export type PaletteColor = typeof PALETTE[number];

// Short, friendly animal handles. Server picks the first not in use in a room.
// 20 entries — comfortably exceeds the 8-color presence cap and gives the
// handle picker room to suffix-disambiguate if it ever needs to.
export const HANDLES = [
  'Owl', 'Fox', 'Otter', 'Lynx', 'Hawk', 'Mole',
  'Frog', 'Wren', 'Toad', 'Bat',  'Ibis', 'Kit',
  'Stoat','Crane','Raven','Newt', 'Marten','Vole',
  'Jay',  'Heron',
] as const;
export type Handle = typeof HANDLES[number];
