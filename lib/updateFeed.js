// Update provider resolution. The installed app normally reads its update
// feed from app-update.yml, which electron-builder bakes into the installer
// from the "publish" block in package.json (today: GitHub Releases).
//
// This module exists so the feed can be redirected without touching the
// updater logic:
//   MARTPOS_UPDATE_SERVER_URL=https://updates.example.com/martpos
//     -> "generic" provider (a future MartPOS update server; the URL should
//        point at the folder that hosts latest.yml).
//   MARTPOS_UPDATE_GH_OWNER / MARTPOS_UPDATE_GH_REPO
//     -> explicit GitHub override (e.g. a staging fork for QA).
// With no overrides the baked-in app-update.yml is used, so package.json
// stays the single place that defines the production channel.
function resolveUpdateFeed(env = process.env) {
  const server = String(env.MARTPOS_UPDATE_SERVER_URL || '').trim().replace(/\/+$/, '');
  if (server) {
    // Plain-http feeds are refused on the open network (metadata would be
    // trivially spoofable); loopback http is allowed so the update flow can
    // be tested end-to-end against a local feed.
    const loopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(`${server}/`);
    if (!/^https:\/\//i.test(server) && !loopback) {
      throw new Error('MARTPOS_UPDATE_SERVER_URL must be an https:// URL');
    }
    return { type: 'generic', url: `${server}/`, channel: 'latest' };
  }
  const owner = String(env.MARTPOS_UPDATE_GH_OWNER || '').trim();
  const repo = String(env.MARTPOS_UPDATE_GH_REPO || '').trim();
  if (owner && repo) {
    return { type: 'github', owner, repo };
  }
  return { type: 'default' };
}

module.exports = { resolveUpdateFeed };
