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
};

module.exports = { BUILDING_COSTS };
