const jwt = require('jsonwebtoken'); 
// Asegúrate de que esta variable de entorno esté configurada en tu hosting (Render)
const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Middleware para verificar la validez del token JWT en el encabezado Authorization.
 * Si es válido, añade el objeto 'user' (con id y username) a req.user.
 */
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Espera un formato "Bearer TOKEN"

    if (token == null) {
        // 401 Unauthorized: No hay token
        return res.status(401).json({ message: 'Acceso denegado. Token no proporcionado.' }); 
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            // 403 Forbidden: Token inválido o expirado
            return res.status(403).json({ message: 'Token inválido o expirado.' }); 
        }
        req.user = user; 
        next();
    });
};

module.exports = {
    authenticateToken
};
