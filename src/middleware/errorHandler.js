const logger = require('../config/logger');

function errorHandler(err, req, res, next) {
    logger.error({
        message: err.message,
        stack:   err.stack,
        path:    req.path,
        method:  req.method,
        userId:  req.user?.id,
    });

    // Multer errors
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, message: 'File too large' });
    }

    // Prisma unique constraint
    if (err.code === 'P2002') {
        const field = err.meta?.target?.[0] || 'field';
        return res.status(409).json({ success: false, message: `${field} already exists` });
    }

    // Prisma record not found
    if (err.code === 'P2025') {
        return res.status(404).json({ success: false, message: 'Record not found' });
    }

    // Validation errors from express-validator
    if (err.type === 'validation') {
        return res.status(422).json({ success: false, message: 'Validation failed', errors: err.errors });
    }

    const status = err.statusCode || err.status || 500;
    const message = status < 500 ? err.message : 'Internal server error';

    res.status(status).json({ success: false, message });
}

module.exports = { errorHandler };