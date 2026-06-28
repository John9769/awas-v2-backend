const jwt = require('jsonwebtoken');

// ─── INSURER USER AUTH ────────────────────────────────────────────────────────
// Validates JWT and attaches insurerUser to req
module.exports = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided.' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.insurerUser = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired token.' });
    }
};

// ─── ROLE GUARD ───────────────────────────────────────────────────────────────
// Usage: requireRole('HOC') or requireRole('HOC', 'OFFICER')
module.exports.requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.insurerUser) {
            return res.status(401).json({ error: 'Unauthorized.' });
        }
        if (!roles.includes(req.insurerUser.role)) {
            return res.status(403).json({ error: 'Access denied. Insufficient permissions.' });
        }
        next();
    };
};