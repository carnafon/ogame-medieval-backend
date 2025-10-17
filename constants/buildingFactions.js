// Mapping de ejemplo: nombre_de_faccion -> lista de tipos de edificios permitidos
// Si una facción no aparece en este map, se asume que puede construir todos los edificios.
const ALLOWED_BUILDINGS_BY_FACTION = {
  // 'Artisans': ['sastreria','carpinteria','forja'],
  // 'Royal': ['herreria_real','tintoreria_real','herreria'],
  // Por defecto, deja vacío para permitir todo
};

module.exports = { ALLOWED_BUILDINGS_BY_FACTION };
