// Centralized building cost definitions for backend
// Keep values aligned with frontend `frontend/src/constants/buildings.js`
const BUILDING_COSTS = {
  house: { wood: 20, stone: 10, food: 5 },
  sawmill: { wood: 50, stone: 30, food: 10 },
  quarry: { wood: 40, stone: 80, food: 15 },
  farm: { wood: 40, stone: 10, food: 10 },
  well: { wood: 15, stone: 10, food: 0 },
  clay_pit: { wood: 20, stone: 20, food: 0 },
  tannery: { wood: 25, stone: 15, food: 5 },
  coal_mine: { wood: 30, stone: 40, food: 0 },
  copper_mine: { wood: 35, stone: 45, food: 0 },
  sheepfold: { wood: 20, stone: 10, food: 5 },
  apiary: { wood: 15, stone: 5, food: 0 },
  sastreria: { wood: 60, stone: 20, food: 10 },
  carpinteria: { wood: 40, stone: 20, food: 5 },
  fabrica_ladrillos: { wood: 30, stone: 25, food: 5 },
  bazar_especias: { wood: 20, stone: 15, food: 10 },
  alfareria: { wood: 25, stone: 20, food: 5 },
  tintoreria_morada: { wood: 30, stone: 15, food: 5 },
  herreria: { wood: 50, stone: 40, food: 10 },
  salazoneria: { wood: 25, stone: 20, food: 5 },
  libreria: { wood: 45, stone: 10, food: 5 },
  cerveceria: { wood: 30, stone: 10, food: 10 },
  forja: { wood: 40, stone: 30, food: 8 },
};

module.exports = { BUILDING_COSTS };
