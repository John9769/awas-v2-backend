const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminAuth = require('../middleware/adminAuth');
const { uploadCsv } = require('../middleware/upload');

// All routes protected by admin key
router.use(adminAuth);

// Dashboard
router.get('/dashboard', adminController.getDashboard);

// Insurer management
router.post('/insurers', adminController.createInsurer);
router.get('/insurers', adminController.getInsurers);
router.patch('/insurers/:id/toggle-status', adminController.toggleInsurerStatus);

// Driver management
router.get('/drivers', adminController.getDrivers);

// Writs
router.get('/writs', adminController.getWrits);

// CSV upload
router.post('/csv-upload', uploadCsv, adminController.uploadCsv);
router.get('/csv-uploads', adminController.getCsvUploads);

// Invoices
router.post('/invoices/generate-writ', adminController.generateWritInvoice);
router.get('/invoices', adminController.getInvoices);
router.patch('/invoices/:id/mark-paid', adminController.markInvoicePaid);

module.exports = router;