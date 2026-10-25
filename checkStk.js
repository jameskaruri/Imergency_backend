require('dotenv').config();
const { stkPushQuery } = require('./src/services/mpesa');

stkPushQuery('ws_CO_19092026160001484705171545')
  .then((data) => console.log('✅ Query result:', data))
  .catch((err) => console.log('❌ Query error:', err.response?.data || err.message));