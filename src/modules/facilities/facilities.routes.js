const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize, requireFacilityAccess } = require('../../middleware/authenticate');
const { prisma } = require('../../config/database');
const { successResponse, createdResponse, errorResponse, paginatedResponse, buildPagination } = require('../../utils/response');
const { writeAuditLog } = require('../../utils/audit');
const { createUploader, getPrivateUrl } = require('../../config/storage');
const authService = require('../auth/auth.service');

const logoUpload = createUploader({ folder: 'facility-logos', allowedTypes: 'images', maxSizeMB: 5 });

// ─── Facility CRUD ─────────────────────────────

// POST /facilities — admin creates a facility
router.post('/',
    authenticate, authorize('SUPER_ADMIN'),
    [
        body('name').trim().notEmpty(),
        body('email').isEmail().normalizeEmail(),
        body('phone').optional().isMobilePhone(),
        body('taxId').optional().trim(),
        body('npiNumber').optional().trim(),
        // Admin account to create
        body('adminFirstName').trim().notEmpty(),
        body('adminLastName').trim().notEmpty(),
        body('adminPassword').isLength({ min: 8 }),
    ],
    validate,
    async (req, res, next) => {
        try {
            const { name, email, phone, taxId, npiNumber, adminFirstName, adminLastName, adminPassword } = req.body;

            const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now();

            const result = await prisma.$transaction(async (tx) => {
                const facility = await tx.facility.create({
                    data: { name, slug, email, phone, taxId, npiNumber, status: 'ACTIVE' },
                });

                // Create the facility admin user
                const adminUser = await authService.registerUser({
                    email:     email,
                    password:  adminPassword,
                    firstName: adminFirstName,
                    lastName:  adminLastName,
                    role:      'FACILITY_ADMIN',
                    req:       {},
                });

                // Link them as facility member
                await tx.facilityMember.create({
                    data: {
                        facilityId: facility.id,
                        userId:     adminUser.id,
                        firstName:  adminFirstName,
                        lastName:   adminLastName,
                        jobTitle:   'Facility Administrator',
                    },
                });

                return facility;
            });

            await writeAuditLog({ userId: req.user.id, action: 'CREATE', resource: 'Facility', resourceId: result.id, req });
            return createdResponse(res, result, 'Facility created');
        } catch (err) { next(err); }
    }
);

// GET /facilities — admin list all facilities
router.get('/', authenticate, authorize('SUPER_ADMIN', 'RECRUITER'), async (req, res, next) => {
    try {
        const { page = 1, limit = 20, status, search } = req.query;
        const skip = (page - 1) * limit;

        const where = {
            deletedAt: null,
            ...(status ? { status } : {}),
            ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
        };

        const [facilities, total] = await Promise.all([
            prisma.facility.findMany({
                where,
                skip: Number(skip),
                take: Number(limit),
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true, name: true, email: true, phone: true,
                    status: true, logoUrl: true, createdAt: true,
                    _count: { select: { members: true, cases: true } },
                },
            }),
            prisma.facility.count({ where }),
        ]);

        return paginatedResponse(res, facilities, buildPagination(page, limit, total));
    } catch (err) { next(err); }
});

// GET /facilities/:id
router.get('/:id', authenticate, async (req, res, next) => {
    try {
        // Non-admins can only see their own facility
        if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'RECRUITER') {
            if (req.user.facilityMember?.facilityId !== req.params.id) {
                return errorResponse(res, 'Forbidden', 403);
            }
        }

        const facility = await prisma.facility.findUnique({
            where: { id: req.params.id },
            include: {
                addresses:           true,
                billingInfo:         true,
                staffingPreferences: true,
                notificationPrefs:   true,
                requirements:        true,
                members: {
                    include: { user: { select: { email: true, status: true } } },
                },
            },
        });

        if (!facility) return errorResponse(res, 'Facility not found', 404);
        return successResponse(res, facility);
    } catch (err) { next(err); }
});

// PATCH /facilities/:id — update facility info
router.patch('/:id', authenticate, requireFacilityAccess,
    [
        body('name').optional().trim().notEmpty(),
        body('phone').optional().isMobilePhone(),
        body('taxId').optional().trim(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const allowed = ['name', 'phone', 'taxId', 'npiNumber'];
            const data = Object.fromEntries(
                Object.entries(req.body).filter(([k]) => allowed.includes(k))
            );

            const facility = await prisma.facility.update({ where: { id: req.params.id }, data });
            await writeAuditLog({ userId: req.user.id, action: 'UPDATE', resource: 'Facility', resourceId: facility.id, newData: data, req });
            return successResponse(res, facility, 'Facility updated');
        } catch (err) { next(err); }
    }
);

// POST /facilities/:id/logo — upload logo
router.post('/:id/logo', authenticate, requireFacilityAccess, logoUpload.single('logo'), async (req, res, next) => {
    try {
        if (!req.file) return errorResponse(res, 'Logo file required', 400);
        const url = await getPrivateUrl(req.file.key);
        await prisma.facility.update({ where: { id: req.params.id }, data: { logoUrl: req.file.location } });
        return successResponse(res, { logoUrl: req.file.location, signedUrl: url });
    } catch (err) { next(err); }
});

// ─── Addresses ─────────────────────────────────

router.post('/:id/addresses', authenticate, requireFacilityAccess,
    [
        body('label').optional().trim(),
        body('addressLine1').trim().notEmpty(),
        body('city').trim().notEmpty(),
        body('state').trim().notEmpty(),
        body('zipCode').trim().notEmpty(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const addr = await prisma.facilityAddress.create({
                data: { ...req.body, facilityId: req.params.id },
            });
            return createdResponse(res, addr);
        } catch (err) { next(err); }
    }
);

router.patch('/:id/addresses/:addrId', authenticate, requireFacilityAccess, async (req, res, next) => {
    try {
        const addr = await prisma.facilityAddress.update({
            where: { id: req.params.addrId },
            data:  req.body,
        });
        return successResponse(res, addr);
    } catch (err) { next(err); }
});

router.delete('/:id/addresses/:addrId', authenticate, requireFacilityAccess, async (req, res, next) => {
    try {
        await prisma.facilityAddress.delete({ where: { id: req.params.addrId } });
        return successResponse(res, {}, 'Address deleted');
    } catch (err) { next(err); }
});

// ─── Billing Info ──────────────────────────────

router.put('/:id/billing', authenticate, requireFacilityAccess,
    [
        body('billingName').trim().notEmpty(),
        body('billingEmail').isEmail(),
        body('addressLine1').trim().notEmpty(),
        body('city').trim().notEmpty(),
        body('state').trim().notEmpty(),
        body('zipCode').trim().notEmpty(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const billing = await prisma.facilityBilling.upsert({
                where:  { facilityId: req.params.id },
                create: { ...req.body, facilityId: req.params.id },
                update: req.body,
            });
            return successResponse(res, billing);
        } catch (err) { next(err); }
    }
);

// ─── Workplace Requirements ────────────────────

router.get('/:id/requirements', authenticate, async (req, res, next) => {
    try {
        const reqs = await prisma.workplaceRequirement.findMany({
            where: { facilityId: req.params.id },
        });
        return successResponse(res, reqs);
    } catch (err) { next(err); }
});

router.post('/:id/requirements', authenticate, requireFacilityAccess,
    [
        body('credentialType').isIn(['STATE_LICENSE','CPR_CERTIFICATION','TB_TEST','BACKGROUND_CHECK','GOVERNMENT_ID','OIG_CHECK','SAM_CHECK','IMMUNIZATION','WORK_AUTHORIZATION','CUSTOM']),
        body('isMandatory').optional().isBoolean(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const req_ = await prisma.workplaceRequirement.upsert({
                where: { facilityId_credentialType: { facilityId: req.params.id, credentialType: req.body.credentialType } },
                create: { ...req.body, facilityId: req.params.id },
                update: req.body,
            });
            return createdResponse(res, req_);
        } catch (err) { next(err); }
    }
);

router.delete('/:id/requirements/:reqId', authenticate, requireFacilityAccess, async (req, res, next) => {
    try {
        await prisma.workplaceRequirement.delete({ where: { id: req.params.reqId } });
        return successResponse(res, {}, 'Requirement removed');
    } catch (err) { next(err); }
});

// ─── Team Members ──────────────────────────────

router.post('/:id/members', authenticate, requireFacilityAccess,
    [
        body('email').isEmail().normalizeEmail(),
        body('firstName').trim().notEmpty(),
        body('lastName').trim().notEmpty(),
        body('jobTitle').optional().trim(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const { email, firstName, lastName, jobTitle, permissionsMask } = req.body;

            const existingUser = await prisma.user.findUnique({ where: { email } });
            let userId = existingUser?.id;

            if (!existingUser) {
                const tempPassword = require('crypto').randomBytes(8).toString('hex');
                const newUser = await authService.registerUser({
                    email,
                    password:  tempPassword,
                    firstName,
                    lastName,
                    role:      'TEAM_MEMBER',
                    req:       {},
                });
                userId = newUser.id;
            }

            const member = await prisma.facilityMember.create({
                data: {
                    facilityId: req.params.id,
                    userId,
                    firstName,
                    lastName,
                    jobTitle:       jobTitle || null,
                    permissionsMask: permissionsMask || null,
                },
            });

            return createdResponse(res, member, 'Team member added');
        } catch (err) { next(err); }
    }
);

router.patch('/:id/members/:memberId', authenticate, requireFacilityAccess,
    async (req, res, next) => {
        try {
            const member = await prisma.facilityMember.update({
                where: { id: req.params.memberId },
                data:  req.body,
            });
            return successResponse(res, member);
        } catch (err) { next(err); }
    }
);

router.delete('/:id/members/:memberId', authenticate, requireFacilityAccess, async (req, res, next) => {
    try {
        await prisma.facilityMember.delete({ where: { id: req.params.memberId } });
        return successResponse(res, {}, 'Member removed');
    } catch (err) { next(err); }
});

// ─── Staffing Preferences & Notification Prefs ─

router.put('/:id/staffing-preferences', authenticate, requireFacilityAccess, async (req, res, next) => {
    try {
        const prefs = await prisma.staffingPreference.upsert({
            where:  { facilityId: req.params.id },
            create: { ...req.body, facilityId: req.params.id },
            update: req.body,
        });
        return successResponse(res, prefs);
    } catch (err) { next(err); }
});

router.put('/:id/notification-preferences', authenticate, requireFacilityAccess, async (req, res, next) => {
    try {
        const prefs = await prisma.facilityNotificationPref.upsert({
            where:  { facilityId: req.params.id },
            create: { ...req.body, facilityId: req.params.id },
            update: req.body,
        });
        return successResponse(res, prefs);
    } catch (err) { next(err); }
});

module.exports = router;