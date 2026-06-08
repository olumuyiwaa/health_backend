const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/authenticate');
const { prisma } = require('../../config/database');
const { successResponse, errorResponse } = require('../../utils/response');
const { Prisma } = require('@prisma/client');

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
router.get('/revenue', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const { from, to } = req.query;
        const { gte, lte } = dateRange(from, to);

        const [payoutTotals, invoiceTotals, byMonth, byFacility] = await Promise.all([
            // Payouts
            prisma.payout.aggregate({
                where: { createdAt: { gte, lte }, status: 'SETTLED' },
                _sum: { grossCharge: true, netPayout: true, systemCommission: true },
                _count: { id: true },
            }),

            // Invoices Aggregate
            prisma.invoice.aggregate({
                where: {
                    createdAt: { gte, lte },
                    status: { in: ['PAID', 'ISSUED'] }
                },
                _sum: { subtotal: true, tax: true, total: true },
                _count: { id: true },
            }),

            // Revenue by Month
            prisma.$queryRaw`
                SELECT
                    TO_CHAR(DATE_TRUNC('month', "createdAt"), 'YYYY-MM') AS month,
                    SUM("subtotal")::NUMERIC(12,2)     AS "grossRevenue",
                    SUM("total")::NUMERIC(12,2)        AS "totalInvoiced",
                    COUNT(id)                          AS "invoiceCount"
                FROM "Invoice"
                WHERE "createdAt" >= ${gte}
                  AND "createdAt" <= ${lte}
                  AND status IN ('PAID', 'ISSUED')
                GROUP BY DATE_TRUNC('month', "createdAt")
                ORDER BY month ASC
            `,

            // FIXED: By Facility
            prisma.$queryRaw`
                SELECT
                    f.id            AS "facilityId",
                    f.name          AS "facilityName",
                    COUNT(i.id)     AS "invoiceCount",
                    SUM(i."total")::NUMERIC(12,2) AS "totalRevenue"
                FROM "Invoice" i
                         JOIN "Facility" f ON f.id = i."facilityId"
                WHERE i."createdAt" >= ${gte}
                  AND i."createdAt" <= ${lte}
                  AND i.status IN ('PAID', 'ISSUED')
                GROUP BY f.id, f.name
                ORDER BY "totalRevenue" DESC
                    LIMIT 10
            `,
        ]);

        const safeByMonth = (byMonth || []).map((m) => ({
            month: m.month,
            grossRevenue: Number(m.grossRevenue || 0),
            totalInvoiced: Number(m.totalInvoiced || 0),
            invoiceCount: Number(m.invoiceCount || 0),
        }));

        const safeByFacility = (byFacility || []).map((f) => ({
            facilityId: f.facilityId,
            facilityName: f.facilityName,
            invoiceCount: Number(f.invoiceCount || 0),
            totalRevenue: Number(f.totalRevenue || 0),
        }));

        return successResponse(res, {
            period: { from: gte, to: lte },
            totals: {
                grossRevenue: Number(invoiceTotals._sum.total || 0),
                netPayouts: Number(payoutTotals._sum.netPayout || 0),
                systemCommission: Number(payoutTotals._sum.systemCommission || 0),
                settledPayouts: Number(payoutTotals._count.id || 0),
                totalInvoices: Number(invoiceTotals._count.id || 0),
            },
            byFacility: safeByFacility,     // ← Now properly populated
            byMonth: safeByMonth,
        });
    } catch (err) {
        next(err);
    }
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

        const [shiftStats, visitStats, topNursesRaw, caseCount] = await Promise.all([
            prisma.shift.groupBy({
                by:    ['status'],
                where: { facilityId: fid, scheduledStart: { gte, lte } },
                _count: { id: true },
            }),

            // FIXED: Use assignment.shift instead of direct shift
            prisma.visit.aggregate({
                where: {
                    status: 'CHECKED_OUT',
                    assignment: {
                        shift: {
                            facilityId: fid,
                            scheduledStart: { gte, lte }
                        }
                    }
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

        const topNurses = (topNursesRaw || []).map(n => ({
            name: n.name,
            designation: n.designation,
            shiftsCompleted: Number(n.shiftsCompleted || 0),
        }));

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
    } catch (err) {
        next(err);
    }
});

// ─── Worker Activity ──────────────────────────
// GET /reports/workers
router.get('/workers', authenticate, authorize('SUPER_ADMIN', 'RECRUITER', 'FACILITY_ADMIN'), async (req, res, next) => {
    try {
        const { from, to, facilityId, designation, limit = 50, page = 1 } = req.query;

        const { gte, lte } = dateRange(from, to);
        const fid = facilityScope(req, facilityId);
        const take = Math.min(Math.max(Number(limit) || 50, 1), 100); // max 100
        const skip = (Number(page) - 1) * take;

        const facilityFilter = fid
            ? Prisma.sql`AND s."facilityId" = ${fid}`
            : Prisma.empty;

        const workers = await prisma.$queryRaw`
            SELECT
                np.id,
                np."firstName" || ' ' || np."lastName" AS name,
                np.designation,
                u.email,
                COUNT(CASE WHEN sa.status = 'COMPLETED' THEN 1 END) AS "completedShifts",
                COUNT(CASE WHEN sa.status = 'CANCELLED' THEN 1 END) AS "cancelledShifts",
                COUNT(CASE WHEN sa.status = 'ACCEPTED' THEN 1 END) AS "upcomingShifts",
                ROUND(AVG(v."durationMinutes")) AS "avgVisitMinutes",
                COALESCE(SUM(p."netPayout"), 0) AS "totalEarnings"
            FROM "NurseProfile" np
            JOIN "User" u ON u.id = np."userId"

            LEFT JOIN "ShiftAssignment" sa
                      ON sa."nurseProfileId" = np.id
                          AND sa."createdAt" >= ${gte}
                          AND sa."createdAt" <= ${lte}

            LEFT JOIN "Shift" s
                      ON s.id = sa."shiftId"
            ${facilityFilter}

            LEFT JOIN "Visit" v
                      ON v."assignmentId" = sa.id

            LEFT JOIN "Payout" p
                      ON p."nurseProfileId" = np.id
                      AND p.status = 'SETTLED'
                      AND p."createdAt" >= ${gte}
                      AND p."createdAt" <= ${lte}

            ${designation ? Prisma.sql`WHERE np.designation = ${designation}` : Prisma.empty}

            GROUP BY
                np.id,
                np."firstName",
                np."lastName",
                np.designation,
                u.email

            ORDER BY "completedShifts" DESC
            LIMIT ${take}
            OFFSET ${skip}
        `;

        // Convert BigInts to safe numbers
        const safeWorkers = workers.map(w => ({
            id: w.id,
            name: w.name,
            designation: w.designation,
            email: w.email,
            completedShifts: Number(w.completedShifts || 0),
            cancelledShifts: Number(w.cancelledShifts || 0),
            upcomingShifts: Number(w.upcomingShifts || 0),
            avgVisitMinutes: Number(w.avgVisitMinutes || 0),
            totalEarnings: Number(w.totalEarnings || 0),
        }));

        // Optional: Return total count for pagination
        const totalResult = await prisma.$queryRaw`
            SELECT COUNT(DISTINCT np.id) AS total
            FROM "NurseProfile" np
            JOIN "User" u ON u.id = np."userId"
            LEFT JOIN "ShiftAssignment" sa ON sa."nurseProfileId" = np.id
                AND sa."createdAt" >= ${gte} AND sa."createdAt" <= ${lte}
            LEFT JOIN "Shift" s ON s.id = sa."shiftId"
            ${facilityFilter}
            ${designation ? Prisma.sql`WHERE np.designation = ${designation}` : Prisma.empty}
        `;

        const total = Number(totalResult[0]?.total || 0);

        return successResponse(res, {
            data: safeWorkers,
            pagination: {
                page: Number(page),
                limit: take,
                total,
                totalPages: Math.ceil(total / take),
                hasNext: Number(page) * take < total,
                hasPrev: Number(page) > 1,
            }
        });

    } catch (err) {
        next(err);
    }
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
        let { from, to, facilityId } = req.query;

        // Default to last 3 months if no date range is provided
        if (!from && !to) {
            const threeMonthsAgo = new Date();
            threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
            from = threeMonthsAgo.toISOString();
        }

        const { gte, lte } = dateRange(from, to);

        let finalFacilityId = facilityId;
        if (['FACILITY_ADMIN', 'TEAM_MEMBER'].includes(req.user.role)) {
            finalFacilityId = req.user.facilityMember?.facilityId;
        }

        const where = {
            createdAt: { gte, lte },
            ...(finalFacilityId ? { facilityId: finalFacilityId } : {}),
        };

        const [invoiceSummary, byStatus] = await Promise.all([
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
        ]);

        return successResponse(res, {
            period: { from: gte, to: lte },
            totals: {
                invoiceCount: Number(invoiceSummary._count.id || 0),
                subtotal:     Number(invoiceSummary._sum.subtotal || 0),
                tax:          Number(invoiceSummary._sum.tax || 0),
                total:        Number(invoiceSummary._sum.total || 0),
            },
            byStatus: byStatus.map((s) => ({
                status: s.status,
                count:  Number(s._count.id || 0),
                total:  Number(s._sum.total || 0),
            })),
        });
    } catch (err) {
        next(err);
    }
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
                // where:   { facilityId: fid, status: { in: ['OPEN','BOOKED'] }, scheduledStart: { gte: new Date() } },
                where: {
                    facilityId: fid,
                    status: { in: ['OPEN', 'BOOKED'] },
                    OR: [
                        {
                            scheduledStart: {
                                gte: new Date(),
                            },
                        },
                        {
                            scheduledStart: {
                                lte: new Date(),
                            },
                            scheduledEnd: {
                                gte: new Date(),
                            },
                        },
                    ],
                },
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