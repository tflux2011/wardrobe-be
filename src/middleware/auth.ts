import { NextFunction, Request, Response } from 'express';
import axios from 'axios';

type FirebaseLookupResponse = {
  users?: Array<{
    localId?: string;
    email?: string;
  }>;
};

type AuthenticatedUser = {
  uid: string;
  email: string | null;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY?.trim().replace(/^["']|["']$/g, '');

function parseBearerToken(headerValue?: string): string | null {
  if (!headerValue) return null;
  const [scheme, token] = headerValue.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  if (!token || token.trim().length === 0) return null;
  return token.trim();
}

async function lookupFirebaseUser(idToken: string): Promise<AuthenticatedUser | null> {
  if (!firebaseApiKey) {
    console.error('[auth] FIREBASE_WEB_API_KEY is not configured inside lookupFirebaseUser');
    return null;
  }

  const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseApiKey}`;

  const response = await axios.post<FirebaseLookupResponse>(
    url,
    { idToken },
    {
      timeout: 10000,
      validateStatus: () => true,
      headers: { 'Content-Type': 'application/json' },
    },
  );

  if (response.status !== 200) {
    console.error(
      `[auth] Firebase Identity Toolkit lookup failed with status ${response.status}:`,
      JSON.stringify(response.data)
    );
    return null;
  }

  const user = response.data?.users?.[0];
  const uid = user?.localId?.trim();

  if (!uid) {
    console.error('[auth] Firebase user lookup returned status 200 but no localId/uid');
    return null;
  }

  return {
    uid,
    email: user?.email?.trim() || null,
  };
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!firebaseApiKey) {
    console.error('[auth] FIREBASE_WEB_API_KEY is not configured');
    res.status(500).json({ error: 'Authentication is not configured' });
    return;
  }

  try {
    const authHeader = req.header('Authorization');
    const token = parseBearerToken(authHeader);
    if (!token) {
      console.warn(`[auth] Missing or invalid Authorization header format. Raw header: "${authHeader}"`);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await lookupFirebaseUser(token);
    if (!user) {
      console.warn('[auth] Firebase ID token lookup failed (token might be expired or invalid)');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    req.user = user;
    next();
  } catch (error: any) {
    console.error('[auth] Token verification exception:', error.stack || error.message || error);
    res.status(401).json({ error: 'Unauthorized' });
  }
}
