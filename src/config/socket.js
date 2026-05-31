const { Server } = require('socket.io');
const { verifyAccessToken } = require('../utils/jwt');
const logger = require('./logger');

let io;

function initSocket(server) {
    io = new Server(server, {
        cors: {
            origin: [process.env.FRONTEND_URL, process.env.ADMIN_URL].filter(Boolean),
            credentials: true,
        },
        pingTimeout:  60000,
        pingInterval: 25000,
    });

    // Auth middleware for socket connections
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token ||
                socket.handshake.headers?.authorization?.split(' ')[1];
            if (!token) return next(new Error('Authentication required'));

            const payload = verifyAccessToken(token);
            socket.userId = payload.sub;
            socket.userRole = payload.role;
            next();
        } catch {
            next(new Error('Invalid token'));
        }
    });

    io.on('connection', (socket) => {
        logger.info(`Socket connected: ${socket.userId}`);

        // Join personal room for targeted notifications
        socket.join(`user:${socket.userId}`);

        socket.on('join_conversation', (conversationId) => {
            socket.join(`conv:${conversationId}`);
        });

        socket.on('leave_conversation', (conversationId) => {
            socket.leave(`conv:${conversationId}`);
        });

        socket.on('typing', ({ conversationId }) => {
            socket.to(`conv:${conversationId}`).emit('user_typing', {
                userId: socket.userId,
                conversationId,
            });
        });

        socket.on('disconnect', () => {
            logger.info(`Socket disconnected: ${socket.userId}`);
        });
    });

    return io;
}

function getIO() {
    if (!io) throw new Error('Socket.io not initialized');
    return io;
}

// Helper: emit to a user's personal room
function emitToUser(userId, event, data) {
    if (io) io.to(`user:${userId}`).emit(event, data);
}

// Helper: emit to a conversation room
function emitToConversation(conversationId, event, data) {
    if (io) io.to(`conv:${conversationId}`).emit(event, data);
}

module.exports = { initSocket, getIO, emitToUser, emitToConversation };