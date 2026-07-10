const express = require('express');
const router = express.Router();
const insurerController = require('../controllers/insurerController');
const logsController = require('../controllers/logsController');
const insurerAuth = require('../middleware/insurerAuth');
const { requireRole } = require('../middleware/insurerAuth');
const { uploadCsv } = require('../middleware/upload');

// All routes protected by insurer JWT
router.use(insurerAuth);

// Dashboard — HOC only
router.get('/dashboard', requireRole('HOC'), insurerController.getDashboard);

// Policyholders — HOC + EXECUTIVE + OFFICER
router.get('/drivers', requireRole('HOC', 'EXECUTIVE', 'OFFICER'), insurerController.getMyDrivers);

// Writs — HOC + EXECUTIVE + OFFICER
router.get('/writs', requireRole('HOC', 'EXECUTIVE', 'OFFICER'), insurerController.getMyWrits);
router.get('/writs/:writNumber', requireRole('HOC', 'EXECUTIVE', 'OFFICER'), insurerController.getWritDetail);

// NEW: manual assessment actions — HOC + EXECUTIVE + OFFICER (CLERICAL excluded,
// never touches claims per role rule confirmed today)
router.post('/writs/:writNumber/retry-assessment', requireRole('HOC', 'EXECUTIVE', 'OFFICER'), logsController.retryAssessment);
router.post('/writs/:writNumber/escalate', requireRole('HOC', 'EXECUTIVE', 'OFFICER'), logsController.escalateToManual);
router.post('/writs/:writNumber/resolve-escalation', requireRole('HOC', 'EXECUTIVE', 'OFFICER'), logsController.resolveEscalation);

// Invoices — HOC + EXECUTIVE + OFFICER
router.get('/invoices', requireRole('HOC', 'EXECUTIVE', 'OFFICER'), insurerController.getMyInvoices);

// CSV — HOC + EXECUTIVE + OFFICER + CLERICAL (Clerical's only writ-adjacent task)
router.post('/csv-upload', requireRole('HOC', 'EXECUTIVE', 'OFFICER', 'CLERICAL'), uploadCsv, insurerController.uploadCsv);
router.get('/csv-uploads', requireRole('HOC', 'EXECUTIVE', 'OFFICER', 'CLERICAL'), insurerController.getCsvUploads);

// User management — HOC only
router.post('/users', requireRole('HOC'), insurerController.createInsurerUser);
router.get('/users', requireRole('HOC'), insurerController.getInsurerUsers);
router.patch('/users/:id/toggle-status', requireRole('HOC'), insurerController.toggleInsurerUserStatus);

// V3: Settlements — HOC only
router.get('/settlements', requireRole('HOC'), insurerController.getSettlements);
router.get('/settlements/:id', requireRole('HOC'), insurerController.getSettlementDetail);
router.post('/settlements/:id/offer', requireRole('HOC'), insurerController.makeSettlementOffer);

module.exports = router;