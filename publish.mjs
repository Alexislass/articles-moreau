#!/usr/bin/env node
/**
 * Robot de publication — Drive → WordPress
 * ----------------------------------------
 * Scanne un dossier Google Drive, repère les Google Docs en `status: PUBLIER`,
 * les convertit en HTML WordPress et les crée via l'API REST, puis repasse
 * le Doc en `status: PUBLIÉ` pour éviter toute republication.
 *
 * Conçu pour tourner dans GitHub Actions (voir .github/workflows/publish.yml).
 * Aucune valeur sensible n'est écrite ici : tout vient des variables
 * d'environnement (secrets GitHub).
 *
 * Variables d'environnement attendues :
 *   WP_URL                       https://crayondigital.fr
 *   WP_USER                      identifiant WordPress
 *   WP_PASS                      mot de passe d'application WordPress
 *   GOOGLE_SERVICE_ACCOUNT_JSON  contenu JSON complet de la clé du compte de service
 *   DRIVE_FOLDER_NAME            "NOTAIRES ARTICLES" (par défaut)
 *   DRIVE_FOLDER_ID              (optionnel) ID du dossier ; prioritaire sur le nom
 *   DEFAULT_STATUS               "draft" (test) | "publish" | "future" (selon schedule_date)
 */

import { google } from "googleapis";

const {
  WP_URL,
  WP_USER,
  WP_PASS,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  DRIVE_FOLDER_NAME = "NOTAIRES ARTICLES",
  DRIVE_FOLDER_ID = "",
  DEFAULT_STATUS = "draft",
  PEXELS_API_KEY = "",
  ZERNIO_API_KEY = "",
  ZERNIO_LINKEDIN_ID = "",
  ZERNIO_INSTAGRAM_ID = "",
  FORCED_CATEGORY = "Nouveautés",
} = process.env;

function requireEnv() {
  const missing = [];
  if (!WP_URL) missing.push("WP_URL");
  if (!WP_USER) missing.push("WP_USER");
  if (!WP_PASS) missing.push("WP_PASS");
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) missing.push("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (missing.length) {
    console.error(`Secrets manquants : ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Authentification Google (compte de service)
// ---------------------------------------------------------------------------
function googleClients() {
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents",
    ],
  });
  return {
    drive: google.drive({ version: "v3", auth }),
    docs: google.docs({ version: "v1", auth }),
  };
}

async function resolveFolderId(drive) {
  if (DRIVE_FOLDER_ID) return DRIVE_FOLDER_ID;
  const res = await drive.files.list({
    q: `name='${DRIVE_FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 10,
  });
  const files = res.data.files || [];
  if (!files.length) {
    throw new Error(
      `Dossier "${DRIVE_FOLDER_NAME}" introuvable. ` +
        `Vérifie qu'il est partagé (Éditeur) avec l'e-mail du compte de service.`
    );
  }
  return files[0].id;
}

async function listDocs(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 100,
  });
  return res.data.files || [];
}

async function exportDocText(drive, fileId) {
  const res = await drive.files.export(
    { fileId, mimeType: "text/plain" },
    { responseType: "text" }
  );
  return typeof res.data === "string" ? res.data : String(res.data);
}

async function markPublished(docs, fileId) {
  // Remplace la première occurrence de "status: PUBLIER" par "status: PUBLIÉ"
  await docs.documents.batchUpdate({
    documentId: fileId,
    requestBody: {
      requests: [
        {
          replaceAllText: {
            containsText: { text: "status: PUBLIER", matchCase: false },
            replaceText: "status: PUBLIÉ",
          },
        },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// API WordPress
// ---------------------------------------------------------------------------
function makeApi(siteUrl, username, password) {
  const auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  const base = `${siteUrl.replace(/\/+$/, "")}/wp-json/wp/v2`;
  return async function request(endpoint, options = {}) {
    const response = await fetch(`${base}${endpoint}`, {
      ...options,
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        "User-Agent": "Notaire-Publisher/1.0",
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`WordPress API ${response.status}: ${body}`);
    }
    return response.json();
  };
}

// ---------------------------------------------------------------------------
// Image à la une (Pexels -> bibliothèque média WordPress)
// ---------------------------------------------------------------------------
function wpAuthHeader() {
  return "Basic " + Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64");
}

// fetch avec délai d'expiration (évite que le script reste bloqué indéfiniment)
async function fetchWithTimeout(url, options = {}, ms = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPexelsImageUrl(query) {
  if (!PEXELS_API_KEY) return null;
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=15&orientation=landscape`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: PEXELS_API_KEY } }, 15000);
  if (!res.ok) {
    console.log(`  ⚠️  Pexels a répondu ${res.status} — image ignorée.`);
    return null;
  }
  const data = await res.json();
  const photos = data.photos || [];
  if (!photos.length) {
    console.log(`  ⚠️  Pexels : aucune image pour "${query}" — image ignorée.`);
    return null;
  }
  // Un peu de variété : on pioche parmi les premiers résultats.
  const pick = photos[Math.floor(Math.random() * Math.min(photos.length, 10))];
  // src.large = ~1280px, plus léger/rapide à uploader que large2x.
  return pick.src.large || pick.src.medium || pick.src.original;
}

async function uploadFeaturedImage(siteUrl, query, slug, altText) {
  try {
    const imgUrl = await fetchPexelsImageUrl(query);
    if (!imgUrl) return null;

    const imgRes = await fetch(imgUrl);
    if (!imgRes.ok) return null;
    const buffer = Buffer.from(await imgRes.arrayBuffer());

    const base = `${siteUrl.replace(/\/+$/, "")}/wp-json/wp/v2`;
    const filename = `${slug || "image"}.jpg`;

    const up = await fetch(`${base}/media`, {
      method: "POST",
      headers: {
        Authorization: wpAuthHeader(),
        "Content-Type": "image/jpeg",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "User-Agent": "Notaire-Publisher/1.0",
      },
      body: buffer,
    });
    if (!up.ok) {
      console.log(`  ⚠️  Upload média WP ${up.status} — image ignorée.`);
      return null;
    }
    const media = await up.json();

    if (altText) {
      await fetch(`${base}/media/${media.id}`, {
        method: "POST",
        headers: { Authorization: wpAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ alt_text: altText }),
      });
    }
    console.log(`     Image à la une ajoutée (Pexels, média ID ${media.id}).`);
    return { id: media.id, sourceUrl: media.source_url };
  } catch (e) {
    console.log(`  ⚠️  Image à la une ignorée : ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Diffusion sociale (LinkedIn + Instagram via Zernio)
// ---------------------------------------------------------------------------
async function zernioCreatePost(body) {
  const res = await fetchWithTimeout(
    "https://zernio.com/api/v1/posts",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ZERNIO_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    20000
  );
  if (!res.ok) {
    console.log(`  ⚠️  Zernio ${res.status} — post social ignoré : ${await res.text()}`);
    return false;
  }
  return true;
}

async function postToSocial(articleUrl, imageUrl, meta) {
  if (!ZERNIO_API_KEY) return;

  // LinkedIn : texte + lien (LinkedIn génère l'aperçu avec l'image via Open Graph)
  if (ZERNIO_LINKEDIN_ID && meta.linkedin_post) {
    const ok = await zernioCreatePost({
      content: `${meta.linkedin_post}\n\n${articleUrl}`,
      publishNow: true,
      platforms: [{ platform: "linkedin", accountId: ZERNIO_LINKEDIN_ID }],
    });
    console.log(ok ? "     → LinkedIn publié." : "     → LinkedIn non publié.");
  }

  // Instagram : légende + image obligatoire (les liens ne sont pas cliquables sur IG)
  if (ZERNIO_INSTAGRAM_ID && meta.instagram_caption) {
    if (!imageUrl) {
      console.log("     → Instagram ignoré (aucune image disponible).");
    } else {
      const ok = await zernioCreatePost({
        content: meta.instagram_caption,
        publishNow: true,
        mediaItems: [{ url: imageUrl, type: "image" }],
        platforms: [
          {
            platform: "instagram",
            accountId: ZERNIO_INSTAGRAM_ID,
            // Le lien va en premier commentaire (les légendes Insta n'ont pas de lien cliquable)
            platformSpecificData: {
              firstComment: `📖 Article complet : ${articleUrl}`,
            },
          },
        ],
      });
      console.log(ok ? "     → Instagram publié." : "     → Instagram non publié.");
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing du Google Doc (en-tête + corps)
// ---------------------------------------------------------------------------
function parseGoogleDoc(text) {
  // Google Docs (export texte) échappe les caractères markdown : "\#\#", "\---",
  // "meta\_title", "\*\*"... On retire ces antislashs d'échappement.
  text = text
    .replace(/\r/g, "")
    .replace(/\\([\\`*_{}\[\]()#+\-.!=>~|])/g, "$1");
  const lines = text.split("\n");
  const meta = {};
  let bodyStartIndex = 0;
  let foundTitle = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line && !foundTitle) continue;
    if (!foundTitle) {
      meta.title = line;
      foundTitle = true;
      continue;
    }
    if (/^\\?[-_=]{3,}$/.test(line)) {
      bodyStartIndex = i + 1;
      break;
    }
    const kv = line.match(
      /^(slug|excerpt|categories|tags|schedule|status|schedule_date|featured_image_alt|meta_title|meta_description|image_query|linkedin_post|instagram_caption)\s*:\s*(.+)$/i
    );
    if (kv) {
      const key = kv[1].toLowerCase().replace("schedule_date", "schedule");
      const value = kv[2].trim();
      meta[key] = key === "categories" || key === "tags"
        ? value.split(",").map((s) => s.trim()).filter(Boolean)
        : value;
      continue;
    }
    if (foundTitle && line) {
      bodyStartIndex = i;
      break;
    }
  }
  return { meta, body: lines.slice(bodyStartIndex).join("\n").trim() };
}

// ---------------------------------------------------------------------------
// Conversion texte/markdown → blocs Gutenberg
// ---------------------------------------------------------------------------
function processInline(text) {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function buildRankMathFaq(faqText) {
  const lines = faqText.split("\n");
  const pairs = [];
  let q = null;
  let a = [];
  const flush = () => {
    if (q && a.length) pairs.push({ question: q, answer: a.join(" ") });
    q = null;
    a = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const qPrefix = line.match(/^Q\s*:\s*(.+?\??)$/i);
    const qBold = line.match(/^\*\*(.+?\?)\*\*$/);
    if (qPrefix) {
      flush();
      q = qPrefix[1];
      continue;
    }
    if (qBold) {
      flush();
      q = qBold[1];
      continue;
    }
    if (q) a.push(line);
  }
  flush();
  if (!pairs.length) return null;
  const items = pairs
    .map(
      (p) =>
        `<div class="rank-math-faq-item"><h3 class="rank-math-question">${p.question}</h3><div class="rank-math-answer">${p.answer}</div></div>`
    )
    .join("\n");
  const jsonLd = pairs.map((p, idx) => ({
    id: `faq-${Date.now()}-${idx}`,
    title: p.question,
    content: p.answer,
    visible: true,
  }));
  return `<!-- wp:rank-math/faq-block ${JSON.stringify({ questions: jsonLd })} -->\n<div class="wp-block-rank-math-faq-block">${items}</div>\n<!-- /wp:rank-math/faq-block -->`;
}

function toGutenbergBlocks(text) {
  let mainContent = text;
  let faqContent = null;
  const faqMatch = text.match(/\n\*{0,2}FAQ\*{0,2}\s*\n([\s\S]+)$/i);
  if (faqMatch) {
    mainContent = text.slice(0, faqMatch.index);
    faqContent = faqMatch[1].trim();
  }
  const lines = mainContent.split("\n");
  const blocks = [];
  const spacer = (h) =>
    `<!-- wp:spacer {"height":"${h}"} -->\n<div style="height:${h}" aria-hidden="true" class="wp-block-spacer"></div>\n<!-- /wp:spacer -->`;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }
    let headingText = null;
    let level = 2;
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      level = Math.min(Math.max(h[1].length, 2), 4);
      headingText = h[2].replace(/\*\*/g, "");
    } else {
      const bold = line.match(/^\*\*(.+?)\*\*$/);
      const prev = (lines[i - 1] || "").trim();
      const next = (lines[i + 1] || "").trim();
      if (bold && (prev === "" || i === 0) && (next === "" || i === lines.length - 1)) {
        headingText = bold[1];
        level = 2;
      }
    }
    if (headingText) {
      blocks.push(spacer("40px"));
      blocks.push(
        `<!-- wp:heading {"level":${level}} -->\n<h${level} class="wp-block-heading">${processInline(headingText)}</h${level}>\n<!-- /wp:heading -->`
      );
      blocks.push(spacer("15px"));
      i++;
      continue;
    }
    if (/^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const items = [];
      const ordered = /^\d+\.\s+/.test(line);
      while (i < lines.length) {
        const l = lines[i].trim();
        const m = l.match(/^[-*•]\s+(.+)$/) || l.match(/^\d+\.\s+(.+)$/);
        if (!m) break;
        items.push(processInline(m[1]));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      const li = items
        .map((it) => `<!-- wp:list-item -->\n<li>${it}</li>\n<!-- /wp:list-item -->`)
        .join("\n");
      blocks.push(`<!-- wp:list -->\n<${tag}>\n${li}\n</${tag}>\n<!-- /wp:list -->`);
      continue;
    }
    if (line.startsWith("> ")) {
      blocks.push(
        `<!-- wp:quote -->\n<blockquote class="wp-block-quote"><p>${processInline(line.slice(2))}</p></blockquote>\n<!-- /wp:quote -->`
      );
      i++;
      continue;
    }
    if (/^[-_=]{3,}$/.test(line)) {
      i++;
      continue;
    }
    blocks.push(`<!-- wp:paragraph -->\n<p>${processInline(line)}</p>\n<!-- /wp:paragraph -->`);
    i++;
  }
  if (faqContent) {
    const faq = buildRankMathFaq(faqContent);
    if (faq) {
      blocks.push(spacer("40px"));
      blocks.push(`<!-- wp:heading {"level":2} -->\n<h2 class="wp-block-heading">FAQ</h2>\n<!-- /wp:heading -->`);
      blocks.push(spacer("15px"));
      blocks.push(faq);
    }
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Catégories / tags
// ---------------------------------------------------------------------------
async function getOrCreate(api, type, name) {
  const list = await api(`/${type}?search=${encodeURIComponent(name)}&per_page=100`);
  const found = list.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  try {
    const created = await api(`/${type}`, { method: "POST", body: JSON.stringify({ name }) });
    return created.id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------
async function publish(api, meta, body) {
  const content = toGutenbergBlocks(body);

  // On force toujours la catégorie "Nouveautés" (pour le template Elementor),
  // en plus des catégories thématiques du Doc, sans doublon.
  const catNames = [];
  const seenCat = new Set();
  for (const name of [FORCED_CATEGORY, ...(meta.categories || [])]) {
    const n = (name || "").trim();
    if (!n || seenCat.has(n.toLowerCase())) continue;
    seenCat.add(n.toLowerCase());
    catNames.push(n);
  }
  const categories = [];
  for (const name of catNames) {
    const id = await getOrCreate(api, "categories", name);
    if (id) categories.push(id);
  }
  const tags = [];
  for (const name of meta.tags || []) {
    const id = await getOrCreate(api, "tags", name);
    if (id) tags.push(id);
  }

  // Pour le test : DEFAULT_STATUS="draft" => rien ne part en ligne.
  let status = DEFAULT_STATUS;
  const postData = {
    title: meta.title,
    content,
    status,
    slug:
      meta.slug ||
      meta.title.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    excerpt: meta.excerpt || "",
    categories: categories.length ? categories : undefined,
    tags: tags.length ? tags : undefined,
  };
  if (status === "future" && meta.schedule) postData.date = meta.schedule;

  // Métadonnées SEO Yoast (nécessite le snippet d'autorisation côté WordPress)
  const yoast = {};
  if (meta.meta_title) yoast._yoast_wpseo_title = meta.meta_title;
  if (meta.meta_description) yoast._yoast_wpseo_metadesc = meta.meta_description;
  if (Object.keys(yoast).length) postData.meta = yoast;

  // Image à la une depuis Pexels (si une clé API est fournie)
  const imageQuery =
    meta.image_query ||
    (meta.tags && meta.tags[0]) ||
    (meta.categories && meta.categories[0]) ||
    "notary office documents";
  const featured = await uploadFeaturedImage(WP_URL, imageQuery, postData.slug, meta.featured_image_alt);
  if (featured) postData.featured_media = featured.id;

  const result = await api("/posts", { method: "POST", body: JSON.stringify(postData) });

  // Diffusion sociale (uniquement si l'article est réellement en ligne)
  if (result.status === "publish") {
    try {
      await postToSocial(result.link, featured && featured.sourceUrl, meta);
    } catch (e) {
      console.log(`  ⚠️  Diffusion sociale ignorée : ${e.message}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  requireEnv();
  const { drive, docs } = googleClients();
  const api = makeApi(WP_URL, WP_USER, WP_PASS);

  const folderId = await resolveFolderId(drive);
  const files = await listDocs(drive, folderId);
  console.log(`Dossier OK — ${files.length} document(s) trouvé(s).`);

  let published = 0;
  let skipped = 0;

  for (const file of files) {
    const text = await exportDocText(drive, file.id);
    // Support multi-articles séparés par =====
    const chunks = text.split(/\n\s*={3,}\s*\n/);
    let touched = false;

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const { meta, body } = parseGoogleDoc(chunk);
      const st = (meta.status || "").trim().toLowerCase();
      if (st !== "publier") {
        skipped++;
        continue;
      }
      if (!meta.title) {
        console.log(`  ⚠️  "${file.name}" : titre manquant, ignoré.`);
        continue;
      }
      console.log(`  → Publication : "${meta.title}" (statut cible: ${DEFAULT_STATUS})`);
      const res = await publish(api, meta, body);
      console.log(`     OK — ID ${res.id} | ${res.status} | ${res.link}`);
      published++;
      touched = true;
    }

    if (touched) {
      await markPublished(docs, file.id);
      console.log(`     Doc "${file.name}" repassé en PUBLIÉ.`);
    }
  }

  console.log(`\nTerminé. ${published} publié(s), ${skipped} ignoré(s) (non en PUBLIER).`);
}

main().catch((err) => {
  console.error(`\nErreur : ${err.message}\n`);
  process.exit(1);
});
