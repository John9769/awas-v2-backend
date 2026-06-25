const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const auth = require('../middleware/auth');
const insurerAuth = require('../middleware/insurerAuth');

// Driver routes
router.post('/driver/login', authController.driverLogin);
router.post('/driver/change-password', auth, authController.driverChangePassword);
router.post('/driver/forgot-password', authController.driverForgotPassword);
router.post('/driver/reset-password', authController.driverResetPassword);

// Insurer routes
router.post('/insurer/login', authController.insurerLogin);
router.post('/insurer/change-password', insurerAuth, authController.insurerChangePassword);
router.post('/insurer/forgot-password', authController.insurerForgotPassword);
router.post('/insurer/reset-password', authController.insurerResetPassword);

module.exports = router;