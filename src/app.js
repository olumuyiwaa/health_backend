const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');

const { globalRateLimiter } = require('./middleware/rateLimiter');
const { errorHandler } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/requestLogger');
const routes = require('./routes');
const logger = require('./config/logger');
const { setupSwagger } = require('./config/swagger');


const app = express();

// ─── Security Headers ──────────────────────────
app.use(helmet());
app.use(helmet.hsts({ maxAge: 31536000, includeSubDomains: true, preload: true }));

// ─── CORS ──────────────────────────────────────
const allowedOrigins = [
    'http://localhost:3000',
    process.env.FRONTEND_URL,
    process.env.ADMIN_URL,
].filter(Boolean).map(origin => origin.replace(/\/$/, ''));

app.use(cors({
    origin: function (origin, callback) {
        // allow Postman / server-to-server (no origin)
        if (!origin) return callback(null, true);

        const cleanOrigin = origin.replace(/\/$/, '');

        if (allowedOrigins.includes(cleanOrigin)) {
            return callback(null, true);
        }

        return callback(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
}));

// ─── Body Parsing ──────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());

// ─── Logging ───────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined', { stream: { write: (msg) => logger.http(msg.trim()) } }));
}
app.use(requestLogger);

// ─── Rate Limiting ─────────────────────────────
app.use(globalRateLimiter);

// ─── Health Check ──────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), env: process.env.NODE_ENV });
});

// ─── Swagger Docs ──────────────────────────────
setupSwagger(app);

// ─── API Routes ────────────────────────────────
const prefix = process.env.API_PREFIX || '/api/v1';
app.use(prefix, routes);

// ─── 404 Handler ───────────────────────────────
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
});

// ─── Global Error Handler ──────────────────────
app.use(errorHandler);

module.exports = app;