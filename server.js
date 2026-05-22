const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cron = require("node-cron");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

// ─── In-memory state ──────────────────────────────────────────────────────────
let DEALS = [];
let STORES = buildStores();
let CLICKS = [];
let lastRefresh = null;
let ahToken = null;
let ahTokenExpiry = 0;

// ─── Store data ───────────────────────────────────────────────────────────────
function buildStores() {
  const ahStores = [
    { id: "ah_1", name: "Albert Heijn Amsterdam Centrum", supermarket: "albert_heijn", lat: 52.3731, lon: 4.8936, address: "Koningsplein 17, Amsterdam", open: "08:00-22:00" },
    { id: "ah_2", name: "Albert Heijn Amsterdam Zuid", supermarket: "albert_heijn", lat: 52.3456, lon: 4.8890, address: "Beethovenstraat 76, Amsterdam", open: "07:00-22:00" },
    { id: "ah_3", name: "Albert Heijn Rotterdam Centrum", supermarket: "albert_heijn", lat: 51.9225, lon: 4.4792, address: "Lijnbaan 23, Rotterdam", open: "08:00-21:00" },
    { id: "ah_4", name: "Albert Heijn Den Haag", supermarket: "albert_heijn", lat: 52.0800, lon: 4.3100, address: "Spuistraat 42, Den Haag", open: "07:00-22:00" },
    { id: "ah_5", name: "Albert Heijn Utrecht", supermarket: "albert_heijn", lat: 52.0907, lon: 5.1214, address: "Vredenburg 18, Utrecht", open: "08:00-21:00" },
    { id: "ah_6", name: "Albert Heijn Eindhoven", supermarket: "albert_heijn", lat: 51.4381, lon: 5.4752, address: "Markt 8, Eindhoven", open: "08:00-21:00" },
    { id: "ah_7", name: "Albert Heijn Groningen", supermarket: "albert_heijn", lat: 53.2194, lon: 6.5665, address: "Grote Markt 1, Groningen", open: "08:00-21:00" },
    { id: "ah_8", name: "Albert Heijn Maastricht", supermarket: "albert_heijn", lat: 50.8514, lon: 5.6910, address: "Markt 25, Maastricht", open: "08:00-21:00" },
  ];
  const lidlStores = [
    { id: "lidl_1", name: "Lidl Amsterdam Centrum", supermarket: "lidl", lat: 52.3702, lon: 4.8952, address: "Nieuwezijds Voorburgwal 162, Amsterdam", open: "08:00-21:00" },
    { id: "lidl_2", name: "Lidl Amsterdam Noord", supermarket: "lidl", lat: 52.4093, lon: 4.9222, address: "Purmerweg 59, Amsterdam", open: "08:00-21:00" },
    { id: "lidl_3", name: "Lidl Rotterdam", supermarket: "lidl", lat: 51.9300, lon: 4.4900, address: "Schiedamse Vest 154, Rotterdam", open: "08:00-21:00" },
    { id: "lidl_4", name: "Lidl Den Haag", supermarket: "lidl", lat: 52.0750, lon: 4.3150, address: "Laan van Meerdervoort 78, Den Haag", open: "08:00-21:00" },
    { id: "lidl_5", name: "Lidl Utrecht", supermarket: "lidl", lat: 52.0850, lon: 5.1280, address: "Kanaalweg 20, Utrecht", open: "08:00-21:00" },
    { id: "lidl_6", name: "Lidl Eindhoven", supermarket: "lidl", lat: 51.4420, lon: 5.4680, address: "Willemstraat 33, Eindhoven", open: "08:00-21:00" },
  ];
  const jumboStores = [
    { id: "jumbo_1", name: "Jumbo Amsterdam", supermarket: "jumbo", lat: 52.3750, lon: 4.9000, address: "Overtoom 150, Amsterdam", open: "08:00-22:00" },
    { id: "jumbo_2", name: "Jumbo Rotterdam", supermarket: "jumbo", lat: 51.9280, lon: 4.4820, address: "Coolsingel 95, Rotterdam", open: "08:00-22:00" },
    { id: "jumbo_3", name: "Jumbo Utrecht", supermarket: "jumbo", lat: 52.0950, lon: 5.1190, address: "Lange Elisabethstraat 2, Utrecht", open: "08:00-22:00" },
  ];
  return [...ahStores, ...lidlStores, ...jumboStores];
}

// ─── AH API ───────────────────────────────────────────────────────────────────
async function getAhToken() {
  if (ahToken && Date.now() < ahTokenExpiry) return ahToken;
  const res = await axios.post(
    "https://api.ah.nl/mobile-auth/v1/auth/token/anonymous",
    { clientId: "appie-android", clientSecret: "veldovic" },
    { timeout: 10000 }
  );
  ahToken = res.data.access_token;
  ahTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return ahToken;
}

async function fetchAhDeals() {
  console.log("Fetching AH deals...");
  const token = await getAhToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "x-application": "AHWEBSHOP",
    "User-Agent": "Appie/8.22.3 (nl.ahold.appie; build:810; Android 12) okhttp/4.10.0",
  };

  const products = [];
  let page = 0;
  while (true) {
    const res = await axios.get(
      `https://api.ah.nl/mobile-services/product/search/v2?bonus=BONUS&size=100&page=${page}`,
      { headers, timeout: 30000 }
    );
    const items = (res.data.products || []).filter(p => p.isBonus);
    if (items.length === 0 && page > 0) break;
    products.push(...items);
    const total = res.data.page?.totalPages || 1;
    if (page >= total - 1 || products.length >= 2000 || page >= 20) break;
    page++;
  }
  console.log(`AH: fetched ${products.length} bonus products across ${page + 1} pages`);

  const ahStoreIds = STORES.filter(s => s.supermarket === "albert_heijn").map(s => s.id);
  const deals = [];

  for (const p of products) {
    const regularPrice = p.priceBeforeBonus || 0;
    const label = p.discountLabels?.[0];
    let dealPrice, discountPct, discountLabel;

    if (label?.code === "DISCOUNT_X_FOR_Y" && label.price && label.count > 1) {
      // "2 voor €1.19" — per-item price
      dealPrice = Math.round((label.price / label.count) * 100) / 100;
      discountPct = regularPrice > 0 ? Math.round(((regularPrice - dealPrice) / regularPrice) * 100) : 0;
      discountLabel = `${label.count} voor €${label.price.toFixed(2)}`;
    } else if (label?.code === "DISCOUNT_X_PLUS_Y_FREE" && label.freeCount) {
      // "1+1 gratis"
      const total = (label.count || 1) + label.freeCount;
      dealPrice = regularPrice;
      discountPct = Math.round((label.freeCount / total) * 100);
      discountLabel = `${label.count}+${label.freeCount} gratis`;
    } else if (p.currentPrice && p.currentPrice < regularPrice) {
      dealPrice = p.currentPrice;
      discountPct = regularPrice > 0 ? Math.round(((regularPrice - dealPrice) / regularPrice) * 100) : 0;
      discountLabel = label?.percentage ? `-${label.percentage}%` : `-${discountPct}%`;
    } else if (label?.percentage) {
      dealPrice = regularPrice > 0 ? Math.round(regularPrice * (1 - label.percentage / 100) * 100) / 100 : 0;
      discountPct = label.percentage;
      discountLabel = `-${discountPct}%`;
    } else {
      dealPrice = p.currentPrice || regularPrice;
      discountPct = 0;
      discountLabel = p.bonusMechanism || "Actie";
    }

    if (!dealPrice || dealPrice <= 0) continue;

    const imgObj = (p.images || []).find(i => i.width >= 200) || p.images?.[0];

    const deal = {
      id: `ah_${p.webshopId || p.hqId}`,
      title: p.title || p.brand,
      brand: p.brand || "",
      category: mapAhCategory(p.mainCategory || p.subCategory || ""),
      supermarket: "albert_heijn",
      deal_price: dealPrice,
      regular_price: regularPrice > dealPrice ? regularPrice : dealPrice,
      discount_percent: discountPct,
      discount_label: discountLabel,
      unit: p.salesUnitSize || "",
      image_url: imgObj?.url || "",
      valid_from: p.bonusStartDate || new Date().toISOString(),
      valid_till: p.bonusEndDate || new Date(Date.now() + 7 * 86400000).toISOString(),
      store_ids: ahStoreIds,
      np_id: `np_ah_${p.id}`,
    };
    deals.push(deal);
  }

  return deals;
}

// ─── Jumbo scraper ────────────────────────────────────────────────────────────
function jumboGet(path) {
  return new Promise((resolve) => {
    const req = https.get({
      host: "www.jumbo.com", path, timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html",
        "Accept-Language": "nl-NL,nl;q=0.9",
      },
    }, (res) => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", () => resolve({ status: 0, data: "" }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, data: "" }); });
  });
}

function parseJumboTag(tag, currentPrice) {
  const t = (tag || "").toLowerCase().trim();
  const nVoorX = t.match(/^(\d+)\s+voor\s+(\d+[,.]?\d*)/);
  if (nVoorX) {
    const count = parseInt(nVoorX[1]);
    const total = parseFloat(nVoorX[2].replace(",", "."));
    const dealPrice = Math.round((total / count) * 100) / 100;
    const regularPrice = currentPrice > dealPrice ? currentPrice : Math.round(dealPrice * 1.35 * 100) / 100;
    const pct = regularPrice > 0 ? Math.round((1 - dealPrice / regularPrice) * 100) : 0;
    return { dealPrice, regularPrice, pct, label: tag.trim() };
  }
  const oneOne = t.match(/(\d+)\s*\+\s*(\d+)\s*gratis/);
  if (oneOne) {
    const free = parseInt(oneOne[2]);
    const pct = Math.round((free / (parseInt(oneOne[1]) + free)) * 100);
    return { dealPrice: currentPrice, regularPrice: currentPrice, pct, label: tag.trim() };
  }
  const pctMatch = t.match(/(-?\d+)\s*%/);
  if (pctMatch) {
    const pct = Math.abs(parseInt(pctMatch[1]));
    const regularPrice = pct > 0 ? Math.round(currentPrice / (1 - pct / 100) * 100) / 100 : currentPrice;
    return { dealPrice: currentPrice, regularPrice, pct, label: `-${pct}%` };
  }
  return { dealPrice: currentPrice, regularPrice: currentPrice, pct: 0, label: tag.trim() || "Actie" };
}

async function getJumboPromo(path, jumboStoreIds) {
  const r = await jumboGet(path);
  if (r.status !== 200) return null;
  const html = r.data;

  const promoId = path.match(/\/(\d+)$/)?.[1] || path;
  const tag = (html.match(/jum-tag[^>]*><!----><!--\[-->([\s\S]*?)<!--\]-->/) || [])[1]?.trim() || "";
  const dateMatch = html.match(/(\w{2} \d{1,2} t\/m \w{2} \d{1,2} \w+)/);
  const dateStr = dateMatch ? dateMatch[1] : "";

  // Parse date range
  const now = new Date();
  const validFrom = new Date(now); validFrom.setHours(0, 0, 0, 0);
  const validTill = new Date(now); validTill.setDate(validTill.getDate() + 7); validTill.setHours(23, 59, 59, 0);

  // Get first product image (DAM images only)
  const imgMatch = html.match(/src="(https:\/\/www\.jumbo\.com\/dam-images\/[^"]+)" alt="([^"]+)" class="ima/);
  if (!imgMatch) return null;
  const imageUrl = imgMatch[1];
  const productName = imgMatch[2];

  // Get first price
  const priceMatch = html.match(/Prijs:\s*€\s*([\d,]+)/);
  if (!priceMatch) return null;
  const currentPrice = parseFloat(priceMatch[1].replace(",", "."));
  if (!currentPrice || currentPrice <= 0) return null;

  // Get product SKU from first product link
  const skuMatch = html.match(/\/producten\/[^"]*-([A-Z0-9]+STK|[A-Z0-9]+CUP|[A-Z0-9]+ZK|[A-Z0-9]+DSL)"/);
  const sku = skuMatch ? skuMatch[1] : promoId;

  const { dealPrice, regularPrice, pct, label } = parseJumboTag(tag, currentPrice);

  return {
    id: `jumbo_${promoId}`,
    title: productName,
    brand: productName.startsWith("Jumbo ") ? "Jumbo" : productName.split(" ")[0],
    category: mapJumboCategory(productName),
    supermarket: "jumbo",
    deal_price: dealPrice,
    regular_price: regularPrice,
    discount_percent: pct,
    discount_label: label,
    unit: "",
    image_url: imageUrl,
    valid_from: validFrom.toISOString(),
    valid_till: validTill.toISOString(),
    store_ids: jumboStoreIds,
    np_id: `np_jumbo_${promoId}`,
  };
}

function mapJumboCategory(title) {
  const t = title.toLowerCase();
  if (t.match(/vlees|kip|ham|worst|burger|karbonade|spek|rund|varken|lam|kalf|steak|schnitzel/)) return "vlees_vis";
  if (t.match(/vis|zalm|haring|tonijn|garnaal|kabeljauw|pangasius/)) return "vlees_vis";
  if (t.match(/groente|fruit|paprika|tomaat|avocado|sla|spinazie|broccoli|aardappel|mango|aardbei|appel|peer|banaan|sinaasappel/)) return "groente_fruit";
  if (t.match(/melk|kaas|yoghurt|kwark|boter|room|ei|zuivel|mozzarella|skyr/)) return "zuivel_eieren";
  if (t.match(/brood|baguette|bollen|croissant|cake|koek|gebak|bagel|donut/)) return "bakkerij";
  if (t.match(/bier|wijn|frisdrank|sap|koffie|thee|water|tonic|ijsthee|cola|fanta|spa/)) return "dranken";
  if (t.match(/ijs|diepvries|pizza|snack.*diep/)) return "diepvries";
  if (t.match(/snoep|chips|noot|chocola|drop|gummi|koek|snack/)) return "snacks";
  if (t.match(/pasta|rijst|soep|saus|olie|mayonaise|ketchup|hagelslag/)) return "pasta_rijst";
  if (t.match(/wasmiddel|zeep|shampoo|deodorant|schoonmaak|toiletpapier|keukenrol/)) return "huishouden";
  if (t.match(/bloem|plant|tuin/)) return "bloemen_planten";
  return "overig";
}

async function fetchJumboDeals() {
  console.log("Fetching Jumbo deals...");
  const main = await jumboGet("/aanbiedingen/nu");
  if (main.status !== 200) { console.log("Jumbo: could not fetch main page"); return []; }

  const links = [...new Set([...main.data.matchAll(/href="(\/aanbiedingen\/[^/]+\/\d+)"/g)].map(m => m[1]))];
  console.log(`Jumbo: found ${links.length} promotions`);

  const jumboStoreIds = STORES.filter(s => s.supermarket === "jumbo").map(s => s.id);

  const results = await Promise.allSettled(links.map(link => getJumboPromo(link, jumboStoreIds)));
  const deals = results.filter(r => r.status === "fulfilled" && r.value).map(r => r.value);
  console.log(`Jumbo: extracted ${deals.length} deals`);
  return deals;
}

// ─── Lidl API ─────────────────────────────────────────────────────────────────
async function getLidlCampaignId() {
  return new Promise((resolve) => {
    const req = https.get(
      "https://www.lidl.nl/q/search?q=aanbieding&country=NL&language=nl",
      {
        timeout: 10000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "text/html",
          "Accept-Language": "nl-NL,nl;q=0.9",
        },
      },
      (res) => {
        res.resume();
        const loc = res.headers.location || "";
        const match = loc.match(/a(\d{6,})/);
        resolve(match ? match[1] : null);
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

async function fetchLidlDeals() {
  console.log("Fetching Lidl deals...");
  const campaignId = await getLidlCampaignId();
  if (!campaignId) {
    console.log("Lidl: could not determine campaign ID");
    return [];
  }
  console.log(`Lidl: campaign ID = ${campaignId}`);

  const res = await axios.get(
    `https://www.lidl.nl/c/api/campaigns/${campaignId}/NL/nl`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Accept-Language": "nl-NL,nl;q=0.9",
        "Referer": `https://www.lidl.nl/c/aanbiedingen/a${campaignId}`,
      },
      timeout: 15000,
    }
  );

  const sections = res.data.sections || [];
  const lidlStoreIds = STORES.filter(s => s.supermarket === "lidl").map(s => s.id);
  const deals = [];

  for (const section of sections) {
    if (!section.items || section.items.length === 0) continue;

    const validFrom = section.validFrom || new Date().toISOString();
    const validTill = section.validTill || new Date(Date.now() + 7 * 86400000).toISOString();

    for (const item of section.items) {
      if (item.type !== "PRODUCT") continue;
      const d = item.data || {};
      if (!d.havingPrice || !d.price) continue;

      // Get price - check lidlPlus first, then regular price
      let dealPrice, regularPrice, discountPct, discountLabel;

      const plusPricing = d.lidlPlus && d.lidlPlus[0];
      if (plusPricing && plusPricing.price && plusPricing.price.price > 0) {
        // Use Lidl Plus price as the deal price (they're shown in the folder)
        dealPrice = plusPricing.price.price;
        regularPrice = plusPricing.price.oldPrice || plusPricing.price.discount?.deletedPrice || dealPrice;
        discountPct = plusPricing.price.discount?.percentageDiscount || 0;
        discountLabel = plusPricing.highlightText || (discountPct > 0 ? `-${discountPct}%` : "Lidl Plus");
      } else {
        const price = d.price;
        if (!price.price && price.price !== 0) continue;
        dealPrice = price.price;
        regularPrice = price.oldPrice || price.discount?.deletedPrice || dealPrice;
        discountPct = price.discount?.percentageDiscount || 0;
        discountLabel = discountPct > 0 ? `-${discountPct}%` : (price.discount?.discountText || "Actie");
      }

      if (!dealPrice || dealPrice <= 0) continue;

      const imgList = d.imageList_V1 || d.imageList || [];
      const imageUrl = imgList[0]?.image || d.image || "";

      const deal = {
        id: `lidl_${item.id}`,
        title: d.title || d.fullTitle || "",
        brand: "",
        category: mapLidlCategory(d.title || ""),
        supermarket: "lidl",
        deal_price: dealPrice,
        regular_price: regularPrice > dealPrice ? regularPrice : dealPrice,
        discount_percent: discountPct,
        discount_label: discountLabel,
        unit: d.price?.packaging?.text || "",
        image_url: imageUrl,
        valid_from: validFrom,
        valid_till: validTill,
        store_ids: lidlStoreIds,
        np_id: `np_lidl_${item.id}`,
      };
      deals.push(deal);
    }
  }

  console.log(`Lidl: extracted ${deals.length} deals from campaign ${campaignId}`);
  return deals;
}

// ─── Category mappers ──────────────────────────────────────────────────────────
function mapAhCategory(cat) {
  const c = cat.toLowerCase();
  if (c.match(/vlees|vis|kip|gehakt|worst|hamburger|filet/)) return "vlees_vis";
  if (c.match(/groente|fruit|salade|aardappel|tomaat|paprika/)) return "groente_fruit";
  if (c.match(/zuivel|melk|kaas|yoghurt|boter|ei/)) return "zuivel_eieren";
  if (c.match(/brood|bakker|bak|koek|cake|gebak/)) return "bakkerij";
  if (c.match(/drank|bier|wijn|frisdrank|sap|koffie|thee|water/)) return "dranken";
  if (c.match(/diepvries|ijs/)) return "diepvries";
  if (c.match(/snoep|chips|snack|noot|dropje/)) return "snacks";
  if (c.match(/huishoud|schoonmaak|wasmiddel|zeep|tandenborstel/)) return "huishouden";
  if (c.match(/baby|luier/)) return "baby";
  if (c.match(/pasta|rijst|graan|saus|soep|conserven/)) return "pasta_rijst";
  return "overig";
}

function mapLidlCategory(title) {
  const t = title.toLowerCase();
  if (t.match(/vlees|hamburger|worst|kipfilet|kip|biefstuk|gehakt|lam|varken|kalf|entrecote|karbonade|speklap/)) return "vlees_vis";
  if (t.match(/vis|zalm|pangasius|kabeljauw|tonijn|garnaal/)) return "vlees_vis";
  if (t.match(/groente|fruit|paprika|tomaat|avocado|komkommer|sla|spinazie|broccoli|asperge|aardappel|mango|frambozen|aardbei|sinaasappel|appel|ananas|abrikoz|meloen/)) return "groente_fruit";
  if (t.match(/pioenen|lelie|geranium|lavendel|cactus|plant|bloem|boom/)) return "bloemen_planten";
  if (t.match(/melk|kaas|yoghurt|boter|room|ei|zuivel|mozzarella/)) return "zuivel_eieren";
  if (t.match(/brood|bagel|baguette|bollen|kaneelbrood|croissant|donut|cake|brownietaart|koek/)) return "bakkerij";
  if (t.match(/bier|wijn|champagne|cava|frisdrank|sap|koffie|thee|water|tonic|ijsthee|kombucha|drank/)) return "dranken";
  if (t.match(/ijs|sorbet/)) return "diepvries";
  if (t.match(/snoep|chips|snack|noot|tortilla|gummi|haribo|kinder|ritter|milka|chocolade/)) return "snacks";
  if (t.match(/wasmiddel|dreft|ariel|zeep|shampoo|deodorant|axe|altijd|schoonmaak|keukenrol|wc/)) return "huishouden";
  if (t.match(/pasta|rijst|soep|unox|nescafé|hagelslag|pindakaas|jam|sauce|mayo|olie|tortilla/)) return "pasta_rijst";
  return "overig";
}

// ─── Main refresh ──────────────────────────────────────────────────────────────
async function refreshAll() {
  console.log(`\n[${new Date().toISOString()}] Refreshing deals...`);
  try {
    const [ahDeals, lidlDeals, jumboDeals] = await Promise.allSettled([
      fetchAhDeals(),
      fetchLidlDeals(),
      fetchJumboDeals(),
    ]);

    const ah = ahDeals.status === "fulfilled" ? ahDeals.value : [];
    const lidl = lidlDeals.status === "fulfilled" ? lidlDeals.value : [];
    const jumbo = jumboDeals.status === "fulfilled" ? jumboDeals.value : [];

    if (ahDeals.status === "rejected") console.error("AH error:", ahDeals.reason?.message);
    if (lidlDeals.status === "rejected") console.error("Lidl error:", lidlDeals.reason?.message);
    if (jumboDeals.status === "rejected") console.error("Jumbo error:", jumboDeals.reason?.message);

    DEALS = [...ah, ...lidl, ...jumbo];
    lastRefresh = new Date().toISOString();
    console.log(`Total deals loaded: ${DEALS.length} (AH: ${ah.length}, Lidl: ${lidl.length}, Jumbo: ${jumbo.length})`);
  } catch (e) {
    console.error("Refresh error:", e.message);
  }
}

// ─── Haversine distance ────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Routes ────────────────────────────────────────────────────────────────────
app.post("/api/refresh", async (req, res) => {
  res.json({ ok: true, message: "Refresh started" });
  refreshAll();
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    deals: DEALS.length,
    lastRefresh,
    supermarkets: {
      albert_heijn: DEALS.filter(d => d.supermarket === "albert_heijn").length,
      lidl: DEALS.filter(d => d.supermarket === "lidl").length,
      jumbo: DEALS.filter(d => d.supermarket === "jumbo").length,
    },
  });
});

app.get("/api/stores", (req, res) => {
  res.json(STORES);
});

app.get("/api/deals", (req, res) => {
  const { supermarket, category, limit = 100, offset = 0 } = req.query;
  let deals = DEALS;
  if (supermarket) deals = deals.filter(d => d.supermarket === supermarket);
  if (category) deals = deals.filter(d => d.category === category);
  const total = deals.length;
  deals = deals.slice(Number(offset), Number(offset) + Number(limit));
  res.json({ deals, total, offset: Number(offset), limit: Number(limit) });
});

app.get("/api/deals/this-week", (req, res) => {
  const now = Date.now();
  const thisWeek = DEALS.filter(d => {
    const from = new Date(d.valid_from).getTime();
    const till = new Date(d.valid_till).getTime();
    return from <= now + 86400000 && till >= now;
  });
  res.json({ deals: thisWeek, total: thisWeek.length });
});

app.get("/api/nearby/deals", (req, res) => {
  const { lat, lon, radius = 10, supermarket, category, limit = 100 } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  const userLat = parseFloat(lat);
  const userLon = parseFloat(lon);
  const nearbyStoreIds = new Set(
    STORES
      .filter(s => haversine(userLat, userLon, s.lat, s.lon) <= parseFloat(radius))
      .map(s => s.id)
  );

  let deals = DEALS.filter(d => d.store_ids.some(id => nearbyStoreIds.has(id)));
  if (supermarket) deals = deals.filter(d => d.supermarket === supermarket);
  if (category) deals = deals.filter(d => d.category === category);
  deals = deals.slice(0, Number(limit));
  res.json({ deals, total: deals.length });
});

app.get("/api/nearby/stores", (req, res) => {
  const { lat, lon, radius = 10 } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });
  const userLat = parseFloat(lat);
  const userLon = parseFloat(lon);
  const stores = STORES
    .map(s => ({ ...s, distance: haversine(userLat, userLon, s.lat, s.lon) }))
    .filter(s => s.distance <= parseFloat(radius))
    .sort((a, b) => a.distance - b.distance);
  res.json(stores);
});

app.get("/api/products/:id", (req, res) => {
  const deal = DEALS.find(d => d.id === req.params.id);
  if (!deal) return res.status(404).json({ error: "Not found" });

  const alternatives = DEALS
    .filter(d => d.id !== deal.id && d.category === deal.category && d.supermarket !== deal.supermarket)
    .slice(0, 4)
    .map(d => ({
      id: d.id,
      title: d.title,
      supermarket: d.supermarket,
      deal_price: d.deal_price,
      regular_price: d.regular_price,
      discount_percent: d.discount_percent,
      image_url: d.image_url,
    }));

  res.json({ ...deal, alternatives });
});

app.get("/api/search", (req, res) => {
  const { q = "", category, supermarket, limit = 50 } = req.query;
  const query = q.toLowerCase();
  let deals = DEALS.filter(d =>
    d.title.toLowerCase().includes(query) || d.brand.toLowerCase().includes(query)
  );
  if (category) deals = deals.filter(d => d.category === category);
  if (supermarket) deals = deals.filter(d => d.supermarket === supermarket);
  deals = deals.slice(0, Number(limit));
  res.json({ deals, total: deals.length });
});

app.get("/api/search/suggest", (req, res) => {
  const { q = "" } = req.query;
  const query = q.toLowerCase();
  if (query.length < 2) return res.json([]);
  const seen = new Set();
  const suggestions = [];
  for (const d of DEALS) {
    const title = d.title.toLowerCase();
    if (title.startsWith(query) && !seen.has(d.title)) {
      seen.add(d.title);
      suggestions.push(d.title);
      if (suggestions.length >= 8) break;
    }
  }
  res.json(suggestions);
});

app.get("/api/map/stores", (req, res) => {
  res.json(STORES.map(s => ({
    id: s.id,
    name: s.name,
    supermarket: s.supermarket,
    lat: s.lat,
    lon: s.lon,
    address: s.address,
    open: s.open,
    dealCount: DEALS.filter(d => d.store_ids.includes(s.id)).length,
  })));
});

// ─── Click tracking ───────────────────────────────────────────────────────────
app.post("/api/track", (req, res) => {
  const { product_id, store_id, source, timestamp, conversion_type } = req.body || {};
  CLICKS.push({
    id: Date.now(),
    product_id: product_id || 'unknown',
    store_id: store_id || 'unknown',
    source_screen: source || 'unknown',
    timestamp: timestamp || new Date().toISOString(),
    conversion_type: conversion_type || 'click',
  });
  res.json({ ok: true });
});

app.get("/api/clicks", (req, res) => {
  res.json(CLICKS);
});

// ─── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;

refreshAll().then(() => {
  // If AH returned 0 on cold boot, retry once after 45s
  if (DEALS.filter(d => d.supermarket === "albert_heijn").length === 0) {
    console.log("AH returned 0 deals on boot — retrying in 45s...");
    setTimeout(refreshAll, 45000);
  }
  app.listen(PORT, () => {
    console.log(`\nFareboos Weekly Deals server running on http://localhost:${PORT}`);
    console.log(`Deals loaded: ${DEALS.length}`);
    console.log(`  - Albert Heijn: ${DEALS.filter(d => d.supermarket === "albert_heijn").length}`);
    console.log(`  - Lidl: ${DEALS.filter(d => d.supermarket === "lidl").length}`);
    console.log(`  - Jumbo: ${DEALS.filter(d => d.supermarket === "jumbo").length}`);
  });
});

// Refresh every 6 hours
cron.schedule("0 */6 * * *", refreshAll);
