const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/authenticate');
const { prisma } = require('../../config/database');
const { successResponse, errorResponse } = require('../../utils/response');

// ─── Helpers ───────────────────────────────────

function dateRange(from, to) {
    const gte = from ? new Date(from) : new Date(new Date().setDate(1)); // default: start of month
    const lte = to   ? new Date(to)   : new Date();
    return { gte, lte };
}

function facilityScope(req, facilityId) {
    if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'RECRUITER') {
        return facilityId || undefined;
    }
    return req.user.facilityMember?.facilityId;
}

// ─── Shift Analytics ───────────────────────────
// GET /reports/shifts
// Returns: total, filled, cancelled, completion rate, by designation, by visit type
router.get('/shifts', authenticate, async (req, res, next) => {
    try {
        const { from, to, facilityId } = req.query;
        const { gte, lte } = dateRange(from, to);
        const fid = facilityScope(req, facilityId);

        const where = {
            scheduledStart: { gte, lte },
            ...(fid ? { facilityId: fid } : {}),
        };

        const [total, filled, cancelled, completed, byDesignation, byVisitType] = await Promise.all([
            prisma.shift.count({ where }),
            prisma.shift.count({ where: { ...where, status: 'BOOKED' } }),
            prisma.shift.count({ where: { ...where, status: 'CANCELLED' } }),
            prisma.shift.count({ where: { ...where, status: 'COMPLETED' } }),
            prisma.shift.groupBy({
                by:    ['requiredDesignation'],
                where,
                _count: { id: true },
            }),
            prisma.shift.groupBy({
                by:    ['visitType'],
                where,
                _count: { id: true },
            }),
        ]);

        const open           = await prisma.shift.count({ where: { ...where, status: 'OPEN' } });
        const fillRate       = total > 0 ? ((filled + completed) / total * 100).toFixed(1) : '0.0';
        const completionRate = total > 0 ? (completed / total * 100).toFixed(1) : '0.0';

        return successResponse(res, {
            period:   { from: gte, to: lte },
            summary: { total, open, filled, completed, cancelled },
            rates:   { fillRate: `${fillRate}%`, completionRate: `${completionRate}%` },
            byDesignation: byDesignation.map((r) => ({
                designation: r.requiredDesignation,
                count:       r._count.id,
            })),
            byVisitType: byVisitType.map((r) => ({
                visitType: r.visitType,
                count:     r._count.id,
            })),
        });
    } catch (err) { next(err); }
});

// ─── Revenue Dashboard ─────────────────────────
// GET /reports/revenue
// Returns: gross revenue, net payouts, commission, by facility, by month
router.get('/revenue', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const { from, to } = req.query;
        const { gte, lte } = dateRange(from, to);

        const [totals, byFacility, byMonth] = await Promise.all([
            // Overall payout totals
            prisma.payout.aggregate({
                where:   { createdAt: { gte, lte }, status: 'SETTLED' },
                _sum:    { grossCharge: true, netPayout: true, systemCommission: true },
                _count:  { id: true },
            }),

            // Revenue per facility (via shifts → cases → facility)
            prisma.$queryRaw`
        SELECT
          f.id            AS "facilityId",
          f.name          AS "facilityName",
          COUNT(s.id)     AS "shiftCount",
          SUM(s."chargeRate" * EXTRACT(EPOCH FROM (s."scheduledEnd" - s."scheduledStart")) / 3600)::NUMERIC(12,2) AS "estimatedRevenue"
        FROM "Shift" s
        JOIN "Case" c  ON c.id = s."caseId"
        JOIN "Facility" f ON f.id = c."facilityId"
        WHERE s.status = 'COMPLETED'
          AND s."scheduledStart" >= ${gte}
          AND s."scheduledStart" <= ${lte}
        GROUP BY f.id, f.name
        ORDER BY "estimatedRevenue" DESC
        LIMIT 10
      `,

            // Revenue by month
            prisma.$queryRaw`
        SELECT
          TO_CHAR(DATE_TRUNC('month', "createdAt"), 'YYYY-MM') AS month,
          SUM("grossCharge")::NUMERIC(12,2)     AS "grossRevenue",
          SUM("netPayout")::NUMERIC(12,2)       AS "netPayouts",
          SUM("systemCommission")::NUMERIC(12,2) AS "commission",
          COUNT(id)                              AS "payoutCount"
        FROM "Payout"
        WHERE status = 'SETTLED'
          AND "createdAt" >= ${gte}
          AND "createdAt" <= ${lte}
        GROUP BY DATE_TRUNC('month', "createdAt")
        ORDER BY month ASC
      `,
        ]);

        const safeByMonth = (byMonth || []).map((m) => ({
            month: m.month,
            grossRevenue: Number(m.grossRevenue || 0),
            netPayouts: Number(m.netPayouts || 0),
            commission: Number(m.commission || 0),
            payoutCount: Number(m.payoutCount || 0),
        }));

        const safeByFacility = (byFacility || []).map((f) => ({
            facilityId: f.facilityId,
            facilityName: f.facilityName,
            shiftCount: Number(f.shiftCount || 0),
            estimatedRevenue: Number(f.estimatedRevenue || 0),
        }));

        return successResponse(res, {
            period: { from: gte, to: lte },
            totals: {
                grossRevenue: Number(totals._sum.grossCharge || 0),
                netPayouts: Number(totals._sum.netPayout || 0),
                systemCommission: Number(totals._sum.systemCommission || 0),
                settledPayouts: Number(totals._count.id || 0),
            },
            byFacility: safeByFacility,
            byMonth: safeByMonth,
        });
    } catch (err) { next(err); }
});

// ─── Facility Performance ─────────────────────
// GET /reports/facilities/:facilityId/performance
router.get('/facilities/:facilityId/performance', authenticate, async (req, res, next) => {
    try {
        // Scope: facility users can only see their own
        if (['FACILITY_ADMIN', 'TEAM_MEMBER'].includes(req.user.role)) {
            if (req.user.facilityMember?.facilityId !== req.params.facilityId) {
                return errorResponse(res, 'Forbidden', 403);
            }
        }

        const { from, to } = req.query;
        const { gte, lte } = dateRange(from, to);
        const fid = req.params.facilityId;

        const [shiftStats, visitStats, topNurses, caseCount] = await Promise.all([
            prisma.shift.groupBy({
                by:    ['status'],
                where: { facilityId: fid, scheduledStart: { gte, lte } },
                _count: { id: true },
            }),

            prisma.visit.aggregate({
                where: {
                    shift: { facilityId: fid, scheduledStart: { gte, lte } },
                    status: 'CHECKED_OUT',
                },
                _avg:   { durationMinutes: true },
                _count: { id: true },
            }),

            prisma.$queryRaw`
        SELECT
          np."firstName" || ' ' || np."lastName" AS name,
          np.designation,
          COUNT(sa.id) AS "shiftsCompleted"
        FROM "ShiftAssignment" sa
        JOIN "NurseProfile" np ON np.id = sa."nurseProfileId"
        JOIN "Shift" s         ON s.id  = sa."shiftId"
        WHERE s."facilityId" = ${fid}
          AND sa.status      = 'COMPLETED'
          AND s."scheduledStart" >= ${gte}
          AND s."scheduledStart" <= ${lte}
        GROUP BY np.id, np."firstName", np."lastName", np.designation
        ORDER BY "shiftsCompleted" DESC
        LIMIT 5
      `,

            prisma.case.count({ where: { facilityId: fid, isActive: true } }),
        ]);

        const statusMap = Object.fromEntries(shiftStats.map((s) => [s.status, s._count.id]));

        return successResponse(res, {
            period: { from: gte, to: lte },
            shifts: {
                total:     Object.values(statusMap).reduce((a, b) => a + b, 0),
                open:      statusMap.OPEN       || 0,
                booked:    statusMap.BOOKED     || 0,
                completed: statusMap.COMPLETED  || 0,
                cancelled: statusMap.CANCELLED  || 0,
            },
            visits: {
                completed:          visitStats._count.id,
                avgDurationMinutes: Math.round(visitStats._avg.durationMinutes || 0),
            },
            activeCases: caseCount,
            topNurses,
        });
    } catch (err) { next(err); }
});

// ─── Worker Activity ──────────────────────────
// GET /reports/workers
router.get('/workers', authenticate, authorize('SUPER_ADMIN', 'RECRUITER', 'FACILITY_ADMIN'), async (req, res, next) => {
    try {
        const { from, to, facilityId, designation } = req.query;
        const { gte, lte } = dateRange(from, to);
        const fid = facilityScope(req, facilityId);

        const workers = await prisma.$queryRaw`
      SELECT
        np.id,
        np."firstName" || ' ' || np."lastName" AS name,
        np.designation,
        u.email,
        COUNT(CASE WHEN sa.status = 'COMPLETED' THEN 1 END) AS "completedShifts",
        COUNT(CASE WHEN sa.status = 'CANCELLED' THEN 1 END) AS "cancelledShifts",
        COUNT(CASE WHEN sa.status = 'ACCEPTED'  THEN 1 END) AS "upcomingShifts",
        ROUND(AVG(v."durationMinutes"))                      AS "avgVisitMinutes",
        SUM(p."netPayout")                                   AS "totalEarnings"
      FROM "NurseProfile" np
      JOIN "User" u         ON u.id  = np."userId"
      LEFT JOIN "ShiftAssignment" sa ON sa."nurseProfileId" = np.id
        AND sa."createdAt" >= ${gte} AND sa."createdAt" <= ${lte}
      LEFT JOIN "Shift" s ON s.id = sa."shiftId"
        ${fid ? prisma.$raw`AND s."facilityId" = ${fid}` : prisma.$raw``}
      LEFT JOIN "Visit" v  ON v."assignmentId" = sa.id
      LEFT JOIN "Payout" p ON p."nurseProfileId" = np.id
        AND p.status = 'SETTLED'
        AND p."createdAt" >= ${gte} AND p."createdAt" <= ${lte}
      ${designation ? prisma.$raw`WHERE np.designation = ${designation}` : prisma.$raw``}
      GROUP BY np.id, np."firstName", np."lastName", np.designation, u.email
      ORDER BY "completedShifts" DESC
      LIMIT 50
    `;

        return successResponse(res, workers);
    } catch (err) { next(err); }
});

// ─── Credential Expiry Report ─────────────────
// GET /reports/credentials/expiry
router.get('/credentials/expiry', authenticate, authorize('SUPER_ADMIN', 'RECRUITER'), async (req, res, next) => {
    try {
        const days   = Number(req.query.days)   || 30;
        const status = req.query.status || 'APPROVED';

        const threshold = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

        const [expiringSoon, alreadyExpired] = await Promise.all([
            prisma.credential.findMany({
                where: {
                    status,
                    expiresAt: { gte: new Date(), lte: threshold },
                },
                include: {
                    nurseProfile: {
                        select: {
                            firstName: true, lastName: true, designation: true,
                            user: { select: { email: true, phone: true } },
                        },
                    },
                },
                orderBy: { expiresAt: 'asc' },
            }),

            prisma.credential.findMany({
                where: {
                    status,
                    expiresAt: { lt: new Date() },
                },
                include: {
                    nurseProfile: {
                        select: {
                            firstName: true, lastName: true, designation: true,
                            user: { select: { email: true } },
                        },
                    },
                },
                orderBy: { expiresAt: 'asc' },
                take: 100,
            }),
        ]);

        const byType = (list) =>
            list.reduce((acc, c) => {
                acc[c.type] = (acc[c.type] || 0) + 1;
                return acc;
            }, {});

        return successResponse(res, {
            thresholdDays: days,
            expiringSoon: {
                count:   expiringSoon.length,
                byType:  byType(expiringSoon),
                records: expiringSoon,
            },
            alreadyExpired: {
                count:   alreadyExpired.length,
                byType:  byType(alreadyExpired),
                records: alreadyExpired,
            },
        });
    } catch (err) { next(err); }
});

// ─── Billing Report ───────────────────────────
// GET /reports/billing
router.get('/billing', authenticate, authorize('SUPER_ADMIN', 'FACILITY_ADMIN'), async (req, res, next) => {
    try {
        const { from, to, facilityId } = req.query;
        const { gte, lte } = dateRange(from, to);
        const fid = facilityScope(req, facilityId);

        const where = {
            createdAt: { gte, lte },
            ...(fid ? { facilityId: fid } : {}),
        };

        const [invoiceSummary, byStatus, recentInvoices] = await Promise.all([
            prisma.invoice.aggregate({
                where,
                _sum:   { subtotal: true, tax: true, total: true },
                _count: { id: true },
            }),

            prisma.invoice.groupBy({
                by:    ['status'],
                where,
                _sum:   { total: true },
                _count: { id: true },
            }),

            prisma.invoice.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take: 20,
                select: {
                    id: true, invoiceNumber: true, status: true,
                    total: true, dueAt: true, paidAt: true,
                    facility: { select: { name: true } },
                },
            }),
        ]);

        return successResponse(res, {
            period: { from: gte, to: lte },
            totals: {
                invoiceCount: invoiceSummary._count.id,
                subtotal:     invoiceSummary._sum.subtotal || 0,
                tax:          invoiceSummary._sum.tax      || 0,
                total:        invoiceSummary._sum.total    || 0,
            },
            byStatus: byStatus.map((s) => ({
                status: s.status,
                count:  s._count.id,
                total:  s._sum.total,
            })),
            recentInvoices,
        });
    } catch (err) { next(err); }
});

// ─── Audit Trail ──────────────────────────────
// GET /reports/audit-trail
router.get('/audit-trail', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const {
            page = 1, limit = 50,
            from, to,
            userId: filterUser,
            resource,
            action,
        } = req.query;

        const { gte, lte } = dateRange(from, to);
        const skip = (page - 1) * limit;

        const where = {
            createdAt: { gte, lte },
            ...(filterUser ? { userId:   filterUser } : {}),
            ...(resource   ? { resource }              : {}),
            ...(action     ? { action }                : {}),
        };

        const [logs, total] = await Promise.all([
            prisma.auditLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip:    Number(skip),
                take:    Number(limit),
                include: {
                    user: { select: { email: true, role: true } },
                },
            }),
            prisma.auditLog.count({ where }),
        ]);

        const totalPages = Math.ceil(total / limit);

        return successResponse(res, {
            data: logs,
            pagination: {
                page:       Number(page),
                limit:      Number(limit),
                total,
                totalPages,
                hasNext:    Number(page) < totalPages,
                hasPrev:    Number(page) > 1,
            },
        });
    } catch (err) { next(err); }
});

// ─── Dashboard Summary (Admin) ────────────────
// GET /reports/dashboard
router.get('/dashboard', authenticate, authorize('SUPER_ADMIN', 'RECRUITER'), async (req, res, next) => {
    try {
        const now       = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const [
            totalUsers,
            activeNurses,
            activeFacilities,
            openShifts,
            completedThisMonth,
            pendingCredentials,
            flaggedVisits,
            pendingPayouts,
        ] = await Promise.all([
            prisma.user.count({ where: { status: 'ACTIVE', deletedAt: null } }),
            prisma.user.count({ where: { role: 'NURSE', status: 'ACTIVE' } }),
            prisma.facility.count({ where: { status: 'ACTIVE', deletedAt: null } }),
            prisma.shift.count({ where: { status: 'OPEN' } }),
            prisma.shift.count({ where: { status: 'COMPLETED', scheduledStart: { gte: monthStart } } }),
            prisma.credential.count({ where: { status: 'PENDING' } }),
            prisma.visit.count({ where: { overrideRequired: true, status: 'FLAGGED' } }),
            prisma.payout.aggregate({
                where: { status: 'PENDING' },
                _sum:  { netPayout: true },
                _count: { id: true },
            }),
        ]);

        return successResponse(res, {
            users:       { total: totalUsers, activeNurses, activeFacilities },
            shifts:      { open: openShifts, completedThisMonth },
            credentials: { pendingReview: pendingCredentials },
            visits:      { flaggedOverrides: flaggedVisits },
            payouts: {
                pendingCount:  pendingPayouts._count.id,
                pendingAmount: pendingPayouts._sum.netPayout || 0,
            },
        });
    } catch (err) { next(err); }
});

// ─── Facility Dashboard Summary ───────────────
router.get('/facilities/:facilityId/dashboard', authenticate, async (req, res, next) => {
    try {
        if (['FACILITY_ADMIN', 'TEAM_MEMBER'].includes(req.user.role)) {
            if (req.user.facilityMember?.facilityId !== req.params.facilityId) {
                return errorResponse(res, 'Forbidden', 403);
            }
        }

        const fid = req.params.facilityId;
        const now  = new Date();
        const weekStart = new Date(now.setDate(now.getDate() - now.getDay()));

        const [
            openShifts,
            shiftsFillThisWeek,
            activeCases,
            pendingOverrides, // UPDATED BELOW
            upcomingShifts,
        ] = await Promise.all([
            prisma.shift.count({ where: { facilityId: fid, status: 'OPEN' } }),
            prisma.shift.count({ where: { facilityId: fid, status: { in: ['BOOKED','COMPLETED'] }, scheduledStart: { gte: weekStart } } }),
            prisma.case.count({ where:  { facilityId: fid, isActive: true } }),
            prisma.visit.count({
                where: {
                    overrideRequired: true,
                    status: 'FLAGGED',
                    assignment: {
                        shift: { facilityId: fid }
                    }
                }
            }),
            prisma.shift.findMany({
                where:   { facilityId: fid, status: { in: ['OPEN','BOOKED'] }, scheduledStart: { gte: new Date() } },
                orderBy: { scheduledStart: 'asc' },
                take:    5,
                include: {
                    case:        { select: { publicIdentifier: true } },
                    assignments: { where: { status: 'ACCEPTED' }, include: { nurseProfile: { select: { firstName: true, lastName: true } } } },
                },
            }),
        ]);

        return successResponse(res, {
            stats: { openShifts, shiftsFillThisWeek, activeCases, pendingOverrides },
            upcomingShifts,
        });
    } catch (err) { next(err); }
});

module.exports = router;