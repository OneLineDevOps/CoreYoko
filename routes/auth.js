const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/authController');
const auth = require('../middleware/authMiddleware');

router.post('/register', ctrl.register);
router.post('/login', ctrl.login);
router.get('/me', auth, ctrl.me);
router.put('/me', auth, ctrl.updateMe);
router.post('/change-password', auth, ctrl.changePassword);

module.exports = router;
