require('dotenv').config();
const http = require('http');
const app = require('./app');
const { initSocket } = require('./config/socket');
const logger = require('./config/logger');
const { prisma } = require('./config/database');

const PORT = process.env.PORT || 8000;

const server = http.createServer(app);
initSocket(server);

async function bootstrap() {
    try {
        await prisma.$connect();
        logger.info('✅ Database connected');

        server.listen(PORT, () => {
            logger.info(`🚀 Server running on port ${PORT} [${process.env.NODE_ENV}]`);
        });
    } catch (err) {
        logger.error('❌ Failed to start server:', err);
        process.exit(1);
    }
}

process.on('SIGTERM', async () => {
    logger.info('SIGTERM received. Shutting down gracefully...');
    await prisma.$disconnect();
    server.close(() => process.exit(0));
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection:', reason);
});

bootstrap();