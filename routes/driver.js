const express = require('express');
const router = express.Router();
const driverController = require('../controllers/driverController');
const auth = require('../middleware/auth');

// All routes protected by driver JWT
router.use(auth);

router.get('/profile', driverController.getProfile);
router.get('/history', driverController.getMyHistory);

module.exports = router;