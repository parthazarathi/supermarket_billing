// Google Sign-In for the AI Store Manager.
//
// IMPORTANT: the Google account is an IDENTITY, not a Gemini credential.
// This module proves "which Google account owns this MartPOS installation's
// AI access" via OAuth + id_token verification. It never derives, fetches or
// fabricates an API key from the Gmail address - the Gemini credential lives
// separately in the backend (platform env var or the encrypted secrets
// store, resolved by lib/ai/provider.js).
//
// Flow (same loopback pattern as Google Drive connect):
//   loopback listener on a random 127.0.0.1 port -> system browser ->
//   Google consent -> redirect with auth code -> token exchange ->
//   verifyIdToken() signature + audience check -> store the verified
//   identity (sub/email/name). access_type 'online': we only need identity,
//   so NO refresh token is requested and the access token is discarded the
//   moment verification completes - no Google tokens are ever persisted.
const crypto = require('crypto');
const fs = require('fs');
const { google } = require('googleapis');
const { getCredentialsPath } = require('../paths');
const { getSetting, setSettings } = require('../settings');

const SCOPES = ['openid', 'email', 'profile'];
const IDENTITY_KEYS = ['ai_google_sub', 'ai_google_email', 'ai_google_name', 'ai_google_connected_at', 'ai_google_last_login'];

class GoogleAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoogleAuthError';
    this.code = 'google_auth';
  }
}

// OAuth client credentials: the same Desktop-app credentials.json the Google
// Drive connect uses, or env vars for server-mode deployments.
function oauthClientConfig() {
  const credentialsPath = getCredentialsPath();
  if (fs.existsSync(credentialsPath)) {
    try {
      const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
      const c = credentials.installed || credentials.web;
      if (c && c.client_id) return { client_id: c.client_id, client_secret: c.client_secret };
    } catch (_) { /* fall through to error */ }
    throw new GoogleAuthError(`Google credentials at ${credentialsPath} are invalid`);
  }
  if (process.env.GOOGLE_CLIENT_ID) {
    return {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET || ''
    };
  }
  throw new GoogleAuthError(`Google sign-in needs OAuth credentials. Place a Google "Desktop app" credentials.json at ${credentialsPath} (the same file Drive backup uses), or set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.`);
}

function signInAvailable() {
  try {
    oauthClientConfig();
    return true;
  } catch (_) {
    return false;
  }
}

function identity() {
  const sub = getSetting('ai_google_sub', '');
  return {
    connected: !!sub,
    sub: sub || null,
    email: getSetting('ai_google_email', '') || null,
    name: getSetting('ai_google_name', '') || null,
    connected_at: getSetting('ai_google_connected_at', '') || null,
    last_login: getSetting('ai_google_last_login', '') || null
  };
}

function storeIdentity(payload) {
  const now = new Date().toISOString();
  setSettings({
    ai_google_sub: payload.sub,
    ai_google_email: payload.email || '',
    ai_google_name: payload.name || '',
    ai_google_connected_at: getSetting('ai_google_connected_at', '') || now,
    ai_google_last_login: now
  });
  return identity();
}

// Clears the linked Google identity. Never touches business data, and there
// are no stored Google tokens to revoke (access_type 'online').
function disconnect() {
  const updates = {};
  for (const k of IDENTITY_KEYS) updates[k] = '';
  setSettings(updates);
  return { connected: false };
}

let inFlight = null; // one sign-in flow at a time

// Runs the loopback OAuth flow. Resolves with the stored identity once the
// browser redirect lands; rejects on cancel/deny/timeout. Never persists
// Google tokens - they are verified and dropped.
function signIn() {
  if (inFlight) return inFlight;
  inFlight = runSignIn().finally(() => { inFlight = null; });
  return inFlight;
}

function runSignIn() {
  const cfg = oauthClientConfig();
  const http = require('http');
  const url = require('url');
  const state = crypto.randomBytes(16).toString('hex');

  return new Promise((resolve, reject) => {
    let oAuth2Client = null;
    let done = false;

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { server.close(); } catch (_) { /* already closed */ }
      fn(value);
    };

    const server = http.createServer(async (req, res) => {
      const query = url.parse(req.url, true).query;
      // Only an OAuth redirect carrying code/error completes the flow;
      // favicon and other incidental requests are ignored.
      if (!query.code && !query.error) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      try {
        if (query.error) {
          throw new GoogleAuthError(`Google sign-in was cancelled or denied (${query.error})`);
        }
        if (!query.state || query.state !== state) {
          throw new GoogleAuthError('Invalid sign-in state - please try again');
        }
        const { tokens } = await oAuth2Client.getToken(query.code);
        if (!tokens || !tokens.id_token) {
          throw new GoogleAuthError('Google did not return an identity token');
        }
        // Cryptographically verify the identity - signature, expiry, issuer
        // and our client_id audience are all checked by verifyIdToken.
        const ticket = await oAuth2Client.verifyIdToken({
          idToken: tokens.id_token,
          audience: cfg.client_id
        });
        const payload = ticket.getPayload() || {};
        if (!payload.sub || !payload.email) {
          throw new GoogleAuthError('Google account did not provide a verifiable identity');
        }
        if (payload.email_verified === false) {
          throw new GoogleAuthError('That Google account email is not verified by Google');
        }
        const stored = storeIdentity(payload); // tokens discarded here
        console.log(`AI Google sign-in: ${payload.email}`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Connected to MartPOS AI Store Manager.</h1><p>You can close this window and return to MartPOS.</p>');
        finish(resolve, stored);
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>Sign-in failed</h1><p>You can close this window and try again in MartPOS.</p>');
        finish(reject, error instanceof GoogleAuthError ? error : new GoogleAuthError(error.message));
      }
    });

    const timer = setTimeout(() => {
      finish(reject, new GoogleAuthError('Google sign-in timed out. Try Sign in again.'));
    }, 5 * 60 * 1000);

    server.on('error', (err) => finish(reject, new GoogleAuthError(err.message)));
    server.listen(0, '127.0.0.1', async () => {
      try {
        const port = server.address().port;
        oAuth2Client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, `http://127.0.0.1:${port}`);
        const authUrl = oAuth2Client.generateAuthUrl({
          access_type: 'online', // identity only - no refresh token
          scope: SCOPES,
          state
        });
        try {
          const open = require('open');
          await open(authUrl);
        } catch (e) {
          console.log(`Open this URL to sign in with Google: ${authUrl}`);
        }
      } catch (e) {
        finish(reject, new GoogleAuthError(e.message));
      }
    });
  });
}

module.exports = { signIn, disconnect, identity, signInAvailable, GoogleAuthError };
