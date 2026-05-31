const router = require('express').Router();
const { authenticate } = require('../../middleware/authenticate');
const { prisma } = require('../../config/database');
const { successResponse, paginatedResponse, buildPagination } = require('../../utils/response');

// GET /notifications — list my notifications
router.get('/', authenticate, async (req, res, next) => {
    try {
        const { page = 1, limit = 20, unreadOnly } = req.query;
        const skip = (page - 1) * limit;

        const where = {
            userId: req.user.id,
            ...(unreadOnly === 'true' ? { isRead: false } : {}),
        };

        const [items, total] = await Promise.all([
            prisma.notification.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: Number(skip),
                take: Number(limit),
            }),
            prisma.notification.count({ where }),
        ]);

        return paginatedResponse(res, items, buildPagination(page, limit, total));
    } catch (err) { next(err); }
});

// PATCH /notifications/read-all
router.patch('/read-all', authenticate, async (req, res, next) => {
    try {
        await prisma.notification.updateMany({
            where: { userId: req.user.id, isRead: false },
            data:  { isRead: true, readAt: new Date() },
        });
        return successResponse(res, {}, 'All notifications marked as read');
    } catch (err) { next(err); }
});

// PATCH /notifications/:id/read
router.patch('/:id/read', authenticate, async (req, res, next) => {
    try {
        await prisma.notification.updateMany({
            where: { id: req.params.id, userId: req.user.id },
            data:  { isRead: true, readAt: new Date() },
        });
        return successResponse(res, {}, 'Notification marked as read');
    } catch (err) { next(err); }
});

module.exports = router;