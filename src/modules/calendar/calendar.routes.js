// GET /calendar/events         — aggregated event feed (main endpoint)
// GET /calendar/events/:id     — single event detail by composite ID
// GET /calendar/upcoming       — next N events for the current user
// GET /calendar/day            — all events for a specific date
// GET /calendar/week           — all events for a specific ISO week
// GET /calendar/month          — all events for a calendar month
// GET /calendar/agenda         — flat chronological list (useful for mobile)
// ─────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { query } = require('express-validator');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { prisma } = require('../../config/database');
const { successResponse, errorResponse } = require('../../utils/response');

// ─── Constants ────────────────────────────────────────────────

const EVENT_TYPES = {
    SHIFT:               'SHIFT',
    VISIT:               'VISIT',
    CREDENTIAL_EXPIRY:   'CREDENTIAL_EXPIRY',
    INVOICE_DUE:         'INVOICE_DUE',
    INVOICE_OVERDUE:     'INVOICE_OVERDUE',
    RECURRING_SHIFT:     'RECURRING_SHIFT',
};

const EVENT_COLORS = {
    // Shifts
    SHIFT_OPEN:        '#3b82f6', // blue
    SHIFT_BOOKED:      '#8b5cf6', // purple
    SHIFT_IN_PROGRESS: '#f59e0b', // amber
    SHIFT_COMPLETED:   '#10b981', // green
    SHIFT_CANCELLED:   '#6b7280', // grey
    SHIFT_URGENT:      '#ef4444', // red

    // Visits
    VISIT_SCHEDULED:        '#60a5fa', // light blue
    VISIT_CHECKED_IN:       '#a78bfa', // light purple
    VISIT_CHECKED_OUT:      '#34d399', // light green
    VISIT_VERIFIED:         '#10b981', // green
    VISIT_FLAGGED:          '#f87171', // light red
    VISIT_OVERRIDE_PENDING: '#fb923c', // orange

    // Credentials
    CREDENTIAL_EXPIRY_CRITICAL: '#dc2626', // red — ≤7 days
    CREDENTIAL_EXPIRY_WARNING:  '#f59e0b', // amber — ≤30 days
    CREDENTIAL_EXPIRY_NOTICE:   '#3b82f6', // blue — ≤60 days

    // Billing
    INVOICE_DUE:      '#f59e0b',
    INVOICE_OVERDUE:  '#ef4444',
};

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Parse date range from query params.
 * Defaults to the current calendar month if not supplied.
 */
function parseDateRange(fromStr, toStr) {
    const now = new Date();

    const from = fromStr
        ? new Date(fromStr)
        : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

    const to = toStr
        ? new Date(toStr)
        : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    if (isNaN(from.getTime())) throw Object.assign(new Error('Invalid "from" date'), { statusCode: 400 });
    if (isNaN(to.getTime()))   throw Object.assign(new Error('Invalid "to" date'),   { statusCode: 400 });
    if (from > to)             throw Object.assign(new Error('"from" must be before "to"'), { statusCode: 400 });

    return { from, to };
}

/**
 * Determine the facility/nurse scope for the requesting user so that
 * facility admins only see their own data and nurses only see their own shifts.
 */
function resolveScope(req, overrideFacilityId) {
    const { role, facilityMember, nurseProfile } = req.user;

    if (role === 'SUPER_ADMIN' || role === 'RECRUITER') {
        return {
            facilityId:     overrideFacilityId || null,
            nurseProfileId: null,
            isAdmin:        true,
        };
    }

    if (role === 'FACILITY_ADMIN' || role === 'TEAM_MEMBER') {
        return {
            facilityId:     facilityMember?.facilityId || null,
            nurseProfileId: null,
            isAdmin:        false,
        };
    }

    if (role === 'NURSE') {
        return {
            facilityId:     null,
            nurseProfileId: nurseProfile?.id || null,
            isAdmin:        false,
        };
    }

    return { facilityId: null, nurseProfileId: null, isAdmin: false };
}

/**
 * Determine the colour for a shift event.
 */
function shiftColor(shift) {
    if (shift.isUrgent || shift.isEmergencyFill) return EVENT_COLORS.SHIFT_URGENT;
    return EVENT_COLORS[`SHIFT_${shift.status}`] || EVENT_COLORS.SHIFT_OPEN;
}

/**
 * Determine the colour for a visit event.
 */
function visitColor(visit) {
    if (visit.overrideRequired && visit.status === 'FLAGGED') return EVENT_COLORS.VISIT_FLAGGED;
    if (visit.overrideRequired) return EVENT_COLORS.VISIT_OVERRIDE_PENDING;
    return EVENT_COLORS[`VISIT_${visit.status}`] || EVENT_COLORS.VISIT_SCHEDULED;
}

/**
 * Determine the colour for a credential expiry event.
 */
function credentialColor(daysUntilExpiry) {
    if (daysUntilExpiry <= 7)  return EVENT_COLORS.CREDENTIAL_EXPIRY_CRITICAL;
    if (daysUntilExpiry <= 30) return EVENT_COLORS.CREDENTIAL_EXPIRY_WARNING;
    return EVENT_COLORS.CREDENTIAL_EXPIRY_NOTICE;
}

// ─── Event Builders ───────────────────────────────────────────
// Each function returns an array of calendar event objects shaped as:
// {
//   id:          string   — "type:record-id" composite
//   type:        string   — EVENT_TYPES key
//   title:       string
//   start:       ISO string
//   end:         ISO string | null
//   allDay:      boolean
//   color:       hex string
//   status:      string
//   meta:        object   — lightweight context for the UI tooltip / detail panel
//   resourceId:  string   — the underlying record's UUID
//   facilityId:  string | null
// }

async function buildShiftEvents({ from, to, facilityId, nurseProfileId }) {
    const where = {
        scheduledStart: { lte: to },
        scheduledEnd:   { gte: from },
        status:         { not: 'CANCELLED' },
        ...(facilityId     ? { facilityId }                                                                        : {}),
        ...(nurseProfileId ? { assignments: { some: { nurseProfileId, status: { in: ['ACCEPTED','COMPLETED'] } } } } : {}),
    };

    const shifts = await prisma.shift.findMany({
        where,
        select: {
            id:                  true,
            title:               true,
            visitType:           true,
            requiredDesignation: true,
            specialties:         true,
            scheduledStart:      true,
            scheduledEnd:        true,
            estimatedDuration:   true,
            status:              true,
            isUrgent:            true,
            isEmergencyFill:     true,
            pattern:             true,
            period:              true,
            chargeRate:          true,
            payRate:             true,
            facilityId:          true,
            case: {
                select: {
                    publicIdentifier: true,
                    city:             true,
                    state:            true,
                    visitType:        true,
                },
            },
            assignments: {
                where:  { status: { in: ['ACCEPTED', 'COMPLETED'] } },
                select: {
                    id:     true,
                    status: true,
                    nurseProfile: {
                        select: { firstName: true, lastName: true, designation: true },
                    },
                },
                take: 1,
            },
        },
        orderBy: { scheduledStart: 'asc' },
    });

    return shifts.map((s) => {
        const assignee = s.assignments[0]?.nurseProfile;
        const label    = s.title || `${s.visitType.replace(/_/g, ' ')} — ${s.requiredDesignation}`;

        return {
            id:         `SHIFT:${s.id}`,
            type:       s.pattern === 'RECURRING' ? EVENT_TYPES.RECURRING_SHIFT : EVENT_TYPES.SHIFT,
            title:      label,
            start:      s.scheduledStart.toISOString(),
            end:        s.scheduledEnd.toISOString(),
            allDay:     false,
            color:      shiftColor(s),
            status:     s.status,
            resourceId: s.id,
            facilityId: s.facilityId,
            meta: {
                caseIdentifier:  s.case?.publicIdentifier,
                location:        s.case ? `${s.case.city}, ${s.case.state}` : null,
                designation:     s.requiredDesignation,
                visitType:       s.visitType,
                specialties:     s.specialties,
                pattern:         s.pattern,
                period:          s.period,
                isUrgent:        s.isUrgent,
                isEmergencyFill: s.isEmergencyFill,
                payRate:         s.payRate,
                chargeRate:      s.chargeRate,
                assignee:        assignee
                    ? `${assignee.firstName} ${assignee.lastName} (${assignee.designation})`
                    : null,
            },
        };
    });
}

async function buildVisitEvents({ from, to, facilityId, nurseProfileId }) {
    const where = {
        createdAt: { lte: to },
        OR: [
            { checkInTime:  { gte: from, lte: to } },
            { checkOutTime: { gte: from, lte: to } },
            { assignment: { shift: { scheduledStart: { gte: from, lte: to } } } },
        ],
        ...(nurseProfileId ? { nurseProfileId } : {}),
        ...(facilityId     ? { assignment: { shift: { facilityId } } } : {}),
    };

    const visits = await prisma.visit.findMany({
        where,
        select: {
            id:                   true,
            status:               true,
            checkInTime:          true,
            checkOutTime:         true,
            durationMinutes:      true,
            overrideRequired:     true,
            overrideReason:       true,
            checkInDistance:      true,
            notes:                true,
            nurseProfile: {
                select: { firstName: true, lastName: true, designation: true },
            },
            assignment: {
                select: {
                    shift: {
                        select: {
                            id:             true,
                            visitType:      true,
                            scheduledStart: true,
                            scheduledEnd:   true,
                            facilityId:     true,
                            case: {
                                select: {
                                    publicIdentifier: true,
                                    city:             true,
                                    state:            true,
                                },
                            },
                        },
                    },
                },
            },
        },
        orderBy: { createdAt: 'asc' },
    });

    return visits.map((v) => {
        const shift    = v.assignment?.shift;
        const start    = v.checkInTime  || shift?.scheduledStart;
        const end      = v.checkOutTime || shift?.scheduledEnd;
        const nurse    = v.nurseProfile;
        const location = shift?.case ? `${shift.case.city}, ${shift.case.state}` : null;

        const title = [
            shift?.visitType?.replace(/_/g, ' ') || 'Visit',
            nurse ? `— ${nurse.firstName} ${nurse.lastName}` : '',
        ].join(' ');

        return {
            id:         `VISIT:${v.id}`,
            type:       EVENT_TYPES.VISIT,
            title,
            start:      start ? new Date(start).toISOString() : new Date().toISOString(),
            end:        end   ? new Date(end).toISOString()   : null,
            allDay:     false,
            color:      visitColor(v),
            status:     v.status,
            resourceId: v.id,
            facilityId: shift?.facilityId || null,
            meta: {
                caseIdentifier:  shift?.case?.publicIdentifier,
                location,
                visitType:       shift?.visitType,
                nurse:           nurse ? `${nurse.firstName} ${nurse.lastName} (${nurse.designation})` : null,
                durationMinutes: v.durationMinutes,
                checkInTime:     v.checkInTime,
                checkOutTime:    v.checkOutTime,
                checkInDistance: v.checkInDistance,
                overrideRequired: v.overrideRequired,
                overrideReason:  v.overrideReason,
                notes:           v.notes,
                shiftId:         shift?.id,
            },
        };
    });
}

async function buildCredentialExpiryEvents({ from, to, nurseProfileId }) {
    const where = {
        status:    'APPROVED',
        expiresAt: { gte: from, lte: to },
        ...(nurseProfileId ? { nurseProfileId } : {}),
    };

    const credentials = await prisma.credential.findMany({
        where,
        select: {
            id:        true,
            type:      true,
            customLabel: true,
            expiresAt: true,
            status:    true,
            nurseProfile: {
                select: {
                    id:          true,
                    firstName:   true,
                    lastName:    true,
                    designation: true,
                },
            },
        },
        orderBy: { expiresAt: 'asc' },
    });

    return credentials.map((c) => {
        const daysUntil  = Math.ceil((new Date(c.expiresAt) - new Date()) / (1000 * 60 * 60 * 24));
        const label      = c.customLabel || c.type.replace(/_/g, ' ');
        const nurseName  = `${c.nurseProfile.firstName} ${c.nurseProfile.lastName}`;

        return {
            id:         `CREDENTIAL:${c.id}`,
            type:       EVENT_TYPES.CREDENTIAL_EXPIRY,
            title:      `${label} expiry — ${nurseName}`,
            start:      new Date(c.expiresAt).toISOString(),
            end:        null,
            allDay:     true,
            color:      credentialColor(daysUntil),
            status:     daysUntil <= 0 ? 'EXPIRED' : daysUntil <= 7 ? 'CRITICAL' : daysUntil <= 30 ? 'WARNING' : 'NOTICE',
            resourceId: c.id,
            facilityId: null,
            meta: {
                credentialType: c.type,
                customLabel:    c.customLabel,
                expiresAt:      c.expiresAt,
                daysUntilExpiry: daysUntil,
                nurseProfileId: c.nurseProfile.id,
                nurse:          `${nurseName} (${c.nurseProfile.designation})`,
            },
        };
    });
}

async function buildInvoiceEvents({ from, to, facilityId }) {
    const where = {
        status:  { in: ['ISSUED', 'OVERDUE'] },
        dueAt:   { gte: from, lte: to },
        ...(facilityId ? { facilityId } : {}),
    };

    const invoices = await prisma.invoice.findMany({
        where,
        select: {
            id:            true,
            invoiceNumber: true,
            status:        true,
            total:         true,
            dueAt:         true,
            facilityId:    true,
            facility: {
                select: { name: true },
            },
        },
        orderBy: { dueAt: 'asc' },
    });

    return invoices.map((inv) => ({
        id:         `INVOICE:${inv.id}`,
        type:       inv.status === 'OVERDUE' ? EVENT_TYPES.INVOICE_OVERDUE : EVENT_TYPES.INVOICE_DUE,
        title:      `Invoice ${inv.invoiceNumber} due — ${inv.facility.name}`,
        start:      new Date(inv.dueAt).toISOString(),
        end:        null,
        allDay:     true,
        color:      inv.status === 'OVERDUE' ? EVENT_COLORS.INVOICE_OVERDUE : EVENT_COLORS.INVOICE_DUE,
        status:     inv.status,
        resourceId: inv.id,
        facilityId: inv.facilityId,
        meta: {
            invoiceNumber: inv.invoiceNumber,
            total:         inv.total,
            dueAt:         inv.dueAt,
            facilityName:  inv.facility.name,
        },
    }));
}

// ─── Aggregator ───────────────────────────────────────────────

async function aggregateEvents({ from, to, scope, eventTypes }) {
    const include = eventTypes ? new Set(eventTypes.split(',').map((t) => t.trim().toUpperCase())) : null;

    const shouldInclude = (type) => !include || include.has(type);

    const [shiftEvents, visitEvents, credentialEvents, invoiceEvents] = await Promise.all([
        shouldInclude('SHIFT') || shouldInclude('RECURRING_SHIFT')
            ? buildShiftEvents({ from, to, ...scope })
            : [],
        shouldInclude('VISIT')
            ? buildVisitEvents({ from, to, ...scope })
            : [],
        (shouldInclude('CREDENTIAL_EXPIRY') && (scope.isAdmin || scope.nurseProfileId))
            ? buildCredentialExpiryEvents({ from, to, nurseProfileId: scope.nurseProfileId })
            : [],
        (shouldInclude('INVOICE_DUE') || shouldInclude('INVOICE_OVERDUE')) && (scope.isAdmin || scope.facilityId)
            ? buildInvoiceEvents({ from, to, facilityId: scope.facilityId })
            : [],
    ]);

    return [
        ...shiftEvents,
        ...visitEvents,
        ...credentialEvents,
        ...invoiceEvents,
    ].sort((a, b) => new Date(a.start) - new Date(b.start));
}

// ─── Routes ───────────────────────────────────────────────────

/**
 * GET /calendar/events
 *
 * Main calendar feed. Returns all event types within the date range.
 *
 * Query params:
 *   from         ISO date string — range start (default: start of current month)
 *   to           ISO date string — range end   (default: end of current month)
 *   facilityId   UUID            — filter by facility (admin/super-admin only)
 *   nurseProfileId UUID          — filter by nurse   (admin/super-admin only)
 *   types        comma-separated — filter event types e.g. "SHIFT,VISIT"
 *   groupBy      day | week | none (default: none)
 */
router.get('/events',
    authenticate,
    [
        query('from').optional().isISO8601(),
        query('to').optional().isISO8601(),
        query('facilityId').optional().isUUID(),
        query('nurseProfileId').optional().isUUID(),
        query('types').optional().isString(),
        query('groupBy').optional().isIn(['day', 'week', 'none']),
    ],
    validate,
    async (req, res, next) => {
        try {
            const { from: fromStr, to: toStr, types, groupBy = 'none' } = req.query;
            const { from, to } = parseDateRange(fromStr, toStr);

            // Enforce a max 90-day window to prevent accidental full-table scans
            const diffDays = (to - from) / (1000 * 60 * 60 * 24);
            if (diffDays > 90) {
                return errorResponse(res, 'Date range cannot exceed 90 days. Split into smaller requests.', 400);
            }

            const scope = resolveScope(req, req.query.facilityId);

            // Non-admins cannot override nurseProfileId to spy on others
            if (req.query.nurseProfileId && req.user.role === 'NURSE') {
                if (req.query.nurseProfileId !== scope.nurseProfileId) {
                    return errorResponse(res, 'Forbidden', 403);
                }
            }
            if (req.query.nurseProfileId && (scope.isAdmin || req.user.role === 'FACILITY_ADMIN')) {
                scope.nurseProfileId = req.query.nurseProfileId;
            }

            const events = await aggregateEvents({ from, to, scope, eventTypes: types });

            // Optional groupBy
            let payload;

            if (groupBy === 'day') {
                const grouped = {};
                for (const event of events) {
                    const day = event.start.slice(0, 10); // YYYY-MM-DD
                    if (!grouped[day]) grouped[day] = [];
                    grouped[day].push(event);
                }
                payload = grouped;
            } else if (groupBy === 'week') {
                const grouped = {};
                for (const event of events) {
                    const d    = new Date(event.start);
                    const dow  = d.getDay(); // 0 = Sun
                    const weekStart = new Date(d);
                    weekStart.setDate(d.getDate() - dow);
                    const key = weekStart.toISOString().slice(0, 10);
                    if (!grouped[key]) grouped[key] = [];
                    grouped[key].push(event);
                }
                payload = grouped;
            } else {
                payload = events;
            }

            return successResponse(res, {
                period: { from: from.toISOString(), to: to.toISOString() },
                count:  events.length,
                groupBy,
                events: payload,
            });
        } catch (err) { next(err); }
    }
);

/**
 * GET /calendar/events/:compositeId
 *
 * Fetch full detail for a single calendar event by its composite ID.
 * Format: TYPE:uuid  e.g. SHIFT:abc123, VISIT:def456
 */
router.get('/events/:compositeId', authenticate, async (req, res, next) => {
    try {
        const parts = req.params.compositeId.split(':');
        if (parts.length !== 2) return errorResponse(res, 'Invalid event ID format. Expected TYPE:uuid', 400);

        const [type, id] = parts;

        let detail = null;

        switch (type.toUpperCase()) {
            case 'SHIFT': {
                detail = await prisma.shift.findUnique({
                    where: { id },
                    include: {
                        case: true,
                        assignments: {
                            where:  { status: { in: ['ACCEPTED','COMPLETED'] } },
                            include: {
                                nurseProfile: {
                                    select: { firstName: true, lastName: true, designation: true, avatarUrl: true },
                                },
                                visit: true,
                            },
                        },
                    },
                });
                break;
            }

            case 'VISIT': {
                detail = await prisma.visit.findUnique({
                    where: { id },
                    include: {
                        nurseProfile: {
                            select: { firstName: true, lastName: true, designation: true },
                        },
                        assignment: {
                            include: {
                                shift: { include: { case: true } },
                            },
                        },
                        auditEvents: { orderBy: { createdAt: 'asc' } },
                    },
                });
                break;
            }

            case 'CREDENTIAL': {
                detail = await prisma.credential.findUnique({
                    where: { id },
                    include: {
                        nurseProfile: {
                            select: { firstName: true, lastName: true, designation: true },
                        },
                    },
                });
                break;
            }

            case 'INVOICE': {
                detail = await prisma.invoice.findUnique({
                    where: { id },
                    include: {
                        facility:  { select: { name: true, email: true } },
                        lineItems: true,
                    },
                });
                break;
            }

            default:
                return errorResponse(res, `Unknown event type: ${type}`, 400);
        }

        if (!detail) return errorResponse(res, 'Event not found', 404);

        return successResponse(res, { type: type.toUpperCase(), id, detail });
    } catch (err) { next(err); }
});

/**
 * GET /calendar/upcoming
 *
 * Returns the next N events for the current user, starting from now.
 *
 * Query params:
 *   limit    number of events to return (default 10, max 50)
 *   types    comma-separated event type filter
 */
router.get('/upcoming',
    authenticate,
    [
        query('limit').optional().isInt({ min: 1, max: 50 }),
        query('types').optional().isString(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const limit  = Math.min(Number(req.query.limit) || 10, 50);
            const from   = new Date();
            const to     = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days ahead
            const scope  = resolveScope(req, null);

            const events = await aggregateEvents({
                from, to, scope,
                eventTypes: req.query.types || null,
            });

            return successResponse(res, {
                count:  Math.min(events.length, limit),
                events: events.slice(0, limit),
            });
        } catch (err) { next(err); }
    }
);

/**
 * GET /calendar/day
 *
 * All events for a specific date.
 *
 * Query params:
 *   date     ISO date string YYYY-MM-DD (default: today)
 *   types    comma-separated event type filter
 */
router.get('/day',
    authenticate,
    [
        query('date').optional().isDate(),
        query('types').optional().isString(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const dateStr = req.query.date || new Date().toISOString().slice(0, 10);
            const from    = new Date(`${dateStr}T00:00:00.000Z`);
            const to      = new Date(`${dateStr}T23:59:59.999Z`);
            const scope   = resolveScope(req, req.query.facilityId);

            const events  = await aggregateEvents({ from, to, scope, eventTypes: req.query.types || null });

            return successResponse(res, {
                date:   dateStr,
                count:  events.length,
                events,
            });
        } catch (err) { next(err); }
    }
);

/**
 * GET /calendar/week
 *
 * All events for the ISO week containing the given date.
 *
 * Query params:
 *   date     any date within the target week (default: today)
 *   types    comma-separated event type filter
 */
router.get('/week',
    authenticate,
    [
        query('date').optional().isDate(),
        query('types').optional().isString(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const anchor = new Date(req.query.date || new Date().toISOString().slice(0, 10));
            const dow    = anchor.getDay(); // 0 = Sunday

            const from = new Date(anchor);
            from.setDate(anchor.getDate() - dow);
            from.setHours(0, 0, 0, 0);

            const to = new Date(from);
            to.setDate(from.getDate() + 6);
            to.setHours(23, 59, 59, 999);

            const scope  = resolveScope(req, req.query.facilityId);
            const events = await aggregateEvents({ from, to, scope, eventTypes: req.query.types || null });

            return successResponse(res, {
                weekStart: from.toISOString().slice(0, 10),
                weekEnd:   to.toISOString().slice(0, 10),
                count:     events.length,
                events,
            });
        } catch (err) { next(err); }
    }
);

/**
 * GET /calendar/month
 *
 * All events for a calendar month.
 *
 * Query params:
 *   year     4-digit year  (default: current year)
 *   month    1–12          (default: current month)
 *   types    comma-separated event type filter
 */
router.get('/month',
    authenticate,
    [
        query('year').optional().isInt({ min: 2020, max: 2100 }),
        query('month').optional().isInt({ min: 1, max: 12 }),
        query('types').optional().isString(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const now   = new Date();
            const year  = Number(req.query.year)  || now.getFullYear();
            const month = Number(req.query.month) || (now.getMonth() + 1);

            const from = new Date(year, month - 1, 1,  0,  0,  0,   0);
            const to   = new Date(year, month,     0, 23, 59, 59, 999); // last day of month

            const scope  = resolveScope(req, req.query.facilityId);
            const events = await aggregateEvents({ from, to, scope, eventTypes: req.query.types || null });

            // Build a day-keyed summary for the month grid
            const byDay = {};
            for (const event of events) {
                const day = event.start.slice(0, 10);
                if (!byDay[day]) byDay[day] = { count: 0, types: {} };
                byDay[day].count++;
                byDay[day].types[event.type] = (byDay[day].types[event.type] || 0) + 1;
            }

            return successResponse(res, {
                year,
                month,
                monthStart: from.toISOString().slice(0, 10),
                monthEnd:   to.toISOString().slice(0, 10),
                totalCount: events.length,
                byDay,      // lightweight grid summary
                events,     // full event list
            });
        } catch (err) { next(err); }
    }
);

/**
 * GET /calendar/agenda
 *
 * Flat chronological list of events — ideal for mobile "agenda" view.
 * Groups events by date label for easy rendering.
 *
 * Query params:
 *   from     ISO date (default: today)
 *   days     number of days to look ahead (default: 14, max: 60)
 *   types    comma-separated event type filter
 */
router.get('/agenda',
    authenticate,
    [
        query('from').optional().isISO8601(),
        query('days').optional().isInt({ min: 1, max: 60 }),
        query('types').optional().isString(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const days  = Math.min(Number(req.query.days) || 14, 60);
            const from  = req.query.from ? new Date(req.query.from) : new Date();
            from.setHours(0, 0, 0, 0);
            const to    = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
            to.setHours(23, 59, 59, 999);

            const scope  = resolveScope(req, req.query.facilityId);
            const events = await aggregateEvents({ from, to, scope, eventTypes: req.query.types || null });

            // Group into date sections
            const sections = [];
            let currentDate = null;
            let currentSection = null;

            for (const event of events) {
                const day = event.start.slice(0, 10);
                if (day !== currentDate) {
                    currentDate    = day;
                    currentSection = { date: day, events: [] };
                    sections.push(currentSection);
                }
                currentSection.events.push(event);
            }

            return successResponse(res, {
                from:     from.toISOString().slice(0, 10),
                to:       to.toISOString().slice(0, 10),
                days,
                count:    events.length,
                sections,
            });
        } catch (err) { next(err); }
    }
);

/**
 * GET /calendar/summary
 *
 * Lightweight counts per event type for the given range.
 * Useful for dashboard badges and "this week" stats.
 *
 * Query params:
 *   from     ISO date string
 *   to       ISO date string
 */
router.get('/summary',
    authenticate,
    [
        query('from').optional().isISO8601(),
        query('to').optional().isISO8601(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const { from, to } = parseDateRange(req.query.from, req.query.to);
            const scope = resolveScope(req, req.query.facilityId);

            const facilityWhere     = scope.facilityId ? { facilityId: scope.facilityId } : {};
            const nurseWhere        = scope.nurseProfileId ? { nurseProfileId: scope.nurseProfileId } : {};
            const nurseAssignWhere  = scope.nurseProfileId
                ? { assignments: { some: { nurseProfileId: scope.nurseProfileId } } }
                : {};

            const [
                totalShifts,
                openShifts,
                bookedShifts,
                completedShifts,
                urgentShifts,
                totalVisits,
                flaggedVisits,
                completedVisits,
                expiringCredentials,
                overdueInvoices,
                dueInvoices,
            ] = await Promise.all([
                prisma.shift.count({ where: { scheduledStart: { gte: from, lte: to }, ...facilityWhere, ...nurseAssignWhere } }),
                prisma.shift.count({ where: { scheduledStart: { gte: from, lte: to }, status: 'OPEN',      ...facilityWhere } }),
                prisma.shift.count({ where: { scheduledStart: { gte: from, lte: to }, status: 'BOOKED',    ...facilityWhere, ...nurseAssignWhere } }),
                prisma.shift.count({ where: { scheduledStart: { gte: from, lte: to }, status: 'COMPLETED', ...facilityWhere, ...nurseAssignWhere } }),
                prisma.shift.count({ where: { scheduledStart: { gte: from, lte: to }, isUrgent: true,      ...facilityWhere } }),

                prisma.visit.count({ where: { createdAt: { gte: from, lte: to }, ...nurseWhere } }),
                prisma.visit.count({ where: { createdAt: { gte: from, lte: to }, overrideRequired: true, status: 'FLAGGED', ...nurseWhere } }),
                prisma.visit.count({ where: { createdAt: { gte: from, lte: to }, status: 'CHECKED_OUT', ...nurseWhere } }),

                scope.isAdmin || scope.nurseProfileId
                    ? prisma.credential.count({ where: { status: 'APPROVED', expiresAt: { gte: from, lte: to }, ...nurseWhere } })
                    : 0,

                scope.isAdmin || scope.facilityId
                    ? prisma.invoice.count({ where: { status: 'OVERDUE', dueAt: { gte: from, lte: to }, ...facilityWhere } })
                    : 0,

                scope.isAdmin || scope.facilityId
                    ? prisma.invoice.count({ where: { status: 'ISSUED',  dueAt: { gte: from, lte: to }, ...facilityWhere } })
                    : 0,
            ]);

            return successResponse(res, {
                period: { from: from.toISOString(), to: to.toISOString() },
                shifts: {
                    total:     totalShifts,
                    open:      openShifts,
                    booked:    bookedShifts,
                    completed: completedShifts,
                    urgent:    urgentShifts,
                },
                visits: {
                    total:     totalVisits,
                    flagged:   flaggedVisits,
                    completed: completedVisits,
                },
                credentials: {
                    expiringInPeriod: expiringCredentials,
                },
                invoices: {
                    due:     dueInvoices,
                    overdue: overdueInvoices,
                },
            });
        } catch (err) { next(err); }
    }
);

module.exports = router;