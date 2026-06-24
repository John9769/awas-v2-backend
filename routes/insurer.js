const express = require('express');
const router = express.Router();
const insurerController = require('../controllers/insurerController');
const insurerAuth = require('../middleware/insurerAuth');

// All routes protected by insurer JWT
router.use(insurerAuth);

router.get('/dashboard', insurerController.getDashboard);
router.get('/drivers', insurerController.getMyDrivers);
router.get('/writs', insurerController.getMyWrits);
router.get('/writs/:writNumber', insurerController.getWritDetail);
router.get('/invoices', insurerController.getMyInvoices);

module.exports = router;