const { prisma } = require('../config/database');

/**
 * Write an immutable audit trail entry.
 */
async function writeAuditLog({ userId, action, resource, resourceId, previousData, newData, req }) {
    try {
        await prisma.auditLog.create({
            data: {
                userId:       userId || null,
                action,
                resource,
                resourceId:   resourceId ? String(resourceId) : null,
                previousData: previousData || undefined,
                newData:      newData || undefined,
                ipAddress:    req?.ip || null,
                userAgent:    req?.headers?.['user-agent'] || null,
            },
        });
    } catch (err) {
        // Non-blocking — never break a request over audit failure
        const logger = require('../config/logger');
        logger.error('Audit log write failed:', err);
    }
}

module.exports = { writeAuditLog };