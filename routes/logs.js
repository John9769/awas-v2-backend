const express = require('express');
const router = express.Router();
const logsController = require('../controllers/logsController');
const auth = require('../middleware/auth');
const { uploadEvidence } = require('../middleware/upload');

// Protected — driver JWT required
// uploadEvidence handles video + images via multer before controller
router.post('/seal', auth, uploadEvidence, logsController.verifyAndSeal);
router.get('/my-writs', auth, logsController.getMyWrits);

// Public — anyone with writ number can view
router.get('/writ/:writNumber', logsController.getWritByNumber);

module.exports = router;