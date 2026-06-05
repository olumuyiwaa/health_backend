const router = require('express').Router();
const express = require('express');
const { body } = require('express-validator');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');
const { prisma } = require('../../config/database');
const {
    successResponse,
    createdResponse,
    errorResponse,
    paginatedResponse,
    buildPagination,
} = require('../../utils/response');
const { writeAuditLog } = require('../../utils/audit');
const { dispatchNotification } = require('../notifications/notifications.service');

// Stripe is initialised lazily so the server boots even without a key in dev
function getStripe() {
    if (!process.env.STRIPE_SECRET_KEY) return null;
    return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function generateInvoiceNumber() {
    const ts   = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `INV-${ts}-${rand}`;
}

// ─── Invoice Routes ─────────────────────────────────────────────────────────

// POST /billing/invoices  — admin generates an invoice for a facility
router.post(
    '/invoices',
    authenticate,
    authorize('SUPER_ADMIN'),
    [
        body('facilityId').notEmpty(),
        body('periodStart').isISO8601(),
        body('periodEnd').isISO8601(),
        body('lineItems').isArray({ min: 1 }),
        body('lineItems.*.description').trim().notEmpty(),
        body('lineItems.*.quantity').isFloat({ min: 0 }),
        body('lineItems.*.unitRate').isFloat({ min: 0 }),
        body('dueAt').optional().isISO8601(),
        body('notes').optional().trim(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const { facilityId, periodStart, periodEnd, lineItems, dueAt, notes } = req.body;

            const facility = await prisma.facility.findUnique({
                where:  { id: facilityId },
                select: { id: true, name: true, email: true, stripeCustomerId: true },
            });
            if (!facility) return errorResponse(res, 'Facility not found', 404);

            // Calculate totals
            const subtotal = lineItems.reduce(
                (sum, item) => sum + parseFloat(item.quantity) * parseFloat(item.unitRate),
                0
            );
            const tax   = parseFloat(req.body.tax || 0);
            const total = subtotal + tax;

            const invoice = await prisma.$transaction(async (tx) => {
                const inv = await tx.invoice.create({
                    data: {
                        facilityId,
                        invoiceNumber: generateInvoiceNumber(),
                        status:        'DRAFT',
                        periodStart:   new Date(periodStart),
                        periodEnd:     new Date(periodEnd),
                        subtotal,
                        tax,
                        total,
                        dueAt:         dueAt ? new Date(dueAt) : null,
                        notes:         notes || null,
                    },
                });

                await tx.invoiceLineItem.createMany({
                    data: lineItems.map((item) => ({
                        invoiceId:   inv.id,
                        shiftId:     item.shiftId || null,
                        description: item.description,
                        quantity:    parseFloat(item.quantity),
                        unitRate:    parseFloat(item.unitRate),
                        amount:      parseFloat(item.quantity) * parseFloat(item.unitRate),
                    })),
                });

                return inv;
            });

            await writeAuditLog({
                userId:     req.user.id,
                action:     'CREATE',
                resource:   'Invoice',
                resourceId: invoice.id,
                req,
            });

            return createdResponse(res, invoice, 'Invoice created');
        } catch (err) {
            next(err);
        }
    }
);

// PATCH /billing/invoices/:id/issue  — move from DRAFT → ISSUED
router.patch(
    '/invoices/:id/issue',
    authenticate,
    authorize('SUPER_ADMIN'),
    async (req, res, next) => {
        try {
            const invoice = await prisma.invoice.findUnique({
                where:   { id: req.params.id },
                include: { facility: { select: { email: true, name: true } } },
            });
            if (!invoice) return errorResponse(res, 'Invoice not found', 404);
            if (invoice.status !== 'DRAFT') return errorResponse(res, 'Only draft invoices can be issued', 400);

            const updated = await prisma.invoice.update({
                where: { id: req.params.id },
                data:  { status: 'ISSUED' },
            });

            // Notify facility admin
            const facilityAdmin = await prisma.facilityMember.findFirst({
                where:  { facilityId: invoice.facilityId },
                select: { userId: true },
            });
            if (facilityAdmin) {
                await dispatchNotification({
                    userId:   facilityAdmin.userId,
                    type:     'PAYMENT_ALERT',
                    title:    'Invoice Issued',
                    body:     `Invoice ${invoice.invoiceNumber} for $${invoice.total} has been issued.`,
                    channels: ['EMAIL', 'PUSH'],
                });
            }

            await writeAuditLog({ userId: req.user.id, action: 'UPDATE', resource: 'Invoice', resourceId: invoice.id, req });
            return successResponse(res, updated, 'Invoice issued');
        } catch (err) {
            next(err);
        }
    }
);

// PATCH /billing/invoices/:id/void
router.patch(
    '/invoices/:id/void',
    authenticate,
    authorize('SUPER_ADMIN'),
    async (req, res, next) => {
        try {
            const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
            if (!invoice) return errorResponse(res, 'Invoice not found', 404);
            if (invoice.status === 'PAID') return errorResponse(res, 'Cannot void a paid invoice', 400);

            const updated = await prisma.invoice.update({
                where: { id: req.params.id },
                data:  { status: 'VOID' },
            });

            await writeAuditLog({ userId: req.user.id, action: 'UPDATE', resource: 'Invoice', resourceId: invoice.id, req });
            return successResponse(res, updated, 'Invoice voided');
        } catch (err) {
            next(err);
        }
    }
);


// GET /billing/invoices  — list invoices (scoped by role)
router.get('/invoices', authenticate, async (req, res, next) => {
    try {
        const { page = 1, limit = 20, facilityId, status } = req.query;
        const skip = (Number(page) - 1) * Number(limit);

        let facilityFilter = facilityId;
        if (['FACILITY_ADMIN', 'TEAM_MEMBER'].includes(req.user.role)) {
            facilityFilter = req.user.facilityMember?.facilityId;
        }

        const where = {
            ...(facilityFilter ? { facilityId: facilityFilter } : {}),
            ...(status         ? { status }                     : {}),
        };

        const [invoices, total] = await Promise.all([
            prisma.invoice.findMany({
                where,
                skip,
                take:    Number(limit),
                orderBy: { createdAt: 'desc' },
                include: {
                    facility:  { select: { name: true } },
                    lineItems: true,
                },
            }),
            prisma.invoice.count({ where }),
        ]);

        return paginatedResponse(res, invoices, buildPagination(page, limit, total));
    } catch (err) {
        next(err);
    }
});

// GET /billing/invoices/:id
router.get('/invoices/:id', authenticate, async (req, res, next) => {
    try {
        const invoice = await prisma.invoice.findUnique({
            where:   { id: req.params.id },
            include: { facility: true, lineItems: true },
        });
        if (!invoice) return errorResponse(res, 'Invoice not found', 404);

        // Scope: facility users can only view their own invoices
        if (['FACILITY_ADMIN', 'TEAM_MEMBER'].includes(req.user.role)) {
            if (invoice.facilityId !== req.user.facilityMember?.facilityId) {
                return errorResponse(res, 'Forbidden', 403);
            }
        }

        return successResponse(res, invoice);
    } catch (err) {
        next(err);
    }
});

// ─── Stripe Payment Intent ─────────────────────────────────────────────────

// POST /billing/invoices/:id/pay  — create Stripe PaymentIntent for facility
router.post(
    '/invoices/:id/pay',
    authenticate,
    authorize('FACILITY_ADMIN', 'SUPER_ADMIN'),
    async (req, res, next) => {
        try {
            const stripe = getStripe();
            if (!stripe) return errorResponse(res, 'Stripe is not configured', 503);

            const invoice = await prisma.invoice.findUnique({
                where:   { id: req.params.id },
                include: { facility: { select: { stripeCustomerId: true, name: true, email: true } } },
            });
            if (!invoice) return errorResponse(res, 'Invoice not found', 404);
            if (invoice.status === 'PAID') return errorResponse(res, 'Invoice already paid', 400);
            if (invoice.status !== 'ISSUED') return errorResponse(res, 'Invoice must be issued before payment', 400);

            // Ensure Stripe customer exists
            let customerId = invoice.facility.stripeCustomerId;
            if (!customerId) {
                const customer = await stripe.customers.create({
                    name:  invoice.facility.name,
                    email: invoice.facility.email,
                });
                customerId = customer.id;
                await prisma.facility.update({
                    where: { id: invoice.facilityId },
                    data:  { stripeCustomerId: customerId },
                });
            }

            const paymentIntent = await stripe.paymentIntents.create({
                amount:      Math.round(parseFloat(invoice.total) * 100), // cents
                currency:    'usd',
                customer:    customerId,
                description: `Invoice ${invoice.invoiceNumber}`,
                metadata:    { invoiceId: invoice.id, facilityId: invoice.facilityId },
            });

            await prisma.invoice.update({
                where: { id: invoice.id },
                data:  { stripePaymentIntentId: paymentIntent.id },
            });

            return successResponse(res, {
                clientSecret:    paymentIntent.client_secret,
                paymentIntentId: paymentIntent.id,
                amount:          invoice.total,
            });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Stripe Webhook ────────────────────────────────────────────────────────

// POST /billing/webhooks/stripe
// Raw body required — mount before express.json() in a real app;
// here we use express.raw() locally on this route.
router.post(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    async (req, res, next) => {
        try {
            const stripe = getStripe();
            if (!stripe) return res.sendStatus(200);

            const sig     = req.headers['stripe-signature'];
            const secret  = process.env.STRIPE_WEBHOOK_SECRET;

            let event;
            try {
                event = stripe.webhooks.constructEvent(req.body, sig, secret);
            } catch (err) {
                return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
            }

            switch (event.type) {
                case 'payment_intent.succeeded': {
                    const pi = event.data.object;
                    const invoice = await prisma.invoice.findFirst({
                        where: { stripePaymentIntentId: pi.id },
                    });
                    if (invoice) {
                        await prisma.invoice.update({
                            where: { id: invoice.id },
                            data:  { status: 'PAID', paidAt: new Date() },
                        });

                        const facilityAdmin = await prisma.facilityMember.findFirst({
                            where:  { facilityId: invoice.facilityId },
                            select: { userId: true },
                        });
                        if (facilityAdmin) {
                            await dispatchNotification({
                                userId:   facilityAdmin.userId,
                                type:     'PAYMENT_ALERT',
                                title:    'Payment Successful',
                                body:     `Invoice ${invoice.invoiceNumber} has been paid.`,
                                channels: ['EMAIL', 'PUSH'],
                            });
                        }
                    }
                    break;
                }

                case 'payment_intent.payment_failed': {
                    const pi = event.data.object;
                    const invoice = await prisma.invoice.findFirst({
                        where: { stripePaymentIntentId: pi.id },
                    });
                    if (invoice) {
                        const facilityAdmin = await prisma.facilityMember.findFirst({
                            where:  { facilityId: invoice.facilityId },
                            select: { userId: true },
                        });
                        if (facilityAdmin) {
                            await dispatchNotification({
                                userId:   facilityAdmin.userId,
                                type:     'PAYMENT_ALERT',
                                title:    'Payment Failed',
                                body:     `Payment for invoice ${invoice.invoiceNumber} failed. Please update your payment method.`,
                                channels: ['EMAIL', 'PUSH'],
                            });
                        }
                    }
                    break;
                }

                default:
                    // Unhandled event — still acknowledge
                    break;
            }

            return res.json({ received: true });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Nurse Wallet & Payouts ────────────────────────────────────────────────

// GET /billing/wallet  — nurse views own wallet
router.get('/wallet', authenticate, authorize('NURSE'), async (req, res, next) => {
    try {
        const np = await prisma.nurseProfile.findUnique({
            where:   { userId: req.user.id },
            select:  { id: true },
        });
        if (!np) return errorResponse(res, 'Nurse profile not found', 404);

        const wallet = await prisma.wallet.findUnique({
            where:   { nurseProfileId: np.id },
            include: {
                payouts: {
                    orderBy: { createdAt: 'desc' },
                    take:    10,
                },
            },
        });

        return successResponse(res, wallet);
    } catch (err) {
        next(err);
    }
});

// GET /billing/payouts  — list payouts (admin or own)
router.get('/payouts', authenticate, async (req, res, next) => {
    try {
        const { page = 1, limit = 20, status, nurseProfileId } = req.query;
        const skip = (Number(page) - 1) * Number(limit);

        let npFilter = nurseProfileId;
        if (req.user.role === 'NURSE') {
            const np = await prisma.nurseProfile.findUnique({
                where:  { userId: req.user.id },
                select: { id: true },
            });
            npFilter = np.id;
        }

        const where = {
            ...(npFilter ? { nurseProfileId: npFilter } : {}),
            ...(status   ? { status }                   : {}),
        };

        const [payouts, total] = await Promise.all([
            prisma.payout.findMany({
                where,
                skip,
                take:    Number(limit),
                orderBy: { createdAt: 'desc' },
                include: {
                    nurseProfile: { select: { firstName: true, lastName: true } },
                },
            }),
            prisma.payout.count({ where }),
        ]);

        return paginatedResponse(res, payouts, buildPagination(page, limit, total));
    } catch (err) {
        next(err);
    }
});

// POST /billing/payouts  — admin initiates payout to nurse via Stripe Connect
router.post(
    '/payouts',
    authenticate,
    authorize('SUPER_ADMIN'),
    [
        body('nurseProfileId').notEmpty(),
        body('shiftId').optional(),
        body('grossCharge').isFloat({ min: 0 }),
        body('netPayout').isFloat({ min: 0 }),
        body('notes').optional().trim(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const { nurseProfileId, shiftId, grossCharge, netPayout, notes } = req.body;

            const np = await prisma.nurseProfile.findUnique({
                where:   { id: nurseProfileId },
                include: { wallet: true },
            });
            if (!np)          return errorResponse(res, 'Nurse profile not found', 404);
            if (!np.wallet)   return errorResponse(res, 'Wallet not found', 404);

            const commission = parseFloat(grossCharge) - parseFloat(netPayout);

            let stripeTransferId = null;
            const stripe = getStripe();
            if (stripe && np.stripeAccountId) {
                const transfer = await stripe.transfers.create({
                    amount:      Math.round(parseFloat(netPayout) * 100),
                    currency:    'usd',
                    destination: np.stripeAccountId,
                    metadata:    { nurseProfileId, shiftId: shiftId || '' },
                });
                stripeTransferId = transfer.id;
            }

            const payout = await prisma.$transaction(async (tx) => {
                const p = await tx.payout.create({
                    data: {
                        nurseProfileId,
                        walletId:        np.wallet.id,
                        shiftId:         shiftId || null,
                        grossCharge:     parseFloat(grossCharge),
                        netPayout:       parseFloat(netPayout),
                        systemCommission: commission,
                        stripeTransferId,
                        status:          stripeTransferId ? 'SETTLED' : 'PENDING',
                        paidAt:          stripeTransferId ? new Date() : null,
                        notes:           notes || null,
                    },
                });

                // Update wallet balances
                await tx.wallet.update({
                    where: { id: np.wallet.id },
                    data: {
                        availableBalance: { increment: parseFloat(netPayout) },
                        lifetimeEarnings: { increment: parseFloat(netPayout) },
                    },
                });

                return p;
            });

            // Notify nurse
            const nurseUser = await prisma.user.findFirst({
                where:  { nurseProfile: { id: nurseProfileId } },
                select: { id: true },
            });
            if (nurseUser) {
                await dispatchNotification({
                    userId:   nurseUser.id,
                    type:     'PAYMENT_ALERT',
                    title:    'Payment Sent',
                    body:     `$${netPayout} has been transferred to your account.`,
                    channels: ['EMAIL', 'PUSH'],
                });
            }

            await writeAuditLog({ userId: req.user.id, action: 'CREATE', resource: 'Payout', resourceId: payout.id, req });
            return createdResponse(res, payout, 'Payout initiated');
        } catch (err) {
            next(err);
        }
    }
);

// GET /billing/summary  — facility upcoming charges summary
router.get('/summary', authenticate, authorize('FACILITY_ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const facilityId =
            req.user.role === 'SUPER_ADMIN'
                ? req.query.facilityId
                : req.user.facilityMember?.facilityId;

        if (!facilityId) return errorResponse(res, 'facilityId required', 400);

        const [outstanding, paid, upcoming] = await Promise.all([
            prisma.invoice.aggregate({
                where:  { facilityId, status: { in: ['ISSUED', 'OVERDUE'] } },
                _sum:   { total: true },
                _count: true,
            }),
            prisma.invoice.aggregate({
                where:  { facilityId, status: 'PAID' },
                _sum:   { total: true },
                _count: true,
            }),
            prisma.invoice.findMany({
                where:   { facilityId, status: 'ISSUED', dueAt: { gte: new Date() } },
                orderBy: { dueAt: 'asc' },
                take:    5,
                select:  { invoiceNumber: true, total: true, dueAt: true },
            }),
        ]);

        return successResponse(res, {
            outstanding: { total: outstanding._sum.total || 0, count: outstanding._count },
            paid:        { total: paid._sum.total || 0,        count: paid._count        },
            upcoming,
        });
    } catch (err) {
        next(err);
    }
});

router.patch(
    '/payouts/:id/retry',
    authenticate,
    authorize('SUPER_ADMIN'),
    async (req, res, next) => {
        try {
            const stripe = getStripe();

            // Perform the check and Stripe call inside a transaction
            const result = await prisma.$transaction(async (tx) => {
                // 1. Check if it's still pending
                const payout = await tx.payout.findUnique({
                    where: { id: req.params.id },
                    include: { nurseProfile: true }
                });

                if (!payout || payout.status !== 'PENDING') {
                    throw new Error('ALREADY_PROCESSED');
                }

                if (!payout.nurseProfile.stripeAccountId) {
                    throw new Error('NO_STRIPE_ACCOUNT');
                }

                // 2. Attempt Stripe Transfer with Idempotency Key
                // The Idempotency Key is your primary defense against double-spending
                const transfer = await stripe.transfers.create({
                    amount: Math.round(parseFloat(payout.netPayout) * 100),
                    currency: 'usd',
                    destination: payout.nurseProfile.stripeAccountId,
                    metadata: { payoutId: payout.id },
                }, {
                    idempotencyKey: `retry-payout-${payout.id}`,
                });

                // 3. Update to SETTLED
                return await tx.payout.update({
                    where: { id: payout.id },
                    data: {
                        status: 'SETTLED',
                        stripeTransferId: transfer.id,
                        paidAt: new Date(),
                    },
                });
            });

            return successResponse(res, result, 'Payment successful');
        } catch (err) {
            if (err.message === 'ALREADY_PROCESSED') {
                return errorResponse(res, 'Payout already processed or not found', 400);
            }
            if (err.message === 'NO_STRIPE_ACCOUNT') {
                return errorResponse(res, 'Nurse has not linked Stripe account', 400);
            }
            next(err);
        }
    }
);

module.exports = router;