const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');

const { combine, timestamp, errors, json, colorize, simple } = format;

const fileTransport = new transports.DailyRotateFile({
    filename:      'logs/app-%DATE%.log',
    datePattern:   'YYYY-MM-DD',
    zippedArchive: true,
    maxSize:       '20m',
    maxFiles:      '30d',
    level:         'info',
});

const errorFileTransport = new transports.DailyRotateFile({
    filename:      'logs/error-%DATE%.log',
    datePattern:   'YYYY-MM-DD',
    zippedArchive: true,
    maxSize:       '20m',
    maxFiles:      '30d',
    level:         'error',
});

const logger = createLogger({
    level:  process.env.LOG_LEVEL || 'info',
    format: combine(timestamp(), errors({ stack: true }), json()),
    defaultMeta: { service: 'trabajo-hub-api' },
    transports: [fileTransport, errorFileTransport],
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new transports.Console({
        format: combine(colorize(), simple()),
    }));
}

module.exports = logger;