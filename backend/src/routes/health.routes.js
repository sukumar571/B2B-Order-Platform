'use strict';

const express = require('express');
const { healthHandler } = require('../controllers/health.controller');

const router = express.Router();

router.get('/health', healthHandler);

module.exports = router;
