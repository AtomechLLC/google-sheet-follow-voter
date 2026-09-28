import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  // Public URL students will reach, e.g. https://feedback.example.com
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dataDir: path.resolve(env.DATA_DIR || 'data'),
  sessionSecret: env.SESSION_SECRET || '',
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
  },
  // When true, "/api/demo" creates a session with placeholder slides so the
  // whole flow can be tried without Google credentials.
  demoMode: env.DEMO_MODE === '1' || env.DEMO_MODE === 'true',
  // Thumbnail width requested from the Slides API: SMALL (200px), MEDIUM (800px), LARGE (1600px)
  thumbnailSize: env.THUMBNAIL_SIZE || 'MEDIUM',
};

if (!config.sessionSecret) {
  config.sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] SESSION_SECRET not set; generated a random one. Teachers will be signed out on every restart.');
}

export const googleConfigured = Boolean(config.google.clientId && config.google.clientSecret);
