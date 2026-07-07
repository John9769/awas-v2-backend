const express = require('express');
const router = express.Router();
const insurerController = require('../controllers/insurerController');
const insurerAuth = require('../middleware/insurerAuth');
const { requireRole } = require('../middleware/insurerAuth');
const { uploadCsv } = require('../middleware/upload');

// All routes protected by insurer JWT
router.use(insurerAuth);

// Dashboard — HOC only
router.get('/dashboard', requireRole('HOC'), insurerController.getDashboard);

// Policyholders — HOC + OFFICER
router.get('/drivers', requireRole('HOC', 'OFFICER'), insurerController.getMyDrivers);

// Writs — HOC + OFFICER
router.get('/writs', requireRole('HOC', 'OFFICER'), insurerController.getMyWrits);
router.get('/writs/:writNumber', requireRole('HOC', 'OFFICER'), insurerController.getWritDetail);

// Invoices — HOC + ACCOUNTS
router.get('/invoices', requireRole('HOC', 'ACCOUNTS'), insurerController.getMyInvoices);

// CSV — HOC + OFFICER + BACKROOM
router.post('/csv-upload', requireRole('HOC', 'OFFICER', 'BACKROOM'), uploadCsv, insurerController.uploadCsv);
router.get('/csv-uploads', requireRole('HOC', 'OFFICER', 'BACKROOM'), insurerController.getCsvUploads);

// User management — HOC only
router.post('/users', requireRole('HOC'), insurerController.createInsurerUser);
router.get('/users', requireRole('HOC'), insurerController.getInsurerUsers);
router.patch('/users/:id/toggle-status', requireRole('HOC'), insurerController.toggleInsurerUserStatus);

// V3: Settlements — HOC only
router.get('/settlements', requireRole('HOC'), insurerController.getSettlements);
router.get('/settlements/:id', requireRole('HOC'), insurerController.getSettlementDetail);
router.post('/settlements/:id/offer', requireRole('HOC'), insurerController.makeSettlementOffer);

module.exports = router;