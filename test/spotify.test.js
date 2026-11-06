// src/spotify.js contre un faux Spotify : Electron est remplacé, aucun appel réseau réel
// (seul le serveur local de connexion, sur 127.0.0.1:43117, est vraiment ouvert).
const Module = require('node:module');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const calls = [];
const state = { expectedChallenge: null, refreshValid: true, playing: [], likedResponse: [false], likeStatus: 200 };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function fakeFetch(url, options = {}) {
  calls.push({ url, method: options.method ?? 'GET', auth: options.headers?.Authorization });
  if (url === 'https://accounts.spotify.com/api/token') {
    const body = new URLSearchParams(options.body);
    assert.strictEqual(body.get('client_id'), 'client-test');
    if (body.get('grant_type') === 'authorization_code') {
      const challenge = crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url');
      assert.strictEqual(challenge, state.expectedChallenge, 'PKCE : le verifier ne correspond pas au challenge');
      assert.strictEqual(body.get('redirect_uri'), 'http://127.0.0.1:43117/callback');
      return json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
    }
    if (!state.refreshValid) return json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400);
    return json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 });
  }
  const { pathname } = new URL(url);
  if (pathname === '/v1/me/player/currently-playing') {
    const next = state.playing.shift();
    return next === undefined ? new Response(null, { status: 204 }) : json(next);
  }
  if (pathname === '/v1/me/library/contains') return json(state.likedResponse);
  if (pathname === '/v1/me/library') return new Response(null, { status: state.likeStatus });
  throw new Error(`URL inattendue : ${url}`);
}

const fakeElectron = {
  net: { fetch: fakeFetch },
  safeStorage: {
    encryptString: (text) => Buffer.from(text, 'utf8').reverse(),
    decryptString: (buffer) => Buffer.from(buffer).reverse().toString('utf8'),
  },
  shell: {
    // Joue le rôle du navigateur : l'utilisateur accepte, Spotify rappelle 127.0.0.1.
    openExternal: async (url) => {
      const params = new URL(url).searchParams;
      assert.strictEqual(params.get('code_challenge_method'), 'S256');
      assert.ok(params.get('scope').includes('user-library-modify'));
      state.expectedChallenge = params.get('code_challenge');
      const returnedState = state.wrongState ? 'pirate' : params.get('state');
      // La connexion peut se terminer avant que le « navigateur » ait fini de lire la page :
      // le test attend cette promesse.
      state.page = fetch(`http://127.0.0.1:43117/callback?code=code-ok&state=${returnedState}`).then((r) => r.text());
    },
  },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? fakeElectron : load.call(this, request, ...rest);
};
const { createSpotify } = require('../src/spotify');

const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diva-spotify-')), 'spotify.token');
const make = () => createSpotify({ tokenFile, getClientId: () => 'client-test' });
const readTokens = () => JSON.parse(fakeElectron.safeStorage.decryptString(fs.readFileSync(tokenFile)));
const expireToken = () => {
  fs.writeFileSync(tokenFile, fakeElectron.safeStorage.encryptString(JSON.stringify({ ...readTokens(), expiresAt: 0 })));
};
const track = { item: { name: 'Bruk Out', uri: 'spotify:track:abc' } };

test('connexion refusée si Spotify renvoie un mauvais state', async () => {
  state.wrongState = true;
  await assert.rejects(make().connect(), /annulée/);
  state.wrongState = false;
  assert.ok(!fs.existsSync(tokenFile));
});

test('connexion refusée sans Client ID', async () => {
  await assert.rejects(createSpotify({ tokenFile, getClientId: () => '' }).connect(), /Client ID/);
});

test('connexion complète, PKCE vérifié, page « connecté » seulement après le jeton', async () => {
  const spotify = make();
  await spotify.connect();
  assert.ok(spotify.isConnected());
  assert.ok((await state.page).includes('connecté à Diva'));
});

test('jeton chiffré sur le disque et rechargé au redémarrage', () => {
  assert.ok(!fs.readFileSync(tokenFile, 'utf8').includes('refresh-1'));
  assert.ok(make().isConnected());
});

test('lookup : morceau en cours trouvé, avec son état liké', async () => {
  state.playing = [track];
  state.likedResponse = [true];
  assert.deepStrictEqual(await make().lookup('Bruk Out'), { uri: 'spotify:track:abc', liked: true });
  const contains = calls.findLast((call) => call.url.includes('/contains'));
  assert.ok(contains.url.includes('uris=spotify%3Atrack%3Aabc'));
  assert.strictEqual(contains.auth, 'Bearer access-1');
});

test('lookup : Spotify en retard sur Windows, nouvel essai', async () => {
  state.playing = [{ item: { name: 'Ancien titre', uri: 'spotify:track:old' } }, track];
  state.likedResponse = [false];
  assert.deepStrictEqual(await make().lookup('bruk out!'), { uri: 'spotify:track:abc', liked: false });
});

test('like et unlike sur /me/library', async () => {
  const spotify = make();
  await spotify.setLiked('spotify:track:abc', true);
  assert.strictEqual(calls.at(-1).method, 'PUT');
  assert.ok(calls.at(-1).url.endsWith('/me/library?uris=spotify%3Atrack%3Aabc'));
  await spotify.setLiked('spotify:track:abc', false);
  assert.strictEqual(calls.at(-1).method, 'DELETE');
});

test('403 : message qui parle de Premium', async () => {
  state.likeStatus = 403;
  await assert.rejects(make().setLiked('spotify:track:abc', true), /Premium/);
  state.likeStatus = 200;
});

test('jeton expiré : rafraîchi, et le nouveau jeton de rafraîchissement est gardé', async () => {
  expireToken();
  await make().setLiked('spotify:track:abc', true);
  assert.strictEqual(readTokens().accessToken, 'access-2');
  assert.strictEqual(readTokens().refreshToken, 'refresh-2');
});

test('6 mois écoulés (invalid_grant) : déconnecté proprement', async () => {
  expireToken();
  state.refreshValid = false;
  const spotify = make();
  await assert.rejects(spotify.setLiked('spotify:track:abc', true), /revoked/);
  assert.ok(!spotify.isConnected());
  assert.ok(!fs.existsSync(tokenFile));
});
