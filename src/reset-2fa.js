'use strict';

const { clearAllTwoFactor } = require('./db');

clearAllTwoFactor();
console.log('Two-factor login is now off. Log in with your password, then turn it back on in Settings.');
