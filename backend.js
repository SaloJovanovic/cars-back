import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import fs from 'fs';

const app = express();
const PORT = 5001;
const url = "https://www.willhaben.at/iad/gebrauchtwagen/auto/gebrauchtwagenboerse?sfId=6bc718a3-598a-4308-b98e-10c829d0730c&isNavigation=true&rows=30&sort=1&DEALER=1&page=1&PRICE_TO=12000";

// URL za dohvatanje plaćenih proxy servera
const PAID_PROXY_API_URL = "https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=16791c81jgzqofaeyh3s&type=getproxies&country[]=all&protocol=http&format=json&status=online";

// Dodajte konstante za korisničko ime i lozinku
const PROXY_USERNAME = 'mistermarko4002@gmail.com';
const PROXY_PASSWORD = 'Marko2004';

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
const FETCH_INTERVAL = 3000; // 3 sekunde za dohvatanje automobila
const PROXY_TIMEOUT = 20000; // 20 sekundi za timeout proxy-ja
const PROXY_REFRESH_INTERVAL = 3600000; // 1 sat za osvežavanje proxy liste (povećano jer su plaćeni proxy serveri)
let workingProxies = []; // Lista proxy-ja koji rade
let proxyUsageCount = {}; // Brojač korišćenja svakog proxy-ja

// Konstanta za ProxyScrape API ključ
const ProxyScrapeAPIKey = '16791c81jgzqofaeyh3s'; // Tvoj API ključ

// Privremeno koristi fetch umesto axios-a
const fetchWithProxyScrape = async (targetUrl) => {
  try {
    console.log(`Dohvatam podatke sa ${targetUrl} preko ProxyScrape API-ja`);
    
    const data = {
      url: targetUrl,
      country: 'random',
      render: false,
      session: 'random',
      timeout: PROXY_TIMEOUT / 1000
    };
    
    const response = await fetch('https://api.proxyscrape.com/v3/accounts/freebies/scraperapi/request', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'X-Api-Key': ProxyScrapeAPIKey
      },
      body: JSON.stringify(data)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP greška: ${response.status} ${response.statusText}`);
    }
    
    return await response.text();
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
      // Vraćamo samo IP:PORT bez autentifikacije u URL-u
      // Autentifikacija će biti dodata u createProxyAgent funkciji
      return `http://${ipPort}`;
    });
    
    console.log(`Dohvaćeno ${proxies.length} proxy servera`);
    
    // Resetovanje brojača korišćenja
    proxyUsageCount = {};
    
    // Dodavanje direktne konekcije kao rezervne opcije
    proxies.push('direct');
    
    // Ažuriranje liste proxy servera
    proxyList = proxies;
    
    // Postavi direktnu konekciju kao prvi izbor
    workingProxies = ['direct', ...proxies];
    
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
    
    return false;
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

// Funkcija za kreiranje proxy agenta
const createProxyAgent = (proxyUrl) => {
  if (proxyUrl === 'direct') {
    return null; // Bez proxy-ja
  }
  
  try {
    // Izvlačimo IP i port iz proxy URL-a
    const urlParts = proxyUrl.split('://');
    if (urlParts.length !== 2) {
      throw new Error('Neispravan format proxy URL-a');
    }
    
    const protocol = urlParts[0];
    const address = urlParts[1];
    
    // Kreiramo opcije za proxy agent
    const options = {
      host: address.split(':')[0],
      port: address.split(':')[1],
      protocol: `${protocol}:`,
      auth: `${PROXY_USERNAME}:${PROXY_PASSWORD}`
    };
    
    console.log(`Kreiranje proxy agenta za: ${protocol}://${address} sa autentifikacijom`);
    
    // Koristimo HttpsProxyAgent sa opcijama
    return new HttpsProxyAgent(options);
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

// Nova funkcija za dohvatanje detaljne adrese preko ProxyScrape API-ja
const fetchDetailedAddressWithProxyScrape = async (detailUrl) => {
  try {
    console.log(`Dohvatam detaljnu adresu sa: ${detailUrl}`);
    
    const htmlContent = await fetchWithProxyScrape(detailUrl);
    const $ = cheerio.load(htmlContent);
    
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
      
      // Povećavamo brojač korišćenja
      proxyUsageCount[proxyUrl] = usageCount + 1;
    }
    
    const agent = createProxyAgent(proxyUrl);
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Connection': 'keep-alive',
        'Cache-Control': 'max-age=0'
      },
      timeout: PROXY_TIMEOUT
    };
    
    // Dodajemo proxy agenta ako postoji
    if (agent) {
      options.agent = agent;
    }
    
    console.log(`Dohvatam oglase sa URL-a: ${url}`);
    
    // Koristimo ProxyScrape API umesto direktnog zahteva
    const htmlContent = await fetchWithProxyScrape(url);
    
    console.log(`Dohvaćen HTML sadržaj (${htmlContent.length} karaktera)`);
    
    // Sačuvajmo HTML za analizu
    fs.writeFileSync('last_response.html', htmlContent);
    console.log("HTML sadržaj je sačuvan u fajl 'last_response.html' za analizu.");
    
    // Provera da li HTML sadrži poruku o grešci sa proxy-jem
    if (htmlContent.includes("Proxy Authentication Required") || htmlContent.includes("407 Proxy Authentication Required")) {
      console.error("HTML sadrži poruku o grešci sa proxy autentifikacijom.");
      
      // Uklanjamo problematični proxy iz liste radnih proxy-ja
      workingProxies = workingProxies.filter(p => p !== proxyUrl);
      
      // Ako nema više radnih proxy-ja, dodajemo direktnu konekciju
      if (workingProxies.length === 0) {
        console.warn("Nema više radnih proxy servera, koristim direktnu konekciju.");
        workingProxies = ['direct'];
        currentProxyIndex = 0;
      }
      
      // Pokušavamo ponovo sa drugim proxy-jem
      return await fetchCarAds();
    }
    
    const $ = cheerio.load(htmlContent);
    const cars = [];
    const baseUrl = "https://www.willhaben.at";

    // Provera da li ima oglasa
    const adElements = $("a[data-testid^='search-result-entry-header']");
    console.log(`Pronađeno ${adElements.length} elemenata oglasa na stranici`);
    
    // Ako nema oglasa, probajmo alternativni selektor
    if (adElements.length === 0) {
      console.log("Probavam alternativni selektor za oglase...");
      const alternativeElements = $("a[id^='search-result-entry-header']");
      console.log(`Pronađeno ${alternativeElements.length} elemenata oglasa sa alternativnim selektorom`);
      
      if (alternativeElements.length > 0) {
        alternativeElements.each((i, element) => {
          try {
            const id = $(element).attr("id");
            if (!id) {
              console.warn("Preskačem element bez ID-a");
              return;
            }

            const idMatch = id.match(/\d+$/);
            if (!idMatch) {
              console.warn(`Preskačem element sa nevalidnim ID-om: ${id}`);
              return;
            }

            const extractedId = idMatch[0];
            const titleElement = $(element).find("h3");
            if (titleElement.length === 0) {
              console.warn(`Preskačem element bez naslova (ID: ${extractedId})`);
              return;
            }

            const title = titleElement.text().trim();
            
            const priceElement = $(element).find("[data-testid^='search-result-entry-price']");
            const price = priceElement.length > 0 ? priceElement.text().trim() : "N/A";
            
            // Ekstrakcija adrese iz liste (koristićemo je kao fallback)
            const locationElement = $(element).find("[data-testid^='search-result-entry-location']");
            const location = locationElement.length > 0 ? locationElement.text().trim() : "N/A";
            
            // Dobijanje linka ka detaljima oglasa
            const detailPath = $(element).attr("href");
            if (!detailPath) {
              console.warn(`Preskačem element bez linka (ID: ${extractedId})`);
              return;
            }
            
            const detailUrl = `${baseUrl}${detailPath}`;
            
            const imageElement = $(element).find("img");
            const image = imageElement.length > 0 ? imageElement.attr("src") : null;

            console.log(`Obrađujem oglas: ${title} (ID: ${extractedId})`);
            
            cars.push({ 
              id, 
              title, 
              price, 
              location, // Privremena adresa iz liste
              detailUrl, // URL ka detaljima oglasa
              image
            });
          } catch (error) {
            console.error(`Greška pri obradi oglasa: ${error.message}`);
          }
        });
      }
    } else {
      adElements.each((i, element) => {
        try {
      const id = $(element).attr("id") || $(element).attr("data-testid");
          if (!id) {
            console.warn("Preskačem element bez ID-a");
            return;
          }

          const idMatch = id.match(/\d+$/);
          if (!idMatch) {
            console.warn(`Preskačem element sa nevalidnim ID-om: ${id}`);
            return;
          }

          const extractedId = idMatch[0];
          const titleElement = $(element).find("h3");
          if (titleElement.length === 0) {
            console.warn(`Preskačem element bez naslova (ID: ${extractedId})`);
            return;
          }

          const title = titleElement.text().trim();
          
          const priceElement = $(element).find("[data-testid^='search-result-entry-price']");
          const price = priceElement.length > 0 ? priceElement.text().trim() : "N/A";
          
          // Ekstrakcija adrese iz liste (koristićemo je kao fallback)
          const locationElement = $(element).find("[data-testid^='search-result-entry-location']");
          const location = locationElement.length > 0 ? locationElement.text().trim() : "N/A";
          
          // Dobijanje linka ka detaljima oglasa
          const detailPath = $(element).attr("href");
          if (!detailPath) {
            console.warn(`Preskačem element bez linka (ID: ${extractedId})`);
            return;
          }
          
          const detailUrl = `${baseUrl}${detailPath}`;
          
          const imageElement = $(element).find("img.ResponsiveImage-sc-17bk1i9-0");
          const image = imageElement.length > 0 ? imageElement.attr("src") : null;

          console.log(`Obrađujem oglas: ${title} (ID: ${extractedId})`);
          
          cars.push({ 
            id, 
            title, 
            price, 
            location, // Privremena adresa iz liste
            detailUrl, // URL ka detaljima oglasa
            image
          });
        } catch (error) {
          console.error(`Greška pri obradi oglasa: ${error.message}`);
        }
      });
    }

    console.log(`Pronađeno ${cars.length} automobila`);
    
    if (cars.length === 0) {
      console.warn("Nije pronađen nijedan automobil! Proveravam HTML strukturu...");
      // Provera da li je stranica možda blokirala pristup
      if (htmlContent.includes("captcha") || htmlContent.includes("Captcha") || htmlContent.includes("CAPTCHA")) {
        console.error("CAPTCHA detektovana! Sajt je možda blokirao pristup.");
      }
      if (htmlContent.includes("blocked") || htmlContent.includes("Blocked") || htmlContent.includes("BLOCKED")) {
        console.error("Pristup je blokiran! Sajt je detektovao automatizovani pristup.");
      }
      
      // Vraćamo keširane podatke ako ih ima
      return cachedCars.length > 0 ? cachedCars : [{ 
        id: "no-data", 
        title: "Nema podataka", 
        price: "N/A", 
        location: "N/A",
        message: "Nije moguće dohvatiti podatke. Pokušajte ponovo kasnije."
      }];
    }
    
    // Dohvatamo detaljne adrese za svaki oglas (maksimalno 5 paralelno da ne preopteretimo server)
    console.log("Dohvatam detaljne adrese za oglase...");
    const batchSize = 5;
    for (let i = 0; i < cars.length; i += batchSize) {
      const batch = cars.slice(i, i + batchSize);
      console.log(`Obrađujem batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(cars.length/batchSize)} (${batch.length} oglasa)`);
      
      try {
        const addressPromises = batch.map(car => fetchDetailedAddressWithProxyScrape(car.detailUrl));
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
          
          console.log(`Oglas ${car.title} - Adresa: ${finalAddress}`);
        }
      } catch (error) {
        console.error(`Greška pri dohvatanju detaljnih adresa: ${error.message}`);
        // Nastavljamo sa sledećim batch-om
      }
    }
    
    // Ažuriranje keširanih podataka
    if (cars.length > 0) {
      cachedCars = cars;
      console.log(`Keširano ${cars.length} automobila`);
    }

    return cars;
  } catch (error) {
    console.error("Greška pri dohvatanju oglasa za automobile:", error.message);
    
    // Ako je proxy problem, označimo ga kao neispravan i probajmo ponovo sa drugim
    if (error.message.includes('ECONNREFUSED') || 
        error.message.includes('ETIMEDOUT') || 
        error.message.includes('ECONNRESET') ||
        error.message.includes('EPROTO') ||
        error.message.includes('socket hang up') ||
        error.message.includes('network timeout') ||
        error.message.includes('Timeout')) {
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
        await fetchPaidProxies();
      }
    }
    
    // Vraćamo keširane podatke ili poruku o grešci
    return cachedCars.length > 0 ? cachedCars : [{ 
      id: "error", 
      title: "Greška", 
      price: "N/A", 
      location: "N/A",
      error: error.message,
      message: "Došlo je do greške pri dohvatanju podataka. Pokušajte ponovo kasnije."
    }];
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
    await fetchPaidProxies();
  }, PROXY_REFRESH_INTERVAL);
};

app.get("/cars", async (req, res) => {
  try {
    console.log("Primljen zahtev za /cars endpoint");
    
    // Ako nemamo keširane podatke, dohvatamo ih
    if (cachedCars.length === 0) {
      console.log("Nema keširanih podataka, dohvatam nove...");
      cachedCars = await fetchCarAds();
    } else {
      console.log(`Vraćam ${cachedCars.length} keširanih automobila`);
    }
    
    res.json(cachedCars);
  } catch (error) {
    console.error("Greška pri obradi /cars zahteva:", error.message);
    res.status(500).json({ 
      error: "Interna greška servera", 
      message: error.message,
      cars: []
    });
  }
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
  const success = await fetchPaidProxies();
  res.json({ 
    success, 
    totalProxies: proxyList.length,
    workingProxies: workingProxies.length
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
    status: isUsingDirect ? 'UPOZORENJE: Koristi se direktna konekcija!' : 'OK',
    apiRateLimit: API_RATE_LIMIT,
    lastProxyRequestTime: new Date(lastProxyRequestTime).toISOString()
  });
});

// Endpoint za testiranje direktne konekcije
app.get("/test-direct", async (req, res) => {
  try {
    console.log("Testiram direktnu konekciju...");
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Connection': 'keep-alive',
        'Cache-Control': 'max-age=0'
      },
      timeout: PROXY_TIMEOUT
    };
    
    const response = await fetch(url, options);
    const text = await response.text();
    
    // Sačuvaj HTML za analizu
    fs.writeFileSync('direct_response.html', text);
    
    res.json({ 
      success: true, 
      status: response.status,
      contentLength: text.length,
      message: "Direktna konekcija uspešna, HTML sačuvan u 'direct_response.html'"
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Endpoint za testiranje proxy servera sa httpbin.org
app.get("/test-proxy-httpbin", async (req, res) => {
  try {
    console.log("Testiram proxy konekciju sa httpbin.org...");
    
    // Uzimamo prvi proxy iz liste
    const proxyUrl = workingProxies.find(p => p !== 'direct') || 'direct';
    
    if (proxyUrl === 'direct') {
      return res.json({ 
        success: false, 
        message: "Nema dostupnih proxy servera za testiranje"
      });
    }
    
    // Izvlačimo IP i port iz proxy URL-a
    const urlParts = proxyUrl.split('://');
    if (urlParts.length !== 2) {
      return res.json({ 
        success: false, 
        message: "Neispravan format proxy URL-a"
      });
    }
    
    const protocol = urlParts[0];
    const address = urlParts[1];
    
    // Kreiramo opcije za proxy agent
    const options = {
      host: address.split(':')[0],
      port: address.split(':')[1],
      protocol: `${protocol}:`,
      auth: `${PROXY_USERNAME}:${PROXY_PASSWORD}`
    };
    
    console.log(`Kreiranje proxy agenta za: ${protocol}://${address} sa autentifikacijom`);
    
    // Koristimo HttpsProxyAgent sa opcijama
    const agent = new HttpsProxyAgent(options);
    
    const fetchOptions = {
      agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: PROXY_TIMEOUT
    };
    
    // Koristimo isti URL kao u Python primeru
    const testUrl = "https://httpbin.org/ip";
    const response = await fetch(testUrl, fetchOptions);
    
    if (!response.ok) {
      return res.json({ 
        success: false, 
        status: response.status,
        statusText: response.statusText,
        message: "Proxy test nije uspeo"
      });
    }
    
    const data = await response.json();
    
    res.json({ 
      success: true, 
      proxy: proxyUrl,
      ipInfo: data,
      message: "Proxy test uspešan"
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Endpoint za testiranje ProxyScrape ScraperAPI
app.get("/test-scraper-api", async (req, res) => {
  try {
    console.log("Testiram ProxyScrape ScraperAPI...");
    
    const testUrl = "https://httpbin.org/ip";
    const data = await fetchWithProxyScrape(testUrl);
    
    res.json({ 
      success: true, 
      data: data,
      message: "ScraperAPI test uspešan"
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  
  // Prvo dohvatamo plaćene proxy servere
  await fetchPaidProxies();
  
  // Pokretanje periodičnog dohvatanja podataka
  startPeriodicFetching();
});
