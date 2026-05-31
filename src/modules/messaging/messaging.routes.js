const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { prisma } = require('../../config/database');
const {
    successResponse,
    createdResponse,
    errorResponse,
    paginatedResponse,
    buildPagination,
} = require('../../utils/response');
const { emitToConversation, emitToUser } = require('../../config/socket');
const { createUploader, getPrivateUrl } = require('../../config/storage');
const { dispatchNotification } = require('../notifications/notifications.service');

const attachmentUpload = createUploader({
    folder:       'message-attachments',
    allowedTypes: 'all',
    maxSizeMB:    25,
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Verify the requesting user is a participant in the conversation.
 */
async function assertParticipant(conversationId, userId, res) {
    const convo = await prisma.conversation.findUnique({
        where:  { id: conversationId },
        select: { participantIds: true },
    });
    if (!convo) {
        errorResponse(res, 'Conversation not found', 404);
        return null;
    }
    if (!convo.participantIds.includes(userId)) {
        errorResponse(res, 'You are not a participant in this conversation', 403);
        return null;
    }
    return convo;
}

/**
 * Resolve the other participant's user ID from a conversation,
 * used for push notification targeting.
 */
function getOtherParticipants(participantIds, selfId) {
    return participantIds.filter((id) => id !== selfId);
}

// ─── Conversations ─────────────────────────────────────────────────────────

// POST /messages/conversations  — start or retrieve a DM thread
router.post(
    '/conversations',
    authenticate,
    [body('recipientId').notEmpty().withMessage('recipientId is required')],
    validate,
    async (req, res, next) => {
        try {
            const { recipientId, facilityId } = req.body;
            const selfId = req.user.id;

            if (recipientId === selfId) {
                return errorResponse(res, 'Cannot message yourself', 400);
            }

            // Verify recipient exists
            const recipient = await prisma.user.findUnique({
                where:  { id: recipientId },
                select: { id: true, status: true },
            });
            if (!recipient) return errorResponse(res, 'Recipient not found', 404);
            if (recipient.status === 'SUSPENDED' || recipient.status === 'DEACTIVATED') {
                return errorResponse(res, 'Recipient account is inactive', 400);
            }

            // Look for an existing 1-to-1 conversation between these two users
            const existing = await prisma.conversation.findFirst({
                where: {
                    participantIds: { hasEvery: [selfId, recipientId] },
                    ...(facilityId ? { facilityId } : {}),
                },
            });

            if (existing) return successResponse(res, existing, 'Conversation retrieved');

            const convo = await prisma.conversation.create({
                data: {
                    participantIds: [selfId, recipientId],
                    facilityId:     facilityId || null,
                },
            });

            return createdResponse(res, convo, 'Conversation created');
        } catch (err) {
            next(err);
        }
    }
);

router.get('/conversations', authenticate, async (req, res, next) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);

        const where = {
            participantIds: {
                has: req.user.id,
            },
        };

        const [conversations, total] = await Promise.all([
            prisma.conversation.findMany({
                where,
                orderBy: { lastMessageAt: 'desc' },
                skip,
                take: Number(limit),
                include: {
                    messages: {
                        orderBy: { createdAt: 'desc' },
                        take: 1,
                        select: {
                            content: true,
                            createdAt: true,
                            senderId: true,
                            attachmentType: true,
                        },
                    },
                },
            }),
            prisma.conversation.count({ where }),
        ]);

        const enrichedConversations = await Promise.all(
            conversations.map(async (conversation) => {
                const participants = await prisma.user.findMany({
                    where: {
                        id: {
                            in: conversation.participantIds,
                        },
                    },
                    select: {
                        id: true,
                        role: true,
                        email: true,
                        adminProfile: {
                            select: {
                                firstName: true,
                                lastName: true,
                            },
                        },
                        nurseProfile: {
                            select: {
                                firstName: true,
                                lastName: true,
                            },
                        },
                        facilityMember: {
                            select: {
                                firstName: true,
                                lastName: true,
                                jobTitle: true,
                            },
                        },
                    },
                });

                const unreadCount = await prisma.message.count({
                    where: {
                        conversationId: conversation.id,
                        senderId: {
                            not: req.user.id,
                        },
                        status: {
                            not: 'READ',
                        },
                    },
                });

                return {
                    ...conversation,
                    unreadCount,
                    participants,
                };
            })
        );

        return paginatedResponse(
            res,
            enrichedConversations,
            buildPagination(page, limit, total)
        );
    } catch (err) {
        next(err);
    }
});

// GET /messages/conversations/:conversationId  — get single conversation
router.get('/conversations/:conversationId', authenticate, async (req, res, next) => {
    try {
        const convo = await assertParticipant(req.params.conversationId, req.user.id, res);
        if (!convo) return;

        const full = await prisma.conversation.findUnique({
            where:   { id: req.params.conversationId },
            include: { messages: { orderBy: { createdAt: 'asc' }, take: 1 } }, // latest page
        });

        return successResponse(res, full);
    } catch (err) {
        next(err);
    }
});

// ─── Messages ──────────────────────────────────────────────────────────────

// GET /messages/conversations/:conversationId/messages  — paginated message history
router.get('/conversations/:conversationId/messages', authenticate, async (req, res, next) => {
    try {
        const convo = await assertParticipant(req.params.conversationId, req.user.id, res);
        if (!convo) return;

        const { page = 1, limit = 50 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);

        const [messages, total] = await Promise.all([
            prisma.message.findMany({
                where:   { conversationId: req.params.conversationId },
                orderBy: { createdAt: 'desc' },
                skip,
                take:    Number(limit),
                include: {
                    sender: {
                        select: {
                            id:           true,
                            role:         true,
                            adminProfile: { select: { firstName: true, lastName: true, avatarUrl: true } },
                            nurseProfile: { select: { firstName: true, lastName: true, avatarUrl: true } },
                        },
                    },
                },
            }),
            prisma.message.count({ where: { conversationId: req.params.conversationId } }),
        ]);

        // Attach signed URL for any attachment
        const withUrls = await Promise.all(
            messages.map(async (m) => {
                if (m.attachmentKey) {
                    return { ...m, attachmentSignedUrl: await getPrivateUrl(m.attachmentKey) };
                }
                return m;
            })
        );

        // Mark unread messages from others as READ
        await prisma.message.updateMany({
            where: {
                conversationId: req.params.conversationId,
                senderId:       { not: req.user.id },
                status:         { not: 'READ' },
            },
            data: { status: 'READ', readAt: new Date() },
        });

        return paginatedResponse(res, withUrls.reverse(), buildPagination(page, limit, total));
    } catch (err) {
        next(err);
    }
});

// POST /messages/conversations/:conversationId/messages  — send text message
router.post(
    '/conversations/:conversationId/messages',
    authenticate,
    [
        body('content')
            .if(body('attachmentKey').not().exists())
            .trim()
            .notEmpty()
            .withMessage('content is required when no attachment is provided'),
    ],
    validate,
    async (req, res, next) => {
        try {
            const convo = await assertParticipant(req.params.conversationId, req.user.id, res);
            if (!convo) return;

            const message = await prisma.message.create({
                data: {
                    conversationId: req.params.conversationId,
                    senderId:       req.user.id,
                    content:        req.body.content?.trim() || null,
                    status:         'SENT',
                },
                include: {
                    sender: {
                        select: {
                            id:           true,
                            role:         true,
                            adminProfile: { select: { firstName: true, lastName: true } },
                            nurseProfile: { select: { firstName: true, lastName: true } },
                        },
                    },
                },
            });

            // Update conversation's lastMessageAt
            await prisma.conversation.update({
                where: { id: req.params.conversationId },
                data:  { lastMessageAt: new Date() },
            });

            // Broadcast to conversation room via WebSocket
            emitToConversation(req.params.conversationId, 'new_message', message);

            // Push notification to all other participants
            const others = getOtherParticipants(convo.participantIds, req.user.id);
            await Promise.all(
                others.map((userId) =>
                    dispatchNotification({
                        userId,
                        type:     'NEW_MESSAGE',
                        title:    'New message',
                        body:     req.body.content?.slice(0, 80) || 'You have a new attachment',
                        data:     { conversationId: req.params.conversationId },
                        channels: ['PUSH'],
                    })
                )
            );

            return createdResponse(res, message, 'Message sent');
        } catch (err) {
            next(err);
        }
    }
);

// POST /messages/conversations/:conversationId/attachments  — upload file attachment
router.post(
    '/conversations/:conversationId/attachments',
    authenticate,
    attachmentUpload.single('file'),
    async (req, res, next) => {
        try {
            const convo = await assertParticipant(req.params.conversationId, req.user.id, res);
            if (!convo) return;

            if (!req.file) return errorResponse(res, 'File is required', 400);

            const signedUrl = await getPrivateUrl(req.file.key);

            const message = await prisma.message.create({
                data: {
                    conversationId: req.params.conversationId,
                    senderId:       req.user.id,
                    content:        req.body.caption?.trim() || null,
                    attachmentUrl:  req.file.location,
                    attachmentKey:  req.file.key,
                    attachmentType: req.file.mimetype,
                    status:         'SENT',
                },
            });

            await prisma.conversation.update({
                where: { id: req.params.conversationId },
                data:  { lastMessageAt: new Date() },
            });

            emitToConversation(req.params.conversationId, 'new_message', {
                ...message,
                attachmentSignedUrl: signedUrl,
            });

            const others = getOtherParticipants(convo.participantIds, req.user.id);
            await Promise.all(
                others.map((userId) =>
                    dispatchNotification({
                        userId,
                        type:     'NEW_MESSAGE',
                        title:    'New attachment',
                        body:     'You received a file attachment',
                        data:     { conversationId: req.params.conversationId },
                        channels: ['PUSH'],
                    })
                )
            );

            return createdResponse(res, { ...message, attachmentSignedUrl: signedUrl }, 'Attachment sent');
        } catch (err) {
            next(err);
        }
    }
);

// PATCH /messages/:messageId/read  — mark single message as read
router.patch('/:messageId/read', authenticate, async (req, res, next) => {
    try {
        const message = await prisma.message.findUnique({
            where:  { id: req.params.messageId },
            select: { conversationId: true, senderId: true },
        });

        if (!message) return errorResponse(res, 'Message not found', 404);

        const convo = await assertParticipant(message.conversationId, req.user.id, res);
        if (!convo) return;

        if (message.senderId === req.user.id) {
            return errorResponse(res, 'Cannot mark your own message as read', 400);
        }

        await prisma.message.update({
            where: { id: req.params.messageId },
            data:  { status: 'READ', readAt: new Date() },
        });

        // Notify sender of read receipt via socket
        emitToUser(message.senderId, 'message_read', {
            messageId:      req.params.messageId,
            conversationId: message.conversationId,
            readBy:         req.user.id,
            readAt:         new Date(),
        });

        return successResponse(res, {}, 'Message marked as read');
    } catch (err) {
        next(err);
    }
});

// GET /messages/unread-count  — total unread across all conversations
router.get('/unread-count', authenticate, async (req, res, next) => {
    try {
        const count = await prisma.message.count({
            where: {
                conversation: { participantIds: { has: req.user.id } },
                senderId:     { not: req.user.id },
                status:       { not: 'READ' },
            },
        });

        return successResponse(res, { unreadCount: count });
    } catch (err) {
        next(err);
    }
});

// DELETE /messages/:messageId  — soft-delete own message (admin or sender)
router.delete('/:messageId', authenticate, async (req, res, next) => {
    try {
        const message = await prisma.message.findUnique({
            where:  { id: req.params.messageId },
            select: { senderId: true, conversationId: true },
        });

        if (!message) return errorResponse(res, 'Message not found', 404);

        const isOwner = message.senderId === req.user.id;
        const isAdmin = req.user.role === 'SUPER_ADMIN';

        if (!isOwner && !isAdmin) {
            return errorResponse(res, 'Forbidden', 403);
        }

        // Replace content with tombstone rather than hard delete to preserve thread integrity
        await prisma.message.update({
            where: { id: req.params.messageId },
            data:  { content: null, attachmentUrl: null, attachmentKey: null },
        });

        emitToConversation(message.conversationId, 'message_deleted', {
            messageId: req.params.messageId,
        });

        return successResponse(res, {}, 'Message deleted');
    } catch (err) {
        next(err);
    }
});

module.exports = router;