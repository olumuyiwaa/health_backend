const jwt  = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const ACCESS_SECRET  = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

function signAccessToken(payload) {
    return jwt.sign(
        { ...payload, jti: uuidv4() },   // unique ID — prevents same-millisecond collisions
        ACCESS_SECRET,
        {
            expiresIn: process.env.JWT_EXPIRES_IN || '15m',
            issuer:    'healthcare-api',
        }
    );
}

function signRefreshToken(payload) {
    return jwt.sign(
        { ...payload, jti: uuidv4() },   // unique ID — prevents token rotation collisions
        REFRESH_SECRET,
        {
            expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
            issuer:    'healthcare-api',
        }
    );
}

function verifyAccessToken(token) {
    return jwt.verify(token, ACCESS_SECRET, { issuer: 'healthcare-api' });
}

function verifyRefreshToken(token) {
    return jwt.verify(token, REFRESH_SECRET, { issuer: 'healthcare-api' });
}

function buildTokenPair(user) {
    const payload = { sub: user.id, role: user.role, email: user.email };
    return {
        accessToken:  signAccessToken(payload),
        refreshToken: signRefreshToken(payload),
    };
}

module.exports = {
    signAccessToken,
    signRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
    buildTokenPair,
};