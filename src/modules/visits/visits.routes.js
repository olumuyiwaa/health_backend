const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { prisma } = require('../../config/database');
const { successResponse, errorResponse, paginatedResponse, buildPagination } = require('../../utils/response');
const { isWithinGeofence } = require('../../utils/geo');
const { writeAuditLog } = require('../../utils/audit');
const { dispatchNotification } = require('../notifications/notifications.service');

const GEOFENCE_RADIUS = Number(process.env.EVV_GEOFENCE_RADIUS_METERS) || 200;

// ─── Check-In ─────────────────────────────────

router.post('/:id/check-in',
    authenticate, authorize('NURSE'),
    [
        body('latitude').isFloat(),
        body('longitude').isFloat(),
        body('qrCode').optional().trim(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const visit = await prisma.visit.findUnique({
                where: { id: req.params.id },
                include: {
                    assignment: {
                        include: {
                            shift: {
                                include: {
                                    case: { select: { latitude: true, longitude: true, addressLine1: true, city: true } },
                                },
                            },
                        },
                    },
                },
            });

            if (!visit) return errorResponse(res, 'Visit not found', 404);
            if (visit.status !== 'SCHEDULED') return errorResponse(res, 'Visit cannot be checked into at this state', 400);

            // Verify nurse owns this visit
            const np = await prisma.nurseProfile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
            if (visit.nurseProfileId !== np.id) return errorResponse(res, 'Forbidden', 403);

            const { latitude, longitude } = req.body;
            const caseLat = visit.assignment.shift.case.latitude;
            const caseLon = visit.assignment.shift.case.longitude;

            let overrideRequired = false;
            let distance = null;

            if (caseLat && caseLon) {
                const geoCheck = isWithinGeofence(latitude, longitude, caseLat, caseLon, GEOFENCE_RADIUS);
                distance = Math.round(geoCheck.distance);

                if (!geoCheck.withinFence) {
                    overrideRequired = true;
                }
            }

            const updated = await prisma.visit.update({
                where: { id: req.params.id },
                data: {
                    checkInTime:      new Date(),
                    checkInLatitude:  latitude,
                    checkInLongitude: longitude,
                    checkInDistance:  distance,
                    checkInIpAddress: req.ip,
                    checkInQrCode:    req.body.qrCode || null,
                    status:           overrideRequired ? 'FLAGGED' : 'CHECKED_IN',
                    overrideRequired,
                    overrideReason:   overrideRequired
                        ? `Check-in location is ${distance}m from case address (limit: ${GEOFENCE_RADIUS}m)`
                        : null,
                },
            });

            // Log visit audit event
            await prisma.visitAuditLog.create({
                data: {
                    visitId:       visit.id,
                    action:        overrideRequired ? 'CHECK_IN_FLAGGED' : 'CHECK_IN',
                    performedById: req.user.id,
                    metadata:      { latitude, longitude, distance },
                },
            });

            if (overrideRequired) {
                // Notify admins/facility of flag
                return errorResponse(res, `Check-in flagged: you are ${distance}m from the case address. Override request sent for review.`, 422);
            }

            return successResponse(res, updated, 'Checked in successfully');
        } catch (err) { next(err); }
    }
);

// ─── Check-Out ────────────────────────────────

router.post('/:id/check-out',
    authenticate, authorize('NURSE'),
    [
        body('latitude').isFloat(),
        body('longitude').isFloat(),
        body('notes').optional().trim(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const visit = await prisma.visit.findUnique({
                where: { id: req.params.id },
                include: {
                    assignment: {
                        include: {
                            shift: { include: { case: { select: { latitude: true, longitude: true } } } },
                        },
                    },
                },
            });

            if (!visit) return errorResponse(res, 'Visit not found', 404);
            if (visit.status !== 'CHECKED_IN') return errorResponse(res, 'Must be checked in first', 400);

            const np = await prisma.nurseProfile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
            if (visit.nurseProfileId !== np.id) return errorResponse(res, 'Forbidden', 403);

            const { latitude, longitude, notes } = req.body;
            const durationMinutes = Math.round((Date.now() - new Date(visit.checkInTime).getTime()) / 60000);

            const geoCheck = visit.assignment.shift.case.latitude
                ? isWithinGeofence(latitude, longitude, visit.assignment.shift.case.latitude, visit.assignment.shift.case.longitude, GEOFENCE_RADIUS)
                : { withinFence: true, distance: 0 };

            const updated = await prisma.visit.update({
                where: { id: req.params.id },
                data: {
                    checkOutTime:      new Date(),
                    checkOutLatitude:  latitude,
                    checkOutLongitude: longitude,
                    checkOutDistance:  Math.round(geoCheck.distance),
                    checkOutIpAddress: req.ip,
                    durationMinutes,
                    notes:             notes || null,
                    status:            'CHECKED_OUT',
                },
            });

            // Mark shift complete
            await prisma.$transaction([
                prisma.shift.update({ where: { id: visit.shiftId }, data: { status: 'COMPLETED' } }),
                prisma.shiftAssignment.update({ where: { id: visit.assignmentId }, data: { status: 'COMPLETED', completedAt: new Date() } }),
            ]);

            await prisma.visitAuditLog.create({
                data: {
                    visitId:       visit.id,
                    action:        'CHECK_OUT',
                    performedById: req.user.id,
                    metadata:      { latitude, longitude, durationMinutes },
                },
            });

            return successResponse(res, updated, 'Checked out successfully');
        } catch (err) { next(err); }
    }
);

// ─── Override Approval ────────────────────────

router.patch('/:id/override-approve',
    authenticate, authorize('SUPER_ADMIN', 'FACILITY_ADMIN'),
    async (req, res, next) => {
        try {
            const visit = await prisma.visit.update({
                where: { id: req.params.id },
                data: {
                    status:              'CHECKED_IN',
                    overrideApprovedById: req.user.id,
                    overrideApprovedAt:   new Date(),
                },
            });

            await prisma.visitAuditLog.create({
                data: {
                    visitId:       req.params.id,
                    action:        'OVERRIDE_APPROVED',
                    performedById: req.user.id,
                },
            });

            await writeAuditLog({ userId: req.user.id, action: 'APPROVE', resource: 'Visit', resourceId: req.params.id, newData: { status: 'CHECKED_IN', overrideApprovedAt: new Date().toISOString(), approvedById: req.user.id }, req });
            return successResponse(res, visit, 'Override approved');
        } catch (err) { next(err); }
    }
);

// ─── Visit List ───────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
    try {
        const {
            page = 1,
            limit = 20,
            facilityId,
            nurseProfileId,
            status,
            flaggedOnly
        } = req.query;

        const skip = (Number(page) - 1) * Number(limit);

        // Role-based scoping
        let finalNurseProfileId = nurseProfileId;
        let finalFacilityId = facilityId;

        if (req.user.role === 'NURSE') {
            const nurseProfile = await prisma.nurseProfile.findUnique({
                where: { userId: req.user.id },
                select: { id: true }
            });
            finalNurseProfileId = nurseProfile?.id;
        }

        if (['FACILITY_ADMIN', 'TEAM_MEMBER'].includes(req.user.role)) {
            finalFacilityId = req.user.facilityMember?.facilityId;
        }

        const where = {
            ...(finalNurseProfileId ? { nurseProfileId: finalNurseProfileId } : {}),
            ...(status ? { status } : {}),
            ...(flaggedOnly === 'true' || flaggedOnly === true ? { overrideRequired: true } : {}),

            // Facility filtering through relationship
            ...(finalFacilityId ? {
                assignment: {
                    shift: {
                        facilityId: finalFacilityId
                    }
                }
            } : {}),
        };

        const [visits, total] = await Promise.all([
            prisma.visit.findMany({
                where,
                skip,
                take: Number(limit),
                orderBy: { createdAt: 'desc' },
                include: {
                    nurseProfile: {
                        select: {
                            firstName: true,
                            lastName: true,
                            designation: true
                        }
                    },
                    assignment: {
                        include: {
                            shift: {
                                select: {
                                    scheduledStart: true,
                                    scheduledEnd: true,
                                    visitType: true,
                                    case: {
                                        select: {
                                            publicIdentifier: true,
                                            city: true,
                                            state: true
                                        }
                                    },
                                },
                            },
                        },
                    },
                    auditEvents: {
                        orderBy: { createdAt: 'asc' },
                        take: 10 // limit audit events for performance
                    },
                },
            }),
            prisma.visit.count({ where }),
        ]);

        return paginatedResponse(res, visits, buildPagination(page, limit, total));
    } catch (err) {
        next(err);
    }
});

// GET /visits/:id
router.get('/:id', authenticate, async (req, res, next) => {
    try {
        const visit = await prisma.visit.findUnique({
            where: { id: req.params.id },
            include: {
                assignment: { include: { shift: { include: { case: true } } } },
                nurseProfile: { select: { firstName: true, lastName: true, designation: true } },
                auditEvents: { orderBy: { createdAt: 'asc' } },
            },
        });
        if (!visit) return errorResponse(res, 'Visit not found', 404);
        return successResponse(res, visit);
    } catch (err) { next(err); }
});

module.exports = router;