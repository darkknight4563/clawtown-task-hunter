import { createClient } from '@base44/sdk';

const base44 = createClient({
  appId: process.env.VITE_BASE44_APP_ID || process.env.BASE44_APP_ID,
  serviceToken: process.env.BASE44_SERVICE_TOKEN,
  serverUrl: process.env.VITE_BASE44_BACKEND_URL || 'https://base44.app',
});

// Check environment vars
console.error('APP_ID:', process.env.VITE_BASE44_APP_ID || process.env.BASE44_APP_ID);
console.error('Has token:', !!process.env.BASE44_SERVICE_TOKEN);
console.error('Server:', process.env.VITE_BASE44_BACKEND_URL || 'https://base44.app');

const all = await base44.asServiceRole.entities.EventOutbox.list({ limit: 50 });
console.error('Total EventOutbox records:', all.length);
all.forEach(r => console.error(r.id, r.status, r.event_type, r.attempts));
