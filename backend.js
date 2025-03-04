import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const app = express();
const PORT = 5001;
const url = "https://www.willhaben.at/iad/gebrauchtwagen/auto/gebrauchtwagenboerse?sfId=6bc718a3-598a-4308-b98e-10c829d0730c&isNavigation=true&rows=30&page=1&sort=1&PRICE_TO=12000";

// URL-ovi za dohvatanje svežih proxy servera
const PROXY_API_URLS = [
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text&timeout=20000",
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all"
];
let currentApiIndex = 0; // Indeks trenutnog API-ja za rotaciju

let proxyList = []; // Lista proxy servera
let currentProxyIndex = 0;
let cachedCars = [];
const FETCH_INTERVAL = 3000; // 3 sekunde za dohvatanje automobila
const PROXY_TIMEOUT = 5000; // 5 sekundi za timeout proxy-ja
const PROXY_REFRESH_INTERVAL = 1800000; // 30 minuta za osvežavanje proxy liste
let workingProxies = []; // Lista proxy-ja koji rade

// Funkcija za dohvatanje svežih proxy servera
const fetchFreshProxies = async () => {
  try {
    // Rotiramo API-je za dohvatanje proxy servera
    const apiUrl = PROXY_API_URLS[currentApiIndex];
    currentApiIndex = (currentApiIndex + 1) % PROXY_API_URLS.length;
    
    console.log(`Dohvatam sveže proxy servere sa API-ja: ${apiUrl}`);
    
    const response = await fetch(apiUrl);
    if (!response.ok) {
      throw new Error(`HTTP greška: ${response.status}`);
    }
    
    const text = await response.text();
    const proxies = text.trim().split('\n')
      .map(proxy => proxy.trim())
      .filter(proxy => proxy && proxy.includes(':'));
    
    if (proxies.length > 0) {
      console.log(`Dohvaćeno ${proxies.length} svežih proxy servera.`);
      
      // Dodajemo http:// prefiks ako ga nema
      const formattedProxies = proxies.map(proxy => {
        if (!proxy.startsWith('http://') && !proxy.startsWith('https://') && 
            !proxy.startsWith('socks4://') && !proxy.startsWith('socks5://')) {
          return `http://${proxy}`;
        }
        return proxy;
      });
      
      // Dodajemo nove proxy servere u listu (bez duplikata)
      const newProxies = formattedProxies.filter(proxy => !proxyList.includes(proxy));
      proxyList = [...proxyList, ...newProxies];
      
      console.log(`Dodato ${newProxies.length} novih proxy servera. Ukupno: ${proxyList.length}`);
      
      // Resetujemo listu radnih proxy-ja da bi se ponovo testirali
      workingProxies = [];
      await initializeWorkingProxies();
      
      return true;
    } else {
      console.warn(`Nije dohvaćen nijedan proxy server sa API-ja: ${apiUrl}. Pokušaću sa drugim API-jem.`);
      
      // Pokušavamo sa drugim API-jem
      if (PROXY_API_URLS.length > 1) {
        return await fetchFreshProxies();
      } else {
        console.warn("Nijedan API nije vratio proxy servere. Koristiću direktnu konekciju.");
        proxyList = [];
        workingProxies = ['direct'];
        return false;
      }
    }
  } catch (error) {
    console.error("Greška pri dohvatanju proxy servera:", error.message);
    
    // Pokušavamo sa drugim API-jem
    if (PROXY_API_URLS.length > 1 && currentApiIndex !== 0) {
      console.log("Pokušavam sa drugim API-jem...");
      currentApiIndex = (currentApiIndex + 1) % PROXY_API_URLS.length;
      return await fetchFreshProxies();
    }
    
    console.warn("Koristiću direktnu konekciju.");
    proxyList = [];
    workingProxies = ['direct'];
    return false;
  }
};

// Funkcija za proveru da li proxy radi
const checkProxy = async (proxyUrl) => {
  try {
    const agent = createProxyAgent(proxyUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT);
    
    const response = await fetch('https://api.ipify.org?format=json', {
      agent: agent,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      const data = await response.json();
      console.log(`Proxy ${proxyUrl} radi. IP adresa: ${data.ip}`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`Proxy ${proxyUrl} ne radi:`, error.message);
    return false;
  }
};

// Funkcija za inicijalizaciju radnih proxy-ja
const initializeWorkingProxies = async () => {
  console.log("Proveravam proxy servere...");
  
  if (proxyList.length === 0) {
    console.warn("Nema proxy servera za testiranje. Koristiću direktnu konekciju.");
    workingProxies = ['direct'];
    return;
  }
  
  // Testiramo samo prvih 50 proxy servera da ne bismo preopteretili sistem
  const proxiesToTest = proxyList.slice(0, 50);
  
  const checkPromises = proxiesToTest.map(proxy => 
    checkProxy(proxy)
      .then(isWorking => isWorking ? proxy : null)
      .catch(() => null)
  );
  
  const results = await Promise.all(checkPromises);
  workingProxies = results.filter(proxy => proxy !== null);
  
  console.log(`Pronađeno ${workingProxies.length} ispravnih proxy servera od testiranih ${proxiesToTest.length}`);
  
  if (workingProxies.length === 0) {
    console.warn("Nijedan proxy ne radi! Koristiću direktnu konekciju.");
    workingProxies = ['direct']; // Specijalna vrednost za direktnu konekciju
  }
};

// Funkcija za dobijanje sledećeg proxy servera koji radi
const getNextProxy = () => {
  if (workingProxies.length === 0) {
    return 'direct'; // Ako nemamo radnih proxy-ja, koristimo direktnu konekciju
  }
  
  const proxy = workingProxies[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % workingProxies.length;
  return proxy;
};

// Funkcija za kreiranje odgovarajućeg proxy agenta
const createProxyAgent = (proxyUrl) => {
  if (proxyUrl === 'direct') {
    return null; // Bez proxy-ja
  } else if (proxyUrl.startsWith('socks4://') || proxyUrl.startsWith('socks5://')) {
    return new SocksProxyAgent(proxyUrl);
  } else if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
    return new HttpsProxyAgent(proxyUrl);
  } else {
    throw new Error('Nepodržani proxy protokol');
  }
};

app.use(cors());

const fetchCarAds = async () => {
  try {
    const proxyUrl = getNextProxy();
    console.log(`Korišćenje proxy servera: ${proxyUrl}`);
    
    const agent = createProxyAgent(proxyUrl);
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Connection': 'keep-alive',
        'Cache-Control': 'max-age=0'
      }
    };
    
    if (agent) {
      options.agent = agent;
    }
    
    const response = await fetch(url, options);
    
    const text = await response.text();
    const $ = cheerio.load(text);
    const cars = [];
    const baseUrl = "https://www.willhaben.at/iad/gebrauchtwagen/d/auto/";

    $("a[data-testid^='search-result-entry-header']").each((i, element) => {
      const id = $(element).attr("id") || $(element).attr("data-testid");
      if (!id) return;

      const extractedId = id.match(/\d+$/)[0];
      const title = $(element).find("h3").text().trim();
      const price = $(element).find("[data-testid^='search-result-entry-price']").text().trim();
      const location = $(element).find("[data-testid^='search-result-entry-location']").text().trim();
      const link = `${baseUrl}${title.toLowerCase().replace(/\s+/g, "-")}-${extractedId}/`;

      cars.push({ id, title, price, location, link });
    });

    console.log(`Pronađeno ${cars.length} automobila`);
    
    // Ažuriranje keširanih podataka
    if (cars.length > 0) {
      cachedCars = cars;
    }
    
    return cars.length > 0 ? cars : cachedCars;
  } catch (error) {
    console.error("Greška pri dohvatanju oglasa za automobile:", error.message);
    
    // Ako je proxy problem, označimo ga kao neispravan i probajmo ponovo sa drugim
    if (error.message.includes('ECONNREFUSED') || 
        error.message.includes('ETIMEDOUT') || 
        error.message.includes('ECONNRESET')) {
      const failedProxy = getNextProxy();
      console.log(`Uklanjam neispravan proxy: ${failedProxy}`);
      workingProxies = workingProxies.filter(p => p !== failedProxy);
      
      if (workingProxies.length === 0) {
        console.warn("Svi proxy serveri su neispravni! Pokušavam ponovo inicijalizaciju...");
        initializeWorkingProxies();
      }
    }
    
    return cachedCars; // Vraćamo keširane podatke u slučaju greške
  }
};

// Funkcija za periodično dohvatanje podataka
const startPeriodicFetching = () => {
  console.log("Započinjem periodično dohvatanje podataka...");
  
  // Prvo dohvatanje
  fetchCarAds();
  
  // Postavljanje intervala za periodično dohvatanje automobila
  setInterval(async () => {
    console.log("Dohvatam nove podatke o automobilima...");
    await fetchCarAds();
  }, FETCH_INTERVAL);
  
  // Postavljanje intervala za periodično osvežavanje proxy servera
  setInterval(async () => {
    console.log("Osvežavam listu proxy servera...");
    await fetchFreshProxies();
  }, PROXY_REFRESH_INTERVAL);
};

app.get("/cars", async (req, res) => {
  // Ako nemamo keširane podatke, dohvatamo ih
  if (cachedCars.length === 0) {
    cachedCars = await fetchCarAds();
  }
  
  res.json(cachedCars);
});

// Endpoint za ručno osvežavanje podataka o automobilima
app.get("/refresh", async (req, res) => {
  console.log("Ručno osvežavanje podataka o automobilima...");
  const cars = await fetchCarAds();
  res.json({ success: true, count: cars.length });
});

// Endpoint za ručno osvežavanje proxy servera
app.get("/refresh-proxies", async (req, res) => {
  console.log("Ručno osvežavanje proxy servera...");
  const success = await fetchFreshProxies();
  res.json({ 
    success, 
    totalProxies: proxyList.length,
    workingProxies: workingProxies.length
  });
});

// Endpoint za prikaz statistike proxy servera
app.get("/proxy-stats", (req, res) => {
  res.json({
    total: proxyList.length,
    working: workingProxies.length,
    current: workingProxies[currentProxyIndex],
    workingList: workingProxies,
    currentApi: PROXY_API_URLS[currentApiIndex]
  });
});

app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  
  // Prvo dohvatamo sveže proxy servere
  await fetchFreshProxies();
  
  // Inicijalizacija proxy servera
  await initializeWorkingProxies();
  
  // Pokretanje periodičnog dohvatanja podataka
  startPeriodicFetching();
});
