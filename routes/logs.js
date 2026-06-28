const express = require('express');
const router = express.Router();
const logsController = require('../controllers/logsController');
const auth = require('../middleware/auth');
const { uploadEvidence } = require('../middleware/upload');

// Protected — driver JWT required
router.post('/submit', auth, uploadEvidence, logsController.submitWrit);
router.get('/my-writs', auth, logsController.getMyWrits);

// Public — anyone with writ number can view
router.get('/writ/:writNumber', logsController.getWritByNumber);

module.exports = router;