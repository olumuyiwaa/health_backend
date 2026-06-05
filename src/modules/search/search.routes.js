// GET /search?q=term            — universal search across all resource types
// GET /search/nurses?q=term     — search nurses only
// GET /search/facilities?q=term — search facilities only
// GET /search/cases?q=term      — search cases only
// GET /search/shifts?q=term     — search shifts only
// ─────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { query } = require('express-validator');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { prisma } = require('../../config/database');
const { successResponse, errorResponse } = require('../../utils/response');

// ─── Constants ────────────────────────────────────────────────

const DEFAULT_LIMIT_PER_CATEGORY = 5;
const MAX_LIMIT_PER_CATEGORY     = 20;
const MIN_QUERY_LENGTH           = 2;

// Resource type labels — used in the `type` field of every result hit
// so the frontend knows which route to navigate to on click.
const RESOURCE_TYPES = {
    NURSE:       'NURSE',
    FACILITY:    'FACILITY',
    CASE:        'CASE',
    SHIFT:       'SHIFT',
    CREDENTIAL:  'CREDENTIAL',
    INVOICE:     'INVOICE',
    USER:        'USER',
};

function normalizeEnumValue(query) {
    return query.trim().toUpperCase().replace(/\s+/g, '_');
}

function enumFilter(query, values) {
    const normalized = normalizeEnumValue(query);
    return values.includes(normalized) ? normalized : null;
}

// ─── Scope resolver ───────────────────────────────────────────
function resolveScope(req) {
    const { role, facilityMember, nurseProfile } = req.user;
    return {
        role,
        isAdmin:        role === 'SUPER_ADMIN' || role === 'RECRUITER',
        isFacility:     role === 'FACILITY_ADMIN' || role === 'TEAM_MEMBER',
        isNurse:        role === 'NURSE',
        facilityId:     facilityMember?.facilityId ?? null,
        nurseProfileId: nurseProfile?.id           ?? null,
    };
}

// ─── Individual searchers ─────────────────────────────────────
// Each returns an array of normalised hit objects:
// {
//   type:        RESOURCE_TYPES key
//   id:          the record's UUID
//   title:       primary display string
//   subtitle:    secondary line (role, status, location…)
//   status:      status string or null
//   badge:       short label shown in the chip (e.g. "RN", "Facility")
//   url:         suggested frontend navigation path
//   meta:        lightweight extra context
// }

async function searchNurses(q, scope, limit) {
    // Facility members and nurses cannot search the nurse roster
    if (scope.isNurse) return [];

    const where = {
        deletedAt: null,
        OR: [
            { nurseProfile: { firstName: { contains: q, mode: 'insensitive' } } },
            { nurseProfile: { lastName:  { contains: q, mode: 'insensitive' } } },
            { email:                     { contains: q, mode: 'insensitive' } },
            { phone:                     { contains: q, mode: 'insensitive' } },
            // Allow searching by full name "Sarah Adams"
            { nurseProfile: {
                    AND: q.includes(' ') ? [
                        { firstName: { contains: q.split(' ')[0], mode: 'insensitive' } },
                        { lastName:  { contains: q.split(' ')[1], mode: 'insensitive' } },
                    ] : [{ firstName: { contains: q, mode: 'insensitive' } }],
                }},
        ],
        role:         'NURSE',
        nurseProfile: { isNot: null },
    };

    const users = await prisma.user.findMany({
        where,
        take: limit,
        select: {
            id:     true,
            email:  true,
            status: true,
            nurseProfile: {
                select: {
                    id:          true,
                    firstName:   true,
                    lastName:    true,
                    designation: true,
                    isAvailable: true,
                    city:        true,
                    state:       true,
                },
            },
        },
    });

    return users.map((u) => ({
        type:     RESOURCE_TYPES.NURSE,
        id:       u.nurseProfile.id,
        title:    `${u.nurseProfile.firstName} ${u.nurseProfile.lastName}`,
        subtitle: [u.nurseProfile.city, u.nurseProfile.state].filter(Boolean).join(', ') || u.email,
        status:   u.status,
        badge:    u.nurseProfile.designation,
        url:      `/nurses/${u.nurseProfile.id}`,
        meta: {
            userId:      u.id,
            email:       u.email,
            designation: u.nurseProfile.designation,
            isAvailable: u.nurseProfile.isAvailable,
        },
    }));
}

async function searchFacilities(q, scope, limit) {
    // Nurses cannot search facilities
    if (scope.isNurse) return [];

    const where = {
        deletedAt: null,
        OR: [
            { name:       { contains: q, mode: 'insensitive' } },
            { email:      { contains: q, mode: 'insensitive' } },
            { npiNumber:  { contains: q, mode: 'insensitive' } },
            { addresses: { some: { city: { contains: q, mode: 'insensitive' } } } },
        ],
        // Facility members scoped to their own facility
        ...(scope.isFacility ? { id: scope.facilityId } : {}),
    };

    const facilities = await prisma.facility.findMany({
        where,
        take: limit,
        select: {
            id:     true,
            name:   true,
            email:  true,
            status: true,
            addresses: {
                where:  { isPrimary: true },
                select: { city: true, state: true },
                take:   1,
            },
            _count: { select: { cases: true, members: true } },
        },
    });

    return facilities.map((f) => {
        const addr = f.addresses[0];
        return {
            type:     RESOURCE_TYPES.FACILITY,
            id:       f.id,
            title:    f.name,
            subtitle: addr ? `${addr.city}, ${addr.state}` : f.email,
            status:   f.status,
            badge:    'Facility',
            url:      `/facilities/${f.id}`,
            meta: {
                email:       f.email,
                activeCases: f._count.cases,
                memberCount: f._count.members,
            },
        };
    });
}

async function searchCases(q, scope, limit) {
    const where = {
        deletedAt: null,
        isActive:  true,
        OR: [
            { publicIdentifier: { contains: q, mode: 'insensitive' } },
            // Admins can also search by real patient name
            ...(scope.isAdmin ? [
                { patientFirstName: { contains: q, mode: 'insensitive' } },
                { patientLastName:  { contains: q, mode: 'insensitive' } },
            ] : []),
            { primaryDiagnosis: { contains: q, mode: 'insensitive' } },
            { city:             { contains: q, mode: 'insensitive' } },
        ],
        // Facility users scoped to their own facility
        ...(scope.isFacility ? { facilityId: scope.facilityId } : {}),
        // Nurses scoped to cases they have an assignment on
        ...(scope.isNurse ? {
            shifts: {
                some: {
                    assignments: {
                        some: {
                            nurseProfileId: scope.nurseProfileId,
                            status: { in: ['ACCEPTED', 'COMPLETED'] },
                        },
                    },
                },
            },
        } : {}),
    };

    const cases = await prisma.case.findMany({
        where,
        take: limit,
        select: {
            id:               true,
            publicIdentifier: true,
            visitType:        true,
            primaryDiagnosis: true,
            city:             true,
            state:            true,
            isOasisCase:      true,
            // Only return real name to admins — never to nurses or public
            ...(scope.isAdmin ? {
                patientFirstName: true,
                patientLastName:  true,
            } : {}),
            facility: { select: { name: true } },
            _count:   { select: { shifts: true } },
        },
    });

    return cases.map((c) => ({
        type:     RESOURCE_TYPES.CASE,
        id:       c.id,
        title:    c.publicIdentifier,
        subtitle: [c.primaryDiagnosis, c.city, c.state].filter(Boolean).join(' · '),
        status:   'ACTIVE',
        badge:    c.visitType.replace(/_/g, ' '),
        url:      `/cases/${c.id}`,
        meta: {
            facilityName:    c.facility?.name,
            visitType:       c.visitType,
            isOasisCase:     c.isOasisCase,
            activeShifts:    c._count.shifts,
            // Real name only for admins
            ...(scope.isAdmin && c.patientFirstName ? {
                patientName: `${c.patientFirstName} ${c.patientLastName}`,
            } : {}),
        },
    }));
}

async function searchShifts(q, scope, limit) {
    const visitType = enumFilter(q, [
        'ADMISSION',
        'REGULAR',
        'RESUMPTION_OF_CARE',
        'RECERTIFICATION',
        'SUPERVISORY',
        'DISCHARGE',
    ]);

    const where = {
        status: { not: 'CANCELLED' },
        OR: [
            { title:       { contains: q, mode: 'insensitive' } },
            ...(visitType ? [{ visitType }] : []),
            { description: { contains: q, mode: 'insensitive' } },
            { case: { publicIdentifier: { contains: q, mode: 'insensitive' } } },
            { case: { city:             { contains: q, mode: 'insensitive' } } },
        ],
        ...(scope.isFacility ? { facilityId: scope.facilityId } : {}),
        ...(scope.isNurse ? {
            assignments: {
                some: {
                    nurseProfileId: scope.nurseProfileId,
                    status:         { in: ['ACCEPTED', 'COMPLETED'] },
                },
            },
        } : {}),
    };

    const shifts = await prisma.shift.findMany({
        where,
        take:    limit,
        orderBy: { scheduledStart: 'desc' },
        select: {
            id:                  true,
            title:               true,
            visitType:           true,
            requiredDesignation: true,
            scheduledStart:      true,
            scheduledEnd:        true,
            status:              true,
            isUrgent:            true,
            payRate:             true,
            chargeRate:          true,
            case: {
                select: {
                    publicIdentifier: true,
                    city:             true,
                    state:            true,
                },
            },
        },
    });

    return shifts.map((s) => ({
        type:     RESOURCE_TYPES.SHIFT,
        id:       s.id,
        title:    s.title || `${s.visitType.replace(/_/g, ' ')} — ${s.requiredDesignation}`,
        subtitle: s.case
            ? `${s.case.publicIdentifier} · ${s.case.city}, ${s.case.state}`
            : new Date(s.scheduledStart).toLocaleDateString(),
        status:   s.status,
        badge:    s.requiredDesignation,
        url:      `/shifts/${s.id}`,
        meta: {
            scheduledStart:      s.scheduledStart,
            scheduledEnd:        s.scheduledEnd,
            visitType:           s.visitType,
            isUrgent:            s.isUrgent,
            payRate:             s.payRate,
            chargeRate:          s.chargeRate,
            caseIdentifier:      s.case?.publicIdentifier,
        },
    }));
}

async function searchCredentials(q, scope, limit) {
    // Only admins and recruiters can search credentials globally
    if (!scope.isAdmin) return [];

    const credentialType = enumFilter(q, [
        'STATE_LICENSE',
        'CPR_CERTIFICATION',
        'TB_TEST',
        'BACKGROUND_CHECK',
        'GOVERNMENT_ID',
        'OIG_CHECK',
        'SAM_CHECK',
        'IMMUNIZATION',
        'WORK_AUTHORIZATION',
        'CUSTOM',
    ]);

    const where = {
        OR: [
            ...(credentialType ? [{ type: credentialType }] : []),
            { customLabel: { contains: q, mode: 'insensitive' } },
            { nurseProfile: { firstName: { contains: q, mode: 'insensitive' } } },
            { nurseProfile: { lastName:  { contains: q, mode: 'insensitive' } } },
        ],
        status: { in: ['PENDING', 'REJECTED', 'EXPIRED'] }, // highlight actionable ones
    };

    const credentials = await prisma.credential.findMany({
        where,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
            id:          true,
            type:        true,
            customLabel: true,
            status:      true,
            expiresAt:   true,
            nurseProfile: {
                select: { id: true, firstName: true, lastName: true, designation: true },
            },
        },
    });

    return credentials.map((c) => ({
        type:     RESOURCE_TYPES.CREDENTIAL,
        id:       c.id,
        title:    c.customLabel || c.type.replace(/_/g, ' '),
        subtitle: `${c.nurseProfile.firstName} ${c.nurseProfile.lastName} (${c.nurseProfile.designation})`,
        status:   c.status,
        badge:    'Credential',
        url:      `/credentials/${c.id}`,
        meta: {
            credentialType:  c.type,
            nurseProfileId:  c.nurseProfile.id,
            expiresAt:       c.expiresAt,
        },
    }));
}

async function searchInvoices(q, scope, limit) {
    if (scope.isNurse) return [];

    const where = {
        OR: [
            { invoiceNumber: { contains: q, mode: 'insensitive' } },
            { facility: { name: { contains: q, mode: 'insensitive' } } },
        ],
        ...(scope.isFacility ? { facilityId: scope.facilityId } : {}),
    };

    const invoices = await prisma.invoice.findMany({
        where,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
            id:            true,
            invoiceNumber: true,
            status:        true,
            total:         true,
            dueAt:         true,
            facility: { select: { name: true } },
        },
    });

    return invoices.map((inv) => ({
        type:     RESOURCE_TYPES.INVOICE,
        id:       inv.id,
        title:    `Invoice ${inv.invoiceNumber}`,
        subtitle: `${inv.facility.name} · $${Number(inv.total).toFixed(2)}`,
        status:   inv.status,
        badge:    'Invoice',
        url:      `/billing/invoices/${inv.id}`,
        meta: {
            total:        inv.total,
            dueAt:        inv.dueAt,
            facilityName: inv.facility.name,
        },
    }));
}

async function searchUsers(q, scope, limit) {
    // Only admins can search the full user table
    if (!scope.isAdmin) return [];

    const where = {
        deletedAt: null,
        role:      { not: 'NURSE' }, // nurses are covered by searchNurses
        OR: [
            { email: { contains: q, mode: 'insensitive' } },
            { adminProfile: { firstName: { contains: q, mode: 'insensitive' } } },
            { adminProfile: { lastName:  { contains: q, mode: 'insensitive' } } },
        ],
    };

    const users = await prisma.user.findMany({
        where,
        take: limit,
        select: {
            id:     true,
            email:  true,
            role:   true,
            status: true,
            adminProfile: { select: { firstName: true, lastName: true } },
            facilityMember: { select: { facilityId: true, jobTitle: true } },
        },
    });

    return users.map((u) => ({
        type:     RESOURCE_TYPES.USER,
        id:       u.id,
        title:    u.adminProfile
            ? `${u.adminProfile.firstName} ${u.adminProfile.lastName}`
            : u.email,
        subtitle: u.facilityMember?.jobTitle || u.email,
        status:   u.status,
        badge:    u.role.replace(/_/g, ' '),
        url:      `/users/${u.id}`,
        meta: {
            email:      u.email,
            role:       u.role,
            facilityId: u.facilityMember?.facilityId,
        },
    }));
}

// ─── Routes ───────────────────────────────────────────────────

/**
 * GET /search
 *
 * Universal search across all resource types.
 *
 * Query params:
 *   q        string  — search term (min 2 chars)
 *   types    string  — comma-separated resource types to include
 *                      e.g. "NURSE,CASE,SHIFT"
 *                      Default: all types the requesting role can see
 *   limit    number  — results per category (default 5, max 20)
 *
 * Response shape:
 * {
 *   query:   string,
 *   total:   number,
 *   results: {
 *     NURSE:      CalendarHit[],
 *     FACILITY:   CalendarHit[],
 *     CASE:       CalendarHit[],
 *     SHIFT:      CalendarHit[],
 *     CREDENTIAL: CalendarHit[],
 *     INVOICE:    CalendarHit[],
 *     USER:       CalendarHit[],
 *   }
 * }
 */
router.get('/',
    authenticate,
    [
        query('q')
            .trim()
            .isLength({ min: MIN_QUERY_LENGTH })
            .withMessage(`Search term must be at least ${MIN_QUERY_LENGTH} characters`),
        query('limit')
            .optional()
            .isInt({ min: 1, max: MAX_LIMIT_PER_CATEGORY })
            .toInt(),
        query('types')
            .optional()
            .isString(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const q     = req.query.q.trim();
            const limit = Math.min(Number(req.query.limit) || DEFAULT_LIMIT_PER_CATEGORY, MAX_LIMIT_PER_CATEGORY);
            const scope = resolveScope(req);

            // Determine which types to search
            const requestedTypes = req.query.types
                ? new Set(req.query.types.split(',').map((t) => t.trim().toUpperCase()))
                : null; // null = all

            const want = (type) => !requestedTypes || requestedTypes.has(type);

            // Run all searches in parallel
            const [
                nurses,
                facilities,
                cases,
                shifts,
                credentials,
                invoices,
                users,
            ] = await Promise.all([
                want('NURSE')       ? searchNurses(q, scope, limit)      : [],
                want('FACILITY')    ? searchFacilities(q, scope, limit)   : [],
                want('CASE')        ? searchCases(q, scope, limit)        : [],
                want('SHIFT')       ? searchShifts(q, scope, limit)       : [],
                want('CREDENTIAL')  ? searchCredentials(q, scope, limit)  : [],
                want('INVOICE')     ? searchInvoices(q, scope, limit)     : [],
                want('USER')        ? searchUsers(q, scope, limit)        : [],
            ]);

            const results = {
                NURSE:       nurses,
                FACILITY:    facilities,
                CASE:        cases,
                SHIFT:       shifts,
                CREDENTIAL:  credentials,
                INVOICE:     invoices,
                USER:        users,
            };

            // Remove empty categories from the response
            const filtered = Object.fromEntries(
                Object.entries(results).filter(([, hits]) => hits.length > 0)
            );

            const total = Object.values(filtered).reduce((sum, hits) => sum + hits.length, 0);

            return successResponse(res, {
                query:   q,
                total,
                limit,
                results: filtered,
            });
        } catch (err) { next(err); }
    }
);

/**
 * GET /search/nurses?q=term
 * Scoped nurse search — returns more results than the universal endpoint.
 */
router.get('/nurses',
    authenticate,
    authorize('SUPER_ADMIN', 'RECRUITER', 'FACILITY_ADMIN', 'TEAM_MEMBER'),
    [
        query('q').trim().isLength({ min: MIN_QUERY_LENGTH }),
        query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
        query('designation').optional().isIn(['RN','LVN','LPN','CNA','HHA','THERAPIST','CAREGIVER']),
        query('isAvailable').optional().isBoolean(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const q           = req.query.q.trim();
            const limit       = Math.min(Number(req.query.limit) || 20, 50);
            const designation = req.query.designation;
            const isAvailable = req.query.isAvailable;
            const scope       = resolveScope(req);

            const where = {
                deletedAt: null,
                role:      'NURSE',
                nurseProfile: {
                    isNot: null,
                    ...(designation  ? { designation }                          : {}),
                    ...(isAvailable !== undefined ? { isAvailable: isAvailable === 'true' } : {}),
                },
                OR: [
                    { nurseProfile: { firstName: { contains: q, mode: 'insensitive' } } },
                    { nurseProfile: { lastName:  { contains: q, mode: 'insensitive' } } },
                    { email:                     { contains: q, mode: 'insensitive' } },
                    { phone:                     { contains: q, mode: 'insensitive' } },
                ],
            };

            const users = await prisma.user.findMany({
                where,
                take: limit,
                select: {
                    id:     true,
                    email:  true,
                    phone:  true,
                    status: true,
                    verificationStatus: true,
                    nurseProfile: {
                        select: {
                            id:                 true,
                            firstName:          true,
                            lastName:           true,
                            designation:        true,
                            isAvailable:        true,
                            availabilityRadius: true,
                            city:               true,
                            state:              true,
                            yearsOfExperience:  true,
                            _count: { select: { credentials: true, assignments: true } },
                        },
                    },
                },
            });

            const hits = users.map((u) => ({
                type:     RESOURCE_TYPES.NURSE,
                id:       u.nurseProfile.id,
                title:    `${u.nurseProfile.firstName} ${u.nurseProfile.lastName}`,
                subtitle: [u.nurseProfile.city, u.nurseProfile.state].filter(Boolean).join(', '),
                status:   u.status,
                badge:    u.nurseProfile.designation,
                url:      `/nurses/${u.nurseProfile.id}`,
                meta: {
                    userId:             u.id,
                    email:              u.email,
                    phone:              u.phone,
                    designation:        u.nurseProfile.designation,
                    isAvailable:        u.nurseProfile.isAvailable,
                    availabilityRadius: u.nurseProfile.availabilityRadius,
                    yearsOfExperience:  u.nurseProfile.yearsOfExperience,
                    verificationStatus: u.verificationStatus,
                    credentialCount:    u.nurseProfile._count.credentials,
                    assignmentCount:    u.nurseProfile._count.assignments,
                },
            }));

            return successResponse(res, { query: q, total: hits.length, results: hits });
        } catch (err) { next(err); }
    }
);

/**
 * GET /search/facilities?q=term
 */
router.get('/facilities',
    authenticate,
    authorize('SUPER_ADMIN', 'RECRUITER'),
    [
        query('q').trim().isLength({ min: MIN_QUERY_LENGTH }),
        query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const q     = req.query.q.trim();
            const limit = Math.min(Number(req.query.limit) || 20, 50);
            const scope = resolveScope(req);

            const hits = await searchFacilities(q, scope, limit);
            return successResponse(res, { query: q, total: hits.length, results: hits });
        } catch (err) { next(err); }
    }
);

/**
 * GET /search/cases?q=term
 */
router.get('/cases',
    authenticate,
    [
        query('q').trim().isLength({ min: MIN_QUERY_LENGTH }),
        query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const q     = req.query.q.trim();
            const limit = Math.min(Number(req.query.limit) || 20, 50);
            const scope = resolveScope(req);

            const hits = await searchCases(q, scope, limit);
            return successResponse(res, { query: q, total: hits.length, results: hits });
        } catch (err) { next(err); }
    }
);

/**
 * GET /search/shifts?q=term
 */
router.get('/shifts',
    authenticate,
    [
        query('q').trim().isLength({ min: MIN_QUERY_LENGTH }),
        query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
        query('status').optional().isString(),
        query('designation').optional().isIn(['RN','LVN','LPN','CNA','HHA','THERAPIST','CAREGIVER']),
    ],
    validate,
    async (req, res, next) => {
        try {
            const q     = req.query.q.trim();
            const limit = Math.min(Number(req.query.limit) || 20, 50);
            const scope = resolveScope(req);

            const hits = await searchShifts(q, scope, limit);
            return successResponse(res, { query: q, total: hits.length, results: hits });
        } catch (err) { next(err); }
    }
);

module.exports = router;