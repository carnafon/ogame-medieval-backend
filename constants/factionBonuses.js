// Faction-specific production multipliers.
// Keyed by faction name (string) -> object of resource multipliers (multiplier, e.g. 1.2 = +20%).
// Keep conservative values here; game designers can edit this file or load from DB later.
const FACTION_BONUSES = {
  // Example faction names. Replace with real faction names from DB.
  'Celtas': { food: 1.15, wood: 1.05 },
  'Vascones': { stone: 1.10, coal: 1.10 },
  'Andalusíes': { water: 1.10, clay: 1.10 },
  'Fenicios': {honey: 1.20, copper: 1.05 },
};

module.exports = { FACTION_BONUSES };
