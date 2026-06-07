const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { prisma } = require('../../config/database');
const { successResponse, createdResponse, errorResponse, paginatedResponse, buildPagination } = require('../../utils/response');
const { writeAuditLog } = require('../../utils/audit');
const { dispatchNotification } = require('../notifications/notifications.service');
const crypto = require("crypto");


// ─── Create Shift ──────────────────────────────
function generatePublicIdentifier() {
    return `Case-PT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}
router.post(
    "/",
    authenticate,
    authorize("SUPER_ADMIN", "FACILITY_ADMIN", "TEAM_MEMBER"),
    [
        body("facilityId").optional().isUUID(),

        body("visitType").isIn([
            "ADMISSION",
            "REGULAR",
            "RESUMPTION_OF_CARE",
            "RECERTIFICATION",
            "SUPERVISORY",
            "DISCHARGE",
        ]),

        body("requiredDesignation").isIn([
            "RN",
            "LVN",
            "LPN",
            "CNA",
            "HHA",
            "THERAPIST",
            "CAREGIVER",
        ]),

        body("scheduledStart").isISO8601(),
        body("scheduledEnd").isISO8601(),

        body("chargeRate").isDecimal(),
        body("payRate").isDecimal(),

        body("pattern").optional().isIn(["ONE_TIME", "RECURRING"]),
        body("period").optional().isIn(["DAY", "NIGHT", "FLEXIBLE"]),

        body("specialties").optional().isArray(),
        body("recurringDays").optional().isArray(),
        body("recurringEndDate").optional({ nullable: true }).isISO8601(),

        body("title").optional().isString(),
        body("description").optional().isString(),
        body("estimatedDuration").optional().isInt({ min: 0 }),
        body("billingType").optional().isString(),
        body("isUrgent").optional().isBoolean(),
        body("isEmergencyFill").optional().isBoolean(),
        body("allowInstantBook").optional().isBoolean(),
        body("internalNotes").optional().isString(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const facilityId =
                req.user.role === "SUPER_ADMIN"
                    ? req.body.facilityId
                    : req.user.facilityMember?.facilityId;

            if (!facilityId) {
                return errorResponse(res, "Facility ID is required", 400);
            }

            const facility = await prisma.facility.findUnique({
                where: { id: facilityId },
                select: {
                    id: true,
                    status: true,
                    addresses: {
                        where: { isPrimary: true },
                        take: 1,
                        select: {
                            addressLine1: true,
                            addressLine2: true,
                            city: true,
                            state: true,
                            zipCode: true,
                            latitude: true,
                            longitude: true,
                        },
                    },
                },
            });

            if (!facility) {
                return errorResponse(res, "Facility not found", 404);
            }

            if (facility.status !== "ACTIVE") {
                return errorResponse(res, "Facility is not active", 400);
            }

            if (
                req.user.role !== "SUPER_ADMIN" &&
                facility.id !== req.user.facilityMember?.facilityId
            ) {
                return errorResponse(res, "Forbidden", 403);
            }

            const primaryAddress = facility.addresses[0];

            if (!primaryAddress) {
                return errorResponse(
                    res,
                    "Facility must have a primary address before creating shifts",
                    400
                );
            }

            const scheduledStart = new Date(req.body.scheduledStart);
            const scheduledEnd = new Date(req.body.scheduledEnd);

            if (scheduledEnd <= scheduledStart) {
                return errorResponse(res, "Scheduled end must be after scheduled start", 400);
            }

            const specialties = Array.isArray(req.body.specialties)
                ? req.body.specialties
                : [];

            const recurringDays = Array.isArray(req.body.recurringDays)
                ? req.body.recurringDays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
                : [];

            const result = await prisma.$transaction(async (tx) => {
                let caseId = req.body.caseId;
                let createdCase = null;

                if (caseId) {
                    const existingCase = await tx.case.findUnique({
                        where: { id: caseId },
                        select: { id: true, facilityId: true, isActive: true },
                    });

                    if (!existingCase) throw Object.assign(new Error("Case not found"), { statusCode: 404 });
                    if (existingCase.facilityId !== facilityId) throw Object.assign(new Error("Case does not belong to this facility"), { statusCode: 403 });
                    if (!existingCase.isActive) throw Object.assign(new Error("Case is not active"), { statusCode: 400 });
                } else {
                    createdCase = await tx.case.create({
                        data: {
                            facilityId: facility.id,
                            publicIdentifier: generatePublicIdentifier(),
                            addressLine1: primaryAddress.addressLine1,
                            addressLine2: primaryAddress.addressLine2,
                            city: primaryAddress.city,
                            state: primaryAddress.state,
                            zipCode: primaryAddress.zipCode,
                            latitude: primaryAddress.latitude,
                            longitude: primaryAddress.longitude,
                            visitType: req.body.visitType,
                            specialties,
                            isActive: true,
                            createdById: req.user.id,
                        },
                    });
                    caseId = createdCase.id;
                }

                const shift = await tx.shift.create({
                    data: {
                        caseId,
                        facilityId: facility.id,
                        title: req.body.title || null,
                        description: req.body.description || null,
                        visitType: req.body.visitType,
                        requiredDesignation: req.body.requiredDesignation,
                        specialties,
                        pattern: req.body.pattern || "ONE_TIME",
                        period: req.body.period || "DAY",
                        scheduledStart,
                        scheduledEnd,
                        estimatedDuration: req.body.estimatedDuration ? Number(req.body.estimatedDuration) : null,
                        recurringDays,
                        recurringEndDate: req.body.recurringEndDate ? new Date(req.body.recurringEndDate) : null,
                        chargeRate: parseFloat(req.body.chargeRate),
                        payRate: parseFloat(req.body.payRate),
                        billingType: req.body.billingType || "HOURLY",
                        isUrgent: Boolean(req.body.isUrgent),
                        isEmergencyFill: Boolean(req.body.isEmergencyFill),
                        allowInstantBook: typeof req.body.allowInstantBook === "boolean" ? req.body.allowInstantBook : true,
                        internalNotes: req.body.internalNotes || null,
                        createdById: req.user.id,
                    },
                    include: { case: true, assignments: true },
                });

                return { createdCase, shift };
            });

            if (result.createdCase) {
                await writeAuditLog({
                    userId: req.user.id,
                    action: "CREATE",
                    resource: "Case",
                    resourceId: result.createdCase.id,
                    req,
                });
            }

            await writeAuditLog({
                userId: req.user.id,
                action: "CREATE",
                resource: "Shift",
                resourceId: result.shift.id,
                req,
            });

            return createdResponse(res, result.shift);
        } catch (err) {
            next(err);
        }
    }
);

// ─── Marketplace (Nurse view) ──────────────────

router.get('/marketplace', authenticate, authorize('NURSE'), async (req, res, next) => {
    try {
        const {
            page = 1, limit = 20,
            designation, visitType, isUrgent,
            minPay, maxPay,
            lat, lng, radiusMiles,
            date,
        } = req.query;

        const skip = (page - 1) * limit;

        const nurseProfile = await prisma.nurseProfile.findUnique({
            where: { userId: req.user.id },
            select: { designation: true },
        });

        const where = {
            status: 'OPEN',
            requiredDesignation: designation || nurseProfile.designation,
            ...(visitType   ? { visitType }              : {}),
            ...(isUrgent === 'true' ? { isUrgent: true } : {}),
            ...(minPay      ? { payRate: { gte: parseFloat(minPay) } } : {}),
            ...(maxPay      ? { payRate: { lte: parseFloat(maxPay) } } : {}),
            ...(date        ? {
                scheduledStart: {
                    gte: new Date(date),
                    lt:  new Date(new Date(date).setDate(new Date(date).getDate() + 1)),
                },
            } : {
                scheduledStart: { gte: new Date() },
            }),
            case: { isActive: true },
        };

        const [shifts, total] = await Promise.all([
            prisma.shift.findMany({
                where,
                skip: Number(skip),
                take: Number(limit),
                orderBy: [{ isUrgent: 'desc' }, { scheduledStart: 'asc' }],
                include: {
                    case: {
                        select: {
                            publicIdentifier: true, city: true, state: true,
                            latitude: true, longitude: true, specialties: true,
                            visitType: true,
                        },
                    },
                },
            }),
            prisma.shift.count({ where }),
        ]);

        return paginatedResponse(res, shifts, buildPagination(page, limit, total));
    } catch (err) { next(err); }
});

// ─── Book Shift (Atomic with FOR UPDATE equivalent) ──

router.post('/:id/book', authenticate, authorize('NURSE'),
    async (req, res, next) => {
        try {
            const nurseProfile = await prisma.nurseProfile.findUnique({
                where: { userId: req.user.id },
                select: { id: true, designation: true },
            });

            if (!nurseProfile) return errorResponse(res, 'Nurse profile not found', 404);

            // Atomic booking using Prisma interactive transaction
            const assignment = await prisma.$transaction(async (tx) => {
                // Lock and read shift
                const shift = await tx.$queryRaw`
          SELECT id, status, "requiredDesignation", "payRate"
          FROM "Shift"
          WHERE id = ${req.params.id}
          FOR UPDATE
        `;

                const s = Array.isArray(shift) ? shift[0] : shift;
                if (!s) throw Object.assign(new Error('Shift not found'), { statusCode: 404 });
                if (s.status !== 'OPEN') throw Object.assign(new Error('Shift is no longer available'), { statusCode: 409 });
                if (s.requiredDesignation !== nurseProfile.designation) {
                    throw Object.assign(new Error(`This shift requires a ${s.requiredDesignation}`), { statusCode: 403 });
                }

                // Check nurse doesn't have an overlapping accepted shift
                const shiftData = await tx.shift.findUnique({ where: { id: req.params.id } });
                const overlap = await tx.shiftAssignment.findFirst({
                    where: {
                        nurseProfileId: nurseProfile.id,
                        status:         'ACCEPTED',
                        shift: {
                            scheduledStart: { lt: shiftData.scheduledEnd },
                            scheduledEnd:   { gt: shiftData.scheduledStart },
                        },
                    },
                });
                if (overlap) throw Object.assign(new Error('You already have a shift during this time'), { statusCode: 409 });

                // Mark shift booked
                await tx.shift.update({ where: { id: req.params.id }, data: { status: 'BOOKED' } });

                return tx.shiftAssignment.create({
                    data: {
                        shiftId:        req.params.id,
                        nurseProfileId: nurseProfile.id,
                        status:         'ACCEPTED',
                        acceptedAt:     new Date(),
                    },
                });
            });

            // Create visit record
            await prisma.visit.create({
                data: {
                    assignmentId:  assignment.id,
                    nurseProfileId: nurseProfile.id,
                    shiftId:        req.params.id,
                    status:        'SCHEDULED',
                },
            });

            await dispatchNotification({
                userId:   req.user.id,
                type:     'BOOKING_CONFIRMATION',
                title:    'Shift Booked',
                body:     'Your shift has been confirmed.',
                channels: ['EMAIL', 'PUSH'],
            });

            await writeAuditLog({ userId: req.user.id, action: 'CREATE', resource: 'ShiftAssignment', resourceId: assignment.id, req });
            return createdResponse(res, assignment, 'Shift booked successfully');
        } catch (err) { next(err); }
    }
);

// ─── Manual Assignment (Admin/Facility) ───────

router.post('/:id/assign', authenticate, authorize('SUPER_ADMIN', 'FACILITY_ADMIN'),
    [body('nurseProfileId').notEmpty()],
    validate,
    async (req, res, next) => {
        try {
            const shift = await prisma.shift.findUnique({ where: { id: req.params.id } });
            if (!shift || shift.status !== 'OPEN') return errorResponse(res, 'Shift unavailable', 409);

            const assignment = await prisma.$transaction(async (tx) => {
                await tx.shift.update({ where: { id: req.params.id }, data: { status: 'BOOKED' } });
                return tx.shiftAssignment.create({
                    data: {
                        shiftId:        req.params.id,
                        nurseProfileId: req.body.nurseProfileId,
                        status:         'ACCEPTED',
                        assignedById:   req.user.id,
                        acceptedAt:     new Date(),
                    },
                });
            });

            await prisma.visit.create({
                data: {
                    assignmentId:   assignment.id,
                    nurseProfileId: req.body.nurseProfileId,
                    shiftId:        req.params.id,
                    status:        'SCHEDULED',
                },
            });

            // Notify nurse
            const nurseUser = await prisma.user.findFirst({
                where: { nurseProfile: { id: req.body.nurseProfileId } },
                select: { id: true },
            });
            if (nurseUser) {
                await dispatchNotification({
                    userId:   nurseUser.id,
                    type:     'ASSIGNMENT_UPDATE',
                    title:    'New Shift Assignment',
                    body:     'You have been assigned to a new shift.',
                    channels: ['EMAIL', 'PUSH', 'SMS'],
                });
            }

            return createdResponse(res, assignment, 'Shift assigned');
        } catch (err) { next(err); }
    }
);

// ─── Cancel Shift ─────────────────────────────

router.patch('/:id/cancel', authenticate,
    [body('reason').optional().trim()],
    validate,
    async (req, res, next) => {
        try {
            const shift = await prisma.shift.findUnique({ where: { id: req.params.id } });
            if (!shift) return errorResponse(res, 'Shift not found', 404);

            // Nurses can cancel their own booked shifts
            if (req.user.role === 'NURSE') {
                const np = await prisma.nurseProfile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
                const assignment = await prisma.shiftAssignment.findFirst({
                    where: { shiftId: req.params.id, nurseProfileId: np.id, status: 'ACCEPTED' },
                });
                if (!assignment) return errorResponse(res, 'Not your shift', 403);

                await prisma.$transaction([
                    prisma.shiftAssignment.update({ where: { id: assignment.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: req.body.reason } }),
                    prisma.shift.update({ where: { id: req.params.id }, data: { status: 'OPEN' } }),
                ]);
            } else {
                // Admin/Facility cancels the shift entirely
                await prisma.$transaction([
                    prisma.shift.update({ where: { id: req.params.id }, data: { status: 'CANCELLED', cancelReason: req.body.reason, cancelledAt: new Date(), cancelledById: req.user.id } }),
                    prisma.shiftAssignment.updateMany({ where: { shiftId: req.params.id, status: 'ACCEPTED' }, data: { status: 'CANCELLED', cancelledAt: new Date() } }),
                ]);
            }

            return successResponse(res, {}, 'Shift cancelled');
        } catch (err) { next(err); }
    }
);

// ─── List Shifts ──────────────────────────────

router.get('/', authenticate, async (req, res, next) => {
    try {
        const { page = 1, limit = 20, facilityId, caseId, status, nurseProfileId } = req.query;
        const skip = (page - 1) * limit;

        let facilityFilter = facilityId;
        if (['FACILITY_ADMIN','TEAM_MEMBER'].includes(req.user.role)) {
            facilityFilter = req.user.facilityMember?.facilityId;
        }

        const where = {
            ...(facilityFilter   ? { facilityId: facilityFilter }                 : {}),
            ...(caseId           ? { caseId }                                     : {}),
            ...(status           ? { status }                                     : {}),
            ...(nurseProfileId   ? { assignments: { some: { nurseProfileId } } }  : {}),
        };

        const [shifts, total] = await Promise.all([
            prisma.shift.findMany({
                where,
                skip: Number(skip),
                take: Number(limit),
                orderBy: { scheduledStart: 'desc' },
                include: {
                    case: { select: { publicIdentifier: true, city: true, state: true } },
                    assignments: {
                        where:   { status: 'ACCEPTED' },
                        include: { nurseProfile: { select: { firstName: true, lastName: true, designation: true } } },
                    },
                },
            }),
            prisma.shift.count({ where }),
        ]);

        return paginatedResponse(res, shifts, buildPagination(page, limit, total));
    } catch (err) { next(err); }
});

// GET /shifts/:id
router.get('/:id', authenticate, async (req, res, next) => {
    try {
        const shift = await prisma.shift.findUnique({
            where: { id: req.params.id },
            include: {
                case: true,
                assignments: {
                    include: {
                        nurseProfile: { select: { firstName: true, lastName: true, designation: true, avatarUrl: true } },
                        visit: true,
                    },
                },
            },
        });
        if (!shift) return errorResponse(res, 'Shift not found', 404);
        return successResponse(res, shift);
    } catch (err) { next(err); }
});

// GET /shifts/my-shifts — nurse's own shifts
router.get('/nurse/my-shifts', authenticate, authorize('NURSE'), async (req, res, next) => {
    try {
        const np = await prisma.nurseProfile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
        const { page = 1, limit = 20, status } = req.query;
        const skip = (page - 1) * limit;

        const where = {
            nurseProfileId: np.id,
            ...(status ? { status } : {}),
        };

        const [assignments, total] = await Promise.all([
            prisma.shiftAssignment.findMany({
                where,
                skip: Number(skip),
                take: Number(limit),
                orderBy: { createdAt: 'desc' },
                include: {
                    shift: {
                        include: {
                            case: { select: { publicIdentifier: true, city: true, state: true, latitude: true, longitude: true } },
                        },
                    },
                    visit: true,
                },
            }),
            prisma.shiftAssignment.count({ where }),
        ]);

        return paginatedResponse(res, assignments, buildPagination(page, limit, total));
    } catch (err) { next(err); }
});

module.exports = router;