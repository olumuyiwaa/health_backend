const router = require('express').Router();
const { body, param } = require('express-validator');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { uploadRateLimiter } = require('../../middleware/rateLimiter');
const { createUploader, getPrivateUrl, deleteObject } = require('../../config/storage');
const { prisma } = require('../../config/database');
const { successResponse, createdResponse, errorResponse, paginatedResponse, buildPagination } = require('../../utils/response');
const { writeAuditLog } = require('../../utils/audit');
const { dispatchNotification } = require('../notifications/notifications.service');

const upload = createUploader({ folder: 'credentials', allowedTypes: 'documents', maxSizeMB: 15 });

// POST /credentials — nurse uploads a credential
router.post('/',
    authenticate,
    authorize('NURSE'),
    uploadRateLimiter,
    upload.single('file'),
    [
        body('type').isIn(['STATE_LICENSE','CPR_CERTIFICATION','TB_TEST','BACKGROUND_CHECK','GOVERNMENT_ID','OIG_CHECK','SAM_CHECK','IMMUNIZATION','WORK_AUTHORIZATION','CUSTOM']),
        body('customLabel').optional().trim(),
        body('issuedAt').optional().isISO8601(),
        body('expiresAt').optional().isISO8601(),
    ],
    validate,
    async (req, res, next) => {
        try {
            if (!req.file) return errorResponse(res, 'File is required', 400);

            const nurseProfile = await prisma.nurseProfile.findUnique({
                where: { userId: req.user.id },
                select: { id: true },
            });

            if (!nurseProfile) return errorResponse(res, 'Nurse profile not found', 404);

            const { type, customLabel, issuedAt, expiresAt } = req.body;

            const credential = await prisma.credential.create({
                data: {
                    nurseProfileId: nurseProfile.id,
                    type,
                    customLabel:    customLabel || null,
                    fileUrl:        req.file.location,
                    fileKey:        req.file.key,
                    issuedAt:       issuedAt  ? new Date(issuedAt)  : null,
                    expiresAt:      expiresAt ? new Date(expiresAt) : null,
                    status:         'PENDING',
                },
            });

            await writeAuditLog({ userId: req.user.id, action: 'UPLOAD', resource: 'Credential', resourceId: credential.id, newData: { type: credential.type, status: 'PENDING', fileKey: credential.fileKey }, req });

            return createdResponse(res, credential, 'Credential uploaded and pending review');
        } catch (err) { next(err); }
    }
);

// GET /credentials/mine — nurse's own credentials
router.get('/mine', authenticate, authorize('NURSE'), async (req, res, next) => {
    try {
        const nurseProfile = await prisma.nurseProfile.findUnique({
            where: { userId: req.user.id },
            select: { id: true },
        });

        const credentials = await prisma.credential.findMany({
            where: { nurseProfileId: nurseProfile.id },
            orderBy: { createdAt: 'desc' },
        });

        // Attach signed URLs for download
        const withUrls = await Promise.all(
            credentials.map(async (c) => ({
                ...c,
                downloadUrl: await getPrivateUrl(c.fileKey),
            }))
        );

        return successResponse(res, withUrls);
    } catch (err) { next(err); }
});

// GET /credentials — admin: all pending credentials
router.get('/', authenticate, authorize('SUPER_ADMIN', 'RECRUITER'), async (req, res, next) => {
    try {
        const { page = 1, limit = 20, status, type } = req.query;
        const skip = (page - 1) * limit;

        const where = {
            ...(status ? { status } : {}),
            ...(type   ? { type }   : {}),
        };

        const [items, total] = await Promise.all([
            prisma.credential.findMany({
                where,
                skip: Number(skip),
                take: Number(limit),
                orderBy: { createdAt: 'desc' },
                include: {
                    nurseProfile: {
                        include: {
                            user: { select: { email: true } },
                        },
                    },
                },
            }),
            prisma.credential.count({ where }),
        ]);

        return paginatedResponse(res, items, buildPagination(page, limit, total));
    } catch (err) { next(err); }
});

// GET /credentials/:id — get one with signed URL
router.get('/:id', authenticate, async (req, res, next) => {
    try {
        const credential = await prisma.credential.findUnique({ where: { id: req.params.id } });
        if (!credential) return errorResponse(res, 'Credential not found', 404);

        // Nurses can only see their own
        if (req.user.role === 'NURSE') {
            const np = await prisma.nurseProfile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
            if (credential.nurseProfileId !== np.id) return errorResponse(res, 'Forbidden', 403);
        }

        const downloadUrl = await getPrivateUrl(credential.fileKey);
        return successResponse(res, { ...credential, downloadUrl });
    } catch (err) { next(err); }
});

// PATCH /credentials/:id/approve — admin approves
router.patch('/:id/approve', authenticate, authorize('SUPER_ADMIN', 'RECRUITER'), async (req, res, next) => {
    try {
        const credential = await prisma.credential.update({
            where: { id: req.params.id },
            data: {
                status:       'APPROVED',
                reviewedById: req.user.id,
                reviewedAt:   new Date(),
            },
            include: { nurseProfile: { include: { user: { select: { id: true, email: true } } } } },
        });

        await writeAuditLog({ userId: req.user.id, action: 'APPROVE', resource: 'Credential', resourceId: credential.id, newData: { status: 'APPROVED', type: credential.type, nurseProfileId: credential.nurseProfileId }, req });

        await dispatchNotification({
            userId:   credential.nurseProfile.user.id,
            type:     'CREDENTIAL_APPROVED',
            title:    'Credential Approved',
            body:     `Your ${credential.type.replace(/_/g, ' ')} has been approved.`,
            channels: ['EMAIL', 'PUSH'],
        });

        return successResponse(res, credential, 'Credential approved');
    } catch (err) { next(err); }
});

// PATCH /credentials/:id/reject
router.patch('/:id/reject', authenticate, authorize('SUPER_ADMIN', 'RECRUITER'),
    [body('reason').trim().notEmpty()],
    validate,
    async (req, res, next) => {
        try {
            const credential = await prisma.credential.update({
                where: { id: req.params.id },
                data: {
                    status:          'REJECTED',
                    rejectionReason: req.body.reason,
                    reviewedById:    req.user.id,
                    reviewedAt:      new Date(),
                },
                include: { nurseProfile: { include: { user: { select: { id: true } } } } },
            });

            await writeAuditLog({ userId: req.user.id, action: 'REJECT', resource: 'Credential', resourceId: credential.id, newData: { status: 'REJECTED', reason: req.body.reason, type: credential.type }, req });

            await dispatchNotification({
                userId:   credential.nurseProfile.user.id,
                type:     'CREDENTIAL_REJECTED',
                title:    'Credential Rejected',
                body:     `Your ${credential.type.replace(/_/g, ' ')} was rejected. Reason: ${req.body.reason}`,
                channels: ['EMAIL', 'PUSH'],
            });

            return successResponse(res, {}, 'Credential rejected');
        } catch (err) { next(err); }
    }
);

// DELETE /credentials/:id — nurse removes own credential
router.delete('/:id', authenticate, authorize('NURSE'), async (req, res, next) => {
    try {
        const np = await prisma.nurseProfile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
        const cred = await prisma.credential.findFirst({
            where: { id: req.params.id, nurseProfileId: np.id },
        });

        if (!cred) return errorResponse(res, 'Credential not found', 404);
        if (cred.status === 'APPROVED') return errorResponse(res, 'Cannot delete an approved credential', 400);

        await deleteObject(cred.fileKey);
        await prisma.credential.delete({ where: { id: cred.id } });

        return successResponse(res, {}, 'Credential deleted');
    } catch (err) { next(err); }
});

// GET /credentials/expiry-alerts — admin: credentials expiring in N days
router.get('/admin/expiry-alerts', authenticate, authorize('SUPER_ADMIN', 'RECRUITER'), async (req, res, next) => {
    try {
        const days = Number(req.query.days) || 30;
        const threshold = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

        const expiring = await prisma.credential.findMany({
            where: {
                status:    'APPROVED',
                expiresAt: { lte: threshold, gte: new Date() },
            },
            include: {
                nurseProfile: {
                    select: { firstName: true, lastName: true, user: { select: { email: true } } },
                },
            },
            orderBy: { expiresAt: 'asc' },
        });

        return successResponse(res, expiring);
    } catch (err) { next(err); }
});

module.exports = router;