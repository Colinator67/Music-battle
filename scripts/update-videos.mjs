// Met à jour data/videos.json à partir de data/countries.json.
// - Cherche sur YouTube les morceaux qui n'ont pas encore de vidéo (100 unités de quota par recherche)
// - Rafraîchit les vues de toutes les vidéos connues (1 unité par lot de 50)
// La clé est lue dans la variable d'environnement YT_API_KEY (secret GitHub), jamais dans le code.
import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.YT_API_KEY;
if (!KEY) { console.error("YT_API_KEY manquant : ajoutez le secret dans Settings > Secrets and variables > Actions."); process.exit(1); }

const countries = JSON.parse(await readFile("data/countries.json", "utf8"));
let db = { updatedAt: null, tracks: {}, stats: {} };
try { db = JSON.parse(await readFile("data/videos.json", "utf8")); } catch {}

const keyOf = d => `${d.artist}|${d.song || ""}`;

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

// 1) Liste des morceaux voulus, en gardant ce qui est déjà connu
const tracks = {};
const missing = [];
for (const c of countries) {
  for (const d of c.djs) {
    const k = keyOf(d);
    const known = db.tracks?.[k] || [];
    if (d.videoId) tracks[k] = [d.videoId, ...known.filter(id => id !== d.videoId)];
    else if (known.length) tracks[k] = known;
    else missing.push(d);
  }
}

// 2) Recherche des morceaux manquants
let searches = 0;
for (const d of missing) {
  const q = `${d.artist} ${d.song || ""} official`.replace(/\s+/g, " ").trim();
  try {
    const r = await api("search", {
      part: "snippet", type: "video", videoEmbeddable: "true", videoCategoryId: "10", maxResults: "5", q
    });
    const ids = (r.items || []).map(i => i.id?.videoId).filter(Boolean);
    if (ids.length) tracks[keyOf(d)] = ids;
    searches++;
    console.log(`Recherche : ${q} -> ${ids[0] || "aucun résultat"}`);
  } catch (e) {
    console.error(`Recherche échouée pour « ${q} » : ${e.message}`);
    if (e.reason === "quotaExceeded") { console.error("Quota épuisé, les recherches restantes seront faites au prochain passage."); break; }
  }
}

// 3) Vues de toutes les vidéos, par lots de 50
const allIds = [...new Set(Object.values(tracks).flat())];
const stats = {};
for (let i = 0; i < allIds.length; i += 50) {
  const batch = allIds.slice(i, i + 50);
  try {
    const r = await api("videos", { part: "snippet,statistics", id: batch.join(","), maxResults: "50" });
    for (const it of r.items || []) {
      stats[it.id] = {
        t: it.snippet?.title || "",
        v: it.statistics?.viewCount != null ? Number(it.statistics.viewCount) : null
      };
    }
  } catch (e) {
    console.error(`Statistiques indisponibles pour un lot : ${e.message}`);
    for (const id of batch) if (db.stats?.[id]) stats[id] = db.stats[id]; // on garde les anciennes valeurs
  }
}

// Une vidéo supprimée de YouTube n'a plus de stats : on la retire des listes
for (const k of Object.keys(tracks)) {
  const alive = tracks[k].filter(id => stats[id]);
  if (alive.length) tracks[k] = alive;
}

await writeFile("data/videos.json", JSON.stringify({ updatedAt: new Date().toISOString(), tracks, stats }, null, 1) + "\n");
console.log(`${searches} recherche(s), ${allIds.length} vidéo(s) mises à jour.`);
