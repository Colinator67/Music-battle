// Met à jour data/videos.json à partir de data/countries.json.
//
// Règles de choix des vidéos :
//  - durée entre 1 et 7 minutes
//  - pas de remix, cover, karaoké, version accélérée, nightcore, etc.
//  - préférence : radio edit > chaîne officielle de l'artiste (VEVO, "- Topic") > "official video"
//
// Coût en quota : une recherche = 100 unités (uniquement pour les morceaux sans vidéo valable),
// les détails des vidéos = 1 unité par lot de 50. Quota gratuit : 10 000 unités par jour.
// La clé est lue dans la variable d'environnement YT_API_KEY (secret GitHub), jamais dans le code.
import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.YT_API_KEY;
if (!KEY) { console.error("YT_API_KEY manquant : ajoutez le secret dans Settings > Secrets and variables > Actions."); process.exit(1); }

const MIN_SECONDS = 60;
const MAX_SECONDS = 7 * 60;
const REV = 3; // version des règles de choix : changer ce nombre relance la sélection

const countries = JSON.parse(await readFile("data/countries.json", "utf8"));
let db = {};
try { db = JSON.parse(await readFile("data/videos.json", "utf8")); } catch {}
const oldTracks = db.tracks || {};
const oldStats = db.stats || {};
const searched = db.rev === REV ? (db.searched || {}) : {};

const keyOf = d => `${d.artist}|${d.song || ""}`;
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

async function api(path, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) url.searchParams.set(k, v);
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = json?.error?.errors?.[0]?.reason || "";
    throw Object.assign(new Error(`${res.status} ${reason} ${json?.error?.message || ""}`), { reason });
  }
  return json;
}

function seconds(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  if (!m) return null;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

// Détails (titre, chaîne, vues, durée, intégrable) pour une liste d'identifiants
const details = {};
async function fetchDetails(ids) {
  const todo = [...new Set(ids)].filter(id => !details[id]);
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    const r = await api("videos", { part: "snippet,statistics,contentDetails,status", id: batch.join(","), maxResults: "50" });
    for (const it of r.items || []) {
      details[it.id] = {
        t: it.snippet?.title || "",
        c: it.snippet?.channelTitle || "",
        v: it.statistics?.viewCount != null ? Number(it.statistics.viewCount) : null,
        d: seconds(it.contentDetails?.duration),
        e: it.status?.embeddable !== false
      };
    }
  }
}

// Mots qui signalent une version qui n'est pas l'originale
const BANNED = ["remix", "rmx", "mashup", "bootleg", "cover", "karaoke", "instrumental", "nightcore",
  "sped up", "speed up", "slowed", "reverb", "8d", "extended", "club mix", "bass boosted", "hour", "hours",
  "reaction", "tutorial", "lesson", "full album", "megamix", "medley", "parody", "parodie"];
const PENALIZED = ["live", "concert", "acoustic", "unplugged", "lyrics", "lyric", "paroles", "letra", "testo"];
const OFFICIAL = ["official video", "official music video", "clip officiel", "videoclip oficial", "video oficial",
  "official audio", "official", "officiel", "oficial", "ufficiale", "offizielles"];

const hasWord = (text, w) => new RegExp(`(^| )${w}( |$)`).test(text);

function score(d, info) {
  const title = norm(info.t), channel = norm(info.c);
  const own = norm(`${d.artist} ${d.song}`); // un mot présent dans le nom du morceau n'est pas pénalisé
  if (info.d == null || info.d < MIN_SECONDS || info.d > MAX_SECONDS) return null;
  for (const w of BANNED) if (hasWord(title, w) && !hasWord(own, w)) return null;
  // compilations et mixes de DJ (mais "Original Mix" et "Radio Mix" sont acceptés)
  if (/(dj mix|mixed by|continuous mix|mix 20\d\d|best of|top \d+)/.test(title) && !own.includes("mix")) return null;

  let s = 0;
  if (/radio (edit|version|mix)/.test(title)) s += 5;
  const artist = norm(d.artist).replace(/^the /, "");
  const ch = channel.replace(/ ?(vevo|official|officiel|topic|music|tv)$/g, "").trim();
  if (channel.endsWith("vevo") || channel.endsWith("topic") ||
      (artist.length > 2 && ch.length > 2 && (channel.includes(artist) || artist.includes(ch)))) s += 4;
  if (OFFICIAL.some(w => title.includes(w))) s += 3;
  const song = norm(d.song);
  if (song) s += title.includes(song.slice(0, 20)) ? 4 : -4;
  for (const w of PENALIZED) if (hasWord(title, w) && !hasWord(own, w)) s -= 2;
  return s;
}

function rank(d, ids) {
  return [...new Set(ids)]
    .filter(id => details[id])
    .map(id => ({ id, s: score(d, details[id]) }))
    .filter(x => x.s !== null)
    .sort((a, b) => b.s - a.s || (details[b.id].v || 0) - (details[a.id].v || 0))
    .map(x => x.id);
}

// 1) Morceaux voulus (tous genres), sans doublons
const wanted = [];
const seen = new Set();
for (const c of countries) {
  for (const list of Object.values(c.genres || { electro: c.djs || [] })) {
    list.forEach((d, pos) => {
      const k = keyOf(d);
      if (!seen.has(k)) { seen.add(k); wanted.push({ k, d, pos }); }
    });
  }
}

// 2) On réévalue les vidéos déjà connues avec les règles actuelles (peu coûteux)
const tracks = {};
try {
  await fetchDetails(wanted.flatMap(({ k, d }) => [...(d.videoId ? [d.videoId] : []), ...(oldTracks[k] || [])]));
} catch (e) {
  // Sans les détails (quota épuisé...), impossible de vérifier les vidéos :
  // on s'arrête SANS toucher à data/videos.json pour ne rien effacer.
  console.error(`Détails indisponibles (${e.message}). Fichier inchangé, nouvel essai au prochain passage.`);
  process.exit(1);
}
const toSearch = [];
for (const { k, d, pos } of wanted) {
  let ids = rank(d, oldTracks[k] || []);
  if (d.videoId) ids = [d.videoId, ...ids.filter(id => id !== d.videoId)]; // choix imposé, toujours en premier
  tracks[k] = ids;
  if (!ids.length && !searched[k]) toSearch.push({ k, d, pos });
}

// 3) Recherche des morceaux sans vidéo valable (les premiers de chaque liste d'abord)
toSearch.sort((a, b) => a.pos - b.pos);
let searches = 0;
for (const { k, d } of toSearch) {
  const q = (d.query || `${d.artist} ${d.song || ""}`).replace(/\s+/g, " ").trim();
  try {
    const r = await api("search", { part: "id", type: "video", maxResults: "10", q });
    const ids = (r.items || []).map(i => i.id?.videoId).filter(Boolean);
    await fetchDetails(ids);
    tracks[k] = rank(d, ids).slice(0, 5);
    searched[k] = true;
    searches++;
    const best = tracks[k][0];
    console.log(`Recherche : ${q} -> ${best ? `${details[best].t} (${Math.round(details[best].d / 60 * 10) / 10} min)` : "aucune vidéo valable"}`);
  } catch (e) {
    console.error(`Recherche échouée pour « ${q} » : ${e.message}`);
    if (e.reason === "quotaExceeded") { console.error("Quota épuisé, la suite au prochain passage."); break; }
  }
}

// 4) Écriture
const stats = {};
for (const ids of Object.values(tracks)) for (const id of ids) if (details[id]) stats[id] = details[id];
await writeFile("data/videos.json", JSON.stringify({ rev: REV, updatedAt: new Date().toISOString(), tracks, stats, searched }, null, 1) + "\n");

const empty = wanted.filter(({ k }) => !tracks[k].length).length;
const left = toSearch.length - searches;
console.log(`${searches} recherche(s). ${wanted.length - empty}/${wanted.length} morceaux ont une vidéo.` +
  (left > 0 ? ` ${left} restent à chercher au prochain passage.` : ""));
