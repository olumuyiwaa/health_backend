const { verifyAccessToken } = require('../utils/jwt');
const { prisma } = require('../config/database');
const { errorResponse } = require('../utils/response');

/**
 * Validates Bearer JWT and attaches req.user
 */
async function authenticate(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return errorResponse(res, 'Authentication required', 401);
        }

        const token = authHeader.split(' ')[1];
        const payload = verifyAccessToken(token);

        // Validate session is still active in DB
        const session = await prisma.session.findFirst({
            where: {
                id: payload.sessionId,
                isActive: true,
                userId: payload.sub,
            },
            select: { id: true },
        });

        if (!session) {
            return errorResponse(res, 'Session expired or revoked', 401);
        }

        const user = await prisma.user.findUnique({
            where:  { id: payload.sub },
            select: {
                id:     true,
                email:  true,
                role:   true,
                status: true,
                facilityMember: { select: { facilityId: true, permissionsMask: true } },
                nurseProfile:   { select: { id: true, designation: true } },
            },
        });

        if (!user) return errorResponse(res, 'User not found', 401);
        if (user.status === 'SUSPENDED')   return errorResponse(res, 'Account suspended', 403);
        if (user.status === 'DEACTIVATED') return errorResponse(res, 'Account deactivated', 403);

        req.user = user;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') return errorResponse(res, 'Token expired', 401);
        if (err.name === 'JsonWebTokenError') return errorResponse(res, 'Invalid token', 401);
        next(err);
    }
}

/**
 * Require specific roles (variadic)
 * Usage: authorize('SUPER_ADMIN', 'FACILITY_ADMIN')
 */
function authorize(...roles) {
    return (req, res, next) => {
        if (!req.user) return errorResponse(res, 'Authentication required', 401);
        if (!roles.includes(req.user.role)) {
            return errorResponse(res, 'Insufficient permissions', 403);
        }
        next();
    };
}

/**
 * Ensure the requesting facility admin/member belongs to the :facilityId param
 */
function requireFacilityAccess(req, res, next) {
    const { role, facilityMember } = req.user;
    if (role === 'SUPER_ADMIN') return next(); // admins bypass

    const paramId = req.params.facilityId || req.params.id;
    if (!facilityMember || facilityMember.facilityId !== paramId) {
        return errorResponse(res, 'Access to this facility is not permitted', 403);
    }
    next();
}

module.exports = { authenticate, authorize, requireFacilityAccess };