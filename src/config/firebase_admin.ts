import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import * as fs from 'fs';
import * as path from 'path';

let initialized = false;

// 1. Try to load from environment variable
const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

if (serviceAccountEnv) {
  try {
    let serviceAccountJson: any;
    if (serviceAccountEnv.trim().startsWith('{')) {
      serviceAccountJson = JSON.parse(serviceAccountEnv);
    } else {
      // Try decoding base64
      const decoded = Buffer.from(serviceAccountEnv, 'base64').toString('utf-8');
      serviceAccountJson = JSON.parse(decoded);
    }
    initializeApp({
      credential: cert(serviceAccountJson)
    });
    initialized = true;
    console.log('[firebase-admin] Successfully initialized via env variable key.');
  } catch (e) {
    console.error('[firebase-admin] Invalid service account configuration');
  }
}

// 2. Try to load from local file if not initialized
if (!initialized) {
  const localKeyPath = path.join(__dirname, '../../firebase-service-account.json');
  if (fs.existsSync(localKeyPath)) {
    try {
      const serviceAccountJson = JSON.parse(fs.readFileSync(localKeyPath, 'utf8'));
      initializeApp({
        credential: cert(serviceAccountJson)
      });
      initialized = true;
      console.log('[firebase-admin] Successfully initialized via local json file.');
    } catch (e) {
      console.error('[firebase-admin] Invalid local service account configuration');
    }
  }
}

if (!initialized) {
  console.warn(
    '[firebase-admin] Admin SDK is NOT initialized. Please set FIREBASE_SERVICE_ACCOUNT_KEY or add firebase-service-account.json.'
  );
}

export const firebaseAuth = initialized ? getAuth() : null;
export const isFirebaseAuthInitialized = () => initialized;
