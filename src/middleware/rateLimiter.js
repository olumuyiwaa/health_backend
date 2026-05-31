const rateLimit = require('express-rate-limit');
const { errorResponse } = require('../utils/response');

const handler = (req, res) =>
    errorResponse(res, 'Too many requests. Please slow down.', 429);

const globalRateLimiter = rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max:      Number(process.env.RATE_LIMIT_MAX) || 100,
    standardHeaders: true,
    legacyHeaders:   false,
    handler,
});

const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max:      Number(process.env.AUTH_RATE_LIMIT_MAX) || 10,
    standardHeaders: true,
    legacyHeaders:   false,
    handler,
    skipSuccessfulRequests: false,
});

const uploadRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max:      30,
    standardHeaders: true,
    legacyHeaders:   false,
    handler,
});

module.exports = { globalRateLimiter, authRateLimiter, uploadRateLimiter };