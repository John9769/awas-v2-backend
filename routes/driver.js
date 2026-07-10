const express = require('express');
const router = express.Router();
const driverController = require('../controllers/driverController');
const auth = require('../middleware/auth');
const { uploadSettlementDocs } = require('../middleware/upload');

// All routes protected by driver JWT
router.use(auth);

// Profile & history
router.get('/profile', driverController.getProfile);
router.get('/history', driverController.getMyHistory);

// V3: Settlement
router.get('/settlement/:settlementId', driverController.getMySettlement);
router.post('/settlement/:settlementId/accept', driverController.acceptSettlementOffer);
router.post('/settlement/:settlementId/reject', driverController.rejectSettlementOffer);
router.post('/settlement/:settlementId/docs', uploadSettlementDocs, driverController.uploadSettlementDocs);

// NEW: in-app notifications
router.get('/notifications', driverController.getNotifications);
router.patch('/notifications/:id/read', driverController.markNotificationRead);

module.exports = router;