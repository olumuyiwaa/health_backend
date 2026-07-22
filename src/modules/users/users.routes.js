const router = require('express').Router();
const {body, query} = require('express-validator');
const {validate} = require('../../middleware/validate');
const {authenticate, authorize} = require('../../middleware/authenticate');
const {prisma} = require('../../config/database');
const {successResponse, paginatedResponse, errorResponse, buildPagination} = require('../../utils/response');
const {createUploader, getPrivateUrl, deleteObject} = require('../../config/storage');
const {writeAuditLog} = require('../../utils/audit');
const bcrypt = require('bcryptjs');
const authService = require('../auth/auth.service');
const {sendEmail} = require("../notifications/email.service");
const {authRateLimiter} = require("../../middleware/rateLimiter");

const avatarUpload = createUploader({
    folder: 'avatars',
    allowedTypes: 'images',
    maxSizeMB: 5,
});


function isPrivateStorageKey(value) {
    return value && !/^https?:\/\//i.test(value);
}

async function attachSignedNurseAvatar(nurseProfile) {
    if (!nurseProfile?.avatarUrl) return nurseProfile;

    if (!isPrivateStorageKey(nurseProfile.avatarUrl)) {
        return nurseProfile;
    }

    const avatarKey = nurseProfile.avatarUrl;
    const signedAvatarUrl = await getPrivateUrl(avatarKey);

    return {
        ...nurseProfile,
        avatarKey,
        avatarUrl: signedAvatarUrl,
    };
}


// GET /users — admin list all users
router.get('/', authenticate, authorize('SUPER_ADMIN', 'RECRUITER'),
    async (req, res, next) => {
        try {
            const {page = 1, limit = 20, role, status, search} = req.query;
            const skip = (page - 1) * limit;

            const where = {
                ...(role ? {role} : {}),
                ...(status ? {status} : {}),
                ...(search ? {
                    OR: [
                        {email: {contains: search, mode: 'insensitive'}},
                        {
                            adminProfile: {
                                OR: [{
                                    firstName: {
                                        contains: search,
                                        mode: 'insensitive'
                                    }
                                }, {lastName: {contains: search, mode: 'insensitive'}}]
                            }
                        },
                        {
                            nurseProfile: {
                                OR: [{
                                    firstName: {
                                        contains: search,
                                        mode: 'insensitive'
                                    }
                                }, {lastName: {contains: search, mode: 'insensitive'}}]
                            }
                        },
                    ],
                } : {}),
                deletedAt: null,
            };

            const [users, total] = await Promise.all([
                prisma.user.findMany({
                    where,
                    skip: Number(skip),
                    take: Number(limit),
                    orderBy: {createdAt: 'desc'},
                    select: {
                        id: true, email: true, role: true, status: true,
                        verificationStatus: true, createdAt: true,
                        adminProfile: {select: {firstName: true, lastName: true}},
                        nurseProfile: {select: {firstName: true, lastName: true, designation: true}},
                        facilityMember: {select: {facilityId: true, jobTitle: true}},
                    },
                }),
                prisma.user.count({where}),
            ]);

            return paginatedResponse(res, users, buildPagination(page, limit, total));
        } catch (err) {
            next(err);
        }
    }
);

// POST /users
router.post('/',
    authenticate,
    authorize('SUPER_ADMIN', 'RECRUITER'),
    [
        body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),

        body('password')
            .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
            .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
            .matches(/[0-9]/).withMessage('Password must contain at least one number'),

        body('firstName').trim().notEmpty().withMessage('First name is required'),
        body('lastName').trim().notEmpty().withMessage('Last name is required'),

        body('role')
            .isIn(['NURSE', 'FACILITY_ADMIN', 'TEAM_MEMBER', 'RECRUITER', 'SUPER_ADMIN'])
            .withMessage('Invalid role selected'),

        // ✅ Fixed phone validation
        body('phone')
            .optional({ checkFalsy: true, nullable: true })
            .isMobilePhone()
            .withMessage('Invalid phone number'),

        // ✅ Better designation validation
        body('designation')
            .if(body('role').equals('NURSE'))
            .notEmpty().withMessage('Designation is required for Nurse role')
            .isIn(['RN','LVN','LPN','CNA','HHA','THERAPIST','CAREGIVER'])
            .withMessage('Valid designation is required for Nurse role'),

        body('designation')
            .if(body('role').not().equals('NURSE'))
            .optional({ checkFalsy: true, nullable: true }),
    ],
    validate,
    async (req, res, next) => {
        try {
            const result = await authService.createUserByAdmin({
                ...req.body,
                createdBy: req.user.id,
                req
            });

            return res.status(201).json({
                success: true,
                message: 'User created successfully',
                data: result
            });
        } catch (err) {
            next(err);
        }
    }
);

// GET /users/chat — list all users for the sake of messaging
router.get('/chat', authenticate,
    async (req, res, next) => {
        try {
            const {page = 1, limit = 20, search} = req.query;
            const skip = (Number(page) - 1) * Number(limit);

            const requesterId = req.user.id;
            const requesterRole = req.user.role;
            const requesterFacilityId = req.user.facilityMember?.facilityId;

            // --- Define Visibility Logic ---

            // 1. Everyone can see SUPER_ADMIN and RECRUITER
            let roleFilters = [{role: 'SUPER_ADMIN'}, {role: 'RECRUITER'}];

            if (requesterRole === 'NURSE') {
                // Nurses: Can ONLY see Super Admins, Recruiters, and other Nurses
                // (They cannot see Facility Admins or Facility Members)
                roleFilters.push({role: 'NURSE'});
            } else if (requesterRole === 'FACILITY_ADMIN' || requesterRole === 'TEAM_MEMBER') {
                // Facility users: Can see Super Admins, Recruiters, and Nurses
                roleFilters.push({role: 'NURSE'});

                // Restriction: Can only see Facility Admins/Members from their SAME facility
                if (requesterFacilityId) {
                    roleFilters.push({
                        OR: [
                            {role: 'FACILITY_ADMIN', facilityMember: {facilityId: requesterFacilityId}},
                            {role: 'TEAM_MEMBER', facilityMember: {facilityId: requesterFacilityId}}
                        ]
                    });
                }
            } else if (requesterRole === 'SUPER_ADMIN' || requesterRole === 'RECRUITER') {
                // System Admins: Can see everyone
                roleFilters = []; // No restrictions
            }

            const where = {
                // Combine the role/facility restrictions
                ...(roleFilters.length > 0 ? {OR: roleFilters} : {}),

                // Exclude the requester themselves from the search
                id: {not: requesterId},

                // Search functionality
                ...(search ? {
                    AND: [
                        {
                            OR: [
                                {email: {contains: search, mode: 'insensitive'}},
                                {
                                    adminProfile: {
                                        OR: [{
                                            firstName: {
                                                contains: search,
                                                mode: 'insensitive'
                                            }
                                        }, {lastName: {contains: search, mode: 'insensitive'}}]
                                    }
                                },
                                {
                                    nurseProfile: {
                                        OR: [{
                                            firstName: {
                                                contains: search,
                                                mode: 'insensitive'
                                            }
                                        }, {lastName: {contains: search, mode: 'insensitive'}}]
                                    }
                                },
                                {
                                    facilityMember: {
                                        OR: [{
                                            firstName: {
                                                contains: search,
                                                mode: 'insensitive'
                                            }
                                        }, {lastName: {contains: search, mode: 'insensitive'}}]
                                    }
                                },
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
                    orderBy: {createdAt: 'desc'},
                    select: {
                        id: true, email: true, role: true, status: true,
                        adminProfile: {select: {firstName: true, lastName: true}},
                        nurseProfile: {select: {firstName: true, lastName: true, designation: true}},
                        facilityMember: {select: {firstName: true, lastName: true, facilityId: true, jobTitle: true}},
                    },
                }),
                prisma.user.count({where}),
            ]);

            return paginatedResponse(res, users, buildPagination(page, limit, total));
        } catch (err) {
            next(err);
        }
    }
);

// GET /users/me — current user profile
router.get('/me', authenticate, async (req, res, next) => {
    try {
        const user = await prisma.user.findUnique({
            where: {id: req.user.id},
            select: {
                id: true, email: true, phone: true, role: true,
                status: true, verificationStatus: true,
                twoFactorEnabled: true, lastLoginAt: true,
                adminProfile: true,
                nurseProfile: {
                    include: {
                        credentials: {
                            select: {type: true, status: true, expiresAt: true},
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

        if (user?.nurseProfile) {
            user.nurseProfile = await attachSignedNurseAvatar(user.nurseProfile);
        }

        return successResponse(res, user);
    } catch (err) {
        next(err);
    }
});

// POST /users/me/avatar — upload nurse profile picture
router.post('/me/avatar',
    authenticate,
    avatarUpload.single('avatar'),
    async (req, res, next) => {
        try {
            if (req.user.role !== 'NURSE') {
                return errorResponse(res, 'Only nurses can upload a profile picture', 403);
            }

            if (!req.file) {
                return errorResponse(res, 'Profile picture file is required', 400);
            }

            const existingProfile = await prisma.nurseProfile.findUnique({
                where: {userId: req.user.id},
                select: {avatarUrl: true},
            });

            const avatarKey = req.file.key;
            const avatarUrl = await getPrivateUrl(avatarKey);

            await prisma.nurseProfile.update({
                where: {userId: req.user.id},
                data: {avatarUrl: avatarKey},
            });

            if (isPrivateStorageKey(existingProfile?.avatarUrl)) {
                await deleteObject(existingProfile.avatarUrl).catch(() => {});
            }

            await writeAuditLog({
                userId: req.user.id,
                action: 'UPDATE',
                resource: 'NurseProfile',
                resourceId: req.user.id,
                newData: {avatarKey},
                req,
            });

            return successResponse(res, {
                avatarKey,
                avatarUrl,
                expiresIn: Number(process.env.SIGNED_URL_EXPIRY) || 3600,
            }, 'Profile picture uploaded');
        } catch (err) {
            next(err);
        }
    }
);

// PATCH /users/me — update own profile
router.patch('/me', authenticate,
    [
        body('phone').optional().isMobilePhone(),
        body('firstName').optional().trim().notEmpty(),
        body('lastName').optional().trim().notEmpty(),
        body('fcmToken').optional().isString().trim(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const {
                phone,
                firstName,
                lastName,
                bio,
                designation,
                availabilityRadius,
                fcmToken,
                latitude,
                longitude
            } = req.body;
            const userId = req.user.id;

            await prisma.$transaction(async (tx) => {
                if (phone || fcmToken) {
                    await tx.user.update({
                        where: { id: userId },
                        data: {
                            ...(phone ? { phone } : {}),
                            ...(fcmToken !== undefined ? { fcmToken: fcmToken.trim() || null } : {}),
                        },
                    });
                }
                if (req.user.role === 'NURSE') {
                    await tx.nurseProfile.update({
                        where: {userId},
                        data: {
                            ...(firstName ? {firstName} : {}),
                            ...(lastName ? {lastName} : {}),
                            ...(bio !== undefined ? {bio} : {}),
                            ...(designation ? {designation} : {}),
                            ...(availabilityRadius !== undefined ? {availabilityRadius: Number(availabilityRadius)} : {}),
                            ...(latitude !== undefined ? {latitude: Number(latitude)} : {}),
                            ...(longitude !== undefined ? {longitude: Number(longitude)} : {}),
                        },
                    });
                } else {
                    if (firstName || lastName) {
                        await tx.adminProfile.upsert({
                            where: {userId},
                            create: {userId, firstName: firstName || '', lastName: lastName || ''},
                            update: {...(firstName ? {firstName} : {}), ...(lastName ? {lastName} : {})},
                        });
                    }
                }
            });

            return successResponse(res, {}, 'Profile updated');
        } catch (err) {
            next(err);
        }
    }
);

// PATCH /users/me/password — change password
router.patch('/me/password', authenticate,
    [
        body('currentPassword').notEmpty(),
        body('newPassword').isLength({min: 8}).matches(/[A-Z]/).matches(/[0-9]/),
    ],
    validate,
    async (req, res, next) => {
        try {
            const user = await prisma.user.findUnique({where: {id: req.user.id}});
            const valid = await bcrypt.compare(req.body.currentPassword, user.passwordHash);
            if (!valid) return errorResponse(res, 'Current password is incorrect', 400);

            const newHash = await bcrypt.hash(req.body.newPassword, 12);
            await prisma.user.update({where: {id: req.user.id}, data: {passwordHash: newHash}});

            await writeAuditLog({
                userId: req.user.id,
                action: 'UPDATE',
                resource: 'User',
                resourceId: req.user.id,
                req
            });

            return successResponse(res, {}, 'Password updated');
        } catch (err) {
            next(err);
        }
    }
);


// GET /users/audit-logs — admin audit trail
router.get('/admin/audit-logs', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const {page = 1, limit = 50, resource, userId: filterUserId} = req.query;
        const skip = (page - 1) * limit;

        const where = {
            ...(resource ? {resource} : {}),
            ...(filterUserId ? {userId: filterUserId} : {}),
        };

        const [logs, total] = await Promise.all([
            prisma.auditLog.findMany({
                where,
                orderBy: {createdAt: 'desc'},
                skip: Number(skip),
                take: Number(limit),
                include: {user: {select: {email: true, role: true}}},
            }),
            prisma.auditLog.count({where}),
        ]);

        return paginatedResponse(res, logs, buildPagination(page, limit, total));
    } catch (err) {
        next(err);
    }
});

// GET /users/:id — admin get any user
router.get('/:id', authenticate, authorize('SUPER_ADMIN', 'RECRUITER'), async (req, res, next) => {
    try {
        const user = await prisma.user.findUnique({
            where: {id: req.params.id},
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
                    where: {isActive: true},
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

        if (user?.nurseProfile) {
            user.nurseProfile = await attachSignedNurseAvatar(user.nurseProfile);
        }

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
                where: {id: req.params.id},
                data: {status: 'SUSPENDED'},
            });
            await writeAuditLog({
                userId: req.user.id,
                action: 'SUSPEND',
                resource: 'User',
                resourceId: req.params.id,
                newData: {reason: req.body.reason},
                req
            });
            return successResponse(res, {}, 'User suspended');
        } catch (err) {
            next(err);
        }
    }
);

// PATCH /users/:id/restore
router.patch('/:id/restore', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
    try {
        await prisma.user.update({
            where: {id: req.params.id},
            data: {status: 'ACTIVE'},
        });
        await writeAuditLog({
            userId: req.user.id,
            action: 'RESTORE',
            resource: 'User',
            resourceId: req.params.id,
            newData: {status: 'ACTIVE'},
            req
        });
        return successResponse(res, {}, 'User restored');
    } catch (err) {
        next(err);
    }
});

// DELETE /users/me — self-initiated account deletion
// Requires password confirmation to prevent accidental or unauthorised deletion.
// Does NOT immediately purge data — marks as DEACTIVATED with a scheduledDeletionAt
// 30 days out so the platform can cancel if the user changes their mind.
// A nightly job (or cron) is responsible for hard-deleting after that window.
router.delete('/me',
    authenticate,
    authRateLimiter,
    [
        body('password').notEmpty().withMessage('Password confirmation is required'),
        body('reason').optional().trim().isLength({ max: 500 }),
    ],
    validate,
    async (req, res, next) => {
        try {
            const { password, reason } = req.body;
            const userId = req.user.id;

            // 1. Fetch user
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    email: true,
                    role: true,
                    status: true,
                    passwordHash: true
                },
            });

            if (!user) return errorResponse(res, 'User not found', 404);
            if (user.status === 'DEACTIVATED') return errorResponse(res, 'Account is already deactivated', 400);
            if (user.role === 'SUPER_ADMIN') {
                return errorResponse(res, 'Super admin accounts cannot be self-deleted. Contact another super admin.', 403);
            }

            // 2. Verify password
            const passwordValid = await bcrypt.compare(password, user.passwordHash);
            if (!passwordValid) {
                return errorResponse(res, 'Incorrect password. Please try again.', 401);
            }

            const scheduledDeletionAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

            // 3. Role-specific cleanup + soft delete in a transaction
            await prisma.$transaction(async (tx) => {
                // Nurse-specific cleanup
                if (user.role === 'NURSE') {
                    const nurseProfile = await tx.nurseProfile.findUnique({
                        where: { userId },
                        select: { id: true },
                    });

                    if (nurseProfile) {
                        const upcomingAssignments = await tx.shiftAssignment.findMany({
                            where: {
                                nurseProfileId: nurseProfile.id,
                                status: 'ACCEPTED',
                                shift: { scheduledStart: { gt: new Date() } },
                            },
                            select: { id: true, shiftId: true },
                        });

                        if (upcomingAssignments.length > 0) {
                            const assignmentIds = upcomingAssignments.map(a => a.id);
                            const shiftIds = upcomingAssignments.map(a => a.shiftId);

                            await tx.shiftAssignment.updateMany({
                                where: { id: { in: assignmentIds } },
                                data: {
                                    status: 'CANCELLED',
                                    cancelledAt: new Date(),
                                    cancelReason: 'Nurse account deletion'
                                },
                            });

                            await tx.shift.updateMany({
                                where: {
                                    id: { in: shiftIds },
                                    status: 'BOOKED'
                                },
                                data: { status: 'OPEN' },
                            });
                        }

                        // Mark unavailable immediately
                        await tx.nurseProfile.update({
                            where: { id: nurseProfile.id },
                            data: { isAvailable: false },
                        });
                    }
                }

                // Revoke all active sessions
                await tx.session.updateMany({
                    where: { userId, isActive: true },
                    data: {
                        isActive: false,
                        revokedAt: new Date()
                    },
                });

                // Soft delete user
                await tx.user.update({
                    where: { id: userId },
                    data: {
                        status: 'DEACTIVATED',
                        deletedAt: new Date(),
                        scheduledDeletionAt,
                    },
                });
            });

            // 4. Audit log (outside transaction for flexibility)
            await writeAuditLog({
                userId,
                action: 'DELETE',
                resource: 'User',
                resourceId: userId,
                newData: {
                    initiatedBy: 'self',
                    reason: reason || null,
                    status: 'DEACTIVATED',
                    sessionsRevoked: true,
                    scheduledDeletionAt: scheduledDeletionAt.toISOString(),
                },
                req,
            });

            // 5. Send confirmation email (fire-and-forget)
            sendEmail({
                to: user.email,
                subject: 'Your Trabajo Hub account has been deactivated',
                html: `
                    <h2>Account Deactivation Confirmed</h2>
                    <p>Your account has been deactivated as requested.</p>
                    <p>Your data will be permanently deleted on <strong>${scheduledDeletionAt.toLocaleDateString('en-US', { dateStyle: 'long' })}</strong>.</p>
                    <p>If this was a mistake, contact us at 
                       <a href="mailto:support@trabajohub.com">support@trabajohub.com</a> 
                       within 30 days to restore your account.</p>
                `,
            }).catch(console.error);

            return successResponse(res, {
                message: 'Account deactivated. You have been signed out of all devices.',
                scheduledDeletionAt: scheduledDeletionAt.toISOString(),
                gracePeriodDays: 30,
            }, 'Account deactivated successfully');

        } catch (err) {
            next(err);
        }
    }
);

// DELETE /users/:id — soft delete
router.delete('/:id', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
    try {
        await prisma.user.update({
            where: {id: req.params.id},
            data: {deletedAt: new Date(), status: 'DEACTIVATED'},
        });
        await writeAuditLog({
            userId: req.user.id,
            action: 'DELETE',
            resource: 'User',
            resourceId: req.params.id,
            newData: {status: 'DEACTIVATED', deletedAt: new Date().toISOString()},
            req
        });
        return successResponse(res, {}, 'User deactivated');
    } catch (err) {
        next(err);
    }
});


module.exports = router;