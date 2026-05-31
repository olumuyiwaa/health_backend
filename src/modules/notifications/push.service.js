const admin = require('firebase-admin');
const logger = require('../../config/logger');

let firebaseApp;

function getFirebaseApp() {
    if (!firebaseApp) {
        firebaseApp = admin.initializeApp({
            credential: admin.credential.cert({
                projectId:   process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            }),
        });
    }
    return firebaseApp;
}

async function sendPushNotification({ fcmToken, title, body, data = {} }) {
    if (!fcmToken) return;

    try {
        const app = getFirebaseApp();
        const message = {
            token: fcmToken,
            notification: { title, body },
            data: Object.fromEntries(
                Object.entries(data).map(([k, v]) => [k, String(v)])
            ),
            android: { priority: 'high' },
            apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        };

        const response = await admin.messaging(app).send(message);
        logger.info(`Push sent: ${response}`);
        return response;
    } catch (err) {
        logger.error('Push notification failed:', err.message);
    }
}

async function sendMulticastPush({ fcmTokens, title, body, data = {} }) {
    if (!fcmTokens?.length) return;

    const tokens = fcmTokens.filter(Boolean);
    if (!tokens.length) return;

    try {
        const app = getFirebaseApp();
        const message = {
            tokens,
            notification: { title, body },
            data: Object.fromEntries(
                Object.entries(data).map(([k, v]) => [k, String(v)])
            ),
        };

        const response = await admin.messaging(app).sendEachForMulticast(message);
        logger.info(`Multicast push: ${response.successCount} sent, ${response.failureCount} failed`);
        return response;
    } catch (err) {
        logger.error('Multicast push failed:', err.message);
    }
}

module.exports = { sendPushNotification, sendMulticastPush };