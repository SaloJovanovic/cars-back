import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const app = express();
const PORT = 5001;
const url = "https://www.willhaben.at/iad/gebrauchtwagen/auto/gebrauchtwagenboerse?sfId=6bc718a3-598a-4308-b98e-10c829d0730c&isNavigation=true&rows=30&sort=1&DEALER=1&page=1&PRICE_TO=12000";

// URL za dohvatanje plaćenih proxy servera
const PAID_PROXY_API_URL = "https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=16791c81jgzqofaeyh3s&type=getproxies&country[]=all&protocol=http&format=json&status=online";

// Ograničenja API-ja
const API_RATE_LIMIT = {
  REQUESTS_PER_SECOND: 4,
  REQUESTS_PER_HOUR: 240,
  REQUESTS_PER_DAY: 2880
};

// Vreme poslednjeg zahteva za proxy
let lastProxyRequestTime = 0;

let proxyList = []; // Lista svih proxy servera
let currentProxyIndex = 0;
let cachedCars = [];
const FETCH_INTERVAL = 2500; // 3 sekunde za dohvatanje automobila
const PROXY_TIMEOUT = 5000; // 5 sekundi za timeout proxy-ja
const PROXY_REFRESH_INTERVAL = 300000; // 5 minuta za osvežavanje proxy liste
const PROXY_TEST_INTERVAL = 30000; // 30 sekundi za testiranje novih proxy servera
let workingProxies = []; // Lista proxy-ja koji rade
let isProxyTestRunning = false; // Flag da li je testiranje proxy-ja u toku
let proxyTestQueue = []; // Red za testiranje proxy servera
let proxyUsageCount = {}; // Brojač korišćenja svakog proxy-ja

// Konstanta za ProxyScrape API ključ
const ProxyScrapeAPIKey = '16791c81jgzqofaeyh3s'; // Tvoj API ključ

// Funkcija za dohvatanje podataka preko ProxyScrape API-ja
const fetchWithProxyScrape = async (targetUrl) => {
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
      
      // Dodajemo nove proxy servere u red za testiranje
      proxyTestQueue.push(...newProxies);
      
      // Pokrenemo testiranje ako nije već u toku
      if (!isProxyTestRunning) {
        testProxiesFromQueue();
      }
      
      return true;
    } else {
      console.warn(`Nije dohvaćen nijedan proxy server sa API-ja: ${apiUrl}. Pokušaću sa drugim API-jem.`);
      
      // Pokušavamo sa drugim API-jem
      if (PROXY_API_URLS.length > 1) {
        return await fetchFreshProxies();
      } else {
        console.warn("Nijedan API nije vratio proxy servere. Koristiću direktnu konekciju.");
        if (workingProxies.length === 0) {
          workingProxies = ['direct'];
        }
        return false;
      }
    }
  } catch (error) {
    console.error(`Greška pri dohvatanju podataka preko ProxyScrape API-ja: ${error.message}`);
    throw error;
  }
};

// Funkcija za dohvatanje plaćenih proxy servera
const fetchPaidProxies = async () => {
  try {
    // Provera ograničenja API-ja
    const now = Date.now();
    const timeSinceLastRequest = now - lastProxyRequestTime;
    
    if (timeSinceLastRequest < 1000 / API_RATE_LIMIT.REQUESTS_PER_SECOND) {
      console.log(`Čekanje zbog ograničenja API-ja (${Math.ceil(1000 / API_RATE_LIMIT.REQUESTS_PER_SECOND - timeSinceLastRequest)}ms)`);
      await new Promise(resolve => setTimeout(resolve, 1000 / API_RATE_LIMIT.REQUESTS_PER_SECOND - timeSinceLastRequest));
    }
    
    console.log("Dohvatanje plaćenih proxy servera...");
    const response = await fetch(PAID_PROXY_API_URL);
    lastProxyRequestTime = Date.now();
    
    if (!response.ok) {
      throw new Error(`HTTP greška: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!data || !data.data || !Array.isArray(data.data) || data.data.length === 0) {
      console.log("Nema dostupnih proxy servera iz API-ja");
      return false;
    }
    
    // Parsiranje proxy servera iz JSON odgovora
    // Format odgovora je: [["ip:port", "HTTP", "Online", "country_code"], ...]
    const proxies = data.data.map(proxyData => {
      const ipPort = proxyData[0]; // Prvi element je "ip:port"
      return `http://${ipPort}`;
    });
    
    console.log(`Dohvaćeno ${proxies.length} proxy servera`);
    
    // Resetovanje brojača korišćenja
    proxyUsageCount = {};
    
    // Dodavanje direktne konekcije kao rezervne opcije
    proxies.push('direct');
    
    // Ažuriranje liste proxy servera
    proxyList = proxies;
    
    // Postavi proxy servere kao prvi izbor, a direktnu konekciju kao poslednju opciju
    workingProxies = [...proxies.filter(p => p !== 'direct'), 'direct'];
    
    // Resetovanje indeksa trenutnog proxy-ja
    currentProxyIndex = 0;
    
    return true;
  } catch (error) {
    console.error(`Greška pri dohvatanju proxy servera: ${error.message}`);
    
    // Ako nema proxy servera, koristimo direktnu konekciju
    if (workingProxies.length === 0) {
      console.log("UPOZORENJE: Nema dostupnih proxy servera, koristi se direktna konekcija");
      workingProxies = ['direct'];
      currentProxyIndex = 0;
    }
    
    // Pokrenemo testiranje u pozadini
    setTimeout(testProxiesFromQueue, 1000);
  }
};

// Funkcija za dobijanje sledećeg proxy servera koji radi
const getNextProxy = () => {
  if (workingProxies.length === 0) {
    return 'direct'; // Ako nemamo radnih proxy-ja, koristimo direktnu konekciju
  }
  
  const proxy = workingProxies[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % workingProxies.length;
  
  // Povećavamo brojač korišćenja za ovaj proxy
  if (proxy !== 'direct') {
    proxyUsageCount[proxy] = (proxyUsageCount[proxy] || 0) + 1;
  }
  
  return proxy;
};

// Funkcija za kreiranje odgovarajućeg proxy agenta
const createProxyAgent = (proxyUrl) => {
  if (proxyUrl === 'direct') {
    return null; // Bez proxy-ja
  }
  
  try {
    console.log(`Kreiranje proxy agenta za: ${proxyUrl}`);
    
    // Koristimo HttpsProxyAgent direktno sa URL-om, bez dodatne autentifikacije
    return new HttpsProxyAgent(proxyUrl);
  } catch (error) {
    console.error(`Greška pri kreiranju proxy agenta: ${error.message}`);
    return null;
  }
};

// Funkcija za dohvatanje detaljne adrese iz stranice sa detaljima oglasa
const fetchDetailedAddress = async (detailUrl, proxyUrl) => {
  try {
    console.log(`Dohvatam detaljnu adresu sa: ${detailUrl}`);
    
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
    
    const response = await fetch(detailUrl, options);
    const text = await response.text();
    const $ = cheerio.load(text);
    
    // Tražimo element sa adresom
    const addressBox = $('[data-testid="top-contact-box-address-box"]');
    if (addressBox.length > 0) {
      // Uzimamo sve tekstualne elemente iz adresnog boksa
      const addressParts = [];
      addressBox.find('.Text-sc-10o2fdq-0').each((i, element) => {
        addressParts.push($(element).text().trim());
      });
      
      // Spajamo delove adrese
      const fullAddress = addressParts.join(', ');
      console.log(`Pronađena detaljna adresa: ${fullAddress}`);
      return fullAddress;
    } else {
      console.warn(`Nije pronađena detaljna adresa za: ${detailUrl}`);
      return null;
    }
  } catch (error) {
    console.error(`Greška pri dohvatanju detaljne adrese: ${error.message}`);
    return null;
  }
};

app.use(cors());

const fetchCarAds = async () => {
  try {
    const proxyUrl = getNextProxy();
    if (proxyUrl === 'direct') {
      console.warn(`UPOZORENJE: Koristim direktnu konekciju bez proxy-ja! Postoji rizik od blokiranja.`);
    } else {
      const usageCount = proxyUsageCount[proxyUrl] || 0;
      console.log(`Korišćenje proxy servera: ${proxyUrl} (korišćen ${usageCount} puta)`);
    }
    
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
    
    console.log(`Dohvatam oglase sa URL-a: ${url}`);
    
    // Koristimo direktan zahtev umesto ProxyScrape API
    const fetchPromise = fetch(url, options);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout pri dohvatanju oglasa')), PROXY_TIMEOUT)
    );
    
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    
    if (!response.ok) {
      throw new Error(`HTTP greška: ${response.status} ${response.statusText}`);
    }
    
    const htmlContent = await response.text();
    
    console.log(`Dohvaćen HTML sadržaj (${htmlContent.length} karaktera)`);
    
    // Sačuvajmo HTML za analizu
    fs.writeFileSync('last_response.html', htmlContent);
    console.log("HTML sadržaj je sačuvan u fajl 'last_response.html' za analizu.");
    
    const $ = cheerio.load(htmlContent);
    const cars = [];
    const baseUrl = "https://www.willhaben.at";

    $("a[data-testid^='search-result-entry-header']").each((i, element) => {
      const id = $(element).attr("id") || $(element).attr("data-testid");
      if (!id) return;

      const extractedId = id.match(/\d+$/)[0];
      const title = $(element).find("h3").text().trim();
      const price = $(element).find("[data-testid^='search-result-entry-price']").text().trim();
      
      // Ekstrakcija adrese iz liste (koristićemo je kao fallback)
      const locationElement = $(element).find("[data-testid^='search-result-entry-location']");
      const location = locationElement.text().trim();
      
      // Dobijanje linka ka detaljima oglasa
      const detailPath = $(element).attr("href");
      const detailUrl = `${baseUrl}${detailPath}`;

      const link = `${baseUrl}/iad/gebrauchtwagen/d/auto/${title.toLowerCase().replace(/\s+/g, "-")}-${extractedId}/#ad-contact-form-container`;
      
      const image = $(element).find("img.ResponsiveImage-sc-17bk1i9-0").attr("src");

      cars.push({ 
        id, 
        title, 
        price, 
        location, // Privremena adresa iz liste
        detailUrl, // URL ka detaljima oglasa
        image,
        link
      });
    });

    console.log(`Pronađeno ${cars.length} automobila`);
    
    // Dohvatamo detaljne adrese za svaki oglas (maksimalno 5 paralelno da ne preopteretimo server)
    const batchSize = 5;
    for (let i = 0; i < cars.length; i += batchSize) {
      const batch = cars.slice(i, i + batchSize);
      const addressPromises = batch.map(car => fetchDetailedAddress(car.detailUrl, proxyUrl));
      const addresses = await Promise.all(addressPromises);
      
      // Dodajemo detaljne adrese i linkove za pretragu
      for (let j = 0; j < batch.length; j++) {
        const car = batch[j];
        const detailedAddress = addresses[j];
        
        // Koristimo detaljnu adresu ako je dostupna, inače koristimo adresu iz liste
        const finalAddress = detailedAddress || car.location;
        
        // Dodajemo adresu i linkove za pretragu
        car.address = finalAddress;
        car.googleMapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(finalAddress)}`;
        car.googleSearchLink = `https://www.google.com/search?q=${encodeURIComponent(finalAddress)}`;
      }
    }
    
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
        error.message.includes('ECONNRESET') ||
        error.message.includes('EPROTO')) {
      const failedProxy = getNextProxy();
      if (failedProxy !== 'direct') {
        console.log(`Uklanjam neispravan proxy: ${failedProxy}`);
        workingProxies = workingProxies.filter(p => p !== failedProxy);
        // Uklanjamo brojač korišćenja za uklonjeni proxy
        delete proxyUsageCount[failedProxy];
      }
      
      if (workingProxies.length === 0) {
        console.warn("Svi proxy serveri su neispravni! Pokušavam ponovo inicijalizaciju...");
        
        // Pokušavamo da dohvatimo nove proxy servere
        await fetchFreshProxies();
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
  
  // Postavljanje intervala za periodično testiranje proxy servera iz reda
  setInterval(() => {
    if (!isProxyTestRunning && proxyTestQueue.length > 0) {
      console.log("Pokrećem testiranje proxy servera iz reda...");
      testProxiesFromQueue();
    }
  }, PROXY_TEST_INTERVAL);
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
    workingProxies: workingProxies.length,
    queuedProxies: proxyTestQueue.length
  });
});

// Endpoint za prikaz statistike proxy servera
app.get("/proxy-stats", (req, res) => {
  const isUsingDirect = workingProxies.includes('direct') && workingProxies.length === 1;
  
  // Pripremamo listu radnih proxija sa brojem korišćenja
  const workingProxiesWithUsage = workingProxies.map(proxy => ({
    url: proxy,
    usageCount: proxyUsageCount[proxy] || 0
  }));
  
  res.json({
    total: proxyList.length,
    working: workingProxies.length,
    current: workingProxies[currentProxyIndex] || 'direct',
    workingList: workingProxiesWithUsage,
    currentApi: PROXY_API_URLS[currentApiIndex],
    queuedForTesting: proxyTestQueue.length,
    isTestingRunning: isProxyTestRunning,
    status: isUsingDirect ? 'UPOZORENJE: Koristi se direktna konekcija!' : 'OK'
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
