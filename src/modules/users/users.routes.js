const router = require('express').Router();
const { body, query } = require('express-validator');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { prisma } = require('../../config/database');
const { successResponse, paginatedResponse, errorResponse, buildPagination } = require('../../utils/response');
const { writeAuditLog } = require('../../utils/audit');
const bcrypt = require('bcryptjs');

// GET /users — admin list all users
router.get('/', authenticate, authorize('SUPER_ADMIN', 'RECRUITER'),
    async (req, res, next) => {
        try {
            const { page = 1, limit = 20, role, status, search } = req.query;
            const skip = (page - 1) * limit;

            const where = {
                ...(role   ? { role }   : {}),
                ...(status ? { status } : {}),
                ...(search ? {
                    OR: [
                        { email: { contains: search, mode: 'insensitive' } },
                        { adminProfile:  { OR: [{ firstName: { contains: search, mode: 'insensitive' } }, { lastName: { contains: search, mode: 'insensitive' } }] } },
                        { nurseProfile:  { OR: [{ firstName: { contains: search, mode: 'insensitive' } }, { lastName: { contains: search, mode: 'insensitive' } }] } },
                    ],
                } : {}),
                deletedAt: null,
            };

            const [users, total] = await Promise.all([
                prisma.user.findMany({
                    where,
                    skip: Number(skip),
                    take: Number(limit),
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true, email: true, role: true, status: true,
                        verificationStatus: true, createdAt: true,
                        adminProfile:  { select: { firstName: true, lastName: true } },
                        nurseProfile:  { select: { firstName: true, lastName: true, designation: true } },
                        facilityMember:{ select: { facilityId: true, jobTitle: true } },
                    },
                }),
                prisma.user.count({ where }),
            ]);

            return paginatedResponse(res, users, buildPagination(page, limit, total));
        } catch (err) { next(err); }
    }
);

router.get('/chat', authenticate,
    async (req, res, next) => {
        try {
            const { page = 1, limit = 20, search } = req.query;
            const skip = (Number(page) - 1) * Number(limit);

            const requesterId = req.user.id;
            const requesterRole = req.user.role;
            const requesterFacilityId = req.user.facilityMember?.facilityId;

            // --- Define Visibility Logic ---

            // 1. Everyone can see SUPER_ADMIN and RECRUITER
            let roleFilters = [{ role: 'SUPER_ADMIN' }, { role: 'RECRUITER' }];

            if (requesterRole === 'NURSE') {
                // Nurses: Can ONLY see Super Admins, Recruiters, and other Nurses
                // (They cannot see Facility Admins or Facility Members)
                roleFilters.push({ role: 'NURSE' });
            }
            else if (requesterRole === 'FACILITY_ADMIN' || requesterRole === 'TEAM_MEMBER') {
                // Facility users: Can see Super Admins, Recruiters, and Nurses
                roleFilters.push({ role: 'NURSE' });

                // Restriction: Can only see Facility Admins/Members from their SAME facility
                if (requesterFacilityId) {
                    roleFilters.push({
                        OR: [
                            { role: 'FACILITY_ADMIN', facilityMember: { facilityId: requesterFacilityId } },
                            { role: 'TEAM_MEMBER', facilityMember: { facilityId: requesterFacilityId } }
                        ]
                    });
                }
            }
            else if (requesterRole === 'SUPER_ADMIN' || requesterRole === 'RECRUITER') {
                // System Admins: Can see everyone
                roleFilters = []; // No restrictions
            }

            const where = {
                // Combine the role/facility restrictions
                ...(roleFilters.length > 0 ? { OR: roleFilters } : {}),

                // Exclude the requester themselves from the search
                id: { not: requesterId },

                // Search functionality
                ...(search ? {
                    AND: [
                        {
                            OR: [
                                { email: { contains: search, mode: 'insensitive' } },
                                { adminProfile: { OR: [{ firstName: { contains: search, mode: 'insensitive' } }, { lastName: { contains: search, mode: 'insensitive' } }] } },
                                { nurseProfile: { OR: [{ firstName: { contains: search, mode: 'insensitive' } }, { lastName: { contains: search, mode: 'insensitive' } }] } },
                                { facilityMember: { OR: [{ firstName: { contains: search, mode: 'insensitive' } }, { lastName: { contains: search, mode: 'insensitive' } }] } },
                            ]
                        }
                    ]
                } : {}),
                deletedAt: null,
                status: 'ACTIVE' // Usually you only want to chat with active users
            };

            const [users, total] = await Promise.all([
                prisma.user.findMany({
                    where,
                    skip: Number(skip),
                    take: Number(limit),
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true, email: true, role: true, status: true,
                        adminProfile:  { select: { firstName: true, lastName: true } },
                        nurseProfile:  { select: { firstName: true, lastName: true, designation: true } },
                        facilityMember:{ select: { firstName: true, lastName: true, facilityId: true, jobTitle: true } },
                    },
                }),
                prisma.user.count({ where }),
            ]);

            return paginatedResponse(res, users, buildPagination(page, limit, total));
        } catch (err) { next(err); }
    }
);

// GET /users/me — current user profile
router.get('/me', authenticate, async (req, res, next) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: {
                id: true, email: true, phone: true, role: true,
                status: true, verificationStatus: true,
                twoFactorEnabled: true, lastLoginAt: true,
                adminProfile:  true,
                nurseProfile: {
                    include: {
                        credentials: {
                            select: { type: true, status: true, expiresAt: true },
                        },
                        wallet: true,
                    },
                },
                facilityMember: {
                    select: {
                        facilityId: true,
                        firstName: true,
                        lastName: true,
                        jobTitle: true,
                    },
                },
            },
        });
        return successResponse(res, user);
    } catch (err) { next(err); }
});

// PATCH /users/me — update own profile
router.patch('/me', authenticate,
    [
        body('phone').optional().isMobilePhone(),
        body('firstName').optional().trim().notEmpty(),
        body('lastName').optional().trim().notEmpty(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const { phone, firstName, lastName, bio, designation, availabilityRadius, fcmToken, latitude, longitude } = req.body;
            const userId = req.user.id;

            await prisma.$transaction(async (tx) => {
                if (phone) await tx.user.update({ where: { id: userId }, data: { phone } });

                if (req.user.role === 'NURSE') {
                    await tx.nurseProfile.update({
                        where: { userId },
                        data: {
                            ...(firstName ? { firstName } : {}),
                            ...(lastName  ? { lastName  } : {}),
                            ...(bio !== undefined ? { bio } : {}),
                            ...(designation ? { designation } : {}),
                            ...(availabilityRadius !== undefined ? { availabilityRadius: Number(availabilityRadius) } : {}),
                            ...(fcmToken ? { fcmToken } : {}),
                            ...(latitude  !== undefined ? { latitude:  Number(latitude)  } : {}),
                            ...(longitude !== undefined ? { longitude: Number(longitude) } : {}),
                        },
                    });
                } else {
                    if (firstName || lastName) {
                        await tx.adminProfile.upsert({
                            where:  { userId },
                            create: { userId, firstName: firstName || '', lastName: lastName || '' },
                            update: { ...(firstName ? { firstName } : {}), ...(lastName ? { lastName } : {}) },
                        });
                    }
                }
            });

            return successResponse(res, {}, 'Profile updated');
        } catch (err) { next(err); }
    }
);

// PATCH /users/me/password — change password
router.patch('/me/password', authenticate,
    [
        body('currentPassword').notEmpty(),
        body('newPassword').isLength({ min: 8 }).matches(/[A-Z]/).matches(/[0-9]/),
    ],
    validate,
    async (req, res, next) => {
        try {
            const user = await prisma.user.findUnique({ where: { id: req.user.id } });
            const valid = await bcrypt.compare(req.body.currentPassword, user.passwordHash);
            if (!valid) return errorResponse(res, 'Current password is incorrect', 400);

            const newHash = await bcrypt.hash(req.body.newPassword, 12);
            await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: newHash } });

            await writeAuditLog({ userId: req.user.id, action: 'UPDATE', resource: 'User', resourceId: req.user.id, req });

            return successResponse(res, {}, 'Password updated');
        } catch (err) { next(err); }
    }
);


// GET /users/audit-logs — admin audit trail
router.get('/admin/audit-logs', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const { page = 1, limit = 50, resource, userId: filterUserId } = req.query;
        const skip = (page - 1) * limit;

        const where = {
            ...(resource    ? { resource }         : {}),
            ...(filterUserId ? { userId: filterUserId } : {}),
        };

        const [logs, total] = await Promise.all([
            prisma.auditLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: Number(skip),
                take: Number(limit),
                include: { user: { select: { email: true, role: true } } },
            }),
            prisma.auditLog.count({ where }),
        ]);

        return paginatedResponse(res, logs, buildPagination(page, limit, total));
    } catch (err) { next(err); }
});

// GET /users/:id — admin get any user
router.get('/:id', authenticate, authorize('SUPER_ADMIN', 'RECRUITER'), async (req, res, next) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.params.id },
            select: {
                id: true,
                email: true,
                phone: true,
                role: true,
                status: true,
                verificationStatus: true,
                emailVerifiedAt: true,
                phoneVerifiedAt: true,
                twoFactorEnabled: true,
                lastLoginAt: true,
                createdAt: true,
                updatedAt: true,

                adminProfile: true,

                nurseProfile: {
                    include: {
                        credentials: true,
                        wallet: true,
                    },
                },

                facilityMember: {
                    include: {
                        facility: true,
                    },
                },

                sessions: {
                    where: { isActive: true },
                    select: {
                        id: true,
                        deviceModel: true,
                        ipAddress: true,
                        createdAt: true,
                    },
                },
            },
        });

        if (!user) return errorResponse(res, 'User not found', 404);

        return successResponse(res, user);
    } catch (err) {
        next(err);
    }
});

// PATCH /users/:id/suspend — suspend account
router.patch('/:id/suspend', authenticate, authorize('SUPER_ADMIN'),
    [body('reason').optional().trim()],
    validate,
    async (req, res, next) => {
        try {
            await prisma.user.update({
                where: { id: req.params.id },
                data:  { status: 'SUSPENDED' },
            });
            await writeAuditLog({ userId: req.user.id, action: 'SUSPEND', resource: 'User', resourceId: req.params.id, newData: { reason: req.body.reason }, req });
            return successResponse(res, {}, 'User suspended');
        } catch (err) { next(err); }
    }
);

// PATCH /users/:id/restore
router.patch('/:id/restore', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
    try {
        await prisma.user.update({
            where: { id: req.params.id },
            data:  { status: 'ACTIVE' },
        });
        await writeAuditLog({ userId: req.user.id, action: 'RESTORE', resource: 'User', resourceId: req.params.id, req });
        return successResponse(res, {}, 'User restored');
    } catch (err) { next(err); }
});

// DELETE /users/:id — soft delete
router.delete('/:id', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
    try {
        await prisma.user.update({
            where: { id: req.params.id },
            data:  { deletedAt: new Date(), status: 'DEACTIVATED' },
        });
        await writeAuditLog({ userId: req.user.id, action: 'DELETE', resource: 'User', resourceId: req.params.id, req });
        return successResponse(res, {}, 'User deactivated');
    } catch (err) { next(err); }
});

module.exports = router;