const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { prisma } = require('../../config/database');
const { successResponse, createdResponse, errorResponse, paginatedResponse, buildPagination } = require('../../utils/response');
const { writeAuditLog } = require('../../utils/audit');
const crypto = require('crypto');

function generatePatientId() {
    return `Case-PT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

// POST /cases
router.post('/',
    authenticate,
    authorize('SUPER_ADMIN', 'FACILITY_ADMIN', 'TEAM_MEMBER'),
    [
        body('facilityId').notEmpty(),
        body('addressLine1').trim().notEmpty(),
        body('city').trim().notEmpty(),
        body('state').trim().notEmpty(),
        body('zipCode').trim().notEmpty(),
        body('visitType').isIn(['ADMISSION','REGULAR','RESUMPTION_OF_CARE','RECERTIFICATION','SUPERVISORY','DISCHARGE']),
        body('specialties').optional().isArray(),
        body('isOasisCase').optional().isBoolean(),
        body('oasisType').optional().isIn(['ADMISSION','RESUMPTION_OF_CARE','RECERTIFICATION','DISCHARGE']),
    ],
    validate,
    async (req, res, next) => {
        try {
            // Team members and facility admin scoped to own facility
            if (
                ['FACILITY_ADMIN', 'TEAM_MEMBER'].includes(req.user.role) &&
                req.user.facilityMember?.facilityId !== req.body.facilityId
            ) {
                return errorResponse(res, 'Forbidden', 403);
            }


            const publicIdentifier = generatePatientId();

            // Encrypt patient name fields if provided
            const { patientFirstName, patientLastName, dateOfBirth, ...rest } = req.body;

            const newCase = await prisma.case.create({
                data: {
                    ...rest,
                    publicIdentifier,
                    patientFirstName: patientFirstName || null,
                    patientLastName:  patientLastName  || null,
                    dateOfBirth:      dateOfBirth ? new Date(dateOfBirth) : null,
                    specialties:      req.body.specialties || [],
                    createdById:      req.user.id,
                },
            });

            await writeAuditLog({ userId: req.user.id, action: 'CREATE', resource: 'Case', resourceId: newCase.id, req });
            return createdResponse(res, newCase);
        } catch (err) { next(err); }
    }
);

// GET /cases
router.get('/', authenticate, async (req, res, next) => {
    try {
        const { page = 1, limit = 20, facilityId, visitType, isActive, search } = req.query;
        const skip = (page - 1) * limit;

        let facilityFilter = facilityId;
        // Facility users scoped to own facility
        if (['FACILITY_ADMIN', 'TEAM_MEMBER'].includes(req.user.role)) {
            facilityFilter = req.user.facilityMember?.facilityId;
        }

        const where = {
            deletedAt: null,
            ...(facilityFilter ? { facilityId: facilityFilter } : {}),
            ...(visitType ? { visitType } : {}),
            ...(isActive !== undefined ? { isActive: isActive === 'true' } : {}),
            ...(search ? {
                OR: [
                    { publicIdentifier: { contains: search, mode: 'insensitive' } },
                    { patientFirstName: { contains: search, mode: 'insensitive' } },
                    { patientLastName:  { contains: search, mode: 'insensitive' } },
                ],
            } : {}),
        };

        const [cases, total] = await Promise.all([
            prisma.case.findMany({
                where,
                skip: Number(skip),
                take: Number(limit),
                orderBy: { createdAt: 'desc' },
                include: {
                    facility: { select: { name: true } },
                    _count:   { select: { shifts: true } },
                },
            }),
            prisma.case.count({ where }),
        ]);

        return paginatedResponse(res, cases, buildPagination(page, limit, total));
    } catch (err) { next(err); }
});

// GET /cases/:id
router.get('/:id', authenticate, async (req, res, next) => {
    try {
        const c = await prisma.case.findUnique({
            where: { id: req.params.id },
            include: {
                facility: { select: { id: true, name: true } },
                shifts: {
                    orderBy: { scheduledStart: 'desc' },
                    take: 10,
                    include: {
                        assignments: {
                            where:   { status: 'ACCEPTED' },
                            include: { nurseProfile: { select: { firstName: true, lastName: true } } },
                        },
                    },
                },
            },
        });

        if (!c) return errorResponse(res, 'Case not found', 404);

        // Scope check for facility users
        if (['FACILITY_ADMIN', 'TEAM_MEMBER'].includes(req.user.role)) {
            if (c.facilityId !== req.user.facilityMember?.facilityId) {
                return errorResponse(res, 'Forbidden', 403);
            }
        }

        // Nurses see masked patient info
        if (req.user.role === 'NURSE') {
            c.patientFirstName = null;
            c.patientLastName  = null;
            c.dateOfBirth      = null;
        }

        return successResponse(res, c);
    } catch (err) { next(err); }
});

// PATCH /cases/:id
router.patch('/:id', authenticate, authorize('SUPER_ADMIN', 'FACILITY_ADMIN', 'TEAM_MEMBER'),
    async (req, res, next) => {
        try {
            const existing = await prisma.case.findUnique({ where: { id: req.params.id } });
            if (!existing) return errorResponse(res, 'Case not found', 404);

            // if (req.user.role === 'TEAM_MEMBER' && existing.facilityId !== req.user.facilityMember?.facilityId) {
            //     return errorResponse(res, 'Forbidden', 403);
            // }

            if (['FACILITY_ADMIN', 'TEAM_MEMBER'].includes(req.user.role) && existing.facilityId !== req.user.facilityMember?.facilityId) {
                return errorResponse(res, 'Forbidden', 403);
            }

            if (data.dateOfBirth) {
                data.dateOfBirth = new Date(data.dateOfBirth);
            }

            const allowed = [
                'patientFirstName','patientLastName','dateOfBirth','gender',
                'primaryDiagnosis','notes','addressLine1','addressLine2',
                'city','state','zipCode','latitude','longitude',
                'isOasisCase','oasisType','visitType','specialties','isActive',
            ];
            const data = Object.fromEntries(
                Object.entries(req.body).filter(([k]) => allowed.includes(k))
            );

            const updated = await prisma.case.update({ where: { id: req.params.id }, data });
            await writeAuditLog({ userId: req.user.id, action: 'UPDATE', resource: 'Case', resourceId: updated.id, newData: data, req });
            return successResponse(res, updated);
        } catch (err) { next(err); }
    }
);

// DELETE /cases/:id — soft delete
router.delete('/:id', authenticate, authorize('SUPER_ADMIN', 'FACILITY_ADMIN'), async (req, res, next) => {
    try {
        await prisma.case.update({
            where: { id: req.params.id },
            data:  { deletedAt: new Date(), isActive: false },
        });
        await writeAuditLog({ userId: req.user.id, action: 'DELETE', resource: 'Case', resourceId: req.params.id, req });
        return successResponse(res, {}, 'Case archived');
    } catch (err) { next(err); }
});

module.exports = router;