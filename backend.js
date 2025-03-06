import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const app = express();
const PORT = 5001;
const url = "https://www.willhaben.at/iad/gebrauchtwagen/auto/gebrauchtwagenboerse?sfId=6bc718a3-598a-4308-b98e-10c829d0730c&isNavigation=true&rows=30&sort=1&DEALER=1&page=1&PRICE_TO=12000";

// URL-ovi za dohvatanje svežih proxy servera
const PROXY_API_URLS = [
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text&timeout=20000",
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all"
];
let currentApiIndex = 0; // Indeks trenutnog API-ja za rotaciju

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
    console.error("Greška pri dohvatanju proxy servera:", error.message);
    
    // Pokušavamo sa drugim API-jem
    if (PROXY_API_URLS.length > 1 && currentApiIndex !== 0) {
      console.log("Pokušavam sa drugim API-jem...");
      currentApiIndex = (currentApiIndex + 1) % PROXY_API_URLS.length;
      return await fetchFreshProxies();
    }
    
    console.warn("Koristiću direktnu konekciju ako nema radnih proxy servera.");
    if (workingProxies.length === 0) {
      workingProxies = ['direct'];
    }
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

// Funkcija za testiranje proxy servera iz reda
const testProxiesFromQueue = async () => {
  if (isProxyTestRunning || proxyTestQueue.length === 0) {
    return;
  }
  
  isProxyTestRunning = true;
  
  // Uzimamo veći broj proxy servera iz reda za testiranje
  const batchSize = 50; // Povećavamo sa 10 na 50
  const proxiesToTest = proxyTestQueue.splice(0, batchSize);
  
  console.log(`Testiram ${proxiesToTest.length} proxy servera paralelno...`);
  
  // Testiramo sve proxy servere paralelno
  const testPromises = proxiesToTest.map(async (proxy) => {
    // Preskačemo proxy servere koji su već u radnoj listi
    if (workingProxies.includes(proxy)) {
      return;
    }
    
    const isWorking = await checkProxy(proxy);
    if (isWorking) {
      // Dodajemo radni proxy u listu radnih proxy-ja
      if (!workingProxies.includes(proxy)) {
        if (workingProxies.length === 1 && workingProxies[0] === 'direct') {
          // Ako je jedini proxy 'direct', zamenjujemo ga
          workingProxies = [proxy];
          // Inicijalizujemo brojač korišćenja
          proxyUsageCount = { [proxy]: 0 };
          console.log(`Pronađen radni proxy! Prelazim sa direktne konekcije na proxy.`);
        } else {
          workingProxies.push(proxy);
          // Inicijalizujemo brojač korišćenja za novi proxy
          proxyUsageCount[proxy] = 0;
          console.log(`Dodat novi radni proxy. Ukupno radnih: ${workingProxies.length}`);
        }
      }
    }
  });
  
  // Čekamo da se svi testovi završe
  await Promise.all(testPromises);
  
  isProxyTestRunning = false;
  
  // Ako ima još proxy servera u redu, nastavljamo testiranje
  if (proxyTestQueue.length > 0) {
    setTimeout(testProxiesFromQueue, 1000); // Pauza od 1 sekunde između batch-eva
  } else {
    console.log(`Završeno testiranje proxy servera. Ukupno radnih: ${workingProxies.length}`);
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
  
  // Testiramo veći broj proxy servera paralelno
  const proxiesToTest = proxyList.slice(0, 100); // Povećavamo sa 50 na 100
  
  console.log(`Paralelno testiram ${proxiesToTest.length} proxy servera...`);
  
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
  
  // Dodajemo ostatak proxy servera u red za testiranje
  if (proxyList.length > 100) {
    const remainingProxies = proxyList.slice(100);
    proxyTestQueue.push(...remainingProxies);
    
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
  } else if (proxyUrl.startsWith('socks4://') || proxyUrl.startsWith('socks5://')) {
    return new SocksProxyAgent(proxyUrl);
  } else if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
    return new HttpsProxyAgent(proxyUrl);
  } else {
    throw new Error('Nepodržani proxy protokol');
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
    
    const response = await fetch(url, options);
    
    const text = await response.text();
    const $ = cheerio.load(text);
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
