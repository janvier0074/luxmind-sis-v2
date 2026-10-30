const https = require('https');

// ⬇️ PASTE YOUR REAL VALUES HERE BETWEEN THE QUOTES
const serviceId = 'srv-dbcgqk0473hc73eh1m40';
const apiKey = 'rnd_vVVm0L1577DnAOcIrp8852O0ziXa';

const options = {
  hostname: 'api.render.com',
  path: `/v1/services/${serviceId}/resume`,
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('\n--- Response ---');
    console.log('Status:', res.statusCode);
    console.log('Body:', body || '(empty)');
  });
});

req.on('error', (e) => console.error('Error:', e.message));
req.end();