const router = require('express').Router();
const { body, param } = require('express-validator');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { authRateLimiter } = require('../../middleware/rateLimiter');
const { successResponse, errorResponse } = require('../../utils/response');
const authService = require('./auth.service');

// POST /auth/register
router.post('/register',
    authRateLimiter,
    [
        body('email').isEmail().normalizeEmail(),
        body('password').isLength({ min: 8 }).matches(/[A-Z]/).matches(/[0-9]/),
        body('firstName').trim().notEmpty(),
        body('lastName').trim().notEmpty(),
        body('role').optional().isIn(['NURSE', 'FACILITY_ADMIN', 'RECRUITER', 'SUPER_ADMIN']),
        body('designation').optional().isIn(['RN','LVN','LPN','CNA','HHA','THERAPIST','CAREGIVER']),
        body('phone').optional().isMobilePhone(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const result = await authService.registerUser({ ...req.body, req });
            return res.status(201).json({ success: true, message: 'Registration successful. Please verify your email.', data: result });
        } catch (err) { next(err); }
    }
);

// POST /auth/login
router.post('/login',
    authRateLimiter,
    [
        body('email').isEmail().normalizeEmail(),
        body('password').notEmpty(),
    ],
    validate,
    async (req, res, next) => {
        try {
            const result = await authService.login({ ...req.body, req });
            return successResponse(res, result, 'Login successful');
        } catch (err) { next(err); }
    }
);

// POST /auth/verify-email
router.post('/verify-email',
    [body('userId').notEmpty(), body('code').isLength({ min: 6, max: 6 })],
    validate,
    async (req, res, next) => {
        try {
            await authService.verifyEmailOtp(req.body.userId, req.body.code);
            return successResponse(res, {}, 'Email verified successfully');
        } catch (err) { next(err); }
    }
);

// POST /auth/resend-verification
router.post('/resend-verification',
    authRateLimiter,
    [body('email').isEmail().normalizeEmail()],
    validate,
    async (req, res, next) => {
        try {
            const user = await require('../../config/database').prisma.user.findUnique({
                where: { email: req.body.email },
                select: { id: true },
            });
            if (user) await authService.sendEmailVerificationOtp(user.id, req.body.email);
            return successResponse(res, {}, 'If the email exists, a verification code has been sent');
        } catch (err) { next(err); }
    }
);

// POST /auth/2fa/setup
router.post('/2fa/setup', authenticate, async (req, res, next) => {
    try {
        const result = await authService.setup2FA(req.user.id);
        return successResponse(res, result, '2FA secret generated');
    } catch (err) { next(err); }
});

// POST /auth/2fa/enable
router.post('/2fa/enable',
    authenticate,
    [body('totpCode').isLength({ min: 6, max: 6 })],
    validate,
    async (req, res, next) => {
        try {
            await authService.enable2FA(req.user.id, req.body.totpCode);
            return successResponse(res, {}, '2FA enabled successfully');
        } catch (err) { next(err); }
    }
);

// PATCH /auth/2fa/disable
router.patch(
    '/2fa/disable',
    authenticate,
    authRateLimiter,
    [
        body('totpCode')
            .isLength({ min: 6, max: 6 })
            .withMessage('TOTP code must be 6 digits'),
        body('password')
            .notEmpty()
            .withMessage('Current password is required to disable 2FA'),
    ],
    validate,
    async (req, res, next) => {
        try {
            await authService.disable2FA(
                req.user.id,
                req.body.totpCode,
                req.body.password,
                req
            );

            return successResponse(
                res,
                {},
                'Two-factor authentication has been disabled successfully'
            );
        } catch (err) {
            next(err);
        }
    }
);

// POST /auth/2fa/verify
router.post('/2fa/verify',
    authRateLimiter,
    [
        body('userId').notEmpty(),
        body('challengeToken').notEmpty(),
        body('totpCode').isLength({ min: 6, max: 6 }),
    ],
    validate,
    async (req, res, next) => {
        try {
            const result = await authService.verify2FA(req.body);
            return successResponse(res, result, 'Authentication successful');
        } catch (err) { next(err); }
    }
);

// POST /auth/refresh
router.post('/refresh',
    [body('refreshToken').notEmpty()],
    validate,
    async (req, res, next) => {
        try {
            const tokens = await authService.refreshTokens(req.body.refreshToken, req);
            return successResponse(res, tokens, 'Tokens refreshed');
        } catch (err) { next(err); }
    }
);

// POST /auth/forgot-password
router.post('/forgot-password',
    authRateLimiter,
    [body('email').isEmail().normalizeEmail()],
    validate,
    async (req, res, next) => {
        try {
            await authService.requestPasswordReset(req.body.email);
            return successResponse(res, {}, 'If the email exists, a reset link has been sent');
        } catch (err) { next(err); }
    }
);

// POST /auth/reset-password
router.post('/reset-password',
    [
        body('token').notEmpty(),
        body('password').isLength({ min: 8 }).matches(/[A-Z]/).matches(/[0-9]/),
    ],
    validate,
    async (req, res, next) => {
        try {
            await authService.resetPassword(req.body.token, req.body.password);
            return successResponse(res, {}, 'Password reset successfully');
        } catch (err) { next(err); }
    }
);

// POST /auth/logout
router.post('/logout', authenticate, async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        await authService.logout(req.user.id, token, req);
        return successResponse(res, {}, 'Logged out successfully');
    } catch (err) { next(err); }
});

// POST /auth/logout-all
router.post('/logout-all', authenticate, async (req, res, next) => {
    try {
        await authService.logoutAllDevices(req.user.id);
        return successResponse(res, {}, 'All sessions revoked');
    } catch (err) { next(err); }
});

// GET /auth/sessions
router.get('/sessions', authenticate, async (req, res, next) => {
    try {
        const sessions = await authService.getActiveSessions(req.user.id);
        return successResponse(res, sessions);
    } catch (err) { next(err); }
});

// DELETE /auth/sessions/:sessionId
router.delete('/sessions/:sessionId', authenticate, async (req, res, next) => {
    try {
        await authService.revokeSession(req.user.id, req.params.sessionId);
        return successResponse(res, {}, 'Session revoked');
    } catch (err) { next(err); }
});

module.exports = router;