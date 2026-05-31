const { prisma } = require('../../config/database');
const { sendEmail } = require('./email.service');
const { sendPushNotification } = require('./push.service');
const { sendSms } = require('./sms.service');
const { emitToUser } = require('../../config/socket');

/**
 * Create a notification record and dispatch via requested channels.
 */
async function dispatchNotification({
                                        userId,
                                        type,
                                        title,
                                        body,
                                        data = {},
                                        channels = ['EMAIL', 'PUSH'],
                                    }) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            email:        true,
            phone:        true,
            nurseProfile: { select: { fcmToken: true } },
        },
    });

    if (!user) return;

    // Persist to DB
    await prisma.notification.createMany({
        data: channels.map((channel) => ({
            userId,
            type,
            channel,
            title,
            body,
            data,
            sentAt: new Date(),
        })),
    });

    // Emit real-time in-app notification
    emitToUser(userId, 'notification', { type, title, body, data });

    // Dispatch per channel
    for (const ch of channels) {
        if (ch === 'EMAIL' && user.email) {
            await sendEmail({ to: user.email, subject: title, html: `<p>${body}</p>` });
        }
        if (ch === 'PUSH' && user.nurseProfile?.fcmToken) {
            await sendPushNotification({
                fcmToken: user.nurseProfile.fcmToken,
                title,
                body,
                data,
            });
        }
        if (ch === 'SMS' && user.phone) {
            await sendSms({ to: user.phone, body: `${title}: ${body}` });
        }
    }
}

module.exports = { dispatchNotification };