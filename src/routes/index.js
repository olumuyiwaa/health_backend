const router = require('express').Router();

router.use('/auth',          require('../modules/auth/auth.routes'));
router.use('/users',         require('../modules/users/users.routes'));
router.use('/credentials',   require('../modules/credentials/credentials.routes'));
router.use('/facilities',    require('../modules/facilities/facilities.routes'));
router.use('/cases',         require('../modules/cases/cases.routes'));
router.use('/shifts',        require('../modules/shifts/shifts.routes'));
router.use('/visits',        require('../modules/visits/visits.routes'));
router.use('/messages',      require('../modules/messaging/messaging.routes'));
router.use('/notifications', require('../modules/notifications/notifications.routes'));
router.use('/billing',       require('../modules/billing/billing.routes'));
router.use('/reports',       require('../modules/reports/reports.routes'));
router.use('/storage',       require('../modules/storage/storage.routes'));
router.use('/calendar',      require('../modules/calendar/calendar.routes'));

module.exports = router;