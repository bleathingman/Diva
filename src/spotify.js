// Connexion à Spotify pour le ❤ : retrouver le morceau en cours et l'ajouter aux favoris.
// Authentification « PKCE » : pas de secret dans l'app, l'utilisateur valide dans son navigateur.
const { net, safeStorage, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

const REDIRECT_PORT = 43117;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = 'user-read-currently-playing user-library-read user-library-modify';
const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

const base64Url = (buffer) => buffer.toString('base64url');

// Comparaison tolérante : Windows et Spotify n'écrivent pas toujours le titre à l'identique.
const comparable = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function createSpotify({ tokenFile, getClientId }) {
  let tokens = loadTokens();

  function loadTokens() {
    try {
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(tokenFile)));
    } catch {
      return null;
    }
  }

  function saveTokens(next) {
    tokens = next;
    if (next) fs.writeFileSync(tokenFile, safeStorage.encryptString(JSON.stringify(next)));
    else fs.rmSync(tokenFile, { force: true });
  }

  function storeTokenResponse(data) {
    saveTokens({
      accessToken: data.access_token,
      // Spotify peut renvoyer un nouveau jeton de rafraîchissement : l'ancien ne vaut alors plus.
      refreshToken: data.refresh_token ?? tokens?.refreshToken,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    });
  }

  async function requestToken(params) {
    const response = await net.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: getClientId(), ...params }).toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error_description ?? data.error ?? `erreur ${response.status}`);
      error.code = data.error;
      throw error;
    }
    return data;
  }

  // Ouvre le navigateur et attend que Spotify revienne sur 127.0.0.1 avec le code d'accès.
  function connect() {
    return new Promise((resolve, reject) => {
      const clientId = getClientId();
      if (!clientId) {
        reject(new Error('Colle d\'abord ton Client ID'));
        return;
      }
      const verifier = base64Url(crypto.randomBytes(48));
      const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
      const state = base64Url(crypto.randomBytes(16));

      const finish = (error) => {
        clearTimeout(timer);
        server.close();
        if (error) reject(error);
        else resolve();
      };

      const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, REDIRECT_URI);
        if (url.pathname !== '/callback') {
          response.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get('code');
        let failure = null;
        if (!code || url.searchParams.get('state') !== state) {
          failure = new Error('Connexion annulée');
        } else {
          try {
            storeTokenResponse(await requestToken({
              grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier,
            }));
          } catch (error) {
            failure = error;
          }
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        response.end(`<!doctype html><title>Diva</title><body style="background:#0c0c0d;color:#ececee;font:16px 'Segoe UI',sans-serif;display:grid;place-items:center;height:90vh">${
          failure ? 'La connexion a échoué, retourne sur Diva.' : 'Spotify est connecté à Diva. Tu peux fermer cet onglet.'}</body>`, () => finish(failure));
      });
      const timer = setTimeout(() => finish(new Error('Délai dépassé')), LOGIN_TIMEOUT_MS);

      server.on('error', (error) => {
        clearTimeout(timer);
        reject(error.code === 'EADDRINUSE' ? new Error(`Le port ${REDIRECT_PORT} est déjà utilisé`) : error);
      });
      server.listen(REDIRECT_PORT, '127.0.0.1', () => {
        const query = new URLSearchParams({
          response_type: 'code', client_id: clientId, scope: SCOPES, redirect_uri: REDIRECT_URI,
          state, code_challenge_method: 'S256', code_challenge: challenge,
        });
        shell.openExternal(`https://accounts.spotify.com/authorize?${query}`);
      });
    });
  }

  async function accessToken() {
    if (!tokens) throw new Error('Spotify n\'est pas connecté');
    if (Date.now() < tokens.expiresAt) return tokens.accessToken;
    try {
      storeTokenResponse(await requestToken({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }));
    } catch (error) {
      // Spotify invalide la connexion au bout de 6 mois : il faut se reconnecter.
      if (error.code === 'invalid_grant') saveTokens(null);
      throw error;
    }
    return tokens.accessToken;
  }

  async function api(method, path) {
    const response = await net.fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}` },
    });
    if (response.status === 204) return null;
    if (response.ok) return response.json().catch(() => null);
    if (response.status === 403) throw new Error('Accès refusé par Spotify (compte Premium requis ?)');
    if (response.status === 429) throw new Error('Trop de requêtes, réessaie dans un moment');
    throw new Error(`Spotify a répondu ${response.status}`);
  }

  // Windows ne donne que le titre : on demande à Spotify l'identifiant du morceau en cours.
  // Spotify peut avoir un temps de retard sur Windows, d'où les essais espacés.
  async function lookup(title) {
    const wanted = comparable(title);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 1500));
      const playing = await api('GET', '/me/player/currently-playing');
      const item = playing?.item;
      if (item?.uri?.startsWith('spotify:track:') && comparable(item.name) === wanted) {
        const [liked] = await api('GET', `/me/library/contains?uris=${encodeURIComponent(item.uri)}`);
        return { uri: item.uri, liked: Boolean(liked) };
      }
    }
    return null;
  }

  function setLiked(uri, liked) {
    return api(liked ? 'PUT' : 'DELETE', `/me/library?uris=${encodeURIComponent(uri)}`);
  }

  return {
    connect,
    lookup,
    setLiked,
    disconnect: () => saveTokens(null),
    isConnected: () => Boolean(tokens),
  };
}

module.exports = { createSpotify, REDIRECT_URI };
