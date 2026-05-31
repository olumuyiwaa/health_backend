const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const { prisma } = require('../../config/database');
const { buildTokenPair, verifyRefreshToken } = require('../../utils/jwt');
const { sendEmail } = require('../notifications/email.service');
const { sendOtpSms } = require('../notifications/sms.service');
const { writeAuditLog } = require('../../utils/audit');

const SALT_ROUNDS = 12;
const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 min
const RESET_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// ─── Helpers ───────────────────────────────────

function generateOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

async function hashPassword(plain) {
    return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash);
}

function buildSession(userId, req) {
    return {
        userId,
        deviceModel:  req.headers['x-device-model']  || null,
        deviceOs:     req.headers['x-device-os']     || null,
        ipAddress:    req.ip,
        userAgent:    req.headers['user-agent']       || null,
        expiresAt:    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
}

// ─── Register ──────────────────────────────────

async function registerUser({ email, password, phone, role, firstName, lastName, designation, req }) {
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) throw Object.assign(new Error('Email already registered'), { statusCode: 409 });

    const passwordHash = await hashPassword(password);

    const user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
            data: {
                email,
                phone:        phone || null,
                passwordHash,
                role:         role || 'NURSE',
                status:       'PENDING',
            },
        });

        if (role === 'NURSE' || role === undefined) {
            await tx.nurseProfile.create({
                data: {
                    userId:      newUser.id,
                    firstName,
                    lastName,
                    designation: designation || 'RN',
                },
            });
            await tx.wallet.create({ data: { nurseProfileId: (await tx.nurseProfile.findUnique({ where: { userId: newUser.id }, select: { id: true } })).id } });
        }

        if (['FACILITY_ADMIN', 'TEAM_MEMBER', 'RECRUITER'].includes(role)) {
            await tx.adminProfile.create({
                data: { userId: newUser.id, firstName, lastName },
            });
        }

        if (role === 'SUPER_ADMIN') {
            await tx.adminProfile.create({
                data: { userId: newUser.id, firstName, lastName },
            });
        }

        return newUser;
    });

    // Send email verification OTP
    await sendEmailVerificationOtp(user.id, email);

    await writeAuditLog({ userId: user.id, action: 'CREATE', resource: 'User', resourceId: user.id, req });

    return { id: user.id, email: user.email, role: user.role };
}

// ─── Email Verification ────────────────────────

async function sendEmailVerificationOtp(userId, email) {
    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

    await prisma.otpCode.create({
        data: { userId, code, purpose: 'email_verify', expiresAt },
    });

    await sendEmail({
        to: email,
        templateName: 'verifyEmail',
        templateData: { code },
    });
}

async function verifyEmailOtp(userId, code) {
    const otp = await prisma.otpCode.findFirst({
        where: {
            userId,
            code,
            purpose: 'email_verify',
            usedAt:    null,
            expiresAt: { gte: new Date() },
        },
    });

    if (!otp) throw Object.assign(new Error('Invalid or expired OTP'), { statusCode: 400 });

    await prisma.$transaction([
        prisma.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } }),
        prisma.user.update({
            where: { id: userId },
            data:  { emailVerifiedAt: new Date(), status: 'ACTIVE', verificationStatus: 'VERIFIED' },
        }),
    ]);

    return true;
}

// ─── Login ────────────────────────────────────

async function login({ email, password, req }) {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
    if (user.status === 'SUSPENDED') throw Object.assign(new Error('Account suspended'), { statusCode: 403 });

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });

    // If 2FA is enabled, return a temporary challenge token
    if (user.twoFactorEnabled) {
        const challengeToken = crypto.randomBytes(32).toString('hex');
        await prisma.otpCode.create({
            data: {
                userId:    user.id,
                code:      challengeToken,
                purpose:   '2fa_challenge',
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
            },
        });
        return { requires2FA: true, challengeToken, userId: user.id };
    }

    return completeLogin(user, req);
}

async function completeLogin(user, req) {
    const { accessToken, refreshToken } = buildTokenPair(user);

    const session = await prisma.session.create({
        data: { ...buildSession(user.id, req), token: refreshToken },
    });

    await prisma.user.update({
        where: { id: user.id },
        data:  { lastLoginAt: new Date(), lastLoginIp: req.ip },
    });

    await writeAuditLog({ userId: user.id, action: 'LOGIN', resource: 'User', resourceId: user.id, req });

    return {
        accessToken,
        refreshToken,
        sessionId: session.id,
        user: {
            id:    user.id,
            email: user.email,
            role:  user.role,
        },
    };
}

// ─── 2FA ──────────────────────────────────────

async function verify2FA({ userId, challengeToken, totpCode }) {
    const challenge = await prisma.otpCode.findFirst({
        where: {
            userId,
            code:      challengeToken,
            purpose:   '2fa_challenge',
            usedAt:    null,
            expiresAt: { gte: new Date() },
        },
    });

    if (!challenge) throw Object.assign(new Error('Invalid or expired challenge'), { statusCode: 401 });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const valid = speakeasy.totp.verify({
        secret:   user.twoFactorSecret,
        encoding: 'base32',
        token:    totpCode,
        window:   1,
    });

    if (!valid) throw Object.assign(new Error('Invalid TOTP code'), { statusCode: 401 });

    await prisma.otpCode.update({ where: { id: challenge.id }, data: { usedAt: new Date() } });

    return completeLogin(user, { ip: null, headers: {} });
}

async function setup2FA(userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });

    const secret = speakeasy.generateSecret({
        name:   `HealthcareApp (${user.email})`,
        length: 20,
    });

    await prisma.user.update({ where: { id: userId }, data: { twoFactorSecret: secret.base32 } });

    const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url);

    return { secret: secret.base32, qrCodeUrl };
}

async function enable2FA(userId, totpCode) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user.twoFactorSecret) throw Object.assign(new Error('2FA setup not initiated'), { statusCode: 400 });

    const valid = speakeasy.totp.verify({
        secret:   user.twoFactorSecret,
        encoding: 'base32',
        token:    totpCode,
        window:   1,
    });

    if (!valid) throw Object.assign(new Error('Invalid TOTP code'), { statusCode: 400 });

    await prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
    return true;
}

// ─── Token Refresh ────────────────────────────

async function refreshTokens(refreshToken, req) {
    let payload;
    try {
        payload = verifyRefreshToken(refreshToken);
    } catch {
        throw Object.assign(new Error('Invalid refresh token'), { statusCode: 401 });
    }

    const session = await prisma.session.findFirst({
        where: { token: refreshToken, isActive: true, userId: payload.sub },
    });

    if (!session) throw Object.assign(new Error('Session not found or revoked'), { statusCode: 401 });
    if (new Date() > session.expiresAt) throw Object.assign(new Error('Refresh token expired'), { statusCode: 401 });

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    const { accessToken, refreshToken: newRefreshToken } = buildTokenPair(user);

    // Rotate refresh token
    await prisma.$transaction([
        prisma.session.update({ where: { id: session.id }, data: { isActive: false, revokedAt: new Date() } }),
        prisma.session.create({ data: { ...buildSession(user.id, req), token: newRefreshToken } }),
    ]);

    return { accessToken, refreshToken: newRefreshToken };
}

// ─── Logout ───────────────────────────────────

async function logout(userId, sessionToken, req) {
    await prisma.session.updateMany({
        where: { userId, token: sessionToken },
        data:  { isActive: false, revokedAt: new Date() },
    });
    await writeAuditLog({ userId, action: 'LOGOUT', resource: 'User', resourceId: userId, req });
}

async function logoutAllDevices(userId) {
    await prisma.session.updateMany({
        where: { userId, isActive: true },
        data:  { isActive: false, revokedAt: new Date() },
    });
}

// ─── Password Reset ───────────────────────────

async function requestPasswordReset(email) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
    if (!user) return; // Silently succeed to prevent user enumeration

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_EXPIRY_MS);

    await prisma.passwordReset.create({ data: { userId: user.id, token, expiresAt } });

    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
    await sendEmail({
        to:           user.email,
        templateName: 'passwordReset',
        templateData: { link: resetLink },
    });
}

async function resetPassword(token, newPassword) {
    const record = await prisma.passwordReset.findFirst({
        where: {
            token,
            usedAt:    null,
            expiresAt: { gte: new Date() },
        },
    });

    if (!record) throw Object.assign(new Error('Invalid or expired reset link'), { statusCode: 400 });

    const passwordHash = await hashPassword(newPassword);

    await prisma.$transaction([
        prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
        prisma.passwordReset.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
        // Revoke all sessions for security
        prisma.session.updateMany({
            where: { userId: record.userId, isActive: true },
            data:  { isActive: false, revokedAt: new Date() },
        }),
    ]);
}

// ─── Session Management ───────────────────────

async function getActiveSessions(userId) {
    return prisma.session.findMany({
        where:   { userId, isActive: true },
        orderBy: { createdAt: 'desc' },
        select:  { id: true, deviceModel: true, deviceOs: true, ipAddress: true, createdAt: true, expiresAt: true },
    });
}

async function revokeSession(userId, sessionId) {
    await prisma.session.updateMany({
        where: { id: sessionId, userId },
        data:  { isActive: false, revokedAt: new Date() },
    });
}

module.exports = {
    registerUser,
    login,
    verify2FA,
    setup2FA,
    enable2FA,
    refreshTokens,
    logout,
    logoutAllDevices,
    requestPasswordReset,
    resetPassword,
    verifyEmailOtp,
    sendEmailVerificationOtp,
    getActiveSessions,
    revokeSession,
};