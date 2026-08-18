import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

async function parseProductUrl(url) {
  if (!url || !url.startsWith('http')) {
    return { error: 'URL inválida o no configurada' };
  }
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-VE,es;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });
    if (!res.ok) {
      return { error: `HTTP ${res.status}: No se pudo cargar la página` };
    }
    const html = await res.text();

    let nombre = null;
    let precio_full_bs = null;
    let precio_desc_bs = null;
    let tiene_descuento = false;
    let marca = null;

    // 1. Check Schema.org JSON-LD
    const jsonLdMatches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs) || [];
    for (const match of jsonLdMatches) {
      try {
        const jsonStr = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '').trim();
        const data = JSON.parse(jsonStr);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item['@type'] === 'Product' || item.offers) {
            nombre = nombre || item.name;
            if (item.brand) {
              marca = typeof item.brand === 'string' ? item.brand : item.brand.name;
            }
            const offer = item.offers;
            if (offer) {
              const p = parseFloat(offer.price);
              const low = parseFloat(offer.lowPrice);
              const high = parseFloat(offer.highPrice);

              if (low && high && high > low) {
                precio_full_bs = high;
                precio_desc_bs = low;
                tiene_descuento = true;
              } else if (p && low && p > low) {
                precio_full_bs = p;
                precio_desc_bs = low;
                tiene_descuento = true;
              } else if (p) {
                precio_full_bs = p;
              } else if (low) {
                precio_full_bs = low;
              }
            }
          }
        }
      } catch (e) {}
    }

    // 2. Next.js / App Root State (Farmatodo, etc.)
    if (!precio_full_bs) {
      const appState = html.match(/<script[^>]*id="app-root-state"[^>]*>(.*?)<\/script>/s);
      if (appState) {
        const decoded = appState[1].replace(/&q;/g, '"').replace(/&amp;/g, '&');
        const priceMatches = decoded.match(/"price":\s*([0-9.]+)/g);
        if (priceMatches) {
          const vals = priceMatches.map(p => parseFloat(p.split(':')[1])).filter(v => v > 0);
          if (vals.length > 0) precio_full_bs = Math.max(...vals);
        }
      }
    }

    // 3. Fallback regex DOM scanning for prices in Bs
    if (!precio_full_bs) {
      const bsMatches = html.match(/(?:Bs\.?|VES|Bs)\s*([0-9.,]+)/gi) || html.match(/([0-9.,]+)\s*(?:Bs\.?|VES|Bs)/gi);
      if (bsMatches) {
        const parsed = bsMatches.map(m => {
          const numStr = m.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
          return parseFloat(numStr);
        }).filter(n => n > 0.5 && n < 100000);

        if (parsed.length > 0) {
          precio_full_bs = Math.max(...parsed);
          const minP = Math.min(...parsed);
          if (precio_full_bs > minP && (precio_full_bs - minP) > 0.1) {
            precio_desc_bs = minP;
            tiene_descuento = true;
          }
        }
      }
    }

    // Clean up title/name if extracted
    if (!nombre) {
      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
      if (h1Match) {
        nombre = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }
    }
    if (nombre) nombre = nombre.trim();

    return {
      nombre,
      marca,
      precio_full_bs,
      precio_desc_bs,
      tiene_descuento,
      scraped_at: new Date().toISOString()
    };
  } catch (err) {
    return { error: err.message };
  }
}

function liveScraperPlugin() {
  return {
    name: 'live-scraper-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.startsWith('/api/scrape-url')) {
          const urlObj = new URL(req.url, 'http://localhost:3000');
          const targetUrl = urlObj.searchParams.get('url');
          if (!targetUrl) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Parámetro ?url= es requerido' }));
            return;
          }
          const result = await parseProductUrl(targetUrl);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }

        if (req.url === '/api/scrape-batch' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const { items } = JSON.parse(body || '{}');
              if (!Array.isArray(items)) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'El cuerpo debe incluir un arreglo "items"' }));
                return;
              }
              const results = [];
              for (const item of items) {
                if (item.url) {
                  const resData = await parseProductUrl(item.url);
                  results.push({ ...item, ...resData });
                } else {
                  results.push({ ...item, error: 'Sin URL' });
                }
              }
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ results }));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), liveScraperPlugin()],
  base: '/',
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true
  }
});

