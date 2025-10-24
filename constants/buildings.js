// Centralized building cost definitions for backend
// Generated/updated to balance construction costs with production/recipes
const BUILDING_COSTS = {
  // Housing
  house: { wood: 20, stone: 10, food: 5, popNeeded: 0 },
  casa_de_piedra: { lumber: 10, baked_brick: 5, popNeeded: 0 },
  casa_de_ladrillos: { magic_catalyst: 4, linen: 3, popNeeded: 0 },

  // Primary producers (common resources) — payback ~4-6 min at level 1
  sawmill: { wood: 30, stone: 20, food: 5, popNeeded: 1 },
  quarry: { wood: 20, stone: 40, food: 5, popNeeded: 1 },
  farm: { wood: 15, stone: 5, food: 0, popNeeded: 1 },
  well: { wood: 10, stone: 5, food: 0, popNeeded: 1 },
  clay_pit: { wood: 10, stone: 10, food: 0, popNeeded: 1 },
  coal_mine: { wood: 15, stone: 25, food: 0, popNeeded: 1 },
  copper_mine: { wood: 20, stone: 30, food: 0, popNeeded: 1 },
  sheepfold: { wood: 10, stone: 10, food: 5, popNeeded: 1 },
  apiary: { wood: 8, stone: 4, food: 0, popNeeded: 1 },

  // Processors: wood + stone + food + one extra common resource (unique per building as requested)
  carpinteria: { wood: 20, stone: 10, food: 5, water: 6, popNeeded: 1 },
  tannery: { wood: 20, stone: 10, food: 5, leather: 8, popNeeded: 1 },
  sastreria: { wood: 20, stone: 10, food: 5, wool: 8, popNeeded: 1 },
  alfareria: { wood: 15, stone: 10, food: 5, clay: 20, popNeeded: 1 },
  fabrica_ladrillos: { clay: 20, wood: 10, stone: 10, food: 5, popNeeded: 1 },
  bazar_especias: { wood: 20, stone: 10, food: 5, honey: 8, popNeeded: 1 },
  salazoneria: { wood: 20, stone: 10, food: 5, water: 8, popNeeded: 1 },
  libreria: { wood: 25, stone: 10, food: 5, copper: 8, popNeeded: 1 },
  cerveceria: { wood: 15, stone: 10, food: 20, water: 6, popNeeded: 1 },
  forja: { wood: 20, stone: 30, food: 5, copper: 15, popNeeded: 1 },
  herreria: { wood: 20, stone: 30, food: 5, coal: 15, popNeeded: 1 },

  // Specialized buildings (cost = 1 processed + 1 common approx.)
  elixireria: { honey: 6, spice: 6, wood: 5, refined_clay: 15, popNeeded: 1 },
  tintoreria_morada: { wood: 30, stone: 15, books: 5, popNeeded: 1 },
  tintoreria_real: { wood: 8, stone: 8, purple_dye: 2, popNeeded: 1 },
  escriba: { wood: 20, stone: 10, books: 5, popNeeded: 1 },
  artificiero: { wood: 45, stone: 30, salted: 15, popNeeded: 1 },
  herreria_real: { wood: 60, stone: 50, iron_ingot: 15, popNeeded: 1 },
  lineria: { wood: 30, stone: 20, beer: 80, popNeeded: 1 },

  // Strategic / late-game
  tintoreria_dorada: { wood: 60, stone: 40, royal_dye: 10, popNeeded: 1 },
  herreria_mitica: { wood: 120, stone: 180, damascus_steel: 20, popNeeded: 2 },
  salinas: { wood: 30, stone: 20, preservation_elixir: 50, popNeeded: 1 },
  mina_azufre: { wood: 50, stone: 70, explosive_compound: 10, popNeeded: 1 },
  mina_gemas: { wood: 120, stone: 200, illustrated_parchment: 30, popNeeded: 2 },
  telar_real: { wood: 70, stone: 30, linen: 15, popNeeded: 1 }
};

module.exports = { BUILDING_COSTS };
